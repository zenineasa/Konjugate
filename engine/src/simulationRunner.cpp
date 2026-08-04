/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "simulationRunner.hpp"
#include "engineProtocol.pb.h"
#include "dependencyGraph.hpp"
#include "executionBackend.hpp"
#include "executionPlan.hpp"
#include "partitionPlan.hpp"
#include "partitionRuntime.hpp"
#include "taskExecutor.hpp"
#include <boost/property_tree/json_parser.hpp>
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <future>
#include <memory>
#include <numeric>
#include <random>
#include <set>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <unordered_map>
#include <vector>

namespace konjugate {
namespace {
void writeFramedEvent(std::ostream& output, const protocol::EngineEvent& event) {
    const auto size = event.ByteSizeLong();
    if (size > 0xffffffffu) throw std::runtime_error("The protocol event is too large.");
    const unsigned char header[4] = {
        static_cast<unsigned char>((size >> 24) & 0xff), static_cast<unsigned char>((size >> 16) & 0xff),
        static_cast<unsigned char>((size >> 8) & 0xff), static_cast<unsigned char>(size & 0xff)
    };
    output.write(reinterpret_cast<const char*>(header), sizeof(header));
    if (!event.SerializeToOstream(&output)) throw std::runtime_error("Could not serialize the protocol event.");
    output.flush();
}
using Values = StateValues;
struct Sample { double time; Values states; };
struct Checkpoint { std::string uuid; double time; Values states; };
enum class PacingMode { fastest, realTime, limitedRatio };
enum class RunState { running, paused, stopped };
struct Pacing { PacingMode mode = PacingMode::fastest; double ratio = 1; };
struct RunControl { Pacing pacing; RunState executionState = RunState::running; EntityValues parameterValues; };
struct ExecutionSettings {
    ExecutionBackend requestedBackend = ExecutionBackend::automatic;
    ExecutionBackend backend = ExecutionBackend::serial;
    std::size_t workerThreads = 1;
    std::size_t estimatedOperationsPerSynchronization = 0;
    std::size_t automaticParallelThreshold = 128;
};
struct NodeIntegrationResult { Values states; std::uint64_t computeNanoseconds = 0; };
struct NodeRuntimeMetrics {
    std::uint64_t invocations = 0;
    std::uint64_t executedSubsteps = 0;
    std::uint64_t evaluatedContributions = 0;
    std::uint64_t computeNanoseconds = 0;
};

EntityId entityIdValue(const boost::property_tree::ptree& tree, const std::string& key) {
    const auto text = tree.get<std::string>(key, "");
    std::size_t consumed = 0;
    const auto result = std::stoull(text, &consumed);
    if (!result || result > 9007199254740991ULL || consumed != text.size()) {
        throw std::runtime_error("Model ids must be positive safe integers.");
    }
    return result;
}

PacingMode pacingModeFromString(const std::string& value) {
    if (value == "fastest") return PacingMode::fastest;
    if (value == "realTime") return PacingMode::realTime;
    if (value == "limitedRatio") return PacingMode::limitedRatio;
    throw std::runtime_error("Pacing mode must be fastest, realTime, or limitedRatio.");
}

std::string_view pacingModeName(PacingMode value) noexcept {
    switch (value) {
        case PacingMode::fastest: return "fastest";
        case PacingMode::realTime: return "realTime";
        case PacingMode::limitedRatio: return "limitedRatio";
    }
    return "fastest";
}

RunState runStateFromString(const std::string& value) {
    if (value == "running") return RunState::running;
    if (value == "paused") return RunState::paused;
    if (value == "stopped") return RunState::stopped;
    throw std::runtime_error("Run state must be running, paused or stopped.");
}

std::string_view runStateName(RunState value) noexcept {
    switch (value) {
        case RunState::running: return "running";
        case RunState::paused: return "paused";
        case RunState::stopped: return "stopped";
    }
    return "running";
}

std::string createUuid() {
    static thread_local std::mt19937_64 generator(std::random_device{}());
    std::uniform_int_distribution<unsigned int> octet(0, 255);
    unsigned int bytes[16];
    for (auto& byte : bytes) byte = octet(generator);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    std::ostringstream value;
    value << std::hex << std::setfill('0');
    for (std::size_t index = 0; index < 16; ++index) {
        if (index == 4 || index == 6 || index == 8 || index == 10) value << '-';
        value << std::setw(2) << bytes[index];
    }
    return value.str();
}

std::string escape(const std::string& input) {
    std::string output;
    for (const char character : input) {
        if (character == '\\' || character == '"') output += '\\';
        output += character;
    }
    return output;
}

void atomicWrite(const std::filesystem::path& path, const std::string& content) {
    const auto temporary = path.string() + ".tmp";
    std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
    if (!stream) throw std::runtime_error("The simulation result could not be created.");
    stream << content;
    stream.close();
    std::error_code error;
    std::filesystem::rename(temporary, path, error);
    if (error) {
        std::filesystem::remove(path, error);
        std::filesystem::rename(temporary, path);
    }
}

Pacing pacingFromTree(const boost::property_tree::ptree& tree, const Pacing& fallback = {}) {
    Pacing pacing;
    pacing.mode = pacingModeFromString(tree.get<std::string>(
        "pacing.mode", tree.get<std::string>("mode", std::string(pacingModeName(fallback.mode)))));
    pacing.ratio = tree.get<double>("pacing.simulationSecondsPerWallSecond",
        tree.get<double>("simulationSecondsPerWallSecond", fallback.ratio));
    if (pacing.mode == PacingMode::realTime) pacing.ratio = 1;
    if (pacing.mode == PacingMode::limitedRatio && (!(pacing.ratio > 0) || !std::isfinite(pacing.ratio))) {
        throw std::runtime_error("Limited pacing requires a finite positive simulationSecondsPerWallSecond value.");
    }
    return pacing;
}

RunControl readRunControl(const std::filesystem::path& path, const RunControl& current) {
    if (path.empty() || !std::filesystem::exists(path)) return current;
    try {
        boost::property_tree::ptree control;
        boost::property_tree::read_json(path.string(), control);
        const auto executionState = runStateFromString(control.get<std::string>(
            "executionState", std::string(runStateName(current.executionState))));
        auto parameterValues = current.parameterValues;
        if (const auto values = control.get_child_optional("parameterValues")) {
            for (const auto& item : *values) {
                const auto parameterValue = item.second.get_value<double>();
                std::size_t consumed = 0;
                const auto parameterId = std::stoull(item.first, &consumed);
                if (consumed == item.first.size() && parameterId > 0 &&
                    parameterId <= 9007199254740991ULL && std::isfinite(parameterValue)) {
                    parameterValues[parameterId] = parameterValue;
                }
            }
        }
        return {pacingFromTree(control, current.pacing), executionState, std::move(parameterValues)};
    } catch (...) {
        return current;
    }
}

ExecutionSettings executionSettingsFromTree(const boost::property_tree::ptree& tree, const ExecutionPlan& plan) {
    ExecutionSettings settings;
    settings.requestedBackend = executionBackendFromString(tree.get<std::string>("execution.backend", "automatic"));
    settings.automaticParallelThreshold = tree.get<std::size_t>("execution.automaticParallelThreshold", 128);
    if (!settings.automaticParallelThreshold || settings.automaticParallelThreshold > 1000000) {
        throw std::runtime_error("execution.automaticParallelThreshold must be an integer from 1 through 1000000.");
    }
    for (const auto& node : plan.nodes) {
        settings.estimatedOperationsPerSynchronization += node.estimatedOperationsPerSubstep * node.substeps;
    }
    const auto hardwareThreads = std::max(1u, std::thread::hardware_concurrency());
    const auto requestedThreads = tree.get<std::size_t>("execution.workerThreads", hardwareThreads);
    if (!requestedThreads || requestedThreads > 256) {
        throw std::runtime_error("execution.workerThreads must be an integer from 1 through 256.");
    }
    settings.backend = settings.requestedBackend;
    settings.workerThreads = settings.requestedBackend == ExecutionBackend::serial
        ? 1 : std::min(requestedThreads, std::max<std::size_t>(1, plan.nodes.size()));
    return settings;
}

NodeIntegrationResult integrateNode(const NodeExecutionPlan& node,
                                    const Values& synchronizationSnapshot,
                                    const EntityValues& liveParameterValues,
                                    double synchronizationStep) {
    const auto startedAt = std::chrono::steady_clock::now();
    Values localStates(node.stateIndexes.size());
    for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) {
        localStates[index] = synchronizationSnapshot.at(node.stateIndexes[index]);
    }
    const auto parameterValues = resolveParameterValues(node, liveParameterValues);
    const auto nodeTimeStep = synchronizationStep / static_cast<double>(node.substeps);
    for (std::size_t substep = 0; substep < node.substeps; ++substep) {
        const auto evaluated = evaluateContributionTasks(node, localStates, synchronizationSnapshot, parameterValues);
        const auto derivatives = reduceContributions(evaluated);
        for (const auto& derivative : derivatives) localStates.at(derivative.first) += nodeTimeStep * derivative.second;
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - startedAt).count();
    return {std::move(localStates), static_cast<std::uint64_t>(std::max<std::int64_t>(0, elapsed))};
}
}

