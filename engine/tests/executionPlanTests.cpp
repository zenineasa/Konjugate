/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "executionPlan.hpp"
#include "dependencyGraph.hpp"
#include "executionBackend.hpp"
#include "partitionPlan.hpp"
#include "partitionRuntime.hpp"
#include "taskExecutor.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

konjugate::CompiledExpression symbol(const std::string& name) {
    konjugate::CompiledExpression expression;
    expression.operation = konjugate::ExpressionOperation::symbol;
    expression.symbol = name;
    return expression;
}

konjugate::CompiledExpression add(std::initializer_list<konjugate::CompiledExpression> arguments) {
    konjugate::CompiledExpression expression;
    expression.operation = konjugate::ExpressionOperation::add;
    expression.arguments = arguments;
    return expression;
}

void deterministicReductionUsesTaskSequence() {
    std::vector<konjugate::EvaluatedContribution> completedOutOfOrder = {
        {2, "state", 1},
        {0, "state", 1e16},
        {1, "state", -1e16}
    };
    const auto derivatives = konjugate::reduceContributions(std::move(completedOutOfOrder));
    require(derivatives.size() == 1, "Contributions for one state were not reduced together.");
    require(derivatives.front().second == 1, "Reduction did not preserve declared task order.");
}

void evaluationSeparatesLocalSnapshotAndLiveParameterInputs() {
    konjugate::NodeExecutionPlan node;
    node.nodeId = "targetNode";
    konjugate::ContributionTask task;
    task.sequence = 0;
    task.outputStateId = "output";
    task.bindings = {
        {"local", konjugate::BindingSource::localState, "targetState"},
        {"remote", konjugate::BindingSource::synchronizationSnapshot, "sourceState"},
        {"gain", konjugate::BindingSource::parameter, "gainParameter"}
    };
    task.parameters = {{"gainParameter", 3, true}};
    task.expression = add({symbol("local"), symbol("remote"), symbol("gain")});
    require(task.expression.operationCount() == 4, "Static expression work was not counted recursively.");
    node.contributions.push_back(std::move(task));

    const konjugate::StateValues local = {{"targetState", 2}, {"sourceState", 999}};
    const konjugate::StateValues snapshot = {{"targetState", -1}, {"sourceState", 5}};
    const konjugate::StateValues overrides = {{"gainParameter", 7}};
    const auto evaluated = konjugate::evaluateContributionTasks(node, local, snapshot, overrides);
    require(evaluated.size() == 1, "The contribution task was not evaluated.");
    require(std::abs(evaluated.front().value - 14) < 1e-12,
        "Evaluation did not respect local state, synchronization snapshot and live parameter boundaries.");
}

void taskExecutorBoundsConcurrentWorkAndPropagatesResults() {
    konjugate::TaskExecutor executor(2);
    std::atomic<int> active = 0;
    std::atomic<int> maximum = 0;
    std::vector<std::future<int>> futures;
    for (int value = 0; value < 8; ++value) {
        futures.push_back(executor.submit([value, &active, &maximum] {
            const auto current = ++active;
            auto observed = maximum.load();
            while (current > observed && !maximum.compare_exchange_weak(observed, current)) {}
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
            --active;
            return value * value;
        }));
    }
    for (int value = 0; value < 8; ++value) require(futures[value].get() == value * value, "A worker result was not propagated.");
    require(maximum.load() == 2, "The task executor did not use exactly its bounded worker count.");
    require(executor.workerCount() == 2, "The task executor reported an incorrect worker count.");
}

void taskSubmissionPrioritizesEstimatedWorkAndKeepsStableTies() {
    std::vector<konjugate::NodeExecutionPlan> nodes(4);
    nodes[0].estimatedOperationsPerSubstep = 2;
    nodes[0].substeps = 2;
    nodes[1].estimatedOperationsPerSubstep = 8;
    nodes[1].substeps = 1;
    nodes[2].estimatedOperationsPerSubstep = 4;
    nodes[2].substeps = 2;
    nodes[3].estimatedOperationsPerSubstep = 1;
    nodes[3].substeps = 1;
    require(konjugate::planTaskSubmissionOrder(nodes) == std::vector<std::size_t>({1, 2, 0, 3}),
        "Task submission did not prioritize estimated work with stable ties.");
}

