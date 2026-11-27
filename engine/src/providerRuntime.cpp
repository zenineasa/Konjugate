/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "providerRuntime.hpp"
#include "childProcess.hpp"
#include "cppToolchain.hpp"
#include "relationshipProvider.pb.h"
#include "konjugate/providerSharedMemoryChannel.hpp"
#include "konjugate/providerInProcessAbi.hpp"
#include "programUnits.hpp"

#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <mutex>
#include <regex>
#include <set>
#include <sstream>
#include <openssl/evp.h>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <io.h>
#include <process.h>
#include <fcntl.h>
using ssize_t = intptr_t;
#else
#include <cerrno>
#include <dlfcn.h>
#include <fcntl.h>
#include <semaphore.h>
#include <sys/mman.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif
#include <unordered_map>

#include <vector>

namespace konjugate {
namespace {

using namespace konjugate::provider::protocol;

std::string sha256Hex(const std::string& data) {
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int digestLength = 0;
    EVP_MD_CTX* context = EVP_MD_CTX_new();
    const bool ok = context &&
        EVP_DigestInit_ex(context, EVP_sha256(), nullptr) == 1 &&
        EVP_DigestUpdate(context, data.data(), data.size()) == 1 &&
        EVP_DigestFinal_ex(context, digest, &digestLength) == 1;
    if (context) EVP_MD_CTX_free(context);
    if (!ok) throw std::runtime_error("Failed to hash a C++ relationship provider's inline source.");

    static const char hex[] = "0123456789abcdef";
    std::string result(static_cast<std::size_t>(digestLength) * 2, '0');
    for (unsigned int index = 0; index < digestLength; ++index) {
        const auto position = static_cast<std::size_t>(index) * 2;
        result[position] = hex[(digest[index] >> 4) & 0xf];
        result[position + 1] = hex[digest[index] & 0xf];
    }
    return result;
}

// Python needs no build step, but an inline implementation authored in the editor is still
// literal source text, not a path — it must be written to a real .py file before it can be
// passed to `python3 -m konjugate <path>`. A provider source that already names an existing
// file (as used by references to standalone, non-inline scripts) is passed through as-is.
// Cached alongside compiled C++ providers, by the same source-hash scheme.
std::string preparePythonProviderSource(const std::string& source, const ProviderConfiguration& config) {
    std::error_code existsError;
    if (std::filesystem::exists(source, existsError) && !existsError) return source;

    const auto hash = sha256Hex(source);
    const std::filesystem::path buildRoot = config.buildDirectory.empty()
        ? std::filesystem::temp_directory_path() / "konjugateProviders"
        : std::filesystem::path(config.buildDirectory);
    const auto providerDirectory = buildRoot / hash;
    const auto sourcePath = providerDirectory / "relationship.py";

    if (!std::filesystem::exists(sourcePath)) {
        std::filesystem::create_directories(providerDirectory);
        std::ofstream sourceFile(sourcePath, std::ios::trunc);
        if (!sourceFile) throw std::runtime_error("Failed to write Python provider source to " + sourcePath.string());
        sourceFile << source;
    }
    return sourcePath.string();
}

// executable pairs the inline source with providerWorker.cpp into a standalone process (used
// by the pipe and shared-memory transports); sharedLibrary pairs it with
// providerInProcessShim.cpp into a dlopen()'d/LoadLibrary()'d relationship-shaped plugin (used
// by the in-process transport); nodeSharedLibrary pairs it with providerInProcessNodeShim.cpp
// into a dlopen()'d/LoadLibrary()'d NODE-shaped plugin (N inputs, M named outputs, optional
// checkpoint/restore -- see providerInProcessAbi.hpp's two distinct vtables). All three live
// under the same source-hash build directory, just as different filenames, so choosing a
// different mode/shape for the same source never collides with a previously-built artifact of
// another kind.
enum class CppProviderArtifactKind { executable, sharedLibrary, nodeSharedLibrary, programSharedLibrary };

// Compiles an inline C++ relationship's source, together with the public SDK header and one of
// Konjugate's glue wrappers, into a native provider artifact. The build is cached on disk by a
// hash of the source text AND the glue file's own content, so repeated runs of the same inline
// implementation only pay the compile cost once -- but a Konjugate upgrade that changes the glue
// file itself (a shim bug fix, an SDK change) still invalidates a previously-compiled artifact
// rather than silently reusing code built against the old glue forever, since the fixed OS temp
// directory this caches under (see buildRoot below) is not itself versioned by Konjugate's own
// version number. This is a minimal first build pipeline: it does not yet run declared
// conformance tests or record compiler identity/artifact hash in the project.
std::string buildCppProvider(const std::string& source, const ProviderConfiguration& config, CppProviderArtifactKind kind) {
    if (config.cppSdkPath.empty()) {
        throw std::runtime_error(
            "A C++ relationship provider requires providers.cpp.sdkPath to locate the Konjugate C++ SDK.");
    }

    const bool sharedLibrary = kind != CppProviderArtifactKind::executable;
    const std::string glueFile = kind == CppProviderArtifactKind::programSharedLibrary ? "providerInProcessProgramShim.cpp"
        : kind == CppProviderArtifactKind::nodeSharedLibrary ? "providerInProcessNodeShim.cpp"
        : kind == CppProviderArtifactKind::sharedLibrary ? "providerInProcessShim.cpp" : "providerWorker.cpp";
    // A node-shaped artifact's generated glue dlopen()s a second, external library of its own
    // (e.g. an imported FMU's own compiled binary) -- on Linux that symbol lives in libdl, which
    // (unlike macOS's libSystem or Windows' LoadLibrary) is not linked in by default.
    const bool needsDynamicLoaderLibrary = kind == CppProviderArtifactKind::nodeSharedLibrary;
    const std::filesystem::path sdkRoot(config.cppSdkPath);
    const auto gluePath = sdkRoot / "src" / glueFile;

    std::ifstream glueStream(gluePath, std::ios::binary);
    if (!glueStream) throw std::runtime_error("Failed to read the provider glue file at " + gluePath.string());
    const std::string glueContent((std::istreambuf_iterator<char>(glueStream)), std::istreambuf_iterator<char>());

    const auto hash = sha256Hex(source + '\0' + glueContent);
    const std::filesystem::path buildRoot = config.buildDirectory.empty()
        ? std::filesystem::temp_directory_path() / "konjugateProviders"
        : std::filesystem::path(config.buildDirectory);
    const auto providerDirectory = buildRoot / hash;
#ifdef _WIN32
    const auto artifactPath = providerDirectory / (sharedLibrary ? "provider.dll" : "provider.exe");
#elif defined(__APPLE__)
    const auto artifactPath = providerDirectory / (sharedLibrary ? "provider.dylib" : "provider");
#else
    const auto artifactPath = providerDirectory / (sharedLibrary ? "provider.so" : "provider");
#endif

    if (!std::filesystem::exists(artifactPath)) {
        std::filesystem::create_directories(providerDirectory);
        const auto sourcePath = providerDirectory / "relationship.cpp";
        std::ofstream sourceFile(sourcePath, std::ios::trunc);
        if (!sourceFile) throw std::runtime_error("Failed to write C++ provider source to " + sourcePath.string());
        sourceFile << source;
        sourceFile.close();

        cppToolchain::buildNativeArtifact(sourcePath, gluePath, sdkRoot / "include",
            artifactPath, sharedLibrary, config.cppCompiler,
            kind == CppProviderArtifactKind::programSharedLibrary ? "the C++ program"
                : kind == CppProviderArtifactKind::nodeSharedLibrary ? "the C++ computational-node provider" : "the C++ relationship provider",
            needsDynamicLoaderLibrary);
    }

    return artifactPath.string();
}

} // anonymous namespace

class ProviderBackend {
public:
    virtual ~ProviderBackend() = default;
    virtual void addInstance(std::uint64_t instanceId, const std::vector<CompiledBinding>& bindings) = 0;
    virtual void sendInitialization() = 0;
    virtual std::vector<std::pair<std::uint64_t, double>> evaluateBatch(
        std::uint64_t sequence, double simulationTime, double stepSize,
        const std::vector<std::pair<std::uint64_t, std::span<const double>>>& evaluations) = 0;
    virtual void shutdown() noexcept = 0;
    // The input keys the program's describe() declares, once it has started (after sendInitialization()); empty when the
    // transport cannot tell, which only means no warning about an unbound input is given for it.
    virtual std::vector<std::string> declaredInputKeys() const { return {}; }

    // Throwing defaults: only PipeProviderBackend (the transport Python computational-node
    // providers always use) overrides these. SharedMemoryProviderBackend/InProcessProviderBackend
    // never receive these calls in practice, since createProviderBackend only routes cppProvider
    // tasks to them and node-provider tasks are always pythonProvider this release.
    virtual std::vector<std::pair<std::string, double>> evaluateNode(
        std::uint64_t instanceId, double simulationTime, double stepSize, std::span<const double> inputs) {
        static_cast<void>(instanceId);
        static_cast<void>(simulationTime);
        static_cast<void>(stepSize);
        static_cast<void>(inputs);
        throw std::runtime_error("This provider transport does not support computational-node providers.");
    }
    // A node's outputs at the start of a fresh run (NodeProvider::initialOutputs); nothing when the transport or the node has none.
    virtual std::optional<std::vector<std::pair<std::string, double>>> initialNodeOutputs(
        std::uint64_t instanceId, double simulationTime, std::span<const double> inputs) {
        static_cast<void>(instanceId);
        static_cast<void>(simulationTime);
        static_cast<void>(inputs);
        return std::nullopt;
    }
    virtual std::vector<std::byte> requestCheckpoint(std::uint64_t instanceId) {
        static_cast<void>(instanceId);
        throw std::runtime_error("This provider transport does not support computational-node checkpointing.");
    }
    virtual void requestRestore(std::uint64_t instanceId, std::span<const std::byte> payload) {
        static_cast<void>(instanceId);
        static_cast<void>(payload);
        throw std::runtime_error("This provider transport does not support computational-node restore.");
    }
};

// Owns one provider process's control channel: the start (a ChildProcess, the same class that starts a person's objective program),
// the protocol handshake, the initialize round trip, the pipe evaluateBatch round trip (the hot path for PipeProviderBackend; used by
// SharedMemoryProviderBackend only for handshake/initialize/shutdown, never for evaluation), and shutdown. Both backends below compose
// one of these rather than duplicating process lifecycle handling.
class ProviderControlChannel {
public:
    ProviderControlChannel(std::string processKey, ContributionImplementation implementation,
                           std::string sourcePath, const ProviderConfiguration& config,
                           std::vector<std::pair<std::string, std::string>> extraEnvironment = {}, std::uint32_t apiVersion = 1)
        : processKey_(std::move(processKey)), implementation_(implementation), sourcePath_(std::move(sourcePath)), apiVersion_(apiVersion) {
        spawn(config, std::move(extraEnvironment));
        performHandshake();
    }

    // A version 2 worker's description of its program, from the handshake (empty from a version 1 worker).
    const std::string& programDescription() const noexcept { return programDescription_; }

    // One request and its answer, for messages this class has no method for (version 2's).
    ProviderToEngine request(const EngineToProvider& message, const char* during) { return roundTrip(message, during); }

    ~ProviderControlChannel() { close(); }
    ProviderControlChannel(const ProviderControlChannel&) = delete;
    ProviderControlChannel& operator=(const ProviderControlChannel&) = delete;

    const std::string& processKey() const noexcept { return processKey_; }
    const std::vector<std::string>& declaredInputKeys() const noexcept { return declaredInputKeys_; }

    void sendInitialize(const InitializeRequest& request) {
        if (request.instances_size() == 0) return;
        EngineToProvider msg;
        *msg.mutable_initialize() = request;
        const auto resp = roundTrip(msg, "initialization");
        if (resp.has_failure()) {
            throw std::runtime_error("Provider process initialization failed: " + std::string(resp.failure().message()));
        }
        if (!resp.has_initialize()) {
            throw std::runtime_error("Unexpected response to initialization from provider process " + processKey_);
        }
    }

    std::vector<std::pair<std::uint64_t, double>> evaluateBatchOverPipe(
        std::uint64_t sequence, double simulationTime, double stepSize,
        const std::vector<std::pair<std::uint64_t, std::span<const double>>>& evaluations) {
        EngineToProvider msg;
        auto* batch = msg.mutable_evaluate_batch();
        batch->set_sequence(sequence);
        batch->set_simulation_time(simulationTime);
        batch->set_step_size(stepSize);

        for (const auto& [instId, inputs] : evaluations) {
            auto* eval = batch->add_evaluations();
            eval->set_instance_id(instId);
            for (const auto val : inputs) eval->add_inputs(val);
        }

        const auto resp = roundTrip(msg, "evaluateBatch");
        if (resp.has_failure()) {
            throw std::runtime_error("Provider process evaluation failed: " + std::string(resp.failure().message()));
        }
        if (!resp.has_evaluate_batch()) {
            throw std::runtime_error("Unexpected response to evaluateBatch from provider process " + processKey_);
        }

        std::vector<std::pair<std::uint64_t, double>> results;
        for (const auto& contrib : resp.evaluate_batch().contributions()) {
            results.emplace_back(contrib.instance_id(), contrib.value());
        }
        return results;
    }

    // A node has at most one provider task, so this always carries exactly one NodeEvaluation:
    // there is no cross-instance batching benefit here the way evaluateBatchOverPipe has across
    // multiple relationship-provider instances sharing one process.
    std::vector<std::pair<std::string, double>> sendNodeEvaluate(
        std::uint64_t instanceId, double simulationTime, double stepSize, std::span<const double> inputs) {
        EngineToProvider msg;
        auto* request = msg.mutable_node_evaluate();
        request->set_sequence(0);
        request->set_simulation_time(simulationTime);
        request->set_step_size(stepSize);
        auto* evaluation = request->add_evaluations();
        evaluation->set_instance_id(instanceId);
        for (const auto value : inputs) evaluation->add_inputs(value);

        const auto resp = roundTrip(msg, "nodeEvaluate");
        if (resp.has_failure()) {
            throw std::runtime_error("Provider process node evaluation failed: " + std::string(resp.failure().message()));
        }
        if (!resp.has_node_evaluate()) {
            throw std::runtime_error("Unexpected response to nodeEvaluate from provider process " + processKey_);
        }

        std::vector<std::pair<std::string, double>> results;
        for (const auto& contribution : resp.node_evaluate().contributions()) {
            if (contribution.instance_id() != instanceId) continue;
            for (const auto& output : contribution.outputs()) {
                results.emplace_back(output.key(), output.value());
            }
        }
        return results;
    }

    std::vector<std::byte> sendCheckpoint(std::uint64_t instanceId) {
        EngineToProvider msg;
        msg.mutable_checkpoint()->set_instance_id(instanceId);
        const auto resp = roundTrip(msg, "checkpoint");
        if (resp.has_failure()) {
            throw std::runtime_error("Provider process checkpoint failed: " + std::string(resp.failure().message()));
        }
        if (!resp.has_checkpoint() || resp.checkpoint().instance_id() != instanceId) {
            throw std::runtime_error("Unexpected response to checkpoint from provider process " + processKey_);
        }

        const auto& payload = resp.checkpoint().payload();
        std::vector<std::byte> bytes(payload.size());
        std::transform(payload.begin(), payload.end(), bytes.begin(),
            [](char byte) { return static_cast<std::byte>(byte); });
        return bytes;
    }

    void sendRestore(std::uint64_t instanceId, std::span<const std::byte> payload) {
        EngineToProvider msg;
        auto* request = msg.mutable_restore();
        request->set_instance_id(instanceId);
        request->set_payload(std::string(reinterpret_cast<const char*>(payload.data()), payload.size()));
        const auto resp = roundTrip(msg, "restore");
        if (resp.has_failure()) {
            throw std::runtime_error("Provider process restore failed: " + std::string(resp.failure().message()));
        }
        if (!resp.has_restore() || resp.restore().instance_id() != instanceId || !resp.restore().restored()) {
            throw std::runtime_error("Unexpected response to restore from provider process " + processKey_);
        }
    }

    void close() noexcept {
        if (!process_) return;
        // Best-effort: this whole function is noexcept, and the process is ended right below (its stdin closed, then stopped if it
        // does not end by itself) whether or not the provider answers the shutdown handshake.
        try {
            EngineToProvider msg;
            msg.mutable_shutdown();
            send(msg);
            ProviderToEngine resp;
            receive(resp);
        } catch (...) {} // NOLINT(bugprone-empty-catch)
        process_.reset();
    }

private:
    void spawn(const ProviderConfiguration& config, std::vector<std::pair<std::string, std::string>> environment) {
        std::vector<std::vector<std::string>> commands;
        if (implementation_ == ContributionImplementation::pythonProvider) {
            const std::string pythonExe = config.pythonInterpreter.empty() ? "python3" : config.pythonInterpreter;
            commands.push_back({pythonExe, "-m", "konjugate", sourcePath_});
            // No override was configured, and some platforms only provide the interpreter as "python".
            if (pythonExe == "python3") commands.push_back({"python", "-m", "konjugate", sourcePath_});
            // The interpreter found may be a distribution (Anaconda, a pyenv shim, ...) with no knowledge of Konjugate's SDK; it is
            // put on the child's PYTHONPATH rather than relying on the package being installed into whichever interpreter is found.
            if (!config.pythonSdkPath.empty()) {
#ifdef _WIN32
                constexpr const char* separator = ";";
#else
                constexpr const char* separator = ":";
#endif
                const char* existingPythonPath = std::getenv("PYTHONPATH");
                environment.emplace_back("PYTHONPATH", existingPythonPath && *existingPythonPath
                    ? config.pythonSdkPath + separator + existingPythonPath : config.pythonSdkPath);
            }
        } else {
            commands.push_back({sourcePath_});
        }
        try {
            process_ = std::make_unique<ChildProcess>(commands, environment, true);
        } catch (const std::exception& error) {
            throw std::runtime_error("Provider process " + processKey_ + " could not be started: " + error.what());
        }
    }

    void performHandshake() {
        EngineToProvider msg;
        auto* handshake = msg.mutable_handshake();
        handshake->set_protocol_version(1);
        handshake->set_provider_api_version(apiVersion_);
        const auto resp = roundTrip(msg, "the handshake");
        if (resp.has_failure()) {
            // A program that could not be loaded says why in words (a misspelt port names its line): that message is the error.
            if (apiVersion_ == 2) throw std::runtime_error(std::string(resp.failure().message()));
            throw std::runtime_error("Provider process handshake failed: " + std::string(resp.failure().message()));
        }
        if (!resp.has_handshake()) {
            throw std::runtime_error("Unexpected response to handshake from provider process " + processKey_);
        }
        for (const auto& key : resp.handshake().input_keys()) declaredInputKeys_.emplace_back(key);
        programDescription_ = std::string(resp.handshake().program_description());
    }

    void send(const google::protobuf::MessageLite& message) {
        std::string payload;
        if (!message.SerializeToString(&payload)) {
            throw std::runtime_error("Failed to serialize message for provider process.");
        }
        process_->writeFrame(payload);
    }

    bool receive(ProviderToEngine& message) {
        std::string payload;
        if (!process_->readFrame(payload, ChildProcess::noLimit)) return false;
        return message.ParseFromString(payload);
    }

    // One request and its answer. A provider that ends instead of answering is reported with the last of what it wrote to stderr.
    ProviderToEngine roundTrip(const EngineToProvider& message, const char* during) {
        ProviderToEngine resp;
        bool answered = false;
        try {
            send(message);
            answered = receive(resp);
        } catch (const std::exception&) {
            answered = false;
        }
        if (!answered) {
            auto said = process_->diagnostics();
            while (!said.empty() && (said.back() == '\n' || said.back() == '\r')) said.pop_back();
            throw std::runtime_error("Provider process " + processKey_ + " ended during " + during +
                (said.empty() ? std::string(".") : ": " + said));
        }
        return resp;
    }

    std::string processKey_;
    ContributionImplementation implementation_;
    std::string sourcePath_;
    std::uint32_t apiVersion_ = 1;
    std::string programDescription_;
    std::unique_ptr<ChildProcess> process_;
    std::vector<std::string> declaredInputKeys_;
};

class PipeProviderBackend final : public ProviderBackend {
public:
    PipeProviderBackend(std::string processKey, ContributionImplementation implementation,
                        std::string sourcePath, const ProviderConfiguration& config)
        : channel_(std::move(processKey), implementation, std::move(sourcePath), config) {}

