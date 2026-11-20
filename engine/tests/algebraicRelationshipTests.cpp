/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Relationships with several equations that set their endpoints' states (equationModel.outputs),
// evaluated across the whole model at each instant in dependency order; and nodes integrated
// semi-implicitly (numerics.integration "semiImplicit").

#include "executionPlan.hpp"
#include "modelValidator.hpp"
#include <boost/property_tree/json_parser.hpp>
#include <algorithm>
#include <chrono>
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

const char* chainNodes = R"json(
    {"id": 1, "name": "A", "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 3}],
     "sourceTerms": []},
    {"id": 2, "name": "B", "states": [{"id": 21, "name": "Y", "symbol": "y", "initialValue": 0}], "sourceTerms": []},
    {"id": 3, "name": "C", "states": [{"id": 31, "name": "Z", "symbol": "z", "initialValue": 0},
                                      {"id": 32, "name": "W", "symbol": "w", "initialValue": 0}], "sourceTerms": []},
    {"id": 4, "name": "D", "states": [{"id": 41, "name": "U", "symbol": "u", "initialValue": 5}], "sourceTerms": []}
)json";

// B.y = gain x (from A), C.z = y + 1 and C.w = d * d with d = y - 1 (from B), and C.z also gets u (from D):
// listed with the later links first, so only ordering by dependency gets them right.
std::string chainProject(const std::string& extraEdges = "",
                         const std::string& firstOutput = R"json({"role": "target", "stateId": 31, "mathJson": ["Add", "y", 1], "setsValue": true})json") {
    return std::string(R"json({"format": "konjugate", "version": 1, "nodes": [)json") + chainNodes + R"json(], "edges": [
        {"id": 5, "name": "B to C", "directionality": "directed", "source": {"nodeId": 2}, "target": {"nodeId": 3},
         "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "y", "kind": "state", "role": "source", "nodeId": 2, "stateId": 21}],
            "definitions": [{"symbol": "d", "mathJson": ["Add", "y", -1]}, {"symbol": "unused", "mathJson": ["Divide", 1, 0]}],
            "outputs": [
                )json" + firstOutput + R"json(,
                {"role": "target", "stateId": 32, "mathJson": ["Multiply", "d", "d"], "setsValue": true}
            ]}},
        {"id": 6, "name": "A to B", "directionality": "directed", "source": {"nodeId": 1}, "target": {"nodeId": 2},
         "parameters": [{"id": 61, "name": "Gain", "symbol": "gain", "value": 2, "mode": "live", "control": {"minimum": 0, "maximum": 10, "step": 1}}],
         "equationModel": {
            "bindings": [{"symbol": "x", "kind": "state", "role": "source", "nodeId": 1, "stateId": 11},
                         {"symbol": "gain", "kind": "parameter", "parameterId": 61}],
            "outputs": [{"role": "target", "stateId": 21, "mathJson": ["Multiply", "gain", "x"], "setsValue": true}]}},
        {"id": 7, "name": "D to C", "directionality": "directed", "source": {"nodeId": 4}, "target": {"nodeId": 3},
         "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "u", "kind": "state", "role": "source", "nodeId": 4, "stateId": 41}],
            "outputs": [{"role": "target", "stateId": 31, "mathJson": "u", "setsValue": true}]}})json" + extraEdges + R"json(
    ]})json";
}

