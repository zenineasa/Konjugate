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
};

// Owns ALL the dynamics of one node, unlike ContributionTask which owns one scalar derivative
// into one state: evaluated once per substep, returns N named derivative contributions (one per
// declared output), each folded additively into its own target state exactly like an ordinary
// contribution. A node has at most one of these. Python-only for now (see providerRuntime.cpp);
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

std::vector<EvaluatedContribution> evaluateContributionTasks(
    const NodeExecutionPlan& node,
    const StateValues& localStates,
    const StateValues& synchronizationSnapshot,
    const NodeParameterValues& parameterValues,
    double simulationTime = 0,
    double stepSize = 0,
    ProviderEvaluator* providerEvaluator = nullptr);

NodeParameterValues resolveParameterValues(const NodeExecutionPlan& node, const EntityValues& liveParameterValues);

std::vector<std::pair<std::size_t, double>> reduceContributions(
    std::vector<EvaluatedContribution> contributions);

}
