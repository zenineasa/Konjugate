/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Manual benchmark, not wired into ctest: measures how much of the provider IPC round-trip
// cost comes from "one evaluateBatch call per contribution" versus the pipe/process transport
// itself. Both paths below call the identical ProviderRuntime::evaluateBatch over the same
// live worker process; only the number of round trips differs, so the gap between them is
// exactly the round-trip count's contribution to total cost, isolated from everything else.
//
// Run manually from engine/tests after building the providerBatchingBenchmark target:
//   ../../out/engine/providerBatchingBenchmark

#include "executionPlan.hpp"
#include "providerRuntime.hpp"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

std::string inlineConductanceProviderSource() {
    return R"cpp(
#include <konjugate/relationshipProvider.hpp>
#include <memory>

namespace {

class ConductanceProvider final : public konjugate::sdk::v1::RelationshipProvider {
public:
    konjugate::sdk::v1::RelationshipDescription describe() const override {
        return {"benchmark.conductance", "Conductance",
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

// All instances deliberately share one inline source, so ProviderRuntime resolves them to a
// single worker process (mirrors the common case: many edges reusing one relationship type).
konjugate::NodeExecutionPlan buildSharedProviderNode(std::size_t instanceCount, const std::string& source) {
    konjugate::NodeExecutionPlan node;
    node.stateIndexes = {0};
    node.contributions.reserve(instanceCount);
    for (std::size_t index = 0; index < instanceCount; ++index) {
        konjugate::ContributionTask task;
        task.sequence = index;
        task.sourceId = 1000 + index;
        task.outputStateIndex = 0;
        task.implementation = konjugate::ContributionImplementation::cppProvider;
        task.providerSource = source;
        task.providerOutputKey = "gradient";

        konjugate::CompiledBinding binding;
        binding.symbol = "delta";
        binding.source = konjugate::BindingSource::localState;
        binding.valueIndex = 0;
        task.bindings = {binding};

        node.contributions.push_back(std::move(task));
    }
    return node;
}

// One evaluateBatch call per contribution: what the call site did before real batching.
std::chrono::nanoseconds timeUnbatched(konjugate::ProviderRuntime& runtime,
                                       const konjugate::NodeExecutionPlan& node,
                                       int repetitions) {
    const std::vector<double> inputs = {300.0};
    const auto started = std::chrono::steady_clock::now();
    for (int repetition = 0; repetition < repetitions; ++repetition) {
        for (const auto& task : node.contributions) {
            const std::vector<const konjugate::ContributionTask*> tasks = {&task};
            const std::vector<std::span<const double>> batchInputs = {inputs};
            if (runtime.evaluateBatch(tasks, batchInputs, 1.5, 0.01).size() != 1) {
                throw std::runtime_error("Unexpected unbatched result size.");
            }
        }
    }
    return std::chrono::steady_clock::now() - started;
}

// One evaluateBatch call covering every instance: what the call site does now.
std::chrono::nanoseconds timeBatched(konjugate::ProviderRuntime& runtime,
                                     const konjugate::NodeExecutionPlan& node,
                                     int repetitions) {
    std::vector<const konjugate::ContributionTask*> tasks;
    std::vector<std::vector<double>> inputStorage;
    tasks.reserve(node.contributions.size());
    inputStorage.reserve(node.contributions.size());
    for (const auto& task : node.contributions) {
        tasks.push_back(&task);
        inputStorage.push_back({300.0});
    }
    std::vector<std::span<const double>> batchInputs(inputStorage.begin(), inputStorage.end());

    const auto started = std::chrono::steady_clock::now();
    for (int repetition = 0; repetition < repetitions; ++repetition) {
        if (runtime.evaluateBatch(tasks, batchInputs, 1.5, 0.01).size() != tasks.size()) {
            throw std::runtime_error("Unexpected batched result size.");
        }
    }
    return std::chrono::steady_clock::now() - started;
}

}

// Same shape (one node, N contributions each reading one localState symbol) and same math
// (delta * 3) as buildSharedProviderNode()'s inline provider, so the two are a fair comparison
// of "cost of one contribution" rather than an artifact of different amounts of work.
konjugate::NodeExecutionPlan buildEquationNode(std::size_t instanceCount) {
    konjugate::NodeExecutionPlan node;
    node.stateIndexes = {0};
    node.contributions.reserve(instanceCount);
    for (std::size_t index = 0; index < instanceCount; ++index) {
        konjugate::CompiledExpression deltaSymbol;
        deltaSymbol.operation = konjugate::ExpressionOperation::symbol;
        deltaSymbol.symbol = "delta";
        deltaSymbol.symbolIndex = 0;

        konjugate::CompiledExpression three;
        three.operation = konjugate::ExpressionOperation::literal;
        three.literal = 3.0;

        konjugate::CompiledExpression product;
        product.operation = konjugate::ExpressionOperation::multiply;
        product.arguments = {deltaSymbol, three};

        konjugate::ContributionTask task;
        task.sequence = index;
        task.sourceId = 2000 + index;
        task.outputStateIndex = 0;
        task.implementation = konjugate::ContributionImplementation::equation;
        task.expression = std::move(product);

        konjugate::CompiledBinding binding;
        binding.symbol = "delta";
        binding.source = konjugate::BindingSource::localState;
        binding.valueIndex = 0;
        task.bindings = {binding};

        node.contributions.push_back(std::move(task));
    }
    return node;
}

double equationRoundTripMicros(std::size_t instanceCount, int repetitions) {
    const auto node = buildEquationNode(instanceCount);
    const konjugate::StateValues localStates = {300.0};
    const konjugate::StateValues synchronizationSnapshot = {300.0};
    const auto parameterValues = konjugate::resolveParameterValues(node, {});

    for (int warmup = 0; warmup < 5; ++warmup) {
        konjugate::evaluateContributionTasks(node, localStates, synchronizationSnapshot, parameterValues, 1.5, 0.01, nullptr);
    }

    const auto started = std::chrono::steady_clock::now();
    for (int repetition = 0; repetition < repetitions; ++repetition) {
        const auto evaluated = konjugate::evaluateContributionTasks(
            node, localStates, synchronizationSnapshot, parameterValues, 1.5, 0.01, nullptr);
        if (evaluated.size() != instanceCount) throw std::runtime_error("Unexpected equation result size.");
    }
    const auto elapsed = std::chrono::steady_clock::now() - started;
    return std::chrono::duration<double, std::micro>(elapsed).count() / repetitions;
}

double batchedRoundTripMicros(konjugate::ProviderConfiguration config, const std::string& source,
                              std::size_t instanceCount, int repetitions) {
    konjugate::ExecutionPlan plan;
    plan.initialStates = {300.0};
    const auto node = buildSharedProviderNode(instanceCount, source);
    plan.nodes = {node};

    konjugate::ProviderRuntime runtime(config);
    runtime.initialize(plan);
    timeBatched(runtime, node, 5); // warm up: keep one-time compile/spawn/handshake cost out of this
    const auto batched = timeBatched(runtime, node, repetitions);
    runtime.shutdown();

    return std::chrono::duration<double, std::micro>(batched).count() / repetitions;
}

int main() {
    konjugate::ProviderConfiguration config;
    config.cppSdkPath = "..";

    const std::string source = inlineConductanceProviderSource();
    const std::vector<std::size_t> instanceCounts = {1, 2, 4, 8, 16, 32, 64};
    constexpr int repetitions = 2000;

    std::cout << "instances,unbatchedTotalMs,batchedTotalMs,speedup,unbatchedRoundTripUs,batchedRoundTripUs\n";
    for (const auto instanceCount : instanceCounts) {
        konjugate::ExecutionPlan plan;
        plan.initialStates = {300.0};
        const auto node = buildSharedProviderNode(instanceCount, source);
        plan.nodes = {node};

        konjugate::ProviderRuntime runtime(config);
        runtime.initialize(plan);

        // Warm up so the one-time compile/spawn/handshake cost stays out of the measured region.
        timeBatched(runtime, node, 5);

        const auto unbatched = timeUnbatched(runtime, node, repetitions);
        const auto batched = timeBatched(runtime, node, repetitions);
        runtime.shutdown();

        const double unbatchedMs = std::chrono::duration<double, std::milli>(unbatched).count();
        const double batchedMs = std::chrono::duration<double, std::milli>(batched).count();
        const double unbatchedRoundTripUs = unbatchedMs * 1000.0 / (static_cast<double>(repetitions) * static_cast<double>(instanceCount));
        const double batchedRoundTripUs = batchedMs * 1000.0 / repetitions;

        std::cout << instanceCount << ',' << unbatchedMs << ',' << batchedMs << ','
                  << (batchedMs > 0 ? unbatchedMs / batchedMs : 0.0) << ','
                  << unbatchedRoundTripUs << ',' << batchedRoundTripUs << '\n';
    }

    std::cout << "\ninstances,pipeRoundTripUs,sharedMemoryRoundTripUs,inProcessRoundTripUs,equationRoundTripUs,inProcessVsEquation\n";
    auto sharedMemoryConfig = config;
    sharedMemoryConfig.executionMode = konjugate::ProviderExecutionMode::sharedMemoryWorker;
    auto inProcessConfig = config;
    inProcessConfig.executionMode = konjugate::ProviderExecutionMode::inProcess;
    for (const auto instanceCount : instanceCounts) {
        const auto pipeUs = batchedRoundTripMicros(config, source, instanceCount, repetitions);
        const auto sharedMemoryUs = batchedRoundTripMicros(sharedMemoryConfig, source, instanceCount, repetitions);
        const auto inProcessUs = batchedRoundTripMicros(inProcessConfig, source, instanceCount, repetitions);
        const auto equationUs = equationRoundTripMicros(instanceCount, repetitions);
        std::cout << instanceCount << ',' << pipeUs << ',' << sharedMemoryUs << ',' << inProcessUs << ',' << equationUs << ','
                  << (equationUs > 0 ? inProcessUs / equationUs : 0.0) << '\n';
    }
}
