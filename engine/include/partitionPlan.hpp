/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "dependencyGraph.hpp"
#include <cstddef>
#include <string>
#include <vector>

namespace konjugate {

struct PartitionAssignment {
    std::string nodeId;
    std::size_t partition = 0;
};

struct PartitionMetrics {
    std::size_t partition = 0;
    std::size_t nodeCount = 0;
    std::size_t computeWeight = 0;
    std::size_t localStateCount = 0;
    std::size_t boundaryStateCount = 0;
};

struct PartitionComparison {
    std::size_t communicationCutWeight = 0;
    std::size_t cutDependencyCount = 0;
    double computeImbalance = 1;
};

struct PartitionPlan {
    std::size_t version = 1;
    std::string algorithm = "communicationAwareGreedy";
    std::string algorithmVersion = "1";
    std::string requestedAlgorithm = "automatic";
    std::string fallbackReason;
    std::size_t requestedPartitions = 1;
    std::size_t effectivePartitions = 1;
    double communicationBias = 1;
    std::vector<PartitionAssignment> assignments;
    std::vector<PartitionMetrics> partitions;
    PartitionComparison selected;
    PartitionComparison greedy;
    PartitionComparison roundRobin;
};

bool metisPartitionerAvailable() noexcept;
std::string metisPartitionerVersion();

PartitionPlan createPartitionPlan(const DependencyGraph& graph,
                                  std::size_t requestedPartitions,
                                  double communicationBias = 4,
                                  const std::string& requestedAlgorithm = "automatic");

PartitionPlan createGreedyPartitionPlan(const DependencyGraph& graph,
                                        std::size_t requestedPartitions,
                                        double communicationBias = 4);

}
