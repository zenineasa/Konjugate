/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "konjugate/relationshipProvider.hpp"
#include "executionPlan.hpp"
#include "modelValidator.hpp"
#include "providerRuntime.hpp"
#include <boost/property_tree/json_parser.hpp>
#include <cstdio>
#include <span>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <stdlib.h>
inline int setenv(const char* name, const char* value, int overwrite) {
    if (!overwrite) {
        size_t size = 0;
        if (getenv_s(&size, nullptr, 0, name) == 0 && size > 0) {
            return 0;
        }
    }
    return _putenv_s(name, value);
}
#endif

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

bool hasIssue(const konjugate::ValidationResult& result, const std::string& code) {
    for (const auto& issue : result.issues) if (issue.code == code) return true;
    return false;
}

// A single node with two states so a computational-node provider's N-output shape (as opposed
// to a relationship/source-term's single output) has somewhere real to land: "level" and
// "effort" mirror the shape of the piControlledTankProject.json example without depending on it.
boost::property_tree::ptree projectWithNodeImplementation(const std::string& implementation) {
    std::istringstream json(R"json({
        "format": "konjugate",
        "version": 1,
        "nodes": [{
            "id": 1,
            "name": "Tank",
            "states": [
                {"id": 11, "name": "Level", "symbol": "level", "initialValue": 0},
                {"id": 12, "name": "Effort", "symbol": "effort", "initialValue": 0}
            ],
            "sourceTerms": [],
            "implementation": )json" + implementation + R"json(
        }],
        "edges": []
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    return project;
}

// Two separate nodes whose implementation blocks carry the IDENTICAL source text (bindings/
// outputs differ per node, pointing at each node's own states, but providerProcessKeyCache is
// derived from source text alone) -- exactly the shape that shares one compiled/loaded artifact
// between them (see providerProcessKey()/ProviderRuntime::initialize). Proves an in-process node
// provider's per-instance state (providerInProcessNodeShim.cpp's InstanceBinding) is genuinely
// independent per node, not accidentally shared -- the bug this shim design was specifically
// fixed to avoid before any real FMI-import glue could depend on it.
boost::property_tree::ptree twoNodesSharingOneCppImplementation(const std::string& source) {
    std::istringstream json(R"json({
        "format": "konjugate",
        "version": 1,
        "nodes": [
            {
                "id": 1, "name": "A",
                "states": [{"id": 11, "name": "Level", "symbol": "level", "initialValue": 0}],
                "sourceTerms": [],
                "implementation": {
                    "kind": "cpp",
                    "providerApiVersion": 1,
                    "source": "placeholder-replaced-below",
                    "bindings": [{"key": "input", "kind": "state", "stateId": 11}],
                    "outputs": [{"key": "output", "stateId": 11}]
                }
            },
            {
                "id": 2, "name": "B",
                "states": [{"id": 21, "name": "Level", "symbol": "level", "initialValue": 0}],
                "sourceTerms": [],
                "implementation": {
                    "kind": "cpp",
                    "providerApiVersion": 1,
                    "source": "placeholder-replaced-below",
                    "bindings": [{"key": "input", "kind": "state", "stateId": 21}],
                    "outputs": [{"key": "output", "stateId": 21}]
                }
            }
        ],
        "edges": []
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    // Set directly on the ptree rather than embedding in the JSON literal above, so the inline
    // C++ source's quotes and braces never have to survive JSON-string escaping -- same reasoning
    // as providerRuntimeCompilesAndExecutesAnInlineCppProviderEndToEnd in relationshipProviderTests.cpp.
    auto nodeIt = project.get_child("nodes").begin();
    nodeIt->second.put("implementation.source", source);
    ++nodeIt;
    nodeIt->second.put("implementation.source", source);
    return project;
}

std::string validNodeImplementation() {
    return R"json({
        "kind": "python",
        "providerApiVersion": 1,
        "source": "provider source",
        "bindings": [
            {"key": "input", "kind": "state", "stateId": 11}
        ],
        "outputs": [
            {"key": "levelRate", "stateId": 11},
            {"key": "effortRateSquared", "stateId": 12}
        ]
    })json";
}

