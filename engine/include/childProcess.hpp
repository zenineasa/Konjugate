/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// A program the engine starts and talks to over its stdin and stdout: a person's objective program (runMeasure.hpp's ProgramMeasure)
// and a relationship or node provider's worker (providerRuntime.cpp's ProviderControlChannel). Started with the first of a list of
// commands that can be found, written to and read from with a time limit or none, and ended when the object is. A program that dies
// is noticed on the next read or write, never as a hang past the limit.

#include <chrono>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace konjugate {

class ChildProcess {
public:
    // `commands`: each a program and its arguments; the first that can be started is used (python3, then python, say).
    // `environment`: variables set for the child only. `echoDiagnostics`: what the child writes to its stderr is also written to the
    // engine's own (a provider's prints, which a person reads in the engine's log), besides being kept for diagnostics().
    ChildProcess(const std::vector<std::vector<std::string>>& commands, const std::vector<std::pair<std::string, std::string>>& environment,
                 bool echoDiagnostics = false);
    ~ChildProcess();
    ChildProcess(const ChildProcess&) = delete;
    ChildProcess& operator=(const ChildProcess&) = delete;

    // A read that waits as long as the child takes (a provider's evaluation, which has no deadline of its own).
    static constexpr std::chrono::milliseconds noLimit = std::chrono::milliseconds::max();

    // One frame: a 4-byte big-endian length, then that many bytes. Write throws if the child has gone; read returns false if it
    // went, and throws if nothing whole came within `limit`.
    void writeFrame(const std::string& payload);
    bool readFrame(std::string& payload, std::chrono::milliseconds limit);

    // What the child wrote to its stderr, kept for a message when it fails (the last few kilobytes).
    std::string diagnostics() const;

private:
    struct Impl;
    Impl* impl_;
};

}
