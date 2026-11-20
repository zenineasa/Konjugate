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
    const auto mixed = konjugate::validateModel(parse(chainProject(rate)));
    require(hasIssue(mixed, "rateIntoWorkedOutState") && !hasIssue(mixed, "algebraicStateMixed"),
        "A state set by relationships and also given a rate should be rateIntoWorkedOutState, said once.");
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

// ---- The cross-model algebraic pass: setsValue source terms reading what relationships set ----

// A relationship A -> B setting B.y = 2 x, a setsValue source term on B setting s = y + 1 (and, reading nothing the pass
// sets, t = 5), and a relationship B -> C setting C.z = 10 s. `extraNodes` and `extraEdges` are spliced in.
std::string sourceTermChain(const std::string& extraNodes = "", const std::string& extraEdges = "",
                            const std::string& aStates = R"json([{"id": 11, "name": "X", "symbol": "x", "initialValue": 3}])json") {
    return std::string(R"json({"format": "konjugate", "version": 1, "nodes": [
        {"id": 1, "name": "A", "states": )json") + aStates + R"json(, "sourceTerms": []},
        {"id": 2, "name": "B", "states": [{"id": 21, "name": "Y", "symbol": "y", "initialValue": 0},
                                          {"id": 22, "name": "S", "symbol": "s", "initialValue": 0},
                                          {"id": 23, "name": "T", "symbol": "t", "initialValue": 0}],
         "sourceTerms": [
            {"id": 24, "state": "s", "expression": "y + 1", "setsValue": true,
             "expressionModel": {"latex": "y + 1", "output": {"stateId": 22}, "mathJson": ["Add", "y", 1],
                                 "bindings": [{"kind": "state", "nodeId": 2, "stateId": 21, "symbol": "y"}]}},
            {"id": 25, "state": "t", "expression": "5", "setsValue": true,
             "expressionModel": {"latex": "5", "output": {"stateId": 23}, "mathJson": 5, "bindings": []}}]},
        {"id": 3, "name": "C", "states": [{"id": 31, "name": "Z", "symbol": "z", "initialValue": 0}], "sourceTerms": []})json" + extraNodes + R"json(
    ], "edges": [
        {"id": 5, "name": "B to C", "directionality": "directed", "source": {"nodeId": 2}, "target": {"nodeId": 3},
         "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "s", "kind": "state", "role": "source", "nodeId": 2, "stateId": 22}],
            "outputs": [{"role": "target", "stateId": 31, "mathJson": ["Multiply", 10, "s"], "setsValue": true}]}},
        {"id": 6, "name": "A to B", "directionality": "directed", "source": {"nodeId": 1}, "target": {"nodeId": 2},
         "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "x", "kind": "state", "role": "source", "nodeId": 1, "stateId": 11}],
            "outputs": [{"role": "target", "stateId": 21, "mathJson": ["Multiply", 2, "x"], "setsValue": true}]}})json" + extraEdges + R"json(
    ]})json";
}

void aSourceTermReadingAStateThePassSetsJoinsIt() {
    const auto document = parse(sourceTermChain());
    const auto result = konjugate::validateModel(document);
    for (const auto& issue : result.issues) if (issue.severity == "error") std::fprintf(stderr, "  %s: %s\n", issue.code.c_str(), issue.message.c_str());
    require(result.valid, "A relationship reading a source term that reads a relationship should be valid.");
    const auto plan = konjugate::compileExecutionPlan(document);
    require(plan.algebraicPass.size() == 3, "The pass should hold the two relationship outputs and the one source term that reads y.");
    require(plan.algebraicPass[0].kind == konjugate::AlgebraicStepKind::relationshipOutput &&
            plan.algebraicPass[1].kind == konjugate::AlgebraicStepKind::sourceTerm &&
            plan.algebraicPass[2].kind == konjugate::AlgebraicStepKind::relationshipOutput,
            "The source term should come between the relationship setting y and the one reading s.");
    auto states = plan.initialStates;
    konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    const auto at = [&](konjugate::EntityId id) { return states.at(plan.stateIndexes.at(id)); };
    require(at(21) == 6 && at(22) == 7 && at(31) == 70, "y = 2x, s = y + 1 and z = 10 s should all settle within one instant.");
    require(at(23) == 0, "A source term reading nothing the pass sets should not join it (t is set by its node, not here).");
}

