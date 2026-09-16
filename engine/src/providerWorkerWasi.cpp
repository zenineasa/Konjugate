/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The web edition's C++-provider transport (docs/proposals/webEdition.md, phase 5): a purpose-
// built WASI-only counterpart to providerWorker.cpp (the native pipe/shared-memory worker), rather
// than the same shared file carrying dead native-only code (main()'s pipe read loop, framed
// stdin/stdout I/O, the POSIX shared-memory fast path) through the in-browser clang's WASI-target
// compile as well. That native code was already `#ifndef __wasi__`-gated out of the object code
// either way, but this split keeps the file this toolchain actually parses limited to what it
// needs, and keeps native-only headers/APIs (<iostream>, <thread>, <semaphore.h>, <sys/mman.h>)
// out of this file's own include list entirely rather than relying on conditional compilation to
// exclude them -- see docs/proposals/webEdition.md's phase 5 status note.
//
// src/webCppProviderBridge.mjs compiles this file (not providerWorker.cpp) alongside a provider's
// own inline source via @wasmer/sdk's in-browser clang, then instantiates the result directly via
// WebAssembly.instantiate() and calls its exports (konjugateProviderCreate/konjugateProviderDispatch)
// synchronously from engine/src/providerRuntime.cpp's WasmCppProviderBackend, through a plain EM_JS
// binding -- there is no process or Stream to make this asynchronous at evaluation time, unlike the
// native pipe transport's Promise-based stdin/stdout.
//
// The protobuf wire-format helpers, message structs/decoders/encoders, instance-binding map, and
// dispatchMessage() below are a deliberate copy of providerWorker.cpp's own __wasi__-reachable
// code (kept in sync by hand -- both are short, and the two build targets diverge structurally
// enough, native process vs. WASM exports, that sharing a single file was the actual source of the
// problem this split exists to solve): decoding an EngineToProvider message, dispatching it against
// the user's own createRelationshipProvider() factory, and encoding a ProviderToEngine response,
// covers the exact same wire protocol ProviderControlChannel/PipeProviderBackend speak natively.

#include "konjugate/relationshipProvider.hpp"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

// ── Minimal protobuf wire-format helpers ────────────────────────────────────

std::string encodeVarint(std::uint64_t value) {
    std::string result;
    do {
        auto byte = static_cast<char>(value & 0x7f);
        value >>= 7;
        if (value) byte |= static_cast<char>(0x80);
        result.push_back(byte);
    } while (value);
    return result;
}

std::uint64_t decodeVarint(const std::string& data, std::size_t& offset) {
    std::uint64_t value = 0;
    unsigned shift = 0;
    while (offset < data.size()) {
        const auto byte = static_cast<std::uint8_t>(data[offset++]);
        value |= static_cast<std::uint64_t>(byte & 0x7f) << shift;
        if (!(byte & 0x80)) return value;
        shift += 7;
        if (shift >= 64) throw std::runtime_error("Malformed varint in provider protocol.");
    }
    throw std::runtime_error("Truncated varint in provider protocol.");
}

std::string encodeTag(unsigned field, unsigned wireType) {
    return encodeVarint((static_cast<std::uint64_t>(field) << 3) | wireType);
}

std::string encodeLengthDelimited(unsigned field, const std::string& payload) {
    return encodeTag(field, 2) + encodeVarint(payload.size()) + payload;
}

std::string encodeUint32Field(unsigned field, std::uint32_t value) {
    return encodeTag(field, 0) + encodeVarint(value);
}

std::string encodeUint64Field(unsigned field, std::uint64_t value) {
    return encodeTag(field, 0) + encodeVarint(value);
}

std::string encodeDoubleField(unsigned field, double value) {
    std::string result = encodeTag(field, 1);
    char bytes[8];
    std::memcpy(bytes, &value, 8);
    result.append(bytes, 8);
    return result;
}

std::string encodeStringField(unsigned field, const std::string& value) {
    return encodeLengthDelimited(field, value);
}

std::string encodeBoolField(unsigned field, bool value) {
    return encodeTag(field, 0) + encodeVarint(value ? 1 : 0);
}

double decodeDouble(const std::string& data, std::size_t& offset) {
    if (offset + 8 > data.size()) throw std::runtime_error("Truncated double in provider protocol.");
    double value;
    std::memcpy(&value, data.data() + offset, 8);
    offset += 8;
    return value;
}

std::string decodeLengthDelimited(const std::string& data, std::size_t& offset) {
    const auto length = decodeVarint(data, offset);
    if (offset + length > data.size()) throw std::runtime_error("Truncated length-delimited field.");
    auto result = data.substr(offset, length);
    offset += length;
    return result;
}

