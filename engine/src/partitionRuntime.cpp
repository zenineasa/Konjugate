/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "partitionRuntime.hpp"
#include <algorithm>
#include <stdexcept>

namespace konjugate {
namespace {

PartitionNodeResult integrateNode(const NodeExecutionPlan& node,
                                  std::size_t nodeIndex,
                                  const StateValues& synchronizationSnapshot,
                                  const StateValues& liveParameterValues,
                                  double synchronizationStep) {
    const auto startedAt = std::chrono::steady_clock::now();
    StateValues localStates;
    localStates.reserve(node.stateIds.size());
    for (const auto& stateId : node.stateIds) localStates[stateId] = synchronizationSnapshot.at(stateId);
    const auto nodeTimeStep = synchronizationStep / static_cast<double>(node.substeps);
    for (std::size_t substep = 0; substep < node.substeps; ++substep) {
        const auto evaluated = evaluateContributionTasks(node, localStates, synchronizationSnapshot, liveParameterValues);
        const auto derivatives = reduceContributions(evaluated);
        for (const auto& derivative : derivatives) localStates.at(derivative.first) += nodeTimeStep * derivative.second;
    }
    StateValues result;
    for (const auto& stateId : node.stateIds) result[stateId] = localStates.at(stateId);
    const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - startedAt).count();
    return {nodeIndex, std::move(result), static_cast<std::uint64_t>(std::max<std::int64_t>(0, elapsed))};
}

}

void InMemoryPartitionTransport::publish(PartitionBoundaryMessage message) {
    if (message.version != 1) throw std::runtime_error("Unsupported partition boundary message version.");
    const MessageKey key{message.targetPartition, message.synchronizationIndex};
    {
        std::lock_guard lock(mutex_);
        if (messages_.contains(key)) throw std::runtime_error("A partition boundary message was published more than once.");
        messages_.emplace(key, std::move(message));
    }
    ready_.notify_all();
}

PartitionBoundaryMessage InMemoryPartitionTransport::receive(std::size_t targetPartition,
                                                             std::size_t synchronizationIndex,
                                                             std::chrono::milliseconds timeout) {
    const MessageKey key{targetPartition, synchronizationIndex};
    std::unique_lock lock(mutex_);
    if (!ready_.wait_for(lock, timeout, [&] { return messages_.contains(key); })) {
        throw std::runtime_error("Timed out waiting for a partition boundary message.");
    }
    auto message = std::move(messages_.at(key));
    messages_.erase(key);
    return message;
}

PartitionRuntime::PartitionRuntime(std::size_t partition,
                                   const ExecutionPlan& executionPlan,
                                   std::vector<std::size_t> nodeIndexes)
    : partition_(partition), executionPlan_(executionPlan), nodeIndexes_(std::move(nodeIndexes)) {
    for (const auto nodeIndex : nodeIndexes_) {
        if (nodeIndex >= executionPlan_.nodes.size()) throw std::invalid_argument("A partition references an unknown node.");
    }
}

std::size_t PartitionRuntime::partition() const noexcept {
    return partition_;
}

const std::vector<std::size_t>& PartitionRuntime::nodeIndexes() const noexcept {
    return nodeIndexes_;
}

std::future<PartitionResultMessage> PartitionRuntime::submit(PartitionTransport& transport,
                                                             std::size_t synchronizationIndex,
                                                             StateValues parameterValues,
                                                             double synchronizationStep,
                                                             std::chrono::milliseconds receiveTimeout) {
    return executor_.submit([this, &transport, synchronizationIndex, parameterValues = std::move(parameterValues),
                             synchronizationStep, receiveTimeout]() mutable {
        const auto waitStartedAt = std::chrono::steady_clock::now();
        auto boundary = transport.receive(partition_, synchronizationIndex, receiveTimeout);
        const auto waitNanoseconds = std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - waitStartedAt).count();
        if (boundary.version != 1 || boundary.targetPartition != partition_ ||
            boundary.synchronizationIndex != synchronizationIndex) {
            throw std::runtime_error("A partition received an incompatible boundary message.");
        }
        PartitionResultMessage result;
        result.synchronizationIndex = synchronizationIndex;
        result.sourcePartition = partition_;
        result.boundaryWaitNanoseconds = static_cast<std::uint64_t>(std::max<std::int64_t>(0, waitNanoseconds));
        result.nodes.reserve(nodeIndexes_.size());
        for (const auto nodeIndex : nodeIndexes_) {
            result.nodes.push_back(integrateNode(
                executionPlan_.nodes[nodeIndex], nodeIndex, boundary.states, parameterValues, synchronizationStep));
        }
        return result;
    });
}

std::size_t partitionMessagePayloadBytes(const PartitionBoundaryMessage& message) noexcept {
    std::size_t bytes = 0;
    for (const auto& [stateId, stateValue] : message.states) {
        static_cast<void>(stateValue);
        bytes += sizeof(stateId) + sizeof(double);
    }
    return bytes;
}

}
