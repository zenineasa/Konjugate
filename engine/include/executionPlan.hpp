/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <boost/property_tree/ptree.hpp>
#include <cstddef>
#include <cstdint>
#include <string>
#include <limits>
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
    // True for the complementary contribution a bidirectional edge applies to its other
    // endpoint: the same computed value, sign-flipped, since what leaves one node enters the
    // other. False for every other contribution (source terms, directed edges, and a
    // bidirectional edge's own primary output).
    bool negateOutput = false;
};

class ProviderEvaluator {
public:
    virtual ~ProviderEvaluator() = default;
    virtual double evaluate(const ContributionTask& task,
                            const std::vector<double>& inputs,
                            double simulationTime,
                            double stepSize) = 0;
};

struct NodeExecutionPlan {
    EntityId nodeId = 0;
    std::size_t substeps = 1;
    std::vector<EntityId> stateIds;
    std::vector<std::size_t> stateIndexes;
    std::vector<ContributionTask> contributions;
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
