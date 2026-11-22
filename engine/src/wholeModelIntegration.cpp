/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "wholeModelIntegration.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <set>
#include <stdexcept>

namespace konjugate {

IntegrationSettings integrationSettingsFromTree(const boost::property_tree::ptree& configuration) {
    IntegrationSettings settings;
    const auto method = configuration.get<std::string>("method", "nodeByNode");
    if (method == "nodeByNode") settings.method = IntegrationMethod::nodeByNode;
    else if (method == "rungeKutta4") settings.method = IntegrationMethod::rungeKutta4;
    else {
        throw std::runtime_error("The run's method \"" + method + "\" is not one this version of Konjugate knows (it knows nodeByNode and "
            "rungeKutta4); open the model in the version that wrote it, or choose another method.");
    }
    if (const auto steps = configuration.get_optional<std::string>("stepsPerGlobalStep")) {
        char* end = nullptr;
        const auto value = std::strtod(steps->c_str(), &end);
        if (steps->empty() || end != steps->c_str() + steps->size() || !(value >= 1) || value > 10000 || value != std::floor(value)) {
            throw std::runtime_error("stepsPerGlobalStep must be an integer from 1 through 10000.");
        }
        settings.stepsPerGlobalStep = static_cast<std::size_t>(value);
    }
    return settings;
}

std::string_view integrationMethodName(IntegrationMethod method) noexcept {
    return method == IntegrationMethod::rungeKutta4 ? "rungeKutta4" : "nodeByNode";
}

std::string_view solverKindName(IntegrationMethod method) noexcept {
    return method == IntegrationMethod::rungeKutta4 ? "rungeKutta4" : "explicitEuler";
}

std::size_t integrationMethodStages(IntegrationMethod method) noexcept {
    return method == IntegrationMethod::rungeKutta4 ? 4 : 1;
}

void checkRequiredFeatures(const boost::property_tree::ptree& document) {
    const auto required = document.get_child_optional("requires");
    if (!required) return;
    // The features this engine knows that a model may require. None yet: the list exists so that the next feature that changes a
    // model's numbers can be required by name and refused by every engine from this one on that does not know it.
    static const std::set<std::string> known;
    for (const auto& entry : *required) {
        const auto name = entry.second.get_value<std::string>();
        if (!known.contains(name)) {
            throw std::runtime_error("This model requires \"" + name + "\", which this version of Konjugate does not know; open it in a newer version.");
        }
    }
}

WholeModelPlan buildWholeModelPlan(const ExecutionPlan& plan, const ProviderEvaluator* providers) {
    WholeModelPlan whole;
    whole.integrated.assign(plan.initialStates.size(), 0);
    const auto pure = [&](const std::string& key) { return providers && providers->declaredPure(key); };
    for (std::size_t index = 0; index < plan.nodes.size(); ++index) {
        const auto& node = plan.nodes[index];
        WholeModelNode compiled;
        const auto& provider = node.nodeProvider;
        // A provider that sets its states' values is a co-simulation step (an imported FMU): it can only be told to step.
        compiled.stepped = provider && (!pure(provider->providerProcessKeyCache) ||
            std::any_of(provider->outputs.begin(), provider->outputs.end(), [](const auto& output) { return output.setsValue; }));
        if (compiled.stepped) {
            whole.steppedNodes.push_back(index);
            whole.nodes.push_back(std::move(compiled));
            continue;
        }
        compiled.stageNode.nodeId = compiled.heldNode.nodeId = node.nodeId;
        compiled.stageNode.stateIds = compiled.heldNode.stateIds = node.stateIds;
        compiled.stageNode.stateIndexes = compiled.heldNode.stateIndexes = node.stateIndexes;
        compiled.stageNode.nodeProvider = provider;
        std::set<std::size_t> integrated;
        for (const auto& task : node.contributions) {
            const bool held = task.implementation != ContributionImplementation::equation && !pure(providerProcessKey(task));
            (held ? compiled.heldNode : compiled.stageNode).contributions.push_back(task);
            if (held) whole.heldTerms.push_back({task.sourceId, task.outputStateId});
            integrated.insert(task.outputStateIndex);
        }
        if (provider) {
            for (const auto& output : provider->outputs) integrated.insert(output.stateIndex);
        }
        for (const auto local : integrated) {
            compiled.integratedStates.push_back(node.stateIndexes.at(local));
            whole.integrated.at(node.stateIndexes.at(local)) = 1;
        }
        whole.nodes.push_back(std::move(compiled));
    }
    return whole;
}

NodeStageResult evaluateNodeStage(const NodeExecutionPlan& node, const WholeModelNode& stageNode, const StateValues& stageStates,
                                  const EntityValues& liveParameterValues, const std::vector<ParameterSchedule>& activeSchedules,
                                  double stageTime, double stepSize, bool evaluateHeld, double heldStepSize,
                                  std::vector<EvaluatedContribution>& held, ProviderEvaluator* providerEvaluator) {
    const auto startedAt = std::chrono::steady_clock::now();
    NodeStageResult result;
    StateValues localStates(node.stateIndexes.size());
    for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) localStates[index] = stageStates[node.stateIndexes[index]];
    if (evaluateHeld) {
        held.clear();
        if (!stageNode.heldNode.contributions.empty()) {
            const auto parameters = resolveParameterValues(stageNode.heldNode.contributions, liveParameterValues, activeSchedules, stageTime);
            held = evaluateContributionTasks(stageNode.heldNode, localStates, stageStates, parameters, stageTime, heldStepSize, providerEvaluator);
        }
    }
    const auto& stage = stageNode.stageNode;
    const auto parameters = resolveParameterValues(stage.contributions, liveParameterValues, activeSchedules, stageTime);
    const auto providerParameters = stage.nodeProvider && !stage.nodeProvider->parameters.empty()
        ? resolveNodeProviderParameterValues(*stage.nodeProvider, liveParameterValues, activeSchedules, stageTime) : std::vector<double>{};
    auto evaluated = evaluateContributionTasks(stage, localStates, stageStates, parameters, stageTime, stepSize, providerEvaluator, nullptr,
        &providerParameters);
    // A provider's outputs come after every contribution of the node, as node by node orders them, held contributions included.
    const auto shift = node.contributions.size() - stage.contributions.size();
    for (auto& contribution : evaluated) if (contribution.sequence >= stage.contributions.size()) contribution.sequence += shift;
    result.evaluatedContributions = evaluated.size();
    evaluated.insert(evaluated.end(), held.begin(), held.end());
    result.derivatives = reduceContributions(std::move(evaluated));
    result.computeNanoseconds = static_cast<std::uint64_t>(std::max<std::int64_t>(0,
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - startedAt).count()));
    return result;
}

}