void skipField(const std::string& data, std::size_t& offset, unsigned wireType) {
    switch (wireType) {
        case 0: decodeVarint(data, offset); break;
        case 1: offset += 8; break;
        case 2: { auto len = decodeVarint(data, offset); offset += len; break; }
        case 5: offset += 4; break;
        default: throw std::runtime_error("Unknown wire type in provider protocol.");
    }
}

// ── Message structures ──────────────────────────────────────────────────────

struct HandshakeRequest {
    std::uint32_t protocolVersion = 0;
    std::uint32_t providerApiVersion = 0;
};

struct ProviderInstance {
    std::uint64_t instanceId = 0;
    std::vector<std::string> inputKeys;
};

struct InitializeRequest {
    std::vector<ProviderInstance> instances;
};

struct Evaluation {
    std::uint64_t instanceId = 0;
    std::vector<double> inputs;
};

struct EvaluateBatchRequest {
    std::uint64_t sequence = 0;
    double simulationTime = 0;
    double stepSize = 0;
    std::vector<Evaluation> evaluations;
};

enum class MessageKind { handshake, initialize, evaluateBatch, shutdown };

struct IncomingMessage {
    MessageKind kind;
    HandshakeRequest handshake;
    InitializeRequest initialize;
    EvaluateBatchRequest evaluateBatch;
};

// ── Decoders ────────────────────────────────────────────────────────────────

HandshakeRequest decodeHandshakeRequest(const std::string& data) {
    HandshakeRequest request;
    std::size_t offset = 0;
    while (offset < data.size()) {
        const auto tag = decodeVarint(data, offset);
        const auto field = static_cast<unsigned>(tag >> 3);
        const auto wire = static_cast<unsigned>(tag & 7);
        if (field == 1 && wire == 0) request.protocolVersion = static_cast<std::uint32_t>(decodeVarint(data, offset));
        else if (field == 2 && wire == 0) request.providerApiVersion = static_cast<std::uint32_t>(decodeVarint(data, offset));
        else skipField(data, offset, wire);
    }
    return request;
}

ProviderInstance decodeProviderInstance(const std::string& data) {
    ProviderInstance instance;
    std::size_t offset = 0;
    while (offset < data.size()) {
        const auto tag = decodeVarint(data, offset);
        const auto field = static_cast<unsigned>(tag >> 3);
        const auto wire = static_cast<unsigned>(tag & 7);
        if (field == 1 && wire == 0) instance.instanceId = decodeVarint(data, offset);
        else if (field == 2 && wire == 2) instance.inputKeys.push_back(decodeLengthDelimited(data, offset));
        else skipField(data, offset, wire);
    }
    return instance;
}

InitializeRequest decodeInitializeRequest(const std::string& data) {
    InitializeRequest request;
    std::size_t offset = 0;
    while (offset < data.size()) {
        const auto tag = decodeVarint(data, offset);
        const auto field = static_cast<unsigned>(tag >> 3);
        const auto wire = static_cast<unsigned>(tag & 7);
        if (field == 1 && wire == 2) request.instances.push_back(decodeProviderInstance(decodeLengthDelimited(data, offset)));
        else skipField(data, offset, wire);
    }
    return request;
}

Evaluation decodeEvaluation(const std::string& data) {
    Evaluation evaluation;
    std::size_t offset = 0;
    while (offset < data.size()) {
        const auto tag = decodeVarint(data, offset);
        const auto field = static_cast<unsigned>(tag >> 3);
        const auto wire = static_cast<unsigned>(tag & 7);
        if (field == 1 && wire == 0) evaluation.instanceId = decodeVarint(data, offset);
        else if (field == 2 && wire == 2) {
            auto packed = decodeLengthDelimited(data, offset);
            std::size_t packedOffset = 0;
            while (packedOffset < packed.size()) evaluation.inputs.push_back(decodeDouble(packed, packedOffset));
        } else skipField(data, offset, wire);
    }
    return evaluation;
}

EvaluateBatchRequest decodeEvaluateBatchRequest(const std::string& data) {
    EvaluateBatchRequest request;
    std::size_t offset = 0;
    while (offset < data.size()) {
        const auto tag = decodeVarint(data, offset);
        const auto field = static_cast<unsigned>(tag >> 3);
        const auto wire = static_cast<unsigned>(tag & 7);
        if (field == 1 && wire == 0) request.sequence = decodeVarint(data, offset);
        else if (field == 2 && wire == 1) request.simulationTime = decodeDouble(data, offset);
        else if (field == 3 && wire == 1) request.stepSize = decodeDouble(data, offset);
        else if (field == 4 && wire == 2) request.evaluations.push_back(decodeEvaluation(decodeLengthDelimited(data, offset)));
        else skipField(data, offset, wire);
    }
    return request;
}

