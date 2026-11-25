/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "executionPlan.hpp"
#include "stabilityAnalysis.hpp"
#include "konjugate/integrators/dormandPrince54.hpp"
#include "konjugate/integrators/tsit5.hpp"
#include "konjugate/integrators/rodas4.hpp"
#include "konjugate/integrators/rodas5p.hpp"
#include "konjugate/integrators/bdf.hpp"
#include <Eigen/Dense>
#include <random>
#include <boost/property_tree/json_parser.hpp>
#include <cmath>
#include <complex>
#include <cstdio>
#include <numbers>
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

// Three states passing a conserved quantity round a ring -- a' = k(c - a), b' = k(a - b), c' = k(b - c),
// like trucks cycling through loaded, returning and idle -- plus, optionally, an unrelated fast decay
// d' = -fastRate * d. The ring's Jacobian has an exact zero eigenvalue (the conserved total) and a pair
// with real part -1.5k; a finite-difference Jacobian turns that zero into round-off of either sign.
boost::property_tree::ptree conservedRingProject(double rate, double fastRate) {
    std::ostringstream json;
    const auto term = [&](int id, const char* state, int stateId, const char* plus, int plusId, const char* minus, int minusId) {
        std::ostringstream out;
        out << R"json({"id": )json" << id << R"json(, "state": ")json" << state << R"json(", "expression": "\\mathrm{k} \\cdot ()json" << plus << " - " << minus << R"json()",
            "parameters": [{"id": )json" << id + 1 << R"json(, "name": "Rate", "symbol": "k", "value": )json" << rate << R"json(, "mode": "constant"}],
            "expressionModel": {
                "latex": "\\mathrm{k} \\cdot ()json" << plus << " - " << minus << R"json()", "output": {"stateId": )json" << stateId << R"json(},
                "bindings": [
                    {"kind": "state", "stateId": )json" << plusId << R"json(, "symbol": ")json" << plus << R"json(", "label": ")json" << plus << R"json("},
                    {"kind": "state", "stateId": )json" << minusId << R"json(, "symbol": ")json" << minus << R"json(", "label": ")json" << minus << R"json("},
                    {"kind": "parameter", "parameterId": )json" << id + 1 << R"json(, "symbol": "k", "label": "k"}
                ],
                "mathJson": ["Multiply", "k", ["Add", ")json" << plus << R"json(", ["Negate", ")json" << minus << R"json("]]]
            }})json";
        return out.str();
    };
    json << R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "Ring",
            "states": [
                {"id": 11, "name": "A", "symbol": "a", "initialValue": 46.7},
                {"id": 12, "name": "B", "symbol": "b", "initialValue": 70},
                {"id": 13, "name": "C", "symbol": "c", "initialValue": 30.3})json"
         << (fastRate > 0 ? R"json(, {"id": 14, "name": "D", "symbol": "d", "initialValue": 1})json" : "") << R"json(
            ],
            "sourceTerms": [)json" << term(21, "a", 11, "c", 13, "a", 11) << ", " << term(23, "b", 12, "a", 11, "b", 12) << ", " << term(25, "c", 13, "b", 12, "c", 13);
    if (fastRate > 0) {
        json << R"json(, {"id": 27, "state": "d", "expression": "-\\mathrm{f} \\cdot d",
            "parameters": [{"id": 28, "name": "Fast rate", "symbol": "f", "value": )json" << fastRate << R"json(, "mode": "constant"}],
            "expressionModel": {
                "latex": "-\\mathrm{f} \\cdot d", "output": {"stateId": 14},
                "bindings": [
                    {"kind": "state", "stateId": 14, "symbol": "d", "label": "d"},
                    {"kind": "parameter", "parameterId": 28, "symbol": "f", "label": "f"}
                ],
                "mathJson": ["Multiply", ["Negate", "f"], "d"]
            }})json";
    }
    json << R"json(],
            "numerics": {"substepsPerGlobalStep": 1}
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

void assessNodeStabilityIgnoresAConservedQuantityWhenJudgingStiffness() {
    // A conserved total is a zero-rate mode, not a slow one: it neither decays nor needs a small step.
    // Treating its round-off as a tiny negative rate reported ratios of 1e15 and more on every such node.
    for (const auto rate : {1.0 / 17280, 0.37, 3.0}) {
        const auto plan = konjugate::compileExecutionPlan(conservedRingProject(rate, 0));
        const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.01 / rate);
        require(assessment.has_value(), "assessment expected");
        require(assessment->stable, "The ring is stable at this step size.");
        require(!assessment->stiffnessRatio.has_value() || *assessment->stiffnessRatio < 1.01,
            "A conserved ring's decaying modes share one rate, so it is not stiff (got a ratio of " + std::to_string(assessment->stiffnessRatio.value_or(0)) + ").");
    }
}

void assessNodeStabilityStillReportsStiffnessBesideAConservedQuantity() {
    const auto plan = konjugate::compileExecutionPlan(conservedRingProject(0.37, 555));
    const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.001);
    require(assessment.has_value(), "assessment expected");
    require(assessment->stiffnessRatio.has_value(), "A fast decay beside the ring is still stiff.");
    // Fastest 555, slowest the ring's decaying pair at 1.5 x 0.37.
    require(std::abs(*assessment->stiffnessRatio - 555 / (1.5 * 0.37)) < 1e-3 * 555 / (1.5 * 0.37),
        "The ratio compares the fast decay with the ring's decaying modes (got " + std::to_string(*assessment->stiffnessRatio) + ").");
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