// One setsValue output (level, driven algebraically) and one ordinary derivative output (effort) --
// binds only "effort" as an input, so this is deliberately not self-referencing (see
// nodeProviderSelfReferencingSetsValueImplementation below for that case).
std::string nodeImplementationWithSetsValueOutput() {
    return R"json({
        "kind": "python",
        "providerApiVersion": 1,
        "source": "provider source",
        "bindings": [
            {"key": "input", "kind": "state", "stateId": 12}
        ],
        "outputs": [
            {"key": "levelRate", "stateId": 11, "setsValue": true},
            {"key": "effortRateSquared", "stateId": 12}
        ]
    })json";
}

// A setsValue output whose own target state (11) is also one of this provider's own input
// bindings -- the self-reference case setsValueSelfReference exists to reject.
std::string nodeProviderSelfReferencingSetsValueImplementation() {
    return R"json({
        "kind": "python",
        "providerApiVersion": 1,
        "source": "provider source",
        "bindings": [
            {"key": "input", "kind": "state", "stateId": 11}
        ],
        "outputs": [
            {"key": "levelRate", "stateId": 11, "setsValue": true}
        ]
    })json";
}

// A node whose own computational-node-provider output sets state 11's value directly, while an
// ordinary equation source term on the same node ALSO contributes to state 11 -- the same
// silently-fight-each-other conflict setsValueNotSoleContributor exists to reject, just with a
// node-provider output on one side instead of two source terms.
boost::property_tree::ptree nodeProviderSetsValueSharingStateWithSourceTermProject() {
    std::istringstream json(R"json({
        "format": "konjugate",
        "version": 1,
        "nodes": [{
            "id": 1,
            "name": "Tank",
            "states": [
                {"id": 11, "name": "Level", "symbol": "level", "initialValue": 0},
                {"id": 12, "name": "Effort", "symbol": "effort", "initialValue": 0}
            ],
            "sourceTerms": [{
                "id": 21, "state": "level", "expression": "1",
                "expressionModel": {"latex": "1", "bindings": [], "output": {"stateId": 11}, "mathJson": 1}
            }],
            "implementation": {
                "kind": "python",
                "providerApiVersion": 1,
                "source": "provider source",
                "bindings": [],
                "outputs": [{"key": "levelRate", "stateId": 11, "setsValue": true}]
            }
        }],
        "edges": []
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    return project;
}

// Proves evaluateContributionTasks routes a setsValue output into algebraicNodeProviderWrites (a
// plain replacement) rather than the ordinary derivative-contribution list, while an unmarked
// output on the same provider is unaffected.
class SetsValueNodeEvaluator final : public konjugate::ProviderEvaluator {
public:
    std::vector<double> evaluateBatch(const std::vector<const konjugate::ContributionTask*>&,
                                      const std::vector<std::span<const double>>&,
                                      double, double) override {
        throw std::runtime_error("This test expects only computational-node evaluation.");
    }

    std::vector<std::pair<std::string, double>> evaluateNode(
        const konjugate::NodeProviderTask&, std::span<const double>, double, double) override {
        return {{"levelRate", 42.0}, {"effortRateSquared", 3.0}};
    }
};

// Proves evaluateContributionTasks resolves a NodeProviderTask's bindings and folds its named
// outputs into the right state indexes, without spawning a real worker process.
class RecordingNodeEvaluator final : public konjugate::ProviderEvaluator {
public:
    std::vector<double> evaluateBatch(const std::vector<const konjugate::ContributionTask*>&,
                                      const std::vector<std::span<const double>>&,
                                      double, double) override {
        throw std::runtime_error("This test expects only computational-node evaluation.");
    }

    std::vector<std::pair<std::string, double>> evaluateNode(
        const konjugate::NodeProviderTask& task, std::span<const double> inputs,
        double simulationTime, double stepSize) override {
        require(task.outputs.size() == 2, "The evaluator received an unexpected node provider task.");
        require(inputs.size() == 1 && inputs[0] == 300, "The evaluator received incorrectly resolved node provider inputs.");
        require(simulationTime == 4.5 && stepSize == 0.01, "The evaluator received incorrect substep timing.");
        called = true;
        return {{"levelRate", 7.0}, {"effortRateSquared", 2.0}};
    }

    bool called = false;
};

void validatorAcceptsACompleteComputationalNodeProvider() {
    const auto project = projectWithNodeImplementation(validNodeImplementation());
    const auto result = konjugate::validateModel(project);
    require(result.valid, "A complete computational-node provider was rejected.");
    const auto plan = konjugate::compileExecutionPlan(project);
    require(plan.nodes.front().nodeProvider.has_value(), "compileExecutionPlan did not populate the node's provider task.");
    const auto& task = *plan.nodes.front().nodeProvider;
    require(task.implementation == konjugate::ContributionImplementation::pythonProvider,
        "The execution plan did not preserve the computational-node implementation kind.");
    require(task.bindings.size() == 1 && task.bindings.front().symbol == "input",
        "The execution plan did not preserve the node provider's input binding.");
    require(task.outputs.size() == 2 && task.outputs[0].key == "levelRate" && task.outputs[1].key == "effortRateSquared",
        "The execution plan did not preserve the node provider's declared outputs.");
    require(task.outputs[0].stateIndex == 0 && task.outputs[1].stateIndex == 1,
        "The execution plan resolved node provider output states to the wrong local index.");
    require(task.providerProcessKeyCache == "py:provider source",
        "The execution plan did not derive the expected provider process key.");
}

void validatorRejectsInvalidNodeProviderKind() {
    const std::string implementation = R"json({
        "kind": "rust",
        "providerApiVersion": 1,
        "source": "provider source",
        "bindings": [],
        "outputs": [{"key": "levelRate", "stateId": 11}]
    })json";
    const auto result = konjugate::validateModel(projectWithNodeImplementation(implementation));
    require(!result.valid, "An unsupported-kind computational-node provider was incorrectly accepted.");
    require(hasIssue(result, "nodeProviderKindInvalid"), "The validator did not flag the unsupported node provider kind.");
}

