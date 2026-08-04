/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "executionPlan.hpp"
#include "taskExecutor.hpp"
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <condition_variable>
#include <vector>

namespace konjugate {

struct PartitionBoundaryMessage {
    std::size_t version = 1;
    std::size_t synchronizationIndex = 0;
    std::size_t targetPartition = 0;
    EntityValues states;
};

struct PartitionNodeResult {
    std::size_t nodeIndex = 0;
    StateValues states;
    std::uint64_t computeNanoseconds = 0;
};

struct PartitionResultMessage {
    std::size_t version = 1;
    std::size_t synchronizationIndex = 0;
    std::size_t sourcePartition = 0;
    std::uint64_t boundaryWaitNanoseconds = 0;
    std::vector<PartitionNodeResult> nodes;
};

class PartitionTransport {
public:
    virtual ~PartitionTransport() = default;
    virtual void publish(PartitionBoundaryMessage message) = 0;
    virtual PartitionBoundaryMessage receive(std::size_t targetPartition,
                                             std::size_t synchronizationIndex,
                                             std::chrono::milliseconds timeout) = 0;
};

class InMemoryPartitionTransport final : public PartitionTransport {
public:
    void publish(PartitionBoundaryMessage message) override;
    PartitionBoundaryMessage receive(std::size_t targetPartition,
                                     std::size_t synchronizationIndex,
                                     std::chrono::milliseconds timeout) override;

private:
    using MessageKey = std::pair<std::size_t, std::size_t>;
    std::map<MessageKey, PartitionBoundaryMessage> messages_;
    std::mutex mutex_;
    std::condition_variable ready_;
};

class PartitionRuntime {
public:
    PartitionRuntime(std::size_t partition,
                     const ExecutionPlan& executionPlan,
                     std::vector<std::size_t> nodeIndexes);

    std::size_t partition() const noexcept;
    const std::vector<std::size_t>& nodeIndexes() const noexcept;
    std::future<PartitionResultMessage> submit(PartitionTransport& transport,
                                               std::size_t synchronizationIndex,
                                               EntityValues parameterValues,
                                               double synchronizationStep,
                                               std::chrono::milliseconds receiveTimeout = std::chrono::seconds(5));

private:
    std::size_t partition_;
    const ExecutionPlan& executionPlan_;
    std::vector<std::size_t> nodeIndexes_;
    TaskExecutor executor_{1};
};

std::size_t partitionMessagePayloadBytes(const PartitionBoundaryMessage& message) noexcept;

}
