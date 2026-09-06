/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "konjugate/relationshipProvider.hpp"
#include "executionPlan.hpp"
#include "modelValidator.hpp"
#include "providerRuntime.hpp"
#include <algorithm>
#include <atomic>
#include <cstring>
#include <cstdlib>
#include <boost/property_tree/json_parser.hpp>
#include <span>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
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
    std::vector<double> evaluateBatch(const std::vector<const konjugate::ContributionTask*>& tasks,
                                      const std::vector<std::span<const double>>& inputs,
                                      double simulationTime,
                                      double stepSize) override {
        require(tasks.size() == 1, "This test expects exactly one provider task in the batch.");
        const auto& task = *tasks.front();
        const auto& taskInputs = inputs.front();
        require(task.providerOutputKey == "targetTemperatureGradient", "The evaluator received the wrong provider task.");
        require(std::vector<double>(taskInputs.begin(), taskInputs.end()) == std::vector<double>({300, 2}),
            "The evaluator received incorrectly resolved provider inputs.");
        require(simulationTime == 4.5 && stepSize == 0.01, "The evaluator received incorrect substep timing.");
        called = true;
        return {taskInputs[1] * taskInputs[0]};
    }

    bool called = false;
};

// Counts how many evaluateBatch calls a node's provider tasks produce, and how large each
// batch was, without spawning real worker processes — used to test evaluateContributionTasks'
// grouping logic in isolation from ProviderRuntime/the pipe transport.
class CountingEvaluator final : public konjugate::ProviderEvaluator {
public:
    std::vector<double> evaluateBatch(const std::vector<const konjugate::ContributionTask*>& tasks,
                                      const std::vector<std::span<const double>>& inputs,
                                      double simulationTime,
                                      double stepSize) override {
        static_cast<void>(simulationTime);
        static_cast<void>(stepSize);
        ++callCount;
        batchSizes.push_back(tasks.size());
        std::vector<double> results;
        results.reserve(tasks.size());
        for (const auto& taskInputs : inputs) {
            double sum = 0;
            for (const auto value : taskInputs) sum += value;
            results.push_back(sum);
        }
        return results;
    }

    int callCount = 0;
    std::vector<std::size_t> batchSizes;
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

class CheckpointableAccumulatorNode final : public konjugate::sdk::v1::NodeProvider {
public:
    konjugate::sdk::v1::NodeProviderDescription describe() const override {
        return {"test.accumulatorNode", "Accumulator node", {{"input", "Input", ""}}, {{"output", "Output", ""}}};
    }

    void evaluate(const konjugate::sdk::v1::EvaluationContext& context,
                  konjugate::sdk::v1::NodeOutputCollector& output) override {
        total_ += context.inputs.at("input") * context.stepSize;
        output.addGradient("output", total_);
    }

    std::vector<std::byte> checkpoint() const override {
        std::vector<std::byte> payload(sizeof(total_));
        std::memcpy(payload.data(), &total_, sizeof(total_));
        return payload;
    }

    void restore(std::span<const std::byte> payload) override {
        require(payload.size() == sizeof(total_), "The node checkpoint payload has the wrong size.");
        std::memcpy(&total_, payload.data(), sizeof(total_));
    }

    double total_ = 0;
};

void sdkProvidesCheckpointableNodeProviderContract() {
    CheckpointableAccumulatorNode provider;
    const double values[] = {4};
    const std::string_view keys[] = {"input"};
    konjugate::sdk::v1::NodeOutputCollector output;
    provider.evaluate({0, 0.5, {values, keys}}, output);
    require(output.gradients().size() == 1 && output.gradients().front().second == 2,
        "The node provider did not collect its declared output gradient.");
    const auto checkpoint = provider.checkpoint();
    provider.total_ = 99;
    provider.restore(checkpoint);
    require(provider.total_ == 2, "The node provider checkpoint did not restore state.");
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

void validatorRejectsAMissingProviderOutputState() {
    auto invalid = validImplementation();
    invalid.replace(invalid.find("\"stateId\": 12"), std::string("\"stateId\": 12").size(), "\"stateId\": 999");
    const auto result = konjugate::validateModel(projectWithImplementation(invalid));
    require(!result.valid, "An invalid programmable relationship was accepted.");
    require(hasIssue(result, "providerOutputMissing"), "A missing provider output state was not diagnosed.");
}

void validatorWarnsWithoutBlockingAnUntouchedProgrammableRelationshipTemplate() {
    // A relationship's provider need not read any bound value either, so an edge with zero
    // bindings and the untouched generated template should warn without blocking the model.
    std::string untouchedImplementation = R"json({
        "kind": "cpp",
        "providerApiVersion": 1,
        "source": "// TODO: read the declared inputs above and add the computed contribution.",
        "bindings": [],
        "output": {"key": "targetTemperatureGradient", "role": "target", "stateId": 12}
    })json";
    const auto untouched = konjugate::validateModel(projectWithImplementation(untouchedImplementation));
    require(untouched.valid, "An untouched programmable relationship template should warn, not block the model.");
    const auto issue = std::find_if(untouched.issues.begin(), untouched.issues.end(),
        [](const auto& item) { return item.code == "providerImplementationIncomplete"; });
    require(issue != untouched.issues.end() && issue->severity == "warning",
        "An untouched relationship template with no bindings should produce a warning, not an error.");