void aLoopThroughASourceTermIsRefused() {
    // A.w = s (from B), and B.y = w + x (from A): y -> s -> w -> y.
    const auto aStates = R"json([{"id": 11, "name": "X", "symbol": "x", "initialValue": 3},
                                  {"id": 12, "name": "W", "symbol": "w", "initialValue": 0}])json";
    const auto loop = R"json(,
        {"id": 7, "name": "B to A", "directionality": "directed", "source": {"nodeId": 2}, "target": {"nodeId": 1},
         "parameters": [],
         "equationModel": {
            "bindings": [{"symbol": "s", "kind": "state", "role": "source", "nodeId": 2, "stateId": 22}],
            "outputs": [{"role": "target", "stateId": 12, "mathJson": "s", "setsValue": true}]}})json";
    auto text = sourceTermChain("", loop, aStates);
    const std::string from = R"json("outputs": [{"role": "target", "stateId": 21, "mathJson": ["Multiply", 2, "x"], "setsValue": true}])json";
    const std::string to = R"json("outputs": [{"role": "target", "stateId": 21, "mathJson": ["Add", "w", "x"], "setsValue": true}])json";
    text.replace(text.find(from), from.size(), to);
    const std::string bindings = R"json("bindings": [{"symbol": "x", "kind": "state", "role": "source", "nodeId": 1, "stateId": 11}],
            "outputs": [{"role": "target", "stateId": 21)json";
    const std::string withW = R"json("bindings": [{"symbol": "x", "kind": "state", "role": "source", "nodeId": 1, "stateId": 11},
                         {"symbol": "w", "kind": "state", "role": "source", "nodeId": 1, "stateId": 12}],
            "outputs": [{"role": "target", "stateId": 21)json";
    text.replace(text.find(bindings), bindings.size(), withW);
    const auto document = parse(text);
    require(hasIssue(konjugate::validateModel(document), "algebraicLoop"), "A loop through a setsValue source term should be algebraicLoop.");
    bool threw = false;
    try { static_cast<void>(konjugate::compileExecutionPlan(document)); } catch (const std::runtime_error&) { threw = true; }
    require(threw, "Compiling a loop through a source term should fail clearly.");
}

}

// ---- A state's `changes`: overTime or atEachInstant, checked against what reaches it ----

// Sets state `stateId`'s `changes` in `document`.
boost::property_tree::ptree withChanges(boost::property_tree::ptree document, konjugate::EntityId stateId, const std::string& changes) {
    for (auto& node : document.get_child("nodes")) {
        for (auto& state : node.second.get_child("states")) {
            if (state.second.get<konjugate::EntityId>("id") == stateId) state.second.put("changes", changes);
        }
    }
    return document;
}

bool onlyIssue(const konjugate::ValidationResult& result, const std::string& code) {
    return std::all_of(result.issues.begin(), result.issues.end(), [&](const auto& issue) { return issue.severity != "error" || issue.code == code; }) &&
        hasIssue(result, code);
}

void declaringWhatAStateAlreadyIsChangesNothing() {
    // y and z are set by relationships, s and t by setsValue source terms, x changes over time.
    auto document = parse(sourceTermChain());
    for (const auto stateId : {21, 22, 23, 31}) document = withChanges(document, stateId, "atEachInstant");
    document = withChanges(document, 11, "overTime");
    const auto result = konjugate::validateModel(document);
    for (const auto& issue : result.issues) std::fprintf(stderr, "  %s: %s\n", issue.code.c_str(), issue.message.c_str());
    require(result.valid && result.issues.empty(), "Declaring what each state already is should be valid, with nothing to say.");
    const auto declaredPlan = konjugate::compileExecutionPlan(document);
    const auto plainPlan = konjugate::compileExecutionPlan(parse(sourceTermChain()));
    auto declaredStates = declaredPlan.initialStates;
    auto plainStates = plainPlan.initialStates;
    konjugate::evaluateAlgebraicRelationships(declaredPlan, declaredStates, {}, {}, 0);
    konjugate::evaluateAlgebraicRelationships(plainPlan, plainStates, {}, {}, 0);
    require(declaredStates == plainStates, "Declaring what each state is should not change a single value.");
}

