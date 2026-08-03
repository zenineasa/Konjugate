/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <cstddef>
#include <string>

namespace konjugate {

struct ExecutionBackendDecision {
    std::string backend = "serial";
    std::string reason = "explicitSelection";
    double communicationCutFraction = 0;
};

ExecutionBackendDecision selectExecutionBackend(const std::string& requestedBackend,
                                                std::size_t nodeCount,
                                                std::size_t estimatedOperationsPerSynchronization,
                                                std::size_t automaticParallelThreshold,
                                                std::size_t communicationCutWeight,
                                                std::size_t totalCommunicationWeight,
                                                double maximumPartitionCutFraction);

}