    void addInstance(std::uint64_t instanceId, const std::vector<CompiledBinding>& bindings) override {
        auto* inst = initializeReq_.add_instances();
        inst->set_instance_id(instanceId);
        for (const auto& binding : bindings) inst->add_input_keys(binding.symbol);
    }

    void sendInitialization() override { channel_.sendInitialize(initializeReq_); }
    std::vector<std::string> declaredInputKeys() const override { return channel_.declaredInputKeys(); }

    std::vector<std::pair<std::uint64_t, double>> evaluateBatch(
        std::uint64_t sequence, double simulationTime, double stepSize,
        const std::vector<std::pair<std::uint64_t, std::span<const double>>>& evaluations) override {
        // Multiple relationship instances sharing this worker may be evaluated from
        // different execution-plan threads in the same synchronization step; the pipe
        // round-trip is not reentrant, so concurrent callers must be serialized here.
        std::lock_guard<std::mutex> lock(mutex_);
        return channel_.evaluateBatchOverPipe(sequence, simulationTime, stepSize, evaluations);
    }

    void shutdown() noexcept override {
        std::lock_guard<std::mutex> lock(mutex_);
        channel_.close();
    }

    std::vector<std::pair<std::string, double>> evaluateNode(
        std::uint64_t instanceId, double simulationTime, double stepSize, std::span<const double> inputs) override {
        std::lock_guard<std::mutex> lock(mutex_);
        return channel_.sendNodeEvaluate(instanceId, simulationTime, stepSize, inputs);
    }

    std::vector<std::byte> requestCheckpoint(std::uint64_t instanceId) override {
        std::lock_guard<std::mutex> lock(mutex_);
        return channel_.sendCheckpoint(instanceId);
    }

    void requestRestore(std::uint64_t instanceId, std::span<const std::byte> payload) override {
        std::lock_guard<std::mutex> lock(mutex_);
        channel_.sendRestore(instanceId, payload);
    }

private:
    ProviderControlChannel channel_;
    InitializeRequest initializeReq_;
    std::mutex mutex_;
};

#ifndef _WIN32
// Uses shared memory plus a pair of named POSIX semaphores for the hot evaluateBatch path
// instead of the pipe, cutting the fixed per-round-trip cost (a syscall pair plus a scheduler
// wake) that dominates when many contributions share one provider process. Handshake,
// initialize and shutdown still go over the same pipe-based control channel as
// PipeProviderBackend: those are rare, so there is nothing to gain by moving them, and reusing
// the existing protocol there keeps this class small. POSIX-only: this mode is never selected
// on Windows, where ProviderRuntime falls back to PipeProviderBackend.
class SharedMemoryProviderBackend final : public ProviderBackend {
public:
    SharedMemoryProviderBackend(std::string processKey, ContributionImplementation implementation,
                                std::string sourcePath, const ProviderConfiguration& config)
        : resources_(processKey),
          channel_(std::move(processKey), implementation, std::move(sourcePath), config, resources_.environment()) {}

    void addInstance(std::uint64_t instanceId, const std::vector<CompiledBinding>& bindings) override {
        auto* inst = initializeReq_.add_instances();
        inst->set_instance_id(instanceId);
        for (const auto& binding : bindings) inst->add_input_keys(binding.symbol);
    }

    void sendInitialization() override { channel_.sendInitialize(initializeReq_); }
    std::vector<std::string> declaredInputKeys() const override { return channel_.declaredInputKeys(); }

    std::vector<std::pair<std::uint64_t, double>> evaluateBatch(
        std::uint64_t sequence, double simulationTime, double stepSize,
        const std::vector<std::pair<std::uint64_t, std::span<const double>>>& evaluations) override {
        static_cast<void>(sequence);
        std::lock_guard<std::mutex> lock(mutex_);

        std::vector<std::pair<std::uint64_t, double>> results;
        results.reserve(evaluations.size());

        // The channel's slot array has a fixed size, so a batch larger than that capacity is
        // sent as multiple round trips rather than growing the shared struct without bound.
        for (std::size_t offset = 0; offset < evaluations.size(); offset += provider::sharedmem::kMaxSlots) {
            const auto count = std::min(provider::sharedmem::kMaxSlots, evaluations.size() - offset);
            auto* channel = resources_.channel;
            channel->slotCount = static_cast<std::uint32_t>(count);
            channel->simulationTime = simulationTime;
            channel->stepSize = stepSize;
            channel->failed = false;

            for (std::size_t index = 0; index < count; ++index) {
                const auto& [instanceId, inputs] = evaluations[offset + index];
                if (inputs.size() > provider::sharedmem::kMaxInputsPerSlot) {
                    throw std::runtime_error(
                        "A provider input list exceeds the shared-memory transport's fixed capacity.");
                }
                auto& slot = channel->slots[index];
                slot.instanceId = instanceId;
                slot.inputCount = static_cast<std::uint32_t>(inputs.size());
                std::copy(inputs.begin(), inputs.end(), slot.inputs);
            }

            if (::sem_post(resources_.requestSemaphore) != 0) {
                throw std::runtime_error("Failed to signal provider process " + channel_.processKey() + " for evaluation.");
            }
            while (::sem_wait(resources_.responseSemaphore) != 0) {
                if (errno != EINTR) {
                    throw std::runtime_error("Failed waiting on provider process " + channel_.processKey() + " for a result.");
                }
            }

            if (channel->failed) {
                throw std::runtime_error("Provider process " + channel_.processKey() +
                    " failed during shared-memory evaluation: " + std::string(channel->errorMessage));
            }
            for (std::size_t index = 0; index < count; ++index) {
                results.emplace_back(channel->slots[index].instanceId, channel->slots[index].output);
            }
        }
        return results;
    }

    void shutdown() noexcept override {
        std::lock_guard<std::mutex> lock(mutex_);
        channel_.close();
    }

private:
    // Owns the shared-memory region and the two named semaphores used to hand evaluation
    // requests/responses across the process boundary. Declared before channel_ so it is
    // constructed first (the worker needs these names as environment variables at spawn time)
    // and destroyed last: member destruction runs in reverse declaration order, so channel_'s
    // shutdown (which waits for the worker's shutdown acknowledgement over the pipe, sent only
    // after the worker has stopped touching shared memory) always completes before this tears
    // the mapping down.
    struct SharedResources {
        std::string shmName;
        std::string requestSemaphoreName;
        std::string responseSemaphoreName;
        int shmFd = -1;
        provider::sharedmem::Channel* channel = nullptr;
        sem_t* requestSemaphore = SEM_FAILED;
        sem_t* responseSemaphore = SEM_FAILED;

        explicit SharedResources(const std::string& processKey) { create(processKey); }
        ~SharedResources() { destroy(); }
        SharedResources(const SharedResources&) = delete;
        SharedResources& operator=(const SharedResources&) = delete;

        std::vector<std::pair<std::string, std::string>> environment() const {
            return {
                {provider::sharedmem::kSharedMemoryEnvVar, shmName},
                {provider::sharedmem::kRequestSemaphoreEnvVar, requestSemaphoreName},
                {provider::sharedmem::kResponseSemaphoreEnvVar, responseSemaphoreName},
            };
        }

        void create(const std::string& processKey) {
            static std::atomic<std::uint64_t> counter{0};
            static_cast<void>(processKey);
            // macOS enforces a short (31-character, including the slash) limit on sem_open()
            // names, so these stay compact rather than embedding the process key.
            const auto token = std::to_string(::getpid()) + "_" +
                std::to_string(counter.fetch_add(1, std::memory_order_relaxed));
            shmName = "/kjs" + token;
            requestSemaphoreName = "/kjq" + token;
            responseSemaphoreName = "/kjr" + token;

            shmFd = ::shm_open(shmName.c_str(), O_CREAT | O_EXCL | O_RDWR, 0600);
            if (shmFd < 0) throw std::runtime_error("Failed to create a shared-memory provider channel.");
            if (::ftruncate(shmFd, sizeof(provider::sharedmem::Channel)) != 0) {
                destroy();
                throw std::runtime_error("Failed to size a shared-memory provider channel.");
            }
            void* mapped = ::mmap(nullptr, sizeof(provider::sharedmem::Channel),
                                  PROT_READ | PROT_WRITE, MAP_SHARED, shmFd, 0);
            if (mapped == MAP_FAILED) {
                destroy();
                throw std::runtime_error("Failed to map a shared-memory provider channel.");
            }
            // shm_open + ftruncate zero-fills new POSIX shared memory, which already matches
            // Channel's intended default state, so no placement-new is needed: both this
            // process and the worker just reinterpret the mapping as a Channel*. (There is no
            // fully portable way to construct a C++ object shared across address spaces;
            // treating the mapping as plain, semaphore-guarded POD bytes sidesteps that.)
            channel = reinterpret_cast<provider::sharedmem::Channel*>(mapped);

            requestSemaphore = ::sem_open(requestSemaphoreName.c_str(), O_CREAT | O_EXCL, 0600, 0);
            if (requestSemaphore == SEM_FAILED) {
                destroy();
                throw std::runtime_error("Failed to create a shared-memory provider request semaphore.");
            }
            responseSemaphore = ::sem_open(responseSemaphoreName.c_str(), O_CREAT | O_EXCL, 0600, 0);
            if (responseSemaphore == SEM_FAILED) {
                destroy();
                throw std::runtime_error("Failed to create a shared-memory provider response semaphore.");
            }
        }

        void destroy() noexcept {
            if (requestSemaphore != SEM_FAILED) {
                ::sem_close(requestSemaphore);
                ::sem_unlink(requestSemaphoreName.c_str());
                requestSemaphore = SEM_FAILED;
            }
            if (responseSemaphore != SEM_FAILED) {
                ::sem_close(responseSemaphore);
                ::sem_unlink(responseSemaphoreName.c_str());
                responseSemaphore = SEM_FAILED;
            }
            if (channel) {
                ::munmap(channel, sizeof(provider::sharedmem::Channel));
                channel = nullptr;
            }
            if (shmFd >= 0) {
                ::close(shmFd);
                shmFd = -1;
            }
            if (!shmName.empty()) ::shm_unlink(shmName.c_str());
        }
    };

    SharedResources resources_;
    ProviderControlChannel channel_;
    InitializeRequest initializeReq_;
    std::mutex mutex_;
};
#endif

// Loads the provider directly into the engine process via dlopen()/LoadLibrary() and calls it
// through the C ABI in providerInProcessAbi.hpp — no IPC, no worker process. This is the
// fastest transport by a wide margin, but it gives up process isolation entirely: a crash,
// hang, or stack overflow in the provider's own code takes the whole engine process with it,
// so ProviderExecutionMode::inProcess is meant to stay an explicit opt-in for providers the
// caller already trusts, never a default. Available on Windows too (LoadLibrary/GetProcAddress
// carry none of SharedMemoryProviderBackend's cross-process-synchronization-primitive
// portability concerns), so this is not POSIX-gated the way that backend is.
class InProcessProviderBackend final : public ProviderBackend {
public:
    InProcessProviderBackend(std::string processKey, ContributionImplementation implementation,
                             std::string libraryPath, const ProviderConfiguration& config)
        : processKey_(std::move(processKey)) {
        static_cast<void>(implementation);
        static_cast<void>(config);
        loadLibrary(libraryPath);
        instance_ = vtable_->create();
        if (!instance_) {
            const std::string message = vtable_->lastError(nullptr);
            unloadLibrary();
            throw std::runtime_error("Failed to construct in-process provider '" + processKey_ + "': " + message);
        }
    }

    ~InProcessProviderBackend() override { unload(); }

    void addInstance(std::uint64_t instanceId, const std::vector<CompiledBinding>& bindings) override {
        std::vector<std::string> keys;
        keys.reserve(bindings.size());
        for (const auto& binding : bindings) keys.push_back(binding.symbol);
        pendingInstances_.emplace_back(instanceId, std::move(keys));
    }

    std::vector<std::string> declaredInputKeys() const override {
        std::vector<std::string> keys;
        const auto count = vtable_->inputCount(instance_);
        for (std::uint32_t index = 0; index < count; ++index) keys.emplace_back(vtable_->inputKey(instance_, index));
        return keys;
    }

    void sendInitialization() override {
        for (const auto& [instanceId, keys] : pendingInstances_) {
            std::vector<const char*> keyPointers;
            keyPointers.reserve(keys.size());
            for (const auto& key : keys) keyPointers.push_back(key.c_str());
            if (!vtable_->initializeInstance(instance_, instanceId, keyPointers.data(),
                                             static_cast<std::uint32_t>(keyPointers.size()))) {
                throw std::runtime_error("In-process provider '" + processKey_ + "' failed to initialize an instance: " +
                    std::string(vtable_->lastError(instance_)));
            }
        }
        pendingInstances_.clear();
    }

    std::vector<std::pair<std::uint64_t, double>> evaluateBatch(
        std::uint64_t sequence, double simulationTime, double stepSize,
        const std::vector<std::pair<std::uint64_t, std::span<const double>>>& evaluations) override {
        static_cast<void>(sequence);
        // There is no IPC to serialize here, but user-authored provider code is not guaranteed
        // thread-safe (e.g. it may hold mutable member state a real relationship implementation
        // updates across calls); matching the concurrency guarantee the other two backends
        // already give such code, calls stay serialized here too rather than silently imposing
        // a new thread-safety requirement on existing provider implementations.
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<std::pair<std::uint64_t, double>> results;
        results.reserve(evaluations.size());
        for (const auto& [instanceId, inputs] : evaluations) {
            double value = 0;
            if (!vtable_->evaluateInstance(instance_, instanceId, simulationTime, stepSize,
                                           inputs.data(), static_cast<std::uint32_t>(inputs.size()), &value)) {
                throw std::runtime_error("In-process provider '" + processKey_ + "' evaluation failed: " +
                    std::string(vtable_->lastError(instance_)));
            }
            results.emplace_back(instanceId, value);
        }
        return results;
    }

    void shutdown() noexcept override {
        std::lock_guard<std::mutex> lock(mutex_);
        unload();
    }

private:
    void loadLibrary(const std::string& path) {
#ifdef _WIN32
        handle_ = ::LoadLibraryA(path.c_str());
        if (!handle_) throw std::runtime_error("Failed to load in-process provider library '" + path + "'.");
        auto entryPoint = reinterpret_cast<KonjugateInProcessProviderV1Fn>(
            ::GetProcAddress(handle_, kKonjugateInProcessProviderEntryPoint));
#else
        handle_ = ::dlopen(path.c_str(), RTLD_LOCAL | RTLD_NOW);
        if (!handle_) {
            throw std::runtime_error("Failed to load in-process provider library '" + path + "': " +
                std::string(::dlerror()));
        }
        auto entryPoint = reinterpret_cast<KonjugateInProcessProviderV1Fn>(
            ::dlsym(handle_, kKonjugateInProcessProviderEntryPoint));
#endif
        if (!entryPoint) {
            unloadLibrary();
            throw std::runtime_error("In-process provider library '" + path + "' is missing its entry point.");
        }
        vtable_ = entryPoint();
        if (!vtable_) {
            unloadLibrary();
            throw std::runtime_error("In-process provider library '" + path + "' returned a null vtable.");
        }
    }

    void unloadLibrary() noexcept {
#ifdef _WIN32
        if (handle_) { ::FreeLibrary(handle_); handle_ = nullptr; }
#else
        if (handle_) { ::dlclose(handle_); handle_ = nullptr; }
#endif
        vtable_ = nullptr;
    }

    void unload() noexcept {
        if (instance_ && vtable_) {
            vtable_->shutdownProvider(instance_);
            vtable_->destroy(instance_);
            instance_ = nullptr;
        }
        unloadLibrary();
    }

    std::string processKey_;
    const KonjugateInProcessProviderV1* vtable_ = nullptr;
    void* instance_ = nullptr;
#ifdef _WIN32
    HMODULE handle_ = nullptr;
#else
    void* handle_ = nullptr;
#endif
    std::vector<std::pair<std::uint64_t, std::vector<std::string>>> pendingInstances_;
    std::mutex mutex_;
};

// The node-shaped counterpart to InProcessProviderBackend above: same dlopen()/LoadLibrary()
// mechanism, same "no crash isolation, opt-in only" tradeoff (see providerInProcessAbi.hpp and
// docs/providerExecution.md), but drives KonjugateInProcessNodeProviderV1 (N inputs, M named
// outputs, optional checkpoint/restore) instead of the relationship-shaped V1 -- overriding
// evaluateNode/requestCheckpoint/requestRestore rather than evaluateBatch.
class InProcessNodeProviderBackend final : public ProviderBackend {
public:
    InProcessNodeProviderBackend(std::string processKey, std::string libraryPath, const ProviderConfiguration& config)
        : processKey_(std::move(processKey)) {
        static_cast<void>(config);
        loadLibrary(libraryPath);
        instance_ = vtable_->create();
        if (!instance_) {
            const std::string message = vtable_->lastError(nullptr);
            unloadLibrary();
            throw std::runtime_error("A node program could not be loaded: " + message);
        }
    }

    ~InProcessNodeProviderBackend() override { unload(); }

    void addInstance(std::uint64_t instanceId, const std::vector<CompiledBinding>& bindings) override {
        std::vector<std::string> keys;
        keys.reserve(bindings.size());
        for (const auto& binding : bindings) keys.push_back(binding.symbol);
        pendingInstances_.emplace_back(instanceId, std::move(keys));
    }

    std::vector<std::string> declaredInputKeys() const override {
        std::vector<std::string> keys;
        const auto count = vtable_->inputCount(instance_);
        for (std::uint32_t index = 0; index < count; ++index) keys.emplace_back(vtable_->inputKey(instance_, index));
        return keys;
    }

    void sendInitialization() override {
        for (const auto& [instanceId, keys] : pendingInstances_) {
            std::vector<const char*> keyPointers;
            keyPointers.reserve(keys.size());
            for (const auto& key : keys) keyPointers.push_back(key.c_str());
            if (!vtable_->initializeInstance(instance_, instanceId, keyPointers.data(),
                                             static_cast<std::uint32_t>(keyPointers.size()))) {
                throw std::runtime_error("A node program could not start: " +
                    std::string(vtable_->lastError(instance_)));
            }
        }
        pendingInstances_.clear();
    }

    std::vector<std::pair<std::uint64_t, double>> evaluateBatch(
        std::uint64_t, double, double,
        const std::vector<std::pair<std::uint64_t, std::span<const double>>>&) override {
        throw std::runtime_error("A node program cannot be evaluated as a relationship.");
    }

    std::vector<std::pair<std::string, double>> evaluateNode(
        std::uint64_t instanceId, double simulationTime, double stepSize, std::span<const double> inputs) override {
        std::lock_guard<std::mutex> lock(mutex_);
        if (outputKeys_.empty()) cacheOutputKeys();
        std::vector<double> outValues(outputKeys_.size(), 0.0);
        if (!vtable_->evaluateInstance(instance_, instanceId, simulationTime, stepSize,
                                       inputs.data(), static_cast<std::uint32_t>(inputs.size()),
                                       outValues.data(), static_cast<std::uint32_t>(outValues.size()))) {
            throw std::runtime_error("A node program failed: " +
                std::string(vtable_->lastError(instance_)));
        }
        std::vector<std::pair<std::string, double>> results;
        results.reserve(outputKeys_.size());
        for (std::size_t index = 0; index < outputKeys_.size(); ++index) results.emplace_back(outputKeys_[index], outValues[index]);
        return results;
    }

    std::optional<std::vector<std::pair<std::string, double>>> initialNodeOutputs(
        std::uint64_t instanceId, double simulationTime, std::span<const double> inputs) override {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!initialOutputs_) return std::nullopt;
        if (outputKeys_.empty()) cacheOutputKeys();
        std::vector<double> outValues(outputKeys_.size(), 0.0);
        std::int32_t given = 0;
        if (!initialOutputs_(instance_, instanceId, simulationTime, inputs.data(), static_cast<std::uint32_t>(inputs.size()),
                             outValues.data(), static_cast<std::uint32_t>(outValues.size()), &given)) {
            throw std::runtime_error("A node program failed: " + std::string(vtable_->lastError(instance_)));
        }
        if (!given) return std::nullopt;
        std::vector<std::pair<std::string, double>> results;
        results.reserve(outputKeys_.size());
        for (std::size_t index = 0; index < outputKeys_.size(); ++index) results.emplace_back(outputKeys_[index], outValues[index]);
        return results;
    }