void aChainAcrossNodesSettlesWithinOneInstantInDependencyOrder() {
    const auto document = parse(chainProject());
    const auto result = konjugate::validateModel(document);
    for (const auto& issue : result.issues) if (issue.severity == "error") std::fprintf(stderr, "  %s: %s\n", issue.code.c_str(), issue.message.c_str());
    require(result.valid, "A chain of relationships setting values should be valid.");
    const auto plan = konjugate::compileExecutionPlan(document);
    require(plan.algebraicOutputs.size() == 4, "Each equation is an algebraic output.");
    for (const auto& node : plan.nodes) require(node.contributions.empty(), "An algebraic relationship adds no rate to any node.");
    auto states = plan.initialStates;
    konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    const auto at = [&](konjugate::EntityId id) { return states.at(plan.stateIndexes.at(id)); };
    require(at(21) == 6, "B.y should be gain x = 6.");
    require(at(31) == 12, "C.z should be y + 1 plus u: 7 + 5 = 12, summed from two relationships.");
    require(at(32) == 25, "C.w should be (y - 1) squared = 25, through its definition.");
    // Evaluating again from the same states gives the same values: the states set are not accumulated.
    konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    require(at(31) == 12, "Evaluating twice should not add to the states set.");
    // A live override of a relationship's parameter reaches it.
    konjugate::evaluateAlgebraicRelationships(plan, states, {{61, 3}}, {}, 0);
    require(at(21) == 9 && at(31) == 15, "A live gain of 3 should give y = 9 and z = 15.");
}

void aLoopOfRelationshipsSettingValuesIsRefused() {
    const auto loop = R"json(,
        {"id": 8, "name": "C to B", "directionality": "directed", "source": {"nodeId": 3}, "target": {"nodeId": 2},
         "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "z", "kind": "state", "role": "source", "nodeId": 3, "stateId": 31}],
            "outputs": [{"role": "target", "stateId": 21, "mathJson": "z", "setsValue": true}]}})json";
    const auto document = parse(chainProject(loop));
    require(hasIssue(konjugate::validateModel(document), "algebraicLoop"), "A loop of relationships setting values should be algebraicLoop.");
    bool threw = false;
    try { static_cast<void>(konjugate::compileExecutionPlan(document)); } catch (const std::runtime_error&) { threw = true; }
    require(threw, "Compiling a loop of relationships setting values should fail clearly.");
}

void theValidatorCatchesMalformedRelationshipsWithSeveralEquations() {
    require(hasIssue(konjugate::validateModel(parse(chainProject("", R"json({"role": "target", "stateId": 31, "mathJson": ["Add", "y", 1]})json"))), "relationshipOutputNotAlgebraic"),
        "An equation that does not set its state's value should be relationshipOutputNotAlgebraic.");
    require(hasIssue(konjugate::validateModel(parse(chainProject("", R"json({"role": "target", "stateId": 31, "mathJson": ["Add", "nothing", 1], "setsValue": true})json"))), "edgeEquationInvalid"),
        "An equation reading an unknown symbol should be edgeEquationInvalid.");
    // A rate into a state relationships set: two kinds of contribution to one state.
    const auto rate = R"json(,
        {"id": 9, "name": "Rate", "directionality": "directed", "source": {"nodeId": 1, "stateId": 11}, "target": {"nodeId": 3, "stateId": 32},
         "parameters": [],
         "equationModel": {"latex": "1", "mathJson": 1, "bindings": [], "output": {"role": "target", "stateId": 32}}})json";
    require(hasIssue(konjugate::validateModel(parse(chainProject(rate))), "algebraicStateMixed"),
        "A state set by relationships and also given a rate should be algebraicStateMixed.");
    auto bidirectional = parse(chainProject());
    bidirectional.get_child("edges").front().second.put("directionality", "bidirectional");
    require(hasIssue(konjugate::validateModel(bidirectional), "relationshipOutputsInvalid"),
        "A bidirectional relationship with several equations should be relationshipOutputsInvalid.");
}

