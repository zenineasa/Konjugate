/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "dependencyGraph.hpp"
#include <algorithm>
#include <map>
#include <numeric>
#include <set>
#include <stdexcept>
#include <unordered_map>

namespace konjugate {
namespace {

struct DependencyAccumulator {
    std::set<EntityId> remoteStateIds;
    std::size_t contributionTaskCount = 0;
    std::size_t remoteBindingsPerSubstep = 0;
    std::size_t estimatedDependentOperationsPerSynchronization = 0;
};

class DisjointComponents {
public:
    explicit DisjointComponents(std::size_t size) : parents_(size), ranks_(size, 0) {
        std::iota(parents_.begin(), parents_.end(), 0);
    }

    std::size_t find(std::size_t item) {
        if (parents_[item] != item) parents_[item] = find(parents_[item]);
        return parents_[item];
    }

    void connect(std::size_t left, std::size_t right) {
        left = find(left);
        right = find(right);
        if (left == right) return;
        if (ranks_[left] < ranks_[right]) std::swap(left, right);
        parents_[right] = left;
        if (ranks_[left] == ranks_[right]) ++ranks_[left];
    }

private:
    std::vector<std::size_t> parents_;
    std::vector<std::size_t> ranks_;
};

}

DependencyGraph buildDependencyGraph(const ExecutionPlan& plan) {
    DependencyGraph graph;
    std::unordered_map<EntityId, std::size_t> nodeIndexes;
    graph.nodes.reserve(plan.nodes.size());
    for (std::size_t index = 0; index < plan.nodes.size(); ++index) {
        const auto& node = plan.nodes[index];
        nodeIndexes[node.nodeId] = index;
        graph.nodes.push_back({
            node.nodeId,
            node.stateIds.size(),
            node.substeps,
            node.estimatedOperationsPerSubstep * node.substeps,
            0
        });
    }

    std::map<std::pair<std::size_t, std::size_t>, DependencyAccumulator> accumulated;
    for (std::size_t targetIndex = 0; targetIndex < plan.nodes.size(); ++targetIndex) {
        const auto& target = plan.nodes[targetIndex];
        for (const auto& task : target.contributions) {
            std::map<std::size_t, std::vector<EntityId>> taskRemoteStates;
            for (const auto& binding : task.bindings) {
                if (binding.source != BindingSource::synchronizationSnapshot) continue;
                const auto stateNode = plan.stateNodes.find(binding.valueId);
                if (stateNode == plan.stateNodes.end()) throw std::runtime_error("A dependency references an unknown state.");
                const auto sourceIndex = nodeIndexes.at(stateNode->second);
                if (sourceIndex != targetIndex) taskRemoteStates[sourceIndex].push_back(binding.valueId);
            }
            for (const auto& [sourceIndex, stateIds] : taskRemoteStates) {
                auto& dependency = accumulated[{sourceIndex, targetIndex}];
                ++dependency.contributionTaskCount;
                dependency.remoteBindingsPerSubstep += stateIds.size();
                dependency.estimatedDependentOperationsPerSynchronization += task.expression.operationCount() * target.substeps;
                dependency.remoteStateIds.insert(stateIds.begin(), stateIds.end());
            }
        }
    }

    DisjointComponents components(plan.nodes.size());
    for (const auto& [indexes, dependency] : accumulated) {
        components.connect(indexes.first, indexes.second);
        graph.dependencies.push_back({
            plan.nodes[indexes.first].nodeId,
            plan.nodes[indexes.second].nodeId,
            {dependency.remoteStateIds.begin(), dependency.remoteStateIds.end()},
            dependency.contributionTaskCount,
            dependency.remoteBindingsPerSubstep,
            dependency.estimatedDependentOperationsPerSynchronization,
            dependency.remoteStateIds.size()
        });
    }

    std::unordered_map<std::size_t, std::size_t> componentIndexes;
    for (std::size_t index = 0; index < graph.nodes.size(); ++index) {
        const auto root = components.find(index);
        const auto [found, inserted] = componentIndexes.emplace(root, componentIndexes.size());
        graph.nodes[index].component = found->second;
        if (inserted) ++graph.componentCount;
    }
    return graph;
}

}