    std::vector<std::byte> requestCheckpoint(std::uint64_t instanceId) override {
        std::lock_guard<std::mutex> lock(mutex_);
        std::uint32_t size = 0;
        if (!vtable_->requestCheckpoint(instance_, instanceId, nullptr, 0, &size)) {
            throw std::runtime_error("A node program declined checkpointing: " +
                std::string(vtable_->lastError(instance_)));
        }
        std::vector<std::uint8_t> buffer(size);
        std::uint32_t written = 0;
        if (!vtable_->requestCheckpoint(instance_, instanceId, buffer.data(), static_cast<std::uint32_t>(buffer.size()), &written)) {
            throw std::runtime_error("A node program could not fill its checkpoint: " +
                std::string(vtable_->lastError(instance_)));
        }
        std::vector<std::byte> result(written);
        std::memcpy(result.data(), buffer.data(), written);
        return result;
    }

    void requestRestore(std::uint64_t instanceId, std::span<const std::byte> payload) override {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!vtable_->requestRestore(instance_, instanceId,
                                     reinterpret_cast<const std::uint8_t*>(payload.data()),
                                     static_cast<std::uint32_t>(payload.size()))) {
            throw std::runtime_error("A node program could not restore its checkpoint: " +
                std::string(vtable_->lastError(instance_)));
        }
    }

    void shutdown() noexcept override {
        std::lock_guard<std::mutex> lock(mutex_);
        unload();
    }

private:
    void cacheOutputKeys() {
        const auto count = vtable_->outputCount(instance_);
        outputKeys_.reserve(count);
        for (std::uint32_t index = 0; index < count; ++index) outputKeys_.emplace_back(vtable_->outputKey(instance_, index));
    }

    void loadLibrary(const std::string& path) {
#ifdef _WIN32
        handle_ = ::LoadLibraryA(path.c_str());
        if (!handle_) throw std::runtime_error("Failed to load in-process computational-node provider library '" + path + "'.");
        auto entryPoint = reinterpret_cast<KonjugateInProcessNodeProviderV1Fn>(
            ::GetProcAddress(handle_, kKonjugateInProcessNodeProviderEntryPoint));
        initialOutputs_ = reinterpret_cast<KonjugateInProcessNodeInitialOutputsV1Fn>(
            ::GetProcAddress(handle_, kKonjugateInProcessNodeInitialOutputsEntryPoint));
#else
        handle_ = ::dlopen(path.c_str(), RTLD_LOCAL | RTLD_NOW);
        if (!handle_) {
            throw std::runtime_error("Failed to load in-process computational-node provider library '" + path + "': " +
                std::string(::dlerror()));
        }
        auto entryPoint = reinterpret_cast<KonjugateInProcessNodeProviderV1Fn>(
            ::dlsym(handle_, kKonjugateInProcessNodeProviderEntryPoint));
        // Optional: a library built before it was added has none, and its nodes start as they did.
        initialOutputs_ = reinterpret_cast<KonjugateInProcessNodeInitialOutputsV1Fn>(
            ::dlsym(handle_, kKonjugateInProcessNodeInitialOutputsEntryPoint));
#endif
        if (!entryPoint) {
            unloadLibrary();
            throw std::runtime_error("In-process computational-node provider library '" + path + "' is missing its entry point.");
        }
        vtable_ = entryPoint();
        if (!vtable_) {
            unloadLibrary();
            throw std::runtime_error("In-process computational-node provider library '" + path + "' returned a null vtable.");
        }
    }

    void unloadLibrary() noexcept {
#ifdef _WIN32
        if (handle_) { ::FreeLibrary(handle_); handle_ = nullptr; }
#else
        if (handle_) { ::dlclose(handle_); handle_ = nullptr; }
#endif
        vtable_ = nullptr;
    }

    void unload() noexcept {
        if (instance_ && vtable_) {
            vtable_->shutdownProvider(instance_);
            vtable_->destroy(instance_);
            instance_ = nullptr;
        }
        unloadLibrary();
    }

    std::string processKey_;
    const KonjugateInProcessNodeProviderV1* vtable_ = nullptr;
    KonjugateInProcessNodeInitialOutputsV1Fn initialOutputs_ = nullptr;
    void* instance_ = nullptr;
#ifdef _WIN32
    HMODULE handle_ = nullptr;
#else
    void* handle_ = nullptr;
#endif
    std::vector<std::pair<std::uint64_t, std::vector<std::string>>> pendingInstances_;
    std::vector<std::string> outputKeys_;
    std::mutex mutex_;
};

#ifdef __EMSCRIPTEN__
extern "C" {
// Synchronous call into JS: Module.evaluatePythonProviderBridge (src/webPythonProviderBridge.mjs)
// dispatches to a Pyodide-backed interpreter and returns before this call returns, since Pyodide
// code execution (once loaded) is itself synchronous from JS's point of view. The returned
// buffer is malloc'd on the JS side (via _malloc/stringToUTF8) and must be freed by the caller.
EM_JS(char*, wasmDispatchPythonProviderRequest, (const char* requestJson), {
    const request = UTF8ToString(requestJson);
    let responseJson;
    try {
        if (typeof Module.evaluatePythonProviderBridge !== 'function') {
            throw new Error('The Python provider bridge is not available in this build.');
        }
        responseJson = Module.evaluatePythonProviderBridge(request);
    } catch (error) {
        responseJson = JSON.stringify({
            ok: false, code: 'bridgeFailure',
            message: (error && error.message) ? String(error.message) : String(error),
            fatal: true
        });
    }
    const length = lengthBytesUTF8(responseJson) + 1;
    const buffer = _malloc(length);
    stringToUTF8(responseJson, buffer, length);
    return buffer;
});
}

// The web edition's Python-provider transport (docs/proposals/webEdition.md, phase 4): there is
// no OS process to fork into inside a browser tab, so this calls directly into a Pyodide-backed
// interpreter running in the same JS context as the engine, via the synchronous EM_JS call
// above, instead of PipeProviderBackend's fork+pipe+protobuf transport. The wire shape here is
// plain JSON (not protobuf) -- see engine/sdk/python/konjugate/_webBridge.py for the other side
// of this exact contract; it reuses __main__.py's own per-message handlers unchanged, so
// behavior matches the native pipe transport exactly, just without the process/framing overhead.
// C++ providers are entirely unaffected: createProviderBackend only ever routes non-cppProvider
// (i.e. python) tasks here.
//
// boost::property_tree's JSON writer quotes every leaf value as a string (it has no numeric
// type of its own) -- _webBridge.py tolerates that on its end (see its _int/_float helpers)
// rather than this class hand-rolling a numeric-aware JSON writer.
class WasmPyodideProviderBackend final : public ProviderBackend {
public:
    WasmPyodideProviderBackend(std::string processKey, std::string providerSource)
        : processKey_(std::move(processKey)) {
        boost::property_tree::ptree request;
        request.put("kind", "create");
        request.put("processKey", processKey_);
        request.put("source", providerSource);
        dispatch(request);
    }

    void addInstance(std::uint64_t instanceId, const std::vector<CompiledBinding>& bindings) override {
        boost::property_tree::ptree keys;
        for (const auto& binding : bindings) {
            boost::property_tree::ptree key;
            key.put_value(binding.symbol);
            keys.push_back({"", key});
        }
        boost::property_tree::ptree instance;
        instance.put("instanceId", instanceId);
        instance.add_child("inputKeys", keys);
        pendingInstances_.push_back({"", instance});
    }

    void sendInitialization() override {
        boost::property_tree::ptree request;
        request.put("kind", "initialize");
        request.put("processKey", processKey_);
        request.add_child("instances", pendingInstances_);
        const auto response = dispatch(request);
        pendingInstances_.clear();
        if (const auto keys = response.get_child_optional("inputKeys")) {
            for (const auto& [unused, key] : *keys) { static_cast<void>(unused); declaredInputKeys_.push_back(key.get_value<std::string>()); }
        }
    }

    std::vector<std::string> declaredInputKeys() const override { return declaredInputKeys_; }

    std::vector<std::pair<std::uint64_t, double>> evaluateBatch(
        std::uint64_t sequence, double simulationTime, double stepSize,
        const std::vector<std::pair<std::uint64_t, std::span<const double>>>& evaluations) override {
        boost::property_tree::ptree request;
        request.put("kind", "evaluateBatch");
        request.put("processKey", processKey_);
        request.put("sequence", sequence);
        request.put("simulationTime", simulationTime);
        request.put("stepSize", stepSize);
        request.add_child("evaluations", encodeEvaluations(evaluations));
        const auto response = dispatch(request);
        std::vector<std::pair<std::uint64_t, double>> results;
        for (const auto& [key, item] : response.get_child("contributions")) {
            static_cast<void>(key);
            results.emplace_back(item.get<std::uint64_t>("instanceId"), item.get<double>("value"));
        }
        return results;
    }

    std::vector<std::pair<std::string, double>> evaluateNode(
        std::uint64_t instanceId, double simulationTime, double stepSize, std::span<const double> inputs) override {
        boost::property_tree::ptree request;
        request.put("kind", "evaluateNode");
        request.put("processKey", processKey_);
        request.put("sequence", 0);
        request.put("simulationTime", simulationTime);
        request.put("stepSize", stepSize);
        const std::vector<std::pair<std::uint64_t, std::span<const double>>> evaluations{{instanceId, inputs}};
        request.add_child("evaluations", encodeEvaluations(evaluations));
        const auto response = dispatch(request);
        std::vector<std::pair<std::string, double>> outputs;
        for (const auto& [key, contribution] : response.get_child("contributions")) {
            static_cast<void>(key);
            for (const auto& [outputKey, outputValue] : contribution.get_child("outputs")) {
                outputs.emplace_back(outputKey, outputValue.get_value<double>());
            }
        }
        return outputs;
    }

    std::vector<std::byte> requestCheckpoint(std::uint64_t instanceId) override {
        boost::property_tree::ptree request;
        request.put("kind", "checkpoint");
        request.put("processKey", processKey_);
        request.put("instanceId", instanceId);
        const auto response = dispatch(request);
        return decodeBase64(response.get<std::string>("payloadBase64"));
    }

    void requestRestore(std::uint64_t instanceId, std::span<const std::byte> payload) override {
        boost::property_tree::ptree request;
        request.put("kind", "restore");
        request.put("processKey", processKey_);
        request.put("instanceId", instanceId);
        request.put("payloadBase64", encodeBase64(payload));
        dispatch(request);
    }

    void shutdown() noexcept override {
        try {
            boost::property_tree::ptree request;
            request.put("kind", "shutdown");
            request.put("processKey", processKey_);
            dispatch(request);
        } catch (const std::exception& error) {
            std::cerr << "Failed to shut down web Python provider '" << processKey_ << "': " << error.what() << '\n';
        }
    }

private:
    static boost::property_tree::ptree encodeEvaluations(
        const std::vector<std::pair<std::uint64_t, std::span<const double>>>& evaluations) {
        boost::property_tree::ptree array;
        for (const auto& [instanceId, inputs] : evaluations) {
            boost::property_tree::ptree values;
            for (double value : inputs) {
                boost::property_tree::ptree item;
                item.put_value(value);
                values.push_back({"", item});
            }
            boost::property_tree::ptree entry;
            entry.put("instanceId", instanceId);
            entry.add_child("inputs", values);
            array.push_back({"", entry});
        }
        return array;
    }

    static std::string encodeBase64(std::span<const std::byte> payload) {
        static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        std::string result;
        result.reserve(((payload.size() + 2) / 3) * 4);
        std::size_t index = 0;
        while (index + 3 <= payload.size()) {
            const auto b0 = static_cast<unsigned>(payload[index]);
            const auto b1 = static_cast<unsigned>(payload[index + 1]);
            const auto b2 = static_cast<unsigned>(payload[index + 2]);
            result += table[b0 >> 2];
            result += table[((b0 & 0x03) << 4) | (b1 >> 4)];
            result += table[((b1 & 0x0f) << 2) | (b2 >> 6)];
            result += table[b2 & 0x3f];
            index += 3;
        }
        const auto remaining = payload.size() - index;
        if (remaining == 1) {
            const auto b0 = static_cast<unsigned>(payload[index]);
            result += table[b0 >> 2];
            result += table[(b0 & 0x03) << 4];
            result += "==";
        } else if (remaining == 2) {
            const auto b0 = static_cast<unsigned>(payload[index]);
            const auto b1 = static_cast<unsigned>(payload[index + 1]);
            result += table[b0 >> 2];
            result += table[((b0 & 0x03) << 4) | (b1 >> 4)];
            result += table[(b1 & 0x0f) << 2];
            result += "=";
        }
        return result;
    }

    static std::vector<std::byte> decodeBase64(const std::string& encoded) {
        static const auto table = [] {
            std::array<int, 256> map{};
            map.fill(-1);
            const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            for (int index = 0; index < 64; ++index) map[static_cast<unsigned char>(alphabet[index])] = index;
            return map;
        }();
        std::vector<std::byte> result;
        result.reserve((encoded.size() / 4) * 3);
        int buffer = 0;
        int bits = 0;
        for (char character : encoded) {
            if (character == '=') break;
            const auto value = table[static_cast<unsigned char>(character)];
            if (value < 0) continue;
            buffer = (buffer << 6) | value;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                result.push_back(static_cast<std::byte>((buffer >> bits) & 0xff));
            }
        }
        return result;
    }

    boost::property_tree::ptree dispatch(const boost::property_tree::ptree& request) {
        std::ostringstream requestStream;
        boost::property_tree::write_json(requestStream, request, false);
        char* responsePointer = wasmDispatchPythonProviderRequest(requestStream.str().c_str());
        const std::string responseJson(responsePointer);
        std::free(responsePointer);

        boost::property_tree::ptree response;
        std::istringstream responseStream(responseJson);
        boost::property_tree::read_json(responseStream, response);
        if (!response.get<bool>("ok", false)) {
            throw std::runtime_error("Web Python provider '" + processKey_ + "' failed: " +
                response.get<std::string>("message", "unknown error"));
        }
        return response;
    }

    std::string processKey_;
    boost::property_tree::ptree pendingInstances_;
    std::vector<std::string> declaredInputKeys_;
};

extern "C" {
// Plain synchronous calls into JS, exactly like wasmDispatchPythonProviderRequest above -- unlike
// that first attempt at this (an earlier revision of this file tried to spawn the compiled
// provider as a live Wasmer-hosted OS process, which needs a genuinely async bridge since
// @wasmer/sdk's process stdin/stdout are real Promise-based Streams), the web edition's C++
// provider (see src/webCppProviderBridge.mjs) is instead a WASI-exports build of the SAME
// engine/src/providerWorker.cpp glue file PipeProviderBackend spawns natively (see that file's
// own __wasi__-gated section), instantiated directly via WebAssembly.instantiate() and called
// through its exported functions -- there is no process, no Stream, and therefore no async
// boundary left at evaluation time: compiling that module (the only genuinely async step, since
// it needs a real clang fetched from Wasmer's registry) happens entirely ahead of callMain(), in
// webEngineAdapter.mjs's ensureCppProvidersReady(); everything below runs after that, fully
// synchronously.
//
// A JS-side bridge failure (an unknown processKey, an exception constructing/calling the
// instance) is signaled by returning a null pointer / *outResponseLength == 0, deliberately not
// by throwing across the EM_JS boundary (matching wasmDispatchPythonProviderRequest's own
// defensive style, which returns a JSON {ok:false} value rather than relying on a thrown JS
// error surviving the crossing into a C++ exception) -- zero bytes never occurs for a real
// protocol response (every dispatchMessage() response wraps at least a field tag), so it is an
// unambiguous sentinel here.
EM_JS(unsigned char*, wasmDispatchCppProviderRequest,
      (const char* processKey, const unsigned char* requestBytes, int requestLength, int* outResponseLength), {
    const key = UTF8ToString(processKey);
    const request = HEAPU8.slice(requestBytes, requestBytes + requestLength);
    let response;
    try {
        if (typeof Module.dispatchCppProviderBridge !== 'function') {
            throw new Error('This web build has no C++ provider bridge installed.');
        }
        response = Module.dispatchCppProviderBridge(key, request);
    } catch (error) {
        console.error(`Web C++ provider '${key}' bridge failure:`, error);
        response = null;
    }
    if (!response || response.length === 0) {
        HEAP32[outResponseLength >> 2] = 0;
        return 0;
    }
    const buffer = _malloc(response.length);
    HEAPU8.set(response, buffer);
    HEAP32[outResponseLength >> 2] = response.length;
    return buffer;
});

// The one-time counterpart to wasmDispatchCppProviderRequest above: hands the provider's raw C++
// source text to the JS bridge, which compiles (if not already cached for this exact source) and
// instantiates it, then calls its konjugateProviderCreate() export -- see
// engine/src/providerWorker.cpp's __wasi__-gated section and src/webCppProviderBridge.mjs. Also
// signals failure via a null return rather than a thrown JS error, for the same reason as above.
EM_JS(char*, wasmRegisterCppProvider, (const char* processKey, const char* sourceUtf8), {
    const key = UTF8ToString(processKey);
    const source = UTF8ToString(sourceUtf8);
    let errorMessage = null;
    try {
        if (typeof Module.registerCppProviderBridge !== 'function') {
            throw new Error('This web build has no C++ provider bridge installed.');
        }
        Module.registerCppProviderBridge(key, source);
    } catch (error) {
        errorMessage = String(error?.message ?? error);
    }
    if (errorMessage === null) return 0;
    const length = lengthBytesUTF8(errorMessage) + 1;
    const buffer = _malloc(length);
    stringToUTF8(errorMessage, buffer, length);
    return buffer;
});
}

// The web edition's C++-provider transport (docs/proposals/webEdition.md, phase 5): a copy of
// engine/src/providerWorker.cpp -- the SAME glue file PipeProviderBackend spawns natively -- is
// compiled to a WASI-exports build (see that file's own __wasi__-gated section) and instantiated
// directly via WebAssembly.instantiate() instead (see src/webCppProviderBridge.mjs), speaking the
// exact same framed-protobuf wire format ProviderControlChannel builds above; only the transport
// differs (a direct synchronous export call instead of a pipe fd), not the protocol -- so this
// class's message-building intentionally mirrors ProviderControlChannel's/PipeProviderBackend's
// own methods field-for-field.
//
// createProviderBackend only ever routes relationship-shaped (isNodeShaped == false) cppProvider
// tasks here: node-shaped C++ providers have no worker-process protocol support even natively
// (see createProviderBackend's own comment on WasmPyodideProviderBackend above) and fail clearly
// instead, matching that existing native limitation rather than inventing new behavior for the
// web build.
class WasmCppProviderBackend final : public ProviderBackend {
public:
    WasmCppProviderBackend(std::string processKey, const std::string& providerSource)
        : processKey_(std::move(processKey)) {
        // Registers this process's source with the JS bridge (compiles it once, on demand, and
        // instantiates the resulting WASI-exports module -- see
        // src/webCppProviderBridge.mjs) before anything else talks to it.
        char* errorPointer = wasmRegisterCppProvider(processKey_.c_str(), providerSource.c_str());
        if (errorPointer) {
            const std::string message(errorPointer);
            std::free(errorPointer);
            throw std::runtime_error("Failed to prepare web C++ provider '" + processKey_ + "': " + message);
        }

        EngineToProvider handshake;
        auto* h = handshake.mutable_handshake();
        h->set_protocol_version(1);
        h->set_provider_api_version(1);
        const auto resp = dispatch(handshake);
        if (!resp.has_handshake()) {
            throw std::runtime_error("Unexpected response to handshake from web C++ provider '" + processKey_ + "'");
        }
        for (const auto& key : resp.handshake().input_keys()) declaredInputKeys_.emplace_back(key);
    }

    std::vector<std::string> declaredInputKeys() const override { return declaredInputKeys_; }

    void addInstance(std::uint64_t instanceId, const std::vector<CompiledBinding>& bindings) override {
        auto* inst = initializeReq_.add_instances();
        inst->set_instance_id(instanceId);
        for (const auto& binding : bindings) inst->add_input_keys(binding.symbol);
    }

    void sendInitialization() override {
        if (initializeReq_.instances_size() == 0) return;
        EngineToProvider msg;
        *msg.mutable_initialize() = initializeReq_;
        const auto resp = dispatch(msg);
        if (!resp.has_initialize()) {
            throw std::runtime_error("Unexpected response to initialization from web C++ provider '" + processKey_ + "'");
        }
    }