    std::string editedImplementation = R"json({
        "kind": "cpp",
        "providerApiVersion": 1,
        "source": "output.addGradient(9.81);",
        "bindings": [],
        "output": {"key": "targetTemperatureGradient", "role": "target", "stateId": 12}
    })json";
    const auto edited = konjugate::validateModel(projectWithImplementation(editedImplementation));
    require(!hasIssue(edited, "providerImplementationIncomplete"),
        "Writing real source should clear the incomplete-template warning even with zero bindings.");
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

void providerRuntimeCompilesAndExecutesAnInlineCppProviderOverSharedMemory() {
    // Same fixture as providerRuntimeCompilesAndExecutesAnInlineCppProviderEndToEnd, but
    // requesting the shared-memory transport: on POSIX this exercises SharedMemoryProviderBackend
    // end to end; on Windows (or if shared memory setup fails for any other reason)
    // ProviderRuntime transparently falls back to the pipe backend, so this still passes there.
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
    project.get_child("edges").begin()->second.put("implementation.source", cppInlineConductanceProviderSource());

    const auto plan = konjugate::compileExecutionPlan(project);
    konjugate::ProviderConfiguration config;
    config.cppSdkPath = "..";
    config.executionMode = konjugate::ProviderExecutionMode::sharedMemoryWorker;

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto& node = plan.nodes.at(1);
    const auto evaluated = konjugate::evaluateContributionTasks(
        node, {290}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &runtime);

    require(!evaluated.empty() && evaluated.front().value == 900,
        "Compiled C++ provider process end-to-end evaluation over shared memory failed.");

    runtime.shutdown();
}

boost::property_tree::ptree sharedCppProviderSourceConvergingOnOneNodeProject() {
    std::istringstream json(R"json({
        "format": "konjugate",
        "version": 1,
        "nodes": [
            {"id": 1, "name": "SourceA", "states": [{"id": 11, "name": "Temperature", "symbol": "temperature", "initialValue": 300}], "sourceTerms": []},
            {"id": 2, "name": "SourceB", "states": [{"id": 21, "name": "Temperature", "symbol": "temperature", "initialValue": 100}], "sourceTerms": []},
            {"id": 3, "name": "Target", "states": [{"id": 31, "name": "Temperature", "symbol": "temperature", "initialValue": 0}], "sourceTerms": []}
        ],
        "edges": [
            {
                "id": 101, "name": "AtoTarget", "source": {"nodeId": 1}, "target": {"nodeId": 3}, "parameters": [],
                "implementation": {
                    "kind": "cpp", "providerApiVersion": 1,
                    "source": "placeholder-replaced-below",
                    "bindings": [{"key": "delta", "kind": "state", "nodeId": 1, "stateId": 11}],
                    "output": {"key": "gradient", "role": "target", "stateId": 31}
                }
            },
            {
                "id": 102, "name": "BtoTarget", "source": {"nodeId": 2}, "target": {"nodeId": 3}, "parameters": [],
                "implementation": {
                    "kind": "cpp", "providerApiVersion": 1,
                    "source": "placeholder-replaced-below",
                    "bindings": [{"key": "delta", "kind": "state", "nodeId": 2, "stateId": 21}],
                    "output": {"key": "gradient", "role": "target", "stateId": 31}
                }
            }
        ]
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    const auto source = cppInlineConductanceProviderSource();
    for (auto& edge : project.get_child("edges")) edge.second.put("implementation.source", source);
    return project;
}

void providerRuntimeBatchesMultipleCppInstancesOverSharedMemoryInOneRoundTrip() {
    const auto plan = konjugate::compileExecutionPlan(sharedCppProviderSourceConvergingOnOneNodeProject());
    const auto& node = plan.nodes.at(2);
    require(node.contributions.size() == 2, "Test setup expected two provider contributions on the target node.");

    konjugate::ProviderConfiguration config;
    config.cppSdkPath = "..";
    config.executionMode = konjugate::ProviderExecutionMode::sharedMemoryWorker;

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto evaluated = konjugate::evaluateContributionTasks(
        node, {0}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &runtime);

    runtime.shutdown();

    require(evaluated.size() == 2, "Expected one evaluated contribution per shared-worker instance.");
    // cppInlineConductanceProviderSource() computes delta * 3.
    bool sawSourceA = false;
    bool sawSourceB = false;
    for (const auto& contribution : evaluated) {
        if (contribution.value == 900) sawSourceA = true;
        if (contribution.value == 300) sawSourceB = true;
    }
    require(sawSourceA && sawSourceB,
        "A single batched shared-memory round trip did not return correct, distinct values per instance.");
}

void providerRuntimeSerializesConcurrentEvaluationsOverSharedMemory() {
    // Same intent as providerRuntimeSerializesConcurrentEvaluationsOnASharedWorker, but against
    // SharedMemoryProviderBackend: many threads hammering one shared-memory channel must not
    // interleave requests/responses or corrupt the shared struct.
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
    project.get_child("edges").begin()->second.put("implementation.source", cppInlineConductanceProviderSource());

    const auto plan = konjugate::compileExecutionPlan(project);
    const auto& node = plan.nodes.at(1);

    konjugate::ProviderConfiguration config;
    config.cppSdkPath = "..";
    config.executionMode = konjugate::ProviderExecutionMode::sharedMemoryWorker;

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
                    if (evaluated.empty() || evaluated.front().value != 900) failed = true;
                } catch (...) {
                    failed = true;
                }
            }
        });
    }
    for (auto& thread : threads) thread.join();
    runtime.shutdown();

    require(!failed.load(),
        "Concurrent evaluation against a shared-memory provider worker produced a wrong result, hung, or corrupted the channel.");
}

