/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Nodes integrated with Störmer–Verlet (numerics.integration "verlet", docs/proposals/integrators.md, Verlet, node by
// node): the two parts a node's states fall in, the steps they take, the order and the energy, the refusals in words, the
// stability analysis, and a term written as a program held through the substep.

#include "executionPlan.hpp"
#include "modelValidator.hpp"
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

bool hasIssue(const konjugate::ValidationResult& result, const std::string& code) {
    for (const auto& issue : result.issues) if (issue.code == code) return true;
    return false;
}

boost::property_tree::ptree parse(const std::string& text) {
    std::istringstream json(text);
    boost::property_tree::ptree document;
    boost::property_tree::read_json(json, document);
    return document;
}

// A state's symbol is its name in lower case (V -> v), as the validator wants a term to say which state it updates.
std::string symbolOf(int stateId) {
    return std::string(stateId == 11 ? "v" : stateId == 12 ? "x" : stateId == 15 ? "y" : "q");
}

std::string term(int id, int stateId, const std::string& mathJson, const std::string& bindings) {
    return R"json({"id": )json" + std::to_string(id) + R"json(, "state": ")json" + symbolOf(stateId) + R"json(", "expression": "rate", "parameters": [], "expressionModel": {"latex": "", "mathJson": )json" + mathJson +
        R"json(, "bindings": [)json" + bindings + R"json(], "output": {"stateId": )json" + std::to_string(stateId) + "}}}";
}

std::string binding(const std::string& symbol, int stateId) {
    return R"json({"symbol": ")json" + symbol + R"json(", "kind": "state", "stateId": )json" + std::to_string(stateId) + "}";
}

std::string project(const std::string& states, const std::string& terms, int substeps = 1, const std::string& integration = "verlet") {
    return R"json({"format": "konjugate", "version": 1, "nodes": [{"id": 1, "name": "Spring",
        "numerics": {"substepsPerGlobalStep": )json" + std::to_string(substeps) + R"json(, "integration": ")json" + integration + R"json("},
        "states": [)json" + states + R"json(], "sourceTerms": [)json" + terms + R"json(]}], "edges": []})json";
}

const std::string speedFirst = R"json({"id": 11, "name": "V", "symbol": "v", "initialValue": 0}, {"id": 12, "name": "X", "symbol": "x", "initialValue": 1})json";
const std::string positionFirst = R"json({"id": 12, "name": "X", "symbol": "x", "initialValue": 1}, {"id": 11, "name": "V", "symbol": "v", "initialValue": 0})json";

// x' = v, v' = sign * x (sign -1: an oscillator of ω = 1; +1: an inverted one), with the states as listed.
std::string oscillator(const std::string& states, int substeps = 1, double sign = -1) {
    const auto force = sign < 0 ? std::string(R"json(["Negate", "x"])json") : std::string(R"json("x")json");
    return project(states, term(13, 11, force, binding("x", 12)) + "," + term(14, 12, R"json("v")json", binding("v", 11)), substeps);
}

double stateOf(const konjugate::ExecutionPlan& plan, const konjugate::StateValues& states, konjugate::EntityId id) {
    return states.at(plan.stateIndexes.at(id));
}

konjugate::StateValues run(const konjugate::ExecutionPlan& plan, double step, int steps) {
    auto states = plan.initialStates;
    for (int index = 0; index < steps; ++index) {
        const auto result = konjugate::integrateNode(plan.nodes.front(), states, {}, index * step, step);
        for (std::size_t local = 0; local < plan.nodes.front().stateIndexes.size(); ++local) states[plan.nodes.front().stateIndexes[local]] = result.states[local];
    }
    return states;
}

void aSpeedListedFirstGivesVelocityVerletAndAPositionFirstPositionVerlet() {
    const auto velocity = konjugate::compileExecutionPlan(parse(oscillator(speedFirst)));
    require(konjugate::validateModel(parse(oscillator(speedFirst))).valid, "A Verlet oscillator should be valid.");
    require(velocity.nodes.front().verletKicked == std::vector<bool>{true, false}, "V, listed first, is the part moved in halves.");
    // v½ = 0 - 0.05·1, x = 1 + 0.1·v½ = 0.995, v = v½ - 0.05·0.995.
    const auto velocityStates = run(velocity, 0.1, 1);
    require(std::abs(stateOf(velocity, velocityStates, 12) - 0.995) < 1e-15, "Velocity Verlet moves x with the half-step speed.");
    require(std::abs(stateOf(velocity, velocityStates, 11) + 0.09975) < 1e-15, "Velocity Verlet's speed ends with the new position's force.");
    const auto position = konjugate::compileExecutionPlan(parse(oscillator(positionFirst)));
    require(position.nodes.front().verletKicked == std::vector<bool>{true, false}, "X, listed first, is the part moved in halves.");
    // x½ = 1, v = -0.1, x = 1 - 0.05·0.1.
    const auto positionStates = run(position, 0.1, 1);
    require(std::abs(stateOf(position, positionStates, 12) - 0.995) < 1e-15, "Position Verlet moves x in halves around the speed's step.");
    require(std::abs(stateOf(position, positionStates, 11) + 0.1) < 1e-15, "Position Verlet's speed takes the middle position's force.");
}