// x' = v, v' = -x, with v listed first: semi-implicit Euler updates v, then x from the new v.
std::string oscillator(const std::string& integration) {
    return std::string(R"json({"format": "konjugate", "version": 1, "nodes": [{"id": 1, "name": "Spring",
        "numerics": {"substepsPerGlobalStep": 1, "integration": ")json") + integration + R"json("},
        "states": [{"id": 11, "name": "V", "symbol": "v", "initialValue": 0}, {"id": 12, "name": "X", "symbol": "x", "initialValue": 1}],
        "sourceTerms": [
            {"id": 13, "state": "v", "expression": "-x", "parameters": [],
             "expressionModel": {"latex": "-x", "mathJson": ["Negate", "x"], "bindings": [{"symbol": "x", "kind": "state", "stateId": 12}], "output": {"stateId": 11}}},
            {"id": 14, "state": "x", "expression": "v", "parameters": [],
             "expressionModel": {"latex": "v", "mathJson": "v", "bindings": [{"symbol": "v", "kind": "state", "stateId": 11}], "output": {"stateId": 12}}}
        ]}], "edges": []})json";
}

void aSemiImplicitNodeUpdatesEachStateFromTheOnesUpdatedBeforeIt() {
    const double step = 0.1;
    const auto explicitPlan = konjugate::compileExecutionPlan(parse(oscillator("explicit")));
    const auto semiPlan = konjugate::compileExecutionPlan(parse(oscillator("semiImplicit")));
    require(konjugate::validateModel(parse(oscillator("semiImplicit"))).valid, "A semi-implicit node should be valid.");
    require(hasIssue(konjugate::validateModel(parse(oscillator("sideways"))), "nodeIntegrationInvalid"), "An unknown integration should be nodeIntegrationInvalid.");
    const auto explicitResult = konjugate::integrateNode(explicitPlan.nodes.front(), explicitPlan.initialStates, {}, 0, step);
    const auto semiResult = konjugate::integrateNode(semiPlan.nodes.front(), semiPlan.initialStates, {}, 0, step);
    require(std::abs(explicitResult.states[0] + 0.1) < 1e-15 && std::abs(explicitResult.states[1] - 1.0) < 1e-15, "Explicit Euler moves x with the old v (0).");
    require(std::abs(semiResult.states[0] + 0.1) < 1e-15 && std::abs(semiResult.states[1] - 0.99) < 1e-15, "Semi-implicit Euler moves x with the new v (-0.1).");
    // Over many steps, semi-implicit Euler keeps the oscillator's energy bounded; explicit Euler lets it grow.
    auto explicitStates = explicitPlan.initialStates;
    auto semiStates = semiPlan.initialStates;
    for (int index = 0; index < 1000; ++index) {
        explicitStates = konjugate::integrateNode(explicitPlan.nodes.front(), explicitStates, {}, index * step, step).states;
        semiStates = konjugate::integrateNode(semiPlan.nodes.front(), semiStates, {}, index * step, step).states;
    }
    const auto energy = [](const konjugate::StateValues& states) { return 0.5 * (states[0] * states[0] + states[1] * states[1]); };
    require(energy(explicitStates) > 100, "Explicit Euler's energy should have grown.");
    require(energy(semiStates) < 0.6, "Semi-implicit Euler's energy should stay near 0.5.");
}