void assessNodeStabilityLeavesOutStatesAnAlgebraicRelationshipSets() {
    // B's only state is set by the relationship from A, so it has nothing Explicit Euler steps; told which states
    // relationships set, the check leaves it out (a toolbox's node may hold hundreds of them).
    const auto project = parseProject(R"json({
        "format": "konjugate", "version": 1,
        "nodes": [
            {"id": 1, "name": "A", "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 1}], "sourceTerms": []},
            {"id": 2, "name": "B", "states": [{"id": 21, "name": "Y", "symbol": "y", "initialValue": 0}], "sourceTerms": []}
        ],
        "edges": [{"id": 5, "name": "Set", "directionality": "directed", "source": {"nodeId": 1}, "target": {"nodeId": 2}, "parameters": [],
            "equationModel": {"bindings": [{"symbol": "x", "kind": "state", "role": "source", "nodeId": 1, "stateId": 11}],
                              "outputs": [{"role": "target", "stateId": 21, "mathJson": ["Multiply", 2, "x"], "setsValue": true}]}}]
    })json");
    const auto plan = konjugate::compileExecutionPlan(project);
    const auto& node = plan.nodes.at(0).nodeId == 2 ? plan.nodes.at(0) : plan.nodes.at(1);
    require(!konjugate::assessNodeStability(node, plan.initialStates, 0.1, plan.algebraicStateIndexes).has_value(),
        "A node whose only state a relationship sets should not be assessed.");
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
    require(assessment->dominantStateId == 12, "The dominant state should be Target's own state (id 12).");
    require(!assessment->unconditionallyUnstable, "A real negative eigenvalue always has a finite stabilizing step size.");
    require(assessment->requiredSubsteps.has_value(), "requiredSubsteps expected");
    // Jacobian entry is exactly -rate = -21 (real) -> stepSizeBound = -2*(-21)/21^2 = 2/21 ≈
    // 0.095238 -> ceil(0.1 / 0.095238) = ceil(1.05) = 2, same as the single-node decay case below.
    require(*assessment->requiredSubsteps == 2, "requiredSubsteps should match the hand-computed bound.");
}

// A state nothing contributes to has a rate of exactly zero: it is left out of the Jacobian, and counted as the zero
// eigenvalue it is (an amplification of exactly 1), so a node of such states alone is stable, as its zero Jacobian
// would have it; and beside one that is not, the assessment is as it was.
void assessNodeStabilityCountsAStateNothingContributesToAsAZero() {
    const auto plan = konjugate::compileExecutionPlan(relaxationTowardSourceProject(30));
    const auto source = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.1);
    require(source.has_value(), "A node whose state nothing changes is still assessed.");
    require(source->stable && source->maxAmplificationFactor == 1, "Its one zero amplifies by exactly 1.");
    const auto target = konjugate::assessNodeStability(plan.nodes.at(1), plan.initialStates, 0.1);
    require(target.has_value() && !target->stable && std::abs(target->maxAmplificationFactor - 2) < 1e-4,
        "The relaxation's own state, |1 - 0.1 x 30| = 2, is assessed as before.");
}

void assessNodeStabilityComputesRequiredSubsteps() {
    // Same fixture as assessNodeStabilityFlagsAnObviouslyUnstableDecay: a real eigenvalue of -21.
    // stepSizeBound = -2*(-21)/21^2 = 2/21 ≈ 0.095238 -> ceil(0.1 / 0.095238) = ceil(1.05) = 2.
    const auto plan = konjugate::compileExecutionPlan(decayProject(21, 1));
    const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.1);
    require(assessment.has_value(), "assessment expected");
    require(!assessment->stable, "assessment should be unstable");
    require(!assessment->unconditionallyUnstable, "A real negative eigenvalue always has a finite stabilizing step size.");
    require(assessment->requiredSubsteps.has_value(), "requiredSubsteps expected");
    require(*assessment->requiredSubsteps == 2, "requiredSubsteps should match the hand-computed bound.");
}

void assessNodeStabilityFlagsUnconditionalInstability() {
    // dx/dt = +growthRate*x -- a positive real eigenvalue. Explicit Euler's amplification
    // |1+h*growthRate| is >= 1 for every h > 0, so no substep count -- however large -- ever
    // stabilizes this: a genuinely growing mode, not merely an under-resolved one.
    const auto project = parseProject(R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "Growth",
            "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 1}],
            "sourceTerms": [{
                "id": 21, "state": "x", "expression": "\\mathrm{growthRate} \\cdot x",
                "parameters": [{"id": 22, "name": "Growth rate", "symbol": "growthRate", "value": 5, "mode": "constant"}],
                "expressionModel": {
                    "latex": "\\mathrm{growthRate} \\cdot x", "output": {"stateId": 11},
                    "bindings": [
                        {"kind": "state", "stateId": 11, "symbol": "x", "label": "x"},
                        {"kind": "parameter", "parameterId": 22, "symbol": "growthRate", "label": "growthRate"}
                    ],
                    "mathJson": ["Multiply", "growthRate", "x"]
                }
            }],
            "numerics": {"substepsPerGlobalStep": 1}
        }],
        "edges": []
    })json");
    const auto plan = konjugate::compileExecutionPlan(project);
    const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.1);
    require(assessment.has_value(), "assessment expected");
    require(!assessment->stable, "A positive real eigenvalue should always be flagged unstable.");
    require(assessment->unconditionallyUnstable, "A positive real eigenvalue has no finite stabilizing step size.");
    require(!assessment->requiredSubsteps.has_value(), "unconditionallyUnstable and requiredSubsteps are mutually exclusive.");
}


// Runge–Kutta 4's stability function is the degree-4 Taylor polynomial of e^z, and its region reaches about 2.785 along the
// negative real axis and 2 sqrt(2) along the imaginary axis (Hairer and Wanner, Solving ODEs II, IV.2).
void rungeKutta4StabilityFunctionIsTheTaylorPolynomial() {
    using konjugate::rungeKutta4StabilityFunction;
    for (const std::complex<double> z : {std::complex<double>{-1.0, 0.0}, {0.3, -2.0}, {-2.5, 1.5}}) {
        const auto expected = 1.0 + z + z * z / 2.0 + z * z * z / 6.0 + z * z * z * z / 24.0;
        require(std::abs(rungeKutta4StabilityFunction(z) - expected) < 1e-14, "R(z) must be 1 + z + z^2/2 + z^3/6 + z^4/24.");
    }
    require(std::abs(konjugate::rungeKutta4LargestStableStep({-1.0, 0.0}) - 2.785293563405282) < 1e-9, "The real-axis bound must be 2.7853.");
    require(std::abs(konjugate::rungeKutta4LargestStableStep({0.0, 1.0}) - 2.0 * std::sqrt(2.0)) < 1e-9, "The imaginary-axis bound must be 2 sqrt 2.");
    require(std::abs(konjugate::rungeKutta4LargestStableStep({-10.0, 0.0}) - 0.2785293563405282) < 1e-10, "The bound must scale with 1 / |lambda|.");
    require(konjugate::rungeKutta4LargestStableStep({0.5, 0.0}) == 0, "A growing mode has no stable step.");
}