void itIsSecondOrderAndKeepsTheEnergyBounded() {
    const auto plan = konjugate::compileExecutionPlan(parse(oscillator(speedFirst)));
    const auto error = [&](int steps) {
        const auto states = run(plan, 2.0 / steps, steps);
        return std::hypot(stateOf(plan, states, 12) - std::cos(2.0), stateOf(plan, states, 11) + std::sin(2.0));
    };
    const auto order = std::log2(error(200) / error(400));
    require(order > 1.95 && order < 2.05, "Verlet's observed order should be 2, was " + std::to_string(order) + ".");
    auto states = plan.initialStates;
    double largestDrift = 0;
    for (int index = 0; index < 10000; ++index) {
        const auto result = konjugate::integrateNode(plan.nodes.front(), states, {}, index * 0.1, 0.1);
        for (std::size_t local = 0; local < 2; ++local) states[plan.nodes.front().stateIndexes[local]] = result.states[local];
        const auto energy = 0.5 * (states[0] * states[0] + states[1] * states[1]);
        largestDrift = std::max(largestDrift, std::abs(energy - 0.5));
    }
    require(largestDrift < 0.002, "Verlet's energy should stay within h² of 0.5 over 10000 steps, drifted " + std::to_string(largestDrift) + ".");
}

void substepsTakeTheStepsGlobalStepsWould() {
    const auto substepped = konjugate::compileExecutionPlan(parse(oscillator(speedFirst, 4)));
    const auto single = konjugate::compileExecutionPlan(parse(oscillator(speedFirst, 1)));
    require(run(substepped, 0.1, 25) == run(single, 0.025, 100), "Four substeps should give the bits of four global steps a quarter the size.");
}

void aRateReadingNothingOfItsNodeIsTheTrapezoidRuleInTime() {
    // v' = t: the first part's rate read at the substep's start and end.
    const auto document = project(R"json({"id": 11, "name": "V", "symbol": "v", "initialValue": 0})json",
        R"json({"id": 13, "state": "v", "expression": "t", "parameters": [], "expressionModel": {"latex": "t", "mathJson": "t", "bindings": [{"symbol": "t", "kind": "time"}], "output": {"stateId": 11}}})json");
    const auto plan = konjugate::compileExecutionPlan(parse(document));
    const auto states = run(plan, 0.1, 1);
    require(std::abs(states[0] - 0.005) < 1e-17, "v' = t over 0.1 s should give 0.005 exactly.");
}

void aNodeWhoseRatesDoNotSplitIsRefusedInWords() {
    const auto refused = [](const std::string& document, const std::string& words) {
        try {
            konjugate::compileExecutionPlan(parse(document));
        } catch (const konjugate::VerletStructureError& error) {
            const std::string message = error.what();
            require(error.nodeId == 1, "The refusal should name the node.");
            require(message.find(words) != std::string::npos, "The refusal should say \"" + words + "\": " + message);
            const auto result = konjugate::validateModel(parse(document));
            require(!result.valid && hasIssue(result, "nodeIntegrationInvalid"), "The validator should refuse it too.");
            for (const auto& issue : result.issues) {
                if (issue.code == "nodeIntegrationInvalid") require(issue.message == message, "The validator should say the same words.");
            }
            return;
        }
        throw std::runtime_error("A node whose rates do not split should be refused: " + words);
    };
    // A damped speed reads itself.
    refused(project(speedFirst, term(13, 11, R"json(["Add", ["Negate", "x"], ["Negate", "v"]])json", binding("x", 12) + "," + binding("v", 11)) + "," +
        term(14, 12, R"json("v")json", binding("v", 11))), "the rate of V reads V itself");
    // Exponential decay: one state reading itself.
    refused(project(R"json({"id": 16, "name": "Charge", "symbol": "q", "initialValue": 1})json", term(13, 16, R"json(["Negate", "q"])json", binding("q", 16))),
        "the rate of Charge reads Charge itself");
    // Y reads X, both after the split at X.
    refused(project(speedFirst + R"json(, {"id": 15, "name": "Y", "symbol": "y", "initialValue": 0})json",
        term(13, 11, R"json(["Negate", "x"])json", binding("x", 12)) + "," + term(14, 12, R"json("v")json", binding("v", 11)) + "," +
        term(16, 15, R"json("x")json", binding("x", 12))), "the rate of Y reads X, in the same part");
    require(hasIssue(konjugate::validateModel(parse(project(speedFirst, "", 1, "sideways"))), "nodeIntegrationInvalid"),
        "An unknown integration should be nodeIntegrationInvalid.");
}