// A relationship whose equations come before and after another's: P sets B.y = e (e = 2 x) and A.v = q + e, Q sets
// A.q = 10 y between them. P's definition e is worked out once for the instant and kept; its second equation reads
// A.q as Q settled it, not as it stood when P's first equation was reached.
void aRelationshipsLaterEquationReadsWhatAnotherSettledSinceItsFirst() {
    const auto document = parse(R"json({"format": "konjugate", "version": 1, "nodes": [
        {"id": 1, "name": "A", "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 3},
                                          {"id": 12, "name": "Q", "symbol": "q", "initialValue": 0},
                                          {"id": 13, "name": "V", "symbol": "v", "initialValue": 0}], "sourceTerms": []},
        {"id": 2, "name": "B", "states": [{"id": 21, "name": "Y", "symbol": "y", "initialValue": 0}], "sourceTerms": []}
    ], "edges": [
        {"id": 5, "name": "P", "directionality": "directed", "source": {"nodeId": 1}, "target": {"nodeId": 2}, "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "x", "kind": "state", "role": "source", "nodeId": 1, "stateId": 11},
                         {"symbol": "q", "kind": "state", "role": "source", "nodeId": 1, "stateId": 12}],
            "definitions": [{"symbol": "e", "mathJson": ["Multiply", 2, "x"]}],
            "outputs": [{"role": "source", "stateId": 13, "mathJson": ["Add", "q", "e"], "setsValue": true},
                        {"role": "target", "stateId": 21, "mathJson": "e", "setsValue": true}]}},
        {"id": 6, "name": "Q", "directionality": "directed", "source": {"nodeId": 2}, "target": {"nodeId": 1}, "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "y", "kind": "state", "role": "source", "nodeId": 2, "stateId": 21}],
            "outputs": [{"role": "target", "stateId": 12, "mathJson": ["Multiply", 10, "y"], "setsValue": true}]}}
    ]})json");
    require(konjugate::validateModel(document).valid, "Two relationships, one's equations either side of the other's, should be valid.");
    const auto plan = konjugate::compileExecutionPlan(document);
    auto states = plan.initialStates;
    konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    const auto at = [&](konjugate::EntityId id) { return states.at(plan.stateIndexes.at(id)); };
    require(at(21) == 6 && at(12) == 60, "B.y should be 2 x = 6 and A.q 10 y = 60.");
    require(at(13) == 66, "A.v should be q + e = 60 + 6, reading q as Q settled it.");
    // Again, from the states as they now stand: nothing is carried over from the instant before.
    states.at(plan.stateIndexes.at(11)) = 4;
    konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    require(at(21) == 8 && at(12) == 80 && at(13) == 88, "With x = 4, y, q and v should be 8, 80 and 88.");
}

void inverseTrigonometricAndHyperbolicFunctionsEvaluate() {
    const auto value = [](const std::string& mathJson) {
        const auto document = parse(std::string(R"json({"format": "konjugate", "version": 1, "nodes": [)json") + chainNodes + R"json(], "edges": [
            {"id": 5, "name": "F", "directionality": "directed", "source": {"nodeId": 1}, "target": {"nodeId": 2}, "parameters": [],
             "equationModel": {"bindings": [], "outputs": [{"role": "target", "stateId": 21, "mathJson": )json" + mathJson + R"json(, "setsValue": true}]}}]})json");
        require(konjugate::validateModel(document).valid, "The function should be valid: " + mathJson);
        const auto plan = konjugate::compileExecutionPlan(document);
        auto states = plan.initialStates;
        konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
        return states.at(plan.stateIndexes.at(21));
    };
    require(std::abs(value(R"json(["Arctan2", 1, -1])json") - 3 * std::atan(1.0)) < 1e-15, "Arctan2(1, -1) is 3 pi / 4.");
    require(std::abs(value(R"json(["Arcsin", 0.5])json") - std::asin(0.5)) < 1e-15, "Arcsin.");
    require(std::abs(value(R"json(["Arccos", 0.5])json") - std::acos(0.5)) < 1e-15, "Arccos.");
    require(std::abs(value(R"json(["Arctan", 2])json") - std::atan(2.0)) < 1e-15, "Arctan.");
    require(std::abs(value(R"json(["Tanh", 0.3])json") - std::tanh(0.3)) < 1e-15, "Tanh.");
}