void dependencyGraphAggregatesParallelTasksAndPreservesDirection() {
    konjugate::ExecutionPlan plan;
    plan.nodes.resize(4);
    for (std::size_t index = 0; index < plan.nodes.size(); ++index) {
        plan.nodes[index].nodeId = std::string(1, static_cast<char>('A' + index));
        plan.nodes[index].stateIds = {std::string(1, static_cast<char>('a' + index))};
        plan.stateNodes[plan.nodes[index].stateIds.front()] = plan.nodes[index].nodeId;
    }
    plan.nodes[0].stateIds.push_back("a2");
    plan.stateNodes["a2"] = "A";
    plan.nodes[1].substeps = 2;

    konjugate::ContributionTask firstForward;
    firstForward.sequence = 0;
    firstForward.outputStateId = "b";
    firstForward.bindings = {
        {"first", konjugate::BindingSource::synchronizationSnapshot, "a"},
        {"second", konjugate::BindingSource::synchronizationSnapshot, "a2"}
    };
    firstForward.expression = add({symbol("first"), symbol("second")});
    konjugate::ContributionTask secondForward;
    secondForward.sequence = 1;
    secondForward.outputStateId = "b";
    secondForward.bindings = {{"first", konjugate::BindingSource::synchronizationSnapshot, "a"}};
    secondForward.expression = symbol("first");
    plan.nodes[1].contributions = {firstForward, secondForward};
    plan.nodes[1].estimatedOperationsPerSubstep = 4;

    konjugate::ContributionTask reverse;
    reverse.sequence = 0;
    reverse.outputStateId = "a";
    reverse.bindings = {{"remote", konjugate::BindingSource::synchronizationSnapshot, "b"}};
    reverse.expression = symbol("remote");
    plan.nodes[0].contributions = {reverse};
    plan.nodes[0].estimatedOperationsPerSubstep = 1;

    const auto graph = konjugate::buildDependencyGraph(plan);
    require(graph.nodes.size() == 4 && graph.dependencies.size() == 2, "Dependency graph has an incorrect shape.");
    require(graph.componentCount == 3, "Disconnected components were not identified deterministically.");
    require(graph.nodes[0].component == graph.nodes[1].component && graph.nodes[2].component != graph.nodes[0].component,
        "Connected nodes were assigned to incorrect components.");
    const auto forward = std::find_if(graph.dependencies.begin(), graph.dependencies.end(), [](const auto& dependency) {
        return dependency.sourceNodeId == "A" && dependency.targetNodeId == "B";
    });
    require(forward != graph.dependencies.end(), "The forward dependency is missing.");
    require(forward->contributionTaskCount == 2, "Parallel contribution tasks were not aggregated.");
    require(forward->remoteBindingsPerSubstep == 3 && forward->remoteStateIds.size() == 2,
        "Remote bindings and unique communicated states were conflated.");
    require(forward->estimatedDependentOperationsPerSynchronization == 8 && forward->communicationWeight == 2,
        "Dependency weights are incorrect.");
    require(std::any_of(graph.dependencies.begin(), graph.dependencies.end(), [](const auto& dependency) {
        return dependency.sourceNodeId == "B" && dependency.targetNodeId == "A";
    }), "Reverse data flow was not preserved as a separate directed dependency.");
}

void greedyPartitionerBalancesIndependentWork() {
    konjugate::DependencyGraph graph;
    graph.nodes = {
        {"A", 1, 1, 8, 0},
        {"B", 1, 1, 7, 1},
        {"C", 1, 1, 6, 2},
        {"D", 1, 1, 5, 3}
    };
    graph.componentCount = 4;
    const auto partitioned = konjugate::createGreedyPartitionPlan(graph, 2);
    require(partitioned.effectivePartitions == 2, "The requested partition count was not created.");
    require(partitioned.partitions[0].computeWeight == 13 && partitioned.partitions[1].computeWeight == 13,
        "Independent computation was not balanced.");
    require(std::abs(partitioned.greedy.computeImbalance - 1) < 1e-12,
        "Balanced partitions reported an incorrect imbalance.");
    require(partitioned.greedy.computeImbalance < partitioned.roundRobin.computeImbalance,
        "Greedy placement did not improve on round robin for uneven work.");
}

void greedyPartitionerCanKeepExpensiveCommunicationLocal() {
    konjugate::DependencyGraph graph;
    graph.nodes = {
        {"A", 1, 1, 1, 0},
        {"B", 1, 1, 1, 0},
        {"C", 1, 1, 1, 1}
    };
    graph.dependencies = {{"A", "B", {"a"}, 1, 1, 1, 100}};
    graph.componentCount = 2;
    const auto partitioned = konjugate::createGreedyPartitionPlan(graph, 2);
    require(partitioned.assignments[0].partition == partitioned.assignments[1].partition,
        "A high-communication dependency was cut unnecessarily.");
    require(partitioned.greedy.communicationCutWeight == 0 && partitioned.roundRobin.communicationCutWeight == 100,
        "Communication-cut comparison is incorrect.");
    const auto balanceOnly = konjugate::createGreedyPartitionPlan(graph, 2, 0);
    const auto targetPartition = balanceOnly.assignments[1].partition;
    require(balanceOnly.assignments[0].partition != targetPartition,
        "The balance-only reference plan did not cut the dependency as expected.");
    require(balanceOnly.partitions[targetPartition].boundaryStateCount == 1,
        "The receiving partition did not report its exchanged boundary state.");
    require(balanceOnly.partitions[0].localStateCount + balanceOnly.partitions[1].localStateCount == 3,
        "Partition-local state accounting is incorrect.");
}

