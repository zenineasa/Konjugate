/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "executionPlan.hpp"
#include "stabilityAnalysis.hpp"
#include <boost/property_tree/json_parser.hpp>
#include <cmath>
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

// dx/dt = -decayRate * x, a self-referencing equation source term -- the same exact-hand-verifiable
// shape used by tests/engine/postRunStabilityDiagnostics.mjs: Explicit Euler's stability condition
// for this scalar linear system is |1 - substepSize*decayRate| <= 1, i.e. substepSize*decayRate <= 2.
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

// Two decoupled decay states on the same node, with very different rates -- exercises the
// stiffness-ratio computation (fastest/slowest |Re(lambda)| among negative-real-part eigenvalues).
boost::property_tree::ptree twoDecayRatesProject(double slowRate, double fastRate, std::size_t substeps) {
    std::ostringstream json;
    json << R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "TwoRates",
            "states": [
                {"id": 11, "name": "Slow", "symbol": "slow", "initialValue": 1},
                {"id": 12, "name": "Fast", "symbol": "fast", "initialValue": 1}
            ],
            "sourceTerms": [
                {
                    "id": 21, "state": "slow", "expression": "-\\mathrm{slowRate} \\cdot \\mathrm{slow}",
                    "parameters": [{"id": 22, "name": "Slow rate", "symbol": "slowRate", "value": )json"
         << slowRate << R"json(, "mode": "constant"}],
                    "expressionModel": {
                        "latex": "-\\mathrm{slowRate} \\cdot \\mathrm{slow}", "output": {"stateId": 11},
                        "bindings": [
                            {"kind": "state", "stateId": 11, "symbol": "slow", "label": "slow"},
                            {"kind": "parameter", "parameterId": 22, "symbol": "slowRate", "label": "slowRate"}
                        ],
                        "mathJson": ["Multiply", ["Negate", "slowRate"], "slow"]
                    }
                },
                {
                    "id": 23, "state": "fast", "expression": "-\\mathrm{fastRate} \\cdot \\mathrm{fast}",
                    "parameters": [{"id": 24, "name": "Fast rate", "symbol": "fastRate", "value": )json"
         << fastRate << R"json(, "mode": "constant"}],
                    "expressionModel": {
                        "latex": "-\\mathrm{fastRate} \\cdot \\mathrm{fast}", "output": {"stateId": 12},
                        "bindings": [
                            {"kind": "state", "stateId": 12, "symbol": "fast", "label": "fast"},
                            {"kind": "parameter", "parameterId": 24, "symbol": "fastRate", "label": "fastRate"}
                        ],
                        "mathJson": ["Multiply", ["Negate", "fastRate"], "fast"]
                    }
                }
            ],
            "numerics": {"substepsPerGlobalStep": )json" << substeps << R"json(}
        }],
        "edges": []
    })json";
    return parseProject(json.str());
}

// y = 2x (algebraic, setsValue), dx/dt = -y -- coupling through the algebraic state should give
// the exact same eigenvalue as a direct dx/dt = -2x, proving the perturbation correctly re-runs
// applyAlgebraicTasks (not just evaluateContributionTasks) for each perturbed differential state.
boost::property_tree::ptree algebraicCouplingProject(std::size_t substeps) {
    return parseProject(R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "Coupled",
            "states": [
                {"id": 11, "name": "X", "symbol": "x", "initialValue": 1},
                {"id": 12, "name": "Y", "symbol": "y", "initialValue": 2}
            ],
            "sourceTerms": [
                {
                    "id": 21, "state": "y", "expression": "2 x", "setsValue": true,
                    "expressionModel": {
                        "latex": "2x", "output": {"stateId": 12},
                        "bindings": [{"kind": "state", "stateId": 11, "symbol": "x", "label": "x"}],
                        "mathJson": ["Multiply", 2, "x"]
                    }
                },
                {
                    "id": 22, "state": "x", "expression": "-y",
                    "expressionModel": {
                        "latex": "-y", "output": {"stateId": 11},
                        "bindings": [{"kind": "state", "stateId": 12, "symbol": "y", "label": "y"}],
                        "mathJson": ["Negate", "y"]
                    }
                }
            ],
            "numerics": {"substepsPerGlobalStep": )json" + std::to_string(substeps) + R"json(}
        }],
        "edges": []
    })json");
}