void theStabilityAnalysisUsesVerletsAmplification() {
    // ω = 1: Verlet is stable for h ≤ 2, where Explicit Euler is unstable at any step.
    const auto plan = konjugate::compileExecutionPlan(parse(oscillator(speedFirst)));
    const auto stable = konjugate::assessNodeStability(plan.nodes.front(), plan.initialStates, 1.9, plan.algebraicStateIndexes);
    require(stable && stable->stable, "Verlet is stable for an oscillation of ω = 1 at h = 1.9.");
    const auto unstable = konjugate::assessNodeStability(plan.nodes.front(), plan.initialStates, 2.5, plan.algebraicStateIndexes);
    require(unstable && !unstable->stable && !unstable->unconditionallyUnstable && unstable->requiredSubsteps == std::size_t{2},
        "At h = 2.5, Verlet needs 2 substeps.");
    const auto inverted = konjugate::compileExecutionPlan(parse(oscillator(speedFirst, 1, 1)));
    const auto growing = konjugate::assessNodeStability(inverted.nodes.front(), inverted.initialStates, 0.5, inverted.algebraicStateIndexes);
    require(growing && !growing->stable && growing->unconditionallyUnstable, "An inverted pendulum grows at any step.");
}

// Returns 2 for every program term and counts its calls.
class CountingEvaluator : public konjugate::ProviderEvaluator {
public:
    std::size_t calls = 0;
    std::vector<double> evaluateBatch(const std::vector<const konjugate::ContributionTask*>& tasks, const std::vector<std::span<const double>>&,
                                      double, double) override {
        calls += tasks.size();
        return std::vector<double>(tasks.size(), 2.0);
    }
};

void aProgramTermIsHeldThroughTheSubstep() {
    // v' = -x + (a program giving 2, reading v), x' = v: the program's reads do not tie v to itself, as it is held.
    const auto program = R"json({"id": 15, "state": "v", "expression": "", "parameters": [], "implementation": {"kind": "cpp", "source": "program", "output": {"key": "force", "stateId": 11},
        "bindings": [{"key": "v", "kind": "state", "stateId": 11}]}})json";
    const auto document = project(speedFirst, term(13, 11, R"json(["Negate", "x"])json", binding("x", 12)) + "," + program + "," +
        term(14, 12, R"json("v")json", binding("v", 11)), 3);
    const auto plan = konjugate::compileExecutionPlan(parse(document));
    CountingEvaluator evaluator;
    const auto result = konjugate::integrateNode(plan.nodes.front(), plan.initialStates, {}, 0, 0.3, &evaluator);
    require(evaluator.calls == 3, "The program should be called once a substep, was " + std::to_string(evaluator.calls) + ".");
    // One substep of 0.1 by hand, three times: v½ = v + 0.05(-x + 2), x += 0.1 v½, v = v½ + 0.05(-x + 2).
    double v = 0;
    double x = 1;
    for (int substep = 0; substep < 3; ++substep) {
        v += 0.05 * (-x + 2.0);
        x += 0.1 * v;
        v += 0.05 * (-x + 2.0);
    }
    require(std::abs(result.states[0] - v) < 1e-15 && std::abs(result.states[1] - x) < 1e-15, "The held program's 2 should be added through each substep.");
}

}

int main() {
    try {
        aSpeedListedFirstGivesVelocityVerletAndAPositionFirstPositionVerlet();
        itIsSecondOrderAndKeepsTheEnergyBounded();
        substepsTakeTheStepsGlobalStepsWould();
        aRateReadingNothingOfItsNodeIsTheTrapezoidRuleInTime();
        aNodeWhoseRatesDoNotSplitIsRefusedInWords();
        theStabilityAnalysisUsesVerletsAmplification();
        aProgramTermIsHeldThroughTheSubstep();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "verletIntegrationTests failed: %s\n", error.what());
        return 1;
    }
    std::printf("verletIntegrationTests passed\n");
    return 0;
}
