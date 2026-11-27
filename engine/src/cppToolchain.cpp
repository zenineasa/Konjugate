/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Shared C++ compiler discovery and native-artifact build logic, extracted from
// providerRuntime.cpp's buildCppProvider() (a pure extraction -- same flags, same behavior) so a
// second caller (the buildSharedLibrary CLI command, used for FMU export) can build a native
// shared library without duplicating this platform-specific logic. providerRuntime.cpp's own
// build path now calls into this file too.

#include "cppToolchain.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <stdexcept>
#include <system_error>
#include <vector>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
using ssize_t = intptr_t;
using pid_t = int;
#else
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace konjugate::cppToolchain {

std::string resolveCompiler(const std::string& overrideCompiler) {
    if (!overrideCompiler.empty()) return overrideCompiler;
#ifdef __APPLE__
    std::string discovered;
    // Fixed, hardcoded command string; no user-controlled input reaches the shell here.
    if (FILE* pipe = ::popen("xcrun -find clang++ 2>/dev/null", "r")) { // NOLINT(bugprone-command-processor)
        std::array<char, 4096> buffer{};
        while (std::fgets(buffer.data(), static_cast<int>(buffer.size()), pipe)) discovered += buffer.data();
        ::pclose(pipe);
    }
    while (!discovered.empty() && (discovered.back() == '\n' || discovered.back() == '\r')) discovered.pop_back();
    if (!discovered.empty()) return discovered;
#endif
    return "c++";
}

namespace {

#ifdef __APPLE__
// The xcrun-discovered toolchain clang++ (as opposed to the /usr/bin/c++ shim) does not
// locate the platform SDK on its own and needs an explicit sysroot to find <cstddef> etc.
std::string resolveAppleSdkSysroot() {
    std::string sdkPath;
    // Fixed, hardcoded command string; no user-controlled input reaches the shell here.
    if (FILE* pipe = ::popen("xcrun --show-sdk-path 2>/dev/null", "r")) { // NOLINT(bugprone-command-processor)
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
// workingDirectory is where the compiler process runs: MSVC's cl.exe writes its intermediate .obj files
// into its working directory (there is no /Fo here), so inheriting the host process's directory breaks
// whenever that is not writable -- e.g. C:\Windows\System32 when launched from an MSIX package, or
// C:\Program Files\Konjugate from a shortcut.
CompilerRunResult runCppCompiler(const std::string& compilerPath, const std::vector<std::string>& arguments,
                                 const std::filesystem::path& workingDirectory) {
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
        throw std::runtime_error("Failed to create pipe for the native build.");
    }

    if (!SetHandleInformation(hChildStd_OUT_Rd, HANDLE_FLAG_INHERIT, 0)) {
        CloseHandle(hChildStd_OUT_Rd);
        CloseHandle(hChildStd_OUT_Wr);
        throw std::runtime_error("Failed to set handle information for the native build.");
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
    const std::string workingDirectoryString = workingDirectory.string();

    BOOL bSuccess = CreateProcessA(
        NULL,
        cmdLineBuf.data(),
        NULL,
        NULL,
        TRUE,
        0,
        NULL,
        workingDirectoryString.empty() ? NULL : workingDirectoryString.c_str(),
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
        throw std::runtime_error("Failed to spawn the native build process: " + std::to_string(err));
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
// gcc/clang write no intermediate files when compiling and linking in one step, so the working directory
// only matters on Windows.
CompilerRunResult runCppCompiler(const std::string& compilerPath, const std::vector<std::string>& arguments,
                                 const std::filesystem::path& /*workingDirectory*/) {
    int errorPipe[2];
    if (::pipe(errorPipe) != 0) throw std::runtime_error("Failed to create a pipe for the native build.");

    const pid_t pid = ::fork();
    if (pid < 0) throw std::runtime_error("Failed to fork the native build process.");

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
        std::perror("execvp failed for the native build");
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

} // namespace

void buildNativeArtifact(const std::filesystem::path& sourcePathArgument, const std::filesystem::path& gluePathArgument,
                          const std::filesystem::path& includeDirectoryArgument, const std::filesystem::path& artifactPathArgument,
                          bool sharedLibrary, const std::string& compilerOverride, const std::string& failureContext,
                          bool needsDynamicLoaderLibrary) {
    const std::string compiler = resolveCompiler(compilerOverride);

    // The compiler runs in the artifact's directory (see runCppCompiler), so every path handed to it
    // must be absolute -- a relative one would silently start resolving against that directory instead.
    const auto sourcePath = std::filesystem::absolute(sourcePathArgument);
    const auto gluePath = std::filesystem::absolute(gluePathArgument);
    const auto artifactPath = std::filesystem::absolute(artifactPathArgument);
    const auto includeDirectory = includeDirectoryArgument.empty() ? includeDirectoryArgument : std::filesystem::absolute(includeDirectoryArgument);

    std::string compilerLower = compiler;
    std::transform(compilerLower.begin(), compilerLower.end(), compilerLower.begin(), ::tolower);
    const bool isMsvc = (compilerLower.find("cl.exe") != std::string::npos || compilerLower == "cl");

    std::vector<std::string> arguments;
    if (isMsvc) {
        arguments = {"/std:c++20", "/O1", "/EHsc", "/nologo"};
        if (!includeDirectory.empty()) arguments.push_back("/I" + includeDirectory.string());
        if (sharedLibrary) arguments.push_back("/LD");
        arguments.push_back(sourcePath.string());
        arguments.push_back(gluePath.string());
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
        // -ffp-contract=on, as engine/CMakeLists.txt builds the engine: GCC's default fuses multiply-adds at -O2 but not at -O1,
        // so without it an FMU or provider built here rounds differently from the engine on aarch64 Linux.
        arguments = {"-std=c++20", "-O1", "-ffp-contract=on"};
        if (!includeDirectory.empty()) arguments.push_back("-I" + includeDirectory.string());
        if (sharedLibrary) {
            arguments.push_back("-shared");
            arguments.push_back("-fPIC");
        }
#ifndef _WIN32
        if (!sharedLibrary) {
            // Only providerWorker.cpp's shared-memory fast path uses std::thread and POSIX
            // semaphores; the in-process shim (and every other sharedLibrary caller) needs neither.
            arguments.push_back("-pthread");
        }
#endif
#ifdef __APPLE__
        if (const auto sysroot = resolveAppleSdkSysroot(); !sysroot.empty()) {
            arguments.push_back("-isysroot");
            arguments.push_back(sysroot);
        }
        arguments.push_back("-mmacosx-version-min=11.0");
#endif
        arguments.push_back(sourcePath.string());
        arguments.push_back(gluePath.string());
        arguments.push_back("-o");
        arguments.push_back(artifactPath.string());
#if !defined(_WIN32) && !defined(__APPLE__)
        if (!sharedLibrary) {
            // shm_open/sem_open historically require linking librt on Linux (folded into
            // libc only since glibc 2.34); passing -lrt is harmless on newer glibc too.
            arguments.push_back("-lrt");
        }
        if (needsDynamicLoaderLibrary) arguments.push_back("-ldl");
#endif
    }

    const auto result = runCppCompiler(compiler, arguments, artifactPath.parent_path());
    if (isMsvc) {
        // cl.exe leaves one .obj per source file next to where it ran; nothing needs them afterwards.
        for (const auto* source : {&sourcePath, &gluePath}) {
            std::error_code ignored;
            std::filesystem::remove(artifactPath.parent_path() / source->stem().concat(".obj"), ignored);
        }
    }
    if (!result.success) {
        std::filesystem::remove(artifactPath);
        throw std::runtime_error("Failed to compile " + failureContext + ":\n" + result.diagnostics);
    }
}

// ---- A shared library built from someone else's sources (docs/proposals/sourceFmuImport.md) ---------------------------------

namespace {

constexpr std::size_t stepOutputLimit = 256 * 1024;

bool isMsvcCompiler(const std::string& compiler) {
    std::string lower = std::filesystem::path(compiler).filename().string();
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    return lower == "cl.exe" || lower == "cl";
}

void keepOutput(std::string& output, const char* data, std::size_t size, bool& truncated) {
    if (output.size() < stepOutputLimit) output.append(data, std::min(size, stepOutputLimit - output.size()));
    if (output.size() >= stepOutputLimit) truncated = true;
}

struct LimitedRunResult {
    bool success = false;
    bool timedOut = false;
    std::string output;
};

#ifdef _WIN32
LimitedRunResult runWithLimits(const std::string& compilerPath, const std::vector<std::string>& arguments,
                               const std::filesystem::path& workingDirectory, std::chrono::steady_clock::time_point deadline) {
    std::string commandLine = "\"" + compilerPath + "\"";
    for (const auto& argument : arguments) commandLine += " \"" + argument + "\"";
    HANDLE readEnd = NULL;
    HANDLE writeEnd = NULL;
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
    if (!CreatePipe(&readEnd, &writeEnd, &attributes, 0)) throw std::runtime_error("Failed to create a pipe for the build.");
    SetHandleInformation(readEnd, HANDLE_FLAG_INHERIT, 0);
    PROCESS_INFORMATION process{};
    STARTUPINFOA startup{};
    startup.cb = sizeof(STARTUPINFOA);
    startup.hStdError = writeEnd;
    startup.hStdOutput = writeEnd;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.dwFlags |= STARTF_USESTDHANDLES;
    std::vector<char> buffer(commandLine.begin(), commandLine.end());
    buffer.push_back('\0');
    const std::string directory = workingDirectory.string();
    const BOOL started = CreateProcessA(NULL, buffer.data(), NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, directory.c_str(), &startup, &process);
    CloseHandle(writeEnd);
    if (!started) {
        CloseHandle(readEnd);
        throw std::runtime_error("The compiler \"" + compilerPath + "\" could not be started (error " + std::to_string(GetLastError()) + ").");
    }
    LimitedRunResult result;
    bool truncated = false;
    std::array<char, 4096> chunk{};
    for (;;) {
        DWORD available = 0;
        while (PeekNamedPipe(readEnd, NULL, 0, NULL, &available, NULL) && available > 0) {
            DWORD bytesRead = 0;
            if (!ReadFile(readEnd, chunk.data(), static_cast<DWORD>(std::min<std::size_t>(chunk.size(), available)), &bytesRead, NULL) || bytesRead == 0) break;
            keepOutput(result.output, chunk.data(), bytesRead, truncated);
        }
        if (WaitForSingleObject(process.hProcess, 20) == WAIT_OBJECT_0) break;
        if (std::chrono::steady_clock::now() >= deadline) {
            TerminateProcess(process.hProcess, 1);
            WaitForSingleObject(process.hProcess, INFINITE);
            result.timedOut = true;
            break;
        }
    }
    DWORD bytesRead = 0;
    while (ReadFile(readEnd, chunk.data(), static_cast<DWORD>(chunk.size()), &bytesRead, NULL) && bytesRead > 0) keepOutput(result.output, chunk.data(), bytesRead, truncated);
    CloseHandle(readEnd);
    DWORD exitCode = 1;
    GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hProcess);
    CloseHandle(process.hThread);
    if (truncated) result.output += "\n[… the rest of the compiler's output is left out]";
    result.success = !result.timedOut && exitCode == 0;
    return result;
}
#else
LimitedRunResult runWithLimits(const std::string& compilerPath, const std::vector<std::string>& arguments,
                               const std::filesystem::path& workingDirectory, std::chrono::steady_clock::time_point deadline) {
    int outputPipe[2];
    if (::pipe(outputPipe) != 0) throw std::runtime_error("Failed to create a pipe for the build.");
    const pid_t pid = ::fork();
    if (pid < 0) throw std::runtime_error("Failed to start the build.");
    if (pid == 0) {
        ::setpgid(0, 0);
        ::dup2(outputPipe[1], STDERR_FILENO);
        ::dup2(outputPipe[1], STDOUT_FILENO);
        ::close(outputPipe[0]);
        ::close(outputPipe[1]);
        if (::chdir(workingDirectory.c_str()) != 0) ::_exit(126);
        std::vector<const char*> argv;
        argv.push_back(compilerPath.c_str());
        for (const auto& argument : arguments) argv.push_back(argument.c_str());
        argv.push_back(nullptr);
        ::execvp(compilerPath.c_str(), const_cast<char* const*>(argv.data()));
        std::perror(("The compiler " + compilerPath + " could not be started").c_str());
        ::_exit(127);
    }
    ::close(outputPipe[1]);
    LimitedRunResult result;
    bool truncated = false;
    std::array<char, 4096> chunk{};
    for (;;) {
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count();
        if (remaining <= 0) {
            // The compiler and anything it started (cc1, ld) are stopped together: they share its process group.
            ::kill(-pid, SIGKILL);
            ::kill(pid, SIGKILL);
            result.timedOut = true;
            break;
        }
        pollfd watched{outputPipe[0], POLLIN, 0};
        const int ready = ::poll(&watched, 1, static_cast<int>(std::min<long long>(remaining, 1000)));
        if (ready < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (ready == 0) continue;
        const ssize_t bytesRead = ::read(outputPipe[0], chunk.data(), chunk.size());
        if (bytesRead <= 0) break;
        keepOutput(result.output, chunk.data(), static_cast<std::size_t>(bytesRead), truncated);
    }
    ::close(outputPipe[0]);
    int status = 0;
    ::waitpid(pid, &status, 0);
    if (truncated) result.output += "\n[… the rest of the compiler's output is left out]";
    result.success = !result.timedOut && WIFEXITED(status) && WEXITSTATUS(status) == 0;
    return result;
}
#endif

// MSVC's /std: for a C or C++ standard, or nothing where it has none of its own (C89, C99 and C++11 are its defaults' subsets).
std::string msvcStandardFlag(const std::string& standard) {
    if (standard == "c11") return "/std:c11";
    if (standard == "c17" || standard == "c18") return "/std:c17";
    if (standard == "c++14") return "/std:c++14";
    if (standard == "c++17") return "/std:c++17";
    if (standard == "c++20") return "/std:c++20";
    return {};
}

} // namespace

std::vector<BuildStep> sourceLibrarySteps(const SourceLibraryPlan& plan, const std::string& cCompilerArgument, const std::string& cxxCompilerArgument) {
    const std::string cCompiler = cCompilerArgument.empty() ? resolveCompiler({}) : cCompilerArgument;
    const std::string cxxCompiler = cxxCompilerArgument.empty() ? cCompiler : cxxCompilerArgument;
    const bool msvc = isMsvcCompiler(cCompiler);
    const auto root = std::filesystem::absolute(plan.sourceRoot);
    const auto objects = std::filesystem::absolute(plan.objectDirectory);
    const auto artifact = std::filesystem::absolute(plan.artifactPath);
    std::vector<std::string> platformFlags;
#ifdef __APPLE__
    if (!msvc) {
        if (const auto sysroot = resolveAppleSdkSysroot(); !sysroot.empty()) platformFlags = {"-isysroot", sysroot};
        platformFlags.push_back("-mmacosx-version-min=11.0");
    }
#endif
#ifdef _WIN32
    const auto msvcFlags = msvc ? getMsvcEnvironmentFlags(cCompiler) : MsvcEnvironmentFlags{};
#endif
    std::vector<BuildStep> steps;
    std::vector<std::string> objectPaths;
    bool anyCxx = false;
    std::size_t index = 0;
    for (const auto& set : plan.sets) {
        const bool cxx = set.language == "c++";
        anyCxx = anyCxx || cxx;
        std::vector<std::string> includes;
        for (const auto& directory : plan.includeFirst) includes.push_back(std::filesystem::absolute(directory).string());
        for (const auto& directory : set.includeDirectories) includes.push_back((root / directory).lexically_normal().string());
        includes.push_back(root.string());
        for (const auto& file : set.files) {
            const auto source = (root / file).lexically_normal();
            const auto object = objects / (std::to_string(index++) + "_" + source.stem().string() + (msvc ? ".obj" : ".o"));
            objectPaths.push_back(object.string());
            std::vector<std::string> arguments;
            if (msvc) {
                arguments = {"/nologo", "/c", cxx ? "/TP" : "/TC", "/O2", "/DNDEBUG"};
                if (const auto standard = msvcStandardFlag(set.standard); !standard.empty()) arguments.push_back(standard);
                if (cxx) arguments.push_back("/EHsc");
                arguments.insert(arguments.end(), set.options.begin(), set.options.end());
                for (const auto& directory : includes) arguments.push_back("/I" + directory);
#ifdef _WIN32
                arguments.insert(arguments.end(), msvcFlags.includeFlags.begin(), msvcFlags.includeFlags.end());
#endif
                for (const auto& definition : set.definitions) arguments.push_back("/D" + definition);
                arguments.push_back(source.string());
                arguments.push_back("/Fo" + object.string());
            } else {
                arguments = {"-c", "-x", cxx ? "c++" : "c"};
                if (!set.standard.empty()) arguments.push_back("-std=" + set.standard);
                arguments.insert(arguments.end(), {"-O3", "-DNDEBUG", "-fPIC"});
                arguments.insert(arguments.end(), set.options.begin(), set.options.end());
                arguments.insert(arguments.end(), platformFlags.begin(), platformFlags.end());
                for (const auto& directory : includes) arguments.push_back("-I" + directory);
                for (const auto& definition : set.definitions) arguments.push_back("-D" + definition);
                arguments.push_back(source.string());
                arguments.push_back("-o");
                arguments.push_back(object.string());
            }
            steps.push_back({"Compiling " + std::filesystem::path(file).generic_string(), cxx ? cxxCompiler : cCompiler, arguments});
        }
    }
    std::vector<std::string> link;
    if (msvc) {
        link = {"/nologo", "/LD"};
        link.insert(link.end(), objectPaths.begin(), objectPaths.end());
        link.push_back("/Fe" + artifact.string());
        link.push_back("/link");
#ifdef _WIN32
        link.insert(link.end(), msvcFlags.libpathFlags.begin(), msvcFlags.libpathFlags.end());
#endif
        for (const auto& library : plan.libraries) {
            if (library == "m" || library == "pthread") continue; // part of the C runtime on Windows
            link.push_back(library + ".lib");
        }
    } else {
        link = {"-shared"};
        link.insert(link.end(), platformFlags.begin(), platformFlags.end());
        link.insert(link.end(), objectPaths.begin(), objectPaths.end());
        link.push_back("-o");
        link.push_back(artifact.string());
#if !defined(__APPLE__)
        link.push_back("-Wl,-rpath,$ORIGIN");
#endif
        if (plan.threads) link.push_back("-pthread");
        for (const auto& library : plan.libraries) link.push_back("-l" + library);
    }
    steps.push_back({"Linking " + artifact.filename().string(), anyCxx ? cxxCompiler : cCompiler, link});
    return steps;
}

void buildSourceLibrary(const SourceLibraryPlan& plan, const std::vector<BuildStep>& steps,
                        const std::function<void(std::size_t, std::size_t, const BuildStep&)>& onStep) {
    std::filesystem::create_directories(plan.objectDirectory);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(std::max(1, plan.timeoutSeconds));
    for (std::size_t index = 0; index < steps.size(); ++index) {
        const auto& step = steps[index];
        if (onStep) onStep(index, steps.size(), step);
        const auto result = runWithLimits(step.compiler, step.arguments, std::filesystem::absolute(plan.objectDirectory), deadline);
        if (result.timedOut) {
            std::filesystem::remove(plan.artifactPath);
            throw std::runtime_error(step.what + " was stopped: the build took longer than " + std::to_string(plan.timeoutSeconds) + " s.\n" + result.output);
        }
        if (!result.success) {
            std::filesystem::remove(plan.artifactPath);
            throw std::runtime_error(step.what + " failed:\n" + result.output);
        }
    }
}

} // namespace konjugate::cppToolchain
