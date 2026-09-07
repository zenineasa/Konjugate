/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <boost/property_tree/ptree.hpp>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <limits>
#include <span>
#include <stdexcept>
#include <unordered_map>
#include <utility>
#include <vector>

namespace konjugate {

using EntityId = std::uint64_t;
using EntityValues = std::unordered_map<EntityId, double>;
using StateValues = std::vector<double>;
using NodeParameterValues = std::vector<std::vector<double>>;

enum class ExpressionOperation {
    literal,
    symbol,
    add,
    multiply,
    negate,
    divide,
    power,
    squareRoot,
    absolute,
    exponential,
    logarithm,
    sine,
    cosine,
    tangent,
    minimum,
    maximum
};

struct CompiledExpression {
    ExpressionOperation operation = ExpressionOperation::literal;
    double literal = 0;
    std::string symbol;
    std::size_t symbolIndex = std::numeric_limits<std::size_t>::max();
    std::vector<CompiledExpression> arguments;

    double evaluate(const std::vector<double>& symbols) const;
    std::size_t operationCount() const noexcept;
};

enum class BindingSource { localState, synchronizationSnapshot, parameter };
enum class ContributionImplementation { equation, cppProvider, pythonProvider };

struct CompiledBinding {
    std::string symbol;
    BindingSource source = BindingSource::localState;
    EntityId valueId = 0;
    std::size_t valueIndex = std::numeric_limits<std::size_t>::max();
    std::size_t parameterIndex = std::numeric_limits<std::size_t>::max();
};

struct CompiledParameter {
    EntityId id = 0;
    double value = 0;
    bool live = false;
};

struct ContributionTask {
    std::size_t sequence = 0;
    EntityId sourceId = 0;
    EntityId outputStateId = 0;
    std::size_t outputStateIndex = std::numeric_limits<std::size_t>::max();
    std::vector<CompiledBinding> bindings;
    std::vector<CompiledParameter> parameters;
    CompiledExpression expression;
    ContributionImplementation implementation = ContributionImplementation::equation;
    std::string providerSource;
    std::string providerOutputKey;
    // Precomputed once by bindTask() at plan-compile time: providerProcessKey() used to
    // concatenate "cpp:"/"py:" with the entire inline source text on every single evaluation
    // call, which is invisible next to an IPC round trip but was measurable overhead in its
    // own right once nothing else dominates (e.g. the in-process transport). Empty for
    // equation tasks, which never call providerProcessKey().
    std::string providerProcessKeyCache;
    // True for the complementary contribution a bidirectional edge applies to its other
    // endpoint: the same computed value, sign-flipped, since what leaves one node enters the
    // other. False for every other contribution (source terms, directed edges, and a
    // bidirectional edge's own primary output).
    bool negateOutput = false;
};

// Contributions sharing the same (implementation, providerSource) run in the same worker
// process/library, so callers group tasks by this key before batching them into one
// evaluateBatch call rather than one round trip per contribution.
const std::string& providerProcessKey(const ContributionTask& task);

struct NodeProviderOutputBinding {
    std::string key;
    EntityId stateId = 0;
    std::size_t stateIndex = std::numeric_limits<std::size_t>::max();
    // Mirrors a source term's own setsValue (see NodeExecutionPlan::algebraicTasks and
    // docs/projectSchema.md's setsValue paragraph): by default an output's returned number is a
    // derivative, folded additively into its target state like any other contribution. When true,
    // the engine instead writes that same number directly into the target state every substep -- a
    // plain replacement, never integrated -- making it a genuine algebraic state rather than the
    // Euler-specific pseudo-derivative trick FMI import used before this field existed (see
    // src/fmiResolver.mjs). No SDK change: NodeOutputCollector::addGradient's value is reinterpreted
    // exactly like a source term's addGradient value is.
    bool setsValue = false;
};

// Owns ALL the dynamics of one node, unlike ContributionTask which owns one scalar derivative
// into one state: evaluated once per substep, returns N named outputs (one per declared output),
// each either folded additively into its own target state as a derivative, or -- when that
// output's binding has setsValue set -- written directly into its target state as a genuine
// algebraic value. A node has at most one of these. Python-only for now (see providerRuntime.cpp);
// implementation is retained (rather than assumed) so a future C++ node-provider slice only has
// to add a branch here, not a new field.
struct NodeProviderTask {
    EntityId nodeId = 0;
    ContributionImplementation implementation = ContributionImplementation::pythonProvider;
    std::string providerSource;
    std::string providerProcessKeyCache; // "py:" + providerSource, same scheme as ContributionTask
    std::vector<CompiledBinding> bindings;          // own-node states only, like a source term
    std::vector<NodeProviderOutputBinding> outputs; // N named outputs -> this node's own states
};

class ProviderEvaluator {
public:
    virtual ~ProviderEvaluator() = default;
    // Every task in a single call must share the same providerProcessKey(); the caller
    // (evaluateContributionTasks) is responsible for grouping them that way. Results are
    // returned in the same order as tasks/inputs.
    virtual std::vector<double> evaluateBatch(const std::vector<const ContributionTask*>& tasks,
                                              const std::vector<std::span<const double>>& inputs,
                                              double simulationTime,
                                              double stepSize) = 0;