void validatorAcceptsACppComputationalNodeProvider() {
    const std::string implementation = R"json({
        "kind": "cpp",
        "providerApiVersion": 1,
        "source": "provider source",
        "bindings": [{"key": "input", "kind": "state", "stateId": 11}],
        "outputs": [{"key": "levelRate", "stateId": 11}]
    })json";
    const auto result = konjugate::validateModel(projectWithNodeImplementation(implementation));
    require(result.valid, "A complete cpp-kind computational-node provider was rejected.");
    const auto plan = konjugate::compileExecutionPlan(projectWithNodeImplementation(implementation));
    const auto& task = *plan.nodes.front().nodeProvider;
    require(task.implementation == konjugate::ContributionImplementation::cppProvider,
        "The execution plan did not preserve the cpp computational-node implementation kind.");
    require(task.providerProcessKeyCache == "cpp:provider source",
        "The execution plan did not derive the expected provider process key for a cpp node provider.");
}

void validatorRejectsDuplicateAndMissingNodeProviderOutputs() {
    const std::string implementation = R"json({
        "kind": "python",
        "providerApiVersion": 1,
        "source": "provider source",
        "bindings": [],
        "outputs": [
            {"key": "levelRate", "stateId": 11},
            {"key": "levelRate", "stateId": 12},
            {"key": "missingOutput", "stateId": 999}
        ]
    })json";
    const auto result = konjugate::validateModel(projectWithNodeImplementation(implementation));
    require(!result.valid, "Invalid computational-node provider outputs were incorrectly accepted.");
    require(hasIssue(result, "nodeProviderOutputKeyDuplicate"), "The validator did not flag the duplicate output key.");
    require(hasIssue(result, "nodeProviderOutputMissing"), "The validator did not flag the output referencing a missing state.");
}

void validatorWarnsOnUntouchedNodeProviderTemplate() {
    const std::string implementation = R"json({
        "kind": "python",
        "providerApiVersion": 1,
        "source": "# TODO: read inputs",
        "bindings": [],
        "outputs": [{"key": "levelRate", "stateId": 11}]
    })json";
    const auto result = konjugate::validateModel(projectWithNodeImplementation(implementation));
    require(result.valid, "An untouched node provider template should warn, not block, a run.");
    require(hasIssue(result, "nodeProviderImplementationIncomplete"),
        "The validator did not warn about the untouched node provider template.");
}