void greedyPartitionerClustersACommunicationRing() {
    konjugate::DependencyGraph graph;
    for (std::size_t index = 0; index < 12; ++index) {
        graph.nodes.push_back({"node" + std::to_string(index), 1, 1, 10, 0});
    }
    for (std::size_t index = 0; index < graph.nodes.size(); ++index) {
        graph.dependencies.push_back({
            graph.nodes[index].nodeId,
            graph.nodes[(index + 1) % graph.nodes.size()].nodeId,
            {"state" + std::to_string(index)}, 1, 1, 1, 1
        });
    }
    graph.componentCount = 1;
    const auto partitioned = konjugate::createGreedyPartitionPlan(graph, 3);
    require(partitioned.greedy.communicationCutWeight <= 3,
        "The greedy partitioner fragmented a simple communication ring.");
    require(partitioned.greedy.communicationCutWeight < partitioned.roundRobin.communicationCutWeight,
        "Communication-aware placement did not improve on round robin for a ring.");
}

void partitionerSelectionUsesMetisWhenAvailable() {
    konjugate::DependencyGraph graph;
    for (std::size_t index = 0; index < 12; ++index) {
        graph.nodes.push_back({"node" + std::to_string(index), 1, 1, 10, 0});
    }
    for (std::size_t index = 0; index < graph.nodes.size(); ++index) {
        graph.dependencies.push_back({
            graph.nodes[index].nodeId, graph.nodes[(index + 1) % graph.nodes.size()].nodeId,
            {"state" + std::to_string(index)}, 1, 1, 1, 1
        });
    }
    const auto automatic = konjugate::createPartitionPlan(graph, 3);
    require(automatic.requestedAlgorithm == "automatic", "The requested partition algorithm was not recorded.");
    require(automatic.assignments.size() == graph.nodes.size(), "The selected partitioner omitted graph nodes.");
    require(automatic.selected.computeImbalance >= 1, "The selected partition metrics were not reported.");
    if (konjugate::metisPartitionerAvailable()) {
        require(automatic.algorithm == "metisKway", "Automatic partitioning did not prefer an available METIS build.");
        const auto explicitMetis = konjugate::createPartitionPlan(graph, 3, 4, "metisKway");
        require(explicitMetis.algorithm == "metisKway" && explicitMetis.fallbackReason.empty(),
            "Explicit METIS partitioning unexpectedly fell back.");
    } else {
        require(automatic.algorithm == "communicationAwareGreedy" && automatic.fallbackReason == "metisUnavailable",
            "Automatic partitioning did not report its METIS fallback.");
        bool unavailableRejected = false;
        try {
            static_cast<void>(konjugate::createPartitionPlan(graph, 3, 4, "metisKway"));
        } catch (const std::runtime_error&) {
            unavailableRejected = true;
        }
        require(unavailableRejected, "An explicit METIS request was accepted by a build without METIS.");
    }
}

konjugate::ExecutionPlan singleNodeRuntimePlan() {
    konjugate::ExecutionPlan plan;
    plan.initialStates = {{"state", 1}};
    plan.stateIds = {"state"};
    plan.stateNodes = {{"state", "node"}};
    konjugate::NodeExecutionPlan node;
    node.nodeId = "node";
    node.stateIds = {"state"};
    konjugate::ContributionTask contribution;
    contribution.outputStateId = "state";
    contribution.bindings = {{"state", konjugate::BindingSource::localState, "state"}};
    contribution.expression = symbol("state");
    node.contributions = {contribution};
    plan.nodes = {node};
    return plan;
}

void partitionTransportWaitsForDelayedMessagesAndRejectsDuplicates() {
    konjugate::InMemoryPartitionTransport transport;
    auto delayed = std::async(std::launch::async, [&] {
        return transport.receive(2, 7, std::chrono::milliseconds(200));
    });
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    transport.publish({1, 7, 2, {{"remoteState", 4}}});
    const auto received = delayed.get();
    require(received.states.at("remoteState") == 4, "A delayed boundary message was not delivered intact.");

    transport.publish({1, 8, 2, {}});
    bool duplicateRejected = false;
    try {
        transport.publish({1, 8, 2, {}});
    } catch (const std::runtime_error&) {
        duplicateRejected = true;
    }
    require(duplicateRejected, "Duplicate boundary delivery was not rejected.");
}

