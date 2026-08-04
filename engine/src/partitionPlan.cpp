/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "partitionPlan.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <numeric>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

#ifndef KONJUGATE_HAS_METIS
#define KONJUGATE_HAS_METIS 0
#endif

#if KONJUGATE_HAS_METIS
#include <metis.h>
#endif

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

void populatePlanMetrics(PartitionPlan& plan,
                         const DependencyGraph& graph,
                         const std::vector<std::size_t>& assignment,
                         const std::vector<std::size_t>& weights) {
    plan.assignments.clear();
    plan.partitions.assign(plan.effectivePartitions, {});
    for (std::size_t partition = 0; partition < plan.partitions.size(); ++partition) {
        plan.partitions[partition].partition = partition;
    }
    std::unordered_map<std::string, std::size_t> nodeIndexes;
    for (std::size_t index = 0; index < graph.nodes.size(); ++index) {
        nodeIndexes[graph.nodes[index].nodeId] = index;
        plan.assignments.push_back({graph.nodes[index].nodeId, assignment[index]});
        auto& partition = plan.partitions[assignment[index]];
        ++partition.nodeCount;
        partition.computeWeight += weights[index];
        partition.localStateCount += graph.nodes[index].stateCount;
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
    plan.selected = compareAssignment(graph, assignment, weights, plan.effectivePartitions);
    std::vector<std::size_t> roundRobin(graph.nodes.size());
    for (std::size_t index = 0; index < roundRobin.size(); ++index) roundRobin[index] = index % plan.effectivePartitions;
    plan.roundRobin = compareAssignment(graph, roundRobin, weights, plan.effectivePartitions);
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
    if (graph.nodes.empty()) {
        plan.partitions.resize(plan.effectivePartitions);
        return plan;
    }

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
    }
    populatePlanMetrics(plan, graph, assignment, weights);
    plan.greedy = plan.selected;
    return plan;
}

bool metisPartitionerAvailable() noexcept {
    return KONJUGATE_HAS_METIS != 0;
}

std::string metisPartitionerVersion() {
#if KONJUGATE_HAS_METIS
    return std::to_string(METIS_VER_MAJOR) + "." + std::to_string(METIS_VER_MINOR) + "." +
        std::to_string(METIS_VER_SUBMINOR);
#else
    return {};
#endif
}