// A definition is worked out only when an equation needs it: one read only in a branch not taken is not. B.y = c, c a
// choice between a = 2 x (x above 0) and the end of a long chain b1 = a + 1, b2 = b1 + 1, ... (otherwise); B.z = n, a
// choice inside a choice, and B.w = a again (kept from the instant, not worked out twice). With x above 0 the chain is
// skipped; with x below it the chain is worked out in turn, without recursing down it.
void aDefinitionReadOnlyInABranchNotTakenIsNotWorkedOut() {
    const std::size_t chain = 3000;
    std::string definitions = R"json({"symbol": "a", "mathJson": ["Multiply", 2, "x"]}, {"symbol": "b1", "mathJson": ["Add", "a", 1]})json";
    for (std::size_t index = 2; index <= chain; ++index) {
        definitions += R"json(, {"symbol": "b)json" + std::to_string(index) + R"json(", "mathJson": ["Add", "b)json" + std::to_string(index - 1) + R"json(", 1]})json";
    }
    definitions += R"json(, {"symbol": "c", "mathJson": ["Which", ["Greater", "x", 0], "a", "True", "b)json" + std::to_string(chain) + R"json("]})json";
    definitions += R"json(, {"symbol": "f", "mathJson": ["Multiply", "a", "a"]}, {"symbol": "g", "mathJson": ["Negate", "a"]})json";
    definitions += R"json(, {"symbol": "n", "mathJson": ["Which", ["Greater", "x", 0], ["Which", ["Greater", "x", 5], "f", "True", "g"], "True", 0]})json";
    const auto document = parse(R"json({"format": "konjugate", "version": 1, "nodes": [
        {"id": 1, "name": "A", "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 3}], "sourceTerms": []},
        {"id": 2, "name": "B", "states": [{"id": 21, "name": "Y", "symbol": "y", "initialValue": 0},
                                          {"id": 22, "name": "Z", "symbol": "z", "initialValue": 0},
                                          {"id": 23, "name": "W", "symbol": "w", "initialValue": 0}], "sourceTerms": []}
    ], "edges": [
        {"id": 5, "name": "P", "directionality": "directed", "source": {"nodeId": 1}, "target": {"nodeId": 2}, "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "x", "kind": "state", "role": "source", "nodeId": 1, "stateId": 11}],
            "definitions": [)json" + definitions + R"json(],
            "outputs": [{"role": "target", "stateId": 21, "mathJson": "c", "setsValue": true},
                        {"role": "target", "stateId": 22, "mathJson": "n", "setsValue": true},
                        {"role": "target", "stateId": 23, "mathJson": "a", "setsValue": true}]}}
    ]})json");
    require(konjugate::validateModel(document).valid, "A relationship with choices between definitions should be valid.");
    const auto plan = konjugate::compileExecutionPlan(document);
    const auto at = [&](const konjugate::StateValues& states, konjugate::EntityId id) { return states.at(plan.stateIndexes.at(id)); };
    auto states = plan.initialStates;
    // x = 3: c reads a; n reads g (and so a, already worked out). Worked out: c, a, n, g.
    auto worked = konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    require(at(states, 21) == 6 && at(states, 22) == -6 && at(states, 23) == 6, "With x = 3, y, z and w should be 6, -6 and 6.");
    require(worked == 4, "With x = 3 only c, a, n and g should be worked out, not " + std::to_string(worked) + " definitions.");
    // x = 6: n reads f instead.
    states.at(plan.stateIndexes.at(11)) = 6;
    worked = konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    require(at(states, 22) == 144 && worked == 4, "With x = 6, z should be a a = 144, from c, a, n and f.");
    // x = -1: c reads the chain's end, and so the whole chain; n takes neither f nor g.
    states.at(plan.stateIndexes.at(11)) = -1;
    worked = konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    require(at(states, 21) == -2.0 + static_cast<double>(chain) && at(states, 22) == 0 && at(states, 23) == -2,
            "With x = -1, y should be -2 plus the chain's length, z 0 and w -2.");
    require(worked == chain + 3, "With x = -1 the chain, a, c and n should be worked out, not " + std::to_string(worked) + " definitions.");
}


