/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "partitionPlan.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

namespace konjugate {
namespace {

std::vector<std::size_t> nodeWeights(const DependencyGraph& graph) {
    std::vector<std::size_t> weights;
    weights.reserve(graph.nodes.size());
    for (const auto& node : graph.nodes) weights.push_back(std::max<std::size_t>(1, node.estimatedOperationsPerSynchronization));
    return weights;
}

PartitionComparison compareAssignment(const DependencyGraph& graph,
                                      const std::vector<std::size_t>& assignment,
                                      const std::vector<std::size_t>& weights,
                                      std::size_t partitionCount) {
    PartitionComparison comparison;
    std::vector<std::size_t> loads(partitionCount, 0);
    std::unordered_map<std::string, std::size_t> nodeIndexes;
    for (std::size_t index = 0; index < graph.nodes.size(); ++index) {
        nodeIndexes[graph.nodes[index].nodeId] = index;
        loads[assignment[index]] += weights[index];
    }
    for (const auto& dependency : graph.dependencies) {
        if (assignment[nodeIndexes.at(dependency.sourceNodeId)] != assignment[nodeIndexes.at(dependency.targetNodeId)]) {
            comparison.communicationCutWeight += dependency.communicationWeight;
            ++comparison.cutDependencyCount;
        }
    }
    const auto totalWeight = std::accumulate(weights.begin(), weights.end(), std::size_t{0});
    const auto average = static_cast<double>(totalWeight) / static_cast<double>(partitionCount);
    comparison.computeImbalance = average > 0
        ? static_cast<double>(*std::max_element(loads.begin(), loads.end())) / average : 1;
    return comparison;
}

}

PartitionPlan createGreedyPartitionPlan(const DependencyGraph& graph,
                                        std::size_t requestedPartitions,
                                        double communicationBias) {
    if (!requestedPartitions || requestedPartitions > 256) {
        throw std::runtime_error("Partition count must be an integer from 1 through 256.");
    }
    if (!(communicationBias >= 0) || !std::isfinite(communicationBias)) {
        throw std::runtime_error("Partition communication bias must be finite and non-negative.");
    }
    PartitionPlan plan;
    plan.requestedPartitions = requestedPartitions;
    plan.effectivePartitions = std::min(requestedPartitions, std::max<std::size_t>(1, graph.nodes.size()));
    plan.communicationBias = communicationBias;
    plan.partitions.resize(plan.effectivePartitions);
    for (std::size_t partition = 0; partition < plan.partitions.size(); ++partition) plan.partitions[partition].partition = partition;
    if (graph.nodes.empty()) return plan;

    const auto weights = nodeWeights(graph);
    const auto totalWeight = std::accumulate(weights.begin(), weights.end(), std::size_t{0});
    const auto targetWeight = static_cast<double>(totalWeight) / static_cast<double>(plan.effectivePartitions);
    const auto totalCommunication = std::accumulate(graph.dependencies.begin(), graph.dependencies.end(), std::size_t{0},
        [](std::size_t total, const auto& dependency) { return total + dependency.communicationWeight; });
    std::unordered_map<std::string, std::size_t> nodeIndexes;
    for (std::size_t index = 0; index < graph.nodes.size(); ++index) nodeIndexes[graph.nodes[index].nodeId] = index;
    std::vector<std::vector<std::pair<std::size_t, std::size_t>>> incidentDependencies(graph.nodes.size());
    for (const auto& dependency : graph.dependencies) {
        const auto source = nodeIndexes.at(dependency.sourceNodeId);
        const auto target = nodeIndexes.at(dependency.targetNodeId);
        incidentDependencies[source].push_back({target, dependency.communicationWeight});
        incidentDependencies[target].push_back({source, dependency.communicationWeight});
    }

    std::vector<std::size_t> order(graph.nodes.size());
    std::iota(order.begin(), order.end(), 0);
    std::stable_sort(order.begin(), order.end(), [&weights](std::size_t left, std::size_t right) {
        return weights[left] > weights[right];
    });
    const auto unassigned = std::numeric_limits<std::size_t>::max();
    std::vector<std::size_t> assignment(graph.nodes.size(), unassigned);
    std::vector<std::size_t> loads(plan.effectivePartitions, 0);
    for (const auto nodeIndex : order) {
        std::size_t selectedPartition = 0;
        std::size_t selectedIncrementalCut = std::numeric_limits<std::size_t>::max();
        double selectedScore = std::numeric_limits<double>::infinity();
        for (std::size_t partition = 0; partition < plan.effectivePartitions; ++partition) {
            std::size_t incrementalCut = 0;
            for (const auto& [other, communicationWeight] : incidentDependencies[nodeIndex]) {
                if (assignment[other] != unassigned && assignment[other] != partition) {
                    incrementalCut += communicationWeight;
                }
            }
            const auto balanceScore = static_cast<double>(loads[partition] + weights[nodeIndex]) / targetWeight;
            const auto communicationScore = totalCommunication
                ? communicationBias * static_cast<double>(incrementalCut) * static_cast<double>(plan.effectivePartitions) /
                    static_cast<double>(totalCommunication) : 0;
            const auto score = balanceScore + communicationScore;
            if (score < selectedScore - 1e-12 ||
                (std::abs(score - selectedScore) <= 1e-12 &&
                    (incrementalCut < selectedIncrementalCut ||
                     (incrementalCut == selectedIncrementalCut && loads[partition] < loads[selectedPartition])))) {
                selectedPartition = partition;
                selectedIncrementalCut = incrementalCut;
                selectedScore = score;
            }
        }
        assignment[nodeIndex] = selectedPartition;
        loads[selectedPartition] += weights[nodeIndex];
        ++plan.partitions[selectedPartition].nodeCount;
        plan.partitions[selectedPartition].computeWeight += weights[nodeIndex];
    }

    for (std::size_t index = 0; index < graph.nodes.size(); ++index) {
        plan.assignments.push_back({graph.nodes[index].nodeId, assignment[index]});
        plan.partitions[assignment[index]].localStateCount += graph.nodes[index].stateCount;
    }
    std::vector<std::unordered_set<std::string>> boundaryStates(plan.effectivePartitions);
    for (const auto& dependency : graph.dependencies) {
        const auto sourcePartition = assignment[nodeIndexes.at(dependency.sourceNodeId)];
        const auto targetPartition = assignment[nodeIndexes.at(dependency.targetNodeId)];
        if (sourcePartition == targetPartition) continue;
        boundaryStates[targetPartition].insert(dependency.remoteStateIds.begin(), dependency.remoteStateIds.end());
    }
    for (std::size_t partition = 0; partition < plan.effectivePartitions; ++partition) {
        plan.partitions[partition].boundaryStateCount = boundaryStates[partition].size();
    }
    plan.greedy = compareAssignment(graph, assignment, weights, plan.effectivePartitions);
    std::vector<std::size_t> roundRobin(graph.nodes.size());
    for (std::size_t index = 0; index < roundRobin.size(); ++index) roundRobin[index] = index % plan.effectivePartitions;
    plan.roundRobin = compareAssignment(graph, roundRobin, weights, plan.effectivePartitions);
    return plan;
}

}