void executionPlanFoldsNodeProviderOutputsIntoNodeDerivatives() {
    const auto plan = konjugate::compileExecutionPlan(projectWithNodeImplementation(validNodeImplementation()));
    const auto& node = plan.nodes.front();
    RecordingNodeEvaluator evaluator;
    const auto evaluated = konjugate::evaluateContributionTasks(
        node, {300, 0}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 4.5, 0.01, &evaluator);
    require(evaluator.called, "evaluateContributionTasks did not call the node provider evaluator.");
    require(evaluated.size() == 2, "evaluateContributionTasks did not fold both declared node provider outputs.");
    for (const auto& contribution : evaluated) {
        if (contribution.outputStateIndex == 0) require(contribution.value == 7.0, "levelRate was folded into the wrong state.");
        else if (contribution.outputStateIndex == 1) require(contribution.value == 2.0, "effortRateSquared was folded into the wrong state.");
        else throw std::runtime_error("A node provider contribution targeted an unexpected state index.");
    }
}

void validatorAcceptsANodeProviderSetsValueOutputAsSoleContributor() {
    const auto project = projectWithNodeImplementation(nodeImplementationWithSetsValueOutput());
    const auto result = konjugate::validateModel(project);
    require(result.valid, "A setsValue node-provider output as the sole contributor to its state was rejected.");
    require(!hasIssue(result, "setsValueNotSoleContributor"), "A sole setsValue node-provider contributor was incorrectly flagged.");
    const auto plan = konjugate::compileExecutionPlan(project);
    const auto& outputs = plan.nodes.front().nodeProvider->outputs;
    require(outputs[0].setsValue, "The execution plan did not preserve the node provider output's setsValue flag.");
    require(!outputs[1].setsValue, "The execution plan incorrectly set setsValue on an ordinary node provider output.");
}

void validatorRejectsANodeProviderSetsValueOutputSharingItsStateWithASourceTerm() {
    const auto result = konjugate::validateModel(nodeProviderSetsValueSharingStateWithSourceTermProject());
    require(!result.valid, "A setsValue node-provider output sharing its state with a source term was incorrectly accepted.");
    require(hasIssue(result, "setsValueNotSoleContributor"),
        "The validator did not flag a setsValue node-provider output sharing its state with a source term.");
}

void validatorRejectsANodeProviderSetsValueSelfReference() {
    const auto project = projectWithNodeImplementation(nodeProviderSelfReferencingSetsValueImplementation());
    const auto result = konjugate::validateModel(project);
    require(!result.valid, "A self-referencing setsValue node-provider output was incorrectly accepted.");
    require(hasIssue(result, "setsValueSelfReference"),
        "The validator did not flag a setsValue node-provider output bound as one of its own provider's inputs.");
    bool threw = false;
    try {
        konjugate::compileExecutionPlan(project);
    } catch (const std::exception&) {
        threw = true;
    }
    require(threw, "compileExecutionPlan should defensively reject a self-referencing setsValue node-provider output too, "
        "since main.cpp's run command compiles without validating first.");
}

void executionPlanRoutesSetsValueNodeProviderOutputsAsAlgebraicWrites() {
    const auto plan = konjugate::compileExecutionPlan(projectWithNodeImplementation(nodeImplementationWithSetsValueOutput()));
    const auto& node = plan.nodes.front();
    SetsValueNodeEvaluator evaluator;
    std::vector<std::pair<std::size_t, double>> algebraicWrites;
    const auto evaluated = konjugate::evaluateContributionTasks(
        node, {0, 0}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &evaluator, &algebraicWrites);
    require(evaluated.size() == 1 && evaluated.front().outputStateIndex == 1 && evaluated.front().value == 3.0,
        "The ordinary (non-setsValue) node provider output should still be folded into the derivative-contribution list.");
    require(algebraicWrites.size() == 1 && algebraicWrites.front().first == 0 && algebraicWrites.front().second == 42.0,
        "The setsValue node provider output should be routed into algebraicNodeProviderWrites, not the derivative list.");
}

void executionPlanThrowsWhenASetsValueNodeProviderOutputHasNowhereToRouteTo() {
    const auto plan = konjugate::compileExecutionPlan(projectWithNodeImplementation(nodeImplementationWithSetsValueOutput()));
    const auto& node = plan.nodes.front();
    SetsValueNodeEvaluator evaluator;
    bool threw = false;
    try {
        konjugate::evaluateContributionTasks(
            node, {0, 0}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &evaluator);
    } catch (const std::exception&) {
        threw = true;
    }
    require(threw, "A setsValue node provider output with no algebraicNodeProviderWrites sink should fail loudly, not silently drop the write.");
}