    std::vector<std::pair<std::uint64_t, double>> evaluateBatch(
        std::uint64_t sequence, double simulationTime, double stepSize,
        const std::vector<std::pair<std::uint64_t, std::span<const double>>>& evaluations) override {
        // Mirrors PipeProviderBackend::evaluateBatch's own locking: multiple relationship
        // instances sharing this process may be evaluated from different execution-plan threads
        // in the same synchronization step, and the bridge round trip is not reentrant.
        std::lock_guard<std::mutex> lock(mutex_);
        EngineToProvider msg;
        auto* batch = msg.mutable_evaluate_batch();
        batch->set_sequence(sequence);
        batch->set_simulation_time(simulationTime);
        batch->set_step_size(stepSize);
        for (const auto& [instId, inputs] : evaluations) {
            auto* eval = batch->add_evaluations();
            eval->set_instance_id(instId);
            for (const auto val : inputs) eval->add_inputs(val);
        }
        const auto resp = dispatch(msg);
        if (!resp.has_evaluate_batch()) {
            throw std::runtime_error("Unexpected response to evaluateBatch from web C++ provider '" + processKey_ + "'");
        }
        std::vector<std::pair<std::uint64_t, double>> results;
        for (const auto& contrib : resp.evaluate_batch().contributions()) {
            results.emplace_back(contrib.instance_id(), contrib.value());
        }
        return results;
    }

    void shutdown() noexcept override {
        try {
            std::lock_guard<std::mutex> lock(mutex_);
            EngineToProvider msg;
            msg.mutable_shutdown();
            dispatch(msg);
        } catch (const std::exception& error) {
            std::cerr << "Failed to shut down web C++ provider '" << processKey_ << "': " << error.what() << '\n';
        }
    }

private:
    ProviderToEngine dispatch(const EngineToProvider& request) {
        std::string payload;
        if (!request.SerializeToString(&payload)) {
            throw std::runtime_error("Failed to serialize a message for web C++ provider '" + processKey_ + "'");
        }
        int responseLength = 0;
        unsigned char* responsePointer = wasmDispatchCppProviderRequest(
            processKey_.c_str(), reinterpret_cast<const unsigned char*>(payload.data()),
            static_cast<int>(payload.size()), &responseLength);
        if (!responsePointer || responseLength == 0) {
            throw std::runtime_error("The web C++ provider bridge failed for '" + processKey_ + "' (see the browser console).");
        }
        ProviderToEngine response;
        const bool parsed = response.ParseFromArray(responsePointer, responseLength);
        std::free(responsePointer);
        if (!parsed) {
            throw std::runtime_error("Failed to parse a response from web C++ provider '" + processKey_ + "'");
        }
        if (response.has_failure()) {
            throw std::runtime_error("Web C++ provider '" + processKey_ + "' failed: " + std::string(response.failure().message()));
        }
        return response;
    }

    std::string processKey_;
    InitializeRequest initializeReq_;
    std::mutex mutex_;
    std::vector<std::string> declaredInputKeys_;
};
#endif

// ── Version 2 programs (konjugate/sdk/v2, konjugate.v2; docs/proposals/programSdkV2.md) ─────────────────────────────────────────────
//
// One backend per program source, whichever transport serves it: the program's description (read once), and per instance its port
// mapping (each binding to its port, each optional port's default), the unit conversion at each port, its memory (the engine's copy,
// always exact: a transport out of process returns it after every advance), its clock and whether advance() has run. Errors are named
// here, where the program, what it belongs to, its ports and the inputs are all known.

struct ProgramPortDescription {
    std::string key;
    std::string kind;
    std::string unit;
    bool hasDefault = false;
    double defaultValue = 0;
    std::size_t line = 0;   // the declaration's line in the source, when the SDK says (0: not said)
};

struct ProgramOutputDescription {
    std::string key;
    std::string unit;
    bool declaresDependencies = false;
    std::vector<std::string> dependsOn;
    std::size_t line = 0;
};

struct ProgramFieldDescription {
    std::string name;
    std::string type;
    std::size_t count = 1;
    std::size_t offset = 0;
    std::string unit;
    std::size_t line = 0;
};

struct ProgramDescription {
    std::string name;
    bool node = false;
    std::vector<ProgramPortDescription> inputs;
    std::vector<ProgramOutputDescription> outputs;
    std::vector<ProgramFieldDescription> memory;
    std::size_t memorySize = 0;
    double clockPeriod = 0;
    std::string clockConstant;
    std::size_t clockLine = 0;
};

ProgramDescription parseProgramDescription(const std::string& json) {
    boost::property_tree::ptree tree;
    std::istringstream stream(json);
    try {
        boost::property_tree::read_json(stream, tree);
    } catch (const std::exception& error) {
        throw std::runtime_error(std::string("A program's description could not be read: ") + error.what());
    }
    ProgramDescription description;
    description.name = tree.get<std::string>("name", "the program");
    description.node = tree.get<std::string>("kind", "relationship") == "node";
    if (const auto inputs = tree.get_child_optional("inputs")) for (const auto& [unused, item] : *inputs) {
        static_cast<void>(unused);
        ProgramPortDescription port;
        port.key = item.get<std::string>("key", "");
        port.kind = item.get<std::string>("kind", "input");
        port.unit = item.get<std::string>("unit", "");
        if (const auto fallback = item.get_optional<double>("default")) {
            port.hasDefault = true;
            port.defaultValue = *fallback;
        }
        port.line = item.get<std::size_t>("line", 0);
        description.inputs.push_back(std::move(port));
    }
    if (const auto outputs = tree.get_child_optional("outputs")) for (const auto& [unused, item] : *outputs) {
        static_cast<void>(unused);
        ProgramOutputDescription port;
        port.key = item.get<std::string>("key", "");
        port.unit = item.get<std::string>("unit", "");
        if (const auto depends = item.get_child_optional("dependsOn")) {
            port.declaresDependencies = true;
            for (const auto& entry : *depends) port.dependsOn.push_back(entry.second.get_value<std::string>());
        }
        port.line = item.get<std::size_t>("line", 0);
        description.outputs.push_back(std::move(port));
    }
    if (const auto memory = tree.get_child_optional("memory")) for (const auto& [unused, item] : *memory) {
        static_cast<void>(unused);
        ProgramFieldDescription field;
        field.name = item.get<std::string>("name", "");
        field.type = item.get<std::string>("type", "real");
        field.count = item.get<std::size_t>("count", 1);
        field.offset = item.get<std::size_t>("offset", 0);
        field.unit = item.get<std::string>("unit", "");
        field.line = item.get<std::size_t>("line", 0);
        description.memory.push_back(std::move(field));
    }
    description.memorySize = tree.get<std::size_t>("memorySize", 0);
    description.clockPeriod = tree.get<double>("clockPeriod", 0);
    description.clockConstant = tree.get<std::string>("clockConstant", "");
    description.clockLine = tree.get<std::size_t>("clockLine", 0);
    return description;
}

std::uint8_t memoryTypeCode(const std::string& type) {
    if (type == "integer") return 1;
    if (type == "flag") return 2;
    if (type == "reals") return 3;
    if (type == "random") return 4;
    return 0;
}

std::size_t memorySlots(const ProgramFieldDescription& field) {
    return field.type == "random" ? 2 : field.type == "reals" ? field.count : 1;
}

// A hash of the fields' names, types and sizes: a checkpoint's memory whose layout matches is restored in one comparison.
std::uint64_t memoryLayoutHash(const std::vector<ProgramFieldDescription>& fields) {
    std::uint64_t hash = 0xCBF29CE484222325ULL;
    const auto mix = [&](const std::string& text) {
        for (const char character : text) {
            hash ^= static_cast<std::uint8_t>(character);
            hash *= 0x100000001B3ULL;
        }
    };
    for (const auto& field : fields) mix(field.name + ":" + field.type + ":" + std::to_string(field.count) + ";");
    return hash;
}

struct ProgramReply {
    std::int32_t status = 0; // 0 done, 1 failed, 2 out of domain, 3 not provided
    std::string message;
    std::uint32_t line = 0;
    std::vector<double> values;
    double clockPeriod = 0;
    // A worker's copy of the instance's memory after the call, when it sends one.
    std::string memory;
};

struct ProgramInvocation {
    std::uint64_t instanceId = 0;
    const double* values = nullptr;
    std::byte* memory = nullptr;
    bool first = false;
};

struct ProgramStart {
    std::uint64_t instanceId = 0;
    std::string owner;
    double startTime = 0;
    std::vector<double> values;
    std::vector<unsigned char> bound;
    EntityId ownerId = 0;
    std::uint64_t seed = 0;
    std::byte* memory = nullptr;
};

// How a program is reached: in-process through the version 2 ABI, or a worker over the pipe. Memory pointers are the engine's own
// buffers; a transport out of process copies the memory its worker returns into them.
class ProgramTransport {
public:
    virtual ~ProgramTransport() = default;
    virtual const std::string& description() const = 0;
    virtual std::vector<ProgramReply> start(const std::vector<ProgramStart>& instances) = 0;
    virtual std::vector<ProgramReply> evaluate(double time, const std::vector<ProgramInvocation>& calls, std::size_t outputCount) = 0;
    virtual std::vector<ProgramReply> advance(double time, double size, const std::vector<ProgramInvocation>& calls) = 0;
    virtual std::vector<ProgramReply> jacobian(double time, const std::vector<ProgramInvocation>& calls, std::size_t entryCount) = 0;
    virtual void setMemory(const std::vector<ProgramInvocation>& calls, std::size_t memorySize) = 0;
    virtual void shutdown() noexcept = 0;
    // The program's number of inputs and its memory's size, once its description is read.
    virtual void configure(std::size_t inputCount, std::size_t memorySize) = 0;
};

class InProcessProgramTransport final : public ProgramTransport {
public:
    InProcessProgramTransport(std::string processKey, const std::string& libraryPath) : processKey_(std::move(processKey)) {
#ifdef _WIN32
        handle_ = ::LoadLibraryA(libraryPath.c_str());
        if (!handle_) throw std::runtime_error("The program's library could not be loaded from '" + libraryPath + "'.");
        auto entryPoint = reinterpret_cast<KonjugateInProcessProgramV2Fn>(::GetProcAddress(handle_, kKonjugateInProcessProgramEntryPoint));
#else
        handle_ = ::dlopen(libraryPath.c_str(), RTLD_LOCAL | RTLD_NOW);
        if (!handle_) throw std::runtime_error("The program's library could not be loaded: " + std::string(::dlerror()));
        auto entryPoint = reinterpret_cast<KonjugateInProcessProgramV2Fn>(::dlsym(handle_, kKonjugateInProcessProgramEntryPoint));
#endif
        if (!entryPoint || !(table_ = entryPoint())) {
            unloadLibrary();
            throw std::runtime_error("The program's library has no version 2 entry point.");
        }
        if (table_->size < sizeof(KonjugateInProcessProgramV2) || table_->abiVersion != kKonjugateInProcessProgramAbiVersion) {
            unloadLibrary();
            throw std::runtime_error("The program was built for another version of Konjugate's program ABI; build it again.");
        }
        self_ = table_->create();
        if (!self_) {
            const std::string message = table_->lastError(nullptr);
            unloadLibrary();
            throw std::runtime_error(message);
        }
        description_ = table_->description(self_);
    }

    ~InProcessProgramTransport() override { shutdown(); }

    const std::string& description() const override { return description_; }

    std::vector<ProgramReply> start(const std::vector<ProgramStart>& instances) override {
        std::vector<ProgramReply> outcomes;
        for (const auto& instance : instances) {
            ProgramReply outcome;
            outcome.status = table_->createInstance(self_, instance.instanceId, instance.owner.c_str(), instance.startTime, instance.values.data(),
                instance.bound.data(), static_cast<std::uint32_t>(instance.values.size()), instance.ownerId, instance.seed,
                reinterpret_cast<std::uint8_t*>(instance.memory), &outcome.clockPeriod);
            if (outcome.status) fillError(outcome);
            outcomes.push_back(std::move(outcome));
        }
        return outcomes;
    }

    std::vector<ProgramReply> evaluate(double time, const std::vector<ProgramInvocation>& calls, std::size_t outputCount) override {
        std::vector<ProgramReply> outcomes(calls.size());
        for (std::size_t index = 0; index < calls.size(); ++index) {
            auto& outcome = outcomes[index];
            outcome.values.assign(outputCount, unsetOutput());
            outcome.status = table_->evaluate(self_, calls[index].instanceId, time, calls[index].values, inputCount_,
                reinterpret_cast<const std::uint8_t*>(calls[index].memory), outcome.values.data(), static_cast<std::uint32_t>(outputCount));
            if (outcome.status) fillError(outcome);
        }
        return outcomes;
    }

    std::vector<ProgramReply> advance(double time, double size, const std::vector<ProgramInvocation>& calls) override {
        std::vector<ProgramReply> outcomes(calls.size());
        for (std::size_t index = 0; index < calls.size(); ++index) {
            outcomes[index].status = table_->advance(self_, calls[index].instanceId, time, size, calls[index].first ? 1 : 0, calls[index].values,
                inputCount_, reinterpret_cast<std::uint8_t*>(calls[index].memory));
            if (outcomes[index].status) fillError(outcomes[index]);
        }
        return outcomes;
    }

    std::vector<ProgramReply> jacobian(double time, const std::vector<ProgramInvocation>& calls, std::size_t entryCount) override {
        std::vector<ProgramReply> outcomes(calls.size());
        for (std::size_t index = 0; index < calls.size(); ++index) {
            auto& outcome = outcomes[index];
            outcome.values.assign(entryCount, 0.0);
            outcome.status = table_->jacobian(self_, calls[index].instanceId, time, calls[index].values, inputCount_,
                reinterpret_cast<const std::uint8_t*>(calls[index].memory), outcome.values.data(), static_cast<std::uint32_t>(entryCount));
            if (outcome.status == 1 || outcome.status == 2) fillError(outcome);
        }
        return outcomes;
    }

    // The engine's buffer is the program's memory: nothing to send.
    void setMemory(const std::vector<ProgramInvocation>&, std::size_t) override {}

    void shutdown() noexcept override {
        if (self_ && table_) {
            table_->shutdownProgram(self_);
            table_->destroy(self_);
            self_ = nullptr;
        }
        unloadLibrary();
    }

    void configure(std::size_t inputCount, std::size_t) override { inputCount_ = static_cast<std::uint32_t>(inputCount); }

    // What an output holds before evaluate() runs: a NaN no arithmetic makes, so one left unwritten is told from one set to NaN.
    static double unsetOutput() { return std::bit_cast<double>(std::uint64_t{0x7FF4B1D0DEADBEEFULL}); }

private:
    void fillError(ProgramReply& outcome) const {
        outcome.message = table_->lastError(self_);
        outcome.line = table_->lastErrorLine(self_);
    }

    void unloadLibrary() noexcept {
#ifdef _WIN32
        if (handle_) { ::FreeLibrary(handle_); handle_ = nullptr; }
#else
        if (handle_) { ::dlclose(handle_); handle_ = nullptr; }
#endif
        table_ = nullptr;
    }

    std::string processKey_;
    const KonjugateInProcessProgramV2* table_ = nullptr;
    void* self_ = nullptr;
    std::string description_;
    std::uint32_t inputCount_ = 0;
#ifdef _WIN32
    HMODULE handle_ = nullptr;
#else
    void* handle_ = nullptr;
#endif
};

class PipeProgramTransport final : public ProgramTransport {
public:
    PipeProgramTransport(std::string processKey, ContributionImplementation implementation, std::string sourcePath, const ProviderConfiguration& config)
        : channel_(std::move(processKey), implementation, std::move(sourcePath), config, {}, 2) {
        if (channel_.programDescription().empty()) {
            throw std::runtime_error("The program's worker did not describe a version 2 program: it may be an older Konjugate's SDK.");
        }
    }

    const std::string& description() const override { return channel_.programDescription(); }

    std::vector<ProgramReply> start(const std::vector<ProgramStart>& instances) override {
        EngineToProvider message;
        auto* request = message.mutable_program_initialize();
        for (const auto& instance : instances) {
            auto* item = request->add_instances();
            item->set_instance_id(instance.instanceId);
            item->set_owner(instance.owner);
            item->set_start_time(instance.startTime);
            for (const auto value : instance.values) item->add_values(value);
            item->set_bound(std::string(instance.bound.begin(), instance.bound.end()));
            item->set_owner_id(instance.ownerId);
            item->set_program_seed(instance.seed);
        }
        auto outcomes = roundTrip(message, "starting the program", instances.size());
        for (std::size_t index = 0; index < instances.size(); ++index) copyMemory(outcomes[index], instances[index].memory);
        return finish(std::move(outcomes));
    }

    std::vector<ProgramReply> evaluate(double time, const std::vector<ProgramInvocation>& calls, std::size_t) override {
        EngineToProvider message;
        auto* request = message.mutable_program_evaluate();
        request->set_time(time);
        for (const auto& call : calls) addCall(request->add_calls(), call);
        return finish(roundTrip(message, "evaluate()", calls.size()));
    }

    std::vector<ProgramReply> advance(double time, double size, const std::vector<ProgramInvocation>& calls) override {
        EngineToProvider message;
        auto* request = message.mutable_program_advance();
        request->set_time(time);
        request->set_size(size);
        for (const auto& call : calls) addCall(request->add_calls(), call);
        auto outcomes = roundTrip(message, "advance()", calls.size());
        for (std::size_t index = 0; index < calls.size(); ++index) if (!outcomes[index].status) copyMemory(outcomes[index], calls[index].memory);
        return finish(std::move(outcomes));
    }

    std::vector<ProgramReply> jacobian(double time, const std::vector<ProgramInvocation>& calls, std::size_t) override {
        EngineToProvider message;
        auto* request = message.mutable_program_jacobian();
        request->set_time(time);
        for (const auto& call : calls) addCall(request->add_calls(), call);
        return finish(roundTrip(message, "jacobian()", calls.size()));
    }

    void setMemory(const std::vector<ProgramInvocation>& calls, std::size_t memorySize) override {
        if (!memorySize || calls.empty()) return;
        EngineToProvider message;
        auto* request = message.mutable_program_set_memory();
        for (const auto& call : calls) {
            auto* item = request->add_memories();
            item->set_instance_id(call.instanceId);
            item->set_memory(std::string(reinterpret_cast<const char*>(call.memory), memorySize));
        }
        const auto response = channel_.request(message, "restoring the program's memory");
        if (response.has_failure()) throw std::runtime_error(std::string(response.failure().message()));
    }

    void shutdown() noexcept override { channel_.close(); }

    void configure(std::size_t inputCount, std::size_t memorySize) override {
        inputCount_ = inputCount;
        memorySize_ = memorySize;
    }

private:
    void addCall(provider::protocol::ProgramCall* item, const ProgramInvocation& call) const {
        item->set_instance_id(call.instanceId);
        for (std::size_t index = 0; index < inputCount_; ++index) item->add_values(call.values[index]);
        if (call.first) item->set_first(true);
    }

    std::vector<ProgramReply> roundTrip(const EngineToProvider& message, const char* during, std::size_t expected) {
        const auto response = channel_.request(message, during);
        if (response.has_failure()) throw std::runtime_error(std::string(response.failure().message()));
        if (!response.has_program() || static_cast<std::size_t>(response.program().outcomes_size()) != expected) {
            throw std::runtime_error(std::string("The program's worker answered ") + during + " with something else.");
        }
        std::vector<ProgramReply> outcomes;
        for (const auto& item : response.program().outcomes()) {
            ProgramReply outcome;
            outcome.status = static_cast<std::int32_t>(item.status());
            outcome.message = std::string(item.message());
            outcome.line = item.line();
            outcome.values.assign(item.values().begin(), item.values().end());
            outcome.clockPeriod = item.clock_period();
            outcome.memory = std::string(item.memory());
            outcomes.push_back(std::move(outcome));
        }
        return outcomes;
    }

    void copyMemory(const ProgramReply& outcome, std::byte* memory) const {
        if (outcome.status || !memory || !memorySize_) return;
        if (outcome.memory.size() != memorySize_) throw std::runtime_error("The program's worker returned memory of the wrong size.");
        std::memcpy(memory, outcome.memory.data(), memorySize_);
    }

    static std::vector<ProgramReply> finish(std::vector<ProgramReply> outcomes) { return outcomes; }

    ProviderControlChannel channel_;
    std::size_t inputCount_ = 0;
    std::size_t memorySize_ = 0;
};

struct ProgramOutputSpec {
    std::string key;     // the output's key as the file binds it (a relationship's one output whatever its key)
    std::string unit;    // the state's unit
    bool rate = true;    // into a Rate state (a rate), or an Update (a value)
    std::string label;   // the state, in words
};

struct ProgramInstanceSpec {
    std::uint64_t instanceId = 0;
    EntityId ownerId = 0;
    std::uint8_t ownerKind = 0;
    std::string owner;
    std::uint64_t seed = 0;
    std::vector<CompiledBinding> bindings;
    std::vector<double> startValues;     // in binding order
    std::vector<ProgramOutputSpec> outputs;
};