// An output depends on a state written by another relationship's output when any definition it may need reads that
// state, however deep in a chain of definitions; and finding that looks through each definition once, not once per
// output that may need it: a relationship of thousands of outputs sharing thousands of definitions is ordered at once.
void outputsAreOrderedByStatesTheirDefinitionsReadOnceEach() {
    const std::size_t chain = 10000;
    const std::size_t outputs = 10000;
    const auto end = "d" + std::to_string(chain);
    std::string definitions = R"json({"symbol": "d1", "mathJson": ["Add", "y", 1]})json";
    for (std::size_t index = 2; index <= chain; ++index) {
        definitions += R"json(, {"symbol": "d)json" + std::to_string(index) + R"json(", "mathJson": ["Add", "d)json" + std::to_string(index - 1) + R"json(", 1]})json";
    }
    // The first output reads the chain's end; the others read it only in a branch not taken.
    std::string states;
    std::string sets;
    for (std::size_t index = 0; index < outputs; ++index) {
        const auto id = std::to_string(1000 + index);
        const auto read = index ? R"json(["Which", ["Greater", "d1", 1000000], ")json" + end + R"json(", "True", )json" + std::to_string(index) + "]" : "\"" + end + "\"";
        states += std::string(index ? ", " : "") + R"json({"id": )json" + id + R"json(, "name": "S)json" + id + R"json(", "symbol": "s)json" + id + R"json(", "initialValue": 0})json";
        sets += std::string(index ? ", " : "") + R"json({"role": "target", "stateId": )json" + id + R"json(, "mathJson": )json" + read + R"json(, "setsValue": true})json";
    }
    // The long relationship comes first in the document, so only what its definitions read puts it after the short one.
    const auto document = parse(R"json({"format": "konjugate", "version": 1, "nodes": [
        {"id": 1, "name": "A", "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 3}], "sourceTerms": []},
        {"id": 2, "name": "B", "states": [{"id": 21, "name": "Y", "symbol": "y", "initialValue": 0}], "sourceTerms": []},
        {"id": 3, "name": "C", "states": [)json" + states + R"json(], "sourceTerms": []}
    ], "edges": [
        {"id": 5, "name": "Long", "directionality": "directed", "source": {"nodeId": 2}, "target": {"nodeId": 3}, "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "y", "kind": "state", "role": "source", "nodeId": 2, "stateId": 21}],
            "definitions": [)json" + definitions + R"json(],
            "outputs": [)json" + sets + R"json(]}},
        {"id": 6, "name": "Short", "directionality": "directed", "source": {"nodeId": 1}, "target": {"nodeId": 2}, "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "x", "kind": "state", "role": "source", "nodeId": 1, "stateId": 11}],
            "outputs": [{"role": "target", "stateId": 21, "mathJson": ["Multiply", 2, "x"], "setsValue": true}]}}
    ]})json");
    const auto started = std::chrono::steady_clock::now();
    const auto plan = konjugate::compileExecutionPlan(document);
    const auto seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    require(plan.algebraicOutputs.front().outputStateId == 21, "The output setting y should come before every output whose definitions read y.");
    auto values = plan.initialStates;
    konjugate::evaluateAlgebraicRelationships(plan, values, {}, {}, 0);
    const auto at = [&](konjugate::EntityId id) { return values.at(plan.stateIndexes.at(id)); };
    require(at(21) == 6 && at(1000) == 6.0 + static_cast<double>(chain) && at(1000 + outputs - 1) == static_cast<double>(outputs - 1),
            "The first output should read y as set this instant, through the whole chain, and the others their own numbers.");
    // Looking through the chain once per output took 17 s here; once in all, a third of a second.
    require(seconds < 3, "Compiling should not look through the definitions once per output: it took " + std::to_string(seconds) + " s.");
}

