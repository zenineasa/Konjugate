/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "konjugate/relationshipProvider.hpp"
#include "executionPlan.hpp"
#include "modelValidator.hpp"
#include "providerRuntime.hpp"
#include <atomic>
#include <cstdlib>
#include <boost/property_tree/json_parser.hpp>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

boost::property_tree::ptree projectWithImplementation(const std::string& implementation) {
    std::istringstream json(R"json({
        "format": "konjugate",
        "version": 1,
        "nodes": [
            {"id": 1, "name": "Source", "states": [{"id": 11, "name": "Temperature", "symbol": "temperature", "initialValue": 300}], "sourceTerms": []},
            {"id": 2, "name": "Target", "states": [{"id": 12, "name": "Temperature", "symbol": "temperature", "initialValue": 290}], "sourceTerms": []}
        ],
        "edges": [{
            "id": 3,
            "name": "Programmable heat transfer",
            "source": {"nodeId": 1},
            "target": {"nodeId": 2},
            "parameters": [{"id": 13, "name": "Conductance", "symbol": "conductance", "value": 2, "mode": "constant"}],
            "implementation": )json" + implementation + R"json(
        }]
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    return project;
}

std::string validImplementation() {
    return R"json({
        "kind": "cpp",
        "providerApiVersion": 1,
        "source": "provider source",
        "bindings": [
            {"key": "sourceTemperature", "kind": "state", "nodeId": 1, "stateId": 11},
            {"key": "conductance", "kind": "parameter", "parameterId": 13}
        ],
        "output": {"key": "targetTemperatureGradient", "role": "target", "stateId": 12}
    })json";
}

bool hasIssue(const konjugate::ValidationResult& result, const std::string& code) {
    for (const auto& issue : result.issues) if (issue.code == code) return true;
    return false;
}

class RecordingEvaluator final : public konjugate::ProviderEvaluator {
public:
    double evaluate(const konjugate::ContributionTask& task,
                    const std::vector<double>& inputs,
                    double simulationTime,
                    double stepSize) override {
        require(task.providerOutputKey == "targetTemperatureGradient", "The evaluator received the wrong provider task.");
        require(inputs == std::vector<double>({300, 2}), "The evaluator received incorrectly resolved provider inputs.");
        require(simulationTime == 4.5 && stepSize == 0.01, "The evaluator received incorrect substep timing.");
        called = true;
        return inputs[1] * inputs[0];
    }

    bool called = false;
};

class ConductanceProvider final : public konjugate::sdk::v1::RelationshipProvider {
public:
    konjugate::sdk::v1::RelationshipDescription describe() const override {
        return {"test.conductance", "Conductance", {{"delta", "Temperature difference", "K"}},
            {"gradient", "Temperature gradient", "K/s"}};
    }

    void evaluate(const konjugate::sdk::v1::EvaluationContext& context,
                  konjugate::sdk::v1::OutputCollector& output) override {
        output.addGradient(context.inputs.at("delta") * 2);
    }
};

void sdkProvidesStableKeyedReadOnlyInputsAndAdditiveOutput() {
    ConductanceProvider provider;
    const double values[] = {4};
    const std::string_view keys[] = {"delta"};
    konjugate::sdk::v1::OutputCollector output;
    provider.evaluate({1.5, 0.01, {values, keys}}, output);
    require(output.gradient() == 8, "The public provider SDK did not preserve scalar input/output semantics.");
    require(provider.describe().inputs.front().key == "delta", "The provider description lost its stable input key.");
}

void validatorAcceptsACompleteProgrammableRelationship() {
    const auto project = projectWithImplementation(validImplementation());
    const auto result = konjugate::validateModel(project);
    require(result.valid, "A complete programmable relationship was rejected.");
    require(!hasIssue(result, "edgeEquationEmpty"), "A programmable relationship was incorrectly validated as an equation.");
    const auto plan = konjugate::compileExecutionPlan(project);
    const auto& task = plan.nodes.at(1).contributions.front();
    require(task.implementation == konjugate::ContributionImplementation::cppProvider,
        "The execution plan did not preserve the programmable implementation kind.");
    require(task.bindings.at(0).symbol == "sourceTemperature" && task.providerOutputKey == "targetTemperatureGradient",
        "The execution plan did not preserve stable provider port keys.");
}

void validatorRejectsMissingProviderBindingsAndOutputState() {
    auto invalid = validImplementation();
    invalid.replace(invalid.find("\"bindings\""), std::string("\"bindings\"").size(), "\"unusedBindings\"");
    invalid.replace(invalid.find("\"stateId\": 12"), std::string("\"stateId\": 12").size(), "\"stateId\": 999");
    const auto result = konjugate::validateModel(projectWithImplementation(invalid));
    require(!result.valid, "An invalid programmable relationship was accepted.");
    require(hasIssue(result, "providerBindingsEmpty"), "Missing provider inputs were not diagnosed.");
    require(hasIssue(result, "providerOutputMissing"), "A missing provider output state was not diagnosed.");
}

