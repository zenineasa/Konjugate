/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <boost/property_tree/ptree.hpp>
#include <cstddef>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace konjugate {

using StateValues = std::unordered_map<std::string, double>;

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
    std::vector<CompiledExpression> arguments;

    double evaluate(const StateValues& symbols) const;
    std::size_t operationCount() const noexcept;
};

enum class BindingSource { localState, synchronizationSnapshot, parameter };

struct CompiledBinding {
    std::string symbol;
    BindingSource source = BindingSource::localState;
    std::string valueId;
};

struct CompiledParameter {
    std::string id;
    double value = 0;
    bool live = false;
};

struct ContributionTask {
    std::size_t sequence = 0;
    std::string sourceId;
    std::string outputStateId;
    std::vector<CompiledBinding> bindings;
    std::vector<CompiledParameter> parameters;
    CompiledExpression expression;
};

struct NodeExecutionPlan {
    std::string nodeId;
    std::size_t substeps = 1;
    std::vector<std::string> stateIds;
    std::vector<ContributionTask> contributions;
    std::size_t estimatedOperationsPerSubstep = 0;
};

struct ExecutionPlan {
    StateValues initialStates;
    std::unordered_map<std::string, std::string> stateNodes;
    std::vector<std::string> stateIds;
    std::vector<NodeExecutionPlan> nodes;
    std::vector<std::size_t> taskSubmissionOrder;
};

struct EvaluatedContribution {
    std::size_t sequence = 0;
    std::string outputStateId;
    double value = 0;
};

ExecutionPlan compileExecutionPlan(const boost::property_tree::ptree& document);

std::vector<std::size_t> planTaskSubmissionOrder(const std::vector<NodeExecutionPlan>& nodes);

std::vector<EvaluatedContribution> evaluateContributionTasks(
    const NodeExecutionPlan& node,
    const StateValues& localStates,
    const StateValues& synchronizationSnapshot,
    const StateValues& liveParameterValues);

std::vector<std::pair<std::string, double>> reduceContributions(
    std::vector<EvaluatedContribution> contributions);

}