// Each equation is worked out by a flat program of instructions. Every operation gives what walking its tree gives,
// to the last bit: a sum adds its terms from zero in turn, a product multiplies them from one.
void everyOperationIsWorkedOutToTheLastBit() {
    const auto document = parse(R"json({"format": "konjugate", "version": 1, "nodes": [
        {"id": 1, "name": "A", "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 0.7}], "sourceTerms": []},
        {"id": 2, "name": "B", "states": [{"id": 21, "name": "S", "symbol": "s", "initialValue": 0},
                                          {"id": 22, "name": "P", "symbol": "p", "initialValue": 0},
                                          {"id": 23, "name": "C", "symbol": "c", "initialValue": 0}], "sourceTerms": []}
    ], "edges": [
        {"id": 5, "name": "All", "directionality": "directed", "source": {"nodeId": 1}, "target": {"nodeId": 2}, "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "x", "kind": "state", "role": "source", "nodeId": 1, "stateId": 11}],
            "definitions": [{"symbol": "h", "mathJson": ["Divide", "x", 3]}],
            "outputs": [
                {"role": "target", "stateId": 21, "setsValue": true, "mathJson": ["Add", ["Sin", "x"], ["Cos", "x"], ["Tan", "x"], ["Arcsin", "x"],
                    ["Arccos", "x"], ["Arctan", "x"], ["Arctan2", "x", 2], ["Tanh", "x"], ["Exp", "x"], ["Ln", "x"], ["Sqrt", "x"],
                    ["Abs", ["Negate", "x"]], ["Power", "x", 3], ["Divide", 1, "x"], ["Min", "x", 0.5], ["Max", "x", 0.5], "h"]},
                {"role": "target", "stateId": 22, "setsValue": true, "mathJson": ["Multiply", 0.1, "x", ["Add", "x", 0.3], "h"]},
                {"role": "target", "stateId": 23, "setsValue": true, "mathJson": ["Which", ["Greater", "x", 1], 10,
                    ["Less", 0, "x", 0.5], 20, ["And", ["LessEqual", 0.5, "x"], ["NotEqual", "x", 0.8]], 30, "True", 40]}
            ]}}
    ]})json");
    require(konjugate::validateModel(document).valid, "A relationship using every operation should be valid.");
    const auto plan = konjugate::compileExecutionPlan(document);
    auto values = plan.initialStates;
    konjugate::evaluateAlgebraicRelationships(plan, values, {}, {}, 0);
    const auto at = [&](konjugate::EntityId id) { return values.at(plan.stateIndexes.at(id)); };
    const double x = 0.7;
    const double h = x / 3;
    double sum = 0;
    for (const double term : {std::sin(x), std::cos(x), std::tan(x), std::asin(x), std::acos(x), std::atan(x), std::atan2(x, 2.0), std::tanh(x),
                              std::exp(x), std::log(x), std::sqrt(x), std::abs(-x), std::pow(x, 3.0), 1 / x, std::min(x, 0.5), std::max(x, 0.5), h}) {
        sum += term;
    }
    double product = 1;
    for (const double factor : {0.1, x, x + 0.3, h}) product *= factor;
    require(at(21) == sum, "The sum of every operation should be what adding them in turn gives, to the last bit.");
    require(at(22) == product, "The product should be what multiplying in turn gives, to the last bit.");
    require(at(23) == 30, "With x = 0.7 the choice should take its third branch.");
}

