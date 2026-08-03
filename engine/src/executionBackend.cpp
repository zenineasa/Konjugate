/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "executionBackend.hpp"
#include <cmath>
#include <stdexcept>

namespace konjugate {

ExecutionBackendDecision selectExecutionBackend(const std::string& requestedBackend,
                                                std::size_t nodeCount,
                                                std::size_t estimatedOperationsPerSynchronization,
                                                std::size_t automaticParallelThreshold,
                                                std::size_t communicationCutWeight,
                                                std::size_t totalCommunicationWeight,
                                                double maximumPartitionCutFraction) {
    if (requestedBackend != "automatic" && requestedBackend != "serial" &&
        requestedBackend != "threadPool" && requestedBackend != "partitioned") {
        throw std::runtime_error("Execution backend must be automatic, serial, threadPool or partitioned.");
    }
    if (!(maximumPartitionCutFraction >= 0 && maximumPartitionCutFraction <= 1) ||
        !std::isfinite(maximumPartitionCutFraction)) {
        throw std::runtime_error("execution.automaticMaximumPartitionCutFraction must be between 0 and 1.");
    }
    const auto cutFraction = totalCommunicationWeight
        ? static_cast<double>(communicationCutWeight) / static_cast<double>(totalCommunicationWeight) : 0;
    if (requestedBackend != "automatic") return {requestedBackend, "explicitSelection", cutFraction};
    if (nodeCount < 2) return {"serial", "singleNode", cutFraction};
    if (estimatedOperationsPerSynchronization < automaticParallelThreshold * nodeCount) {
        return {"serial", "belowParallelWorkThreshold", cutFraction};
    }
    if (cutFraction > maximumPartitionCutFraction) {
        return {"threadPool", "partitionCommunicationCutTooHigh", cutFraction};
    }
    return {"partitioned", totalCommunicationWeight ? "partitionCutWithinLimit" : "independentParallelWork", cutFraction};
}

}
