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
        "kind": "cpp",
        "providerApiVersion": 1,
        "source": "provider source",
        "bindings": [],
        "outputs": [{"key": "levelRate", "stateId": 11}]
    })json";
    const auto result = konjugate::validateModel(projectWithNodeImplementation(implementation));
    require(!result.valid, "A cpp-kind computational-node provider was incorrectly accepted.");
    require(hasIssue(result, "nodeProviderKindInvalid"), "The validator did not flag the unsupported node provider kind.");
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

}

int main() {
    try {
        validatorAcceptsACompleteComputationalNodeProvider();
        validatorRejectsInvalidNodeProviderKind();
        validatorRejectsDuplicateAndMissingNodeProviderOutputs();
        validatorWarnsOnUntouchedNodeProviderTemplate();
        executionPlanFoldsNodeProviderOutputsIntoNodeDerivatives();
        providerRuntimeExecutesNodeProviderPythonWorkerEndToEnd();
    } catch (const std::exception& error) {
        std::fprintf(stderr, "nodeProviderRuntimeTests failed: %s\n", error.what());
        return 1;
    }
    std::printf("nodeProviderRuntimeTests passed\n");
    return 0;
}
