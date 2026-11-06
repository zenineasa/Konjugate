/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// A program the engine starts and talks to over its stdin and stdout (a person's objective program, for one: see
// runMeasure.hpp's ProgramMeasure): started with the first of a list of commands that can be found, written to and read from with a
// time limit, and ended when the object is. A program that dies is noticed on the next read or write, never as a hang past the limit.

#include <chrono>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace konjugate {

class ChildProcess {
public:
    // `commands`: each a program and its arguments; the first that can be started is used (python3, then python, say).
    // `environment`: variables set for the child only.
    ChildProcess(const std::vector<std::vector<std::string>>& commands, const std::vector<std::pair<std::string, std::string>>& environment);
    ~ChildProcess();
    ChildProcess(const ChildProcess&) = delete;
    ChildProcess& operator=(const ChildProcess&) = delete;

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