void integrateNodeAppliesSetsValueNodeProviderOutputsDirectlyNotIntegrated() {
    const auto plan = konjugate::compileExecutionPlan(projectWithNodeImplementation(nodeImplementationWithSetsValueOutput()));
    const auto& node = plan.nodes.front();
    SetsValueNodeEvaluator evaluator;
    const auto result = konjugate::integrateNode(node, plan.initialStates, {}, 0.0, 1.0, &evaluator);
    // "level" (setsValue) should snap directly to 42, never accumulated across the (single)
    // substep -- "effort" (ordinary) should Euler-integrate its derivative: 0 + 1.0 * 3.0 = 3.
    require(result.states.at(0) == 42.0, "A setsValue node-provider output should be written directly into its state, not integrated.");
    require(result.states.at(1) == 3.0, "An ordinary node-provider output should still be Euler-integrated as a derivative.");
}

// The key end-to-end case: a real ProviderRuntime, talking the actual worker protocol to a real
// Python subprocess (not just the in-memory SDK contract sdkProvidesCheckpointableNodeProviderContract
// already covers in relationshipProviderTests.cpp), proving evaluate/checkpoint/restore all reach
// the real worker. The source is supplied inline (not as a file path), exercising the same
// literal-source path an author would use when writing a node provider directly in the editor.
std::string inlineAccumulatorNodeSource() {
    return R"py(
import struct
from konjugate import NodeOutputCollector, NodeProvider, NodeProviderDescription, ScalarPort


class TestAccumulatorNode(NodeProvider):
    def __init__(self):
        self.total = 0.0

    def describe(self):
        return NodeProviderDescription(
            "test.accumulatorNode", "Accumulator node",
            [ScalarPort("input", "Input", "")],
            [ScalarPort("output", "Output", "")],
        )

    def evaluate(self, context, inputs, outputs):
        self.total += inputs["input"] * context.step_size
        outputs.add_gradient("output", self.total)

    def checkpoint(self):
        return struct.pack("!d", self.total)

    def restore(self, payload):
        self.total = struct.unpack("!d", payload)[0]
)py";
}

void providerRuntimeExecutesNodeProviderPythonWorkerEndToEnd() {
    const std::string implementation = R"json({
        "kind": "python",
        "providerApiVersion": 1,
        "source": "placeholder-replaced-below",
        "bindings": [
            {"key": "input", "kind": "state", "stateId": 11}
        ],
        "outputs": [
            {"key": "output", "stateId": 11}
        ]
    })json";

    auto project = projectWithNodeImplementation(implementation);
    // Set directly on the ptree rather than embedding in the JSON literal above, so the inline
    // Python source's quotes and newlines never have to survive JSON-string escaping -- same
    // reasoning as providerRuntimeCompilesAndExecutesAnInlineCppProviderEndToEnd's C++ case.
    project.get_child("nodes").begin()->second.put("implementation.source", inlineAccumulatorNodeSource());

    const auto plan = konjugate::compileExecutionPlan(project);
    konjugate::ProviderConfiguration config;
    config.pythonInterpreter = "python3";
    ::setenv("PYTHONPATH", "../sdk/python", 1);

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto& task = *plan.nodes.front().nodeProvider;

    const double firstInputs[] = {4.0};
    const auto firstResult = runtime.evaluateNode(task, firstInputs, 0.0, 0.5);
    require(firstResult.size() == 1 && firstResult.front().first == "output" && firstResult.front().second == 2.0,
        "The first node provider evaluation over the real worker produced the wrong result.");

    const double secondInputs[] = {4.0};
    const auto secondResult = runtime.evaluateNode(task, secondInputs, 0.5, 0.5);
    require(secondResult.front().second == 4.0,
        "The second node provider evaluation did not accumulate state across calls.");

    const auto checkpoint = runtime.requestNodeCheckpoint(task);
    require(checkpoint.size() == 8, "The node provider checkpoint payload had an unexpected size.");

    // Mutate the real subprocess's state well past the checkpointed value, so a later evaluation
    // proves restore actually reached the subprocess rather than trivially matching by coincidence.
    const double mutateInputs[] = {100.0};
    runtime.evaluateNode(task, mutateInputs, 1.0, 0.5);

    runtime.requestNodeRestore(task, checkpoint);

    const double thirdInputs[] = {0.0};
    const auto thirdResult = runtime.evaluateNode(task, thirdInputs, 1.5, 0.5);
    require(thirdResult.front().second == 4.0,
        "Restore did not reach the real subprocess: the accumulated total was not rolled back.");

    runtime.shutdown();
}