IncomingMessage decodeEngineToProvider(const std::string& data) {
    IncomingMessage message{};
    std::size_t offset = 0;
    while (offset < data.size()) {
        const auto tag = decodeVarint(data, offset);
        const auto field = static_cast<unsigned>(tag >> 3);
        const auto wire = static_cast<unsigned>(tag & 7);
        if (wire == 2) {
            auto payload = decodeLengthDelimited(data, offset);
            if (field == 1) { message.kind = MessageKind::handshake; message.handshake = decodeHandshakeRequest(payload); }
            else if (field == 2) { message.kind = MessageKind::initialize; message.initialize = decodeInitializeRequest(payload); }
            else if (field == 3) { message.kind = MessageKind::evaluateBatch; message.evaluateBatch = decodeEvaluateBatchRequest(payload); }
            else if (field == 4) { message.kind = MessageKind::shutdown; }
        } else skipField(data, offset, wire);
    }
    return message;
}

// ── Encoders ────────────────────────────────────────────────────────────────

std::string encodeHandshakeResponse(const konjugate::sdk::v1::RelationshipDescription& description) {
    std::string payload;
    payload += encodeUint32Field(1, 1);
    payload += encodeUint32Field(2, 1);
    payload += encodeUint32Field(3, 1);
    payload += encodeStringField(4, description.providerId);
    for (const auto& input : description.inputs) payload += encodeStringField(5, input.key);
    payload += encodeStringField(6, description.output.key);
    return encodeLengthDelimited(1, payload);
}

std::string encodeInitializeResponse(const std::vector<std::uint64_t>& instanceIds) {
    std::string packed;
    for (const auto id : instanceIds) packed += encodeVarint(id);
    std::string payload = encodeLengthDelimited(1, packed);
    return encodeLengthDelimited(2, payload);
}

std::string encodeEvaluateBatchResponse(std::uint64_t sequence,
                                        const std::vector<std::pair<std::uint64_t, double>>& contributions) {
    std::string payload;
    payload += encodeUint64Field(1, sequence);
    for (const auto& [instanceId, value] : contributions) {
        std::string contribution;
        contribution += encodeUint64Field(1, instanceId);
        contribution += encodeDoubleField(2, value);
        payload += encodeLengthDelimited(2, contribution);
    }
    return encodeLengthDelimited(3, payload);
}

std::string encodeShutdownResponse() {
    return encodeLengthDelimited(4, {});
}

std::string encodeProviderFailure(std::uint64_t sequence, const std::string& code,
                                  const std::string& errorMessage, bool fatal) {
    std::string payload;
    payload += encodeUint64Field(1, sequence);
    payload += encodeStringField(2, code);
    payload += encodeStringField(3, errorMessage);
    payload += encodeBoolField(4, fatal);
    return encodeLengthDelimited(5, payload);
}

// ── Instance binding map ────────────────────────────────────────────────────

struct InstanceBinding {
    std::vector<std::size_t> keyIndexes;
};

std::map<std::uint64_t, InstanceBinding> instanceBindings;

void buildInstanceBinding(const ProviderInstance& instance,
                          const konjugate::sdk::v1::RelationshipDescription& description) {
    InstanceBinding binding;
    for (const auto& key : instance.inputKeys) {
        std::size_t foundIndex = description.inputs.size();
        for (std::size_t index = 0; index < description.inputs.size(); ++index) {
            if (description.inputs[index].key == key) { foundIndex = index; break; }
        }
        if (foundIndex == description.inputs.size()) throw std::runtime_error("Instance binding references unknown input key: " + key);
        binding.keyIndexes.push_back(foundIndex);
    }
    instanceBindings[instance.instanceId] = std::move(binding);
}

// ── Shared message dispatch ─────────────────────────────────────────────────

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> tryCreateProvider(std::string& failureResponse) {
    try {
        auto provider = createRelationshipProvider();
        if (!provider) {
            failureResponse = encodeProviderFailure(0, "factoryFailed", "createRelationshipProvider returned null.", true);
            return nullptr;
        }
        return provider;
    } catch (const std::exception& error) {
        failureResponse = encodeProviderFailure(0, "factoryFailed", error.what(), true);
        return nullptr;
    }
}

struct DispatchResult {
    std::string responseBytes;
};