// Dormand–Prince 5(4)'s fifth-order solution: R(z) is the Taylor polynomial to z^5 plus z^6 / 600, and its region reaches 3.3066 along
// the negative real axis.
void dormandPrince54StabilityFunctionIsItsPolynomial() {
    using konjugate::dormandPrince54StabilityFunction;
    for (const std::complex<double> z : {std::complex<double>{-1.0, 0.0}, {0.3, -2.0}, {-2.5, 1.5}}) {
        const auto expected = 1.0 + z + z * z / 2.0 + z * z * z / 6.0 + z * z * z * z / 24.0 + z * z * z * z * z / 120.0 + z * z * z * z * z * z / 600.0;
        require(std::abs(dormandPrince54StabilityFunction(z) - expected) < 1e-13, "R(z) must be the Taylor polynomial to z^5 plus z^6/600.");
    }
    require(std::abs(konjugate::dormandPrince54LargestStableStep({-1.0, 0.0}) - 3.306567892634945) < 1e-9, "The real-axis bound must be 3.3066.");
    require(konjugate::dormandPrince54LargestStableStep({0.5, 0.0}) == 0, "A growing mode has no stable step.");
}

// Dormand–Prince 5(4)'s dense output, a continuous extension of order four: within one step from the exact solution, its error at the
// step's middle falls about 32-fold (local order five) per halving of the step. Kept for event location; it writes no samples.
void dormandPrince54DenseOutputIsFourthOrder() {
    // y' = -y + sin 3t, y(0) = 1: y = 1.3 e^-t + (sin 3t - 3 cos 3t) / 10.
    const auto exact = [](double t) { return (1.3 * std::exp(-t)) + (std::sin(3.0 * t) - 3.0 * std::cos(3.0 * t)) / 10.0; };
    const auto evaluate = [](std::size_t, double t, const std::vector<double>& y, std::vector<double>& rates) { rates[0] = -y[0] + std::sin(3.0 * t); };
    double previous = 0;
    for (const double step : {0.2, 0.1, 0.05, 0.025}) {
        std::vector<double> states{exact(0.0)};
        konjugate::integrators::DormandPrince54Controller controller;
        konjugate::integrators::DormandPrince54Stiffness stiffness;
        konjugate::integrators::DormandPrince54Statistics statistics;
        konjugate::integrators::DormandPrince54Tolerance tolerance{1e-6, {1e-9}};
        double middle = 0;
        konjugate::integrators::dormandPrince54GlobalStep(0.0, step, states, {1}, {{0}}, tolerance, {}, {step / 2}, 1, controller, stiffness, statistics,
            evaluate, [&](double, const std::vector<double>& values) { middle = values[0]; });
        const double error = std::abs(middle - exact(step / 2));
        if (previous > 0) require(previous / error > 24 && previous / error < 40, "The dense output's error must fall about 32-fold per halving.");
        previous = error;
    }
}

// Tsit5's fifth-order solution: R(z) agrees with e^z to z^5 (order five), and its region reaches 3.5069 along the negative real axis,
// further than Dormand–Prince's 3.3066.
void tsit5StabilityFunctionIsFifthOrder() {
    for (const std::complex<double> z : {std::complex<double>{-0.05, 0.0}, {0.01, -0.04}}) {
        const auto taylor = 1.0 + z + z * z / 2.0 + z * z * z / 6.0 + z * z * z * z / 24.0 + z * z * z * z * z / 120.0;
        require(std::abs(konjugate::tsit5StabilityFunction(z) - taylor) < 0.01 * std::pow(std::abs(z), 6.0),
            "R(z) must agree with e^z to z^5.");
    }
    require(std::abs(konjugate::tsit5LargestStableStep({-1.0, 0.0}) - 3.5069) < 1e-3, "The real-axis bound must be 3.5069.");
    require(konjugate::tsit5LargestStableStep({0.5, 0.0}) == 0, "A growing mode has no stable step.");
}

// Tsit5 at fixed steps is of order five; its dense output, of order four, falls about 32-fold (local order five) per halving at a step's
// middle; and adaptive, it keeps a smooth model within its tolerance, more accurately than Dormand–Prince 5(4) at the same tolerance.
void tsit5IsFifthOrderWithAFourthOrderDenseOutput() {
    namespace integrators = konjugate::integrators;
    // y' = -y + sin 3t, y(0) = 1: y = 1.3 e^-t + (sin 3t - 3 cos 3t) / 10.
    const auto exact = [](double t) { return (1.3 * std::exp(-t)) + (std::sin(3.0 * t) - 3.0 * std::cos(3.0 * t)) / 10.0; };
    const auto evaluate = [](std::size_t, double t, const std::vector<double>& y, std::vector<double>& rates) { rates[0] = -y[0] + std::sin(3.0 * t); };
    const auto none = [](double, const std::vector<double>&) {};
    double previous = 0;
    // From 16 steps on (coarser, the order is not yet settled: 3.0 from 4 to 8 steps, 4.6 from 8 to 16).
    for (const std::size_t steps : {std::size_t{16}, std::size_t{32}, std::size_t{64}}) {
        std::vector<double> states{exact(0.0)};
        integrators::Tsit5Controller controller;
        integrators::Tsit5Stiffness stiffness;
        integrators::Tsit5Statistics statistics;
        integrators::Tsit5Tolerance tolerance{1e-6, {1e-9}};
        integrators::tsit5GlobalStep(0.0, 2.0, states, {1}, {{0}}, tolerance, {}, {}, steps, controller, stiffness, statistics, evaluate, none);
        const double error = std::abs(states[0] - exact(2.0));
        if (previous > 0) {
            const double order = std::log2(previous / error);
            require(order > 4.7 && order < 5.5, "Tsit5 must be of order five (observed " + std::to_string(order) + ").");
        }
        previous = error;
    }
    previous = 0;
    for (const double step : {0.2, 0.1, 0.05, 0.025}) {
        std::vector<double> states{exact(0.0)};
        integrators::Tsit5Controller controller;
        integrators::Tsit5Stiffness stiffness;
        integrators::Tsit5Statistics statistics;
        integrators::Tsit5Tolerance tolerance{1e-6, {1e-9}};
        double middle = 0;
        integrators::tsit5GlobalStep(0.0, step, states, {1}, {{0}}, tolerance, {}, {step / 2}, 1, controller, stiffness, statistics,
            evaluate, [&](double, const std::vector<double>& values) { middle = values[0]; });
        const double error = std::abs(middle - exact(step / 2));
        if (previous > 0) require(previous / error > 24 && previous / error < 40, "The dense output's error must fall about 32-fold per halving.");
        previous = error;
    }
    // Adaptive over 0 to 20 s at 1e-8, against Dormand–Prince 5(4) at the same tolerance.
    const auto adaptive = [&](bool tsit5, std::size_t& steps) {
        std::vector<double> states{exact(0.0)};
        integrators::DormandPrince54Controller controller;
        integrators::DormandPrince54Stiffness stiffness;
        integrators::DormandPrince54Statistics statistics;
        integrators::DormandPrince54Tolerance tolerance{1e-8, {1e-10}};
        if (tsit5) integrators::tsit5GlobalStep(0.0, 20.0, states, {1}, {{0}}, tolerance, {}, {}, 0, controller, stiffness, statistics, evaluate, none);
        else integrators::dormandPrince54GlobalStep(0.0, 20.0, states, {1}, {{0}}, tolerance, {}, {}, 0, controller, stiffness, statistics, evaluate, none);
        steps = statistics.acceptedSteps;
        return std::abs(states[0] - exact(20.0));
    };
    std::size_t tsit5Steps = 0, dormandPrinceSteps = 0;
    const double tsit5Error = adaptive(true, tsit5Steps);
    const double dormandPrinceError = adaptive(false, dormandPrinceSteps);
    require(tsit5Error < 1e-7, "Tsit5 must keep the model within its tolerance (error " + std::to_string(tsit5Error) + ").");
    // Its embedded estimate is the more cautious: here it takes 17 % more steps than Dormand–Prince 5(4), for an error 1.4 times smaller.
    require(tsit5Error < dormandPrinceError, "Tsit5 must be more accurate than Dormand–Prince 5(4) at the same tolerance.");
    require(10 * tsit5Steps <= 13 * dormandPrinceSteps, "Tsit5 must take at most 1.3 times Dormand–Prince 5(4)'s steps (" + std::to_string(tsit5Steps) +
        " against " + std::to_string(dormandPrinceSteps) + ").");
}