std::string formatNumber(double value) {
    std::ostringstream stream;
    stream.precision(10);
    stream << value;
    return stream.str();
}

class ProgramBackend final : public ProviderBackend {
public:
    ProgramBackend(std::string processKey, std::unique_ptr<ProgramTransport> transport)
        : processKey_(std::move(processKey)), transport_(std::move(transport)), description_(parseProgramDescription(transport_->description())) {
        transport_->configure(description_.inputs.size(), description_.memorySize);
        if (description_.outputs.empty()) throw std::runtime_error("The program " + description_.name + " declares no output.");
    }

    ~ProgramBackend() override { shutdown(); }

    const ProgramDescription& description() const noexcept { return description_; }

    void addInstance(std::uint64_t, const std::vector<CompiledBinding>&) override {
        throw std::runtime_error("A version 2 program is started with its description, not as a version 1 provider.");
    }

    // Checks the instance's bindings against the program's ports, by name and unit, before anything runs.
    void addProgramInstance(ProgramInstanceSpec spec) {
        const auto& name = description_.name;
        Instance instance;
        instance.portOfBinding.assign(spec.bindings.size(), 0);
        instance.scale.assign(description_.inputs.size(), 1.0);
        instance.offset.assign(description_.inputs.size(), 0.0);
        instance.identity.assign(description_.inputs.size(), 1);
        instance.bound.assign(description_.inputs.size(), 0);
        instance.defaults.assign(description_.inputs.size(), 0.0);
        instance.portLabels.assign(description_.inputs.size(), "");
        std::string known;
        for (const auto& port : description_.inputs) known += (known.empty() ? "" : ", ") + port.key;
        for (std::size_t index = 0; index < spec.bindings.size(); ++index) {
            const auto& binding = spec.bindings[index];
            const auto found = std::find_if(description_.inputs.begin(), description_.inputs.end(), [&](const auto& port) { return port.key == binding.symbol; });
            if (found == description_.inputs.end()) {
                throw std::runtime_error("The program " + name + " on " + spec.owner + " has no input ‘" + binding.symbol + "’ (its inputs: " +
                    (known.empty() ? std::string("none") : known) + "). Bind one of those on the Program tab, or declare ‘" + binding.symbol + "’ in the code.");
            }
            const auto port = static_cast<std::size_t>(found - description_.inputs.begin());
            if (instance.bound[port]) throw std::runtime_error("Input ‘" + found->key + "’ of " + name + " on " + spec.owner + " is bound twice.");
            instance.bound[port] = 1;
            instance.portOfBinding[index] = port;
            instance.portLabels[port] = binding.label;
            // The bound value's unit to the port's: converted at the port, refused by name when it cannot be.
            if (!found->unit.empty() && !binding.unit.empty()) {
                const auto conversion = unitConversion(binding.unit, found->unit, false);
                if (!conversion.error.empty()) {
                    throw std::runtime_error("Input ‘" + found->key + "’ of the program " + name + " on " + spec.owner + " is in " + found->unit +
                        " but is bound to " + (binding.label.empty() ? std::string("a value") : binding.label) + ", in " + binding.unit + ".");
                }
                instance.scale[port] = conversion.scale;
                instance.offset[port] = conversion.offset;
                instance.identity[port] = conversion.identity ? 1 : 0;
                if (!conversion.identity) instance.conversions.push_back("‘" + found->key + "’ is converted from " + binding.unit + " to " + found->unit);
            }
        }
        for (std::size_t port = 0; port < description_.inputs.size(); ++port) {
            const auto& declared = description_.inputs[port];
            if (instance.bound[port]) continue;
            if (!declared.hasDefault) {
                throw std::runtime_error("Input ‘" + declared.key + "’ of " + name + " on " + spec.owner + " is not bound to anything and has no default. "
                    "Bind it on the Program tab, or give it a default in the code.");
            }
            instance.defaults[port] = declared.defaultValue;
        }
        // Outputs: a relationship's one output reaches its state; a node program's are matched by key.
        for (const auto& output : spec.outputs) {
            std::size_t index = 0;
            if (description_.node) {
                const auto found = std::find_if(description_.outputs.begin(), description_.outputs.end(), [&](const auto& port) { return port.key == output.key; });
                if (found == description_.outputs.end()) {
                    std::string outputs;
                    for (const auto& port : description_.outputs) outputs += (outputs.empty() ? "" : ", ") + port.key;
                    throw std::runtime_error("The program " + name + " on " + spec.owner + " has no output ‘" + output.key + "’ (its outputs: " + outputs + ").");
                }
                index = static_cast<std::size_t>(found - description_.outputs.begin());
            }
            OutputMap map;
            map.index = index;
            map.key = output.key;
            const auto& declared = description_.outputs[index];
            if (!declared.unit.empty() && !output.unit.empty()) {
                const auto expected = output.rate ? perSecond(output.unit) : output.unit;
                const auto conversion = unitConversion(declared.unit, expected, output.rate);
                if (!conversion.error.empty()) {
                    throw std::runtime_error("Output ‘" + declared.key + "’ of the program " + name + " on " + spec.owner + " is in " + declared.unit + ", but " +
                        (output.label.empty() ? std::string("its state") : output.label) + " is " + (output.rate ? "a Rate state in " + output.unit +
                        ", which takes " + perSecond(output.unit) + "." : "an Update state in " + output.unit + "."));
                }
                map.scale = conversion.scale;
                map.offset = conversion.offset;
                map.identity = conversion.identity;
            }
            instance.outputs.push_back(std::move(map));
        }
        if (instance.outputs.empty() && !description_.node) instance.outputs.push_back(OutputMap{});
        instance.memory.assign(std::max<std::size_t>(description_.memorySize, 8), std::byte{0});
        instance.ownerId = spec.ownerId;
        instance.ownerKind = spec.ownerKind;
        instance.owner = std::move(spec.owner);
        instance.seed = spec.seed;
        instance.startValues = std::move(spec.startValues);
        instance.values.assign(description_.inputs.size(), 0.0);
        instances_.emplace(spec.instanceId, std::move(instance));
        order_.push_back(spec.instanceId);
    }

    void sendInitialization() override {
        std::vector<ProgramStart> starts;
        for (const auto instanceId : order_) {
            auto& instance = instances_.at(instanceId);
            if (instance.started) continue;
            ProgramStart start;
            start.instanceId = instanceId;
            start.owner = instance.owner;
            start.values = portValues(instance, instance.startValues.data());
            start.bound = instance.bound;
            start.ownerId = instance.ownerId;
            start.seed = instance.seed;
            start.memory = instance.memory.data();
            starts.push_back(std::move(start));
        }
        if (starts.empty()) return;
        const auto outcomes = transport_->start(starts);
        for (std::size_t index = 0; index < starts.size(); ++index) {
            auto& instance = instances_.at(starts[index].instanceId);
            const auto& outcome = outcomes.at(index);
            if (outcome.status) {
                throw std::runtime_error(description_.name + " on " + instance.owner + " failed in initialize(): " + outcome.message + lineText(outcome.line));
            }
            instance.clockPeriod = outcome.clockPeriod;
            if (!(instance.clockPeriod >= 0) || !std::isfinite(instance.clockPeriod)) {
                throw std::runtime_error("The clock of " + description_.name + " on " + instance.owner + " has a period of " + formatNumber(instance.clockPeriod) +
                    " s; it must be a positive whole number of the run's time steps.");
            }
            instance.started = true;
        }
    }

    std::vector<std::pair<std::uint64_t, double>> evaluateBatch(
        std::uint64_t, double simulationTime, double,
        const std::vector<std::pair<std::uint64_t, std::span<const double>>>& evaluations) override {
        if (description_.node) throw std::runtime_error("The node program " + description_.name + " cannot be evaluated as a relationship's term.");
        const auto outputs = evaluate(simulationTime, evaluations);
        std::vector<std::pair<std::uint64_t, double>> results;
        results.reserve(outputs.size());
        for (std::size_t index = 0; index < outputs.size(); ++index) results.emplace_back(evaluations[index].first, outputs[index].front());
        return results;
    }

    // Each evaluation's output named by `keys` (a relationship's one output whatever its key; one of several by key).
    std::vector<double> evaluateKeyed(double simulationTime, const std::vector<std::pair<std::uint64_t, std::span<const double>>>& evaluations,
                                      const std::vector<const std::string*>& keys) {
        const auto outputs = evaluate(simulationTime, evaluations);
        std::vector<double> results;
        results.reserve(outputs.size());
        for (std::size_t index = 0; index < outputs.size(); ++index) {
            const auto& maps = instances_.at(evaluations[index].first).outputs;
            std::size_t at = 0;
            if (maps.size() > 1) {
                const auto found = std::find_if(maps.begin(), maps.end(), [&](const auto& map) { return map.key == *keys[index]; });
                if (found == maps.end()) throw std::runtime_error("The program " + description_.name + " has no output ‘" + *keys[index] + "’.");
                at = static_cast<std::size_t>(found - maps.begin());
            }
            results.push_back(outputs[index].at(at));
        }
        return results;
    }

    std::vector<std::pair<std::string, double>> evaluateNode(std::uint64_t instanceId, double simulationTime, double, std::span<const double> inputs) override {
        const std::vector<std::pair<std::uint64_t, std::span<const double>>> evaluations{{instanceId, inputs}};
        const auto outputs = evaluate(simulationTime, evaluations).front();
        const auto& instance = instances_.at(instanceId);
        std::vector<std::pair<std::string, double>> results;
        results.reserve(instance.outputs.size());
        for (std::size_t index = 0; index < instance.outputs.size(); ++index) results.emplace_back(instance.outputs[index].key, outputs[index]);
        return results;
    }

    // Whether the program gives its own Jacobian (docs/proposals/programSdkV2.md, Jacobians for Rodas4): asked once, of the first
    // instance at its starting inputs; a program that fails there is taken to give one, and says so when it is asked in earnest.
    bool givesJacobian() {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!givesJacobian_) {
            bool gives = false;
            if (!instances_.empty() && !description_.node) {
                auto& [instanceId, instance] = *instances_.begin();
                auto values = portValues(instance, instance.startValues.data());
                const auto outcomes = transport_->jacobian(0.0, {{instanceId, values.data(), instance.memory.data(), false}},
                    description_.inputs.size() * description_.outputs.size());
                gives = outcomes.at(0).status != 3;
            }
            givesJacobian_ = gives;
        }
        return *givesJacobian_;
    }

    // The derivative of output `key` (a relationship's one output whatever its key) by each binding, at these inputs (binding order): the
    // program's jacobian() taken through the conversions at its ports, in its state's unit by the binding's. Nothing when it gives none.
    std::optional<std::vector<double>> jacobianByBinding(std::uint64_t instanceId, const std::string& key, double time, std::span<const double> inputs) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto& instance = instances_.at(instanceId);
        std::size_t at = 0;
        if (instance.outputs.size() > 1) {
            const auto output = std::find_if(instance.outputs.begin(), instance.outputs.end(), [&](const auto& map) { return map.key == key; });
            if (output == instance.outputs.end()) return std::nullopt;
            at = static_cast<std::size_t>(output - instance.outputs.begin());
        }
        const auto inputCount = description_.inputs.size();
        instance.values = portValues(instance, inputs.data());
        const auto outcomes = transport_->jacobian(time, {{instanceId, instance.values.data(), instance.memory.data(), false}},
            inputCount * description_.outputs.size());
        const auto& outcome = outcomes.at(0);
        if (outcome.status == 3) return std::nullopt;
        if (outcome.status) {
            throw std::runtime_error(description_.name + " on " + instance.owner + " failed in jacobian() at t = " + formatNumber(time) + " s" +
                stageText() + ": " + outcome.message + lineText(outcome.line) + inputsText(instance, instance.values));
        }
        const auto& map = instance.outputs[at];
        const double outputScale = map.identity ? 1.0 : map.scale;
        std::vector<double> derivatives(instance.portOfBinding.size(), 0.0);
        for (std::size_t binding = 0; binding < instance.portOfBinding.size(); ++binding) {
            const auto port = instance.portOfBinding[binding];
            const double entry = outcome.values.at(map.index * inputCount + port);
            if (!std::isfinite(entry)) {
                throw ProgramOutOfDomain(description_.name + " on " + instance.owner + " gave " + formatNumber(entry) + " in its Jacobian for ‘" +
                    description_.outputs[map.index].key + "’ by ‘" + description_.inputs[port].key + "’ at t = " + formatNumber(time) + " s" + stageText() + ".");
            }
            derivatives[binding] = outputScale * entry * (instance.identity[port] ? 1.0 : instance.scale[port]);
        }
        return derivatives;
    }

    bool advancesEachStep(std::uint64_t instanceId) const {
        const auto& instance = instances_.at(instanceId);
        return description_.memorySize > 0 && instance.clockPeriod == 0;
    }

    double clockPeriod(std::uint64_t instanceId) const { return instances_.at(instanceId).clockPeriod; }

    // advance() for a batch of this program's instances, each with its inputs in binding order.
    void advance(const std::vector<std::pair<std::uint64_t, std::span<const double>>>& calls, double time, double size) {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<ProgramInvocation> programCalls;
        programCalls.reserve(calls.size());
        for (const auto& [instanceId, inputs] : calls) {
            auto& instance = instances_.at(instanceId);
            instance.values = portValues(instance, inputs.data());
            programCalls.push_back({instanceId, instance.values.data(), instance.memory.data(), !instance.advanced});
        }
        const auto outcomes = transport_->advance(time, size, programCalls);
        for (std::size_t index = 0; index < calls.size(); ++index) {
            auto& instance = instances_.at(calls[index].first);
            const auto& outcome = outcomes.at(index);
            if (outcome.status) {
                throw std::runtime_error(description_.name + " on " + instance.owner + " failed in advance() at t = " + formatNumber(time) + " s: " +
                    outcome.message + lineText(outcome.line) + inputsText(instance, instance.values));
            }
            instance.advanced = true;
        }
    }

    ProgramMemoryState memoryState(std::uint64_t instanceId) const {
        const auto& instance = instances_.at(instanceId);
        ProgramMemoryState state;
        state.owner = instance.ownerId;
        state.ownerKind = instance.ownerKind;
        state.layout = memoryLayoutHash(description_.memory);
        for (const auto& field : description_.memory) {
            ProgramMemoryField item;
            item.name = field.name;
            item.type = memoryTypeCode(field.type);
            item.words.resize(memorySlots(field));
            std::memcpy(item.words.data(), instance.memory.data() + field.offset, item.words.size() * 8);
            if (item.type == 2) item.words[0] = (item.words[0] & 0xFF) ? 1 : 0;
            state.fields.push_back(std::move(item));
        }
        return state;
    }

    // The program's Jacobian at these inputs (binding order), outputs x inputs row by output; nothing when the program gives none.
    std::optional<std::vector<double>> jacobian(std::uint64_t instanceId, double time, std::span<const double> inputs) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto& instance = instances_.at(instanceId);
        instance.values = portValues(instance, inputs.data());
        const auto outcomes = transport_->jacobian(time, {{instanceId, instance.values.data(), instance.memory.data(), false}},
            description_.inputs.size() * description_.outputs.size());
        const auto& outcome = outcomes.at(0);
        if (outcome.status == 3) return std::nullopt;
        if (outcome.status) throw std::runtime_error(description_.name + " failed in jacobian(): " + outcome.message + lineText(outcome.line));
        return outcome.values;
    }

    bool hasMemory() const noexcept { return description_.memorySize > 0; }
    const std::string& owner(std::uint64_t instanceId) const { return instances_.at(instanceId).owner; }

    // Memory from a checkpoint, field by field by name: a field kept with the same type and size is restored; a field new since starts from
    // its declared value, and one dropped is left out, each said in `notes`; one whose type or size changed stops the continuation.
    void restoreMemory(std::uint64_t instanceId, const ProgramMemoryState& saved, std::vector<std::string>* notes) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto& instance = instances_.at(instanceId);
        const auto who = description_.name + " on " + instance.owner;
        for (const auto& field : description_.memory) {
            const auto found = std::find_if(saved.fields.begin(), saved.fields.end(), [&](const auto& item) { return item.name == field.name; });
            if (found == saved.fields.end()) {
                if (notes) notes->push_back("Memory ‘" + field.name + "’ of " + who + " is new since this checkpoint and starts from its declared value.");
                continue;
            }
            if (found->type != memoryTypeCode(field.type) || found->words.size() != memorySlots(field)) {
                throw std::runtime_error("Memory ‘" + field.name + "’ of " + who + " has changed its type or size since this checkpoint, so no value of it "
                    "is right: run from the start instead.");
            }
            std::memcpy(instance.memory.data() + field.offset, found->words.data(), found->words.size() * 8);
        }
        for (const auto& item : saved.fields) {
            const bool kept = std::any_of(description_.memory.begin(), description_.memory.end(), [&](const auto& field) { return field.name == item.name; });
            if (!kept && notes) notes->push_back("Memory ‘" + item.name + "’ of " + who + " is no longer in the program and is left out.");
        }
        instance.advanced = true;
        transport_->setMemory({{instanceId, nullptr, instance.memory.data(), false}}, description_.memorySize);
    }

    void shutdown() noexcept override {
        std::lock_guard<std::mutex> lock(mutex_);
        if (transport_) transport_->shutdown();
    }

