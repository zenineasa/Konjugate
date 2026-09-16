/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "konjugate/relationshipProvider.hpp"
#include "konjugate/providerSharedMemoryChannel.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <optional>
#include <string>
#include <vector>
// <iostream>/<thread>/the rest of this block are only needed by main()'s native pipe-transport
// loop below (std::cin/std::cout) and the POSIX shared-memory fast path it can start
// (KONJUGATE_PROVIDER_WORKER_HAS_SHARED_MEMORY) -- both already excluded entirely for a WASI
// target (see that macro's own definition below, and main()'s #ifndef __wasi__ guard), so none of
// this needs to be included there either. This is not just tidiness: <iostream> in particular was
// confirmed, directly, to make an otherwise-fast web-edition provider compile (see
// src/webCppProviderBridge.mjs) take 10+ minutes (sometimes appearing to hang outright) through
// @wasmer/sdk's in-browser clang -- a cost this file has no reason to pay when targeting __wasi__,
// since it never uses any of what these headers provide there.
#ifndef __wasi__
#include <iostream>
#if defined(_WIN32) || defined(_MSC_VER)
#include <fcntl.h>
#include <io.h>
#else
#include <atomic>
#include <cerrno>
#include <fcntl.h>
#include <semaphore.h>
#include <sys/mman.h>
#include <thread>
#endif
#endif

// The shared-memory fast path (shm_open/mmap/sem_open/a real std::thread) is POSIX-only to begin
// with, and additionally unavailable when this file is compiled for a WASI target -- the web
// edition's C++ providers (docs/proposals/webEdition.md) compile this same file client-side via
// a WASI-targeting clang (see src/webCppProviderBridge.mjs), which never sets the
// KONJUGATE_PROVIDER_SHM/KONJUGATE_PROVIDER_REQ_SEM/KONJUGATE_PROVIDER_RESP_SEM environment
// variables this path needs anyway (only SharedMemoryProviderBackend, a native-only transport,
// sets them) -- __wasi__ is the standard predefine clang sets for --target=wasm32-wasi.
#if defined(_WIN32) || defined(__wasi__)
#define KONJUGATE_PROVIDER_WORKER_HAS_SHARED_MEMORY 0
#else
#define KONJUGATE_PROVIDER_WORKER_HAS_SHARED_MEMORY 1
#endif

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

// ── Framed I/O ──────────────────────────────────────────────────────────────
// Native pipe-transport only (main()'s own runLoop, below): the __wasi__-gated exports path
// (also below) never touches std::cin/std::cout at all, exchanging already-framed-elsewhere byte
// buffers directly through its exported functions instead -- so this whole section, and the
// <iostream> it needs, is excluded there too. See providerWorker.cpp's own top-of-file comment on
// why this exclusion is not just tidiness.
#ifndef __wasi__

void writeFramed(const std::string& message) {
    const auto size = static_cast<std::uint32_t>(message.size());
    const char header[4] = {
        static_cast<char>((size >> 24) & 0xff), static_cast<char>((size >> 16) & 0xff),
        static_cast<char>((size >> 8) & 0xff), static_cast<char>(size & 0xff)
    };
    std::cout.write(header, 4);
    std::cout.write(message.data(), static_cast<std::streamsize>(message.size()));
    std::cout.flush();
}

bool readExact(std::string& buffer, std::size_t bytes) {
    buffer.resize(bytes);
    std::cin.read(buffer.data(), static_cast<std::streamsize>(bytes));
    return static_cast<std::size_t>(std::cin.gcount()) == bytes;
}

bool readFramedMessage(IncomingMessage& message) {
    std::string header;
    if (!readExact(header, 4)) return false;
    const auto size = (static_cast<std::uint32_t>(static_cast<std::uint8_t>(header[0])) << 24) |
                      (static_cast<std::uint32_t>(static_cast<std::uint8_t>(header[1])) << 16) |
                      (static_cast<std::uint32_t>(static_cast<std::uint8_t>(header[2])) << 8) |
                       static_cast<std::uint32_t>(static_cast<std::uint8_t>(header[3]));
    std::string payload;
    if (!readExact(payload, size)) return false;
    message = decodeEngineToProvider(payload);
    return true;
}
#endif // __wasi__