// The C++ analogue of inlineAccumulatorNodeSource() above/providerRuntimeExecutesNodeProviderPythonWorkerEndToEnd:
// proves InProcessNodeProviderBackend (dlopen, KonjugateInProcessNodeProviderV1, no worker
// process at all) drives evaluate/checkpoint/restore correctly against a real compiled artifact,
// not just the in-memory SDK contract sdkProvidesCheckpointableNodeProviderContract already
// covers in relationshipProviderTests.cpp.
std::string cppInlineAccumulatorNodeSource() {
    return R"cpp(
#include <konjugate/relationshipProvider.hpp>
#include <cstring>
#include <memory>
#include <vector>

namespace {

class AccumulatorNode final : public konjugate::sdk::v1::NodeProvider {
public:
    konjugate::sdk::v1::NodeProviderDescription describe() const override {
        return {"test.cppAccumulatorNode", "Accumulator node",
            {{"input", "Input", ""}},
            {{"output", "Output", ""}}};
    }

    void evaluate(const konjugate::sdk::v1::EvaluationContext& context,
                  konjugate::sdk::v1::NodeOutputCollector& outputs) override {
        total_ += context.inputs.at("input") * context.stepSize;
        outputs.addGradient("output", total_);
    }

    std::vector<std::byte> checkpoint() const override {
        std::vector<std::byte> bytes(sizeof(double));
        std::memcpy(bytes.data(), &total_, sizeof(double));
        return bytes;
    }

    void restore(std::span<const std::byte> payload) override {
        std::memcpy(&total_, payload.data(), sizeof(double));
    }

private:
    double total_ = 0.0;
};

}

std::unique_ptr<konjugate::sdk::v1::NodeProvider> createNodeProvider() {
    return std::make_unique<AccumulatorNode>();
}
)cpp";
}

void providerRuntimeExecutesNodeProviderCppInProcessEndToEnd() {
    const std::string implementation = R"json({
        "kind": "cpp",
        "providerApiVersion": 1,
        "source": "placeholder-replaced-below",
        "bindings": [
            {"key": "input", "kind": "state", "stateId": 11}
        ],
        "outputs": [
            {"key": "output", "stateId": 11}
        ]
    })json";

    auto project = projectWithNodeImplementation(implementation);
    project.get_child("nodes").begin()->second.put("implementation.source", cppInlineAccumulatorNodeSource());

    const auto plan = konjugate::compileExecutionPlan(project);
    konjugate::ProviderConfiguration config;
    config.cppSdkPath = "..";
    config.executionMode = konjugate::ProviderExecutionMode::inProcess;

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto& task = *plan.nodes.front().nodeProvider;

    const double firstInputs[] = {4.0};
    const auto firstResult = runtime.evaluateNode(task, firstInputs, 0.0, 0.5);
    require(firstResult.size() == 1 && firstResult.front().first == "output" && firstResult.front().second == 2.0,
        "The first in-process C++ node provider evaluation produced the wrong result.");

    const auto secondResult = runtime.evaluateNode(task, firstInputs, 0.5, 0.5);
    require(secondResult.front().second == 4.0,
        "The second in-process C++ node provider evaluation did not accumulate state across calls.");

    const auto checkpoint = runtime.requestNodeCheckpoint(task);
    require(checkpoint.size() == sizeof(double), "The C++ node provider checkpoint payload had an unexpected size.");

    const double mutateInputs[] = {100.0};
    runtime.evaluateNode(task, mutateInputs, 1.0, 0.5);

    runtime.requestNodeRestore(task, checkpoint);

    const double thirdInputs[] = {0.0};
    const auto thirdResult = runtime.evaluateNode(task, thirdInputs, 1.5, 0.5);
    require(thirdResult.front().second == 4.0,
        "Restore did not reach the in-process artifact: the accumulated total was not rolled back.");

    runtime.shutdown();
}

