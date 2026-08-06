/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "providerRuntime.hpp"
#include "relationshipProvider.pb.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <openssl/evp.h>
#include <stdexcept>
#include <string>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <unordered_map>
#include <vector>

namespace konjugate {
namespace {

using namespace konjugate::provider::protocol;

void writeFramed(int fd, const google::protobuf::MessageLite& message) {
    const auto size = static_cast<std::uint32_t>(message.ByteSizeLong());
    const unsigned char header[4] = {
        static_cast<unsigned char>((size >> 24) & 0xff),
        static_cast<unsigned char>((size >> 16) & 0xff),
        static_cast<unsigned char>((size >> 8) & 0xff),
        static_cast<unsigned char>(size & 0xff)
    };
    if (::write(fd, header, 4) != 4) {
        throw std::runtime_error("Failed to write frame header to provider process.");
    }
    std::string payload;
    if (!message.SerializeToString(&payload)) {
        throw std::runtime_error("Failed to serialize message for provider process.");
    }
    std::size_t written = 0;
    while (written < payload.size()) {
        const auto result = ::write(fd, payload.data() + written, payload.size() - written);
        if (result <= 0) throw std::runtime_error("Failed to write payload to provider process.");
        written += static_cast<std::size_t>(result);
    }
}

bool readExact(int fd, char* buffer, std::size_t size) {
    std::size_t readCount = 0;
    while (readCount < size) {
        const auto result = ::read(fd, buffer + readCount, size - readCount);
        if (result <= 0) return false;
        readCount += static_cast<std::size_t>(result);
    }
    return true;
}

bool readFramed(int fd, ProviderToEngine& message) {
    unsigned char header[4];
    if (!readExact(fd, reinterpret_cast<char*>(header), 4)) return false;
    const std::uint32_t size = (static_cast<std::uint32_t>(header[0]) << 24) |
                               (static_cast<std::uint32_t>(header[1]) << 16) |
                               (static_cast<std::uint32_t>(header[2]) << 8) |
                                static_cast<std::uint32_t>(header[3]);
    std::string payload(size, '\0');
    if (!readExact(fd, payload.data(), size)) return false;
    return message.ParseFromString(payload);
}

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
    std::string result(digestLength * 2, '0');
    for (unsigned int index = 0; index < digestLength; ++index) {
        result[2 * index] = hex[(digest[index] >> 4) & 0xf];
        result[2 * index + 1] = hex[digest[index] & 0xf];
    }
    return result;
}

// Resolves the local Apple Clang / GCC toolchain used to build inline C++ providers.
// A configured ProviderConfiguration::cppCompiler always takes precedence; this is a
// minimal first discovery step and does not yet cover Visual Studio/MSVC discovery on
// Windows or a compatible-options list, per the "Local toolchains and runtimes" design.
std::string resolveCppCompiler(const ProviderConfiguration& config) {
    if (!config.cppCompiler.empty()) return config.cppCompiler;
#ifdef __APPLE__
    std::string discovered;
    if (FILE* pipe = ::popen("xcrun -find clang++ 2>/dev/null", "r")) {
        std::array<char, 4096> buffer{};
        while (std::fgets(buffer.data(), static_cast<int>(buffer.size()), pipe)) discovered += buffer.data();
        ::pclose(pipe);
    }
    while (!discovered.empty() && (discovered.back() == '\n' || discovered.back() == '\r')) discovered.pop_back();
    if (!discovered.empty()) return discovered;
#endif
    return "c++";
}

#ifdef __APPLE__
// The xcrun-discovered toolchain clang++ (as opposed to the /usr/bin/c++ shim) does not
// locate the platform SDK on its own and needs an explicit sysroot to find <cstddef> etc.
std::string resolveAppleSdkSysroot() {
    std::string sdkPath;
    if (FILE* pipe = ::popen("xcrun --show-sdk-path 2>/dev/null", "r")) {
        std::array<char, 4096> buffer{};
        while (std::fgets(buffer.data(), static_cast<int>(buffer.size()), pipe)) sdkPath += buffer.data();
        ::pclose(pipe);
    }
    while (!sdkPath.empty() && (sdkPath.back() == '\n' || sdkPath.back() == '\r')) sdkPath.pop_back();
    return sdkPath;
}
#endif

struct CompilerRunResult {
    bool success = false;
    std::string diagnostics;
};

CompilerRunResult runCppCompiler(const std::string& compilerPath, const std::vector<std::string>& arguments) {
    int errorPipe[2];
    if (::pipe(errorPipe) != 0) throw std::runtime_error("Failed to create a pipe for the C++ provider build.");

    const pid_t pid = ::fork();
    if (pid < 0) throw std::runtime_error("Failed to fork the C++ provider build process.");

    if (pid == 0) {
        ::dup2(errorPipe[1], STDERR_FILENO);
        ::close(errorPipe[0]);
        ::close(errorPipe[1]);
        std::vector<const char*> argv;
        argv.push_back(compilerPath.c_str());
        for (const auto& argument : arguments) argv.push_back(argument.c_str());
        argv.push_back(nullptr);
        ::execvp(compilerPath.c_str(), const_cast<char* const*>(argv.data()));
        std::perror("execvp failed for the C++ provider build");
        ::_exit(127);
    }

    ::close(errorPipe[1]);
    std::string diagnostics;
    std::array<char, 4096> buffer{};
    ssize_t bytesRead = 0;
    while ((bytesRead = ::read(errorPipe[0], buffer.data(), buffer.size())) > 0) {
        diagnostics.append(buffer.data(), static_cast<std::size_t>(bytesRead));
    }
    ::close(errorPipe[0]);

    int status = 0;
    ::waitpid(pid, &status, 0);
    return {WIFEXITED(status) && WEXITSTATUS(status) == 0, diagnostics};
}

// Compiles an inline C++ relationship's source, together with the public SDK header and
// Konjugate's worker wrapper, into a native provider executable. The build is cached on
// disk by a hash of the source text, so repeated runs of the same inline implementation
// only pay the compile cost once. This is a minimal first build pipeline: it does not yet
// run declared conformance tests or record compiler identity/artifact hash in the project.
std::string buildCppProvider(const std::string& source, const ProviderConfiguration& config) {
    if (config.cppSdkPath.empty()) {
        throw std::runtime_error(
            "A C++ relationship provider requires providers.cpp.sdkPath to locate the Konjugate C++ SDK.");
    }

    const auto hash = sha256Hex(source);
    const std::filesystem::path buildRoot = config.buildDirectory.empty()
        ? std::filesystem::temp_directory_path() / "konjugateProviders"
        : std::filesystem::path(config.buildDirectory);
    const auto providerDirectory = buildRoot / hash;
    const auto executablePath = providerDirectory / "provider";

    if (!std::filesystem::exists(executablePath)) {
        std::filesystem::create_directories(providerDirectory);
        const auto sourcePath = providerDirectory / "relationship.cpp";
        std::ofstream sourceFile(sourcePath, std::ios::trunc);
        if (!sourceFile) throw std::runtime_error("Failed to write C++ provider source to " + sourcePath.string());
        sourceFile << source;
        sourceFile.close();

        const std::filesystem::path sdkRoot(config.cppSdkPath);
        std::vector<std::string> arguments = {"-std=c++20", "-O1", "-I" + (sdkRoot / "include").string()};
#ifdef __APPLE__
        if (const auto sysroot = resolveAppleSdkSysroot(); !sysroot.empty()) {
            arguments.push_back("-isysroot");
            arguments.push_back(sysroot);
        }
#endif
        arguments.push_back(sourcePath.string());
        arguments.push_back((sdkRoot / "src" / "providerWorker.cpp").string());
        arguments.push_back("-o");
        arguments.push_back(executablePath.string());

        const auto result = runCppCompiler(resolveCppCompiler(config), arguments);
        if (!result.success) {
            std::filesystem::remove(executablePath);
            throw std::runtime_error("Failed to compile the C++ relationship provider:\n" + result.diagnostics);
        }
    }

    return executablePath.string();
}

} // anonymous namespace