// ── Instance binding map ────────────────────────────────────────────────────

struct InstanceBinding {
    std::vector<std::size_t> keyIndexes;
};

std::map<std::uint64_t, InstanceBinding> instanceBindings;

void buildInstanceBinding(const ProviderInstance& instance,
                          const konjugate::sdk::v1::RelationshipDescription& description) {
    InstanceBinding binding;
    for (const auto& key : instance.inputKeys) {
        auto it = std::find_if(description.inputs.begin(), description.inputs.end(),
            [&key](const konjugate::sdk::v1::ScalarPort& port) { return port.key == key; });
        if (it == description.inputs.end()) throw std::runtime_error("Instance binding references unknown input key: " + key);
        binding.keyIndexes.push_back(static_cast<std::size_t>(it - description.inputs.begin()));
    }
    instanceBindings[instance.instanceId] = std::move(binding);
}

#if KONJUGATE_PROVIDER_WORKER_HAS_SHARED_MEMORY
struct SharedMemoryWorkerChannel {
    konjugate::provider::sharedmem::Channel* channel = nullptr;
    sem_t* requestSemaphore = SEM_FAILED;
    sem_t* responseSemaphore = SEM_FAILED;
    int shmFd = -1;
};

// std::nullopt means the engine spawned this worker in ordinary pipe mode (the common case);
// a thrown exception means the environment variables were present but opening the channel they
// name failed, which the caller reports as a handshake failure rather than silently continuing
// in pipe mode, since the engine side has already committed to shared memory for this process
// and has no pipe-evaluateBatch fallback of its own to drop back to.
std::optional<SharedMemoryWorkerChannel> openSharedMemoryWorkerChannel() {
    const char* shmName = std::getenv(konjugate::provider::sharedmem::kSharedMemoryEnvVar);
    const char* requestSemaphoreName = std::getenv(konjugate::provider::sharedmem::kRequestSemaphoreEnvVar);
    const char* responseSemaphoreName = std::getenv(konjugate::provider::sharedmem::kResponseSemaphoreEnvVar);
    if (!shmName || !requestSemaphoreName || !responseSemaphoreName) return std::nullopt;

    SharedMemoryWorkerChannel result;
    result.shmFd = ::shm_open(shmName, O_RDWR, 0600);
    if (result.shmFd < 0) throw std::runtime_error("Failed to open the shared-memory provider channel.");

    void* mapped = ::mmap(nullptr, sizeof(konjugate::provider::sharedmem::Channel),
                          PROT_READ | PROT_WRITE, MAP_SHARED, result.shmFd, 0);
    if (mapped == MAP_FAILED) throw std::runtime_error("Failed to map the shared-memory provider channel.");
    result.channel = reinterpret_cast<konjugate::provider::sharedmem::Channel*>(mapped);

    result.requestSemaphore = ::sem_open(requestSemaphoreName, 0);
    if (result.requestSemaphore == SEM_FAILED) {
        throw std::runtime_error("Failed to open the shared-memory provider request semaphore.");
    }
    result.responseSemaphore = ::sem_open(responseSemaphoreName, 0);
    if (result.responseSemaphore == SEM_FAILED) {
        throw std::runtime_error("Failed to open the shared-memory provider response semaphore.");
    }
    return result;
}