void executionDelegatesResolvedScalarsWithoutChangingCadence() {
    const auto plan = konjugate::compileExecutionPlan(projectWithImplementation(validImplementation()));
    const auto& node = plan.nodes.at(1);
    RecordingEvaluator evaluator;
    const auto evaluated = konjugate::evaluateContributionTasks(
        node, {290}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 4.5, 0.01, &evaluator);
    require(evaluator.called && evaluated.front().value == 600,
        "The programmable contribution was not delegated through the execution plan.");
}

void providerRuntimeExecutesPythonWorkerEndToEnd() {
    std::string pythonImpl = R"json({
        "kind": "python",
        "providerApiVersion": 1,
        "source": "../tests/pythonRelationshipProviderTest.py",
        "bindings": [
            {"key": "delta", "kind": "state", "nodeId": 1, "stateId": 11}
        ],
        "output": {"key": "gradient", "role": "target", "stateId": 12}
    })json";

    const auto plan = konjugate::compileExecutionPlan(projectWithImplementation(pythonImpl));
    konjugate::ProviderConfiguration config;
    config.pythonInterpreter = "python3";

    ::setenv("PYTHONPATH", "../sdk/python", 1);

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto& node = plan.nodes.at(1);
    const auto evaluated = konjugate::evaluateContributionTasks(
        node, {290}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &runtime);

    require(!evaluated.empty() && evaluated.front().value == 600,
        "Python provider process end-to-end evaluation failed.");

    runtime.shutdown();
}

std::string cppInlineConductanceProviderSource() {
    return R"cpp(
#include <konjugate/relationshipProvider.hpp>
#include <memory>

namespace {

class ConductanceProvider final : public konjugate::sdk::v1::RelationshipProvider {
public:
    konjugate::sdk::v1::RelationshipDescription describe() const override {
        return {"test.cppConductance", "Conductance",
            {{"delta", "Temperature difference", "K"}},
            {"gradient", "Temperature gradient", "K/s"}};
    }

    void evaluate(const konjugate::sdk::v1::EvaluationContext& context,
                  konjugate::sdk::v1::OutputCollector& output) override {
        output.addGradient(context.inputs.at("delta") * 3);
    }
};

}

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider() {
    return std::make_unique<ConductanceProvider>();
}
)cpp";
}

void providerRuntimeCompilesAndExecutesAnInlineCppProviderEndToEnd() {
    std::string cppImpl = R"json({
        "kind": "cpp",
        "providerApiVersion": 1,
        "source": "placeholder-replaced-below",
        "bindings": [
            {"key": "delta", "kind": "state", "nodeId": 1, "stateId": 11}
        ],
        "output": {"key": "gradient", "role": "target", "stateId": 12}
    })json";

    auto project = projectWithImplementation(cppImpl);
    // Set directly on the ptree rather than embedding in the JSON literal above, so the
    // inline C++ source's quotes and braces never have to survive JSON-string escaping.
    project.get_child("edges").begin()->second.put("implementation.source", cppInlineConductanceProviderSource());

    const auto plan = konjugate::compileExecutionPlan(project);
    konjugate::ProviderConfiguration config;
    config.cppSdkPath = "..";

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto& node = plan.nodes.at(1);
    const auto evaluated = konjugate::evaluateContributionTasks(
        node, {290}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &runtime);

    require(!evaluated.empty() && evaluated.front().value == 900,
        "Compiled C++ provider process end-to-end evaluation failed.");

    runtime.shutdown();
}