class ProviderProcess {
public:
    ProviderProcess(std::string processKey, ContributionImplementation impl,
                    std::string sourcePath, const ProviderConfiguration& config)
        : processKey_(std::move(processKey)), implementation_(impl), sourcePath_(std::move(sourcePath)) {
        spawn(config);
        performHandshake();
    }

    ~ProviderProcess() {
        shutdown();
    }

    void addInstance(std::uint64_t instanceId, const std::vector<CompiledBinding>& bindings) {
        auto* inst = initializeReq_.add_instances();
        inst->set_instance_id(instanceId);
        for (const auto& binding : bindings) {
            inst->add_input_keys(binding.symbol);
        }
        instanceIds_.push_back(instanceId);
    }

    void sendInitialization() {
        if (instanceIds_.empty()) return;
        EngineToProvider msg;
        *msg.mutable_initialize() = initializeReq_;
        writeFramed(stdinFd_, msg);

        ProviderToEngine resp;
        if (!readFramed(stdoutFd_, resp)) {
            throw std::runtime_error("Provider process " + processKey_ + " closed stdout during initialization.");
        }
        if (resp.has_failure()) {
            throw std::runtime_error("Provider process initialization failed: " + std::string(resp.failure().message()));
        }
        if (!resp.has_initialize()) {
            throw std::runtime_error("Unexpected response to initialization from provider process " + processKey_);
        }
    }