boost::property_tree::ptree programmableSourceTermProject() {
    return parseProject(R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "Programmable",
            "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 1}],
            "sourceTerms": [{
                "id": 21, "state": "x",
                "implementation": {
                    "kind": "cpp", "providerApiVersion": 1, "source": "// unused by this test",
                    "bindings": [{"key": "x", "kind": "state", "stateId": 11}],
                    "output": {"key": "gradient", "stateId": 11}
                }
            }]
        }],
        "edges": []
    })json");
}

// A two-node relaxation: dx/dt = rate*(sourceTemperature - targetTemperature), where
// sourceTemperature is a fixed (dynamics-free) neighbor and targetTemperature is the node under
// test's OWN state -- the destabilizing term here is an EDGE contribution, not a source term, and
// "Target" is the SECOND node declared, not the first. Regression fixture for a real bug this
// attribution feature's own test-writing surfaced: evaluateNodeDerivative used to look up a
// contribution's (already node-LOCAL) output index inside node.stateIndexes (a list of GLOBAL
// indices) as though it still needed translating, silently returning 0 for every node whose first
// state isn't also the document's global state 0 -- invisible in every single-node fixture above,
// where local and global indices coincide by construction.
boost::property_tree::ptree relaxationTowardSourceProject(double rate) {
    std::ostringstream json;
    json << R"json({
        "format": "konjugate", "version": 1,
        "nodes": [
            {"id": 1, "name": "Source", "states": [{"id": 11, "name": "Source temperature", "symbol": "sourceTemperature", "initialValue": 310}], "sourceTerms": []},
            {"id": 2, "name": "Target", "states": [{"id": 12, "name": "Target temperature", "symbol": "targetTemperature", "initialValue": 290}], "sourceTerms": []}
        ],
        "edges": [{
            "id": 3, "name": "Relaxation",
            "source": {"nodeId": 1, "stateId": 11}, "target": {"nodeId": 2, "stateId": 12},
            "parameters": [{"id": 13, "name": "Rate", "symbol": "rate", "value": )json" << rate << R"json(, "mode": "constant"}],
            "equation": "rate\\cdot(sourceTemperature-targetTemperature)",
            "equationModel": {
                "bindings": [
                    {"symbol": "sourceTemperature", "stateId": 11, "nodeId": 1},
                    {"symbol": "targetTemperature", "stateId": 12, "nodeId": 2},
                    {"symbol": "rate", "kind": "parameter", "parameterId": 13}
                ],
                "mathJson": ["Multiply", "rate", ["Add", "sourceTemperature", ["Negate", "targetTemperature"]]],
                "output": {"role": "target", "stateId": 12}
            }
        }]
    })json";
    return parseProject(json.str());
}

void assessNodeStabilityFlagsAnObviouslyUnstableDecay() {
    // decayRate=21, globalTimeStep=0.1, substeps=1 -> nodeStepSize*decayRate = 2.1, past the |1 -
    // stepSize*decayRate| <= 1 boundary (needs <= 2) -- the exact fixture
    // tests/engine/postRunStabilityDiagnostics.mjs uses for the post-run phase's own unstable case.
    const auto plan = konjugate::compileExecutionPlan(decayProject(21, 1));
    const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.1);
    require(assessment.has_value(), "A single-differential-state equation-only node should be assessed.");
    require(!assessment->stable, "decayRate*stepSize = 2.1 should be flagged unstable.");
    require(std::abs(assessment->maxAmplificationFactor - 1.1) < 1e-4,
        "The amplification factor for a scalar decay should be exactly |1 - stepSize*decayRate|.");
}