// An undamped oscillator split over two nodes, x' = v and v' = -omega^2 x, each written as a relationship from the other node.
boost::property_tree::ptree splitOscillatorProject(double omegaSquared) {
    std::ostringstream json;
    json << R"json({
        "format": "konjugate", "version": 1,
        "nodes": [
            {"id": 1, "name": "Position", "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 1}], "sourceTerms": []},
            {"id": 2, "name": "Velocity", "states": [{"id": 21, "name": "V", "symbol": "v", "initialValue": 0}], "sourceTerms": []}
        ],
        "edges": [
            {"id": 31, "name": "Moves", "source": {"nodeId": 2, "stateId": 21}, "target": {"nodeId": 1, "stateId": 11}, "directionality": "directed",
             "parameters": [], "equationModel": {"latex": "v", "output": {"role": "target", "stateId": 11},
             "bindings": [{"kind": "state", "nodeId": 2, "stateId": 21, "symbol": "v"}], "mathJson": "v"}},
            {"id": 32, "name": "Pulls", "source": {"nodeId": 1, "stateId": 11}, "target": {"nodeId": 2, "stateId": 21}, "directionality": "directed",
             "parameters": [], "equationModel": {"latex": "-k x", "output": {"role": "target", "stateId": 21},
             "bindings": [{"kind": "state", "nodeId": 1, "stateId": 11, "symbol": "x"}], "mathJson": ["Multiply", ")json" << -omegaSquared << R"json(", "x"]}}
        ]
    })json";
    return parseProject(json.str());
}

// The whole model's Jacobian holds the coupling a node's own leaves out: the split oscillator's eigenvalues +-i omega appear only
// across the two nodes. Runge–Kutta 4 is stable for h omega up to 2 sqrt 2, and the assessment says how many steps per global step
// keep within it.
void assessWholeModelStabilityJudgesTheCouplingWithTheMethodsRegion() {
    const auto plan = konjugate::compileExecutionPlan(splitOscillatorProject(4.0));
    for (const auto& node : plan.nodes) {
        const auto alone = konjugate::assessNodeStability(node, plan.initialStates, 0.1, plan.algebraicStateIndexes);
        require(alone && alone->stable, "Each node alone has no dynamics of its own to be unstable.");
    }
    const auto stable = konjugate::assessWholeModelStability(plan, plan.initialStates, 1.0, 1);
    require(stable && stable->stable && !stable->perNode, "h omega = 2 is inside Runge–Kutta 4's region.");
    require(stable->maxAmplificationFactor < 1, "Runge–Kutta 4 damps an undamped oscillation slightly.");
    const auto unstable = konjugate::assessWholeModelStability(plan, plan.initialStates, 2.0, 1);
    require(unstable && !unstable->stable && !unstable->unconditionallyUnstable, "h omega = 4 is outside the region.");
    require(std::abs(*unstable->largestStableStep - std::sqrt(2.0)) < 1e-6, "The largest stable step must be 2 sqrt 2 / omega.");
    require(*unstable->requiredStepsPerGlobalStep == 2, "Two steps per global step must be recommended.");
    const auto split = konjugate::assessWholeModelStability(plan, plan.initialStates, 2.0, 2);
    require(split && split->stable, "Two steps per global step must make it stable.");
    const auto judgedApart = konjugate::assessWholeModelStability(plan, plan.initialStates, 2.0, 1, 1);
    require(judgedApart && judgedApart->perNode && judgedApart->stable, "Above the dense limit, each node is judged on its own.");
}