void theValidatorChecksAStatesChangesAgainstWhatReachesIt() {
    const auto base = parse(sourceTermChain());
    // s is set by a source term, so it cannot change over time.
    require(onlyIssue(konjugate::validateModel(withChanges(base, 22, "overTime")), "valueIntoChangingState"),
        "A state a source term sets, marked as changing over time, should be valueIntoChangingState alone.");
    // y is set by a relationship, likewise.
    require(onlyIssue(konjugate::validateModel(withChanges(base, 21, "overTime")), "valueIntoChangingState"),
        "A state a relationship sets, marked as changing over time, should be valueIntoChangingState alone.");
    require(hasIssue(konjugate::validateModel(withChanges(base, 22, "sometimes")), "stateChangesInvalid"),
        "An unknown changes should be stateChangesInvalid.");
    // x: nothing sets it and nothing gives it a rate, so marking it worked out is allowed but worth a word.
    const auto unset = konjugate::validateModel(withChanges(base, 11, "atEachInstant"));
    require(unset.valid && hasIssue(unset, "workedOutStateUnset"), "A worked-out state nothing sets should be valid, with workedOutStateUnset.");
    // An ordinary relationship into a state marked worked out sets its value; into one worked out only because a
    // source term sets it, it is a rate, and refused.
    const auto plainEdge = [](konjugate::EntityId targetNode, konjugate::EntityId targetState) {
        return R"json(,
        {"id": 70, "name": "Plain", "directionality": "directed", "source": {"nodeId": 3, "stateId": 31}, "target": {"nodeId": )json" + std::to_string(targetNode) +
            R"json(, "stateId": )json" + std::to_string(targetState) + R"json(},
         "parameters": [], "equationModel": {"latex": "1", "mathJson": 1, "bindings": [], "output": {"role": "target", "stateId": )json" + std::to_string(targetState) + "}}}";
    };
    require(konjugate::validateModel(withChanges(parse(sourceTermChain("", plainEdge(1, 11))), 11, "atEachInstant")).valid,
        "An ordinary relationship into a state marked worked out should be valid: it sets the value.");
    require(onlyIssue(konjugate::validateModel(parse(sourceTermChain("", plainEdge(2, 23)))), "rateIntoWorkedOutState"),
        "An ordinary relationship into a state a setsValue term sets, with no changes given, should be rateIntoWorkedOutState alone.");
    // A program sets its output after each step: not a value worked out at each instant.
    const auto program = R"json(,
        {"id": 4, "name": "P", "states": [{"id": 41, "name": "O", "symbol": "o", "initialValue": 0}], "sourceTerms": [],
         "implementation": {"kind": "python", "providerApiVersion": 1, "source": "class P: pass",
                            "bindings": [{"key": "in", "kind": "state", "nodeId": 2, "stateId": 21}],
                            "outputs": [{"key": "out", "stateId": 41, "setsValue": true}]}})json";
    require(konjugate::validateModel(parse(sourceTermChain(program))).valid, "A program setting its output should be valid as it is.");
    require(onlyIssue(konjugate::validateModel(withChanges(parse(sourceTermChain(program)), 41, "atEachInstant")), "programOutputWorkedOut"),
        "A program's output marked worked out should be programOutputWorkedOut alone.");
    require(konjugate::validateModel(withChanges(parse(sourceTermChain(program)), 41, "overTime")).valid,
        "A program's output marked as changing over time should be valid.");
}

// ---- Values from every kind of term sum (Rates and values, step 2) ----

// An ordinary single-equation relationship from `from`.`fromState` to `to`.`toState`, reading the source state as x.
std::string plainRelationship(int id, int from, int fromState, int to, int toState, const std::string& mathJson,
                              const std::string& directionality = "directed") {
    return R"json({"id": )json" + std::to_string(id) + R"json(, "name": "E)json" + std::to_string(id) + R"json(", "directionality": ")json" + directionality +
        R"json(", "source": {"nodeId": )json" + std::to_string(from) + R"json(, "stateId": )json" + std::to_string(fromState) +
        R"json(}, "target": {"nodeId": )json" + std::to_string(to) + R"json(, "stateId": )json" + std::to_string(toState) + R"json(}, "parameters": [],
        "equationModel": {"latex": "x", "mathJson": )json" + mathJson + R"json(, "output": {"role": "target", "stateId": )json" + std::to_string(toState) +
        R"json(}, "bindings": [{"kind": "state", "role": "source", "nodeId": )json" + std::to_string(from) + R"json(, "stateId": )json" + std::to_string(fromState) +
        R"json(, "symbol": "x"}]}})json";
}

std::string project(const std::string& nodes, const std::string& edges) {
    return R"json({"format": "konjugate", "version": 1, "nodes": [)json" + nodes + R"json(], "edges": [)json" + edges + "]}";
}

