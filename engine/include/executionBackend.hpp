/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <cstddef>
#include <string>
#include <string_view>

namespace konjugate {

enum class ExecutionBackend { automatic, serial, threadPool, partitioned };
enum class BackendSelectionReason {
    explicitSelection,
    singleNode,
    belowParallelWorkThreshold,
    partitionCommunicationCutTooHigh,
    partitionCutWithinLimit,
    independentParallelWork
};

ExecutionBackend executionBackendFromString(std::string_view value);
std::string_view executionBackendName(ExecutionBackend value) noexcept;
std::string_view backendSelectionReasonName(BackendSelectionReason value) noexcept;

struct ExecutionBackendDecision {
    ExecutionBackend backend = ExecutionBackend::serial;
    BackendSelectionReason reason = BackendSelectionReason::explicitSelection;
    double communicationCutFraction = 0;
};

ExecutionBackendDecision selectExecutionBackend(ExecutionBackend requestedBackend,
                                                std::size_t nodeCount,
                                                std::size_t estimatedOperationsPerSynchronization,
                                                std::size_t automaticParallelThreshold,
                                                std::size_t communicationCutWeight,
                                                std::size_t totalCommunicationWeight,
                                                double maximumPartitionCutFraction);

}