// Rodas4 is L-stable (docs/proposals/integrators.md): |R(z)| <= 1 over the left half-plane, R -> 0 far into it, and R(z) agrees with
// exp(z) to fourth order near 0.
void rodas4StabilityFunctionIsLStableAndFourthOrder() {
    for (const double radius : {0.1, 1.0, 10.0, 1e3, 1e6}) {
        for (int angle = 0; angle <= 180; ++angle) {
            const double theta = std::numbers::pi / 2 + std::numbers::pi * angle / 180.0;
            const auto z = std::polar(radius, theta);
            require(std::abs(konjugate::rodas4StabilityFunction(z)) <= 1.0 + 1e-12, "Rodas4 must be A-stable.");
        }
    }
    require(std::abs(konjugate::rodas4StabilityFunction({-1e8, 0})) < 1e-6, "Rodas4 must be L-stable: R(-infinity) = 0.");
    const double error1 = std::abs(konjugate::rodas4StabilityFunction({-0.01, 0}) - std::exp(-0.01));
    const double error2 = std::abs(konjugate::rodas4StabilityFunction({-0.005, 0}) - std::exp(-0.005));
    require(std::log2(error1 / error2) > 4.8, "R(z) - exp(z) must be O(z^5): Rodas4 is of order four.");
    require(std::isinf(konjugate::rodas4LargestStableStep({-1e9, 3.0})) && konjugate::rodas4LargestStableStep({0.5, 0}) == 0,
        "Rodas4 has no step limit for a decaying mode, and none can hold a growing one.");
}

// Konjugate's own LU, dense and sparse, against Eigen's (the reference the tests check it against, not the implementation), on a
// sparse, unsymmetric matrix of the shape Rodas4 factorises; and the colouring never puts two columns sharing a row in one colour.
void ownLinearSolveAgreesWithEigen() {
    namespace integrators = konjugate::integrators;
    std::mt19937 generator(7);
    std::uniform_real_distribution<double> uniform(-1.0, 1.0);
    for (const std::size_t size : {std::size_t{5}, std::size_t{60}, std::size_t{400}}) {
        integrators::SparsityRows rows(size);
        for (std::size_t row = 0; row < size; ++row) {
            std::set<std::size_t> columns{row, (row + 1) % size, (row * 13 + 5) % size};
            rows[row].assign(columns.begin(), columns.end());
        }
        Eigen::MatrixXd matrix = Eigen::MatrixXd::Zero(static_cast<Eigen::Index>(size), static_cast<Eigen::Index>(size));
        std::vector<double> entries;
        std::vector<double> dense(size * size, 0.0);
        for (std::size_t row = 0; row < size; ++row) {
            for (const auto column : rows[row]) {
                // Rows of a third of the matrix have off-diagonal entries far larger than their diagonal, as a state whose rate many
                // others feed has, so partial pivoting interchanges rows.
                const double value = (row == column ? 4.0 : (row % 3 == 0 ? 50.0 : 0.0)) + uniform(generator);
                entries.push_back(value);
                dense[row * size + column] = value;
                matrix(static_cast<Eigen::Index>(row), static_cast<Eigen::Index>(column)) = value;
            }
        }
        std::vector<double> right(size);
        Eigen::VectorXd eigenRight(static_cast<Eigen::Index>(size));
        for (std::size_t index = 0; index < size; ++index) eigenRight(static_cast<Eigen::Index>(index)) = right[index] = uniform(generator);
        const Eigen::VectorXd expected = matrix.partialPivLu().solve(eigenRight);
        integrators::DenseLu denseLu;
        require(denseLu.factor(dense, size), "The dense LU must factorise a regular matrix.");
        auto fromDense = right;
        denseLu.solve(fromDense);
        // The sparse LU pivots on the diagonal: where a pivot is too small it says so (the stiff method then solves densely), and
        // otherwise agrees.
        integrators::SparseLu sparseLu;
        sparseLu.analyse(rows);
        auto fromSparse = fromDense;
        if (sparseLu.factor(entries)) {
            fromSparse = right;
            sparseLu.solve(fromSparse);
        }
        for (std::size_t index = 0; index < size; ++index) {
            const double reference = expected(static_cast<Eigen::Index>(index));
            require(std::abs(fromDense[index] - reference) <= 1e-10 * (1 + std::abs(reference)), "The dense LU must agree with Eigen's.");
            require(std::abs(fromSparse[index] - reference) <= 1e-10 * (1 + std::abs(reference)), "The sparse LU must agree with Eigen's.");
        }
        std::size_t colours = 0;
        const auto colour = integrators::colourColumns(rows, colours);
        for (const auto& columns : rows) {
            for (std::size_t first = 0; first < columns.size(); ++first) {
                for (std::size_t second = first + 1; second < columns.size(); ++second) {
                    require(colour[columns[first]] != colour[columns[second]], "Two columns sharing a row must not share a colour.");
                }
            }
        }
        require(colours <= 9, "A pattern with three entries a row needs only a few colours.");
    }
    // On a diagonally dominant matrix, the stiff method's usual case, the sparse LU factorises and agrees with Eigen.
    {
        const std::size_t size = 300;
        integrators::SparsityRows rows(size);
        Eigen::MatrixXd matrix = Eigen::MatrixXd::Zero(size, size);
        std::vector<double> entries;
        for (std::size_t row = 0; row < size; ++row) {
            std::set<std::size_t> columns{row, (row + 7) % size, (row * 11 + 3) % size};
            rows[row].assign(columns.begin(), columns.end());
            for (const auto column : rows[row]) {
                const double value = (row == column ? 6.0 : 0.0) + uniform(generator);
                entries.push_back(value);
                matrix(static_cast<Eigen::Index>(row), static_cast<Eigen::Index>(column)) = value;
            }
        }
        Eigen::VectorXd eigenRight = Eigen::VectorXd::LinSpaced(static_cast<Eigen::Index>(size), -1.0, 1.0);
        const Eigen::VectorXd expected = matrix.partialPivLu().solve(eigenRight);
        integrators::SparseLu sparseLu;
        sparseLu.analyse(rows);
        require(sparseLu.factor(entries), "The sparse LU must factorise a diagonally dominant matrix.");
        std::vector<double> values(eigenRight.data(), eigenRight.data() + size);
        sparseLu.solve(values);
        for (std::size_t index = 0; index < size; ++index) {
            require(std::abs(values[index] - expected(static_cast<Eigen::Index>(index))) <= 1e-12, "The sparse LU must agree with Eigen's.");
        }
    }
    // A singular matrix is said to be so, not solved.
    integrators::DenseLu singular;
    require(!singular.factor({1.0, 2.0, 2.0, 4.0}, 2), "A singular matrix must not factorise.");
}