#if KONJUGATE_HAS_METIS
namespace {

std::vector<idx_t> metisWeights(const std::vector<std::size_t>& weights) {
    const auto maximum = *std::max_element(weights.begin(), weights.end());
    const auto safeMaximum = static_cast<std::size_t>(std::numeric_limits<idx_t>::max()) /
        std::max<std::size_t>(1, weights.size());
    const auto divisor = std::max<std::size_t>(1, maximum / std::max<std::size_t>(1, safeMaximum) +
        (maximum % std::max<std::size_t>(1, safeMaximum) ? 1 : 0));
    std::vector<idx_t> converted;
    converted.reserve(weights.size());
    for (const auto weight : weights) converted.push_back(static_cast<idx_t>(std::max<std::size_t>(1, weight / divisor)));
    return converted;
}

PartitionPlan createMetisPartitionPlan(const DependencyGraph& graph,
                                       std::size_t requestedPartitions,
                                       double communicationBias) {
    if (!requestedPartitions || requestedPartitions > 256) {
        throw std::runtime_error("Partition count must be an integer from 1 through 256.");
    }
    if (!(communicationBias >= 0) || !std::isfinite(communicationBias)) {
        throw std::runtime_error("Partition communication bias must be finite and non-negative.");
    }
    if (graph.nodes.size() > static_cast<std::size_t>(std::numeric_limits<idx_t>::max())) {
        throw std::runtime_error("The dependency graph is too large for this METIS build.");
    }
    PartitionPlan plan;
    plan.algorithm = "metisKway";
    plan.algorithmVersion = metisPartitionerVersion();
    plan.requestedPartitions = requestedPartitions;
    plan.effectivePartitions = std::min(requestedPartitions, std::max<std::size_t>(1, graph.nodes.size()));
    plan.communicationBias = communicationBias;
    if (graph.nodes.empty()) {
        plan.partitions.resize(plan.effectivePartitions);
        return plan;
    }

    const auto weights = nodeWeights(graph);
    if (plan.effectivePartitions == 1) {
        populatePlanMetrics(plan, graph, std::vector<std::size_t>(graph.nodes.size(), 0), weights);
        plan.greedy = plan.selected;
        return plan;
    }

    std::unordered_map<std::string, std::size_t> nodeIndexes;
    for (std::size_t index = 0; index < graph.nodes.size(); ++index) nodeIndexes[graph.nodes[index].nodeId] = index;
    std::map<std::pair<std::size_t, std::size_t>, std::size_t> undirectedEdges;
    for (const auto& dependency : graph.dependencies) {
        auto source = nodeIndexes.at(dependency.sourceNodeId);
        auto target = nodeIndexes.at(dependency.targetNodeId);
        if (source == target) continue;
        if (source > target) std::swap(source, target);
        undirectedEdges[{source, target}] += std::max<std::size_t>(1, dependency.communicationWeight);
    }
    std::vector<std::vector<std::pair<std::size_t, std::size_t>>> adjacency(graph.nodes.size());
    for (const auto& [edge, weight] : undirectedEdges) {
        adjacency[edge.first].push_back({edge.second, weight});
        adjacency[edge.second].push_back({edge.first, weight});
    }
    std::vector<idx_t> xadj(graph.nodes.size() + 1, 0);
    std::vector<idx_t> adjncy;
    std::vector<std::size_t> rawEdgeWeights;
    for (std::size_t node = 0; node < adjacency.size(); ++node) {
        xadj[node] = static_cast<idx_t>(adjncy.size());
        for (const auto& [other, weight] : adjacency[node]) {
            adjncy.push_back(static_cast<idx_t>(other));
            rawEdgeWeights.push_back(weight);
        }
    }
    xadj.back() = static_cast<idx_t>(adjncy.size());
    auto vertexWeights = metisWeights(weights);
    auto edgeWeights = rawEdgeWeights.empty() ? std::vector<idx_t>{} : metisWeights(rawEdgeWeights);
    idx_t nodeCount = static_cast<idx_t>(graph.nodes.size());
    idx_t constraints = 1;
    idx_t partitionCount = static_cast<idx_t>(plan.effectivePartitions);
    idx_t objective = 0;
    std::vector<idx_t> assignment(graph.nodes.size(), 0);
    idx_t options[METIS_NOPTIONS];
    METIS_SetDefaultOptions(options);
    options[METIS_OPTION_NUMBERING] = 0;
    options[METIS_OPTION_SEED] = 0;
    options[METIS_OPTION_NCUTS] = 1;
    const auto result = METIS_PartGraphKway(
        &nodeCount, &constraints, xadj.data(), adjncy.empty() ? nullptr : adjncy.data(), vertexWeights.data(), nullptr,
        edgeWeights.empty() ? nullptr : edgeWeights.data(), &partitionCount, nullptr, nullptr, options, &objective,
        assignment.data());
    if (result != METIS_OK) throw std::runtime_error("METIS could not partition the dependency graph.");

    std::vector<std::size_t> normalized(assignment.size());
    std::map<idx_t, std::size_t> partitionIndexes;
    for (std::size_t index = 0; index < assignment.size(); ++index) {
        const auto [iterator, inserted] = partitionIndexes.emplace(assignment[index], partitionIndexes.size());
        static_cast<void>(inserted);
        normalized[index] = iterator->second;
    }
    plan.effectivePartitions = partitionIndexes.size();
    populatePlanMetrics(plan, graph, normalized, weights);
    plan.greedy = createGreedyPartitionPlan(graph, plan.effectivePartitions, communicationBias).selected;
    return plan;
}

}
#endif

PartitionPlan createPartitionPlan(const DependencyGraph& graph,
                                  std::size_t requestedPartitions,
                                  double communicationBias,
                                  const std::string& requestedAlgorithm) {
    if (requestedAlgorithm != "automatic" && requestedAlgorithm != "communicationAwareGreedy" &&
        requestedAlgorithm != "metisKway") {
        throw std::runtime_error("Partition algorithm must be automatic, communicationAwareGreedy or metisKway.");
    }
    if (requestedAlgorithm == "communicationAwareGreedy") {
        auto plan = createGreedyPartitionPlan(graph, requestedPartitions, communicationBias);
        plan.requestedAlgorithm = requestedAlgorithm;
        return plan;
    }
#if KONJUGATE_HAS_METIS
    try {
        auto plan = createMetisPartitionPlan(graph, requestedPartitions, communicationBias);
        plan.requestedAlgorithm = requestedAlgorithm;
        return plan;
    } catch (...) {
        if (requestedAlgorithm == "metisKway") throw;
        auto plan = createGreedyPartitionPlan(graph, requestedPartitions, communicationBias);
        plan.requestedAlgorithm = requestedAlgorithm;
        plan.fallbackReason = "metisPartitioningFailed";
        return plan;
    }
#else
    if (requestedAlgorithm == "metisKway") {
        throw std::runtime_error("This Konjugate engine was built without METIS support.");
    }
    auto plan = createGreedyPartitionPlan(graph, requestedPartitions, communicationBias);
    plan.requestedAlgorithm = requestedAlgorithm;
    plan.fallbackReason = "metisUnavailable";
    return plan;
#endif
}

}
