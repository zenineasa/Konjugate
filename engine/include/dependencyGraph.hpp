/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "executionPlan.hpp"
#include <cstddef>
#include <string>
#include <vector>

namespace konjugate {

struct DependencyNode {
    EntityId nodeId = 0;
    std::size_t stateCount = 0;
    std::size_t substeps = 1;
    std::size_t estimatedOperationsPerSynchronization = 0;
    std::size_t component = 0;
};

struct NodeDependency {
    EntityId sourceNodeId = 0;
    EntityId targetNodeId = 0;
    std::vector<EntityId> remoteStateIds;
    std::size_t contributionTaskCount = 0;
    std::size_t remoteBindingsPerSubstep = 0;
    std::size_t estimatedDependentOperationsPerSynchronization = 0;
    std::size_t communicationWeight = 0;
};

struct DependencyGraph {
    std::size_t version = 1;
    std::size_t componentCount = 0;
    std::vector<DependencyNode> nodes;
    std::vector<NodeDependency> dependencies;
};

DependencyGraph buildDependencyGraph(const ExecutionPlan& plan);

}