// Rodas4 at fixed steps is of order four on a smooth problem whose Jacobian is not constant, its finite differences included.
void rodas4IsFourthOrderAtFixedSteps() {
    namespace integrators = konjugate::integrators;
    const auto run = [](std::size_t steps) {
        auto system = integrators::makeRodas4System({1, 1}, {{1}, {0, 1}}, {{0, 1}});
        integrators::Rodas4Tolerance tolerance{1e-6, {1e-9, 1e-9}};
        integrators::Rodas4Controller controller;
        integrators::Rodas4Statistics statistics;
        std::vector<double> states{1.0, 0.0};
        integrators::rodas4GlobalStep(0.0, 2.0, states, system, tolerance, {}, {}, steps, true, controller, statistics,
            [](std::size_t, double time, const std::vector<double>& values, std::vector<double>& rates) {
                rates[0] = -values[1] + 0.1 * std::sin(time);
                rates[1] = values[0] - 0.5 * values[1] * values[1];
            }, [](double, const std::vector<double>&) {});
        return states;
    };
    const auto reference = run(2048);
    double previous = 0;
    for (const std::size_t steps : {std::size_t{8}, std::size_t{16}, std::size_t{32}}) {
        const auto states = run(steps);
        const double error = std::hypot(states[0] - reference[0], states[1] - reference[1]);
        if (previous > 0) require(std::log2(previous / error) > 3.8 && std::log2(previous / error) < 4.3, "Rodas4 must be of order four.");
        previous = error;
    }
}


// Rodas5P (Steinebach 2023) is L-stable, as its paper says: |R(z)| <= 1 over the left half-plane and R -> 0 far into it; and R(z) agrees
// with exp(z) to fifth order near 0, which a slip in any of its coefficients would break.
void rodas5pStabilityFunctionIsLStableAndFifthOrder() {
    for (const double radius : {0.1, 1.0, 10.0, 1e3, 1e6}) {
        for (int angle = 0; angle <= 180; ++angle) {
            const double theta = std::numbers::pi / 2 + std::numbers::pi * angle / 180.0;
            require(std::abs(konjugate::rodas5pStabilityFunction(std::polar(radius, theta))) <= 1.0 + 1e-12, "Rodas5P must be A-stable.");
        }
    }
    require(std::abs(konjugate::rodas5pStabilityFunction({-1e8, 0})) < 1e-6, "Rodas5P must be L-stable: R(-infinity) = 0.");
    // At -0.4 and -0.2 (nearer 0 the difference is already at rounding level).
    const double error1 = std::abs(konjugate::rodas5pStabilityFunction({-0.4, 0}) - std::exp(-0.4));
    const double error2 = std::abs(konjugate::rodas5pStabilityFunction({-0.2, 0}) - std::exp(-0.2));
    require(std::log2(error1 / error2) > 5.7, "R(z) - exp(z) must be O(z^6): Rodas5P is of order five.");
}

// Rodas5P at fixed steps on a nonlinear, time-dependent model (df/dt worked out): its error falls 32 times when the step halves.
void rodas5pIsFifthOrderAtFixedSteps() {
    namespace integrators = konjugate::integrators;
    const auto run = [](std::size_t steps) {
        auto system = integrators::makeRodas4System({1, 1}, {{1}, {0, 1}}, {{0, 1}});
        integrators::Rodas5PTolerance tolerance{1e-6, {1e-9, 1e-9}};
        integrators::Rodas5PController controller;
        integrators::Rodas5PStatistics statistics;
        std::vector<double> states{1.0, 0.0};
        integrators::rodas5pGlobalStep(0.0, 2.0, states, system, tolerance, {}, {}, steps, true, controller, statistics,
            [](std::size_t, double time, const std::vector<double>& values, std::vector<double>& rates) {
                rates[0] = -values[1] + 0.1 * std::sin(time);
                rates[1] = values[0] - 0.5 * values[1] * values[1];
            }, [](double, const std::vector<double>&) {});
        return states;
    };
    const auto reference = run(2048);
    double previous = 0;
    // From 8 steps on (coarser, the order is not yet settled: 6.3 from 2 to 4 steps, 5.5 from 4 to 8).
    for (const std::size_t steps : {std::size_t{8}, std::size_t{16}, std::size_t{32}}) {
        const auto states = run(steps);
        const double error = std::hypot(states[0] - reference[0], states[1] - reference[1]);
        if (previous > 0) {
            const double order = std::log2(previous / error);
            require(order > 4.8 && order < 5.4, "Rodas5P must be of order five (observed " + std::to_string(order) + ").");
        }
        previous = error;
    }
}

