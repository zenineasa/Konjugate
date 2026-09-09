/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "executionPlan.hpp"
#include <cstddef>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace konjugate {

struct DuringRunStabilityFinding {
    EntityId nodeId = 0;
    // The specific state a Tier-1 finding is about; 0 ("no state") for a Tier-2 finding, which is
    // about the node's dynamics as a whole (its Jacobian couples every differential state
    // together), not any one state in isolation. Left as a raw id, not a name -- this struct has
    // no access to the document's own display names, so resolving nodeId/stateId to something
    // human-readable is a caller (UI) concern, the same way ValidationIssueReport's entityId is.
    EntityId stateId = 0;
    // "duringRunGrowthTrend" (Tier 1, cheap: a state's own successive differences are growing
    // for several steps running) or "duringRunPotentiallyUnstable" (Tier 2, expensive: the
    // trend-triggered Jacobian/eigenvalue re-check, reusing assessNodeStability() at the node's
    // CURRENT state, actually confirmed the amplification factor exceeds 1).
    std::string code;
    std::string message;
    double globalTime = 0;
};

// During-run phase of docs/proposals/numericalStabilityDiagnostics.md: growth tracking (Tier 1,
// cheap, runs every step for every monitored node) plus a trend-gated re-check (Tier 2, expensive,
// only for a node Tier 1 just flagged, reusing the exact same assessNodeStability() the pre-run
// phase already uses -- see that function's own header comment for what it does and does not
// cover). Entirely opt-in: monitoredNodeIds is caller-supplied (from the run configuration's own
// `stabilityMonitoring.nodeIds`, parsed in simulationRunner.cpp) and empty by default, so a run
// that doesn't ask for this pays nothing at all -- not even the cost of an empty check, since
// observeGlobalStep() returns immediately when there is nothing to monitor.
//
// Cost bounding (see the parent proposal's "Bounding the during-run re-check's cost"): a node only
// becomes a Tier-2 candidate once its own Tier-1 growth trend crosses the threshold -- there is no
// fixed re-check schedule to begin with. Nodes that cross in the same step queue rather than all
// being checked at once: at most tier2PerStepBudget Tier-2 re-checks happen in any single
// observeGlobalStep() call, with the rest carried over to later calls in FIFO order.
class DuringRunStabilityMonitor {
public:
    DuringRunStabilityMonitor(const ExecutionPlan& plan, std::unordered_set<EntityId> monitoredNodeIds,
                              double globalTimeStep, std::size_t tier2PerStepBudget = 4);

    // Call once per completed global step, with that step's own settled state vector. Returns
    // whatever new findings (Tier 1 and/or Tier 2) this particular call produced -- never
    // re-reports a finding already returned by an earlier call for the same growth episode.
    std::vector<DuringRunStabilityFinding> observeGlobalStep(const StateValues& synchronizedStates, double globalTime);

private:
    struct StateTrend {
        double previousValue = 0;
        double previousDifferenceMagnitude = -1; // negative = "no previous difference yet"
        std::size_t consecutiveGrowthSteps = 0;
        // True from the step a growth episode first crosses the Tier-1 threshold until the trend
        // resets (consecutiveGrowthSteps drops back to 0) -- prevents re-flagging the same
        // ongoing episode, and Tier 2, every subsequent step while it continues.
        bool episodeAlreadyFlagged = false;
    };

    const ExecutionPlan& plan_;
    std::unordered_set<EntityId> monitoredNodeIds_;
    double globalTimeStep_;
    std::size_t tier2PerStepBudget_;
    // Keyed by (nodeId, local state index within that node).
    std::unordered_map<EntityId, std::unordered_map<std::size_t, StateTrend>> trendsByNode_;
    std::vector<EntityId> pendingTier2Queue_;
};

}