void providerRuntimeCompilesAndExecutesAnInlineCppProviderInProcess() {
    // Same fixture as the pipe/shared-memory versions, requesting the in-process transport
    // instead: this is the one mode with no isolation and no fallback-on-platform-support-gap
    // (it's attempted on every platform), so a clean pass here is a real dlopen/LoadLibrary +
    // C-ABI round trip, not a fallback in disguise.
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
    project.get_child("edges").begin()->second.put("implementation.source", cppInlineConductanceProviderSource());

    const auto plan = konjugate::compileExecutionPlan(project);
    konjugate::ProviderConfiguration config;
    config.cppSdkPath = "..";
    config.executionMode = konjugate::ProviderExecutionMode::inProcess;

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto& node = plan.nodes.at(1);
    const auto evaluated = konjugate::evaluateContributionTasks(
        node, {290}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &runtime);

    require(!evaluated.empty() && evaluated.front().value == 900,
        "In-process C++ provider end-to-end evaluation failed.");

    runtime.shutdown();
}

void providerRuntimeBatchesMultipleCppInstancesInProcessInOneRoundTrip() {
    const auto plan = konjugate::compileExecutionPlan(sharedCppProviderSourceConvergingOnOneNodeProject());
    const auto& node = plan.nodes.at(2);
    require(node.contributions.size() == 2, "Test setup expected two provider contributions on the target node.");

    konjugate::ProviderConfiguration config;
    config.cppSdkPath = "..";
    config.executionMode = konjugate::ProviderExecutionMode::inProcess;

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto evaluated = konjugate::evaluateContributionTasks(
        node, {0}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &runtime);

    runtime.shutdown();

    require(evaluated.size() == 2, "Expected one evaluated contribution per in-process shared-library instance.");
    // cppInlineConductanceProviderSource() computes delta * 3.
    bool sawSourceA = false;
    bool sawSourceB = false;
    for (const auto& contribution : evaluated) {
        if (contribution.value == 900) sawSourceA = true;
        if (contribution.value == 300) sawSourceB = true;
    }
    require(sawSourceA && sawSourceB,
        "A single batched in-process call did not return correct, distinct values per instance.");
}

void providerRuntimeSerializesConcurrentEvaluationsInProcess() {
    // Same intent as the pipe/shared-memory concurrency tests, but against
    // InProcessProviderBackend: there is no IPC here to serialize by construction, so this is
    // the test that actually proves the engine-side mutex does its job.
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
    project.get_child("edges").begin()->second.put("implementation.source", cppInlineConductanceProviderSource());

    const auto plan = konjugate::compileExecutionPlan(project);
    const auto& node = plan.nodes.at(1);

    konjugate::ProviderConfiguration config;
    config.cppSdkPath = "..";
    config.executionMode = konjugate::ProviderExecutionMode::inProcess;

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
                    if (evaluated.empty() || evaluated.front().value != 900) failed = true;
                } catch (...) {
                    failed = true;
                }
            }
        });
    }
    for (auto& thread : threads) thread.join();
    runtime.shutdown();

    require(!failed.load(),
        "Concurrent evaluation against an in-process provider produced a wrong result, hung, or crashed.");
}

