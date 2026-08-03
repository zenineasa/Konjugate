/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "taskExecutor.hpp"
#include <stdexcept>

namespace konjugate {

TaskExecutor::TaskExecutor(std::size_t workerCount) {
    if (!workerCount) throw std::invalid_argument("A task executor requires at least one worker.");
    workers_.reserve(workerCount);
    try {
        for (std::size_t index = 0; index < workerCount; ++index) {
            workers_.emplace_back([this] {
                while (true) {
                    std::function<void()> task;
                    {
                        std::unique_lock lock(mutex_);
                        ready_.wait(lock, [this] { return stopping_ || !tasks_.empty(); });
                        if (stopping_ && tasks_.empty()) return;
                        task = std::move(tasks_.front());
                        tasks_.pop();
                    }
                    task();
                }
            });
        }
    } catch (...) {
        {
            std::lock_guard lock(mutex_);
            stopping_ = true;
        }
        ready_.notify_all();
        for (auto& worker : workers_) if (worker.joinable()) worker.join();
        throw;
    }
}

TaskExecutor::~TaskExecutor() {
    {
        std::lock_guard lock(mutex_);
        stopping_ = true;
    }
    ready_.notify_all();
    for (auto& worker : workers_) if (worker.joinable()) worker.join();
}

std::size_t TaskExecutor::workerCount() const noexcept {
    return workers_.size();
}

}