void runSimulation(const boost::property_tree::ptree& document,
                   const boost::property_tree::ptree& configuration,
                   const std::filesystem::path& outputPath,
                   const std::filesystem::path& pacingControlPath,
                   std::ostream* eventStream) {
    const auto targetTime = configuration.get<double>("targetTime");
    const auto globalTimeStep = configuration.get<double>("globalTimeStep", configuration.get<double>("timeStep", 0.01));
    const auto outputInterval = configuration.get<double>("outputInterval", globalTimeStep);
    const auto outputRatio = outputInterval / globalTimeStep;
    auto pacing = pacingFromTree(configuration);
    RunControl runControl{pacing, RunState::running, {}};
    if (!(targetTime > 0) || !(globalTimeStep > 0) || globalTimeStep > targetTime || !(outputInterval > 0) ||
        !std::isfinite(targetTime) || !std::isfinite(globalTimeStep) || !std::isfinite(outputInterval)) {
        throw std::runtime_error("A run requires a finite positive targetTime and numerical timestep values.");
    }
    if (outputInterval < globalTimeStep || std::abs(outputRatio - std::round(outputRatio)) > 1e-9) {
        throw std::runtime_error("outputInterval must be an integer multiple of globalTimeStep.");
    }

    const auto planningStartedAt = std::chrono::steady_clock::now();
    const auto executionPlan = compileExecutionPlan(document);
    const auto dependencyGraph = buildDependencyGraph(executionPlan);
    auto executionSettings = executionSettingsFromTree(configuration, executionPlan);
    const auto requestedPartitions = configuration.get<std::size_t>("execution.partitionCount", executionSettings.workerThreads);
    if (!requestedPartitions || requestedPartitions > 256) {
        throw std::runtime_error("Partition count must be an integer from 1 through 256.");
    }
    const auto executablePartitions = executionSettings.requestedBackend == ExecutionBackend::partitioned ||
        executionSettings.requestedBackend == ExecutionBackend::automatic
        ? std::min(requestedPartitions, executionSettings.workerThreads) : requestedPartitions;
    const auto communicationBias = configuration.get<double>("execution.partitionCommunicationBias", 4);
    const auto partitionAlgorithm = configuration.get<std::string>("execution.partitionAlgorithm", "automatic");
    auto partitionPlan = createPartitionPlan(dependencyGraph, executablePartitions, communicationBias, partitionAlgorithm);
    partitionPlan.requestedPartitions = requestedPartitions;
    const auto totalCommunicationWeight = std::accumulate(
        dependencyGraph.dependencies.begin(), dependencyGraph.dependencies.end(), std::size_t{0},
        [](std::size_t total, const auto& dependency) { return total + dependency.communicationWeight; });
    const auto maximumPartitionCutFraction = configuration.get<double>("execution.automaticMaximumPartitionCutFraction", 0.25);
    const auto backendDecision = selectExecutionBackend(
        executionSettings.requestedBackend, executionPlan.nodes.size(),
        executionSettings.estimatedOperationsPerSynchronization, executionSettings.automaticParallelThreshold,
        partitionPlan.selected.communicationCutWeight, totalCommunicationWeight, maximumPartitionCutFraction);
    executionSettings.backend = backendDecision.backend;
    if (executionSettings.backend == ExecutionBackend::serial) executionSettings.workerThreads = 1;
    const auto planningNanoseconds = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - planningStartedAt).count());
    std::unique_ptr<TaskExecutor> taskExecutor;
    if (executionSettings.backend == ExecutionBackend::threadPool) taskExecutor = std::make_unique<TaskExecutor>(executionSettings.workerThreads);
    std::vector<std::vector<std::size_t>> partitionNodeIndexes;
    std::vector<std::vector<EntityId>> partitionSnapshotStateIds;
    std::vector<std::unique_ptr<PartitionRuntime>> partitionRuntimes;
    std::unique_ptr<InMemoryPartitionTransport> partitionTransport;
    const auto partitionReceiveTimeoutMilliseconds = configuration.get<std::size_t>(
        "execution.partitionReceiveTimeoutMilliseconds", 5000);
    if (!partitionReceiveTimeoutMilliseconds || partitionReceiveTimeoutMilliseconds > 60000) {
        throw std::runtime_error("execution.partitionReceiveTimeoutMilliseconds must be an integer from 1 through 60000.");
    }
    if (executionSettings.backend == ExecutionBackend::partitioned) {
        partitionRuntimes.reserve(partitionPlan.effectivePartitions);
        partitionNodeIndexes.resize(partitionPlan.effectivePartitions);
        partitionSnapshotStateIds.resize(partitionPlan.effectivePartitions);
        std::unordered_map<EntityId, std::size_t> executionNodeIndexes;
        std::unordered_map<EntityId, std::size_t> nodePartitions;
        for (std::size_t index = 0; index < executionPlan.nodes.size(); ++index) {
            executionNodeIndexes[executionPlan.nodes[index].nodeId] = index;
        }
        for (const auto& assignment : partitionPlan.assignments) {
            nodePartitions[assignment.nodeId] = assignment.partition;
            partitionNodeIndexes[assignment.partition].push_back(executionNodeIndexes.at(assignment.nodeId));
        }
        for (std::size_t partition = 0; partition < partitionNodeIndexes.size(); ++partition) {
            std::set<EntityId> snapshotStateIds;
            for (const auto nodeIndex : partitionNodeIndexes[partition]) {
                snapshotStateIds.insert(executionPlan.nodes[nodeIndex].stateIds.begin(), executionPlan.nodes[nodeIndex].stateIds.end());
            }
            for (const auto& dependency : dependencyGraph.dependencies) {
                if (nodePartitions.at(dependency.targetNodeId) == partition) {
                    snapshotStateIds.insert(dependency.remoteStateIds.begin(), dependency.remoteStateIds.end());
                }
            }
            partitionSnapshotStateIds[partition].assign(snapshotStateIds.begin(), snapshotStateIds.end());
        }
        for (std::size_t partition = 0; partition < partitionPlan.effectivePartitions; ++partition) {
            partitionRuntimes.push_back(std::make_unique<PartitionRuntime>(
                partition, executionPlan, partitionNodeIndexes[partition]));
        }
        partitionTransport = std::make_unique<InMemoryPartitionTransport>();
    }
    const auto activeWorkerThreads = executionSettings.backend == ExecutionBackend::partitioned
        ? partitionPlan.effectivePartitions : executionSettings.workerThreads;
    Values states = executionPlan.initialStates;
    const auto& stateNodes = executionPlan.stateNodes;
    std::unordered_map<EntityId, std::size_t> nodeSubsteps;
    for (const auto& node : executionPlan.nodes) {
        nodeSubsteps[node.nodeId] = node.substeps;
    }

    double startTime = 0;
    if (const auto checkpoint = configuration.get_child_optional("startCheckpoint")) {
        startTime = checkpoint->get<double>("time");
        std::set<EntityId> restored;
        for (const auto& stateItem : checkpoint->get_child("states")) {
            const auto stateId = entityIdValue(stateItem.second, "stateId");
            const auto stateIndex = executionPlan.stateIndexes.find(stateId);
            if (stateIndex == executionPlan.stateIndexes.end() || !restored.insert(stateId).second) {
                throw std::runtime_error("The restart checkpoint does not match the model state vector.");
            }
            states[stateIndex->second] = stateItem.second.get<double>("value");
        }
        if (restored.size() != states.size()) throw std::runtime_error("The restart checkpoint is missing model states.");
    }
    if (!(startTime >= 0) || !(targetTime > startTime)) throw std::runtime_error("targetTime must be later than the restart checkpoint.");

    const auto& stateIds = executionPlan.stateIds;
    std::vector<EntityId> nodeIds;
    for (const auto& item : nodeSubsteps) nodeIds.push_back(item.first);
    std::sort(nodeIds.begin(), nodeIds.end());

    const auto steps = static_cast<std::size_t>(std::ceil((targetTime - startTime) / globalTimeStep));
    std::vector<NodeRuntimeMetrics> nodeMetrics(executionPlan.nodes.size());
    std::uint64_t synchronizationComputeNanoseconds = 0;
    std::uint64_t partitionBoundaryMessages = 0;
    std::uint64_t partitionBoundaryPayloadBytes = 0;
    std::uint64_t partitionMessagePreparationNanoseconds = 0;
    std::uint64_t partitionTransportPublishNanoseconds = 0;
    std::uint64_t partitionBoundaryWaitNanoseconds = 0;
    std::vector<Sample> samples = {{startTime, states}};
    std::vector<Checkpoint> checkpoints = {{createUuid(), startTime, states}};
    const auto streamPath = std::filesystem::path(outputPath.string() + ".stream");
    std::ofstream resultStream(streamPath, std::ios::binary | std::ios::trunc);
    if (!resultStream) throw std::runtime_error("The live result stream could not be created.");
    if (eventStream) {
        protocol::EngineEvent event;
        event.set_protocol_version(1);
        auto* table = event.mutable_state_table();
        for (const auto stateId : stateIds) table->add_states()->set_state_id(stateId);
        writeFramedEvent(*eventStream, event);
    }
    const auto appendStreamRecord = [&](const std::string& type, double time, const Values& recordStates, const std::string& uuid = {}) {
        if (eventStream && type == "sample") {
            protocol::EngineEvent event;
            event.set_protocol_version(1);
            auto* batch = event.mutable_sample_batch();
            batch->add_times(time);
            batch->set_state_count(static_cast<std::uint32_t>(stateIds.size()));
            for (const auto& stateId : stateIds) batch->add_values(recordStates.at(executionPlan.stateIndexes.at(stateId)));
            writeFramedEvent(*eventStream, event);
            return;
        }
        resultStream << std::setprecision(17) << "{\"type\":\"" << type << "\",\"time\":" << time;
        if (!uuid.empty()) resultStream << ",\"uuid\":\"" << uuid << "\",\"solver\":{\"kind\":\"explicitEuler\",\"version\":1}";
        resultStream << ",\"states\":[";
        for (std::size_t stateIndex = 0; stateIndex < stateIds.size(); ++stateIndex) {
            if (stateIndex) resultStream << ',';
            const auto& stateId = stateIds[stateIndex];
            resultStream << "{\"stateId\":" << stateId << ",\"value\":"
                         << recordStates.at(executionPlan.stateIndexes.at(stateId)) << '}';
        }
        resultStream << "]}\n";
    };
    appendStreamRecord("sample", startTime, states);
    appendStreamRecord("checkpoint", startTime, states, checkpoints.front().uuid);
    double currentTime = startTime;
    const auto captureBoundary = [&]() {
        if (currentTime > samples.back().time + 1e-12) {
            samples.push_back({currentTime, states});
            appendStreamRecord("sample", currentTime, states);
        }
        if (currentTime > checkpoints.back().time + 1e-12) {
            checkpoints.push_back({createUuid(), currentTime, states});
            appendStreamRecord("checkpoint", currentTime, states, checkpoints.back().uuid);
        }
    };
    const auto writeResult = [&](const std::string& lifecycle, double simulationTime, bool completeSnapshot = false) {
        resultStream.flush();
        std::ostringstream json;
        json << std::setprecision(17) << "{\"resultVersion\":1,\"engineVersion\":\"0.2.0\",\"configurationName\":\""
             << escape(configuration.get<std::string>("name", "Untitled")) << "\",\"snapshotMode\":\"" << (completeSnapshot ? "full" : "live")
             << "\",\"lifecycle\":\"" << lifecycle
             << "\",\"simulationTime\":" << simulationTime << ",\"availableResultTime\":" << samples.back().time
             << ",\"pacing\":{\"mode\":\"" << pacingModeName(pacing.mode) << "\",\"simulationSecondsPerWallSecond\":" << pacing.ratio << "}"
             << ",\"targetTime\":" << targetTime << ",\"globalTimeStep\":" << globalTimeStep << ",\"outputInterval\":" << outputInterval
             << ",\"execution\":{\"planVersion\":1,\"requestedBackend\":\"" << executionBackendName(executionSettings.requestedBackend)
             << "\",\"backend\":\"" << executionBackendName(executionSettings.backend)
             << "\",\"workerThreads\":" << activeWorkerThreads << ",\"planningNanoseconds\":" << planningNanoseconds
             << ",\"estimatedOperationsPerSynchronization\":" << executionSettings.estimatedOperationsPerSynchronization
             << ",\"automaticParallelThreshold\":" << executionSettings.automaticParallelThreshold
             << ",\"selectionReason\":\"" << backendSelectionReasonName(backendDecision.reason) << "\",\"communicationCutFraction\":"
             << backendDecision.communicationCutFraction << ",\"automaticMaximumPartitionCutFraction\":"
             << maximumPartitionCutFraction
             << ",\"schedulingPolicy\":\"" << (executionSettings.backend == ExecutionBackend::partitioned
                 ? "partitionAffinity" : "largestEstimatedWorkFirst")
             << "\",\"synchronizationComputeNanoseconds\":"
             << synchronizationComputeNanoseconds << ",\"partitionCommunication\":{\"messageVersion\":1,\"transport\":\"inMemory\""
             << ",\"boundaryMessages\":" << partitionBoundaryMessages << ",\"boundaryPayloadBytes\":"
             << partitionBoundaryPayloadBytes << ",\"messagePreparationNanoseconds\":"
             << partitionMessagePreparationNanoseconds << ",\"serializationNanoseconds\":0,\"transportPublishNanoseconds\":"
             << partitionTransportPublishNanoseconds << ",\"boundaryWaitNanoseconds\":"
             << partitionBoundaryWaitNanoseconds << "},\"nodeMetrics\":[";
        for (std::size_t index = 0; index < executionPlan.nodes.size(); ++index) {
            if (index) json << ',';
            const auto& node = executionPlan.nodes[index];
            const auto& metrics = nodeMetrics[index];
            json << "{\"nodeId\":" << node.nodeId << ",\"estimatedOperationsPerSubstep\":"
                 << node.estimatedOperationsPerSubstep << ",\"invocations\":" << metrics.invocations
                 << ",\"executedSubsteps\":" << metrics.executedSubsteps << ",\"evaluatedContributions\":"
                 << metrics.evaluatedContributions << ",\"computeNanoseconds\":" << metrics.computeNanoseconds << '}';
        }
        json << "]},\"dependencyGraph\":{\"version\":" << dependencyGraph.version << ",\"componentCount\":"
             << dependencyGraph.componentCount << ",\"nodes\":[";
        for (std::size_t index = 0; index < dependencyGraph.nodes.size(); ++index) {
            if (index) json << ',';
            const auto& node = dependencyGraph.nodes[index];
            json << "{\"nodeId\":" << node.nodeId << ",\"stateCount\":" << node.stateCount
                 << ",\"substeps\":" << node.substeps << ",\"estimatedOperationsPerSynchronization\":"
                 << node.estimatedOperationsPerSynchronization << ",\"component\":" << node.component << '}';
        }
        json << "],\"dependencies\":[";
        for (std::size_t index = 0; index < dependencyGraph.dependencies.size(); ++index) {
            if (index) json << ',';
            const auto& dependency = dependencyGraph.dependencies[index];
            json << "{\"sourceNodeId\":" << dependency.sourceNodeId << ",\"targetNodeId\":"
                 << dependency.targetNodeId << ",\"remoteStateIds\":[";
            for (std::size_t stateIndex = 0; stateIndex < dependency.remoteStateIds.size(); ++stateIndex) {
                if (stateIndex) json << ',';
                json << dependency.remoteStateIds[stateIndex];
            }
            json << "],\"contributionTaskCount\":" << dependency.contributionTaskCount << ",\"remoteBindingsPerSubstep\":"
                 << dependency.remoteBindingsPerSubstep << ",\"estimatedDependentOperationsPerSynchronization\":"
                 << dependency.estimatedDependentOperationsPerSynchronization << ",\"communicationWeight\":"
                 << dependency.communicationWeight << '}';
        }
        json << "]},\"partitionPlan\":{\"version\":" << partitionPlan.version << ",\"algorithm\":\""
             << partitionPlan.algorithm << "\",\"algorithmVersion\":\"" << partitionPlan.algorithmVersion
             << "\",\"requestedAlgorithm\":\"" << partitionPlan.requestedAlgorithm
             << "\",\"fallbackReason\":\"" << escape(partitionPlan.fallbackReason)
             << "\",\"metisAvailable\":" << (metisPartitionerAvailable() ? "true" : "false")
             << ",\"requestedPartitions\":" << partitionPlan.requestedPartitions
             << ",\"effectivePartitions\":" << partitionPlan.effectivePartitions << ",\"communicationBias\":"
             << partitionPlan.communicationBias << ",\"assignments\":[";
        for (std::size_t index = 0; index < partitionPlan.assignments.size(); ++index) {
            if (index) json << ',';
            json << "{\"nodeId\":" << partitionPlan.assignments[index].nodeId << ",\"partition\":"
                 << partitionPlan.assignments[index].partition << '}';
        }
        json << "],\"partitions\":[";
        for (std::size_t index = 0; index < partitionPlan.partitions.size(); ++index) {
            if (index) json << ',';
            const auto& partition = partitionPlan.partitions[index];
            json << "{\"partition\":" << partition.partition << ",\"nodeCount\":" << partition.nodeCount
                 << ",\"computeWeight\":" << partition.computeWeight << ",\"localStateCount\":"
                 << partition.localStateCount << ",\"boundaryStateCount\":" << partition.boundaryStateCount << '}';
        }
        const auto appendComparison = [&json](const PartitionComparison& comparison) {
            json << "{\"communicationCutWeight\":" << comparison.communicationCutWeight
                 << ",\"cutDependencyCount\":" << comparison.cutDependencyCount
                 << ",\"computeImbalance\":" << comparison.computeImbalance << '}';
        };
        json << "],\"selected\":";
        appendComparison(partitionPlan.selected);
        json << ",\"greedy\":";
        appendComparison(partitionPlan.greedy);
        json << ",\"roundRobin\":";
        appendComparison(partitionPlan.roundRobin);
        json << '}'
             << ",\"globalSteps\":" << steps << ",\"nodeTimesteps\":[";
        for (std::size_t index = 0; index < nodeIds.size(); ++index) {
            if (index) json << ',';
            const auto& nodeId = nodeIds[index];
            json << "{\"nodeId\":" << nodeId << ",\"substepsPerGlobalStep\":" << nodeSubsteps.at(nodeId)
                 << ",\"effectiveTimeStep\":" << globalTimeStep / static_cast<double>(nodeSubsteps.at(nodeId)) << '}';
        }
        json << "],\"states\":[";
        for (std::size_t index = 0; index < stateIds.size(); ++index) {
            if (index) json << ',';
            const auto& stateId = stateIds[index];
            json << "{\"nodeId\":" << stateNodes.at(stateId) << ",\"stateId\":" << stateId
                 << ",\"value\":" << states.at(executionPlan.stateIndexes.at(stateId)) << '}';
        }
        json << "],\"samples\":[";
        for (std::size_t sampleIndex = 0; completeSnapshot && sampleIndex < samples.size(); ++sampleIndex) {
            if (sampleIndex) json << ',';
            json << "{\"time\":" << samples[sampleIndex].time << ",\"states\":[";
            for (std::size_t stateIndex = 0; stateIndex < stateIds.size(); ++stateIndex) {
                if (stateIndex) json << ',';
                const auto& stateId = stateIds[stateIndex];
                json << "{\"stateId\":" << stateId << ",\"value\":"
                     << samples[sampleIndex].states.at(executionPlan.stateIndexes.at(stateId)) << '}';
            }
            json << "]}";
        }
        json << "],\"checkpoints\":[";
        for (std::size_t checkpointIndex = 0; completeSnapshot && checkpointIndex < checkpoints.size(); ++checkpointIndex) {
            if (checkpointIndex) json << ',';
            const auto& checkpoint = checkpoints[checkpointIndex];
            json << "{\"uuid\":\"" << checkpoint.uuid << "\",\"time\":" << checkpoint.time
                 << ",\"solver\":{\"kind\":\"explicitEuler\",\"version\":1},\"states\":[";
            for (std::size_t stateIndex = 0; stateIndex < stateIds.size(); ++stateIndex) {
                if (stateIndex) json << ',';
                const auto& stateId = stateIds[stateIndex];
                json << "{\"stateId\":" << stateId << ",\"value\":"
                     << checkpoint.states.at(executionPlan.stateIndexes.at(stateId)) << '}';
            }
            json << "]}";
        }
        json << "]}";
        atomicWrite(outputPath, json.str());
    };
    writeResult("running", startTime);
    auto lastPublishedAt = std::chrono::steady_clock::now();
    auto lastControlReadAt = std::chrono::steady_clock::now() - std::chrono::seconds(1);
    const auto refreshRunControl = [&](bool force = false) {
        const auto now = std::chrono::steady_clock::now();
        if (force || now - lastControlReadAt >= std::chrono::milliseconds(10)) {
            runControl = readRunControl(pacingControlPath, runControl);
            lastControlReadAt = now;
        }
    };
    auto nextOutputTime = startTime + outputInterval;
    for (std::size_t step = 0; step < steps; ++step) {
        refreshRunControl();
        pacing = runControl.pacing;
        if (runControl.executionState == RunState::paused) {
            captureBoundary();
            writeResult("paused", currentTime);
            while (runControl.executionState == RunState::paused) {
                std::this_thread::sleep_for(std::chrono::milliseconds(40));
                refreshRunControl(true);
            }
            pacing = runControl.pacing;
            if (runControl.executionState == RunState::stopped) {
                writeResult("stopped", currentTime, true);
                resultStream.close();
                std::filesystem::remove(streamPath);
                return;
            }
            writeResult("running", currentTime);
        } else if (runControl.executionState == RunState::stopped) {
            captureBoundary();
            writeResult("stopped", currentTime, true);
            resultStream.close();
            std::filesystem::remove(streamPath);
            return;
        }
        const auto wallStepStarted = std::chrono::steady_clock::now();
        const auto synchronizationStep = std::min(globalTimeStep, targetTime - startTime - static_cast<double>(step) * globalTimeStep);
        const auto synchronizationStartedAt = std::chrono::steady_clock::now();
        const auto snapshot = states;
        auto synchronizedStates = snapshot;
        std::vector<NodeIntegrationResult> nodeResults(executionPlan.nodes.size());
        if (taskExecutor) {
            const auto parameterValues = runControl.parameterValues;
            std::vector<std::future<NodeIntegrationResult>> futures;
            futures.reserve(executionPlan.nodes.size());
            futures.resize(executionPlan.nodes.size());
            for (const auto index : executionPlan.taskSubmissionOrder) {
                const auto* nodePlan = &executionPlan.nodes[index];
                futures[index] = taskExecutor->submit([nodePlan, &snapshot, &parameterValues, synchronizationStep] {
                    return integrateNode(*nodePlan, snapshot, parameterValues, synchronizationStep);
                });
            }
            for (std::size_t index = 0; index < futures.size(); ++index) nodeResults[index] = futures[index].get();
        } else if (!partitionRuntimes.empty()) {
            const auto parameterValues = runControl.parameterValues;
            for (std::size_t partition = 0; partition < partitionRuntimes.size(); ++partition) {
                const auto preparationStartedAt = std::chrono::steady_clock::now();
                PartitionBoundaryMessage message;
                message.synchronizationIndex = step;
                message.targetPartition = partition;
                message.states.reserve(partitionSnapshotStateIds[partition].size());
                for (const auto& stateId : partitionSnapshotStateIds[partition]) {
                    message.states[stateId] = snapshot.at(executionPlan.stateIndexes.at(stateId));
                }
                partitionMessagePreparationNanoseconds += static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                    std::chrono::steady_clock::now() - preparationStartedAt).count());
                partitionBoundaryPayloadBytes += partitionMessagePayloadBytes(message);
                ++partitionBoundaryMessages;
                const auto publishStartedAt = std::chrono::steady_clock::now();
                partitionTransport->publish(std::move(message));
                partitionTransportPublishNanoseconds += static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                    std::chrono::steady_clock::now() - publishStartedAt).count());
            }
            std::vector<std::future<PartitionResultMessage>> futures;
            futures.reserve(partitionRuntimes.size());
            for (auto& runtime : partitionRuntimes) {
                futures.push_back(runtime->submit(
                    *partitionTransport, step, parameterValues, synchronizationStep,
                    std::chrono::milliseconds(partitionReceiveTimeoutMilliseconds)));
            }
            for (std::size_t partition = 0; partition < futures.size(); ++partition) {
                const auto result = futures[partition].get();
                if (result.version != 1 || result.synchronizationIndex != step || result.sourcePartition != partition) {
                    throw std::runtime_error("A partition returned an incompatible result message.");
                }
                partitionBoundaryWaitNanoseconds += result.boundaryWaitNanoseconds;
                for (const auto& nodeResult : result.nodes) {
                    nodeResults[nodeResult.nodeIndex] = {nodeResult.states, nodeResult.computeNanoseconds};
                }
            }
        } else {
            for (std::size_t index = 0; index < executionPlan.nodes.size(); ++index) {
                nodeResults[index] = integrateNode(executionPlan.nodes[index], snapshot, runControl.parameterValues, synchronizationStep);
            }
        }
        for (std::size_t index = 0; index < executionPlan.nodes.size(); ++index) {
            const auto& node = executionPlan.nodes[index];
            const auto& result = nodeResults[index];
            for (std::size_t stateIndex = 0; stateIndex < node.stateIndexes.size(); ++stateIndex) {
                synchronizedStates[node.stateIndexes[stateIndex]] = result.states.at(stateIndex);
            }
            auto& metrics = nodeMetrics[index];
            ++metrics.invocations;
            metrics.executedSubsteps += node.substeps;
            metrics.evaluatedContributions += node.substeps * node.contributions.size();
            metrics.computeNanoseconds += result.computeNanoseconds;
        }
        const auto synchronizationElapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - synchronizationStartedAt).count();
        synchronizationComputeNanoseconds += static_cast<std::uint64_t>(std::max<std::int64_t>(0, synchronizationElapsed));
        states = std::move(synchronizedStates);
        const auto elapsed = std::min(targetTime, startTime + static_cast<double>(step + 1) * globalTimeStep);
        currentTime = elapsed;
        while (pacing.mode != PacingMode::fastest) {
            const auto targetDuration = std::chrono::duration<double>(synchronizationStep / pacing.ratio);
            const auto spent = std::chrono::steady_clock::now() - wallStepStarted;
            if (spent >= targetDuration) break;
            const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(targetDuration - spent);
            std::this_thread::sleep_for(std::min(remaining, std::chrono::milliseconds(20)));
            refreshRunControl(true);
            pacing = runControl.pacing;
            if (runControl.executionState != RunState::running) break;
        }
        if (elapsed + 1e-12 >= nextOutputTime || step + 1 == steps) {
            samples.push_back({elapsed, states});
            appendStreamRecord("sample", elapsed, states);
            if (step + 1 == steps && elapsed > checkpoints.back().time + 1e-12) {
                checkpoints.push_back({createUuid(), elapsed, states});
                appendStreamRecord("checkpoint", elapsed, states, checkpoints.back().uuid);
            }
            while (nextOutputTime <= elapsed + 1e-12) nextOutputTime += outputInterval;
            const auto publicationTime = std::chrono::steady_clock::now();
            if (step + 1 == steps || publicationTime - lastPublishedAt >= std::chrono::milliseconds(250)) {
                writeResult(step + 1 == steps ? "completed" : "running", elapsed, step + 1 == steps);
                lastPublishedAt = publicationTime;
            }
        }
    }
    resultStream.close();
    std::filesystem::remove(streamPath);
}

}