std::string cppInlineThrowingProviderSource() {
    return R"cpp(
#include <konjugate/relationshipProvider.hpp>
#include <memory>
#include <stdexcept>

namespace {

class ThrowingProvider final : public konjugate::sdk::v1::RelationshipProvider {
public:
    konjugate::sdk::v1::RelationshipDescription describe() const override {
        return {"test.throwing", "Throwing",
            {{"delta", "Temperature difference", "K"}},
            {"gradient", "Temperature gradient", "K/s"}};
    }

    void evaluate(const konjugate::sdk::v1::EvaluationContext&,
                  konjugate::sdk::v1::OutputCollector&) override {
        throw std::runtime_error("intentional test failure");
    }
};

}

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider() {
    return std::make_unique<ThrowingProvider>();
}
)cpp";
}

void providerRuntimeInProcessSurfacesAProviderExceptionAcrossTheAbiBoundary() {
    // providerInProcessAbi.hpp forbids C++ exceptions crossing the dlopen boundary; the shim
    // must catch the provider's own throw and report it through lastError() instead. This
    // verifies that round trip actually reconstructs a normal C++ exception on the engine side.
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
    project.get_child("edges").begin()->second.put("implementation.source", cppInlineThrowingProviderSource());

    const auto plan = konjugate::compileExecutionPlan(project);
    konjugate::ProviderConfiguration config;
    config.cppSdkPath = "..";
    config.executionMode = konjugate::ProviderExecutionMode::inProcess;

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto& node = plan.nodes.at(1);
    bool threw = false;
    std::string message;
    try {
        konjugate::evaluateContributionTasks(
            node, {290}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &runtime);
    } catch (const std::exception& error) {
        threw = true;
        message = error.what();
    }

    runtime.shutdown();

    require(threw, "An in-process provider exception should surface as a C++ exception from evaluateBatch.");
    require(message.find("intentional test failure") != std::string::npos,
        "The in-process provider's exception message should propagate through lastError().");
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

boost::property_tree::ptree sharedProviderSourceConvergingOnOneNodeProject() {
    std::istringstream json(R"json({
        "format": "konjugate",
        "version": 1,
        "nodes": [
            {"id": 1, "name": "SourceA", "states": [{"id": 11, "name": "Temperature", "symbol": "temperature", "initialValue": 300}], "sourceTerms": []},
            {"id": 2, "name": "SourceB", "states": [{"id": 21, "name": "Temperature", "symbol": "temperature", "initialValue": 100}], "sourceTerms": []},
            {"id": 3, "name": "Target", "states": [{"id": 31, "name": "Temperature", "symbol": "temperature", "initialValue": 0}], "sourceTerms": []}
        ],
        "edges": [
            {
                "id": 101, "name": "AtoTarget", "source": {"nodeId": 1}, "target": {"nodeId": 3}, "parameters": [],
                "implementation": {
                    "kind": "python", "providerApiVersion": 1,
                    "source": "../tests/pythonRelationshipProviderTest.py",
                    "bindings": [{"key": "delta", "kind": "state", "nodeId": 1, "stateId": 11}],
                    "output": {"key": "gradient", "role": "target", "stateId": 31}
                }
            },
            {
                "id": 102, "name": "BtoTarget", "source": {"nodeId": 2}, "target": {"nodeId": 3}, "parameters": [],
                "implementation": {
                    "kind": "python", "providerApiVersion": 1,
                    "source": "../tests/pythonRelationshipProviderTest.py",
                    "bindings": [{"key": "delta", "kind": "state", "nodeId": 2, "stateId": 21}],
                    "output": {"key": "gradient", "role": "target", "stateId": 31}
                }
            }
        ]
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    return project;
}

void evaluateContributionTasksBatchesTasksSharingAProviderSource() {
    // Both edges below use the identical inline provider source, so they resolve to the same
    // providerProcessKey() and should go out in a single evaluateBatch call rather than two.
    const auto plan = konjugate::compileExecutionPlan(sharedProviderSourceConvergingOnOneNodeProject());
    const auto& node = plan.nodes.at(2);
    require(node.contributions.size() == 2, "Test setup expected two provider contributions on the target node.");
    require(konjugate::providerProcessKey(node.contributions[0]) == konjugate::providerProcessKey(node.contributions[1]),
        "Test setup expected both edges to share the same provider process key.");

    CountingEvaluator evaluator;
    const auto evaluated = konjugate::evaluateContributionTasks(
        node, {0}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &evaluator);

    require(evaluator.callCount == 1,
        "Two contributions sharing a provider source should batch into a single evaluateBatch call.");
    require(evaluator.batchSizes == std::vector<std::size_t>({2}),
        "The single evaluateBatch call should have covered both shared-source instances.");
    require(evaluated.size() == 2, "Both contributions should still produce a result each.");
}

void providerRuntimeBatchesMultipleInstancesSharingAWorkerInOneRoundTrip() {
    const auto plan = konjugate::compileExecutionPlan(sharedProviderSourceConvergingOnOneNodeProject());
    const auto& node = plan.nodes.at(2);
    require(node.contributions.size() == 2, "Test setup expected two provider contributions on the target node.");

    konjugate::ProviderConfiguration config;
    config.pythonInterpreter = "python3";
    ::setenv("PYTHONPATH", "../sdk/python", 1);

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto evaluated = konjugate::evaluateContributionTasks(
        node, {0}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &runtime);

    runtime.shutdown();

    require(evaluated.size() == 2, "Expected one evaluated contribution per shared-worker instance.");
    bool sawSourceA = false;
    bool sawSourceB = false;
    for (const auto& contribution : evaluated) {
        if (contribution.value == 600) sawSourceA = true;
        if (contribution.value == 200) sawSourceB = true;
    }
    require(sawSourceA && sawSourceB,
        "A single batched round trip to a shared worker did not return correct, distinct values per instance.");
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

boost::property_tree::ptree sourceTermWithImplementationProject() {
    std::istringstream json(R"json({
        "format": "konjugate",
        "version": 1,
        "nodes": [{
            "id": 1,
            "name": "Tank",
            "states": [
                {"id": 11, "name": "Level", "symbol": "level", "initialValue": 300},
                {"id": 12, "name": "Rate", "symbol": "rate", "initialValue": 0}
            ],
            "sourceTerms": [{
                "id": 21,
                "state": "rate",
                "expression": "",
                "implementation": {
                    "kind": "python",
                    "providerApiVersion": 1,
                    "source": "../tests/pythonRelationshipProviderTest.py",
                    "bindings": [{"key": "delta", "kind": "state", "stateId": 11}],
                    "output": {"key": "gradient", "stateId": 12}
                }
            }]
        }],
        "edges": []
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    return project;
}

void validatorAndExecutionPlanAcceptAProgrammableSourceTerm() {
    const auto project = sourceTermWithImplementationProject();
    const auto result = konjugate::validateModel(project);
    require(result.valid, "A complete programmable source term was rejected.");
    require(!hasIssue(result, "sourceExpressionEmpty"), "A programmable source term was incorrectly validated as an equation.");

    const auto plan = konjugate::compileExecutionPlan(project);
    const auto& task = plan.nodes.at(0).contributions.front();
    require(task.implementation == konjugate::ContributionImplementation::pythonProvider,
        "The execution plan did not preserve the programmable source-term implementation kind.");
    require(task.bindings.at(0).symbol == "delta" && task.providerOutputKey == "gradient",
        "The execution plan did not preserve stable source-term provider port keys.");
}

void validatorRejectsAnIncompleteProgrammableSourceTerm() {
    auto invalid = sourceTermWithImplementationProject();
    invalid.get_child("nodes").begin()->second.get_child("sourceTerms").begin()->second
        .put("implementation.output.stateId", 999);
    const auto result = konjugate::validateModel(invalid);
    require(!result.valid, "An invalid programmable source term was accepted.");
    require(hasIssue(result, "providerOutputMissing"), "A missing source-term provider output state was not diagnosed.");
}

void validatorAndExecutionPlanAcceptAProgrammableSourceTermWithNoBindings() {
    // Unlike an edge, a source term has no other endpoint to read from, so it may
    // legitimately declare zero input bindings (e.g. a constant contribution). Since this
    // fixture's source is real (not the untouched template), no warning should fire either.
    auto project = sourceTermWithImplementationProject();
    auto& implementation = project.get_child("nodes").begin()->second.get_child("sourceTerms").begin()->second
        .get_child("implementation");
    implementation.get_child("bindings").clear();

    const auto result = konjugate::validateModel(project);
    require(result.valid, "A programmable source term with zero bindings was incorrectly rejected.");
    require(!hasIssue(result, "providerBindingsEmpty"), "Zero declared bindings should be legal for a source term.");
    require(!hasIssue(result, "sourceTermImplementationIncomplete"),
        "A source term with real custom source should not be flagged as incomplete.");

    const auto plan = konjugate::compileExecutionPlan(project);
    const auto& task = plan.nodes.at(0).contributions.front();
    require(task.bindings.empty(), "The execution plan should preserve zero bindings for a source term.");
}

void validatorWarnsWithoutBlockingAnUntouchedProgrammableSourceTermTemplate() {
    // No bindings and the generated template's own TODO marker still present: this looks
    // like an author has not started implementing the term yet, so it should warn without
    // blocking the model (unlike edges, which require at least one binding unconditionally).
    auto project = sourceTermWithImplementationProject();
    auto& implementation = project.get_child("nodes").begin()->second.get_child("sourceTerms").begin()->second
        .get_child("implementation");
    implementation.get_child("bindings").clear();
    implementation.put("source", "// TODO: read the declared inputs above and add the computed contribution.");

    const auto untouched = konjugate::validateModel(project);
    require(untouched.valid, "An untouched programmable source term template should warn, not block the model.");
    require(hasIssue(untouched, "sourceTermImplementationIncomplete"),
        "An untouched source-term template with no bindings was not flagged.");
    const auto issue = std::find_if(untouched.issues.begin(), untouched.issues.end(),
        [](const auto& item) { return item.code == "sourceTermImplementationIncomplete"; });
    require(issue != untouched.issues.end() && issue->severity == "warning",
        "The incomplete-template diagnostic should be a warning, not an error.");

    implementation.put("source", "output.addGradient(9.81);");
    const auto edited = konjugate::validateModel(project);
    require(!hasIssue(edited, "sourceTermImplementationIncomplete"),
        "Writing real source should clear the incomplete-template warning even with zero bindings.");
}

boost::property_tree::ptree oneEquationSourceTermProject(bool setsValue) {
    std::istringstream json(R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "Node",
            "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 0}],
            "sourceTerms": [{
                "id": 21, "state": "x", "expression": "5",
                )json" + std::string(setsValue ? "\"setsValue\": true," : "") + R"json(
                "expressionModel": {"latex": "5", "bindings": [], "output": {"stateId": 11}, "mathJson": 5}
            }]
        }],
        "edges": []
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    return project;
}

boost::property_tree::ptree twoEquationSourceTermsSharingOneStateProject(bool firstSetsValue) {
    std::istringstream json(R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "Node",
            "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 0}],
            "sourceTerms": [
                {
                    "id": 21, "state": "x", "expression": "5",
                    )json" + std::string(firstSetsValue ? "\"setsValue\": true," : "") + R"json(
                    "expressionModel": {"latex": "5", "bindings": [], "output": {"stateId": 11}, "mathJson": 5}
                },
                {
                    "id": 22, "state": "x", "expression": "1",
                    "expressionModel": {"latex": "1", "bindings": [], "output": {"stateId": 11}, "mathJson": 1}
                }
            ]
        }],
        "edges": []
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    return project;
}