    // Throwing defaults, not pure virtual: existing ProviderEvaluator doubles (tests, the
    // benchmark harness) that never exercise computational-node providers need not implement
    // these. A real caller only reaches them when a plan actually contains a NodeProviderTask.
    virtual std::vector<std::pair<std::string, double>> evaluateNode(
        const NodeProviderTask&, std::span<const double> inputs, double simulationTime, double stepSize) {
        static_cast<void>(inputs);
        static_cast<void>(simulationTime);
        static_cast<void>(stepSize);
        throw std::runtime_error("This provider evaluator does not support computational-node providers.");
    }
    virtual std::vector<std::byte> requestNodeCheckpoint(const NodeProviderTask&) {
        throw std::runtime_error("This provider evaluator does not support computational-node checkpointing.");
    }
    virtual void requestNodeRestore(const NodeProviderTask&, std::span<const std::byte>) {
        throw std::runtime_error("This provider evaluator does not support computational-node restore.");
    }
};

struct NodeExecutionPlan {
    EntityId nodeId = 0;
    std::size_t substeps = 1;
    std::vector<EntityId> stateIds;
    std::vector<std::size_t> stateIndexes;
    std::vector<ContributionTask> contributions;
    // Source terms authored as "sets the value" rather than "updates the derivative" -- a genuine
    // algebraic state (in the Differential-Algebraic-Equation sense), never integrated via any
    // solver's update rule. Stored in dependency-resolved order (an algebraic task may bind
    // another algebraic task's own output state, e.g. "y = 2x, z = y + 1" -- z's task follows y's
    // here) so applyAlgebraicTasks() can evaluate them once, in this order, before any ordinary
    // (differential) contribution in the same substep, with each write immediately visible to
    // whatever comes after it. Never contains edges (edges always contribute a derivative) --
    // see docs/projectSchema.md's `setsValue` paragraph and
    // docs/proposals/causalInferenceInputReplay.md for why this needs to be a genuinely
    // recomputed-fresh value rather than a solver-specific derivative trick.
    std::vector<ContributionTask> algebraicTasks;
    std::optional<NodeProviderTask> nodeProvider;
    std::size_t estimatedOperationsPerSubstep = 0;
};

struct ExecutionPlan {
    StateValues initialStates;
    std::unordered_map<EntityId, EntityId> stateNodes;
    std::unordered_map<EntityId, std::size_t> stateIndexes;
    std::vector<EntityId> stateIds;
    std::vector<NodeExecutionPlan> nodes;
    std::vector<std::size_t> taskSubmissionOrder;
};

struct EvaluatedContribution {
    std::size_t sequence = 0;
    std::size_t outputStateIndex = 0;
    double value = 0;
};

ExecutionPlan compileExecutionPlan(const boost::property_tree::ptree& document);

std::vector<std::size_t> planTaskSubmissionOrder(const std::vector<NodeExecutionPlan>& nodes);

// localStates is only ever read here -- but a nodeProvider output with setsValue needs to write its
// target state directly (see NodeProviderOutputBinding::setsValue), exactly like
// applyAlgebraicTasks does. Rather than taking localStates by mutable reference (which would force
// every caller, including every existing test, to supply a named lvalue instead of a plain
// brace-init StateValues), such a write is appended to algebraicNodeProviderWrites instead -- a
// caller-supplied out-parameter, nullptr by default -- as a (stateIndex, value) pair for the caller
// to apply once this call returns, exactly how integrateNode already applies the derivatives it
// gets back from reduceContributions. A setsValue nodeProvider output encountered with a null
// algebraicNodeProviderWrites throws rather than silently discarding the write.
std::vector<EvaluatedContribution> evaluateContributionTasks(
    const NodeExecutionPlan& node,
    const StateValues& localStates,
    const StateValues& synchronizationSnapshot,
    const NodeParameterValues& parameterValues,
    double simulationTime = 0,
    double stepSize = 0,
    ProviderEvaluator* providerEvaluator = nullptr,
    std::vector<std::pair<std::size_t, double>>* algebraicNodeProviderWrites = nullptr);

NodeParameterValues resolveParameterValues(const NodeExecutionPlan& node, const EntityValues& liveParameterValues);
// Shared by evaluateContributionTasks (indexed by position in node.contributions) and
// applyAlgebraicTasks (indexed by position in node.algebraicTasks) -- two structurally separate
// lists, so each needs its own resolved-values vector rather than sharing one keyed by a single
// shared index space.
NodeParameterValues resolveParameterValues(const std::vector<ContributionTask>& tasks, const EntityValues& liveParameterValues);

std::vector<std::pair<std::size_t, double>> reduceContributions(
    std::vector<EvaluatedContribution> contributions);

// A node's genuine algebraic states (see NodeExecutionPlan::algebraicTasks): recomputes each task
// in algebraicTasks, in the caller-supplied (already dependency-sorted) order, and writes the
// result directly into localStates.at(task.outputStateIndex) -- a plain replacement, never
// accumulated, never divided by stepSize. Because each write lands in the same localStates array
// every later algebraic task and every ordinary (differential) contribution in this same substep
// reads from, this composes with any solver: there is no derivative or stepSize-dependent
// arithmetic here at all, unlike the Euler-specific pseudo-derivative trick this replaces. Always
// intra-node (see compileExecutionPlan's dependency-ordering comment) -- takes no
// synchronizationSnapshot because a source term's bindings are never cross-node.
void applyAlgebraicTasks(const std::vector<ContributionTask>& algebraicTasks, StateValues& localStates,
                         const NodeParameterValues& parameterValues, double simulationTime, double stepSize,
                         ProviderEvaluator* providerEvaluator);

struct NodeIntegrationResult {
    StateValues states;
    std::uint64_t computeNanoseconds = 0;
};

// Owns one node's full substep loop for one global step: seeds localStates from the frozen
// synchronizationSnapshot, then per substep applies algebraic tasks (recomputed fresh, see above)
// before evaluating and Euler-integrating the node's ordinary differential contributions. Shared
// verbatim by the serial/thread-pool backend (simulationRunner.cpp) and the partitioned backend
// (partitionRuntime.cpp, which wraps this with its own node index) so the two can never silently
// diverge on this logic.
NodeIntegrationResult integrateNode(const NodeExecutionPlan& node,
                                    const StateValues& synchronizationSnapshot,
                                    const EntityValues& liveParameterValues,
                                    double simulationTime,
                                    double synchronizationStep,
                                    ProviderEvaluator* providerEvaluator = nullptr);

}