void aNeuronIsItsEquation() {
    // z = 0.8 x1 - 0.5 x2 + 0.3, with the bias the neuron's own term; y = 2 tanh(z). Every term an ordinary one.
    const auto document = parse(project(R"json(
        {"id": 1, "name": "In 1", "states": [{"id": 11, "name": "X1", "symbol": "x1", "initialValue": 0.5}], "sourceTerms": []},
        {"id": 2, "name": "In 2", "states": [{"id": 21, "name": "X2", "symbol": "x2", "initialValue": -1}], "sourceTerms": []},
        {"id": 3, "name": "Neuron", "states": [{"id": 31, "name": "Z", "symbol": "z", "initialValue": 0, "changes": "atEachInstant"}],
         "sourceTerms": [{"id": 32, "state": "z", "expression": "0.3", "expressionModel": {"latex": "0.3", "output": {"stateId": 31}, "mathJson": 0.3, "bindings": []}}]},
        {"id": 4, "name": "Out", "states": [{"id": 41, "name": "Y", "symbol": "y", "initialValue": 0, "changes": "atEachInstant"}], "sourceTerms": []})json",
        plainRelationship(5, 1, 11, 3, 31, R"json(["Multiply", 0.8, "x"])json") + "," +
        plainRelationship(6, 2, 21, 3, 31, R"json(["Multiply", -0.5, "x"])json") + "," +
        plainRelationship(7, 3, 31, 4, 41, R"json(["Multiply", 2, ["Tanh", "x"]])json")));
    const auto result = konjugate::validateModel(document);
    for (const auto& issue : result.issues) std::fprintf(stderr, "  %s: %s\n", issue.code.c_str(), issue.message.c_str());
    require(result.valid && result.issues.empty(), "A neuron written with ordinary terms into worked-out states should be valid, with nothing to say.");
    const auto plan = konjugate::compileExecutionPlan(document);
    const auto& neuron = *std::find_if(plan.nodes.begin(), plan.nodes.end(), [](const auto& node) { return node.nodeId == 3; });
    require(neuron.valueTerms.size() == 3 && neuron.algebraicTasks.empty() && neuron.contributions.empty(),
        "The neuron's two weighted inputs and its bias should be its three value terms: a relationship's term belongs to the node it lands on.");
    auto states = plan.initialStates;
    konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    const auto z = 0.8 * 0.5 - 0.5 * -1 + 0.3;
    require(std::abs(states.at(plan.stateIndexes.at(31)) - z) < 1e-15, "z should be the sum of the weighted inputs and the bias.");
    require(std::abs(states.at(plan.stateIndexes.at(41)) - 2 * std::tanh(z)) < 1e-15, "y should read z as summed within the instant.");
    // Worked out again from the same states, nothing is carried over.
    konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    require(std::abs(states.at(plan.stateIndexes.at(31)) - z) < 1e-15, "Working the pass out again should give the same z, not twice it.");
}

void valuesFromRelationshipsAndSourceTermsSum() {
    // y = 2x from a relationship's several equations, plus 1 from a setsValue source term: 7. s = y + 1 and z = 10 s follow.
    auto text = sourceTermChain();
    const std::string terms = R"json("sourceTerms": [
            {"id": 24,)json";
    const std::string withOne = R"json("sourceTerms": [
            {"id": 26, "state": "y", "expression": "1", "setsValue": true,
             "expressionModel": {"latex": "1", "output": {"stateId": 21}, "mathJson": 1, "bindings": []}},
            {"id": 24,)json";
    text.replace(text.find(terms), terms.size(), withOne);
    const auto document = parse(text);
    const auto result = konjugate::validateModel(document);
    for (const auto& issue : result.issues) if (issue.severity == "error") std::fprintf(stderr, "  %s: %s\n", issue.code.c_str(), issue.message.c_str());
    require(result.valid, "A setsValue source term and a relationship setting one state should be valid: they sum.");
    const auto plan = konjugate::compileExecutionPlan(document);
    auto states = plan.initialStates;
    konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    const auto at = [&](konjugate::EntityId id) { return states.at(plan.stateIndexes.at(id)); };
    require(at(21) == 7 && at(22) == 8 && at(31) == 80, "y = 2x + 1, s = y + 1 and z = 10 s should settle within one instant.");
}