    std::vector<std::pair<std::uint64_t, double>> evaluateBatch(
        std::uint64_t sequence, double simulationTime, double stepSize,
        const std::vector<std::pair<std::uint64_t, std::vector<double>>>& evaluations) {
        // Multiple relationship instances sharing this worker may be evaluated from
        // different execution-plan threads in the same synchronization step; the pipe
        // round-trip below is not reentrant, so concurrent callers must be serialized here.
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

        writeFramed(stdinFd_, msg);

        ProviderToEngine resp;
        if (!readFramed(stdoutFd_, resp)) {
            throw std::runtime_error("Provider process " + processKey_ + " closed pipe during evaluateBatch.");
        }
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

    void shutdown() noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        if (pid_ <= 0) return;
        try {
            EngineToProvider msg;
            msg.mutable_shutdown();
            writeFramed(stdinFd_, msg);
            ProviderToEngine resp;
            readFramed(stdoutFd_, resp);
        } catch (...) {}

        if (stdinFd_ != -1) { ::close(stdinFd_); stdinFd_ = -1; }
        if (stdoutFd_ != -1) { ::close(stdoutFd_); stdoutFd_ = -1; }

        int status = 0;
        ::waitpid(pid_, &status, WNOHANG);
        pid_ = -1;
    }

private:
    void spawn(const ProviderConfiguration& config) {
        int inPipe[2];
        int outPipe[2];
        if (::pipe(inPipe) != 0 || ::pipe(outPipe) != 0) {
            throw std::runtime_error("Failed to create pipes for provider process.");
        }

        pid_ = ::fork();
        if (pid_ < 0) {
            throw std::runtime_error("Failed to fork provider process.");
        }

        if (pid_ == 0) {
            // Child process
            ::dup2(inPipe[0], STDIN_FILENO);
            ::dup2(outPipe[1], STDOUT_FILENO);
            ::close(inPipe[0]); ::close(inPipe[1]);
            ::close(outPipe[0]); ::close(outPipe[1]);

            if (implementation_ == ContributionImplementation::pythonProvider) {
                std::string pythonExe = config.pythonInterpreter.empty() ? "python3" : config.pythonInterpreter;
                std::vector<const char*> args;
                args.push_back(pythonExe.c_str());
                args.push_back("-m");
                args.push_back("konjugate");
                args.push_back(sourcePath_.c_str());
                args.push_back(nullptr);
                ::execvp(pythonExe.c_str(), const_cast<char* const*>(args.data()));
            } else {
                std::vector<const char*> args;
                args.push_back(sourcePath_.c_str());
                args.push_back(nullptr);
                ::execvp(sourcePath_.c_str(), const_cast<char* const*>(args.data()));
            }
            std::perror("execvp failed");
            ::_exit(127);
        }

        // Parent process
        ::close(inPipe[0]);
        ::close(outPipe[1]);
        stdinFd_ = inPipe[1];
        stdoutFd_ = outPipe[0];
    }