// A choice settled early leaves the rest unworked: a chained comparison stops at its first pair that fails, And at its
// first false argument, Or at its first true one, so a definition read only after that is not worked out.
void aChoiceSettledEarlyLeavesTheRestUnworked() {
    const auto document = parse(R"json({"format": "konjugate", "version": 1, "nodes": [
        {"id": 1, "name": "A", "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 0.7}], "sourceTerms": []},
        {"id": 2, "name": "B", "states": [{"id": 21, "name": "U", "symbol": "u", "initialValue": 0},
                                          {"id": 22, "name": "V", "symbol": "v", "initialValue": 0},
                                          {"id": 23, "name": "W", "symbol": "w", "initialValue": 0}], "sourceTerms": []}
    ], "edges": [
        {"id": 5, "name": "Choices", "directionality": "directed", "source": {"nodeId": 1}, "target": {"nodeId": 2}, "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "x", "kind": "state", "role": "source", "nodeId": 1, "stateId": 11}],
            "definitions": [{"symbol": "a", "mathJson": ["Multiply", 2, "x"]}, {"symbol": "b", "mathJson": ["Multiply", 3, "x"]},
                            {"symbol": "c", "mathJson": ["Multiply", 4, "x"]}],
            "outputs": [
                {"role": "target", "stateId": 21, "setsValue": true, "mathJson": ["Which", ["Greater", "x", 5], 9, ["Less", "x", 0, "a"], 1, "True", 2]},
                {"role": "target", "stateId": 22, "setsValue": true, "mathJson": ["Which", ["Greater", "x", 5], 9, ["And", ["Greater", "x", 1], ["Greater", "b", 0]], 3, "True", 4]},
                {"role": "target", "stateId": 23, "setsValue": true, "mathJson": ["Which", ["Greater", "x", 5], 9, ["Or", ["Greater", "x", 0], ["Greater", "c", 0]], 5, "True", 6]}
            ]}}
    ]})json");
    require(konjugate::validateModel(document).valid, "A relationship of choices should be valid.");
    const auto plan = konjugate::compileExecutionPlan(document);
    auto values = plan.initialStates;
    const auto worked = konjugate::evaluateAlgebraicRelationships(plan, values, {}, {}, 0);
    const auto at = [&](konjugate::EntityId id) { return values.at(plan.stateIndexes.at(id)); };
    require(at(21) == 2 && at(22) == 4 && at(23) == 5, "With x = 0.7 the choices should give 2, 4 and 5.");
    require(worked == 0, "No definition should be worked out once each choice is settled, not " + std::to_string(worked) + ".");
    values.at(plan.stateIndexes.at(11)) = -1;
    const auto workedThen = konjugate::evaluateAlgebraicRelationships(plan, values, {}, {}, 0);
    require(at(21) == 2 && at(23) == 6 && workedThen == 2, "With x = -1 the chain and Or should read a and c, and only those.");
}

// A valid model's validation hands back the plan it compiled, so a run need not compile it again; an invalid one's none.
void validationHandsBackTheCompiledPlan() {
    const auto document = parse(chainProject());
    const auto result = konjugate::validateModel(document);
    require(result.valid && result.plan, "Validating a valid model with relationships should hand back its compiled plan.");
    const auto compiled = konjugate::compileExecutionPlan(document);
    auto fromValidation = result.plan->initialStates;
    auto fromCompile = compiled.initialStates;
    konjugate::evaluateAlgebraicRelationships(*result.plan, fromValidation, {}, {}, 0);
    konjugate::evaluateAlgebraicRelationships(compiled, fromCompile, {}, {}, 0);
    require(fromValidation == fromCompile, "The plan validation hands back should be the one compiling gives.");
    const auto loop = R"json(,
        {"id": 8, "name": "C to B", "directionality": "directed", "source": {"nodeId": 3}, "target": {"nodeId": 2},
         "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "z", "kind": "state", "role": "source", "nodeId": 3, "stateId": 31}],
            "outputs": [{"role": "target", "stateId": 21, "mathJson": "z", "setsValue": true}]}})json";
    require(!konjugate::validateModel(parse(chainProject(loop))).plan, "An invalid model's validation should hand back no plan.");
}

}

int main() {
    try {
        aChainAcrossNodesSettlesWithinOneInstantInDependencyOrder();
        aLoopOfRelationshipsSettingValuesIsRefused();
        theValidatorCatchesMalformedRelationshipsWithSeveralEquations();
        aSemiImplicitNodeUpdatesEachStateFromTheOnesUpdatedBeforeIt();
        inverseTrigonometricAndHyperbolicFunctionsEvaluate();
        aRelationshipsLaterEquationReadsWhatAnotherSettledSinceItsFirst();
        aDefinitionReadOnlyInABranchNotTakenIsNotWorkedOut();
        outputsAreOrderedByStatesTheirDefinitionsReadOnceEach();
        validationHandsBackTheCompiledPlan();
        everyOperationIsWorkedOutToTheLastBit();
        aChoiceSettledEarlyLeavesTheRestUnworked();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "algebraicRelationshipTests failed: %s\n", error.what());
        return 1;
    }
    std::printf("algebraicRelationshipTests passed\n");
    return 0;
}
