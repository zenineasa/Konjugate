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
#ifdef _WIN32
#include <windows.h>
#include <io.h>
#include <process.h>
#include <fcntl.h>
using ssize_t = intptr_t;
using pid_t = int;
#else
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
#ifdef _WIN32
    const auto executablePath = providerDirectory / "provider.exe";
#else
    const auto executablePath = providerDirectory / "provider";
#endif

    if (!std::filesystem::exists(executablePath)) {
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
                sourcePath.string(),
                (sdkRoot / "src" / "providerWorker.cpp").string(),
                "/Fe" + executablePath.string()
            };
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
        }

        const auto result = runCppCompiler(compiler, arguments);
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
    void spawn(const ProviderConfiguration& config) {
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

        std::string commandLine;
        if (implementation_ == ContributionImplementation::pythonProvider) {
            std::string pythonExe = config.pythonInterpreter.empty() ? "python3" : config.pythonInterpreter;
            // The resolved python3 may be a distribution (Anaconda, a pyenv shim, ...) with no
            // knowledge of Konjugate's SDK; put it on PYTHONPATH explicitly rather than relying on
            // the package being installed into whichever interpreter is found. CreateProcessA below
            // passes a NULL environment block, which inherits this process's environment, so setting
            // it here (rather than building an explicit block) is sufficient.
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
                    : preparePythonProviderSource(task.providerSource, configuration_);
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