// Runs on a dedicated thread started only after the pipe-based "initialize" message has been
// fully handled on the main thread, so instanceBindings is already populated and that
// construction is visible here via std::thread's happens-before guarantee (no separate lock is
// needed for a map that is otherwise never written after this point). The main thread continues
// to own the control pipe (handshake/initialize/shutdown); this loop only ever touches shared
// memory and the provider's evaluate() path.
void runSharedMemoryEvalLoop(konjugate::sdk::v1::RelationshipProvider& provider,
                             const konjugate::sdk::v1::RelationshipDescription& description,
                             konjugate::provider::sharedmem::Channel* channel,
                             sem_t* requestSemaphore, sem_t* responseSemaphore,
                             std::atomic<bool>& stopRequested) {
    std::vector<std::string_view> keys;
    keys.reserve(description.inputs.size());
    for (const auto& input : description.inputs) keys.push_back(input.key);
    std::vector<double> orderedValues(description.inputs.size(), 0);

    while (true) {
        int waitResult = 0;
        do {
            waitResult = ::sem_wait(requestSemaphore);
        } while (waitResult != 0 && errno == EINTR);
        if (waitResult != 0) return;
        // A wake with no real request pending only happens when the main thread is asking this
        // loop to exit during shutdown; nothing is waiting on responseSemaphore in that case.
        if (stopRequested.load()) return;

        try {
            for (std::uint32_t index = 0; index < channel->slotCount; ++index) {
                auto& slot = channel->slots[index];
                const auto bindingIt = instanceBindings.find(slot.instanceId);
                if (bindingIt == instanceBindings.end()) {
                    throw std::runtime_error("Shared-memory evaluation references an uninitialized instance.");
                }
                std::fill(orderedValues.begin(), orderedValues.end(), 0.0);
                const auto& binding = bindingIt->second;
                for (std::size_t i = 0; i < binding.keyIndexes.size() && i < slot.inputCount; ++i) {
                    orderedValues[binding.keyIndexes[i]] = slot.inputs[i];
                }
                konjugate::sdk::v1::OutputCollector output;
                provider.evaluate({channel->simulationTime, channel->stepSize, {orderedValues, keys}}, output);
                slot.output = output.gradient();
            }
            channel->failed = false;
        } catch (const std::exception& error) {
            channel->failed = true;
            const std::string message = error.what();
            const auto copyLength = std::min(message.size(), konjugate::provider::sharedmem::kMaxErrorMessageLength - 1);
            std::memcpy(channel->errorMessage, message.data(), copyLength);
            channel->errorMessage[copyLength] = '\0';
            ::sem_post(responseSemaphore);
            // Matches the pipe path: an unexpected provider exception is fatal to this worker
            // (see the outer try/catch in main()), so die immediately rather than risk
            // continuing to call evaluate() on a provider object that may be in an unknown
            // state after throwing mid-evaluation.
            std::_Exit(1);
        }
        ::sem_post(responseSemaphore);
    }
}

void stopSharedMemoryEvalThread(std::thread& evalThread, std::atomic<bool>& stopRequested, sem_t* requestSemaphore) {
    if (!evalThread.joinable()) return;
    stopRequested = true;
    if (requestSemaphore && requestSemaphore != SEM_FAILED) ::sem_post(requestSemaphore);
    evalThread.join();
}
#endif

// ── Shared message dispatch ─────────────────────────────────────────────────
//
// Constructs the provider via the user's own createRelationshipProvider() factory (the same
// extern function both the executable and web-edition-exports build link against), reporting any
// failure through the same encodeProviderFailure() shape either transport otherwise uses for
// protocol-level failures -- so a factory bug looks the same over both.
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
    std::string responseBytes; // unframed: the same payload writeFramed() would send, before its own 4-byte length prefix
    bool stop = false;         // whether the CALLER (main()'s own read loop; meaningless to the WASI-exports path below,
                                // which has no "process" to stop -- see its own header comment) should stop reading further messages
    int exitCode = 0;
};

