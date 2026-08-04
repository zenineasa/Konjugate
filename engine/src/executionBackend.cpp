/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "executionBackend.hpp"
#include <cmath>
#include <stdexcept>

namespace konjugate {

ExecutionBackend executionBackendFromString(std::string_view value) {
    if (value == "automatic") return ExecutionBackend::automatic;
    if (value == "serial") return ExecutionBackend::serial;
    if (value == "threadPool") return ExecutionBackend::threadPool;
    if (value == "partitioned") return ExecutionBackend::partitioned;
    throw std::runtime_error("Execution backend must be automatic, serial, threadPool or partitioned.");
}

std::string_view executionBackendName(ExecutionBackend value) noexcept {
    switch (value) {
        case ExecutionBackend::automatic: return "automatic";
        case ExecutionBackend::serial: return "serial";
        case ExecutionBackend::threadPool: return "threadPool";
        case ExecutionBackend::partitioned: return "partitioned";
    }
    return "automatic";
}

std::string_view backendSelectionReasonName(BackendSelectionReason value) noexcept {
    switch (value) {
        case BackendSelectionReason::explicitSelection: return "explicitSelection";
        case BackendSelectionReason::singleNode: return "singleNode";
        case BackendSelectionReason::belowParallelWorkThreshold: return "belowParallelWorkThreshold";
        case BackendSelectionReason::partitionCommunicationCutTooHigh: return "partitionCommunicationCutTooHigh";
        case BackendSelectionReason::partitionCutWithinLimit: return "partitionCutWithinLimit";
        case BackendSelectionReason::independentParallelWork: return "independentParallelWork";
    }
    return "explicitSelection";
}

ExecutionBackendDecision selectExecutionBackend(ExecutionBackend requestedBackend,
                                                std::size_t nodeCount,
                                                std::size_t estimatedOperationsPerSynchronization,
                                                std::size_t automaticParallelThreshold,
                                                std::size_t communicationCutWeight,
                                                std::size_t totalCommunicationWeight,
                                                double maximumPartitionCutFraction) {
    if (!(maximumPartitionCutFraction >= 0 && maximumPartitionCutFraction <= 1) ||
        !std::isfinite(maximumPartitionCutFraction)) {
        throw std::runtime_error("execution.automaticMaximumPartitionCutFraction must be between 0 and 1.");
    }
    const auto cutFraction = totalCommunicationWeight
        ? static_cast<double>(communicationCutWeight) / static_cast<double>(totalCommunicationWeight) : 0;
    if (requestedBackend != ExecutionBackend::automatic) return {requestedBackend, BackendSelectionReason::explicitSelection, cutFraction};
    if (nodeCount < 2) return {ExecutionBackend::serial, BackendSelectionReason::singleNode, cutFraction};
    if (estimatedOperationsPerSynchronization < automaticParallelThreshold * nodeCount) {
        return {ExecutionBackend::serial, BackendSelectionReason::belowParallelWorkThreshold, cutFraction};
    }
    if (cutFraction > maximumPartitionCutFraction) {
        return {ExecutionBackend::threadPool, BackendSelectionReason::partitionCommunicationCutTooHigh, cutFraction};
    }
    return {ExecutionBackend::partitioned, totalCommunicationWeight
        ? BackendSelectionReason::partitionCutWithinLimit : BackendSelectionReason::independentParallelWork, cutFraction};
}

}