void partitionTransportReportsMissingMessagesAndWorkerFailures() {
    konjugate::InMemoryPartitionTransport transport;
    bool missingRejected = false;
    try {
        static_cast<void>(transport.receive(0, 99, std::chrono::milliseconds(5)));
    } catch (const std::runtime_error&) {
        missingRejected = true;
    }
    require(missingRejected, "A missing boundary message did not time out.");

    const auto plan = singleNodeRuntimePlan();
    konjugate::PartitionRuntime runtime(0, plan, {0});
    auto failed = runtime.submit(transport, 1, {}, 0.1);
    transport.publish({1, 1, 0, {}});
    bool workerFailurePropagated = false;
    try {
        static_cast<void>(failed.get());
    } catch (const std::out_of_range&) {
        workerFailurePropagated = true;
    }
    require(workerFailurePropagated, "A partition worker failure was not propagated to the coordinator.");
}

void partitionRuntimeReplaysDeterministicallyThroughMessages() {
    const auto plan = singleNodeRuntimePlan();
    konjugate::PartitionRuntime runtime(0, plan, {0});
    konjugate::InMemoryPartitionTransport transport;
    const auto execute = [&](std::size_t synchronizationIndex) {
        auto future = runtime.submit(transport, synchronizationIndex, {}, 0.1);
        konjugate::PartitionBoundaryMessage message{1, synchronizationIndex, 0, {{"state", 1}}};
        require(konjugate::partitionMessagePayloadBytes(message) == std::string("state").size() + sizeof(double),
            "Boundary payload accounting is incorrect.");
        transport.publish(std::move(message));
        return future.get();
    };
    const auto first = execute(3);
    const auto replay = execute(3);
    require(first.nodes.size() == 1 && replay.nodes.size() == 1, "Partition execution omitted a node result.");
    require(first.nodes.front().states == replay.nodes.front().states &&
            std::abs(first.nodes.front().states.at("state") - 1.1) < 1e-12,
        "Partition replay was not deterministic.");
}

void automaticBackendSelectionAccountsForWorkAndCommunication() {
    const auto light = konjugate::selectExecutionBackend("automatic", 8, 800, 128, 0, 0, 0.25);
    require(light.backend == "serial" && light.reason == "belowParallelWorkThreshold",
        "A light model was parallelized automatically.");
    const auto independent = konjugate::selectExecutionBackend("automatic", 8, 8192, 128, 0, 0, 0.25);
    require(independent.backend == "partitioned" && independent.reason == "independentParallelWork",
        "Independent heavy work did not select partitioned execution.");
    const auto connected = konjugate::selectExecutionBackend("automatic", 8, 8192, 128, 2, 20, 0.25);
    require(connected.backend == "partitioned" && std::abs(connected.communicationCutFraction - 0.1) < 1e-12,
        "A low-cut connected graph did not select partitioned execution.");
    const auto dense = konjugate::selectExecutionBackend("automatic", 8, 8192, 128, 9, 20, 0.25);
    require(dense.backend == "threadPool" && dense.reason == "partitionCommunicationCutTooHigh",
        "A communication-heavy partition plan did not fall back to the shared-memory thread pool.");
    const auto explicitBackend = konjugate::selectExecutionBackend("threadPool", 8, 8192, 128, 20, 20, 0);
    require(explicitBackend.backend == "threadPool" && explicitBackend.reason == "explicitSelection",
        "An explicit backend selection was overridden.");
}

}

int main() {
    try {
        deterministicReductionUsesTaskSequence();
        evaluationSeparatesLocalSnapshotAndLiveParameterInputs();
        taskExecutorBoundsConcurrentWorkAndPropagatesResults();
        taskSubmissionPrioritizesEstimatedWorkAndKeepsStableTies();
        dependencyGraphAggregatesParallelTasksAndPreservesDirection();
        greedyPartitionerBalancesIndependentWork();
        greedyPartitionerCanKeepExpensiveCommunicationLocal();
        greedyPartitionerClustersACommunicationRing();
        partitionerSelectionUsesMetisWhenAvailable();
        partitionTransportWaitsForDelayedMessagesAndRejectsDuplicates();
        partitionTransportReportsMissingMessagesAndWorkerFailures();
        partitionRuntimeReplaysDeterministicallyThroughMessages();
        automaticBackendSelectionAccountsForWorkAndCommunication();
        std::cout << "Execution plan tests passed.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
