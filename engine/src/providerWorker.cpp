/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "konjugate/relationshipProvider.hpp"
#include "konjugate/providerSharedMemoryChannel.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <optional>
#include <string>
#include <vector>
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

#ifndef _WIN32
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

} // anonymous namespace

int main() {
#if defined(_WIN32) || defined(_MSC_VER)
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    std::cin.exceptions(std::ios::badbit);
    std::cout.exceptions(std::ios::badbit | std::ios::failbit);

    std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> provider;
    try {
        provider = createRelationshipProvider();
    } catch (const std::exception& error) {
        writeFramed(encodeProviderFailure(0, "factoryFailed", error.what(), true));
        return 1;
    }
    if (!provider) {
        writeFramed(encodeProviderFailure(0, "factoryFailed", "createRelationshipProvider returned null.", true));
        return 1;
    }

    const auto description = provider->describe();
    bool initialized = false;
    bool shutdownReceived = false;

#ifndef _WIN32
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

    auto runLoop = [&]() {
        IncomingMessage message;
        while (readFramedMessage(message)) {
            switch (message.kind) {
                case MessageKind::handshake: {
                    if (message.handshake.protocolVersion != 1 || message.handshake.providerApiVersion != 1) {
                        writeFramed(encodeProviderFailure(0, "versionMismatch",
                            "This provider supports protocol version 1 and API version 1.", true));
                        return 1;
                    }
                    writeFramed(encodeHandshakeResponse(description));
                    break;
                }
                case MessageKind::initialize: {
                    std::vector<std::uint64_t> initializedIds;
                    for (const auto& instance : message.initialize.instances) {
                        buildInstanceBinding(instance, description);
                        provider->initialize({instance.instanceId});
                        initializedIds.push_back(instance.instanceId);
                    }
                    initialized = true;
#ifndef _WIN32
                    if (sharedMemory && !evalThread.joinable()) {
                        evalThread = std::thread(runSharedMemoryEvalLoop, std::ref(*provider), std::cref(description),
                            sharedMemory->channel, sharedMemory->requestSemaphore, sharedMemory->responseSemaphore,
                            std::ref(stopRequested));
                    }
#endif
                    writeFramed(encodeInitializeResponse(initializedIds));
                    break;
                }
                case MessageKind::evaluateBatch: {
                    if (!initialized) {
                        writeFramed(encodeProviderFailure(message.evaluateBatch.sequence, "notInitialized",
                            "Evaluation received before initialization.", true));
                        return 1;
                    }
                    const auto& batch = message.evaluateBatch;
                    std::vector<std::pair<std::uint64_t, double>> contributions;
                    for (const auto& evaluation : batch.evaluations) {
                        const auto it = instanceBindings.find(evaluation.instanceId);
                        if (it == instanceBindings.end()) {
                            writeFramed(encodeProviderFailure(batch.sequence, "unknownInstance",
                                "Evaluation references an uninitialized instance.", true));
                            return 1;
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
                        provider->evaluate(
                            {batch.simulationTime, batch.stepSize, {orderedValues, keys}},
                            output);
                        contributions.emplace_back(evaluation.instanceId, output.gradient());
                    }
                    writeFramed(encodeEvaluateBatchResponse(batch.sequence, contributions));
                    break;
                }
                case MessageKind::shutdown: {
                    shutdownReceived = true;
#ifndef _WIN32
                    stopSharedMemoryEvalThread(evalThread, stopRequested,
                        sharedMemory ? sharedMemory->requestSemaphore : nullptr);
#endif
                    provider->shutdown();
                    writeFramed(encodeShutdownResponse());
                    return 0;
                }
            }
        }
        return 0;
    };

    try {
        const auto result = runLoop();
#ifndef _WIN32
        stopSharedMemoryEvalThread(evalThread, stopRequested, sharedMemory ? sharedMemory->requestSemaphore : nullptr);
#endif
        if (!shutdownReceived) provider->shutdown();
        return result;
    } catch (const std::exception& error) {
        writeFramed(encodeProviderFailure(0, "workerFailure", error.what(), true));
#ifndef _WIN32
        stopSharedMemoryEvalThread(evalThread, stopRequested, sharedMemory ? sharedMemory->requestSemaphore : nullptr);
#endif
        try { provider->shutdown(); } catch (...) {}
        return 1;
    }
}