private:
    struct OutputMap {
        std::size_t index = 0;
        std::string key;
        double scale = 1;
        double offset = 0;
        bool identity = true;
    };

    struct Instance {
        EntityId ownerId = 0;
        std::uint8_t ownerKind = 0;
        std::string owner;
        std::uint64_t seed = 0;
        std::vector<std::size_t> portOfBinding;
        std::vector<double> scale;
        std::vector<double> offset;
        std::vector<unsigned char> identity;
        std::vector<unsigned char> bound;
        std::vector<double> defaults;
        std::vector<std::string> portLabels;
        std::vector<std::string> conversions;
        std::vector<OutputMap> outputs;
        std::vector<double> startValues;
        std::vector<double> values;
        std::vector<std::byte> memory;
        double clockPeriod = 0;
        bool started = false;
        bool advanced = false;
        bool checked = false;
    };


    // The program's inputs in its declaration order from the bound values in binding order: converted at the port, defaults filled in.
    std::vector<double> portValues(const Instance& instance, const double* bindingValues) const {
        std::vector<double> values(instance.defaults);
        for (std::size_t index = 0; index < instance.portOfBinding.size(); ++index) {
            const auto port = instance.portOfBinding[index];
            const double value = bindingValues[index];
            values[port] = instance.identity[port] ? value : value * instance.scale[port] + instance.offset[port];
        }
        return values;
    }

    static std::string lineText(std::uint32_t line) { return line ? " (line " + std::to_string(line) + ")" : std::string(); }

    static std::string stageText() {
        const auto& context = programCallContext();
        if (!context.method) return {};
        if (!context.stage) return std::string(" (") + context.method + ")";
        return " (stage " + std::to_string(context.stage) + " of " + std::to_string(context.stages) + ", " + context.method + ")";
    }

    std::string inputsText(const Instance& instance, const std::vector<double>& values) const {
        std::string text;
        for (std::size_t port = 0; port < description_.inputs.size(); ++port) {
            const auto& declared = description_.inputs[port];
            text += (text.empty() ? ". Inputs: " : ", ") + declared.key + " = " + formatNumber(values[port]) + (declared.unit.empty() ? "" : " " + declared.unit);
        }
        static_cast<void>(instance);
        return text;
    }

    // Every instance's outputs, converted into its states' units, with every failure named.
    std::vector<std::vector<double>> evaluate(double time, const std::vector<std::pair<std::uint64_t, std::span<const double>>>& evaluations) {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<ProgramInvocation> calls;
        calls.reserve(evaluations.size());
        for (const auto& [instanceId, inputs] : evaluations) {
            auto& instance = instances_.at(instanceId);
            instance.values = portValues(instance, inputs.data());
            calls.push_back({instanceId, instance.values.data(), instance.memory.data(), false});
        }
        const auto outputCount = description_.outputs.size();
        const auto outcomes = transport_->evaluate(time, calls, outputCount);
        // The first evaluation of each instance is made twice and compared: the commonest impurity (a counter in a member) is caught
        // before it changes anything.
        std::vector<ProgramInvocation> unchecked;
        std::vector<std::size_t> uncheckedAt;
        for (std::size_t index = 0; index < calls.size(); ++index) {
            if (!instances_.at(calls[index].instanceId).checked && !outcomes[index].status) {
                unchecked.push_back(calls[index]);
                uncheckedAt.push_back(index);
            }
        }
        if (!unchecked.empty()) {
            const auto again = transport_->evaluate(time, unchecked, outputCount);
            for (std::size_t at = 0; at < unchecked.size(); ++at) {
                auto& instance = instances_.at(unchecked[at].instanceId);
                const auto& first = outcomes[uncheckedAt[at]].values;
                const auto& second = again[at].values;
                for (std::size_t output = 0; output < std::min(first.size(), second.size()); ++output) {
                    if (std::bit_cast<std::uint64_t>(first[output]) != std::bit_cast<std::uint64_t>(second[output])) {
                        throw std::runtime_error(description_.name + " on " + instance.owner + " gave a different ‘" + description_.outputs[output].key +
                            "’ when called twice with the same inputs at t = " + formatNumber(time) + " s (" + formatNumber(first[output]) + ", then " +
                            formatNumber(second[output]) + "). evaluate() must not change anything: keep what it remembers in declared memory and "
                            "change it in advance().");
                    }
                }
                instance.checked = true;
            }
        }
        std::vector<std::vector<double>> results;
        results.reserve(calls.size());
        for (std::size_t index = 0; index < calls.size(); ++index) {
            const auto& instance = instances_.at(calls[index].instanceId);
            const auto& outcome = outcomes[index];
            const auto who = description_.name + " on " + instance.owner;
            if (outcome.status == 2) {
                throw ProgramOutOfDomain(who + " refused its inputs at t = " + formatNumber(time) + " s" + stageText() + ": " + outcome.message +
                    lineText(outcome.line) + inputsText(instance, instance.values));
            }
            if (outcome.status) {
                throw std::runtime_error(who + " failed in evaluate() at t = " + formatNumber(time) + " s" + stageText() + ": " + outcome.message +
                    lineText(outcome.line) + inputsText(instance, instance.values));
            }
            std::vector<double> converted;
            converted.reserve(instance.outputs.size());
            for (const auto& map : instance.outputs) {
                const double raw = outcome.values.at(map.index);
                const auto& key = description_.outputs[map.index].key;
                if (std::bit_cast<std::uint64_t>(raw) == std::bit_cast<std::uint64_t>(InProcessProgramTransport::unsetOutput())) {
                    throw std::runtime_error(description_.name + " did not set ‘" + key + "’ (evaluate() at t = " + formatNumber(time) + " s, on " + instance.owner + ").");
                }
                if (!std::isfinite(raw)) {
                    std::string cause = " from finite inputs" + inputsText(instance, instance.values);
                    for (std::size_t port = 0; port < description_.inputs.size(); ++port) {
                        if (std::isfinite(instance.values[port])) continue;
                        const auto& label = instance.portLabels[port];
                        cause = ": the input ‘" + description_.inputs[port].key + "’ was already " + formatNumber(instance.values[port]) +
                            (label.empty() ? std::string() : ": look at what sets " + label);
                        break;
                    }
                    throw ProgramOutOfDomain(who + " gave " + formatNumber(raw) + " for ‘" + key + "’ at t = " + formatNumber(time) + " s" + stageText() + cause + ".");
                }
                converted.push_back(map.identity ? raw : raw * map.scale + map.offset);
            }
            results.push_back(std::move(converted));
        }
        return results;
    }

    std::string processKey_;
    std::unique_ptr<ProgramTransport> transport_;
    ProgramDescription description_;
    std::unordered_map<std::uint64_t, Instance> instances_;
    std::optional<bool> givesJacobian_;
    std::vector<std::uint64_t> order_;
    // As every version 1 transport: calls into one program are serialized (docs/proposals/programSdkV2.md, decision 6).
    std::mutex mutex_;
};

#ifdef __EMSCRIPTEN__
// The web edition's transport for a version 2 Python program: the Pyodide bridge (src/webPythonProviderBridge.mjs and
// konjugate/_webBridge.py), called synchronously with plain JSON as WasmPyodideProviderBackend calls it, the bridge serving the program
// with the same ProgramHost the native worker uses. Memory crosses as base64.
class WebProgramTransport final : public ProgramTransport {
public:
    WebProgramTransport(std::string processKey, const std::string& source) : processKey_(std::move(processKey)) {
        boost::property_tree::ptree request;
        request.put("kind", "create");
        request.put("processKey", processKey_);
        request.put("source", source);
        description_ = dispatch(request).get<std::string>("description", "");
        if (description_.empty()) throw std::runtime_error("The web edition's Python did not describe a version 2 program.");
    }

    const std::string& description() const override { return description_; }

    void configure(std::size_t inputCount, std::size_t memorySize) override {
        inputCount_ = inputCount;
        memorySize_ = memorySize;
    }

    std::vector<ProgramReply> start(const std::vector<ProgramStart>& instances) override {
        boost::property_tree::ptree request = base("programInitialize");
        boost::property_tree::ptree list;
        for (const auto& instance : instances) {
            boost::property_tree::ptree item;
            item.put("instanceId", instance.instanceId);
            item.put("owner", instance.owner);
            item.put("startTime", instance.startTime);
            item.add_child("values", numbers(instance.values.data(), instance.values.size()));
            boost::property_tree::ptree bound;
            for (const auto flag : instance.bound) bound.push_back({"", boost::property_tree::ptree(std::to_string(static_cast<int>(flag)))});
            item.add_child("bound", bound);
            item.put("ownerId", instance.ownerId);
            item.put("programSeed", instance.seed);
            list.push_back({"", item});
        }
        request.add_child("instances", list);
        auto replies = outcomes(dispatch(request));
        for (std::size_t index = 0; index < instances.size() && index < replies.size(); ++index) copyMemory(replies[index], instances[index].memory);
        return replies;
    }

    std::vector<ProgramReply> evaluate(double time, const std::vector<ProgramInvocation>& calls, std::size_t) override {
        auto request = base("programEvaluate");
        request.put("time", time);
        request.add_child("calls", encodeCalls(calls));
        return outcomes(dispatch(request));
    }

    std::vector<ProgramReply> advance(double time, double size, const std::vector<ProgramInvocation>& calls) override {
        auto request = base("programAdvance");
        request.put("time", time);
        request.put("size", size);
        request.add_child("calls", encodeCalls(calls));
        auto replies = outcomes(dispatch(request));
        for (std::size_t index = 0; index < calls.size() && index < replies.size(); ++index) copyMemory(replies[index], calls[index].memory);
        return replies;
    }

    std::vector<ProgramReply> jacobian(double time, const std::vector<ProgramInvocation>& calls, std::size_t) override {
        auto request = base("programJacobian");
        request.put("time", time);
        request.add_child("calls", encodeCalls(calls));
        return outcomes(dispatch(request));
    }

    void setMemory(const std::vector<ProgramInvocation>& calls, std::size_t memorySize) override {
        if (!memorySize || calls.empty()) return;
        auto request = base("programSetMemory");
        boost::property_tree::ptree list;
        for (const auto& call : calls) {
            boost::property_tree::ptree item;
            item.put("instanceId", call.instanceId);
            item.put("memoryBase64", encode(std::span<const std::byte>(call.memory, memorySize)));
            list.push_back({"", item});
        }
        request.add_child("memories", list);
        dispatch(request);
    }

    void shutdown() noexcept override {
        try {
            dispatch(base("shutdown"));
        } catch (...) {} // NOLINT(bugprone-empty-catch)
    }

private:
    boost::property_tree::ptree base(const char* kind) const {
        boost::property_tree::ptree request;
        request.put("kind", kind);
        request.put("processKey", processKey_);
        return request;
    }

    static boost::property_tree::ptree numbers(const double* values, std::size_t count) {
        boost::property_tree::ptree list;
        for (std::size_t index = 0; index < count; ++index) {
            std::ostringstream text;
            text.precision(17);
            text << values[index];
            list.push_back({"", boost::property_tree::ptree(text.str())});
        }
        return list;
    }

    boost::property_tree::ptree encodeCalls(const std::vector<ProgramInvocation>& calls) const {
        boost::property_tree::ptree list;
        for (const auto& call : calls) {
            boost::property_tree::ptree item;
            item.put("instanceId", call.instanceId);
            item.add_child("values", numbers(call.values, inputCount_));
            item.put("first", call.first ? 1 : 0);
            list.push_back({"", item});
        }
        return list;
    }

    static std::vector<ProgramReply> outcomes(const boost::property_tree::ptree& response) {
        std::vector<ProgramReply> replies;
        if (const auto list = response.get_child_optional("outcomes")) for (const auto& [unused, item] : *list) {
            static_cast<void>(unused);
            ProgramReply reply;
            reply.status = item.get<std::int32_t>("status", 0);
            reply.message = item.get<std::string>("message", "");
            reply.line = item.get<std::uint32_t>("line", 0);
            reply.clockPeriod = item.get<double>("clockPeriod", 0);
            if (const auto values = item.get_child_optional("outputs")) {
                for (const auto& value : *values) {
                    const auto text = value.second.get_value<std::string>();
                    reply.values.push_back(text == "nan" || text == "NaN" ? std::numeric_limits<double>::quiet_NaN()
                        : text == "inf" || text == "Infinity" ? std::numeric_limits<double>::infinity()
                        : text == "-inf" || text == "-Infinity" ? -std::numeric_limits<double>::infinity() : std::stod(text));
                }
            }
            const auto memory = decode(item.get<std::string>("memoryBase64", ""));
            reply.memory.assign(reinterpret_cast<const char*>(memory.data()), memory.size());
            replies.push_back(std::move(reply));
        }
        return replies;
    }

    void copyMemory(const ProgramReply& reply, std::byte* memory) const {
        if (reply.status || !memory || !memorySize_ || reply.memory.size() != memorySize_) return;
        std::memcpy(memory, reply.memory.data(), memorySize_);
    }

    static std::string encode(std::span<const std::byte> bytes) {
        static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        std::string out;
        std::size_t index = 0;
        for (; index + 3 <= bytes.size(); index += 3) {
            const unsigned value = (static_cast<unsigned>(bytes[index]) << 16) | (static_cast<unsigned>(bytes[index + 1]) << 8) | static_cast<unsigned>(bytes[index + 2]);
            out += table[(value >> 18) & 63]; out += table[(value >> 12) & 63]; out += table[(value >> 6) & 63]; out += table[value & 63];
        }
        if (bytes.size() - index == 1) {
            const unsigned value = static_cast<unsigned>(bytes[index]) << 16;
            out += table[(value >> 18) & 63]; out += table[(value >> 12) & 63]; out += "==";
        } else if (bytes.size() - index == 2) {
            const unsigned value = (static_cast<unsigned>(bytes[index]) << 16) | (static_cast<unsigned>(bytes[index + 1]) << 8);
            out += table[(value >> 18) & 63]; out += table[(value >> 12) & 63]; out += table[(value >> 6) & 63]; out += '=';
        }
        return out;
    }

    static std::vector<std::byte> decode(const std::string& text) {
        std::vector<std::byte> out;
        int buffer = 0;
        int bits = 0;
        for (const char character : text) {
            int value = -1;
            if (character >= 'A' && character <= 'Z') value = character - 'A';
            else if (character >= 'a' && character <= 'z') value = character - 'a' + 26;
            else if (character >= '0' && character <= '9') value = character - '0' + 52;
            else if (character == '+') value = 62;
            else if (character == '/') value = 63;
            if (value < 0) continue;
            buffer = (buffer << 6) | value;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out.push_back(static_cast<std::byte>((buffer >> bits) & 0xff));
            }
        }
        return out;
    }

    boost::property_tree::ptree dispatch(const boost::property_tree::ptree& request) {
        std::ostringstream requestStream;
        boost::property_tree::write_json(requestStream, request, false);
        char* responsePointer = wasmDispatchPythonProviderRequest(requestStream.str().c_str());
        const std::string responseJson(responsePointer);
        std::free(responsePointer);
        boost::property_tree::ptree response;
        std::istringstream responseStream(responseJson);
        boost::property_tree::read_json(responseStream, response);
        if (!response.get<bool>("ok", false)) throw std::runtime_error(response.get<std::string>("message", "The web edition's Python failed."));
        return response;
    }

    std::string processKey_;
    std::string description_;
    std::size_t inputCount_ = 0;
    std::size_t memorySize_ = 0;
};
#endif

namespace {

// Each tier is only attempted for cppProvider tasks in its matching (or a higher) execution
// mode; any construction failure — including a mode simply not being available on this
// platform — falls back down the chain (inProcess -> sharedMemoryWorker -> pipeWorker) so a
// single unsupported/misconfigured host never blocks a whole run. Python providers always use
// the pipe backend: neither faster transport has a story for an interpreted language.
//
// isNodeShaped distinguishes a NodeProviderTask from a ContributionTask -- both can carry
// implementation == cppProvider, but they need different artifacts (a node-shaped shim exports a
// different ABI/entry point, see providerInProcessNodeShim.cpp) and different execution
// guarantees: providerWorker.cpp has no node-provider protocol handling for C++ at all (only the
// Python worker speaks those messages), so a node-shaped cpp task deliberately gets NO
// worker-process fallback chain -- it either runs in-process or fails clearly, rather than
// falling through into pipe/shared-memory code that doesn't understand it.
std::unique_ptr<ProviderBackend> createProviderBackend(const std::string& key, ContributionImplementation implementation,
                                                        const std::string& providerSource, const ProviderConfiguration& config,
                                                        bool isNodeShaped) {
    if (implementation == ContributionImplementation::cppProvider && isNodeShaped) {
        if (config.executionMode != ProviderExecutionMode::inProcess) {
            throw std::runtime_error(
                "C++ computational-node provider '" + key + "' requires the in-process provider execution mode.");
        }
        const auto libraryPath = buildCppProvider(providerSource, config, CppProviderArtifactKind::nodeSharedLibrary);
        return std::make_unique<InProcessNodeProviderBackend>(key, libraryPath, config);
    }
    if (implementation == ContributionImplementation::cppProvider) {
        if (config.executionMode == ProviderExecutionMode::inProcess) {
            try {
                const auto libraryPath = buildCppProvider(providerSource, config, CppProviderArtifactKind::sharedLibrary);
                return std::make_unique<InProcessProviderBackend>(key, implementation, libraryPath, config);
            } catch (const std::exception& error) {
                std::cerr << "Falling back from the in-process provider transport for '" << key << "': " << error.what() << '\n';
            }
        }
#ifndef _WIN32
        if (config.executionMode == ProviderExecutionMode::inProcess ||
            config.executionMode == ProviderExecutionMode::sharedMemoryWorker) {
            try {
                const auto executablePath = buildCppProvider(providerSource, config, CppProviderArtifactKind::executable);
                return std::make_unique<SharedMemoryProviderBackend>(key, implementation, executablePath, config);
            } catch (const std::exception& error) {
                std::cerr << "Falling back to the pipe provider transport for '" << key << "': " << error.what() << '\n';
            }
        }
#endif
    }
#ifdef __EMSCRIPTEN__
    // A browser tab has no OS process to fork/exec a real python3 interpreter into (see
    // WasmPyodideProviderBackend's own comment above) -- python-kind tasks (relationship- or
    // node-shaped alike, matching PipeProviderBackend's own scope below) route to the Pyodide
    // bridge instead, passing providerSource directly rather than writing it to a file: there is
    // no separate process that needs a real path argument here.
    if (implementation != ContributionImplementation::cppProvider) {
        return std::make_unique<WasmPyodideProviderBackend>(key, providerSource);
    }
    // Relationship-shaped C++ providers route to the WASM/Wasmer bridge (see
    // WasmCppProviderBackend above); node-shaped ones have no worker-process protocol support
    // even natively (see this function's own header comment) and fail clearly here too, rather
    // than falling through into the native buildCppProvider()/PipeProviderBackend path below,
    // which cannot work in a browser (no host compiler, no fork/exec).
    if (!isNodeShaped) {
        return std::make_unique<WasmCppProviderBackend>(key, providerSource);
    }
    throw std::runtime_error(
        "C++ computational-node provider '" + key + "' is not supported in the web edition "
        "(no worker-process protocol for node-shaped C++ providers, even natively).");
#endif
    const auto launchPath = implementation == ContributionImplementation::cppProvider
        ? buildCppProvider(providerSource, config, CppProviderArtifactKind::executable)
        : preparePythonProviderSource(providerSource, config);
    return std::make_unique<PipeProviderBackend>(key, implementation, launchPath, config);
}

// A version 2 program's backend (process keys "cpp2:" and "py2:"). C++ runs in-process whatever the execution mode, as C++ node programs
// do: version 2 has no C++ worker transport yet (docs/proposals/programSdkV2.md, Order of work, stage 5). Python runs in its worker.
std::unique_ptr<ProgramBackend> createProgramBackend(const std::string& key, ContributionImplementation implementation,
                                                     const std::string& providerSource, const ProviderConfiguration& config) {
#ifdef __EMSCRIPTEN__
    static_cast<void>(config);
    if (implementation == ContributionImplementation::cppProvider) {
        throw std::runtime_error("A C++ program cannot run in the web edition: it would need compiling in the browser. Run the model in the desktop app.");
    }
    return std::make_unique<ProgramBackend>(key, std::make_unique<WebProgramTransport>(key, providerSource));
#else
    if (implementation == ContributionImplementation::cppProvider) {
        const auto libraryPath = buildCppProvider(providerSource, config, CppProviderArtifactKind::programSharedLibrary);
        return std::make_unique<ProgramBackend>(key, std::make_unique<InProcessProgramTransport>(key, libraryPath));
    }
    return std::make_unique<ProgramBackend>(key, std::make_unique<PipeProgramTransport>(key, implementation,
        preparePythonProviderSource(providerSource, config), config));
#endif
}

bool isProgramKey(const std::string& key) { return key.rfind("py2:", 0) == 0 || key.rfind("cpp2:", 0) == 0; }

} // namespace

ProviderRuntime::ProviderRuntime(ProviderConfiguration configuration)
    : configuration_(std::move(configuration)) {}

ProviderRuntime::~ProviderRuntime() {
    shutdown();
}