boost::property_tree::ptree setsValueSourceTermWithIncomingEdgeProject() {
    std::istringstream json(R"json({
        "format": "konjugate", "version": 1,
        "nodes": [
            {
                "id": 1, "name": "A",
                "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 0}],
                "sourceTerms": [{
                    "id": 21, "state": "x", "expression": "5", "setsValue": true,
                    "expressionModel": {"latex": "5", "bindings": [], "output": {"stateId": 11}, "mathJson": 5}
                }]
            },
            {
                "id": 2, "name": "B",
                "states": [{"id": 12, "name": "Y", "symbol": "y", "initialValue": 0}],
                "sourceTerms": []
            }
        ],
        "edges": [{
            "id": 31, "name": "B to A",
            "source": {"nodeId": 2, "stateId": 12}, "target": {"nodeId": 1, "stateId": 11},
            "directionality": "directed",
            "equationModel": {
                "latex": "y", "bindings": [{"kind": "state", "role": "source", "nodeId": 2, "stateId": 12, "symbol": "y"}],
                "output": {"role": "target", "stateId": 11}, "mathJson": "y"
            },
            "parameters": []
        }]
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    return project;
}

void validatorAcceptsASetsValueEquationSourceTermAsSoleContributor() {
    const auto result = konjugate::validateModel(oneEquationSourceTermProject(true));
    require(result.valid, "A setsValue equation source term as the sole contributor to its state was rejected.");
    require(!hasIssue(result, "setsValueNotSoleContributor"), "A sole setsValue contributor was incorrectly flagged.");

    const auto plan = konjugate::compileExecutionPlan(oneEquationSourceTermProject(true));
    require(plan.nodes.at(0).contributions.empty() && plan.nodes.at(0).algebraicTasks.size() == 1,
        "A setsValue source term should compile into algebraicTasks, not an ordinary derivative contribution.");
}

void validatorAcceptsASetsValueProgrammableSourceTermAsSoleContributor() {
    auto project = sourceTermWithImplementationProject();
    project.get_child("nodes").begin()->second.get_child("sourceTerms").begin()->second.put("setsValue", true);
    const auto result = konjugate::validateModel(project);
    require(result.valid, "A setsValue programmable source term as the sole contributor to its state was rejected.");

    const auto plan = konjugate::compileExecutionPlan(project);
    require(plan.nodes.at(0).contributions.empty() && plan.nodes.at(0).algebraicTasks.size() == 1,
        "A setsValue programmable source term should compile into algebraicTasks, not an ordinary derivative contribution.");
}

void validatorRejectsASetsValueSourceTermSharingItsStateWithAnotherSourceTerm() {
    const auto sharedButNeitherSetsValue = konjugate::validateModel(twoEquationSourceTermsSharingOneStateProject(false));
    require(sharedButNeitherSetsValue.valid, "Two ordinary source terms sharing a state should validate (they simply sum).");

    const auto sharedWithSetsValue = konjugate::validateModel(twoEquationSourceTermsSharingOneStateProject(true));
    require(!sharedWithSetsValue.valid, "A setsValue source term sharing its state with another source term was accepted.");
    require(hasIssue(sharedWithSetsValue, "setsValueNotSoleContributor"),
        "The shared-state setsValue conflict was not diagnosed with the expected issue code.");
}

void validatorRejectsASetsValueSourceTermSharingItsStateWithAnIncomingEdge() {
    const auto result = konjugate::validateModel(setsValueSourceTermWithIncomingEdgeProject());
    require(!result.valid, "A setsValue source term with an incoming edge to the same state was accepted.");
    require(hasIssue(result, "setsValueNotSoleContributor"),
        "A setsValue/edge conflict on the same state was not diagnosed with the expected issue code.");
}

boost::property_tree::ptree setsValueSelfReferenceProject() {
    std::istringstream json(R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "Node",
            "states": [{"id": 11, "name": "X", "symbol": "x", "initialValue": 0}],
            "sourceTerms": [{
                "id": 21, "state": "x", "expression": "x", "setsValue": true,
                "expressionModel": {
                    "latex": "x", "bindings": [{"kind": "state", "stateId": 11, "symbol": "x"}],
                    "output": {"stateId": 11}, "mathJson": "x"
                }
            }]
        }],
        "edges": []
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    return project;
}