void aNodesOwnTermsSumAndAreRefreshedEverySubstep() {
    // x grows at 1 per second; v = x and v = 2 from two of the node's own setsValue terms: v = x + 2, at every substep.
    const auto document = parse(project(R"json(
        {"id": 1, "name": "A", "numerics": {"substepsPerGlobalStep": 4},
         "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 0}, {"id": 12, "name": "V", "symbol": "v", "initialValue": 0}],
         "sourceTerms": [
            {"id": 13, "state": "x", "expression": "1", "expressionModel": {"latex": "1", "output": {"stateId": 11}, "mathJson": 1, "bindings": []}},
            {"id": 14, "state": "v", "expression": "x", "setsValue": true,
             "expressionModel": {"latex": "x", "output": {"stateId": 12}, "mathJson": "x", "bindings": [{"kind": "state", "nodeId": 1, "stateId": 11, "symbol": "x"}]}},
            {"id": 15, "state": "v", "expression": "2", "setsValue": true,
             "expressionModel": {"latex": "2", "output": {"stateId": 12}, "mathJson": 2, "bindings": []}}]})json", ""));
    const auto result = konjugate::validateModel(document);
    require(result.valid && hasIssue(result, "ownTermsAddUp"), "Two of a node's own terms setting one state should be valid, with ownTermsAddUp.");
    const auto plan = konjugate::compileExecutionPlan(document);
    require(plan.algebraicPass.empty() && plan.nodes.at(0).algebraicTasks.size() == 2, "Terms only the node reaches stay its own, out of the pass.");
    auto states = plan.initialStates;
    konjugate::settleAlgebraicStates(plan, states, {}, 0, 1);
    require(states.at(1) == 2, "Settled before the first step, v = 0 + 2.");
    const auto integrated = konjugate::integrateNode(plan.nodes.at(0), states, {}, 0, 1);
    require(integrated.states.at(0) == 1 && integrated.states.at(1) == 3, "After the step, x = 1 and v = x + 2 = 3, not carried over from before.");
}

void aBidirectionalRelationshipBetweenWorkedOutStatesAddsAndSubtracts() {
    // A flow of 2 from J1 to J2 between two junctions: J2 gains 2, J1 loses 2, as currents through a resistor.
    const auto document = parse(project(R"json(
        {"id": 1, "name": "J1", "states": [{"id": 11, "name": "I", "symbol": "i", "initialValue": 0, "changes": "atEachInstant"}], "sourceTerms": []},
        {"id": 2, "name": "J2", "states": [{"id": 21, "name": "I", "symbol": "i", "initialValue": 0, "changes": "atEachInstant"}], "sourceTerms": []})json",
        plainRelationship(5, 1, 11, 2, 21, "2", "bidirectional")));
    const auto result = konjugate::validateModel(document);
    for (const auto& issue : result.issues) if (issue.severity == "error") std::fprintf(stderr, "  %s: %s\n", issue.code.c_str(), issue.message.c_str());
    require(result.valid, "A bidirectional relationship between worked-out states should be valid.");
    const auto plan = konjugate::compileExecutionPlan(document);
    auto states = plan.initialStates;
    konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    require(states.at(plan.stateIndexes.at(11)) == -2 && states.at(plan.stateIndexes.at(21)) == 2, "J1 should be -2 and J2 +2.");
}

void aLoopOfOrdinaryRelationshipsBetweenWorkedOutStatesIsRefused() {
    const auto document = parse(project(R"json(
        {"id": 1, "name": "A", "states": [{"id": 11, "name": "A", "symbol": "a", "initialValue": 0, "changes": "atEachInstant"}], "sourceTerms": []},
        {"id": 2, "name": "B", "states": [{"id": 21, "name": "B", "symbol": "b", "initialValue": 0, "changes": "atEachInstant"}], "sourceTerms": []})json",
        plainRelationship(5, 1, 11, 2, 21, "\"x\"") + "," + plainRelationship(6, 2, 21, 1, 11, "\"x\"")));
    require(hasIssue(konjugate::validateModel(document), "algebraicLoop"), "Worked-out states setting each other in a loop should be algebraicLoop.");
}