// The single per-message handler both main()'s native pipe-transport read loop AND the web
// edition's WASI-exports transport (docs/proposals/webEdition.md, phase 5; see the __wasi__-gated
// section below) call -- the exact same protocol logic either way, differing only in how a
// message's bytes arrive (a framed pipe read vs. an exported function's byte-buffer argument) and
// leave (a framed pipe write vs. an exported function's byte-buffer return). Shared-memory
// eval-thread bookkeeping (KONJUGATE_PROVIDER_WORKER_HAS_SHARED_MEMORY) is deliberately NOT here:
// it is native-pipe-transport-specific (never reachable when compiled for __wasi__ at all, since
// that macro is unconditionally 0 there), so it stays in main()'s own wrapper around this call.
DispatchResult dispatchMessage(const IncomingMessage& message, konjugate::sdk::v1::RelationshipProvider& provider,
                               const konjugate::sdk::v1::RelationshipDescription& description, bool& initialized) {
    switch (message.kind) {
        case MessageKind::handshake: {
            if (message.handshake.protocolVersion != 1 || message.handshake.providerApiVersion != 1) {
                return {encodeProviderFailure(0, "versionMismatch",
                    "This provider supports protocol version 1 and API version 1.", true), true, 1};
            }
            return {encodeHandshakeResponse(description), false, 0};
        }
        case MessageKind::initialize: {
            std::vector<std::uint64_t> initializedIds;
            for (const auto& instance : message.initialize.instances) {
                buildInstanceBinding(instance, description);
                provider.initialize({instance.instanceId});
                initializedIds.push_back(instance.instanceId);
            }
            initialized = true;
            return {encodeInitializeResponse(initializedIds), false, 0};
        }
        case MessageKind::evaluateBatch: {
            if (!initialized) {
                return {encodeProviderFailure(message.evaluateBatch.sequence, "notInitialized",
                    "Evaluation received before initialization.", true), true, 1};
            }
            const auto& batch = message.evaluateBatch;
            std::vector<std::pair<std::uint64_t, double>> contributions;
            for (const auto& evaluation : batch.evaluations) {
                const auto it = instanceBindings.find(evaluation.instanceId);
                if (it == instanceBindings.end()) {
                    return {encodeProviderFailure(batch.sequence, "unknownInstance",
                        "Evaluation references an uninitialized instance.", true), true, 1};
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
            return {encodeEvaluateBatchResponse(batch.sequence, contributions), false, 0};
        }
        case MessageKind::shutdown: {
            provider.shutdown();
            return {encodeShutdownResponse(), true, 0};
        }
    }
    throw std::logic_error("Unreachable provider message kind in dispatchMessage().");
}

} // anonymous namespace

// This whole function is excluded for a WASI-exports build (see the __wasi__-gated section
// below instead): there is no real OS process/pipe for it to run over there, and the web
// edition's transport calls dispatchMessage() directly through exported functions instead of
// via this stdin/stdout read loop.
#ifndef __wasi__
// The only code before the try/catch below is the Windows _setmode() calls, a non-throwing CRT
// function (returns int, no exception path); every other statement in this function is already
// covered by a try/catch (see below).
int main() { // NOLINT(bugprone-exception-escape)
#if defined(_WIN32) || defined(_MSC_VER)
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    std::string factoryFailure;
    std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> provider;
    try {
        // basic_ios::exceptions() can itself throw if the stream is already in one of the
        // newly-enabled exception states, so it happens before tryCreateProvider() rather than
        // being folded into it -- narrow in practice, but the point of this worker's own uniform
        // failure path (encodeProviderFailure() over the framed protocol, not a bare crash) is
        // exactly to cover cases like this.
        std::cin.exceptions(std::ios::badbit);
        std::cout.exceptions(std::ios::badbit | std::ios::failbit);
    } catch (const std::exception& error) {
        writeFramed(encodeProviderFailure(0, "factoryFailed", error.what(), true));
        return 1;
    }
    provider = tryCreateProvider(factoryFailure);
    if (!provider) {
        writeFramed(factoryFailure);
        return 1;
    }

    const auto description = provider->describe();
    bool initialized = false;
    bool shutdownReceived = false;

#if KONJUGATE_PROVIDER_WORKER_HAS_SHARED_MEMORY
    std::optional<SharedMemoryWorkerChannel> sharedMemory;
    try {
        sharedMemory = openSharedMemoryWorkerChannel();
    } catch (const std::exception& error) {
        writeFramed(encodeProviderFailure(0, "sharedMemorySetupFailed", error.what(), true));
        return 1;
    }
    std::thread evalThread;
    std::atomic<bool> stopRequested{false};
#endif

    // Shared-memory eval-thread bookkeeping around each message is native-pipe-transport-specific
    // (see dispatchMessage()'s own header comment) -- the per-message protocol logic itself,
    // including provider->shutdown(), lives there and is reused unchanged by the web edition's
    // WASI-exports transport below.
    auto runLoop = [&]() {
        IncomingMessage message;
        while (readFramedMessage(message)) {
            auto result = dispatchMessage(message, *provider, description, initialized);
#if KONJUGATE_PROVIDER_WORKER_HAS_SHARED_MEMORY
            if (message.kind == MessageKind::initialize && sharedMemory && !evalThread.joinable()) {
                evalThread = std::thread(runSharedMemoryEvalLoop, std::ref(*provider), std::cref(description),
                    sharedMemory->channel, sharedMemory->requestSemaphore, sharedMemory->responseSemaphore,
                    std::ref(stopRequested));
            }
#endif
            if (message.kind == MessageKind::shutdown) {
                shutdownReceived = true;
#if KONJUGATE_PROVIDER_WORKER_HAS_SHARED_MEMORY
                stopSharedMemoryEvalThread(evalThread, stopRequested, sharedMemory ? sharedMemory->requestSemaphore : nullptr);
#endif
            }
            writeFramed(result.responseBytes);
            if (result.stop) return result.exitCode;
        }
        return 0;
    };

    try {
        const auto result = runLoop();
#if KONJUGATE_PROVIDER_WORKER_HAS_SHARED_MEMORY
        stopSharedMemoryEvalThread(evalThread, stopRequested, sharedMemory ? sharedMemory->requestSemaphore : nullptr);
#endif
        if (!shutdownReceived) provider->shutdown();
        return result;
    } catch (const std::exception& error) {
        writeFramed(encodeProviderFailure(0, "workerFailure", error.what(), true));
#if KONJUGATE_PROVIDER_WORKER_HAS_SHARED_MEMORY
        stopSharedMemoryEvalThread(evalThread, stopRequested, sharedMemory ? sharedMemory->requestSemaphore : nullptr);
#endif
        try { provider->shutdown(); } catch (...) {} // NOLINT(bugprone-empty-catch)
        return 1;
    }
}
#else // __wasi__

// The web edition's C++-provider transport (docs/proposals/webEdition.md, phase 5): a browser
// has no OS process/pipe to run main()'s read loop over (and, separately, no supported way to
// spawn a compiled WASM module as a live Wasmer-hosted process from raw bytes at all -- confirmed
// against the current @wasmer/sdk, see src/webCppProviderBridge.mjs's own header comment), so
// this build exports plain functions instead: src/webCppProviderBridge.mjs instantiates this
// compiled module directly via WebAssembly.instantiate() (synchronous once the module itself is
// compiled) and calls these exports synchronously from the engine's own EM_JS provider-bridge
// call (engine/src/providerRuntime.cpp's WasmCppProviderBackend) -- there is no async boundary
// left to cross at evaluation time, unlike a real spawned process's Promise-based stdin/stdout.
//
// konjugateProviderDispatch() below reuses dispatchMessage() -- the exact same protocol logic
// main()'s pipe loop uses -- unchanged; only the transport differs (an exported function's
// byte-buffer argument/return instead of a framed pipe read/write). This state is intentionally
// file-scope, not per-call: one compiled/instantiated WASM module here plays the same role as one
// spawned OS process natively, living for the whole run, not per request.
namespace {
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
// transport uses) and computes its description -- main()'s own pre-loop setup, called once by
// webCppProviderBridge.mjs right after instantiation, before any konjugateProviderDispatch()
// call. Returns an encoded Failure (see tryCreateProvider()) on error, or an empty buffer
// (*outLen == 0) on success -- there is no protocol response for this step, since it has no
// pipe-transport equivalent message (the pipe transport's process spawn itself plays this role
// there); the caller (webCppProviderBridge.mjs) should still send an explicit handshake message
// through konjugateProviderDispatch() afterward, exactly like the pipe transport's first message,
// to reach the same negotiated/ready state either way.
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

// Handles one EngineToProvider message's already-decoded-from-the-outer-frame bytes (i.e. exactly
// the payload a native pipe write's 4-byte length header would have introduced, without that
// header itself -- webCppProviderBridge.mjs never adds pipe framing at all, so there is none to
// strip here either) via the shared dispatchMessage(), and returns the encoded ProviderToEngine
// response bytes. Must not be called before konjugateProviderCreate() has succeeded.
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
#endif // __wasi__