boost::property_tree::ptree setsValueAlgebraicLoopProject() {
    std::istringstream json(R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "Node",
            "states": [
                {"id": 11, "name": "X", "symbol": "x", "initialValue": 0},
                {"id": 12, "name": "Y", "symbol": "y", "initialValue": 0}
            ],
            "sourceTerms": [
                {
                    "id": 21, "state": "x", "expression": "y", "setsValue": true,
                    "expressionModel": {"latex": "y", "bindings": [{"kind": "state", "stateId": 12, "symbol": "y"}], "output": {"stateId": 11}, "mathJson": "y"}
                },
                {
                    "id": 22, "state": "y", "expression": "x", "setsValue": true,
                    "expressionModel": {"latex": "x", "bindings": [{"kind": "state", "stateId": 11, "symbol": "x"}], "output": {"stateId": 12}, "mathJson": "x"}
                }
            ]
        }],
        "edges": []
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    return project;
}

boost::property_tree::ptree setsValueDependencyChainProject() {
    // y = 2 (algebraic), z = y + 1 (algebraic, depends on y) -- proves dependency ordering, not
    // just cycle rejection, both in the validator (implicitly, by validating cleanly) and in
    // compileExecutionPlan's resulting algebraicTasks order.
    std::istringstream json(R"json({
        "format": "konjugate", "version": 1,
        "nodes": [{
            "id": 1, "name": "Node",
            "states": [
                {"id": 11, "name": "Y", "symbol": "y", "initialValue": 0},
                {"id": 12, "name": "Z", "symbol": "z", "initialValue": 0}
            ],
            "sourceTerms": [
                {
                    "id": 22, "state": "z", "expression": "y + 1", "setsValue": true,
                    "expressionModel": {"latex": "y + 1", "bindings": [{"kind": "state", "stateId": 11, "symbol": "y"}], "output": {"stateId": 12}, "mathJson": ["Add", "y", 1]}
                },
                {
                    "id": 21, "state": "y", "expression": "2", "setsValue": true,
                    "expressionModel": {"latex": "2", "bindings": [], "output": {"stateId": 11}, "mathJson": 2}
                }
            ]
        }],
        "edges": []
    })json");
    boost::property_tree::ptree project;
    boost::property_tree::read_json(json, project);
    return project;
}