void assessNodeStabilityAcceptsTheSameDecayOnceSubsteppedEnough() {
    // Same decayRate*globalTimeStep product, but substeps=8 -> nodeStepSize*decayRate = 0.2625,
    // well inside the stability region.
    const auto plan = konjugate::compileExecutionPlan(decayProject(21, 8));
    const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.1);
    require(assessment.has_value(), "assessment expected");
    require(assessment->stable, "decayRate*stepSize well under 2 should be stable.");
}

void assessNodeStabilityComputesAStiffnessRatio() {
    const auto plan = konjugate::compileExecutionPlan(twoDecayRatesProject(10, 1000, 100));
    const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.1);
    require(assessment.has_value(), "assessment expected");
    require(assessment->stiffnessRatio.has_value(), "Two decoupled negative-real eigenvalues should produce a stiffness ratio.");
    require(std::abs(*assessment->stiffnessRatio - 100.0) < 1e-3,
        "The stiffness ratio of two decoupled decay rates should be exactly fastRate/slowRate.");
}

void assessNodeStabilityFollowsCouplingThroughAnAlgebraicState() {
    // y = 2x algebraically, dx/dt = -y ⇒ the effective eigenvalue for x is exactly -2, identical to
    // a direct dx/dt = -2x -- same instability threshold as decayProject(2, substeps).
    const auto unstablePlan = konjugate::compileExecutionPlan(algebraicCouplingProject(1));
    const auto unstableAssessment = konjugate::assessNodeStability(unstablePlan.nodes.at(0), unstablePlan.initialStates, 1.1);
    require(unstableAssessment.has_value(), "assessment expected");
    // nodeStepSize*|-2| = 1.1*2 = 2.2 > 2 -> unstable.
    require(!unstableAssessment->stable, "The algebraically-coupled effective rate of -2 should be unstable at this step size.");

    const auto stablePlan = konjugate::compileExecutionPlan(algebraicCouplingProject(4));
    const auto stableAssessment = konjugate::assessNodeStability(stablePlan.nodes.at(0), stablePlan.initialStates, 1.1);
    require(stableAssessment.has_value(), "assessment expected");
    require(stableAssessment->stable, "The same effective rate, substepped finer, should be stable.");
}

void assessNodeStabilitySkipsANodeWithNoDifferentialStates() {
    // A lone setsValue source term with no bindings back to itself has zero differential states on
    // this node -- nothing for Explicit Euler to integrate, so nothing to assess.
    const auto project = parseProject(R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "AlgebraicOnly",
            "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 5}],
            "sourceTerms": [{
                "id": 21, "state": "x", "expression": "5", "setsValue": true,
                "expressionModel": {"latex": "5", "output": {"stateId": 11}, "bindings": [], "mathJson": 5}
            }]
        }],
        "edges": []
    })json");
    const auto plan = konjugate::compileExecutionPlan(project);
    const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.1);
    require(!assessment.has_value(), "A node with only an algebraic state should not be assessed.");
}

void assessNodeStabilitySkipsAProgrammableNode() {
    const auto plan = konjugate::compileExecutionPlan(programmableSourceTermProject());
    const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.1);
    require(!assessment.has_value(), "A node with a programmable (non-equation) source term should not be assessed.");
}

void assessNodeStabilityAttributesTheDrivingParameter() {
    // Same fixture as assessNodeStabilityFlagsAnObviouslyUnstableDecay -- the only differential
    // state has exactly one candidate parameter (decayRate, id 22, owned by source term id 21).
    const auto plan = konjugate::compileExecutionPlan(decayProject(21, 1));
    const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.1);
    require(assessment.has_value(), "assessment expected");
    require(!assessment->stable, "assessment should be unstable");
    require(assessment->dominantParameter.has_value(), "The only candidate parameter should be attributed.");
    require(assessment->dominantParameter->sourceId == 21, "The dominant parameter's sourceId should be the source term's own id.");
    require(assessment->dominantParameter->parameterId == 22, "The dominant parameter's id should be decayRate's id.");
}

