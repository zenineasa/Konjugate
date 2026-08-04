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

EntityId idValue(const boost::property_tree::ptree& tree, const std::string& key) {
    const auto text = tree.get<std::string>(key, "");
    std::size_t consumed = 0;
    const auto result = std::stoull(text, &consumed);
    if (!result || result > 9007199254740991ULL || consumed != text.size()) {
        throw std::runtime_error("Model ids must be positive safe integers.");
    }
    return result;
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
                                             EntityId outputNodeId,
                                             bool sourceTerm,
                                             const std::unordered_map<EntityId, std::size_t>& stateIndexes,
                                             const std::unordered_map<EntityId, std::size_t>& localStateIndexes) {
    std::vector<CompiledBinding> result;
    for (const auto& bindingItem : bindings) {
        const auto& binding = bindingItem.second;
        CompiledBinding compiled;
        compiled.symbol = value(binding, "symbol");
        if (value(binding, "kind") == "parameter") {
            compiled.source = BindingSource::parameter;
            compiled.valueId = idValue(binding, "parameterId");
        } else {
            compiled.valueId = idValue(binding, "stateId");
            compiled.source = sourceTerm || idValue(binding, "nodeId") == outputNodeId
                ? BindingSource::localState : BindingSource::synchronizationSnapshot;
            compiled.valueIndex = compiled.source == BindingSource::localState
                ? localStateIndexes.at(compiled.valueId) : stateIndexes.at(compiled.valueId);
        }
        result.push_back(std::move(compiled));
    }
    return result;
}

void bindExpressionSymbols(CompiledExpression& expression, const std::vector<CompiledBinding>& bindings) {
    if (expression.operation == ExpressionOperation::symbol) {
        const auto found = std::find_if(bindings.begin(), bindings.end(), [&](const auto& binding) {
            return binding.symbol == expression.symbol;
        });
        if (found == bindings.end()) throw std::runtime_error("Unknown executable symbol: " + expression.symbol + ".");
        expression.symbolIndex = static_cast<std::size_t>(std::distance(bindings.begin(), found));
    }
    for (auto& argument : expression.arguments) bindExpressionSymbols(argument, bindings);
}

void bindTask(ContributionTask& task) {
    for (auto& binding : task.bindings) {
        if (binding.source != BindingSource::parameter) continue;
        const auto found = std::find_if(task.parameters.begin(), task.parameters.end(), [&](const auto& parameter) {
            return parameter.id == binding.valueId;
        });
        if (found == task.parameters.end()) throw std::runtime_error("An executable parameter binding is unresolved.");
        binding.parameterIndex = static_cast<std::size_t>(std::distance(task.parameters.begin(), found));
    }
    bindExpressionSymbols(task.expression, task.bindings);
}

double requireArgument(const CompiledExpression& expression, std::size_t index, const std::vector<double>& symbols) {
    if (index >= expression.arguments.size()) throw std::runtime_error("Executable expression has too few arguments.");
    return expression.arguments[index].evaluate(symbols);
}

}

