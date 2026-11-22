/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Integration of the whole model at once, stage by stage (docs/proposals/integrators.md). Euler node by node, the default, does
// not come here: it runs through integrateNode as it always has. A whole-model method evaluates every node at every stage from
// every node's stage values, so the coupling between nodes is as accurate as the method. What cannot take part in stages is
// stepped as node by node and held: a node whose own program is not known to be pure (every version 1 program), or sets its states'
// values (an imported FMU, which can only be told to step); and a term written as a program not known to be pure, which is evaluated
// once per global step, at its start, and held through the stages. Purity is asked of ProviderEvaluator::declaredPure, which no version 1
// program can answer yes to (docs/proposals/programSdkV2.md).

#include "executionPlan.hpp"
#include <boost/property_tree/ptree.hpp>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace konjugate {

enum class IntegrationMethod { nodeByNode, rungeKutta4 };

struct IntegrationSettings {
    IntegrationMethod method = IntegrationMethod::nodeByNode;
    // Runge–Kutta 4 only: how many steps of the method make one global step.
    std::size_t stepsPerGlobalStep = 1;
};

// The run configuration's `method` (absent: node by node) and `stepsPerGlobalStep` (absent: 1), refused by name when the method
// is one this engine does not know, so a method added later is never silently run as another.
IntegrationSettings integrationSettingsFromTree(const boost::property_tree::ptree& configuration);

// The name a run configuration and a result give the method: nodeByNode or rungeKutta4.
std::string_view integrationMethodName(IntegrationMethod method) noexcept;
// The checkpoint's solver_kind: explicitEuler (node by node, semi-implicit nodes included) or rungeKutta4.
std::string_view solverKindName(IntegrationMethod method) noexcept;
// The method's number of stages a step.
std::size_t integrationMethodStages(IntegrationMethod method) noexcept;

// The project document's `requires`: features a model needs that change its numbers, each named. An engine refuses, by name, any
// it does not know, rather than running the model as if the feature were not there. Absent from every document that needs none.
void checkRequiredFeatures(const boost::property_tree::ptree& document);

// How one node takes part in a whole-model step.
struct WholeModelNode {
    // Stepped on its own, as node by node, from the step's start, and read held by the rest through the stages.
    bool stepped = false;
    // What takes part in every stage: the node's equations, and any program of it known to be pure.
    NodeExecutionPlan stageNode;
    // Its programs not known to be pure: evaluated once per global step, at its start, and held through the stages.
    NodeExecutionPlan heldNode;
    // The plan's indexes of the node's states the method integrates (those a stage term adds a rate to).
    std::vector<std::size_t> integratedStates;
};

struct HeldTerm {
    EntityId sourceId = 0;
    EntityId stateId = 0;
};

struct WholeModelPlan {
    std::vector<WholeModelNode> nodes;
    // Per state of the plan: whether the method integrates it. Every other state holds its value through the stages.
    std::vector<unsigned char> integrated;
    // The plan's indexes of the stepped nodes, in node order.
    std::vector<std::size_t> steppedNodes;
    // The programs held, in node order.
    std::vector<HeldTerm> heldTerms;
};

// `providers` says which programs are known to be pure (ProviderEvaluator::declaredPure); with none, no program is.
WholeModelPlan buildWholeModelPlan(const ExecutionPlan& plan, const ProviderEvaluator* providers);

struct NodeStageResult {
    // The node's derivatives at the stage: (the node's own state index, value), each state at most once.
    std::vector<std::pair<std::size_t, double>> derivatives;
    std::uint64_t computeNanoseconds = 0;
    std::size_t evaluatedContributions = 0;
};

// One node's derivatives at one stage: its stage terms evaluated from `stageStates` (every state of the plan at the stage) at
// `stageTime`, with `stepSize` passed to any program evaluated at stages, plus its held programs' values. When `evaluateHeld` (the first stage of
// a global step, whose states and time are the step's start), the held programs are evaluated, with `heldStepSize` (the global
// step), and kept in `held`; at every other stage `held` is read. The contributions to each state are summed in the node's
// compiled order, as node by node sums them.
NodeStageResult evaluateNodeStage(const NodeExecutionPlan& node, const WholeModelNode& stageNode, const StateValues& stageStates,
                                  const EntityValues& liveParameterValues, const std::vector<ParameterSchedule>& activeSchedules,
                                  double stageTime, double stepSize, bool evaluateHeld, double heldStepSize,
                                  std::vector<EvaluatedContribution>& held, ProviderEvaluator* providerEvaluator);

}