    void performHandshake() {
        EngineToProvider msg;
        auto* handshake = msg.mutable_handshake();
        handshake->set_protocol_version(1);
        handshake->set_provider_api_version(1);
        writeFramed(stdinFd_, msg);

        ProviderToEngine resp;
        if (!readFramed(stdoutFd_, resp)) {
            throw std::runtime_error("Provider process " + processKey_ + " failed handshake (no response).");
        }
        if (resp.has_failure()) {
            throw std::runtime_error("Provider process handshake failed: " + std::string(resp.failure().message()));
        }
        if (!resp.has_handshake()) {
            throw std::runtime_error("Unexpected response to handshake from provider process " + processKey_);
        }
    }

    std::string processKey_;
    ContributionImplementation implementation_;
    std::string sourcePath_;
    pid_t pid_ = -1;
    int stdinFd_ = -1;
    int stdoutFd_ = -1;
    InitializeRequest initializeReq_;
    std::vector<std::uint64_t> instanceIds_;
    std::mutex mutex_;
};

ProviderRuntime::ProviderRuntime(ProviderConfiguration configuration)
    : configuration_(std::move(configuration)) {}

ProviderRuntime::~ProviderRuntime() {
    shutdown();
}

void ProviderRuntime::initialize(const ExecutionPlan& plan) {
    if (initialized_) return;

    for (const auto& node : plan.nodes) {
        for (const auto& task : node.contributions) {
            if (task.implementation == ContributionImplementation::equation) continue;

            const std::string key = (task.implementation == ContributionImplementation::pythonProvider ? "py:" : "cpp:") + task.providerSource;
            auto& proc = processes_[key];
            if (!proc) {
                const std::string launchPath = task.implementation == ContributionImplementation::cppProvider
                    ? buildCppProvider(task.providerSource, configuration_)
                    : task.providerSource;
                proc = std::make_unique<ProviderProcess>(key, task.implementation, launchPath, configuration_);
            }

            const std::uint64_t instanceId = nextInstanceId_++;
            taskProcessKeys_[task.sourceId] = key;
            taskInstanceIds_[task.sourceId] = instanceId;

            proc->addInstance(instanceId, task.bindings);
        }
    }

    for (auto& [key, proc] : processes_) {
        proc->sendInitialization();
    }

    initialized_ = true;
}

double ProviderRuntime::evaluate(const ContributionTask& task,
                                const std::vector<double>& inputs,
                                double simulationTime,
                                double stepSize) {
    const auto keyIt = taskProcessKeys_.find(task.sourceId);
    if (keyIt == taskProcessKeys_.end()) {
        throw std::runtime_error("Task not registered in ProviderRuntime.");
    }
    const auto instIt = taskInstanceIds_.find(task.sourceId);
    auto& proc = processes_.at(keyIt->second);

    std::vector<std::pair<std::uint64_t, std::vector<double>>> evaluations;
    evaluations.emplace_back(instIt->second, inputs);

    const auto results = proc->evaluateBatch(task.sequence, simulationTime, stepSize, evaluations);
    if (results.empty()) {
        throw std::runtime_error("No contribution returned from provider evaluation.");
    }
    return results.front().second;
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
        for (const auto& task : node.contributions) {
            if (task.implementation != ContributionImplementation::equation) return true;
        }
    }
    return false;
}

} // namespace konjugate
