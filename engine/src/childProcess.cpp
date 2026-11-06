/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "childProcess.hpp"
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace konjugate {

namespace {
constexpr std::size_t keptDiagnostics = 8192;

std::string frameHeader(std::size_t size) {
    if (size > 0xffffffffu) throw std::runtime_error("A message to the program is too large.");
    std::string header(4, '\0');
    header[0] = static_cast<char>((size >> 24) & 0xff);
    header[1] = static_cast<char>((size >> 16) & 0xff);
    header[2] = static_cast<char>((size >> 8) & 0xff);
    header[3] = static_cast<char>(size & 0xff);
    return header;
}

std::uint32_t frameLength(const std::string& header) {
    return (static_cast<std::uint32_t>(static_cast<unsigned char>(header[0])) << 24) |
           (static_cast<std::uint32_t>(static_cast<unsigned char>(header[1])) << 16) |
           (static_cast<std::uint32_t>(static_cast<unsigned char>(header[2])) << 8) |
            static_cast<std::uint32_t>(static_cast<unsigned char>(header[3]));
}
}

struct ChildProcess::Impl {
    std::mutex diagnosticsMutex;
    std::string diagnostics;
    std::thread stderrReader;
    std::string pending;
#ifdef _WIN32
    HANDLE process = NULL;
    HANDLE stdinWrite = NULL;
    HANDLE stdoutRead = NULL;
    HANDLE stderrRead = NULL;
#else
    pid_t pid = -1;
    int stdinFd = -1;
    int stdoutFd = -1;
    int stderrFd = -1;
#endif

    void keep(const char* bytes, std::size_t size) {
        std::lock_guard lock(diagnosticsMutex);
        diagnostics.append(bytes, size);
        if (diagnostics.size() > keptDiagnostics) diagnostics.erase(0, diagnostics.size() - keptDiagnostics);
    }
};

#ifndef _WIN32
ChildProcess::ChildProcess(const std::vector<std::vector<std::string>>& commands, const std::vector<std::pair<std::string, std::string>>& environment)
    : impl_(new Impl) {
    std::string tried;
    for (const auto& command : commands) {
        if (command.empty()) continue;
        int inPipe[2], outPipe[2], errPipe[2], execPipe[2];
        if (::pipe(inPipe) || ::pipe(outPipe) || ::pipe(errPipe) || ::pipe(execPipe)) throw std::runtime_error("Could not make the pipes to start a program.");
        ::fcntl(execPipe[1], F_SETFD, FD_CLOEXEC);
        const pid_t pid = ::fork();
        if (pid < 0) throw std::runtime_error("Could not start a program.");
        if (pid == 0) {
            ::dup2(inPipe[0], STDIN_FILENO);
            ::dup2(outPipe[1], STDOUT_FILENO);
            ::dup2(errPipe[1], STDERR_FILENO);
            for (int fd : {inPipe[0], inPipe[1], outPipe[0], outPipe[1], errPipe[0], errPipe[1], execPipe[0]}) ::close(fd);
            for (const auto& [name, value] : environment) ::setenv(name.c_str(), value.c_str(), 1);
            std::vector<char*> arguments;
            for (const auto& argument : command) arguments.push_back(const_cast<char*>(argument.c_str()));
            arguments.push_back(nullptr);
            ::execvp(arguments[0], arguments.data());
            const int failure = errno;
            [[maybe_unused]] const auto written = ::write(execPipe[1], &failure, sizeof(failure));
            ::_exit(127);
        }
        for (int fd : {inPipe[0], outPipe[1], errPipe[1], execPipe[1]}) ::close(fd);
        int failure = 0;
        const auto got = ::read(execPipe[0], &failure, sizeof(failure));
        ::close(execPipe[0]);
        if (got > 0) {
            // That command could not be started: try the next.
            ::waitpid(pid, nullptr, 0);
            for (int fd : {inPipe[1], outPipe[0], errPipe[0]}) ::close(fd);
            tried += (tried.empty() ? "" : ", ") + command[0];
            continue;
        }
        impl_->pid = pid;
        impl_->stdinFd = inPipe[1];
        impl_->stdoutFd = outPipe[0];
        impl_->stderrFd = errPipe[0];
        // A child that dies makes a write to its stdin raise SIGPIPE; it is reported as an error instead.
        std::signal(SIGPIPE, SIG_IGN);
        impl_->stderrReader = std::thread([impl = impl_] {
            char buffer[1024];
            while (true) {
                const auto count = ::read(impl->stderrFd, buffer, sizeof(buffer));
                if (count <= 0) return;
                impl->keep(buffer, static_cast<std::size_t>(count));
            }
        });
        return;
    }
    delete impl_;
    throw std::runtime_error("None of these could be started: " + tried + ".");
}

ChildProcess::~ChildProcess() {
    if (impl_->stdinFd >= 0) ::close(impl_->stdinFd);
    if (impl_->pid > 0) {
        // Its stdin closed, a well-behaved program ends; one that does not is ended.
        for (int waited = 0; waited < 20; ++waited) {
            if (::waitpid(impl_->pid, nullptr, WNOHANG) == impl_->pid) { impl_->pid = -1; break; }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        if (impl_->pid > 0) {
            ::kill(impl_->pid, SIGKILL);
            ::waitpid(impl_->pid, nullptr, 0);
        }
    }
    if (impl_->stdoutFd >= 0) ::close(impl_->stdoutFd);
    if (impl_->stderrReader.joinable()) impl_->stderrReader.join();
    if (impl_->stderrFd >= 0) ::close(impl_->stderrFd);
    delete impl_;
}

void ChildProcess::writeFrame(const std::string& payload) {
    const auto frame = frameHeader(payload.size()) + payload;
    std::size_t written = 0;
    while (written < frame.size()) {
        const auto count = ::write(impl_->stdinFd, frame.data() + written, frame.size() - written);
        if (count <= 0) throw std::runtime_error("The program stopped taking input.");
        written += static_cast<std::size_t>(count);
    }
}

bool ChildProcess::readFrame(std::string& payload, std::chrono::milliseconds limit) {
    const auto deadline = std::chrono::steady_clock::now() + limit;
    auto& pending = impl_->pending;
    while (true) {
        if (pending.size() >= 4) {
            const auto size = frameLength(pending);
            if (pending.size() >= 4 + static_cast<std::size_t>(size)) {
                payload = pending.substr(4, size);
                pending.erase(0, 4 + static_cast<std::size_t>(size));
                return true;
            }
        }
        const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count();
        if (left <= 0) throw std::runtime_error("The program did not answer within " + std::to_string(limit.count() / 1000) + " s.");
        pollfd watched{impl_->stdoutFd, POLLIN, 0};
        const auto ready = ::poll(&watched, 1, static_cast<int>(left));
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0) continue;
        char buffer[65536];
        const auto count = ::read(impl_->stdoutFd, buffer, sizeof(buffer));
        if (count <= 0) return false;
        pending.append(buffer, static_cast<std::size_t>(count));
    }
}
#else
namespace {
std::string quoted(const std::string& argument) {
    if (!argument.empty() && argument.find_first_of(" \t\"") == std::string::npos) return argument;
    std::string result = "\"";
    for (const char character : argument) {
        if (character == '"') result += '\\';
        result += character;
    }
    return result + "\"";
}
}

ChildProcess::ChildProcess(const std::vector<std::vector<std::string>>& commands, const std::vector<std::pair<std::string, std::string>>& environment)
    : impl_(new Impl) {
    for (const auto& [name, value] : environment) SetEnvironmentVariableA(name.c_str(), value.c_str());
    std::string tried;
    for (const auto& command : commands) {
        if (command.empty()) continue;
        SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
        HANDLE inRead, inWrite, outRead, outWrite, errRead, errWrite;
        if (!CreatePipe(&inRead, &inWrite, &attributes, 0) || !CreatePipe(&outRead, &outWrite, &attributes, 0) || !CreatePipe(&errRead, &errWrite, &attributes, 0)) {
            throw std::runtime_error("Could not make the pipes to start a program.");
        }
        SetHandleInformation(inWrite, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0);
        STARTUPINFOA startup{};
        startup.cb = sizeof(startup);
        startup.hStdInput = inRead;
        startup.hStdOutput = outWrite;
        startup.hStdError = errWrite;
        startup.dwFlags = STARTF_USESTDHANDLES;
        PROCESS_INFORMATION information{};
        std::string line;
        for (const auto& argument : command) line += (line.empty() ? "" : " ") + quoted(argument);
        const BOOL started = CreateProcessA(NULL, line.data(), NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &startup, &information);
        CloseHandle(inRead);
        CloseHandle(outWrite);
        CloseHandle(errWrite);
        if (!started) {
            for (HANDLE handle : {inWrite, outRead, errRead}) CloseHandle(handle);
            tried += (tried.empty() ? "" : ", ") + command[0];
            continue;
        }
        CloseHandle(information.hThread);
        impl_->process = information.hProcess;
        impl_->stdinWrite = inWrite;
        impl_->stdoutRead = outRead;
        impl_->stderrRead = errRead;
        impl_->stderrReader = std::thread([impl = impl_] {
            char buffer[1024];
            DWORD count = 0;
            while (ReadFile(impl->stderrRead, buffer, sizeof(buffer), &count, NULL) && count) impl->keep(buffer, count);
        });
        return;
    }
    delete impl_;
    throw std::runtime_error("None of these could be started: " + tried + ".");
}

ChildProcess::~ChildProcess() {
    if (impl_->stdinWrite) CloseHandle(impl_->stdinWrite);
    if (impl_->process) {
        if (WaitForSingleObject(impl_->process, 200) != WAIT_OBJECT_0) TerminateProcess(impl_->process, 1);
        CloseHandle(impl_->process);
    }
    if (impl_->stdoutRead) CloseHandle(impl_->stdoutRead);
    if (impl_->stderrReader.joinable()) impl_->stderrReader.join();
    if (impl_->stderrRead) CloseHandle(impl_->stderrRead);
    delete impl_;
}

void ChildProcess::writeFrame(const std::string& payload) {
    const auto frame = frameHeader(payload.size()) + payload;
    DWORD written = 0;
    if (!WriteFile(impl_->stdinWrite, frame.data(), static_cast<DWORD>(frame.size()), &written, NULL) || written != frame.size()) {
        throw std::runtime_error("The program stopped taking input.");
    }
}

bool ChildProcess::readFrame(std::string& payload, std::chrono::milliseconds limit) {
    const auto deadline = std::chrono::steady_clock::now() + limit;
    auto& pending = impl_->pending;
    while (true) {
        if (pending.size() >= 4) {
            const auto size = frameLength(pending);
            if (pending.size() >= 4 + static_cast<std::size_t>(size)) {
                payload = pending.substr(4, size);
                pending.erase(0, 4 + static_cast<std::size_t>(size));
                return true;
            }
        }
        if (std::chrono::steady_clock::now() >= deadline) throw std::runtime_error("The program did not answer within " + std::to_string(limit.count() / 1000) + " s.");
        DWORD available = 0;
        if (!PeekNamedPipe(impl_->stdoutRead, NULL, 0, NULL, &available, NULL)) return false;
        if (!available) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            continue;
        }
        char buffer[65536];
        DWORD count = 0;
        if (!ReadFile(impl_->stdoutRead, buffer, available < sizeof(buffer) ? available : sizeof(buffer), &count, NULL) || !count) return false;
        pending.append(buffer, count);
    }
}
#endif

std::string ChildProcess::diagnostics() const {
    std::lock_guard lock(impl_->diagnosticsMutex);
    return impl_->diagnostics;
}

}
