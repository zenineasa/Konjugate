/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Shared C++ compiler discovery and native-artifact build logic, extracted from
// providerRuntime.cpp's buildCppProvider() (a pure extraction -- same flags, same behavior) so a
// second caller (the buildSharedLibrary CLI command, used for FMU export) can build a native
// shared library without duplicating this platform-specific logic. providerRuntime.cpp's own
// build path now calls into this file too.

#include "cppToolchain.hpp"

#include <algorithm>
#include <array>
#include <cstdio>
#include <filesystem>
#include <stdexcept>
#include <vector>
#ifdef _WIN32
#include <windows.h>
using ssize_t = intptr_t;
using pid_t = int;
#else
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
CompilerRunResult runCppCompiler(const std::string& compilerPath, const std::vector<std::string>& arguments) {
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

void buildNativeArtifact(const std::filesystem::path& sourcePath, const std::filesystem::path& gluePath,
                          const std::filesystem::path& includeDirectory, const std::filesystem::path& artifactPath,
                          bool sharedLibrary, const std::string& compilerOverride, const std::string& failureContext) {
    const std::string compiler = resolveCompiler(compilerOverride);

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
        arguments = {"-std=c++20", "-O1"};
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
#endif
    }

    const auto result = runCppCompiler(compiler, arguments);
    if (!result.success) {
        std::filesystem::remove(artifactPath);
        throw std::runtime_error("Failed to compile " + failureContext + ":\n" + result.diagnostics);
    }
}

} // namespace konjugate::cppToolchain