void ProviderRuntime::initialize(const ExecutionPlan& plan) {
    if (initialized_) return;

    // Version 2 programs: one instance per program, however many tasks evaluate it (a two-way relationship's far end is the same program).
    const auto addProgram = [&](const std::string& key, ContributionImplementation implementation, const std::string& source,
                                ProgramInstanceSpec spec) {
        if (programOwners_.contains(spec.ownerId)) return programOwners_.at(spec.ownerId).instanceId;
        auto& proc = processes_[key];
        if (!proc) {
            auto backend = createProgramBackend(key, implementation, source, configuration_);
            programBackends_[key] = backend.get();
            proc = std::move(backend);
        }
        auto* backend = programBackends_.at(key);
        spec.instanceId = nextInstanceId_++;
        programOwners_[spec.ownerId] = {backend, spec.instanceId};
        programOrder_.push_back(spec.ownerId);
        const auto instanceId = spec.instanceId;
        backend->addProgramInstance(std::move(spec));
        return instanceId;
    };
    // Every output of each version 2 relationship's or term's program, across the nodes they reach: a relationship's program with several
    // outputs (implementation.outputs) is one instance whose outputs reach states of both its ends.
    std::unordered_map<EntityId, std::vector<ProgramOutputSpec>> outputsByOwner;
    for (const auto& node : plan.nodes) {
        for (const auto* tasks : {&node.contributions, &node.algebraicTasks, &node.valueTerms}) {
            for (const auto& task : *tasks) {
                if (task.programVersion != 2 || task.negateOutput) continue;
                outputsByOwner[task.sourceId].push_back({task.providerOutputKey, task.outputUnit, tasks == &node.contributions, task.outputLabel});
            }
        }
    }
    for (const auto& node : plan.nodes) {
        StateValues localStates(node.stateIndexes.size());
        for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) localStates[index] = plan.initialStates.at(node.stateIndexes[index]);
        const auto contributionSpec = [&](const ContributionTask& task, bool rate, std::uint8_t ownerKind) {
            ProgramInstanceSpec spec;
            spec.ownerId = task.sourceId;
            spec.ownerKind = ownerKind;
            spec.owner = task.programOwner;
            spec.seed = task.programSeed;
            spec.bindings = task.bindings;
            spec.startValues = programInputs(task.bindings, localStates, plan.initialStates, resolveTaskParameterValues(task.parameters, {}, {}, 0), 0);
            spec.outputs = outputsByOwner[task.sourceId];
            if (spec.outputs.empty()) spec.outputs.push_back({task.providerOutputKey, task.outputUnit, rate, task.outputLabel});
            return spec;
        };
        for (const auto* tasks : {&node.contributions, &node.algebraicTasks, &node.valueTerms}) {
            for (const auto& task : *tasks) {
                if (task.programVersion != 2 || task.negateOutput) continue;
                const bool rate = tasks == &node.contributions;
                taskInstanceIds_[task.sourceId] = addProgram(providerProcessKey(task), task.implementation, task.providerSource,
                    contributionSpec(task, rate, task.programOwnerKind));
            }
        }
        if (node.nodeProvider && node.nodeProvider->programVersion == 2) {
            const auto& task = *node.nodeProvider;
            ProgramInstanceSpec spec;
            spec.ownerId = task.nodeId;
            spec.ownerKind = 0;
            spec.owner = task.programOwner;
            spec.seed = task.programSeed;
            spec.bindings = task.bindings;
            spec.startValues = programInputs(task.bindings, localStates, plan.initialStates, resolveTaskParameterValues(task.parameters, {}, {}, 0), 0);
            for (const auto& output : task.outputs) spec.outputs.push_back({output.key, output.unit, !output.setsValue, output.label});
            taskInstanceIds_[task.nodeId] = addProgram(task.providerProcessKeyCache, task.implementation, task.providerSource, std::move(spec));
        }
    }

    for (const auto& node : plan.nodes) {
        for (const auto& task : node.contributions) {
            if (task.implementation == ContributionImplementation::equation || task.programVersion == 2) continue;

            const std::string key = providerProcessKey(task);
            auto& proc = processes_[key];
            if (!proc) {
                proc = createProviderBackend(key, task.implementation, task.providerSource, configuration_, false);
            }

            const std::uint64_t instanceId = nextInstanceId_++;
            taskInstanceIds_[task.sourceId] = instanceId;

            proc->addInstance(instanceId, task.bindings);
            recordInstance(task.sourceId, key, task.implementation, task.bindings);
        }

        // A programmable ("sets the value") algebraic task is evaluated through the exact same
        // evaluateBatch()/providerProcessKey()/sourceId lookup path as an ordinary programmable
        // contribution (see applyAlgebraicTasks in executionPlan.cpp) -- it must be registered
        // here identically, or its first evaluation throws "Task not registered in ProviderRuntime."
        // So must a value term's (NodeExecutionPlan::valueTerms), evaluated the same way in the update phase.
        for (const auto* tasks : {&node.algebraicTasks, &node.valueTerms}) for (const auto& task : *tasks) {
            if (task.implementation == ContributionImplementation::equation || task.programVersion == 2) continue;

            const std::string key = providerProcessKey(task);
            auto& proc = processes_[key];
            if (!proc) {
                proc = createProviderBackend(key, task.implementation, task.providerSource, configuration_, false);
            }

            const std::uint64_t instanceId = nextInstanceId_++;
            taskInstanceIds_[task.sourceId] = instanceId;

            proc->addInstance(instanceId, task.bindings);
            recordInstance(task.sourceId, key, task.implementation, task.bindings);
        }

        if (node.nodeProvider && node.nodeProvider->programVersion != 2) {
            // NOLINTNEXTLINE(bugprone-unchecked-optional-access) -- guarded by the if() directly above.
            const auto& task = *node.nodeProvider;
            const auto& key = task.providerProcessKeyCache;
            auto& proc = processes_[key];
            if (!proc) {
                proc = createProviderBackend(key, task.implementation, task.providerSource, configuration_, true);
            }

            const std::uint64_t instanceId = nextInstanceId_++;
            // Safe to share this EntityId-keyed map with edge/source-term sourceId entries above:
            // docs/projectSchema.md guarantees ids are unique across nodes, states, source terms,
            // edges, parameters and run configurations project-wide.
            taskInstanceIds_[task.nodeId] = instanceId;

            proc->addInstance(instanceId, task.bindings);
            recordInstance(task.nodeId, key, task.implementation, task.bindings);
            nodesByProcess_[key].push_back(task.nodeId);
        }
    }

    for (auto& [key, proc] : processes_) {
        proc->sendInitialization();
    }
    noteUnboundInputs();

    initialized_ = true;
}

void ProviderRuntime::recordInstance(EntityId entityId, const std::string& processKey, ContributionImplementation implementation,
                                     const std::vector<CompiledBinding>& bindings) {
    InstanceRecord record{entityId, processKey, implementation, {}};
    for (const auto& binding : bindings) record.boundKeys.push_back(binding.symbol);
    instanceRecords_.push_back(std::move(record));
}

// A declared input with no binding reads 0 in the older program format, without a word (docs/proposals/programSdkV2.md,
// decision 8). It stays so, for the numbers of saved models; this only says it, once per instance and input.
void ProviderRuntime::noteUnboundInputs() {
    std::unordered_map<std::string, std::vector<std::string>> declaredByProcess;
    for (const auto& record : instanceRecords_) {
        auto found = declaredByProcess.find(record.processKey);
        if (found == declaredByProcess.end()) {
            found = declaredByProcess.emplace(record.processKey, processes_.at(record.processKey)->declaredInputKeys()).first;
        }
        for (const auto& key : found->second) {
            if (std::find(record.boundKeys.begin(), record.boundKeys.end(), key) != record.boundKeys.end()) continue;
            warnings_.push_back({"inputUnbound", {record.entityId}, key, record.implementation});
        }
    }
}

std::vector<std::pair<std::string, double>> ProviderRuntime::evaluateNode(
    const NodeProviderTask& task, std::span<const double> inputs, double simulationTime, double stepSize) {
    const auto processIt = processes_.find(task.providerProcessKeyCache);
    if (processIt == processes_.end()) {
        throw std::runtime_error("Computational-node provider task not registered in ProviderRuntime.");
    }
    const auto instanceIt = taskInstanceIds_.find(task.nodeId);
    if (instanceIt == taskInstanceIds_.end()) {
        throw std::runtime_error("Computational-node provider task not registered in ProviderRuntime.");
    }
    return processIt->second->evaluateNode(instanceIt->second, simulationTime, stepSize, inputs);
}

std::optional<std::vector<std::pair<std::string, double>>> ProviderRuntime::initialNodeOutputs(
    const NodeProviderTask& task, std::span<const double> inputs, double simulationTime) {
    const auto processIt = processes_.find(task.providerProcessKeyCache);
    const auto instanceIt = taskInstanceIds_.find(task.nodeId);
    if (processIt == processes_.end() || instanceIt == taskInstanceIds_.end()) {
        throw std::runtime_error("Computational-node provider task not registered in ProviderRuntime.");
    }
    return processIt->second->initialNodeOutputs(instanceIt->second, simulationTime, inputs);
}

std::vector<std::byte> ProviderRuntime::requestNodeCheckpoint(const NodeProviderTask& task) {
    const auto processIt = processes_.find(task.providerProcessKeyCache);
    if (processIt == processes_.end()) {
        throw std::runtime_error("Computational-node provider task not registered in ProviderRuntime.");
    }
    const auto instanceIt = taskInstanceIds_.find(task.nodeId);
    if (instanceIt == taskInstanceIds_.end()) {
        throw std::runtime_error("Computational-node provider task not registered in ProviderRuntime.");
    }
    auto payload = processIt->second->requestCheckpoint(instanceIt->second);
    // One Python object serves every node running the same source, so their memory is shared (docs/proposals/
    // programSdkV2.md, decision 8). Said once per program, when it shows it keeps memory by checkpointing some.
    const auto sharing = nodesByProcess_.find(task.providerProcessKeyCache);
    if (task.implementation == ContributionImplementation::pythonProvider && !payload.empty() && sharing != nodesByProcess_.end()
        && sharing->second.size() > 1
        && std::find(sharedCheckpointWarned_.begin(), sharedCheckpointWarned_.end(), sharing->first) == sharedCheckpointWarned_.end()) {
        sharedCheckpointWarned_.push_back(sharing->first);
        warnings_.push_back({"sharedCheckpoint", sharing->second, "", task.implementation});
    }
    return payload;
}

void ProviderRuntime::requestNodeRestore(const NodeProviderTask& task, std::span<const std::byte> payload) {
    const auto processIt = processes_.find(task.providerProcessKeyCache);
    if (processIt == processes_.end()) {
        throw std::runtime_error("Computational-node provider task not registered in ProviderRuntime.");
    }
    const auto instanceIt = taskInstanceIds_.find(task.nodeId);
    if (instanceIt == taskInstanceIds_.end()) {
        throw std::runtime_error("Computational-node provider task not registered in ProviderRuntime.");
    }
    processIt->second->requestRestore(instanceIt->second, payload);
}

std::vector<double> ProviderRuntime::evaluateBatch(const std::vector<const ContributionTask*>& tasks,
                                                    const std::vector<std::span<const double>>& inputs,
                                                    double simulationTime,
                                                    double stepSize) {
    if (tasks.empty()) return {};
    if (tasks.size() != inputs.size()) {
        throw std::runtime_error("A provider batch evaluation received mismatched tasks and inputs.");
    }

    const auto& key = providerProcessKey(*tasks.front());
    auto processIt = processes_.find(key);
    if (processIt == processes_.end()) {
        throw std::runtime_error("Task not registered in ProviderRuntime.");
    }
    auto& proc = processIt->second;

    // Spans, not copies: every backend only ever reads these values (serializing them onto a
    // pipe/into shared memory/straight into a C-ABI call), and inputs outlives this whole call,
    // so there is no need to heap-allocate a fresh vector per task just to hand it downstream.
    std::vector<std::pair<std::uint64_t, std::span<const double>>> evaluations;
    evaluations.reserve(tasks.size());
    for (std::size_t index = 0; index < tasks.size(); ++index) {
        const auto* task = tasks[index];
        // Every task passed to a single call is expected to share the same provider process;
        // evaluateContributionTasks groups them that way before calling in, and re-deriving the
        // key here is cheap insurance against a future caller breaking that invariant.
        if (providerProcessKey(*task) != key) {
            throw std::runtime_error("A provider batch evaluation mixed tasks from different provider processes.");
        }
        const auto instIt = taskInstanceIds_.find(task->sourceId);
        if (instIt == taskInstanceIds_.end()) {
            throw std::runtime_error("Task not registered in ProviderRuntime.");
        }
        evaluations.emplace_back(instIt->second, inputs[index]);
    }

    // A version 2 program: each term's own output, by key.
    if (const auto program = programBackends_.find(key); program != programBackends_.end()) {
        std::vector<const std::string*> keys;
        keys.reserve(tasks.size());
        for (const auto* task : tasks) keys.push_back(&task->providerOutputKey);
        return program->second->evaluateKeyed(simulationTime, evaluations, keys);
    }
    const auto results = proc->evaluateBatch(tasks.front()->sequence, simulationTime, stepSize, evaluations);
    if (results.size() != tasks.size()) {
        throw std::runtime_error("A provider process returned a different number of contributions than requested.");
    }

    // Every backend returns results in the same order the evaluations were submitted (the pipe
    // worker and the shared-memory eval loop both process their request slots in order;
    // InProcessProviderBackend iterates evaluations directly), so results can be zipped back to
    // tasks positionally rather than reassociated through a per-call hash map. The instance-id
    // check below is cheap insurance against a future backend breaking that invariant, not a
    // reason to keep the O(n) map around for the common case.
    std::vector<double> ordered;
    ordered.reserve(tasks.size());
    for (std::size_t index = 0; index < results.size(); ++index) {
        if (results[index].first != evaluations[index].first) {
            throw std::runtime_error("A provider process returned contributions out of the requested order.");
        }
        ordered.push_back(results[index].second);
    }
    return ordered;
}

bool ProviderRuntime::declaredPure(const std::string& processKey) const { return isProgramKey(processKey); }

bool ProviderRuntime::programAdvancesEachStep(EntityId owner) const {
    const auto found = programOwners_.find(owner);
    return found != programOwners_.end() && found->second.backend->advancesEachStep(found->second.instanceId);
}

double ProviderRuntime::programClockPeriod(EntityId owner) const {
    const auto found = programOwners_.find(owner);
    return found != programOwners_.end() ? found->second.backend->clockPeriod(found->second.instanceId) : 0;
}

void ProviderRuntime::advancePrograms(const std::vector<ProgramAdvanceCall>& calls, double time, double size) {
    // One batch per program source, in the order the calls come.
    std::vector<std::pair<ProgramBackend*, std::vector<std::pair<std::uint64_t, std::span<const double>>>>> batches;
    for (const auto& call : calls) {
        const auto found = programOwners_.find(call.owner);
        if (found == programOwners_.end()) throw std::runtime_error("A program was advanced that the run never started.");
        auto batch = std::find_if(batches.begin(), batches.end(), [&](const auto& item) { return item.first == found->second.backend; });
        if (batch == batches.end()) batch = batches.insert(batches.end(), {found->second.backend, {}});
        batch->second.emplace_back(found->second.instanceId, std::span<const double>(call.inputs));
    }
    for (const auto& [backend, batch] : batches) backend->advance(batch, time, size);
}

std::optional<std::vector<std::string>> ProviderRuntime::programOutputDependencies(EntityId owner, const std::string& outputKey) const {
    const auto found = programOwners_.find(owner);
    if (found == programOwners_.end()) return std::nullopt;
    const auto& description = found->second.backend->description();
    const auto output = std::find_if(description.outputs.begin(), description.outputs.end(), [&](const auto& port) { return port.key == outputKey; });
    const auto& declared = description.node ? output : description.outputs.begin();
    if (declared == description.outputs.end() || !declared->declaresDependencies) return std::nullopt;
    return declared->dependsOn;
}

bool ProviderRuntime::suppliesJacobian(const ContributionTask& task) const {
    if (task.programVersion != 2) return false;
    const auto backend = programBackends_.find(providerProcessKey(task));
    return backend != programBackends_.end() && backend->second->givesJacobian();
}

bool ProviderRuntime::evaluateJacobianBatch(const std::vector<const ContributionTask*>& tasks, const std::vector<std::span<const double>>& inputs,
                                            double simulationTime, double, std::vector<std::vector<double>>& derivatives) {
    derivatives.assign(tasks.size(), {});
    for (std::size_t index = 0; index < tasks.size(); ++index) {
        const auto& task = *tasks[index];
        if (task.programVersion != 2) return false;
        const auto backend = programBackends_.find(providerProcessKey(task));
        const auto instance = taskInstanceIds_.find(task.sourceId);
        if (backend == programBackends_.end() || instance == taskInstanceIds_.end()) return false;
        auto given = backend->second->jacobianByBinding(instance->second, task.providerOutputKey, simulationTime, inputs[index]);
        if (!given) return false;
        derivatives[index] = std::move(*given);
    }
    return true;
}

std::vector<ProgramMemoryState> ProviderRuntime::programMemory() const {
    std::vector<ProgramMemoryState> states;
    for (const auto owner : programOrder_) {
        const auto& entry = programOwners_.at(owner);
        if (entry.backend->hasMemory()) states.push_back(entry.backend->memoryState(entry.instanceId));
    }
    return states;
}

void ProviderRuntime::restoreProgramMemory(const std::vector<ProgramMemoryState>& memory, std::vector<std::string>* notes) {
    for (const auto& saved : memory) {
        const auto found = programOwners_.find(saved.owner);
        if (found == programOwners_.end()) {
            if (notes) notes->push_back("A program's memory in this checkpoint belongs to something no longer in the model, and is left out.");
            continue;
        }
        found->second.backend->restoreMemory(found->second.instanceId, saved, notes);
    }
}

std::vector<std::pair<EntityId, double>> ProviderRuntime::programClocks() const {
    std::vector<std::pair<EntityId, double>> clocks;
    for (const auto owner : programOrder_) {
        const auto& entry = programOwners_.at(owner);
        const auto period = entry.backend->clockPeriod(entry.instanceId);
        if (period > 0) clocks.emplace_back(owner, period);
    }
    return clocks;
}

std::string ProviderRuntime::programName(EntityId owner) const {
    const auto found = programOwners_.find(owner);
    if (found == programOwners_.end()) return {};
    return found->second.backend->description().name + " on " + found->second.backend->owner(found->second.instanceId);
}

namespace {

std::string jsonString(const std::string& text) {
    std::string out = "\"";
    for (const char character : text) {
        const auto byte = static_cast<unsigned char>(character);
        if (character == '"' || character == '\\') { out += '\\'; out += character; }
        else if (character == '\n') out += "\\n";
        else if (byte < 0x20) { char escaped[8]; std::snprintf(escaped, sizeof escaped, "\\u%04x", byte); out += escaped; }
        else out += character;
    }
    return out + "\"";
}

std::string jsonNumber(double value) {
    if (!std::isfinite(value)) return "null";
    std::ostringstream stream;
    stream.precision(17);
    stream << value;
    return stream.str();
}

// The source's lines with comments blanked (strings and characters kept), so a declaration written in a comment is not found.
std::vector<std::string> codeLines(const std::string& source) {
    std::vector<std::string> lines(1);
    enum class In { code, line, block, string, character } state = In::code;
    for (std::size_t at = 0; at < source.size(); ++at) {
        const char character = source[at];
        const char next = at + 1 < source.size() ? source[at + 1] : '\0';
        if (character == '\n') {
            lines.emplace_back();
            if (state == In::line) state = In::code;
            continue;
        }
        auto& line = lines.back();
        switch (state) {
        case In::code:
            if (character == '/' && next == '/') { state = In::line; line += ' '; continue; }
            if (character == '/' && next == '*') { state = In::block; line += "  "; ++at; continue; }
            if (character == '"') state = In::string;
            if (character == '\'') state = In::character;
            line += character;
            break;
        case In::line: line += ' '; break;
        case In::block:
            if (character == '*' && next == '/') { state = In::code; line += "  "; ++at; continue; }
            line += ' ';
            break;
        case In::string:
        case In::character:
            line += character;
            if (character == '\\' && next != '\n' && next != '\0') { line += next; ++at; continue; }
            if (character == (state == In::string ? '"' : '\'')) state = In::code;
            break;
        }
    }
    return lines;
}

std::string regexEscaped(const std::string& text) {
    static const std::regex special(R"([.^$|()\[\]{}*+?\\])");
    return std::regex_replace(text, special, R"(\$&)");
}

// The 1-based line of the first line of code matching `pattern`, or 0.
std::size_t firstLineMatching(const std::vector<std::string>& lines, const std::regex& pattern) {
    for (std::size_t index = 0; index < lines.size(); ++index) if (std::regex_search(lines[index], pattern)) return index + 1;
    return 0;
}

// A C++ declaration's line: its key or name, the first argument after `this` (k::Input setpoint{this, "setpoint", "K"}).
std::size_t cppDeclarationLine(const std::vector<std::string>& lines, const std::string& key) {
    return firstLineMatching(lines, std::regex(R"([({]\s*this\s*,\s*")" + regexEscaped(key) + "\""));
}

// The line a problem names: a compiler's "file.cpp:41:32: error", a program's "(line 18)" or "Line 18."; 0 when it names none.
std::size_t problemLine(const std::string& message) {
    static const std::regex compiler(R"(\.(?:cpp|cc|cxx|hpp|h):(\d+):\d+:\s*(?:fatal\s+)?error)");
    static const std::regex said(R"([(\s][Ll]ine (\d+)[).])");
    std::smatch match;
    if (std::regex_search(message, match, compiler) || std::regex_search(message, match, said)) return std::stoul(match[1].str());
    return 0;
}

std::string jsonLine(std::size_t line) { return line ? std::to_string(line) : std::string("null"); }

std::string conversionJson(const UnitConversion& conversion, const std::string& from, const std::string& to) {
    if (!conversion.error.empty()) return "{\"error\":" + jsonString(conversion.error) + "}";
    return "{\"scale\":" + jsonNumber(conversion.scale) + ",\"offset\":" + jsonNumber(conversion.offset) + ",\"identity\":" +
        (conversion.identity ? "true" : "false") + ",\"text\":" + (conversion.identity ? std::string("null") : jsonString(from + " → " + to + " at the port")) + "}";
}

// The code editor's Check, Describe and Test in the web edition, which cannot compile a C++ program: refused with the way forward.
void refuseCppProgramOnWeb([[maybe_unused]] const std::string& kind) {
#ifdef __EMSCRIPTEN__
    if (kind == "cpp") throw std::runtime_error("The web edition cannot compile a C++ program. Check this C++ program in the desktop app.");
#endif
}

const std::string identityConversion = "{\"scale\":1,\"offset\":0,\"identity\":true,\"text\":null}";

}