void aProgramsOutputIsItsAlone() {
    // A program sets P.o after each step; a relationship's several equations set it too.
    const auto program = R"json(,
        {"id": 4, "name": "P", "states": [{"id": 41, "name": "O", "symbol": "o", "initialValue": 0}], "sourceTerms": [],
         "implementation": {"kind": "python", "providerApiVersion": 1, "source": "class P: pass",
                            "bindings": [{"key": "in", "kind": "state", "nodeId": 2, "stateId": 21}],
                            "outputs": [{"key": "out", "stateId": 41, "setsValue": true}]}})json";
    const auto shared = R"json(,
        {"id": 71, "name": "Into P", "directionality": "directed", "source": {"nodeId": 3}, "target": {"nodeId": 4}, "parameters": [],
         "equationModel": {"bindings": [{"symbol": "z", "kind": "state", "role": "source", "nodeId": 3, "stateId": 31}],
                           "outputs": [{"role": "target", "stateId": 41, "mathJson": "z", "setsValue": true}]}})json";
    require(onlyIssue(konjugate::validateModel(parse(sourceTermChain(program, shared))), "setsValueNotSoleContributor"),
        "A program's output also set by a relationship should be setsValueNotSoleContributor alone.");
}

void anUnusedBindingIsNeitherADependencyNorALoop() {
    // B.t = 5 is bound to B.y as the node editor binds every state of a node to each source term, but does not use it.
    // C.z = t and B.y = z: y depends on t, t does not depend on y, so there is no loop.
    const auto document = parse(R"json({"format": "konjugate", "version": 1, "nodes": [
        {"id": 2, "name": "B", "states": [{"id": 21, "name": "Y", "symbol": "y", "initialValue": 0}, {"id": 22, "name": "T", "symbol": "t", "initialValue": 0}],
         "sourceTerms": [{"id": 23, "state": "t", "expression": "5", "setsValue": true,
                          "expressionModel": {"latex": "5", "output": {"stateId": 22}, "mathJson": 5,
                                              "bindings": [{"kind": "state", "nodeId": 2, "stateId": 21, "symbol": "y"}]}}]},
        {"id": 3, "name": "C", "states": [{"id": 31, "name": "Z", "symbol": "z", "initialValue": 0}], "sourceTerms": []}
    ], "edges": [
        {"id": 5, "name": "B to C", "directionality": "directed", "source": {"nodeId": 2}, "target": {"nodeId": 3}, "parameters": [],
         "equationModel": {"bindings": [{"symbol": "t", "kind": "state", "role": "source", "nodeId": 2, "stateId": 22}],
                           "outputs": [{"role": "target", "stateId": 31, "mathJson": "t", "setsValue": true}]}},
        {"id": 6, "name": "C to B", "directionality": "directed", "source": {"nodeId": 3}, "target": {"nodeId": 2}, "parameters": [],
         "equationModel": {"bindings": [{"symbol": "z", "kind": "state", "role": "source", "nodeId": 3, "stateId": 31}],
                           "outputs": [{"role": "target", "stateId": 21, "mathJson": "z", "setsValue": true}]}}
    ]})json");
    const auto result = konjugate::validateModel(document);
    for (const auto& issue : result.issues) if (issue.severity == "error") std::fprintf(stderr, "  %s: %s\n", issue.code.c_str(), issue.message.c_str());
    require(result.valid, "A binding an equation does not use should not make a loop.");
    const auto plan = konjugate::compileExecutionPlan(document);
    auto states = plan.initialStates;
    konjugate::settleAlgebraicStates(plan, states, {}, 0, 1);
    konjugate::evaluateAlgebraicRelationships(plan, states, {}, {}, 0);
    const auto at = [&](konjugate::EntityId id) { return states.at(plan.stateIndexes.at(id)); };
    require(at(22) == 5 && at(31) == 5 && at(21) == 5, "t = 5, z = t and y = z.");
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
        aSourceTermReadingAStateThePassSetsJoinsIt();
        aLoopThroughASourceTermIsRefused();
        declaringWhatAStateAlreadyIsChangesNothing();
        theValidatorChecksAStatesChangesAgainstWhatReachesIt();
        aNeuronIsItsEquation();
        valuesFromRelationshipsAndSourceTermsSum();
        aNodesOwnTermsSumAndAreRefreshedEverySubstep();
        aBidirectionalRelationshipBetweenWorkedOutStatesAddsAndSubtracts();
        aLoopOfOrdinaryRelationshipsBetweenWorkedOutStatesIsRefused();
        aProgramsOutputIsItsAlone();
        anUnusedBindingIsNeitherADependencyNorALoop();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "algebraicRelationshipTests failed: %s\n", error.what());
        return 1;
    }
    std::printf("algebraicRelationshipTests passed\n");
    return 0;
}