void assessNodeStabilityAttributesTheFasterOfTwoRates() {
    // Two decoupled states, slowRate=1 (amplification |1-0.1| = 0.9, stable) and fastRate=25
    // (amplification |1-2.5| = 1.5, unstable) -- the Jacobian here is diagonal, so the eigenvector
    // for the destabilizing eigenvalue is exactly a coordinate axis, isolating "fast" with no
    // ambiguity. Proves the eigenvector step correctly picks the actually-destabilizing state on a
    // non-trivial (two-state) node, not just the fixture's only state.
    const auto plan = konjugate::compileExecutionPlan(twoDecayRatesProject(1, 25, 1));
    const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.1);
    require(assessment.has_value(), "assessment expected");
    require(!assessment->stable, "The fast state alone should be enough to flag the node unstable.");
    require(assessment->dominantParameter.has_value(), "The fast state's own rate parameter should be attributed.");
    require(assessment->dominantParameter->sourceId == 23, "Attribution should point at the fast source term (id 23), not the slow one (id 21).");
    require(assessment->dominantParameter->parameterId == 24, "Attribution should point at fastRate (id 24), not slowRate (id 22).");
}

void assessNodeStabilityOmitsAttributionWithNoCandidateParameters() {
    // The destabilizing term here (dx/dt = -y) has no free parameter at all -- its coefficient is a
    // literal in the expression, not a bound parameter -- so there is nothing to attribute to.
    const auto plan = konjugate::compileExecutionPlan(algebraicCouplingProject(1));
    const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 1.1);
    require(assessment.has_value(), "assessment expected");
    require(!assessment->stable, "assessment should be unstable");
    require(!assessment->dominantParameter.has_value(), "A destabilizing term with no candidate parameter should not fabricate an attribution.");
}

void assessNodeStabilityHandlesANodeThatIsNotFirstInTheDocument() {
    // Regression test for the bug relaxationTowardSourceProject's own comment describes: this
    // exercises the SECOND node in the document, destabilized through an EDGE contribution (not a
    // source term) -- the shape that exposed evaluateNodeDerivative's local/global index bug, since
    // every fixture above only ever checks a document's first (and often only) node.
    const auto plan = konjugate::compileExecutionPlan(relaxationTowardSourceProject(21));
    const auto& target = plan.nodes.at(1);
    require(target.nodeId == 2, "This fixture's second compiled node should be Target (id 2).");
    const auto assessment = konjugate::assessNodeStability(target, plan.initialStates, 0.1);
    require(assessment.has_value(), "assessment expected");
    // nodeStepSize*rate = 0.1*21 = 2.1 > 2 -> amplification |1-2.1| = 1.1 > 1.
    require(!assessment->stable, "rate*stepSize = 2.1 should be flagged unstable, exactly like the single-node decay fixture.");
    require(std::abs(assessment->maxAmplificationFactor - 1.1) < 1e-4, "The amplification factor should be exactly |1 - stepSize*rate|.");
    require(assessment->dominantParameter.has_value(), "The edge's own rate parameter should be attributed.");
    require(assessment->dominantParameter->sourceId == 3, "Attribution should point at the edge (id 3).");
    require(assessment->dominantParameter->parameterId == 13, "Attribution should point at the edge's rate parameter (id 13).");
}

}

int main() {
    try {
        assessNodeStabilityFlagsAnObviouslyUnstableDecay();
        assessNodeStabilityAcceptsTheSameDecayOnceSubsteppedEnough();
        assessNodeStabilityComputesAStiffnessRatio();
        assessNodeStabilityFollowsCouplingThroughAnAlgebraicState();
        assessNodeStabilitySkipsANodeWithNoDifferentialStates();
        assessNodeStabilitySkipsAProgrammableNode();
        assessNodeStabilityAttributesTheDrivingParameter();
        assessNodeStabilityAttributesTheFasterOfTwoRates();
        assessNodeStabilityOmitsAttributionWithNoCandidateParameters();
        assessNodeStabilityHandlesANodeThatIsNotFirstInTheDocument();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "stabilityAnalysisTests failed: %s\n", error.what());
        return 1;
    }
    std::printf("stabilityAnalysisTests passed\n");
    return 0;
}