// Rodas5P, adaptive, on a stiff linear model with an exact solution (decay rates 1 and 1e5, a fast mode coupled into a slow one): its
// error within the tolerance, its samples from the dense output as accurate as its steps, and at a tight tolerance far fewer steps than
// Rodas4 takes for the same accuracy.
void rodas5pFollowsAStiffModelWithinItsTolerance() {
    namespace integrators = konjugate::integrators;
    // y1' = -y1 + y2, y2' = -1e5 (y2 - cos t): y2 follows cos t closely, y1 is driven by it.
    const auto rates = [](std::size_t, double time, const std::vector<double>& values, std::vector<double>& derivatives) {
        derivatives[0] = -values[0] + values[1];
        derivatives[1] = -1e5 * (values[1] - std::cos(time));
    };
    // The exact solution from y(0) = (0, 1), solved by hand: y2 = cos t + a (sin t - ...) is written through its parts below.
    const double lambda = 1e5;
    const auto exact = [&](double time) {
        // y2 = A cos t + B sin t + (1 - A) e^{-lambda t}, with A = lambda^2 / (lambda^2 + 1), B = lambda / (lambda^2 + 1).
        const double A = lambda * lambda / (lambda * lambda + 1), B = lambda / (lambda * lambda + 1), E = 1 - A;
        // y1' + y1 = y2: each part's particular solution, and the homogeneous part fixing y1(0) = 0.
        const double cosPart = A * (std::cos(time) + std::sin(time)) / 2 + B * (std::sin(time) - std::cos(time)) / 2;
        const double expPart = E * std::exp(-lambda * time) / (1 - lambda);
        const double homogeneous = -(A / 2 - B / 2 + E / (1 - lambda));
        return std::vector<double>{cosPart + expPart + homogeneous * std::exp(-time), A * std::cos(time) + B * std::sin(time) + E * std::exp(-lambda * time)};
    };
    const auto run = [&](auto&& step, double relative, std::size_t& accepted, double& worstSample) {
        auto system = integrators::makeRodas4System({1, 1}, {{0, 1}, {1}}, {{0, 1}});
        integrators::Rodas4Tolerance tolerance{relative, {relative, relative}};
        integrators::Rodas4Controller controller;
        integrators::Rodas4Statistics statistics;
        std::vector<double> states{0.0, 1.0};
        std::vector<double> samples;
        for (int i = 1; i < 40; ++i) samples.push_back(i * 0.25);
        worstSample = 0;
        step(0.0, 10.0, states, system, tolerance, std::vector<double>{}, samples, std::size_t{0}, true, controller, statistics, rates,
            [&](double time, const std::vector<double>& values) {
                const auto truth = exact(time);
                worstSample = std::max(worstSample, std::max(std::abs(values[0] - truth[0]), std::abs(values[1] - truth[1])));
            });
        accepted = statistics.acceptedSteps;
        const auto truth = exact(10.0);
        return std::max(std::abs(states[0] - truth[0]), std::abs(states[1] - truth[1]));
    };
    const auto rodas5p = [](auto&&... arguments) { integrators::rodas5pGlobalStep(arguments...); };
    const auto rodas4 = [](auto&&... arguments) { integrators::rodas4GlobalStep(arguments...); };
    for (const double relative : {1e-4, 1e-7, 1e-10}) {
        std::size_t steps5 = 0, steps4 = 0;
        double sample5 = 0, sample4 = 0;
        const double error5 = run(rodas5p, relative, steps5, sample5);
        const double error4 = run(rodas4, relative, steps4, sample4);
        require(error5 < 100 * relative, "Rodas5P's error must follow its tolerance (" + std::to_string(error5) + " at " + std::to_string(relative) + ").");
        require(sample5 < 100 * relative, "Rodas5P's dense output must be as accurate as its steps (" + std::to_string(sample5) + ").");
        if (relative == 1e-10) {
            require(error4 < 100 * relative, "Rodas4 must follow its tolerance too (a check on the test).");
            require(2 * steps5 < steps4, "At a tight tolerance Rodas5P must take far fewer steps than Rodas4 (" + std::to_string(steps5) + " against "
                + std::to_string(steps4) + ").");
        }
    }
}

// BDF landing on many global steps of a smooth model takes not many more steps than in one: its approach to each landing planned in
// equal steps rather than ending in a sliver, after which its table took many steps to grow back (4.1 times the steps here before).
void bdfLandsWithoutSlivers() {
    namespace integrators = konjugate::integrators;
    const auto run = [](double globalStep) {
        auto system = integrators::makeStiffSystem({1, 1, 1}, {{0, 1}, {0, 1, 2}, {1, 2}}, {{0, 1, 2}});
        integrators::BdfTolerance tolerance{1e-3, {1e-3, 1e-3, 1e-3}};
        integrators::BdfHistory history;
        integrators::BdfStatistics statistics;
        std::vector<double> states{1.0, 0.0, 0.0};
        const auto rates = [](std::size_t, double, const std::vector<double>& y, std::vector<double>& d) {
            d[0] = -2e-3 * y[0] + 1e-3 * y[1] + 1e-4;
            d[1] = 1e-3 * y[0] - 3e-3 * y[1] + 1e-3 * y[2];
            d[2] = 1e-3 * y[1] - 1.5e-3 * y[2];
        };
        for (double time = 0; time < 16384 - 1e-9; time += globalStep) {
            integrators::bdfGlobalStep(time, time + globalStep, states, system, tolerance, {}, {}, false, history, statistics, rates,
                [](double, const std::vector<double>&) {});
        }
        return statistics.acceptedSteps;
    };
    const auto once = run(16384), landing = run(256);
    require(landing <= 2.5 * once, "Landing on 64 global steps BDF must take at most 2.5 times its steps in one (" + std::to_string(landing) + " against "
        + std::to_string(once) + ").");
}

// BDF on Robertson's kinetics to 1e11 s: the total kept at 1, the published values reached, its factorisation kept from step to step
// (far fewer factorisations than steps) and its order raised to five; and a run continued from its table mid-way takes the same steps.
void bdfKeepsItsFactorisationAndItsTable() {
    namespace integrators = konjugate::integrators;
    const auto robertson = [](std::size_t, double, const std::vector<double>& s, std::vector<double>& d) {
        d[0] = -0.04 * s[0] + 1e4 * s[1] * s[2];
        d[1] = 0.04 * s[0] - 1e4 * s[1] * s[2] - 3e7 * s[1] * s[1];
        d[2] = 3e7 * s[1] * s[1];
    };
    const auto run = [&](integrators::BdfHistory& history, integrators::BdfStatistics& statistics, std::vector<double>& states, double from, double to) {
        auto system = integrators::makeStiffSystem({1, 1, 1}, {{0, 1, 2}, {0, 1, 2}, {1}}, {{0, 1, 2}});
        integrators::BdfTolerance tolerance{1e-8, {1e-12, 1e-18, 1e-12}};
        double time = from;
        for (double end = from * 10; time < to; end *= 10) {
            integrators::bdfGlobalStep(time, std::min(end, to), states, system, tolerance, {}, {}, false, history, statistics, robertson,
                [](double, const std::vector<double>&) {});
            time = std::min(end, to);
        }
    };
    integrators::BdfHistory history;
    integrators::BdfStatistics statistics;
    std::vector<double> states{1.0, 0.0, 0.0};
    auto system = integrators::makeStiffSystem({1, 1, 1}, {{0, 1, 2}, {0, 1, 2}, {1}}, {{0, 1, 2}});
    integrators::bdfGlobalStep(0.0, 0.4, states, system, integrators::BdfTolerance{1e-8, {1e-12, 1e-18, 1e-12}}, {}, {}, false, history, statistics,
        robertson, [](double, const std::vector<double>&) {});
    auto copy = history;
    auto copyStates = states;
    run(history, statistics, states, 0.4, 1e11);
    require(std::abs(states[0] + states[1] + states[2] - 1.0) < 1e-13, "BDF must keep A + B + C at 1.");
    require(std::abs(states[0] - 2.083340149701255e-08) < 1e-4 * 2.08e-8, "BDF must reach the published concentration of A at 1e11 s.");
    require(statistics.factorisations * 3 < statistics.acceptedSteps, "BDF must keep its factorisation from step to step.");
    require(statistics.highestOrder == 5, "BDF must raise its order to five on Robertson's kinetics.");
    integrators::BdfStatistics again;
    run(copy, again, copyStates, 0.4, 1e11);
    require(copyStates == states, "BDF continued from a copy of its table must take the same steps, to the bit.");
}

}