DispatchResult dispatchMessage(const IncomingMessage& message, konjugate::sdk::v1::RelationshipProvider& provider,
                               const konjugate::sdk::v1::RelationshipDescription& description, bool& initialized) {
    switch (message.kind) {
        case MessageKind::handshake: {
            if (message.handshake.protocolVersion != 1 || message.handshake.providerApiVersion != 1) {
                return {encodeProviderFailure(0, "versionMismatch",
                    "This provider supports protocol version 1 and API version 1.", true)};
            }
            return {encodeHandshakeResponse(description)};
        }
        case MessageKind::initialize: {
            std::vector<std::uint64_t> initializedIds;
            for (const auto& instance : message.initialize.instances) {
                buildInstanceBinding(instance, description);
                provider.initialize({instance.instanceId});
                initializedIds.push_back(instance.instanceId);
            }
            initialized = true;
            return {encodeInitializeResponse(initializedIds)};
        }
        case MessageKind::evaluateBatch: {
            if (!initialized) {
                return {encodeProviderFailure(message.evaluateBatch.sequence, "notInitialized",
                    "Evaluation received before initialization.", true)};
            }
            const auto& batch = message.evaluateBatch;
            std::vector<std::pair<std::uint64_t, double>> contributions;
            for (const auto& evaluation : batch.evaluations) {
                const auto it = instanceBindings.find(evaluation.instanceId);
                if (it == instanceBindings.end()) {
                    return {encodeProviderFailure(batch.sequence, "unknownInstance",
                        "Evaluation references an uninitialized instance.", true)};
                }
                const auto& binding = it->second;
                std::vector<double> orderedValues(description.inputs.size(), 0);
                for (std::size_t index = 0; index < binding.keyIndexes.size() && index < evaluation.inputs.size(); ++index) {
                    orderedValues[binding.keyIndexes[index]] = evaluation.inputs[index];
                }
                std::vector<std::string_view> keys;
                keys.reserve(description.inputs.size());
                for (const auto& input : description.inputs) keys.push_back(input.key);
                konjugate::sdk::v1::OutputCollector output;
                provider.evaluate({batch.simulationTime, batch.stepSize, {orderedValues, keys}}, output);
                contributions.emplace_back(evaluation.instanceId, output.gradient());
            }
            return {encodeEvaluateBatchResponse(batch.sequence, contributions)};
        }
        case MessageKind::shutdown: {
            provider.shutdown();
            return {encodeShutdownResponse()};
        }
    }
    throw std::logic_error("Unreachable provider message kind in dispatchMessage().");
}

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> wasmProvider;
konjugate::sdk::v1::RelationshipDescription wasmDescription;
bool wasmInitialized = false;

uint8_t* returnBytes(const std::string& bytes, int* outLen) {
    auto* buffer = static_cast<uint8_t*>(std::malloc(bytes.size()));
    if (buffer) std::memcpy(buffer, bytes.data(), bytes.size());
    *outLen = static_cast<int>(bytes.size());
    return buffer;
}

} // anonymous namespace

extern "C" {

// Constructs the provider (the same createRelationshipProvider() factory the native pipe
// transport uses) and computes its description -- called once by webCppProviderBridge.mjs right
// after instantiation, before any konjugateProviderDispatch() call. Returns an encoded Failure
// (see tryCreateProvider()) on error, or an empty buffer (*outLen == 0) on success -- the caller
// should still send an explicit handshake message through konjugateProviderDispatch() afterward,
// exactly like the pipe transport's first message, to reach the same negotiated/ready state.
__attribute__((export_name("konjugateProviderCreate")))
uint8_t* konjugateProviderCreate(int* outLen) {
    std::string failure;
    wasmProvider = tryCreateProvider(failure);
    if (!wasmProvider) return returnBytes(failure, outLen);
    try {
        wasmDescription = wasmProvider->describe();
    } catch (const std::exception& error) {
        wasmProvider.reset();
        return returnBytes(encodeProviderFailure(0, "factoryFailed", error.what(), true), outLen);
    }
    return returnBytes({}, outLen);
}

// Handles one EngineToProvider message's already-decoded-from-the-outer-frame bytes via the
// shared dispatchMessage(), and returns the encoded ProviderToEngine response bytes. Must not be
// called before konjugateProviderCreate() has succeeded.
__attribute__((export_name("konjugateProviderDispatch")))
uint8_t* konjugateProviderDispatch(const uint8_t* requestBytes, int requestLen, int* outLen) {
    if (!wasmProvider) {
        return returnBytes(encodeProviderFailure(0, "notInitialized", "konjugateProviderCreate() has not succeeded.", true), outLen);
    }
    try {
        const std::string payload(reinterpret_cast<const char*>(requestBytes), static_cast<std::size_t>(requestLen));
        const auto message = decodeEngineToProvider(payload);
        const auto result = dispatchMessage(message, *wasmProvider, wasmDescription, wasmInitialized);
        return returnBytes(result.responseBytes, outLen);
    } catch (const std::exception& error) {
        return returnBytes(encodeProviderFailure(0, "workerFailure", error.what(), true), outLen);
    }
}

}
