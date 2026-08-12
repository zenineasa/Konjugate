/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "providerRuntime.hpp"
#include "relationshipProvider.pb.h"
#include "konjugate/providerSharedMemoryChannel.hpp"
#include "konjugate/providerInProcessAbi.hpp"

#include <algorithm>
#include <array>
#include <atomic>
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
#include <span>
#include <stdexcept>
#include <string>
#ifdef _WIN32
#include <windows.h>
#include <io.h>
#include <process.h>
#include <fcntl.h>
using ssize_t = intptr_t;
using pid_t = int;
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

#ifdef _WIN32
CompilerRunResult runCppCompiler(const std::string& compilerPath, const std::vector<std::string>& arguments) {
    std::string commandLine = "\"" + compilerPath + "\"";
    for (const auto& arg : arguments) {
        commandLine += " \"" + arg + "\"";
    }

    HANDLE hChildStd_OUT_Rd = NULL;
    HANDLE hChildStd_OUT_Wr = NULL;
    SECURITY_ATTRIBUTES saAttr;
    saAttr.nLength = sizeof(SECURITY_ATTRIBUTES);
    saAttr.bInheritHandle = TRUE;
    saAttr.lpSecurityDescriptor = NULL;

    if (!CreatePipe(&hChildStd_OUT_Rd, &hChildStd_OUT_Wr, &saAttr, 0)) {
        throw std::runtime_error("Failed to create pipe for C++ provider build.");
    }

    if (!SetHandleInformation(hChildStd_OUT_Rd, HANDLE_FLAG_INHERIT, 0)) {
        CloseHandle(hChildStd_OUT_Rd);
        CloseHandle(hChildStd_OUT_Wr);
        throw std::runtime_error("Failed to set handle information for C++ provider build.");
    }

    PROCESS_INFORMATION piProcInfo;
    STARTUPINFOA siStartInfo;
    ZeroMemory(&piProcInfo, sizeof(PROCESS_INFORMATION));
    ZeroMemory(&siStartInfo, sizeof(STARTUPINFOA));
    siStartInfo.cb = sizeof(STARTUPINFOA);
    siStartInfo.hStdError = hChildStd_OUT_Wr;
    siStartInfo.hStdOutput = hChildStd_OUT_Wr;
    siStartInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    siStartInfo.dwFlags |= STARTF_USESTDHANDLES;

    std::vector<char> cmdLineBuf(commandLine.begin(), commandLine.end());
    cmdLineBuf.push_back('\0');

    BOOL bSuccess = CreateProcessA(
        NULL,
        cmdLineBuf.data(),
        NULL,
        NULL,
        TRUE,
        0,
        NULL,
        NULL,
        &siStartInfo,
        &piProcInfo
    );

    CloseHandle(hChildStd_OUT_Wr);

    if (!bSuccess) {
        DWORD err = GetLastError();
        CloseHandle(hChildStd_OUT_Rd);
        if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) {
            throw std::runtime_error("C++ compiler executable not found: \"" + compilerPath +
                "\". Please install a C++ compiler (MSVC cl.exe, MinGW g++, or Clang) or configure the toolchain path in Provider Toolchains.");
        }
        throw std::runtime_error("Failed to spawn the C++ provider build process: " + std::to_string(err));
    }

    std::string diagnostics;
    std::array<char, 4096> buffer{};
    DWORD bytesRead = 0;
    while (ReadFile(hChildStd_OUT_Rd, buffer.data(), static_cast<DWORD>(buffer.size()), &bytesRead, NULL) && bytesRead > 0) {
        diagnostics.append(buffer.data(), static_cast<std::size_t>(bytesRead));
    }
    CloseHandle(hChildStd_OUT_Rd);

    WaitForSingleObject(piProcInfo.hProcess, INFINITE);
    DWORD exitCode = 0;
    GetExitCodeProcess(piProcInfo.hProcess, &exitCode);

    CloseHandle(piProcInfo.hProcess);
    CloseHandle(piProcInfo.hThread);

    return {exitCode == 0, diagnostics};
}
#else
CompilerRunResult runCppCompiler(const std::string& compilerPath, const std::vector<std::string>& arguments) {
    int errorPipe[2];
    if (::pipe(errorPipe) != 0) throw std::runtime_error("Failed to create a pipe for the C++ provider build.");

    const pid_t pid = ::fork();
    if (pid < 0) throw std::runtime_error("Failed to fork the C++ provider build process.");

    if (pid == 0) {
        ::dup2(errorPipe[1], STDERR_FILENO);
        ::dup2(errorPipe[1], STDOUT_FILENO);
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
#endif

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

#ifdef _WIN32
struct MsvcEnvironmentFlags {
    std::vector<std::string> includeFlags;
    std::vector<std::string> libpathFlags;
};

MsvcEnvironmentFlags getMsvcEnvironmentFlags(const std::string& compilerPath) {
    MsvcEnvironmentFlags result;
    std::vector<std::filesystem::path> includeDirs;
    std::vector<std::filesystem::path> libDirs;

    try {
        std::filesystem::path p(compilerPath);
        if (p.is_absolute() && std::filesystem::exists(p)) {
            auto msvcRoot = p.parent_path();
            for (int i = 0; i < 3 && msvcRoot.has_parent_path(); ++i) {
                msvcRoot = msvcRoot.parent_path();
            }
            auto inc = msvcRoot / "include";
            if (std::filesystem::exists(inc / "cstddef")) {
                includeDirs.push_back(inc);
            }
            auto lib = msvcRoot / "lib" / "x64";
            if (std::filesystem::exists(lib)) {
                libDirs.push_back(lib);
            }
        }
    } catch (...) {}

    if (includeDirs.empty() || libDirs.empty()) {
        const std::filesystem::path vsBases[] = {
            "C:\\Program Files\\Microsoft Visual Studio",
            "C:\\Program Files (x86)\\Microsoft Visual Studio"
        };
        for (const auto& vsBase : vsBases) {
            if (!std::filesystem::exists(vsBase)) continue;
            try {
                for (const auto& yearEntry : std::filesystem::directory_iterator(vsBase)) {
                    if (!yearEntry.is_directory()) continue;
                    for (const auto& edEntry : std::filesystem::directory_iterator(yearEntry.path())) {
                        if (!edEntry.is_directory()) continue;
                        auto msvcTools = edEntry.path() / "VC" / "Tools" / "MSVC";
                        if (std::filesystem::exists(msvcTools)) {
                            for (const auto& verEntry : std::filesystem::directory_iterator(msvcTools)) {
                                if (!verEntry.is_directory()) continue;
                                auto inc = verEntry.path() / "include";
                                auto lib = verEntry.path() / "lib" / "x64";
                                if (includeDirs.empty() && std::filesystem::exists(inc / "cstddef")) {
                                    includeDirs.push_back(inc);
                                }
                                if (libDirs.empty() && std::filesystem::exists(lib)) {
                                    libDirs.push_back(lib);
                                }
                                if (!includeDirs.empty() && !libDirs.empty()) break;
                            }
                        }
                        if (!includeDirs.empty() && !libDirs.empty()) break;
                    }
                    if (!includeDirs.empty() && !libDirs.empty()) break;
                }
            } catch (...) {}
            if (!includeDirs.empty() && !libDirs.empty()) break;
        }
    }

    const std::filesystem::path winKitsIncludeBases[] = {
        "C:\\Program Files (x86)\\Windows Kits\\10\\Include",
        "C:\\Program Files\\Windows Kits\\10\\Include"
    };
    for (const auto& winKitBase : winKitsIncludeBases) {
        if (!std::filesystem::exists(winKitBase)) continue;
        try {
            std::filesystem::path latestSdk;
            for (const auto& sdkEntry : std::filesystem::directory_iterator(winKitBase)) {
                if (sdkEntry.is_directory()) {
                    auto ucrt = sdkEntry.path() / "ucrt";
                    if (std::filesystem::exists(ucrt / "stdlib.h")) {
                        latestSdk = sdkEntry.path();
                    }
                }
            }
            if (!latestSdk.empty()) {
                if (std::filesystem::exists(latestSdk / "ucrt")) includeDirs.push_back(latestSdk / "ucrt");
                if (std::filesystem::exists(latestSdk / "um")) includeDirs.push_back(latestSdk / "um");
                if (std::filesystem::exists(latestSdk / "shared")) includeDirs.push_back(latestSdk / "shared");

                std::filesystem::path libBase = winKitBase.parent_path() / "Lib" / latestSdk.filename();
                if (std::filesystem::exists(libBase)) {
                    if (std::filesystem::exists(libBase / "ucrt" / "x64")) libDirs.push_back(libBase / "ucrt" / "x64");
                    if (std::filesystem::exists(libBase / "um" / "x64")) libDirs.push_back(libBase / "um" / "x64");
                }
                break;
            }
        } catch (...) {}
    }

    for (const auto& dir : includeDirs) {
        result.includeFlags.push_back("/I" + dir.string());
    }
    for (const auto& dir : libDirs) {
        result.libpathFlags.push_back("/LIBPATH:" + dir.string());
    }
    return result;
}
#endif

// executable pairs the inline source with providerWorker.cpp into a standalone process (used
// by the pipe and shared-memory transports); sharedLibrary pairs it with
// providerInProcessShim.cpp into a dlopen()'d/LoadLibrary()'d plugin (used by the in-process
// transport). Both live under the same source-hash build directory, just as different
// filenames, so choosing a different mode for the same source never collides with a
// previously-built artifact of the other kind.
enum class CppProviderArtifactKind { executable, sharedLibrary };

// Compiles an inline C++ relationship's source, together with the public SDK header and one of
// Konjugate's glue wrappers, into a native provider artifact. The build is cached on disk by a
// hash of the source text, so repeated runs of the same inline implementation only pay the
// compile cost once. This is a minimal first build pipeline: it does not yet run declared
// conformance tests or record compiler identity/artifact hash in the project.
std::string buildCppProvider(const std::string& source, const ProviderConfiguration& config, CppProviderArtifactKind kind) {
    if (config.cppSdkPath.empty()) {
        throw std::runtime_error(
            "A C++ relationship provider requires providers.cpp.sdkPath to locate the Konjugate C++ SDK.");
    }

    const auto hash = sha256Hex(source);
    const std::filesystem::path buildRoot = config.buildDirectory.empty()
        ? std::filesystem::temp_directory_path() / "konjugateProviders"
        : std::filesystem::path(config.buildDirectory);
    const auto providerDirectory = buildRoot / hash;
    const bool sharedLibrary = kind == CppProviderArtifactKind::sharedLibrary;
    const std::string glueFile = sharedLibrary ? "providerInProcessShim.cpp" : "providerWorker.cpp";
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

        const std::filesystem::path sdkRoot(config.cppSdkPath);
        const std::string compiler = resolveCppCompiler(config);

        std::string compilerLower = compiler;
        std::transform(compilerLower.begin(), compilerLower.end(), compilerLower.begin(), ::tolower);
        const bool isMsvc = (compilerLower.find("cl.exe") != std::string::npos || compilerLower == "cl");

        std::vector<std::string> arguments;
        if (isMsvc) {
            arguments = {
                "/std:c++20",
                "/O1",
                "/EHsc",
                "/nologo",
                "/I" + (sdkRoot / "include").string(),
            };
            if (sharedLibrary) arguments.push_back("/LD");
            arguments.push_back(sourcePath.string());
            arguments.push_back((sdkRoot / "src" / glueFile).string());
            arguments.push_back("/Fe" + artifactPath.string());
#ifdef _WIN32
            auto msvcFlags = getMsvcEnvironmentFlags(compiler);
            arguments.insert(arguments.end(), msvcFlags.includeFlags.begin(), msvcFlags.includeFlags.end());
            if (!msvcFlags.libpathFlags.empty()) {
                arguments.push_back("/link");
                arguments.insert(arguments.end(), msvcFlags.libpathFlags.begin(), msvcFlags.libpathFlags.end());
            }
#endif
        } else {
            arguments = {"-std=c++20", "-O1", "-I" + (sdkRoot / "include").string()};
            if (sharedLibrary) {
                arguments.push_back("-shared");
                arguments.push_back("-fPIC");
            }
#ifndef _WIN32
            if (!sharedLibrary) {
                // Only providerWorker.cpp's shared-memory fast path uses std::thread and POSIX
                // semaphores; the in-process shim needs neither.
                arguments.push_back("-pthread");
            }
#endif
#ifdef __APPLE__
            if (const auto sysroot = resolveAppleSdkSysroot(); !sysroot.empty()) {
                arguments.push_back("-isysroot");
                arguments.push_back(sysroot);
            }
#endif
            arguments.push_back(sourcePath.string());
            arguments.push_back((sdkRoot / "src" / glueFile).string());
            arguments.push_back("-o");
            arguments.push_back(artifactPath.string());
#if !defined(_WIN32) && !defined(__APPLE__)
            if (!sharedLibrary) {
                // shm_open/sem_open historically require linking librt on Linux (folded into
                // libc only since glibc 2.34); passing -lrt is harmless on newer glibc too.
                arguments.push_back("-lrt");
            }
#endif
        }

        const auto result = runCppCompiler(compiler, arguments);
        if (!result.success) {
            std::filesystem::remove(artifactPath);
            throw std::runtime_error("Failed to compile the C++ relationship provider:\n" + result.diagnostics);
        }
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
};

// Owns one spawned provider process's control pipe: spawn, protocol handshake, the initialize
// round trip, the pipe evaluateBatch round trip (the hot path for PipeProviderBackend; used by
// SharedMemoryProviderBackend only for handshake/initialize/shutdown, never for evaluation),
// and shutdown. Both backends below compose one of these rather than duplicating process
// lifecycle handling.
class ProviderControlChannel {
public:
    ProviderControlChannel(std::string processKey, ContributionImplementation implementation,
                           std::string sourcePath, const ProviderConfiguration& config,
                           std::vector<std::pair<std::string, std::string>> extraEnvironment = {})
        : processKey_(std::move(processKey)), implementation_(implementation), sourcePath_(std::move(sourcePath)) {
        spawn(config, extraEnvironment);
        performHandshake();
    }

    ~ProviderControlChannel() { close(); }
    ProviderControlChannel(const ProviderControlChannel&) = delete;
    ProviderControlChannel& operator=(const ProviderControlChannel&) = delete;

    const std::string& processKey() const noexcept { return processKey_; }

    void sendInitialize(const InitializeRequest& request) {
        if (request.instances_size() == 0) return;
        EngineToProvider msg;
        *msg.mutable_initialize() = request;
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

    void close() noexcept {
#ifdef _WIN32
        if (hProcess_ == NULL) return;
#else
        if (pid_ <= 0) return;
#endif
        try {
            EngineToProvider msg;
            msg.mutable_shutdown();
            writeFramed(stdinFd_, msg);
            ProviderToEngine resp;
            readFramed(stdoutFd_, resp);
        } catch (...) {}

        if (stdinFd_ != -1) { ::close(stdinFd_); stdinFd_ = -1; }
        if (stdoutFd_ != -1) { ::close(stdoutFd_); stdoutFd_ = -1; }

#ifdef _WIN32
        DWORD waitResult = WaitForSingleObject(hProcess_, 1000);
        if (waitResult == WAIT_TIMEOUT) {
            TerminateProcess(hProcess_, 1);
        }
        CloseHandle(hProcess_);
        hProcess_ = NULL;
        pid_ = -1;
#else
        int status = 0;
        ::waitpid(pid_, &status, WNOHANG);
        pid_ = -1;
#endif
    }

private:
#ifdef _WIN32
    void spawn(const ProviderConfiguration& config, const std::vector<std::pair<std::string, std::string>>& extraEnvironment) {
        HANDLE hChildStd_IN_Rd = NULL;
        HANDLE hChildStd_IN_Wr = NULL;
        HANDLE hChildStd_OUT_Rd = NULL;
        HANDLE hChildStd_OUT_Wr = NULL;

        SECURITY_ATTRIBUTES saAttr;
        saAttr.nLength = sizeof(SECURITY_ATTRIBUTES);
        saAttr.bInheritHandle = TRUE;
        saAttr.lpSecurityDescriptor = NULL;

        if (!CreatePipe(&hChildStd_OUT_Rd, &hChildStd_OUT_Wr, &saAttr, 0)) {
            throw std::runtime_error("Failed to create stdout pipe for provider process.");
        }
        if (!SetHandleInformation(hChildStd_OUT_Rd, HANDLE_FLAG_INHERIT, 0)) {
            CloseHandle(hChildStd_OUT_Rd);
            CloseHandle(hChildStd_OUT_Wr);
            throw std::runtime_error("Failed to set handle info for stdout pipe.");
        }

        if (!CreatePipe(&hChildStd_IN_Rd, &hChildStd_IN_Wr, &saAttr, 0)) {
            CloseHandle(hChildStd_OUT_Rd);
            CloseHandle(hChildStd_OUT_Wr);
            throw std::runtime_error("Failed to create stdin pipe for provider process.");
        }
        if (!SetHandleInformation(hChildStd_IN_Wr, HANDLE_FLAG_INHERIT, 0)) {
            CloseHandle(hChildStd_OUT_Rd);
            CloseHandle(hChildStd_OUT_Wr);
            CloseHandle(hChildStd_IN_Rd);
            CloseHandle(hChildStd_IN_Wr);
            throw std::runtime_error("Failed to set handle info for stdin pipe.");
        }

        // CreateProcessA below passes a NULL environment block, which inherits this process's
        // environment, so setting variables here (rather than building an explicit block) is
        // sufficient for both PYTHONPATH and any shared-memory channel names a backend needs.
        for (const auto& [name, value] : extraEnvironment) {
            SetEnvironmentVariableA(name.c_str(), value.c_str());
        }

        std::string commandLine;
        if (implementation_ == ContributionImplementation::pythonProvider) {
            std::string pythonExe = config.pythonInterpreter.empty() ? "python3" : config.pythonInterpreter;
            // The resolved python3 may be a distribution (Anaconda, a pyenv shim, ...) with no
            // knowledge of Konjugate's SDK; put it on PYTHONPATH explicitly rather than relying on
            // the package being installed into whichever interpreter is found.
            if (!config.pythonSdkPath.empty()) {
                char existingPythonPath[32768];
                const auto existingLength = GetEnvironmentVariableA("PYTHONPATH", existingPythonPath, sizeof(existingPythonPath));
                const std::string pythonPath = existingLength > 0
                    ? config.pythonSdkPath + ";" + std::string(existingPythonPath, existingLength) : config.pythonSdkPath;
                SetEnvironmentVariableA("PYTHONPATH", pythonPath.c_str());
            }
            commandLine = "\"" + pythonExe + "\" -m konjugate \"" + sourcePath_ + "\"";
        } else {
            commandLine = "\"" + sourcePath_ + "\"";
        }

        BOOL bSuccess = FALSE;
        PROCESS_INFORMATION piProcInfo;
        ZeroMemory(&piProcInfo, sizeof(PROCESS_INFORMATION));

        auto tryCreateProcess = [&](const std::string& cmd) -> BOOL {
            STARTUPINFOA siStartInfo;
            ZeroMemory(&siStartInfo, sizeof(STARTUPINFOA));
            siStartInfo.cb = sizeof(STARTUPINFOA);
            siStartInfo.hStdInput = hChildStd_IN_Rd;
            siStartInfo.hStdOutput = hChildStd_OUT_Wr;
            siStartInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            siStartInfo.dwFlags |= STARTF_USESTDHANDLES;

            std::vector<char> cmdLineBuf(cmd.begin(), cmd.end());
            cmdLineBuf.push_back('\0');

            return CreateProcessA(
                NULL,
                cmdLineBuf.data(),
                NULL,
                NULL,
                TRUE,
                0,
                NULL,
                NULL,
                &siStartInfo,
                &piProcInfo
            );
        };

        bSuccess = tryCreateProcess(commandLine);
        if (!bSuccess && implementation_ == ContributionImplementation::pythonProvider) {
            std::string pythonExe = config.pythonInterpreter.empty() ? "python3" : config.pythonInterpreter;
            if (pythonExe == "python3") {
                std::string fallbackCommandLine = "\"python\" -m konjugate \"" + sourcePath_ + "\"";
                bSuccess = tryCreateProcess(fallbackCommandLine);
            }
        }

        CloseHandle(hChildStd_IN_Rd);
        CloseHandle(hChildStd_OUT_Wr);

        if (!bSuccess) {
            CloseHandle(hChildStd_IN_Wr);
            CloseHandle(hChildStd_OUT_Rd);
            throw std::runtime_error("Failed to spawn provider process: " + std::to_string(GetLastError()));
        }

        CloseHandle(piProcInfo.hThread);

        stdinFd_ = _open_osfhandle(reinterpret_cast<intptr_t>(hChildStd_IN_Wr), _O_WRONLY | _O_BINARY);
        stdoutFd_ = _open_osfhandle(reinterpret_cast<intptr_t>(hChildStd_OUT_Rd), _O_RDONLY | _O_BINARY);
        hProcess_ = piProcInfo.hProcess;
        pid_ = static_cast<pid_t>(piProcInfo.dwProcessId);
    }
#else
    void spawn(const ProviderConfiguration& config, const std::vector<std::pair<std::string, std::string>>& extraEnvironment) {
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

            for (const auto& [name, value] : extraEnvironment) ::setenv(name.c_str(), value.c_str(), 1);

            if (implementation_ == ContributionImplementation::pythonProvider) {
                std::string pythonExe = config.pythonInterpreter.empty() ? "python3" : config.pythonInterpreter;
                // The resolved python3 may be a distribution (Anaconda, a pyenv shim, ...) with no
                // knowledge of Konjugate's SDK; put it on the child's PYTHONPATH explicitly rather
                // than relying on the package being installed into whichever interpreter is found.
                if (!config.pythonSdkPath.empty()) {
                    const char* existingPythonPath = std::getenv("PYTHONPATH");
                    const std::string pythonPath = existingPythonPath && *existingPythonPath
                        ? config.pythonSdkPath + ":" + existingPythonPath : config.pythonSdkPath;
                    ::setenv("PYTHONPATH", pythonPath.c_str(), 1);
                }
                std::vector<const char*> args;
                args.push_back(pythonExe.c_str());
                args.push_back("-m");
                args.push_back("konjugate");
                args.push_back(sourcePath_.c_str());
                args.push_back(nullptr);
                ::execvp(pythonExe.c_str(), const_cast<char* const*>(args.data()));
                if (pythonExe == "python3") {
                    // No override was configured and "python3" itself was not found; some
                    // platforms only provide the interpreter as "python".
                    args[0] = "python";
                    ::execvp("python", const_cast<char* const*>(args.data()));
                }
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
#endif

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
#ifdef _WIN32
    HANDLE hProcess_ = NULL;
#endif
    int stdinFd_ = -1;
    int stdoutFd_ = -1;
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

namespace {

// Each tier is only attempted for cppProvider tasks in its matching (or a higher) execution
// mode; any construction failure — including a mode simply not being available on this
// platform — falls back down the chain (inProcess -> sharedMemoryWorker -> pipeWorker) so a
// single unsupported/misconfigured host never blocks a whole run. Python providers always use
// the pipe backend: neither faster transport has a story for an interpreted language.
std::unique_ptr<ProviderBackend> createProviderBackend(const std::string& key, ContributionImplementation implementation,
                                                        const std::string& providerSource, const ProviderConfiguration& config) {
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
    const auto launchPath = implementation == ContributionImplementation::cppProvider
        ? buildCppProvider(providerSource, config, CppProviderArtifactKind::executable)
        : preparePythonProviderSource(providerSource, config);
    return std::make_unique<PipeProviderBackend>(key, implementation, launchPath, config);
}

} // namespace

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

            const std::string key = providerProcessKey(task);
            auto& proc = processes_[key];
            if (!proc) {
                proc = createProviderBackend(key, task.implementation, task.providerSource, configuration_);
            }

            const std::uint64_t instanceId = nextInstanceId_++;
            taskInstanceIds_[task.sourceId] = instanceId;

            proc->addInstance(instanceId, task.bindings);
        }
    }

    for (auto& [key, proc] : processes_) {
        proc->sendInitialization();
    }

    initialized_ = true;
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