void validatorRejectsASetsValueSourceTermReferencingItsOwnState() {
    const auto result = konjugate::validateModel(setsValueSelfReferenceProject());
    require(!result.valid, "A setsValue source term referencing its own state was accepted.");
    require(hasIssue(result, "setsValueSelfReference"), "Self-reference was not diagnosed with the expected issue code.");

    bool threw = false;
    try {
        konjugate::compileExecutionPlan(setsValueSelfReferenceProject());
    } catch (const std::exception&) {
        threw = true;
    }
    require(threw, "compileExecutionPlan should also defensively reject self-reference (main.cpp's run path skips validateModel entirely).");
}

void validatorRejectsASetsValueAlgebraicLoop() {
    const auto result = konjugate::validateModel(setsValueAlgebraicLoopProject());
    require(!result.valid, "A dependency cycle between two setsValue source terms was accepted.");
    require(hasIssue(result, "setsValueAlgebraicLoop"), "The algebraic loop was not diagnosed with the expected issue code.");

    bool threw = false;
    try {
        konjugate::compileExecutionPlan(setsValueAlgebraicLoopProject());
    } catch (const std::exception&) {
        threw = true;
    }
    require(threw, "compileExecutionPlan should also defensively reject an algebraic loop (main.cpp's run path skips validateModel entirely).");
}