double CompiledExpression::evaluate(const std::vector<double>& symbols) const {
    const auto argument = [&](std::size_t index) { return requireArgument(*this, index, symbols); };
    switch (operation) {
        case ExpressionOperation::literal: return literal;
        case ExpressionOperation::symbol: {
            if (symbolIndex >= symbols.size()) throw std::runtime_error("Executable symbol binding is invalid.");
            return symbols[symbolIndex];
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
    std::unordered_map<EntityId, std::size_t> nodeIndexes;
    for (const auto& nodeItem : document.get_child("nodes")) {
        const auto& node = nodeItem.second;
        NodeExecutionPlan compiledNode;
        compiledNode.nodeId = idValue(node, "id");
        compiledNode.substeps = node.get<std::size_t>("numerics.substepsPerGlobalStep", 1);
        if (!compiledNode.substeps || compiledNode.substeps > 10000) {
            throw std::runtime_error("Node substepsPerGlobalStep must be an integer from 1 through 10000.");
        }
        for (const auto& stateItem : node.get_child("states")) {
            const auto stateId = idValue(stateItem.second, "id");
            compiledNode.stateIds.push_back(stateId);
            compiledNode.stateIndexes.push_back(plan.initialStates.size());
            plan.stateIndexes[stateId] = plan.initialStates.size();
            plan.initialStates.push_back(stateItem.second.get<double>("initialValue", 0));
            plan.stateNodes[stateId] = compiledNode.nodeId;
            plan.stateIds.push_back(stateId);
        }
        std::unordered_map<EntityId, std::size_t> localStateIndexes;
        for (std::size_t index = 0; index < compiledNode.stateIds.size(); ++index) {
            localStateIndexes[compiledNode.stateIds[index]] = index;
        }
        std::size_t sequence = 0;
        for (const auto& termItem : node.get_child("sourceTerms")) {
            const auto& term = termItem.second;
            ContributionTask task;
            task.sequence = sequence++;
            task.sourceId = idValue(term, "id");
            task.outputStateId = idValue(term, "expressionModel.output.stateId");
            task.outputStateIndex = localStateIndexes.at(task.outputStateId);
            task.bindings = compileBindings(term.get_child("expressionModel.bindings"), compiledNode.nodeId, true,
                plan.stateIndexes, localStateIndexes);
            task.expression = compileExpression(term.get_child("expressionModel.mathJson"));
            bindTask(task);
            compiledNode.estimatedOperationsPerSubstep += task.expression.operationCount();
            compiledNode.contributions.push_back(std::move(task));
        }
        nodeIndexes[compiledNode.nodeId] = plan.nodes.size();
        plan.nodes.push_back(std::move(compiledNode));
    }

    for (const auto& edgeItem : document.get_child("edges")) {
        const auto& edge = edgeItem.second;
        const auto outputStateId = idValue(edge, "equationModel.output.stateId");
        const auto outputNodeId = plan.stateNodes.at(outputStateId);
        auto& node = plan.nodes.at(nodeIndexes.at(outputNodeId));
        std::unordered_map<EntityId, std::size_t> localStateIndexes;
        for (std::size_t index = 0; index < node.stateIds.size(); ++index) localStateIndexes[node.stateIds[index]] = index;
        ContributionTask task;
        task.sequence = node.contributions.size();
        task.sourceId = idValue(edge, "id");
        task.outputStateId = outputStateId;
        task.outputStateIndex = localStateIndexes.at(outputStateId);
        task.bindings = compileBindings(edge.get_child("equationModel.bindings"), outputNodeId, false,
            plan.stateIndexes, localStateIndexes);
        for (const auto& parameterItem : edge.get_child("parameters")) {
            const auto& parameter = parameterItem.second;
            task.parameters.push_back({idValue(parameter, "id"), parameter.get<double>("value", 0), value(parameter, "mode") == "live"});
        }
        task.expression = compileExpression(edge.get_child("equationModel.mathJson"));
        bindTask(task);
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
    const NodeParameterValues& parameterValues) {
    std::vector<EvaluatedContribution> evaluated;
    evaluated.reserve(node.contributions.size());
    for (std::size_t taskIndex = 0; taskIndex < node.contributions.size(); ++taskIndex) {
        const auto& task = node.contributions[taskIndex];
        std::vector<double> symbols(task.bindings.size());
        for (std::size_t index = 0; index < task.bindings.size(); ++index) {
            const auto& binding = task.bindings[index];
            if (binding.source == BindingSource::parameter) {
                symbols[index] = parameterValues.at(taskIndex).at(binding.parameterIndex);
            } else if (binding.source == BindingSource::localState) symbols[index] = localStates.at(binding.valueIndex);
            else symbols[index] = synchronizationSnapshot.at(binding.valueIndex);
        }
        const auto contribution = task.expression.evaluate(symbols);
        if (!std::isfinite(contribution)) throw std::runtime_error("A contribution task produced a non-finite derivative.");
        evaluated.push_back({task.sequence, task.outputStateIndex, contribution});
    }
    return evaluated;
}

NodeParameterValues resolveParameterValues(const NodeExecutionPlan& node, const EntityValues& liveParameterValues) {
    NodeParameterValues resolved;
    resolved.reserve(node.contributions.size());
    for (const auto& task : node.contributions) {
        auto& values = resolved.emplace_back();
        values.reserve(task.parameters.size());
        for (const auto& parameter : task.parameters) {
            const auto override = liveParameterValues.find(parameter.id);
            values.push_back(parameter.live && override != liveParameterValues.end() ? override->second : parameter.value);
        }
    }
    return resolved;
}

std::vector<std::pair<std::size_t, double>> reduceContributions(
    std::vector<EvaluatedContribution> contributions) {
    std::stable_sort(contributions.begin(), contributions.end(), [](const auto& left, const auto& right) {
        return left.sequence < right.sequence;
    });
    std::vector<std::pair<std::size_t, double>> derivatives;
    for (const auto& contribution : contributions) {
        const auto found = std::find_if(derivatives.begin(), derivatives.end(), [&](const auto& derivative) {
            return derivative.first == contribution.outputStateIndex;
        });
        if (found == derivatives.end()) {
            derivatives.emplace_back(contribution.outputStateIndex, contribution.value);
        } else {
            found->second += contribution.value;
        }
    }
    return derivatives;
}

}
