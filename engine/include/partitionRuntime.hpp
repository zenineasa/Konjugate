/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "executionPlan.hpp"
#include "wholeModelIntegration.hpp"
#include "taskExecutor.hpp"
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <future>
#include <limits>
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

// A partition's answer for one stage of a whole-model step: each of its nodes' derivatives at the stage.
struct PartitionStageMessage {
    std::size_t version = 1;
    std::size_t synchronizationIndex = 0;
    std::size_t sourcePartition = 0;
    std::uint64_t boundaryWaitNanoseconds = 0;
    std::vector<std::pair<std::size_t, NodeStageResult>> nodes;
};

// What every partition is told for one stage of a whole-model step (docs/proposals/integrators.md): the stage's time and step,
// whether it is the step's first stage (where held programs are evaluated), and where the plan and the held values live. Each
// partition writes only its own nodes' entries of `held`.
struct StageRequest {
    const WholeModelPlan* wholeModel = nullptr;
    std::vector<std::vector<EvaluatedContribution>>* held = nullptr;
    double stageTime = 0;
    double stepSize = 0;
    bool evaluateHeld = false;
    double heldStepSize = 0;
    // The switching conditions' latches the stage terms read (event location); null when the model has none.
    const std::vector<double>* latches = nullptr;
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
                                               double simulationTime = 0,
                                               std::chrono::milliseconds receiveTimeout = std::chrono::seconds(5),
                                               ProviderEvaluator* providerEvaluator = nullptr,
                                               std::vector<ParameterSchedule> activeSchedules = {},
                                               double synchronizationEndTime = std::numeric_limits<double>::quiet_NaN());

    // One stage of a whole-model step: waits for this stage's boundary message (its stage values), then evaluates each of the
    // partition's nodes that takes part in stages at those values.
    std::future<PartitionStageMessage> submitStage(PartitionTransport& transport,
                                                   std::size_t synchronizationIndex,
                                                   EntityValues parameterValues,
                                                   std::vector<ParameterSchedule> activeSchedules,
                                                   StageRequest request,
                                                   std::chrono::milliseconds receiveTimeout,
                                                   ProviderEvaluator* providerEvaluator);

private:
    std::size_t partition_;
    const ExecutionPlan& executionPlan_;
    std::vector<std::size_t> nodeIndexes_;
    TaskExecutor executor_{1};
};

std::size_t partitionMessagePayloadBytes(const PartitionBoundaryMessage& message) noexcept;

}
