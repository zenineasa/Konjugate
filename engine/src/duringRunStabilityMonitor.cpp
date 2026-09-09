/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "duringRunStabilityMonitor.hpp"
#include "stabilityAnalysis.hpp"
#include <algorithm>
#include <cmath>
#include <sstream>

namespace konjugate {
namespace {

// Defaults chosen to match src/postRunStabilityDiagnostics.mjs's detectInstabilityFingerprint()
// exactly -- the same "sustained growth" definition, just evaluated incrementally (one step at a
// time) here instead of over an already-complete trajectory there.
constexpr double growthRatioThreshold = 1.05;
constexpr double negligibleDifference = 1e-9;
constexpr std::size_t minimumConsecutiveGrowthSteps = 4;

const NodeExecutionPlan* findNode(const ExecutionPlan& plan, EntityId nodeId) {
    const auto found = std::find_if(plan.nodes.begin(), plan.nodes.end(),
        [&](const auto& node) { return node.nodeId == nodeId; });
    return found == plan.nodes.end() ? nullptr : &*found;
}

}

DuringRunStabilityMonitor::DuringRunStabilityMonitor(
    const ExecutionPlan& plan, std::unordered_set<EntityId> monitoredNodeIds, double globalTimeStep, std::size_t tier2PerStepBudget)
    : plan_(plan), monitoredNodeIds_(std::move(monitoredNodeIds)), globalTimeStep_(globalTimeStep), tier2PerStepBudget_(tier2PerStepBudget) {}

std::vector<DuringRunStabilityFinding> DuringRunStabilityMonitor::observeGlobalStep(
    const StateValues& synchronizedStates, double globalTime) {
    std::vector<DuringRunStabilityFinding> findings;
    if (monitoredNodeIds_.empty()) return findings;

    for (const auto nodeId : monitoredNodeIds_) {
        const auto* node = findNode(plan_, nodeId);
        if (!node) continue;
        auto& nodeTrends = trendsByNode_[nodeId];
        bool crossedThisStep = false;

        for (std::size_t localIndex = 0; localIndex < node->stateIndexes.size(); ++localIndex) {
            const auto currentValue = synchronizedStates.at(node->stateIndexes[localIndex]);
            auto& trend = nodeTrends[localIndex];
            const auto difference = currentValue - trend.previousValue;
            const auto differenceMagnitude = std::abs(difference);

            if (trend.previousDifferenceMagnitude >= 0 && trend.previousDifferenceMagnitude > negligibleDifference) {
                if (differenceMagnitude > growthRatioThreshold * trend.previousDifferenceMagnitude) {
                    trend.consecutiveGrowthSteps += 1;
                } else {
                    trend.consecutiveGrowthSteps = 0;
                    trend.episodeAlreadyFlagged = false;
                }
            }
            trend.previousValue = currentValue;
            trend.previousDifferenceMagnitude = differenceMagnitude;

            if (trend.consecutiveGrowthSteps >= minimumConsecutiveGrowthSteps && !trend.episodeAlreadyFlagged) {
                trend.episodeAlreadyFlagged = true;
                crossedThisStep = true;
                std::ostringstream message;
                message << "This state has grown for " << trend.consecutiveGrowthSteps
                        << " consecutive global steps -- possible developing instability.";
                findings.push_back({nodeId, node->stateIds.at(localIndex), "duringRunGrowthTrend", message.str(), globalTime});
            }
        }

        if (crossedThisStep && std::find(pendingTier2Queue_.begin(), pendingTier2Queue_.end(), nodeId) == pendingTier2Queue_.end()) {
            pendingTier2Queue_.push_back(nodeId);
        }
    }

    // Tier 2: spend at most tier2PerStepBudget_ re-checks this call, FIFO, leaving the rest queued
    // for a later observeGlobalStep() call -- see this class's own header comment on cost bounding.
    std::size_t spent = 0;
    while (spent < tier2PerStepBudget_ && !pendingTier2Queue_.empty()) {
        const auto nodeId = pendingTier2Queue_.front();
        pendingTier2Queue_.erase(pendingTier2Queue_.begin());
        spent += 1;
        const auto* node = findNode(plan_, nodeId);
        if (!node) continue;
        const auto assessment = assessNodeStability(*node, synchronizedStates, globalTimeStep_);
        if (assessment && !assessment->stable) {
            std::ostringstream message;
            message << "This node's growth trend was confirmed by a re-check of its current dynamics: amplification factor "
                    << assessment->maxAmplificationFactor << " > 1 per global step at its current state.";
            findings.push_back({nodeId, 0, "duringRunPotentiallyUnstable", message.str(), globalTime});
        }
    }

    return findings;
}

}