// An undamped oscillator on one node, x' = v and v' = -omega^2 x, with its speed listed first or second.
boost::property_tree::ptree oneNodeOscillatorProject(double omegaSquared, const std::string& integration, bool speedFirst) {
    const std::string position = R"json({"id": 11, "name": "X", "symbol": "x", "initialValue": 1})json";
    const std::string speed = R"json({"id": 12, "name": "V", "symbol": "v", "initialValue": 0})json";
    std::ostringstream json;
    json << R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "Oscillator", "states": [)json" << (speedFirst ? speed + "," + position : position + "," + speed) << R"json(],
            "sourceTerms": [
                {"id": 21, "state": "x", "expression": "v", "expressionModel": {"latex": "v", "output": {"stateId": 11},
                 "bindings": [{"kind": "state", "stateId": 12, "symbol": "v", "label": "v"}], "mathJson": "v"}},
                {"id": 22, "state": "v", "expression": "-k x", "expressionModel": {"latex": "-k x", "output": {"stateId": 12},
                 "bindings": [{"kind": "state", "stateId": 11, "symbol": "x", "label": "x"}], "mathJson": ["Multiply", ")json" << -omegaSquared << R"json(", "x"]}}
            ],
            "numerics": {"substepsPerGlobalStep": 1, "integration": ")json" << integration << R"json("}
        }],
        "edges": []
    })json";
    return parseProject(json.str());
}

// Explicit Euler grows an undamped oscillation at every step and says it is one (docs/proposals/integrators.md, decision 1);
// semi-implicit Euler is judged by its own amplification matrix, (I - hL)^-1 (I + h(D + U)): neutral up to h omega = 2 in either
// order of the two states, and beyond it the substeps that bring it back.
void assessNodeStabilityJudgesASemiImplicitNodeByItsOwnAmplification() {
    {
        const auto plan = konjugate::compileExecutionPlan(oneNodeOscillatorProject(4.0, "explicit", false));
        const auto assessment = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.1);
        require(assessment && !assessment->stable && assessment->unconditionallyUnstable, "Explicit Euler grows an undamped oscillation at every step.");
        require(assessment->undampedOscillation, "An undamped oscillation must be told from a growing mode.");
    }
    for (const bool speedFirst : {false, true}) {
        const auto plan = konjugate::compileExecutionPlan(oneNodeOscillatorProject(4.0, "semiImplicit", speedFirst));
        const auto inside = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.5);
        require(inside && inside->stable && !inside->undampedOscillation, "Semi-implicit Euler keeps an undamped oscillation at h omega = 1.");
        require(std::abs(inside->maxAmplificationFactor - 1.0) < 1e-6, "Semi-implicit Euler is neutral on an undamped oscillation.");
        const auto outside = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 2.5);
        require(outside && !outside->stable && !outside->unconditionallyUnstable, "h omega = 5 is beyond semi-implicit Euler's bound of 2.");
        require(outside->requiredSubsteps && *outside->requiredSubsteps == 3, "Three substeps bring h omega to 5/3, within 2.");
    }
    {
        const auto plan = konjugate::compileExecutionPlan(oneNodeOscillatorProject(-4.0, "semiImplicit", false));
        const auto growing = konjugate::assessNodeStability(plan.nodes.at(0), plan.initialStates, 0.1);
        require(growing && !growing->stable && growing->unconditionallyUnstable && !growing->undampedOscillation,
            "A truly growing mode stays unconditionally unstable under semi-implicit Euler.");
    }
}

int main() {
    try {
        assessNodeStabilityJudgesASemiImplicitNodeByItsOwnAmplification();
        assessNodeStabilityFlagsAnObviouslyUnstableDecay();
        assessNodeStabilityCountsAStateNothingContributesToAsAZero();
        assessNodeStabilityAcceptsTheSameDecayOnceSubsteppedEnough();
        assessNodeStabilityComputesAStiffnessRatio();
        assessNodeStabilityIgnoresAConservedQuantityWhenJudgingStiffness();
        assessNodeStabilityStillReportsStiffnessBesideAConservedQuantity();
        assessNodeStabilityFollowsCouplingThroughAnAlgebraicState();
        assessNodeStabilitySkipsANodeWithNoDifferentialStates();
        assessNodeStabilityLeavesOutStatesAnAlgebraicRelationshipSets();
        assessNodeStabilitySkipsAProgrammableNode();
        assessNodeStabilityAttributesTheDrivingParameter();
        assessNodeStabilityAttributesTheFasterOfTwoRates();
        assessNodeStabilityOmitsAttributionWithNoCandidateParameters();
        assessNodeStabilityHandlesANodeThatIsNotFirstInTheDocument();
        assessNodeStabilityComputesRequiredSubsteps();
        assessNodeStabilityFlagsUnconditionalInstability();
        rungeKutta4StabilityFunctionIsTheTaylorPolynomial();
        dormandPrince54StabilityFunctionIsItsPolynomial();
        dormandPrince54DenseOutputIsFourthOrder();
        tsit5StabilityFunctionIsFifthOrder();
        tsit5IsFifthOrderWithAFourthOrderDenseOutput();
        assessWholeModelStabilityJudgesTheCouplingWithTheMethodsRegion();
        rodas4StabilityFunctionIsLStableAndFourthOrder();
        ownLinearSolveAgreesWithEigen();
        rodas4IsFourthOrderAtFixedSteps();
        rodas5pStabilityFunctionIsLStableAndFifthOrder();
        rodas5pIsFifthOrderAtFixedSteps();
        rodas5pFollowsAStiffModelWithinItsTolerance();
        bdfKeepsItsFactorisationAndItsTable();
        bdfLandsWithoutSlivers();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "stabilityAnalysisTests failed: %s\n", error.what());
        return 1;
    }
    std::printf("stabilityAnalysisTests passed\n");
    return 0;
}