void providerRuntimeGivesEachCppNodeProviderInstanceIndependentState() {
    auto project = twoNodesSharingOneCppImplementation(cppInlineAccumulatorNodeSource());
    const auto plan = konjugate::compileExecutionPlan(project);
    require(plan.nodes[0].nodeProvider->providerProcessKeyCache == plan.nodes[1].nodeProvider->providerProcessKeyCache,
        "Test setup expected both nodes to share one provider process key.");

    konjugate::ProviderConfiguration config;
    config.cppSdkPath = "..";
    config.executionMode = konjugate::ProviderExecutionMode::inProcess;

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto& taskA = *plan.nodes[0].nodeProvider;
    const auto& taskB = *plan.nodes[1].nodeProvider;

    // Drive A far ahead of B, then confirm B still reads back as if it had never been touched --
    // if the shim accidentally shared one NodeProvider object across both instances, B would see
    // A's accumulated total instead of its own.
    const double drive[] = {4.0};
    runtime.evaluateNode(taskA, drive, 0.0, 1.0);
    runtime.evaluateNode(taskA, drive, 1.0, 1.0);
    runtime.evaluateNode(taskA, drive, 2.0, 1.0);

    const double zero[] = {0.0};
    const auto resultB = runtime.evaluateNode(taskB, zero, 0.0, 1.0);
    require(resultB.front().second == 0.0,
        "Two node-provider instances sharing one in-process artifact did not have independent state.");

    const auto checkpointA = runtime.requestNodeCheckpoint(taskA);
    const auto checkpointB = runtime.requestNodeCheckpoint(taskB);
    require(checkpointA != checkpointB,
        "Two independently-driven node-provider instances produced identical checkpoints -- state is likely shared.");

    runtime.shutdown();
}

void providerRuntimeRejectsACppNodeProviderOutsideInProcessMode() {
    const std::string implementation = R"json({
        "kind": "cpp",
        "providerApiVersion": 1,
        "source": "placeholder-replaced-below",
        "bindings": [{"key": "input", "kind": "state", "stateId": 11}],
        "outputs": [{"key": "output", "stateId": 11}]
    })json";

    auto project = projectWithNodeImplementation(implementation);
    project.get_child("nodes").begin()->second.put("implementation.source", cppInlineAccumulatorNodeSource());

    const auto plan = konjugate::compileExecutionPlan(project);
    konjugate::ProviderConfiguration config;
    config.cppSdkPath = "..";
    config.executionMode = konjugate::ProviderExecutionMode::sharedMemoryWorker;

    konjugate::ProviderRuntime runtime(config);
    bool threw = false;
    try {
        runtime.initialize(plan);
    } catch (const std::exception&) {
        threw = true;
    }
    require(threw, "A cpp computational-node provider outside in-process mode should fail clearly, not fall back to a worker process.");
}

}

int main() {
    try {
        validatorAcceptsACompleteComputationalNodeProvider();
        validatorRejectsInvalidNodeProviderKind();
        validatorAcceptsACppComputationalNodeProvider();
        validatorRejectsDuplicateAndMissingNodeProviderOutputs();
        validatorWarnsOnUntouchedNodeProviderTemplate();
        executionPlanFoldsNodeProviderOutputsIntoNodeDerivatives();
        validatorAcceptsANodeProviderSetsValueOutputAsSoleContributor();
        validatorRejectsANodeProviderSetsValueOutputSharingItsStateWithASourceTerm();
        validatorRejectsANodeProviderSetsValueSelfReference();
        executionPlanRoutesSetsValueNodeProviderOutputsAsAlgebraicWrites();
        executionPlanThrowsWhenASetsValueNodeProviderOutputHasNowhereToRouteTo();
        integrateNodeAppliesSetsValueNodeProviderOutputsDirectlyNotIntegrated();
        providerRuntimeExecutesNodeProviderPythonWorkerEndToEnd();
        providerRuntimeExecutesNodeProviderCppInProcessEndToEnd();
        providerRuntimeGivesEachCppNodeProviderInstanceIndependentState();
        providerRuntimeRejectsACppNodeProviderOutsideInProcessMode();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "nodeProviderRuntimeTests failed: %s\n", error.what());
        return 1;
    }
    std::printf("nodeProviderRuntimeTests passed\n");
    return 0;
}