void compileExecutionPlanOrdersDependentAlgebraicTasksCorrectly() {
    const auto result = konjugate::validateModel(setsValueDependencyChainProject());
    require(result.valid, "A valid algebraic dependency chain (not a cycle) was incorrectly rejected.");

    const auto plan = konjugate::compileExecutionPlan(setsValueDependencyChainProject());
    const auto& tasks = plan.nodes.at(0).algebraicTasks;
    require(tasks.size() == 2, "Both algebraic source terms should compile into algebraicTasks.");
    require(tasks.front().outputStateId == 11 && tasks.back().outputStateId == 12,
        "y's task (no dependencies) should be ordered before z's task (which depends on y), regardless of authored order.");
}

void providerRuntimeExecutesAProgrammableSourceTermEndToEnd() {
    const auto plan = konjugate::compileExecutionPlan(sourceTermWithImplementationProject());
    konjugate::ProviderConfiguration config;
    config.pythonInterpreter = "python3";
    ::setenv("PYTHONPATH", "../sdk/python", 1);

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);

    const auto& node = plan.nodes.at(0);
    const auto evaluated = konjugate::evaluateContributionTasks(
        node, {300, 0}, plan.initialStates, konjugate::resolveParameterValues(node, {}), 1.5, 0.01, &runtime);

    require(!evaluated.empty() && evaluated.front().value == 600,
        "Programmable source-term end-to-end evaluation failed.");

    runtime.shutdown();
}

}

int main() {
    sdkProvidesStableKeyedReadOnlyInputsAndAdditiveOutput();
    sdkProvidesCheckpointableNodeProviderContract();
    validatorAcceptsACompleteProgrammableRelationship();
    validatorRejectsAMissingProviderOutputState();
    validatorWarnsWithoutBlockingAnUntouchedProgrammableRelationshipTemplate();
    executionDelegatesResolvedScalarsWithoutChangingCadence();
    providerRuntimeExecutesPythonWorkerEndToEnd();
    providerRuntimeCompilesAndExecutesAnInlineCppProviderEndToEnd();
    providerRuntimeCompilesAndExecutesAnInlineCppProviderOverSharedMemory();
    providerRuntimeBatchesMultipleCppInstancesOverSharedMemoryInOneRoundTrip();
    providerRuntimeSerializesConcurrentEvaluationsOverSharedMemory();
    providerRuntimeCompilesAndExecutesAnInlineCppProviderInProcess();
    providerRuntimeBatchesMultipleCppInstancesInProcessInOneRoundTrip();
    providerRuntimeSerializesConcurrentEvaluationsInProcess();
    providerRuntimeInProcessSurfacesAProviderExceptionAcrossTheAbiBoundary();
    evaluateContributionTasksBatchesTasksSharingAProviderSource();
    providerRuntimeBatchesMultipleInstancesSharingAWorkerInOneRoundTrip();
    providerRuntimeResolvesTasksByStableSourceIdAcrossCollidingLocalSequences();
    providerRuntimeSerializesConcurrentEvaluationsOnASharedWorker();
    validatorAndExecutionPlanAcceptAProgrammableSourceTerm();
    validatorRejectsAnIncompleteProgrammableSourceTerm();
    validatorAndExecutionPlanAcceptAProgrammableSourceTermWithNoBindings();
    validatorWarnsWithoutBlockingAnUntouchedProgrammableSourceTermTemplate();
    validatorAcceptsASetsValueEquationSourceTermAsSoleContributor();
    validatorAcceptsASetsValueProgrammableSourceTermAsSoleContributor();
    validatorRejectsASetsValueSourceTermSharingItsStateWithAnotherSourceTerm();
    validatorRejectsASetsValueSourceTermSharingItsStateWithAnIncomingEdge();
    validatorRejectsASetsValueSourceTermReferencingItsOwnState();
    validatorRejectsASetsValueAlgebraicLoop();
    compileExecutionPlanOrdersDependentAlgebraicTasksCorrectly();
    providerRuntimeExecutesAProgrammableSourceTermEndToEnd();
}