namespace {

// A program's memory as JSON, field by field by name: a real, an integer or a flag as one number, an array or a stream as several.
std::string memoryJsonOf(const ProgramMemoryState& state) {
    std::string json = "{";
    for (std::size_t index = 0; index < state.fields.size(); ++index) {
        const auto& field = state.fields[index];
        json += std::string(index ? "," : "") + jsonString(field.name) + ":[";
        for (std::size_t word = 0; word < field.words.size(); ++word) {
            const double shown = field.type == 0 || field.type == 3 ? std::bit_cast<double>(field.words[word])
                : field.type == 1 ? static_cast<double>(std::bit_cast<std::int64_t>(field.words[word])) : static_cast<double>(field.words[word]);
            json += std::string(word ? "," : "") + jsonNumber(shown);
        }
        json += "]";
    }
    return json + "}";
}

// Check program, and with `test` Test: the standard checks, and a trace of `test->steps` steps on an instance of its own.
std::string runProgramCheck(const std::string& kind, const std::string& source, const ProviderConfiguration& configuration,
                            const std::unordered_map<std::string, double>& givenInputs, double time, const ProgramTestRequest* test) {
    // Each problem with the check it failed ("" for none: the program could not be loaded, or a step of the trace), and for the trace its
    // step and time.
    struct Problem {
        std::string message;
        std::string check;
        int step = -1;
        double time = 0;
    };
    std::vector<Problem> problems;
    const auto fail = [&](std::string check, std::string message) { problems.push_back({std::move(message), std::move(check)}); };
    // Which checks ran: ports, outputs, purity, memory, jacobian, in that order; null for one that did not run.
    std::vector<std::pair<std::string, int>> checks{{"ports", -1}, {"outputs", -1}, {"purity", -1}, {"memory", -1}, {"jacobian", -1}};
    const auto ran = [&](const std::string& check) {
        for (auto& [name, state] : checks) if (name == check) state = 1;
    };
    std::string name;
    std::string programKind;
    std::string described = "[]";
    std::string outputsJson = "{}";
    std::string memoryJson = "{}";
    std::string traceJson = "null";
    const ProgramDescription* loaded = nullptr;
    // A problem's line: the one it names, else the declaration of the first port it names (‘warming’), C++ found in the source.
    const auto lineOfProblem = [&](const std::string& message) -> std::size_t {
        if (const auto said = problemLine(message)) return said;
        if (!loaded) return 0;
        const auto lines = kind == "cpp" ? codeLines(source) : std::vector<std::string>{};
        const auto declared = [&](std::size_t line, const std::string& key) { return line ? line : kind == "cpp" ? cppDeclarationLine(lines, key) : 0; };
        for (const auto& port : loaded->outputs) if (message.find("‘" + port.key + "’") != std::string::npos) return declared(port.line, port.key);
        for (const auto& port : loaded->inputs) if (message.find("‘" + port.key + "’") != std::string::npos) return declared(port.line, port.key);
        return 0;
    };
    const auto finish = [&] {
        std::string json = "{\"ok\":" + std::string(problems.empty() ? "true" : "false") + ",\"program\":" + jsonString(name) + ",\"kind\":" +
            jsonString(programKind) + ",\"inputs\":" + described + ",\"problems\":[";
        for (std::size_t index = 0; index < problems.size(); ++index) json += (index ? "," : "") + jsonString(problems[index].message);
        json += "],\"outputs\":" + outputsJson + ",\"memory\":" + memoryJson;
        if (!test) return json + "}";
        json += ",\"checks\":[";
        for (std::size_t index = 0; index < checks.size(); ++index) {
            const auto& [check, state] = checks[index];
            const bool failed = std::any_of(problems.begin(), problems.end(), [&](const Problem& problem) { return problem.check == check; });
            json += std::string(index ? "," : "") + "{\"name\":" + jsonString(check) + ",\"passed\":" +
                (failed ? "false" : state > 0 ? "true" : "null") + "}";
        }
        json += "],\"problemDetails\":[";
        for (std::size_t index = 0; index < problems.size(); ++index) {
            const auto& problem = problems[index];
            json += std::string(index ? "," : "") + "{\"message\":" + jsonString(problem.message) + ",\"line\":" + jsonLine(lineOfProblem(problem.message)) +
                ",\"check\":" + (problem.check.empty() ? std::string("null") : jsonString(problem.check)) + ",\"step\":" +
                (problem.step < 0 ? std::string("null") : std::to_string(problem.step)) + ",\"time\":" + (problem.step < 0 ? std::string("null") : jsonNumber(problem.time)) + "}";
        }
        return json + "],\"trace\":" + traceJson + "}";
    };
    const auto implementation = kind == "cpp" ? ContributionImplementation::cppProvider : ContributionImplementation::pythonProvider;
    std::unique_ptr<ProgramBackend> backend;
    try {
        refuseCppProgramOnWeb(kind);
        backend = createProgramBackend((kind == "cpp" ? "cpp2:" : "py2:") + source, implementation, source, configuration);
    } catch (const std::exception& error) {
        fail("", error.what());
        return finish();
    }
    const auto& description = backend->description();
    loaded = &description;
    name = description.name;
    programKind = description.node ? "node" : "relationship";
    // Every port declared once, with a key a file can bind.
    const std::regex identifier("^[a-z][A-Za-z0-9]*$");
    std::set<std::string> keys;
    described = "[";
    for (std::size_t index = 0; index < description.inputs.size(); ++index) {
        const auto& port = description.inputs[index];
        described += std::string(index ? "," : "") + "{\"key\":" + jsonString(port.key) + ",\"kind\":" + jsonString(port.kind) + ",\"unit\":" + jsonString(port.unit) +
            (port.hasDefault ? ",\"default\":" + jsonNumber(port.defaultValue) : "") + "}";
    }
    described += "]";
    ran("ports");
    for (const auto& key : [&] {
             std::vector<std::string> all;
             for (const auto& port : description.inputs) all.push_back(port.key);
             for (const auto& port : description.outputs) all.push_back(port.key);
             return all;
         }()) {
        if (!std::regex_match(key, identifier)) fail("ports", "The port '" + key + "' is not a valid key: it must start with a small letter and hold only letters and digits.");
        if (!keys.insert(key).second) fail("ports", "The port '" + key + "' is declared twice.");
    }
    if (!problems.empty()) return finish();
    // Two instances of the program, every input bound, read from what was given, the default, or 0; Test's trace runs on a third.
    std::vector<CompiledBinding> bindings;
    std::vector<double> values;
    for (const auto& port : description.inputs) {
        CompiledBinding binding;
        binding.symbol = port.key;
        bindings.push_back(binding);
        const auto given = givenInputs.find(port.key);
        values.push_back(given != givenInputs.end() ? given->second : port.hasDefault ? port.defaultValue : 0.0);
    }
    const std::uint64_t traced = 3;
    for (std::uint64_t instance = 1; instance <= (test ? traced : 2); ++instance) {
        ProgramInstanceSpec spec;
        spec.instanceId = instance;
        spec.ownerId = 1;
        spec.owner = "the check";
        spec.bindings = bindings;
        spec.startValues = values;
        for (const auto& port : description.outputs) spec.outputs.push_back({port.key, "", true, ""});
        backend->addProgramInstance(std::move(spec));
    }
    std::vector<double> outputs;
    try {
        backend->sendInitialization();
        // The first evaluation is made twice and compared by the backend itself: purity.
        ran("outputs");
        ran("purity");
        const auto evaluated = backend->evaluateNode(1, time, 0, values);
        outputsJson = "{";
        for (std::size_t index = 0; index < evaluated.size(); ++index) {
            outputs.push_back(evaluated[index].second);
            outputsJson += std::string(index ? "," : "") + jsonString(evaluated[index].first) + ":" + jsonNumber(evaluated[index].second);
        }
        outputsJson += "}";
    } catch (const std::exception& error) {
        const std::string message = error.what();
        const bool impure = message.find("when called twice") != std::string::npos;
        // An evaluation that failed outright was never compared with a second one.
        if (!impure) for (auto& [check, state] : checks) if (check == "purity") state = -1;
        fail(impure ? "purity" : "outputs", message);
        return finish();
    }
    // The memory round trip: memory copied into a fresh instance, then both advanced and evaluated alike.
    std::string current = "memory";
    try {
        if (backend->hasMemory()) {
            ran("memory");
            // Both as a run continued from a checkpoint: the same memory, and neither at its first advance().
            const auto saved = backend->memoryState(1);
            backend->restoreMemory(1, saved, nullptr);
            backend->restoreMemory(2, saved, nullptr);
            const double size = backend->clockPeriod(1) > 0 ? backend->clockPeriod(1) : 0.01;
            for (int round = 0; round < 3; ++round) {
                const double at = time + size * (round + 1);
                const std::vector<std::pair<std::uint64_t, std::span<const double>>> left{{1, values}};
                const std::vector<std::pair<std::uint64_t, std::span<const double>>> right{{2, values}};
                backend->advance(left, at, size);
                backend->advance(right, at, size);
                const auto one = backend->memoryState(1);
                const auto two = backend->memoryState(2);
                bool same = one.fields.size() == two.fields.size();
                for (std::size_t field = 0; same && field < one.fields.size(); ++field) same = one.fields[field].words == two.fields[field].words;
                if (!same) {
                    fail("memory", "Memory restored into a fresh instance did not advance as the original did: something the program remembers is not declared as memory.");
                    break;
                }
                const auto a = backend->evaluateNode(1, at, 0, values);
                const auto b = backend->evaluateNode(2, at, 0, values);
                bool equal = a.size() == b.size();
                for (std::size_t index = 0; equal && index < a.size(); ++index) equal = std::bit_cast<std::uint64_t>(a[index].second) == std::bit_cast<std::uint64_t>(b[index].second);
                if (!equal) {
                    fail("memory", "A fresh instance with the same memory gave different outputs: the program keeps something outside its declared memory.");
                    break;
                }
            }
            memoryJson = memoryJsonOf(backend->memoryState(1));
        }
        // A Jacobian, if given, against central differences.
        current = "jacobian";
        if (const auto entries = backend->jacobian(1, time, values)) {
            ran("jacobian");
            const auto width = description.inputs.size();
            for (std::size_t column = 0; column < width; ++column) {
                const double step = 1e-6 * std::max(1.0, std::abs(values[column]));
                auto above = values;
                auto below = values;
                above[column] += step;
                below[column] -= step;
                const auto high = backend->evaluateNode(1, time, 0, above);
                const auto low = backend->evaluateNode(1, time, 0, below);
                for (std::size_t row = 0; row < description.outputs.size(); ++row) {
                    const double differenced = (high[row].second - low[row].second) / (2 * step);
                    const double given = entries->at(row * width + column);
                    if (std::abs(differenced - given) > 1e-4 * std::max(1.0, std::abs(differenced))) {
                        std::ostringstream message;
                        message << "The Jacobian's entry for '" << description.outputs[row].key << "' by '" << description.inputs[column].key << "' is "
                                << given << ", but differences give " << differenced << ".";
                        fail("jacobian", message.str());
                    }
                }
            }
        }
    } catch (const std::exception& error) {
        fail(current, error.what());
    }
    if (!test) return finish();
    // Test's trace, on its own instance with the inputs held: evaluate() at `time` after initialize(); then each step advance() and evaluate()
    // again. A clock ticks at the start of each step (advance() at time, time + h, ...); without one, advance() ends a step of h (at
    // time + h, time + 2h, ...). h is the step size asked for, else the clock's period, else 0.01 s. It stops at the first failure.
    const double clockPeriod = backend->clockPeriod(traced);
    const bool clocked = clockPeriod > 0;
    const double stepSize = test->stepSize > 0 ? test->stepSize : clocked ? clockPeriod : 0.01;
    std::string rows;
    const auto row = [&](int step, double at) {
        const auto evaluated = backend->evaluateNode(traced, at, 0, values);
        std::string json = std::string(rows.empty() ? "" : ",") + "{\"step\":" + std::to_string(step) + ",\"time\":" + jsonNumber(at) + ",\"outputs\":{";
        for (std::size_t index = 0; index < evaluated.size(); ++index) {
            json += std::string(index ? "," : "") + jsonString(evaluated[index].first) + ":" + jsonNumber(evaluated[index].second);
        }
        rows += json + "},\"memory\":" + memoryJsonOf(backend->memoryState(traced)) + "}";
    };
    int step = 0;
    double at = time;
    try {
        row(0, time);
        for (step = 1; step <= test->steps; ++step) {
            at = clocked ? time + stepSize * (step - 1) : time + stepSize * step;
            const std::vector<std::pair<std::uint64_t, std::span<const double>>> call{{traced, values}};
            backend->advance(call, at, stepSize);
            row(step, at);
        }
    } catch (const std::exception& error) {
        problems.push_back({error.what(), "", step, at});
    }
    traceJson = "{\"stepSize\":" + jsonNumber(stepSize) + ",\"clocked\":" + (clocked ? "true" : "false") + ",\"rows\":[" + rows + "]}";
    return finish();
}

}

std::string checkProgram(const std::string& kind, const std::string& source, const ProviderConfiguration& configuration,
                         const std::unordered_map<std::string, double>& givenInputs, double time) {
    return runProgramCheck(kind, source, configuration, givenInputs, time, nullptr);
}

std::string testProgram(const std::string& kind, const std::string& source, const ProviderConfiguration& configuration,
                        const std::unordered_map<std::string, double>& givenInputs, double time, const ProgramTestRequest& test) {
    return runProgramCheck(kind, source, configuration, givenInputs, time, &test);
}

std::string describeProgram(const std::string& kind, const std::string& source, const ProviderConfiguration& configuration, const ProgramPortUnits& ports,
                            const std::unordered_map<std::string, double>& givenInputs) {
    std::vector<std::string> problems;
    std::string body;
    const auto finish = [&] {
        std::string json = "{\"ok\":" + std::string(problems.empty() ? "true" : "false") + ",\"language\":" + jsonString(kind == "cpp" ? "cpp" : "python") + body +
            ",\"problems\":[";
        for (std::size_t index = 0; index < problems.size(); ++index) {
            json += std::string(index ? "," : "") + "{\"message\":" + jsonString(problems[index]) + ",\"line\":" + jsonLine(problemLine(problems[index])) + "}";
        }
        return json + "]}";
    };
    const auto implementation = kind == "cpp" ? ContributionImplementation::cppProvider : ContributionImplementation::pythonProvider;
    std::unique_ptr<ProgramBackend> backend;
    try {
        refuseCppProgramOnWeb(kind);
        backend = createProgramBackend((kind == "cpp" ? "cpp2:" : "py2:") + source, implementation, source, configuration);
    } catch (const std::exception& error) {
        problems.emplace_back(error.what());
        body = ",\"program\":\"\",\"kind\":\"\",\"inputs\":[],\"outputs\":[],\"memory\":[],\"clock\":null";
        return finish();
    }
    const auto& description = backend->description();
    // C++ declarations are found in the source by their key; Python's SDK says where each was made.
    const auto lines = codeLines(source);
    const auto lineOf = [&](std::size_t said, const std::string& key) { return said ? said : kind == "cpp" ? cppDeclarationLine(lines, key) : 0; };
    // The memory a run starts from: initialize() at these inputs (by key; one not given reads its default, or 0).
    std::vector<double> values;
    std::vector<CompiledBinding> bindings;
    for (const auto& port : description.inputs) {
        CompiledBinding binding;
        binding.symbol = port.key;
        bindings.push_back(binding);
        const auto given = givenInputs.find(port.key);
        values.push_back(given != givenInputs.end() ? given->second : port.hasDefault ? port.defaultValue : 0.0);
    }
    std::optional<ProgramMemoryState> start;
    double clockPeriod = description.clockPeriod;
    try {
        ProgramInstanceSpec spec;
        spec.instanceId = 1;
        spec.ownerId = 1;
        spec.owner = "the description";
        spec.bindings = bindings;
        spec.startValues = values;
        for (const auto& port : description.outputs) spec.outputs.push_back({port.key, "", true, ""});
        backend->addProgramInstance(std::move(spec));
        backend->sendInitialization();
        if (backend->hasMemory()) start = backend->memoryState(1);
        clockPeriod = backend->clockPeriod(1);
    } catch (const std::exception& error) {
        problems.emplace_back(error.what());
    }
    body = ",\"program\":" + jsonString(description.name) + ",\"kind\":" + jsonString(description.node ? "node" : "relationship") + ",\"inputs\":[";
    for (std::size_t index = 0; index < description.inputs.size(); ++index) {
        const auto& port = description.inputs[index];
        body += std::string(index ? "," : "") + "{\"key\":" + jsonString(port.key) + ",\"kind\":" + jsonString(port.kind) + ",\"unit\":" + jsonString(port.unit) +
            (port.hasDefault ? ",\"default\":" + jsonNumber(port.defaultValue) : "") + ",\"line\":" + jsonLine(lineOf(port.line, port.key));
        // As a run converts it: the bound value's unit onto the port's, nothing converted when either has none.
        if (const auto bound = ports.inputs.find(port.key); bound != ports.inputs.end()) {
            body += ",\"conversion\":" + (port.unit.empty() || bound->second.empty() ? identityConversion
                : conversionJson(unitConversion(bound->second, port.unit, false), bound->second, port.unit));
        }
        body += "}";
    }
    body += "],\"outputs\":[";
    for (std::size_t index = 0; index < description.outputs.size(); ++index) {
        const auto& port = description.outputs[index];
        body += std::string(index ? "," : "") + "{\"key\":" + jsonString(port.key) + ",\"unit\":" + jsonString(port.unit);
        if (port.declaresDependencies) {
            body += ",\"dependsOn\":[";
            for (std::size_t at = 0; at < port.dependsOn.size(); ++at) body += std::string(at ? "," : "") + jsonString(port.dependsOn[at]);
            body += "]";
        }
        body += ",\"line\":" + jsonLine(lineOf(port.line, port.key));
        // As a run converts it: the port's unit onto its state's, per second for a Rate state, which never takes an offset.
        if (const auto state = ports.outputs.find(port.key); state != ports.outputs.end()) {
            const auto expected = state->second.rate ? perSecond(state->second.unit) : state->second.unit;
            body += ",\"conversion\":" + (port.unit.empty() || state->second.unit.empty() ? identityConversion
                : conversionJson(unitConversion(port.unit, expected, state->second.rate), port.unit, expected));
        }
        body += "}";
    }
    body += "],\"memory\":[";
    for (std::size_t index = 0; index < description.memory.size(); ++index) {
        const auto& field = description.memory[index];
        body += std::string(index ? "," : "") + "{\"name\":" + jsonString(field.name) + ",\"type\":" + jsonString(field.type) + ",\"count\":" +
            std::to_string(field.count) + ",\"unit\":" + jsonString(field.unit) + ",\"start\":";
        // A random stream's start is its seed and counter, which are not numbers to show: null, as when initialize() failed.
        const auto* saved = start && field.type != "random" && index < start->fields.size() ? &start->fields[index] : nullptr;
        if (saved) {
            body += "[";
            for (std::size_t word = 0; word < saved->words.size(); ++word) {
                const double shown = saved->type == 0 || saved->type == 3 ? std::bit_cast<double>(saved->words[word])
                    : saved->type == 1 ? static_cast<double>(std::bit_cast<std::int64_t>(saved->words[word])) : static_cast<double>(saved->words[word]);
                body += std::string(word ? "," : "") + jsonNumber(shown);
            }
            body += "]";
        } else {
            body += "null";
        }
        body += ",\"line\":" + jsonLine(lineOf(field.line, field.name)) + "}";
    }
    body += "],\"clock\":";
    if (description.clockPeriod > 0 || !description.clockConstant.empty()) {
        const auto line = description.clockLine ? description.clockLine
            : kind == "cpp" ? firstLineMatching(lines, std::regex(R"(\bClock\b[^;]*[({]\s*this\s*,)")) : 0;
        body += "{\"period\":" + (clockPeriod > 0 ? jsonNumber(clockPeriod) : std::string("null")) + ",\"constant\":" +
            (description.clockConstant.empty() ? std::string("null") : jsonString(description.clockConstant)) + ",\"line\":" + jsonLine(line) + "}";
    } else {
        body += "null";
    }
    return finish();
}

void ProviderRuntime::shutdown() noexcept {
    if (shutdown_) return;
    shutdown_ = true;
    for (auto& [key, proc] : processes_) {
        if (proc) proc->shutdown();
    }
    processes_.clear();
}

bool planRequiresProviders(const ExecutionPlan& plan) {
    for (const auto& node : plan.nodes) {
        if (node.nodeProvider) return true;
        for (const auto& task : node.contributions) {
            if (task.implementation != ContributionImplementation::equation) return true;
        }
        for (const auto* tasks : {&node.algebraicTasks, &node.valueTerms}) for (const auto& task : *tasks) {
            if (task.implementation != ContributionImplementation::equation) return true;
        }
    }
    return false;
}

} // namespace konjugate
