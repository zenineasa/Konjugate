/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "executionPlan.hpp"
#include <algorithm>
#include <cmath>
#include <numeric>
#include <stdexcept>

namespace konjugate {
namespace {

std::string value(const boost::property_tree::ptree& tree, const std::string& key) {
    return tree.get<std::string>(key, "");
}

double finiteNumber(const std::string& input) {
    std::size_t consumed = 0;
    const auto result = std::stod(input, &consumed);
    if (consumed != input.size() || !std::isfinite(result)) throw std::runtime_error("Expression contains a non-finite number.");
    return result;
}

ExpressionOperation operationFromName(const std::string& name) {
    if (name == "Add") return ExpressionOperation::add;
    if (name == "Multiply") return ExpressionOperation::multiply;
    if (name == "Negate") return ExpressionOperation::negate;
    if (name == "Divide") return ExpressionOperation::divide;
    if (name == "Power") return ExpressionOperation::power;
    if (name == "Sqrt") return ExpressionOperation::squareRoot;
    if (name == "Abs") return ExpressionOperation::absolute;
    if (name == "Exp") return ExpressionOperation::exponential;
    if (name == "Ln" || name == "Log") return ExpressionOperation::logarithm;
    if (name == "Sin") return ExpressionOperation::sine;
    if (name == "Cos") return ExpressionOperation::cosine;
    if (name == "Tan") return ExpressionOperation::tangent;
    if (name == "Min") return ExpressionOperation::minimum;
    if (name == "Max") return ExpressionOperation::maximum;
    throw std::runtime_error("Unsupported executable operation: " + name + ".");
}

CompiledExpression compileExpression(const boost::property_tree::ptree& tree) {
    if (tree.empty()) {
        CompiledExpression expression;
        try {
            expression.operation = ExpressionOperation::literal;
            expression.literal = finiteNumber(tree.data());
        } catch (...) {
            expression.operation = ExpressionOperation::symbol;
            expression.symbol = tree.data();
        }
        return expression;
    }
    auto item = tree.begin();
    if (item == tree.end()) throw std::runtime_error("Expression array is empty.");
    CompiledExpression expression;
    expression.operation = operationFromName(item->second.data());
    for (++item; item != tree.end(); ++item) expression.arguments.push_back(compileExpression(item->second));
    return expression;
}

std::vector<CompiledBinding> compileBindings(const boost::property_tree::ptree& bindings,
                                             const std::string& outputNodeId,
                                             bool sourceTerm) {
    std::vector<CompiledBinding> result;
    for (const auto& bindingItem : bindings) {
        const auto& binding = bindingItem.second;
        CompiledBinding compiled;
        compiled.symbol = value(binding, "symbol");
        if (value(binding, "kind") == "parameter") {
            compiled.source = BindingSource::parameter;
            compiled.valueId = value(binding, "parameterId");
        } else {
            compiled.valueId = value(binding, "stateId");
            compiled.source = sourceTerm || value(binding, "nodeId") == outputNodeId
                ? BindingSource::localState : BindingSource::synchronizationSnapshot;
        }
        result.push_back(std::move(compiled));
    }
    return result;
}

double requireArgument(const CompiledExpression& expression, std::size_t index, const StateValues& symbols) {
    if (index >= expression.arguments.size()) throw std::runtime_error("Executable expression has too few arguments.");
    return expression.arguments[index].evaluate(symbols);
}

}

double CompiledExpression::evaluate(const StateValues& symbols) const {
    const auto argument = [&](std::size_t index) { return requireArgument(*this, index, symbols); };
    switch (operation) {
        case ExpressionOperation::literal: return literal;
        case ExpressionOperation::symbol: {
            const auto found = symbols.find(symbol);
            if (found == symbols.end()) throw std::runtime_error("Unknown executable symbol: " + symbol + ".");
            return found->second;
        }
        case ExpressionOperation::add: {
            double result = 0;
            for (const auto& item : arguments) result += item.evaluate(symbols);
            return result;
        }
        case ExpressionOperation::multiply: {
            double result = 1;
            for (const auto& item : arguments) result *= item.evaluate(symbols);
            return result;
        }
        case ExpressionOperation::negate: return -argument(0);
        case ExpressionOperation::divide: return argument(0) / argument(1);
        case ExpressionOperation::power: return std::pow(argument(0), argument(1));
        case ExpressionOperation::squareRoot: return std::sqrt(argument(0));
        case ExpressionOperation::absolute: return std::abs(argument(0));
        case ExpressionOperation::exponential: return std::exp(argument(0));
        case ExpressionOperation::logarithm: return std::log(argument(0));
        case ExpressionOperation::sine: return std::sin(argument(0));
        case ExpressionOperation::cosine: return std::cos(argument(0));
        case ExpressionOperation::tangent: return std::tan(argument(0));
        case ExpressionOperation::minimum: return std::min(argument(0), argument(1));
        case ExpressionOperation::maximum: return std::max(argument(0), argument(1));
    }
    throw std::runtime_error("Executable expression operation is invalid.");
}

std::size_t CompiledExpression::operationCount() const noexcept {
    std::size_t count = 1;
    for (const auto& argument : arguments) count += argument.operationCount();
    return count;
}

ExecutionPlan compileExecutionPlan(const boost::property_tree::ptree& document) {
    ExecutionPlan plan;
    std::unordered_map<std::string, std::size_t> nodeIndexes;
    for (const auto& nodeItem : document.get_child("nodes")) {
        const auto& node = nodeItem.second;
        NodeExecutionPlan compiledNode;
        compiledNode.nodeId = value(node, "id");
        compiledNode.substeps = node.get<std::size_t>("numerics.substepsPerGlobalStep", 1);
        if (!compiledNode.substeps || compiledNode.substeps > 10000) {
            throw std::runtime_error("Node substepsPerGlobalStep must be an integer from 1 through 10000.");
        }
        for (const auto& stateItem : node.get_child("states")) {
            const auto stateId = value(stateItem.second, "id");
            compiledNode.stateIds.push_back(stateId);
            plan.initialStates[stateId] = stateItem.second.get<double>("initialValue", 0);
            plan.stateNodes[stateId] = compiledNode.nodeId;
            plan.stateIds.push_back(stateId);
        }
        std::size_t sequence = 0;
        for (const auto& termItem : node.get_child("sourceTerms")) {
            const auto& term = termItem.second;
            ContributionTask task;
            task.sequence = sequence++;
            task.sourceId = value(term, "id");
            task.outputStateId = value(term, "expressionModel.output.stateId");
            task.bindings = compileBindings(term.get_child("expressionModel.bindings"), compiledNode.nodeId, true);
            task.expression = compileExpression(term.get_child("expressionModel.mathJson"));
            compiledNode.estimatedOperationsPerSubstep += task.expression.operationCount();
            compiledNode.contributions.push_back(std::move(task));
        }
        nodeIndexes[compiledNode.nodeId] = plan.nodes.size();
        plan.nodes.push_back(std::move(compiledNode));
    }

    for (const auto& edgeItem : document.get_child("edges")) {
        const auto& edge = edgeItem.second;
        const auto outputStateId = value(edge, "equationModel.output.stateId");
        const auto outputNodeId = plan.stateNodes.at(outputStateId);
        auto& node = plan.nodes.at(nodeIndexes.at(outputNodeId));
        ContributionTask task;
        task.sequence = node.contributions.size();
        task.sourceId = value(edge, "id");
        task.outputStateId = outputStateId;
        task.bindings = compileBindings(edge.get_child("equationModel.bindings"), outputNodeId, false);
        for (const auto& parameterItem : edge.get_child("parameters")) {
            const auto& parameter = parameterItem.second;
            task.parameters.push_back({value(parameter, "id"), parameter.get<double>("value", 0), value(parameter, "mode") == "live"});
        }
        task.expression = compileExpression(edge.get_child("equationModel.mathJson"));
        node.estimatedOperationsPerSubstep += task.expression.operationCount();
        node.contributions.push_back(std::move(task));
    }
    std::sort(plan.stateIds.begin(), plan.stateIds.end());
    plan.taskSubmissionOrder = planTaskSubmissionOrder(plan.nodes);
    return plan;
}

std::vector<std::size_t> planTaskSubmissionOrder(const std::vector<NodeExecutionPlan>& nodes) {
    std::vector<std::size_t> order(nodes.size());
    std::iota(order.begin(), order.end(), 0);
    std::stable_sort(order.begin(), order.end(), [&nodes](std::size_t left, std::size_t right) {
        const auto leftWork = nodes[left].estimatedOperationsPerSubstep * nodes[left].substeps;
        const auto rightWork = nodes[right].estimatedOperationsPerSubstep * nodes[right].substeps;
        return leftWork > rightWork;
    });
    return order;
}

std::vector<EvaluatedContribution> evaluateContributionTasks(
    const NodeExecutionPlan& node,
    const StateValues& localStates,
    const StateValues& synchronizationSnapshot,
    const StateValues& liveParameterValues) {
    std::vector<EvaluatedContribution> evaluated;
    evaluated.reserve(node.contributions.size());
    for (const auto& task : node.contributions) {
        StateValues parameters;
        for (const auto& parameter : task.parameters) {
            const auto override = liveParameterValues.find(parameter.id);
            parameters[parameter.id] = parameter.live && override != liveParameterValues.end() ? override->second : parameter.value;
        }
        StateValues symbols;
        for (const auto& binding : task.bindings) {
            if (binding.source == BindingSource::parameter) symbols[binding.symbol] = parameters.at(binding.valueId);
            else if (binding.source == BindingSource::localState) symbols[binding.symbol] = localStates.at(binding.valueId);
            else symbols[binding.symbol] = synchronizationSnapshot.at(binding.valueId);
        }
        const auto contribution = task.expression.evaluate(symbols);
        if (!std::isfinite(contribution)) throw std::runtime_error("A contribution task produced a non-finite derivative.");
        evaluated.push_back({task.sequence, task.outputStateId, contribution});
    }
    return evaluated;
}

std::vector<std::pair<std::string, double>> reduceContributions(
    std::vector<EvaluatedContribution> contributions) {
    std::stable_sort(contributions.begin(), contributions.end(), [](const auto& left, const auto& right) {
        return left.sequence < right.sequence;
    });
    std::vector<std::pair<std::string, double>> derivatives;
    std::unordered_map<std::string, std::size_t> derivativeIndexes;
    for (const auto& contribution : contributions) {
        const auto found = derivativeIndexes.find(contribution.outputStateId);
        if (found == derivativeIndexes.end()) {
            derivativeIndexes[contribution.outputStateId] = derivatives.size();
            derivatives.emplace_back(contribution.outputStateId, contribution.value);
        } else {
            derivatives[found->second].second += contribution.value;
        }
    }
    return derivatives;
}

}
