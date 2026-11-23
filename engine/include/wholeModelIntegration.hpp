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

enum class IntegrationMethod { nodeByNode, rungeKutta4, dormandPrince54, rodas4 };

struct IntegrationSettings {
    IntegrationMethod method = IntegrationMethod::nodeByNode;
    // Runge–Kutta 4: how many steps of the method make one global step. Dormand–Prince 5(4) and Rodas4: absent (0 here), the steps
    // are chosen by the error control; set, that many equal steps with the error control off, for checking the method's order.
    std::size_t stepsPerGlobalStep = 1;
    // Dormand–Prince 5(4) and Rodas4: the run's tolerances (`tolerance.relative` and `tolerance.absolute`, absent meaning 1e-6 and
    // 1e-9); a state may set its own absolute tolerance (absoluteTolerances).
    double relativeTolerance = 1e-6;
    double absoluteTolerance = 1e-9;
};

// The run configuration's `method` (absent: node by node), `stepsPerGlobalStep` (absent: 1) and `tolerance`, refused by name when the
// method is one this engine does not know, so a method added later is never silently run as another.
IntegrationSettings integrationSettingsFromTree(const boost::property_tree::ptree& configuration);

// Whether the method chooses its own steps (Dormand–Prince 5(4) with its error control on).
bool isAdaptive(const IntegrationSettings& settings) noexcept;
// Whether the stiff method chooses its own steps (Rodas4 with its error control on).
bool isStiff(const IntegrationSettings& settings) noexcept;
// Whether the method has tolerances and a step-size controller (Dormand–Prince 5(4) or Rodas4).
bool hasTolerance(IntegrationMethod method) noexcept;

// The name a run configuration and a result give the method: nodeByNode, rungeKutta4, dormandPrince54 or rodas4.
std::string_view integrationMethodName(IntegrationMethod method) noexcept;
// The checkpoint's solver_kind: explicitEuler (node by node, semi-implicit nodes included), rungeKutta4, dormandPrince54 or rodas4.
std::string_view solverKindName(IntegrationMethod method) noexcept;
// The method's number of new evaluations a step (Dormand–Prince's seventh stage is the next step's first).
std::size_t integrationMethodStages(IntegrationMethod method) noexcept;

// Every state's absolute tolerance, in the plan's state order: a state's own `numerics.absoluteTolerance` where it sets one, and the
// run's otherwise. Refused, naming the state, when one is not a finite positive number.
std::vector<double> absoluteTolerances(const boost::property_tree::ptree& document, const ExecutionPlan& plan, double runAbsoluteTolerance);

// The times strictly between `from` and `to` at which a schedule a stage can read jumps or turns a corner (docs/proposals/
// integrators.md, Interventions, live control and pacing): a step's, ramp's or pulse's start and end, a piecewise schedule's samples,
// and a square, triangle, sawtooth or noise waveform's corners; from the recorded interventions and input streams in `active` and
// every shared parameter's stored schedule the plan reads. Sorted, with times closer together than rounding merged, and none
// within rounding of `from` or `to`. An adaptive method lands a step on each.
std::vector<double> scheduleBreakpoints(const ExecutionPlan& plan, const std::vector<ParameterSchedule>& active, double from, double to);

// Dormand–Prince 5(4)'s hidden state in a checkpoint's solver_state: a versioned record of the step the controller proposes next and
// the previous step's error. Empty (the controller starts afresh) when `proposedStep` is not positive.
std::string encodeAdaptiveSolverState(double proposedStep, double previousError);
// The record read back; false (and nothing changed) when it is empty or not a record this engine wrote.
bool decodeAdaptiveSolverState(const std::string& record, double& proposedStep, double& previousError);

// Rodas4's hidden state in a checkpoint's solver_state: a versioned record of the step the controller proposes next, the last
// accepted step's error and the last accepted step itself (Gustafsson's predictive controller reads both). Empty when `proposedStep`
// is not positive.
std::string encodeStiffSolverState(double proposedStep, double previousError, double previousStep);
// The record read back; false (and nothing changed) when it is empty or not a record this engine wrote.
bool decodeStiffSolverState(const std::string& record, double& proposedStep, double& previousError, double& previousStep);

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
    // The integrated states node by node, in node order and each node's in its order: the order an adaptive method sums its error
    // norm in, so every backend makes the same step-size decisions (docs/proposals/integrators.md, Determinism).
    std::vector<std::vector<std::size_t>> errorGroups;
    // Per state of the plan: whether the method integrates it. Every other state holds its value through the stages.
    std::vector<unsigned char> integrated;
    // The plan's indexes of the stepped nodes, in node order.
    std::vector<std::size_t> steppedNodes;
    // The programs held, in node order.
    std::vector<HeldTerm> heldTerms;
};

// `providers` says which programs are known to be pure (ProviderEvaluator::declaredPure); with none, no program is.
WholeModelPlan buildWholeModelPlan(const ExecutionPlan& plan, const ProviderEvaluator* providers);

// Under Rodas4, per state of the plan, the states its derivative reads at a stage (docs/proposals/integrators.md, Jacobians for
// Rodas4): from the model's graph, every state an equation into it uses, and every state a pure program into it binds (a pure node
// program: every state it binds, into each of its outputs). A held program and a stepped node are constants within the step and read
// none. The Jacobian's pattern is built from these, so it is known exactly before the run. A version 2 program whose output declares the
// inputs it depends on (docs/proposals/programSdkV2.md, Jacobians for Rodas4) reads only the states bound to those, when `providers` is
// given.
std::vector<std::vector<std::size_t>> stageReads(const ExecutionPlan& plan, const WholeModelPlan& whole, const ProviderEvaluator* providers = nullptr);
// Whether anything evaluated at stages may depend on the time within a step: an equation using the time or a parameter that follows a
// stored schedule, or a pure program (which is given the time). Rodas4 then works out df/dt; a recorded intervention active in a step
// is added by the caller.
bool stagesReadTime(const ExecutionPlan& plan, const WholeModelPlan& whole);

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
                                  std::vector<EvaluatedContribution>& held, ProviderEvaluator* providerEvaluator,
                                  const std::vector<double>* latches = nullptr);

}
