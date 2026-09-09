/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "duringRunStabilityMonitor.hpp"
#include "executionPlan.hpp"
#include <algorithm>
#include <boost/property_tree/json_parser.hpp>
#include <cstdio>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

boost::property_tree::ptree parseProject(const std::string& json) {
    std::istringstream input(json);
    boost::property_tree::ptree project;
    boost::property_tree::read_json(input, project);
    return project;
}

// Same exact-hand-verifiable shape as stabilityAnalysisTests.cpp/tests/engine/postRunStabilityDiagnostics.mjs:
// dx/dt = -decayRate * x, Explicit Euler stable iff substepSize*decayRate <= 2.
boost::property_tree::ptree decayProject(double decayRate, std::size_t substeps) {
    std::ostringstream json;
    json << R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "Decay",
            "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 1}],
            "sourceTerms": [{
                "id": 21, "state": "x", "expression": "-\\mathrm{decayRate} \\cdot x",
                "parameters": [{"id": 22, "name": "Decay rate", "symbol": "decayRate", "value": )json"
         << decayRate << R"json(, "mode": "constant"}],
                "expressionModel": {
                    "latex": "-\\mathrm{decayRate} \\cdot x", "output": {"stateId": 11},
                    "bindings": [
                        {"kind": "state", "stateId": 11, "symbol": "x", "label": "x"},
                        {"kind": "parameter", "parameterId": 22, "symbol": "decayRate", "label": "decayRate"}
                    ],
                    "mathJson": ["Multiply", ["Negate", "decayRate"], "x"]
                }
            }],
            "numerics": {"substepsPerGlobalStep": )json" << substeps << R"json(}
        }],
        "edges": []
    })json";
    return parseProject(json.str());
}

// Drives real global steps through the exact same konjugate::integrateNode() simulationRunner.cpp
// itself calls, feeding each settled state into the monitor -- not hand-faked synthetic values --
// so this proves the monitor correctly detects a real unstable (or stable) run, not just a
// synthetic number sequence shaped like one.
std::vector<konjugate::DuringRunStabilityFinding> driveSteps(
    const konjugate::ExecutionPlan& plan, konjugate::DuringRunStabilityMonitor& monitor,
    double globalTimeStep, std::size_t stepCount) {
    std::vector<konjugate::DuringRunStabilityFinding> allFindings;
    auto states = plan.initialStates;
    for (std::size_t step = 0; step < stepCount; ++step) {
        for (const auto& node : plan.nodes) {
            const auto result = konjugate::integrateNode(node, states, {}, static_cast<double>(step) * globalTimeStep, globalTimeStep);
            for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) states.at(node.stateIndexes[index]) = result.states.at(index);
        }
        auto findings = monitor.observeGlobalStep(states, static_cast<double>(step + 1) * globalTimeStep);
        allFindings.insert(allFindings.end(), findings.begin(), findings.end());
    }
    return allFindings;
}

void monitorReportsNothingWhenNoNodesAreMonitored() {
    const auto plan = konjugate::compileExecutionPlan(decayProject(21, 1));
    konjugate::DuringRunStabilityMonitor monitor(plan, {}, 0.1);
    const auto findings = driveSteps(plan, monitor, 0.1, 20);
    require(findings.empty(), "An unmonitored run (the default) should never produce findings, however unstable the model.");
}

void monitorFlagsAGenuinelyUnstableMonitoredNode() {
    const auto plan = konjugate::compileExecutionPlan(decayProject(21, 1));
    konjugate::DuringRunStabilityMonitor monitor(plan, {1}, 0.1);
    const auto findings = driveSteps(plan, monitor, 0.1, 20);
    require(std::any_of(findings.begin(), findings.end(), [](const auto& finding) { return finding.code == "duringRunGrowthTrend"; }),
        "Tier 1 should flag the growing, sign-alternating trajectory of a genuinely unstable node.");
    require(std::any_of(findings.begin(), findings.end(), [](const auto& finding) { return finding.code == "duringRunPotentiallyUnstable"; }),
        "Tier 2, triggered by Tier 1, should confirm instability via a real assessNodeStability() re-check at the current state.");
}

void monitorStaysSilentForAStableMonitoredNode() {
    const auto plan = konjugate::compileExecutionPlan(decayProject(21, 8));
    konjugate::DuringRunStabilityMonitor monitor(plan, {1}, 0.1);
    const auto findings = driveSteps(plan, monitor, 0.1, 30);
    require(findings.empty(), "A stable, well-substepped node's smoothly-decaying trajectory should never trigger either tier.");
}

void monitorDoesNotReflagAnOngoingGrowthEpisodeEveryStep() {
    const auto plan = konjugate::compileExecutionPlan(decayProject(21, 1));
    konjugate::DuringRunStabilityMonitor monitor(plan, {1}, 0.1);
    const auto findings = driveSteps(plan, monitor, 0.1, 20);
    const auto growthFindingCount = std::count_if(findings.begin(), findings.end(),
        [](const auto& finding) { return finding.code == "duringRunGrowthTrend"; });
    require(growthFindingCount == 1,
        "The same ongoing growth episode should be reported once, not on every subsequent step while it continues (got " +
        std::to_string(growthFindingCount) + ").");
}

}

int main() {
    try {
        monitorReportsNothingWhenNoNodesAreMonitored();
        monitorFlagsAGenuinelyUnstableMonitoredNode();
        monitorStaysSilentForAStableMonitoredNode();
        monitorDoesNotReflagAnOngoingGrowthEpisodeEveryStep();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "duringRunStabilityMonitorTests failed: %s\n", error.what());
        return 1;
    }
    std::printf("duringRunStabilityMonitorTests passed\n");
    return 0;
}