boost::property_tree::ptree twoIndependentProviderEdgesProject() {
    std::istringstream json(R"json({
        "format": "konjugate",
        "version": 1,
        "nodes": [
            {"id": 1, "name": "Source", "states": [{"id": 11, "name": "Temperature", "symbol": "temperature", "initialValue": 300}], "sourceTerms": []},
            {"id": 2, "name": "TargetX", "states": [{"id": 21, "name": "Temperature", "symbol": "temperature", "initialValue": 0}], "sourceTerms": []},
            {"id": 3, "name": "TargetY", "states": [{"id": 31, "name": "Temperature", "symbol": "temperature", "initialValue": 0}], "sourceTerms": []}
        ],
        "edges": [
            {
                "id": 101, "name": "SourceToTargetX", "source": {"nodeId": 1}, "target": {"nodeId": 2}, "parameters": [],
                "implementation": {
                    "kind": "python", "providerApiVersion": 1,
                    "source": "../tests/pythonRelationshipProviderTest.py",
                    "bindings": [{"key": "delta", "kind": "state", "nodeId": 1, "stateId": 11}],
                    "output": {"key": "gradient", "role": "target", "stateId": 21}
                }
            },
            {
                "id": 102, "name": "SourceToTargetY", "source": {"nodeId": 1}, "target": {"nodeId": 3}, "parameters": [],
                "implementation": {
                    "kind": "python", "providerApiVersion": 1,
                    "source": "../tests/pythonSecondProviderTest.py",
                    "bindings": [{"key": "delta", "kind": "state", "nodeId": 1, "stateId": 11}],
                    "output": {"key": "gradient", "role": "target", "stateId": 31}
                }
            }
        ]
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    return project;
}

void providerRuntimeResolvesTasksByStableSourceIdAcrossCollidingLocalSequences() {
    const auto plan = konjugate::compileExecutionPlan(twoIndependentProviderEdgesProject());
    const auto& targetX = plan.nodes.at(1);
    const auto& targetY = plan.nodes.at(2);
    require(targetX.contributions.front().sequence == targetY.contributions.front().sequence,
        "Test setup expected both provider tasks to share a colliding per-node local sequence number.");
    require(targetX.contributions.front().sourceId != targetY.contributions.front().sourceId,
        "Test setup expected the two provider tasks to have distinct stable source IDs.");

    konjugate::ProviderConfiguration config;
    config.pythonInterpreter = "python3";
    ::setenv("PYTHONPATH", "../sdk/python", 1);

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto evaluatedX = konjugate::evaluateContributionTasks(
        targetX, {0}, plan.initialStates, konjugate::resolveParameterValues(targetX, {}), 1.5, 0.01, &runtime);
    const auto evaluatedY = konjugate::evaluateContributionTasks(
        targetY, {0}, plan.initialStates, konjugate::resolveParameterValues(targetY, {}), 1.5, 0.01, &runtime);

    runtime.shutdown();

    require(!evaluatedX.empty() && evaluatedX.front().value == 600,
        "A provider task keyed by a colliding local sequence number resolved to the wrong worker process.");
    require(!evaluatedY.empty() && evaluatedY.front().value == 1500,
        "A provider task keyed by a colliding local sequence number resolved to the wrong worker process.");
}

void providerRuntimeSerializesConcurrentEvaluationsOnASharedWorker() {
    // Two edges below deliberately reuse the same inline source, so they share
    // one worker process with two instances. Both are evaluated from multiple
    // threads at once to prove the pipe round-trip in ProviderProcess cannot
    // interleave and corrupt the framed protocol.
    std::string sharedSourceImpl = R"json({
        "kind": "python",
        "providerApiVersion": 1,
        "source": "../tests/pythonRelationshipProviderTest.py",
        "bindings": [
            {"key": "delta", "kind": "state", "nodeId": 1, "stateId": 11}
        ],
        "output": {"key": "gradient", "role": "target", "stateId": 12}
    })json";
    const auto plan = konjugate::compileExecutionPlan(projectWithImplementation(sharedSourceImpl));
    const auto& node = plan.nodes.at(1);

    konjugate::ProviderConfiguration config;
    config.pythonInterpreter = "python3";
    ::setenv("PYTHONPATH", "../sdk/python", 1);

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    std::atomic<bool> failed{false};
    std::vector<std::thread> threads;
    constexpr int threadCount = 8;
    constexpr int iterationsPerThread = 50;
    for (int t = 0; t < threadCount; ++t) {
        threads.emplace_back([&] {
            for (int i = 0; i < iterationsPerThread; ++i) {
                try {
                    const auto evaluated = konjugate::evaluateContributionTasks(
                        node, {290}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &runtime);
                    if (evaluated.empty() || evaluated.front().value != 600) failed = true;
                } catch (...) {
                    failed = true;
                }
            }
        });
    }
    for (auto& thread : threads) thread.join();
    runtime.shutdown();

    require(!failed.load(),
        "Concurrent evaluation against a shared provider worker produced a wrong result, hung, or corrupted the protocol.");
}

}

int main() {
    sdkProvidesStableKeyedReadOnlyInputsAndAdditiveOutput();
    validatorAcceptsACompleteProgrammableRelationship();
    validatorRejectsMissingProviderBindingsAndOutputState();
    executionDelegatesResolvedScalarsWithoutChangingCadence();
    providerRuntimeExecutesPythonWorkerEndToEnd();
    providerRuntimeCompilesAndExecutesAnInlineCppProviderEndToEnd();
    providerRuntimeResolvesTasksByStableSourceIdAcrossCollidingLocalSequences();
    providerRuntimeSerializesConcurrentEvaluationsOnASharedWorker();
}
