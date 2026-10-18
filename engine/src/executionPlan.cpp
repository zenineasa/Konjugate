/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "executionPlan.hpp"
#include <algorithm>
#include <set>
#include <chrono>
#include <cmath>
#include <functional>
#include <numeric>
#include <span>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

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
    if (name == "Arcsin") return ExpressionOperation::arcsine;
    if (name == "Arccos") return ExpressionOperation::arccosine;
    if (name == "Arctan") return ExpressionOperation::arctangent;
    if (name == "Arctan2") return ExpressionOperation::arctangent2;
    if (name == "Tanh") return ExpressionOperation::hyperbolicTangent;
    if (name == "Min") return ExpressionOperation::minimum;
    if (name == "Max") return ExpressionOperation::maximum;
    if (name == "Which") return ExpressionOperation::conditional;
    if (name == "Less") return ExpressionOperation::less;
    if (name == "LessEqual") return ExpressionOperation::lessEqual;
    if (name == "Greater") return ExpressionOperation::greater;
    if (name == "GreaterEqual") return ExpressionOperation::greaterEqual;
    if (name == "Equal") return ExpressionOperation::equal;
    if (name == "NotEqual") return ExpressionOperation::notEqual;
    if (name == "And") return ExpressionOperation::logicalAnd;
    if (name == "Or") return ExpressionOperation::logicalOr;
    if (name == "Not") return ExpressionOperation::logicalNot;
    throw std::runtime_error("Unsupported executable operation: " + name + ".");
}

CompiledExpression compileExpression(const boost::property_tree::ptree& tree) {
    if (tree.empty()) {
        CompiledExpression expression;
        // "True"/"False" appear as bare symbols in MathJSON -- "True" is the otherwise branch of
        // a cases expression.
        if (tree.data() == "True" || tree.data() == "False") {
            expression.operation = ExpressionOperation::literal;
            expression.literal = tree.data() == "True" ? 1.0 : 0.0;
            return expression;
        }
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
                                             const std::unordered_map<EntityId, std::size_t>& localStateIndexes,
                                             const std::string& identifierField = "symbol") {
    std::vector<CompiledBinding> result;
    for (const auto& bindingItem : bindings) {
        const auto& binding = bindingItem.second;
        CompiledBinding compiled;
        compiled.symbol = value(binding, identifierField);
        if (value(binding, "kind") == "parameter") {
            compiled.source = BindingSource::parameter;
            compiled.valueId = idValue(binding, "parameterId");
        } else if (value(binding, "kind") == "time") {
            compiled.source = BindingSource::simulationTime;
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

// Project-level shared parameters (top-level "sharedParameters"), keyed by id. A relationship or
// source-term parameter carrying `sharedParameterId` takes its value and live/constant mode from
// the shared definition, and is controlled by the shared id, so one edit or one live control
// value drives every linked parameter. The linked parameter's own value and mode are left in the
// file only so an unlinked copy would still make sense; they are ignored here.
using SharedParameters = std::unordered_map<EntityId, const boost::property_tree::ptree*>;

SharedParameters collectSharedParameters(const boost::property_tree::ptree& document) {
    SharedParameters shared;
    if (const auto entries = document.get_child_optional("sharedParameters")) {
        for (const auto& entry : *entries) shared.emplace(idValue(entry.second, "id"), &entry.second);
    }
    return shared;
}

// A shared parameter's stored schedule ("schedule": { "interpolation": "linear" | "hold",
// "samples": [[time, value], ...] }), or null when it has none. Samples must be finite with strictly
// increasing times; modelValidator.cpp reports the same rules as validation errors.
std::shared_ptr<const ParameterSchedule> compileStoredSchedule(const boost::property_tree::ptree& definition) {
    const auto stored = definition.get_child_optional("schedule");
    if (!stored) return nullptr;
    auto schedule = std::make_shared<ParameterSchedule>();
    schedule->parameterId = idValue(definition, "id");
    schedule->mode = ParameterSchedule::Mode::piecewise;
    // Stored schedules govern from the very beginning, beneath every recorded intervention.
    schedule->startTime = -std::numeric_limits<double>::infinity();
    const auto interpolation = stored->get<std::string>("interpolation", "linear");
    if (interpolation != "linear" && interpolation != "hold") throw std::runtime_error("A parameter schedule's interpolation must be linear or hold.");
    schedule->hold = interpolation == "hold";
    if (const auto samples = stored->get_child_optional("samples")) {
        for (const auto& sampleItem : *samples) {
            std::vector<double> pair;
            for (const auto& component : sampleItem.second) pair.push_back(component.second.get_value<double>());
            if (pair.size() != 2 || !std::isfinite(pair[0]) || !std::isfinite(pair[1])) {
                throw std::runtime_error("A parameter schedule sample must be a pair of finite numbers [time, value].");
            }
            if (!schedule->samples.empty() && !(pair[0] > schedule->samples.back().first)) {
                throw std::runtime_error("A parameter schedule's sample times must be strictly increasing.");
            }
            schedule->samples.emplace_back(pair[0], pair[1]);
        }
    }
    if (schedule->samples.empty()) throw std::runtime_error("A parameter schedule needs at least one sample.");
    return schedule;
}

CompiledParameter compileParameter(const boost::property_tree::ptree& parameter, const SharedParameters& shared,
                                   std::unordered_map<EntityId, std::shared_ptr<const ParameterSchedule>>& schedules) {
    const auto id = idValue(parameter, "id");
    if (parameter.get_child_optional("sharedParameterId")) {
        const auto sharedId = idValue(parameter, "sharedParameterId");
        const auto found = shared.find(sharedId);
        if (found == shared.end()) throw std::runtime_error("A parameter links to a shared parameter that does not exist.");
        const auto& definition = *found->second;
        auto cached = schedules.find(sharedId);
        if (cached == schedules.end()) cached = schedules.emplace(sharedId, compileStoredSchedule(definition)).first;
        CompiledParameter compiled{id, definition.get<double>("value", 0), value(definition, "mode") == "live", sharedId};
        compiled.schedule = cached->second;
        return compiled;
    }
    return {id, parameter.get<double>("value", 0), value(parameter, "mode") == "live", id};
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

// Binds an expression's symbols against a table of names (an algebraic relationship's bindings, then
// its definitions), allowing only the first `visible` of them.
void bindExpressionNames(CompiledExpression& expression, const std::vector<std::string>& names, std::size_t visible) {
    if (expression.operation == ExpressionOperation::symbol) {
        const auto found = std::find(names.begin(), names.begin() + static_cast<std::ptrdiff_t>(visible), expression.symbol);
        if (found == names.begin() + static_cast<std::ptrdiff_t>(visible)) throw std::runtime_error("Unknown executable symbol: " + expression.symbol + ".");
        expression.symbolIndex = static_cast<std::size_t>(std::distance(names.begin(), found));
    }
    for (auto& argument : expression.arguments) bindExpressionNames(argument, names, visible);
}

void collectSymbolIndexes(const CompiledExpression& expression, std::set<std::size_t>& indexes) {
    if (expression.operation == ExpressionOperation::symbol) indexes.insert(expression.symbolIndex);
    for (const auto& argument : expression.arguments) collectSymbolIndexes(argument, indexes);
}

bool expressionReadsSymbol(const CompiledExpression& expression, std::size_t symbolIndex) {
    if (expression.operation == ExpressionOperation::symbol && expression.symbolIndex == symbolIndex) return true;
    return std::any_of(expression.arguments.begin(), expression.arguments.end(), [&](const auto& argument) {
        return expressionReadsSymbol(argument, symbolIndex);
    });
}

// The local states a task reads: every one a provider binds, but only those an equation uses (the
// node editor binds all of a node's states to each source term, used or not).
std::vector<EntityId> localStatesRead(const ContributionTask& task) {
    std::vector<EntityId> stateIds;
    for (std::size_t index = 0; index < task.bindings.size(); ++index) {
        const auto& binding = task.bindings[index];
        if (binding.source != BindingSource::localState) continue;
        if (task.implementation == ContributionImplementation::equation && !expressionReadsSymbol(task.expression, index)) continue;
        stateIds.push_back(binding.valueId);
    }
    return stateIds;
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
    if (task.implementation == ContributionImplementation::equation) bindExpressionSymbols(task.expression, task.bindings);
    else task.providerProcessKeyCache = (task.implementation == ContributionImplementation::pythonProvider ? "py:" : "cpp:") + task.providerSource;
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
        case ExpressionOperation::arcsine: return std::asin(argument(0));
        case ExpressionOperation::arccosine: return std::acos(argument(0));
        case ExpressionOperation::arctangent: return std::atan(argument(0));
        case ExpressionOperation::arctangent2: return std::atan2(argument(0), argument(1));
        case ExpressionOperation::hyperbolicTangent: return std::tanh(argument(0));
        case ExpressionOperation::minimum: return std::min(argument(0), argument(1));
        case ExpressionOperation::maximum: return std::max(argument(0), argument(1));
        case ExpressionOperation::conditional: {
            // (condition, value) pairs, first true condition wins; only the chosen value is
            // evaluated. The validator requires a final "True" (otherwise) branch.
            for (std::size_t index = 0; index + 1 < arguments.size(); index += 2) {
                if (arguments[index].evaluate(symbols) != 0.0) return arguments[index + 1].evaluate(symbols);
            }
            throw std::runtime_error("No branch of a cases expression matched.");
        }
        case ExpressionOperation::less:
        case ExpressionOperation::lessEqual:
        case ExpressionOperation::greater:
        case ExpressionOperation::greaterEqual:
        case ExpressionOperation::equal:
        case ExpressionOperation::notEqual: {
            // Chained, as MathJSON writes 0 < x < 1: every adjacent pair must hold.
            if (arguments.size() < 2) throw std::runtime_error("Executable expression has too few arguments.");
            double left = arguments[0].evaluate(symbols);
            for (std::size_t index = 1; index < arguments.size(); ++index) {
                const double right = arguments[index].evaluate(symbols);
                bool holds = false;
                switch (operation) {
                    case ExpressionOperation::less: holds = left < right; break;
                    case ExpressionOperation::lessEqual: holds = left <= right; break;
                    case ExpressionOperation::greater: holds = left > right; break;
                    case ExpressionOperation::greaterEqual: holds = left >= right; break;
                    case ExpressionOperation::equal: holds = left == right; break;
                    default: holds = left != right; break;
                }
                if (!holds) return 0.0;
                left = right;
            }
            return 1.0;
        }
        case ExpressionOperation::logicalAnd: {
            for (const auto& item : arguments) if (item.evaluate(symbols) == 0.0) return 0.0;
            return 1.0;
        }
        case ExpressionOperation::logicalOr: {
            for (const auto& item : arguments) if (item.evaluate(symbols) != 0.0) return 1.0;
            return 0.0;
        }
        case ExpressionOperation::logicalNot: return argument(0) == 0.0 ? 1.0 : 0.0;
    }
    throw std::runtime_error("Executable expression operation is invalid.");
}

std::size_t CompiledExpression::operationCount() const noexcept {
    std::size_t count = 1;
    for (const auto& argument : arguments) count += argument.operationCount();
    return count;
}

namespace {

void compileAlgebraicRelationship(ExecutionPlan& plan, const boost::property_tree::ptree& edge, const boost::property_tree::ptree& outputs,
                                  const SharedParameters& sharedParameters,
                                  std::unordered_map<EntityId, std::shared_ptr<const ParameterSchedule>>& storedSchedules) {
    if (value(edge, "directionality") == "bidirectional") throw std::runtime_error("A relationship with several equations is directed.");
    if (!value(edge, "implementation.kind").empty() && value(edge, "implementation.kind") != "equation") {
        throw std::runtime_error("A relationship with several equations is written as equations.");
    }
    AlgebraicRelationship relationship;
    relationship.edgeId = idValue(edge, "id");
    const std::unordered_map<EntityId, std::size_t> noLocalStates;
    if (const auto bindings = edge.get_child_optional("equationModel.bindings")) {
        // No node is the output's own: every state is read from the plan's whole state vector.
        relationship.bindings = compileBindings(*bindings, 0, false, plan.stateIndexes, noLocalStates);
    }
    if (const auto parameters = edge.get_child_optional("parameters")) {
        for (const auto& parameterItem : *parameters) relationship.parameters.push_back(compileParameter(parameterItem.second, sharedParameters, storedSchedules));
    }
    for (auto& binding : relationship.bindings) {
        if (binding.source != BindingSource::parameter) continue;
        const auto found = std::find_if(relationship.parameters.begin(), relationship.parameters.end(), [&](const auto& parameter) { return parameter.id == binding.valueId; });
        if (found == relationship.parameters.end()) throw std::runtime_error("An executable parameter binding is unresolved.");
        binding.parameterIndex = static_cast<std::size_t>(std::distance(relationship.parameters.begin(), found));
    }
    std::vector<std::string> names;
    for (const auto& binding : relationship.bindings) names.push_back(binding.symbol);
    if (const auto definitions = edge.get_child_optional("equationModel.definitions")) {
        for (const auto& definitionItem : *definitions) {
            auto expression = compileExpression(definitionItem.second.get_child("mathJson"));
            // A definition reads the bindings and the definitions before it.
            bindExpressionNames(expression, names, names.size());
            names.push_back(value(definitionItem.second, "symbol"));
            relationship.definitions.push_back(std::move(expression));
        }
    }
    const auto bindingCount = relationship.bindings.size();
    // The definitions each definition needs, directly or through others.
    std::vector<std::set<std::size_t>> needs(relationship.definitions.size());
    for (std::size_t index = 0; index < relationship.definitions.size(); ++index) {
        std::set<std::size_t> symbols;
        collectSymbolIndexes(relationship.definitions[index], symbols);
        for (const auto symbol : symbols) {
            if (symbol < bindingCount) continue;
            const auto definition = symbol - bindingCount;
            needs[index].insert(definition);
            needs[index].insert(needs[definition].begin(), needs[definition].end());
        }
    }
    const auto relationshipIndex = plan.algebraicRelationships.size();
    const auto sourceNodeId = idValue(edge, "source.nodeId");
    const auto targetNodeId = idValue(edge, "target.nodeId");
    for (const auto& outputItem : outputs) {
        const auto& output = outputItem.second;
        if (value(output, "setsValue") != "true") throw std::runtime_error("Each equation of a relationship with several equations sets its state's value.");
        AlgebraicOutput compiled;
        compiled.relationship = relationshipIndex;
        compiled.outputStateId = idValue(output, "stateId");
        const auto node = value(output, "role") == "source" ? sourceNodeId : targetNodeId;
        const auto found = plan.stateIndexes.find(compiled.outputStateId);
        if (found == plan.stateIndexes.end() || plan.stateNodes.at(compiled.outputStateId) != node) {
            throw std::runtime_error("A relationship's equation sets a state that is not its endpoint's.");
        }
        compiled.outputStateIndex = found->second;
        compiled.expression = compileExpression(output.get_child("mathJson"));
        bindExpressionNames(compiled.expression, names, names.size());
        std::set<std::size_t> symbols;
        collectSymbolIndexes(compiled.expression, symbols);
        std::set<std::size_t> definitions;
        for (const auto symbol : symbols) {
            if (symbol < bindingCount) continue;
            definitions.insert(symbol - bindingCount);
            definitions.insert(needs[symbol - bindingCount].begin(), needs[symbol - bindingCount].end());
        }
        compiled.definitions.assign(definitions.begin(), definitions.end());
        plan.algebraicOutputs.push_back(std::move(compiled));
    }
    plan.algebraicRelationships.push_back(std::move(relationship));
}

// The states an algebraic output reads: those its equation and the definitions it needs use.
std::vector<std::size_t> algebraicOutputReads(const ExecutionPlan& plan, const AlgebraicOutput& output) {
    const auto& relationship = plan.algebraicRelationships[output.relationship];
    std::set<std::size_t> symbols;
    collectSymbolIndexes(output.expression, symbols);
    for (const auto definition : output.definitions) collectSymbolIndexes(relationship.definitions[definition], symbols);
    std::vector<std::size_t> reads;
    for (const auto symbol : symbols) {
        if (symbol >= relationship.bindings.size()) continue;
        const auto& binding = relationship.bindings[symbol];
        if (binding.source == BindingSource::synchronizationSnapshot || binding.source == BindingSource::localState) reads.push_back(binding.valueIndex);
    }
    return reads;
}

// Orders the outputs so every output writing a state comes before any output reading it. A cycle
// has no defined solution at an instant, and is refused.
void orderAlgebraicOutputs(ExecutionPlan& plan) {
    if (plan.algebraicOutputs.empty()) return;
    std::unordered_map<std::size_t, std::vector<std::size_t>> writers;
    for (std::size_t index = 0; index < plan.algebraicOutputs.size(); ++index) writers[plan.algebraicOutputs[index].outputStateIndex].push_back(index);
    const auto count = plan.algebraicOutputs.size();
    std::vector<std::vector<std::size_t>> after(count);
    std::vector<std::size_t> waiting(count, 0);
    for (std::size_t index = 0; index < count; ++index) {
        std::set<std::size_t> dependencies;
        for (const auto read : algebraicOutputReads(plan, plan.algebraicOutputs[index])) {
            const auto found = writers.find(read);
            if (found != writers.end()) dependencies.insert(found->second.begin(), found->second.end());
        }
        for (const auto dependency : dependencies) {
            after[dependency].push_back(index);
            ++waiting[index];
        }
    }
    std::vector<std::size_t> ready;
    for (std::size_t index = count; index-- > 0;) if (!waiting[index]) ready.push_back(index);
    std::vector<AlgebraicOutput> ordered;
    ordered.reserve(count);
    while (!ready.empty()) {
        const auto index = ready.back();
        ready.pop_back();
        ordered.push_back(plan.algebraicOutputs[index]);
        for (auto next = after[index].rbegin(); next != after[index].rend(); ++next) if (!--waiting[*next]) ready.push_back(*next);
    }
    if (ordered.size() != count) throw std::runtime_error("Relationships that set states' values form a loop, which has no defined solution.");
    plan.algebraicOutputs = std::move(ordered);
    std::set<std::size_t> states;
    for (const auto& output : plan.algebraicOutputs) states.insert(output.outputStateIndex);
    plan.algebraicStateIndexes.assign(states.begin(), states.end());
}

}

ExecutionPlan compileExecutionPlan(const boost::property_tree::ptree& document) {
    const auto sharedParameters = collectSharedParameters(document);
    std::unordered_map<EntityId, std::shared_ptr<const ParameterSchedule>> storedSchedules;
    ExecutionPlan plan;
    std::unordered_map<EntityId, std::size_t> nodeIndexes;
    // A disabled node contributes no state and no contribution tasks -- exactly as if it, and
    // every edge touching it, had been deleted from the model. Tracked so the edge loop below
    // can skip edges into a disabled node too, since their endpoint's state was never allocated.
    std::unordered_set<EntityId> disabledNodeIds;
    for (const auto& nodeItem : document.get_child("nodes")) {
        const auto& node = nodeItem.second;
        if (value(node, "enabled") == "false") {
            disabledNodeIds.insert(idValue(node, "id"));
            continue;
        }
        NodeExecutionPlan compiledNode;
        compiledNode.nodeId = idValue(node, "id");
        compiledNode.substeps = node.get<std::size_t>("numerics.substepsPerGlobalStep", 1);
        const auto integration = node.get<std::string>("numerics.integration", "explicit");
        if (integration != "explicit" && integration != "semiImplicit") throw std::runtime_error("A node's numerics.integration must be explicit or semiImplicit.");
        compiledNode.semiImplicit = integration == "semiImplicit";
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
        std::vector<ContributionTask> algebraicCandidates;
        for (const auto& termItem : node.get_child("sourceTerms")) {
            const auto& term = termItem.second;
            const auto termImplementationKind = value(term, "implementation.kind");
            const auto termProgrammable = termImplementationKind == "cpp" || termImplementationKind == "python";
            const bool termSetsValue = value(term, "setsValue") == "true";
            ContributionTask task;
            task.sequence = sequence++;
            task.sourceId = idValue(term, "id");
            task.outputStateId = idValue(term, termProgrammable ? "implementation.output.stateId" : "expressionModel.output.stateId");
            task.outputStateIndex = localStateIndexes.at(task.outputStateId);
            task.bindings = compileBindings(term.get_child(termProgrammable ? "implementation.bindings" : "expressionModel.bindings"),
                compiledNode.nodeId, true, plan.stateIndexes, localStateIndexes, termProgrammable ? "key" : "symbol");
            if (const auto parameters = term.get_child_optional("parameters")) for (const auto& parameterItem : *parameters) {
                const auto& parameter = parameterItem.second;
                task.parameters.push_back(compileParameter(parameter, sharedParameters, storedSchedules));
            }
            if (termProgrammable) {
                task.implementation = termImplementationKind == "cpp"
                    ? ContributionImplementation::cppProvider : ContributionImplementation::pythonProvider;
                task.providerSource = value(term, "implementation.source");
                task.providerOutputKey = value(term, "implementation.output.key");
            } else {
                task.expression = compileExpression(term.get_child("expressionModel.mathJson"));
            }
            bindTask(task);
            compiledNode.estimatedOperationsPerSubstep += termProgrammable ? task.bindings.size() + 1 : task.expression.operationCount();
            if (termSetsValue) algebraicCandidates.push_back(std::move(task));
            else compiledNode.contributions.push_back(std::move(task));
        }
        // Algebraic ("sets the value") source terms are recomputed fresh every substep, never
        // integrated -- see NodeExecutionPlan::algebraicTasks. One may itself bind another
        // algebraic task's own output state (e.g. "y = 2x, z = y + 1"), so they must be stored in
        // dependency order for applyAlgebraicTasks() to evaluate correctly in one pass. Binding
        // one's own output state is rejected outright (not just left for the generic cycle
        // check below) -- that would readmit exactly the hidden-recurrence, solver-specific
        // feedback this mechanism exists to eliminate, not a legitimate algebraic dependency.
        if (!algebraicCandidates.empty()) {
            std::unordered_map<EntityId, std::size_t> algebraicIndexByStateId;
            for (std::size_t index = 0; index < algebraicCandidates.size(); ++index) {
                algebraicIndexByStateId[algebraicCandidates[index].outputStateId] = index;
            }
            std::vector<std::vector<EntityId>> statesRead;
            for (const auto& task : algebraicCandidates) {
                statesRead.push_back(localStatesRead(task));
                if (std::find(statesRead.back().begin(), statesRead.back().end(), task.outputStateId) != statesRead.back().end()) {
                    throw std::runtime_error(
                        "A source term that sets its value directly may not reference its own state.");
                }
            }
            std::vector<int> visitState(algebraicCandidates.size(), 0); // 0=unvisited, 1=visiting, 2=done
            std::vector<std::size_t> algebraicOrder;
            algebraicOrder.reserve(algebraicCandidates.size());
            std::function<void(std::size_t)> visit = [&](std::size_t index) {
                if (visitState[index] == 2) return;
                if (visitState[index] == 1) {
                    throw std::runtime_error(
                        "Two or more source terms that set their value directly form a dependency cycle, which has no defined solution.");
                }
                visitState[index] = 1;
                for (const auto stateId : statesRead[index]) {
                    const auto found = algebraicIndexByStateId.find(stateId);
                    if (found != algebraicIndexByStateId.end()) visit(found->second);
                }
                visitState[index] = 2;
                algebraicOrder.push_back(index);
            };
            for (std::size_t index = 0; index < algebraicCandidates.size(); ++index) visit(index);
            compiledNode.algebraicTasks.reserve(algebraicOrder.size());
            for (const auto index : algebraicOrder) compiledNode.algebraicTasks.push_back(std::move(algebraicCandidates[index]));
        }
        if (const auto implementation = node.get_child_optional("implementation")) {
            const auto kind = value(*implementation, "kind");
            if (kind != "python" && kind != "cpp") {
                throw std::runtime_error("A computational-node provider implementation kind must be python or cpp.");
            }
            NodeProviderTask providerTask;
            providerTask.implementation = kind == "cpp"
                ? ContributionImplementation::cppProvider : ContributionImplementation::pythonProvider;
            providerTask.nodeId = compiledNode.nodeId;
            providerTask.providerSource = value(*implementation, "source");
            // A binding to one of this node's own states reads it as it advances, like a source term;
            // one to another node's state reads it from the step's synchronization snapshot, like an
            // edge does. That other node's states may not be indexed yet (nodes compile in document
            // order), so its index is resolved once every node is compiled, below.
            if (const auto bindingsNode = implementation->get_child_optional("bindings")) {
                for (const auto& bindingItem : *bindingsNode) {
                    const auto& binding = bindingItem.second;
                    CompiledBinding compiled;
                    compiled.symbol = value(binding, "key");
                    if (value(binding, "kind") == "parameter") {
                        // A shared parameter, compiled as a parameter linked to it is, so its
                        // schedule and live control apply; one entry however many bindings read it.
                        if (!binding.get_child_optional("sharedParameterId")) {
                            throw std::runtime_error("A computational-node provider binds only shared parameters, by sharedParameterId.");
                        }
                        compiled.source = BindingSource::parameter;
                        compiled.valueId = idValue(binding, "sharedParameterId");
                        auto existing = std::find_if(providerTask.parameters.begin(), providerTask.parameters.end(),
                            [&](const auto& parameter) { return parameter.controlId == compiled.valueId; });
                        if (existing == providerTask.parameters.end()) {
                            boost::property_tree::ptree link;
                            link.put("id", compiled.valueId);
                            link.put("sharedParameterId", compiled.valueId);
                            providerTask.parameters.push_back(compileParameter(link, sharedParameters, storedSchedules));
                            existing = std::prev(providerTask.parameters.end());
                        }
                        compiled.parameterIndex = static_cast<std::size_t>(std::distance(providerTask.parameters.begin(), existing));
                    } else if (value(binding, "kind") == "time") {
                        compiled.source = BindingSource::simulationTime;
                    } else {
                        compiled.valueId = idValue(binding, "stateId");
                        const auto local = localStateIndexes.find(compiled.valueId);
                        compiled.source = local != localStateIndexes.end() ? BindingSource::localState : BindingSource::synchronizationSnapshot;
                        if (local != localStateIndexes.end()) compiled.valueIndex = local->second;
                    }
                    providerTask.bindings.push_back(std::move(compiled));
                }
            }
            for (const auto& outputItem : implementation->get_child("outputs")) {
                const auto& outputEntry = outputItem.second;
                NodeProviderOutputBinding output;
                output.key = value(outputEntry, "key");
                output.stateId = idValue(outputEntry, "stateId");
                output.stateIndex = localStateIndexes.at(output.stateId);
                output.setsValue = value(outputEntry, "setsValue") == "true";
                providerTask.outputs.push_back(std::move(output));
            }
            // Same reasoning, and same defensive necessity (main.cpp's run command compiles
            // without validating), as the algebraic-source-term self-reference throw above: a
            // setsValue output reading its own target state back through one of this provider's
            // own (shared, not per-output) bindings would make it a hidden, substep-count-dependent
            // recurrence rather than a genuine algebraic value.
            for (const auto& output : providerTask.outputs) {
                if (!output.setsValue) continue;
                for (const auto& binding : providerTask.bindings) {
                    if (binding.source == BindingSource::localState && binding.valueId == output.stateId) {
                        throw std::runtime_error(
                            "A computational-node-provider output that sets its state's value directly may not also be one of that provider's own input bindings.");
                    }
                }
            }
            providerTask.providerProcessKeyCache = (kind == "cpp" ? "cpp:" : "py:") + providerTask.providerSource;
            compiledNode.estimatedOperationsPerSubstep += providerTask.bindings.size() + providerTask.outputs.size() + 1;
            compiledNode.nodeProvider = std::move(providerTask);
        }
        nodeIndexes[compiledNode.nodeId] = plan.nodes.size();
        plan.nodes.push_back(std::move(compiledNode));
    }

    for (auto& compiledNode : plan.nodes) {
        if (!compiledNode.nodeProvider) continue;
        for (auto& binding : compiledNode.nodeProvider->bindings) {
            if (binding.source != BindingSource::synchronizationSnapshot) continue;
            const auto found = plan.stateIndexes.find(binding.valueId);
            if (found == plan.stateIndexes.end()) {
                throw std::runtime_error("A computational-node provider binding references a state of a missing or disabled node.");
            }
            binding.valueIndex = found->second;
        }
    }

    for (const auto& edgeItem : document.get_child("edges")) {
        const auto& edge = edgeItem.second;
        // Same rule as a disabled node: skip a disabled edge, or one whose endpoint is disabled
        // (that endpoint's state was never allocated above, so its output/binding lookups below
        // would otherwise throw).
        if (value(edge, "enabled") == "false" ||
            disabledNodeIds.contains(idValue(edge, "source.nodeId")) ||
            disabledNodeIds.contains(idValue(edge, "target.nodeId"))) {
            continue;
        }
        const auto implementationKind = value(edge, "implementation.kind");
        // An algebraic relationship (equationModel.outputs): compiled apart from the nodes' tasks, as it
        // is evaluated for the whole plan at each synchronization instant.
        if (const auto outputs = edge.get_child_optional("equationModel.outputs")) {
            compileAlgebraicRelationship(plan, edge, *outputs, sharedParameters, storedSchedules);
            continue;
        }
        const auto programmable = implementationKind == "cpp" || implementationKind == "python";
        const auto outputRole = value(edge, programmable ? "implementation.output.role" : "equationModel.output.role");
        const auto outputStateId = idValue(edge, programmable ? "implementation.output.stateId" : "equationModel.output.stateId");
        const auto outputNodeId = plan.stateNodes.at(outputStateId);

        auto buildContribution = [&](EntityId contributionNodeId, EntityId contributionStateId, bool negate) {
            auto& contributionNode = plan.nodes.at(nodeIndexes.at(contributionNodeId));
            std::unordered_map<EntityId, std::size_t> localStateIndexes;
            for (std::size_t index = 0; index < contributionNode.stateIds.size(); ++index) {
                localStateIndexes[contributionNode.stateIds[index]] = index;
            }
            ContributionTask task;
            task.sequence = contributionNode.contributions.size();
            task.sourceId = idValue(edge, "id");
            task.outputStateId = contributionStateId;
            task.outputStateIndex = localStateIndexes.at(contributionStateId);
            task.negateOutput = negate;
            task.bindings = compileBindings(edge.get_child(programmable ? "implementation.bindings" : "equationModel.bindings"),
                contributionNodeId, false, plan.stateIndexes, localStateIndexes, programmable ? "key" : "symbol");
            for (const auto& parameterItem : edge.get_child("parameters")) {
                const auto& parameter = parameterItem.second;
                task.parameters.push_back(compileParameter(parameter, sharedParameters, storedSchedules));
            }
            if (programmable) {
                task.implementation = implementationKind == "cpp"
                    ? ContributionImplementation::cppProvider : ContributionImplementation::pythonProvider;
                task.providerSource = value(edge, "implementation.source");
                task.providerOutputKey = value(edge, "implementation.output.key");
            } else {
                task.expression = compileExpression(edge.get_child("equationModel.mathJson"));
            }
            bindTask(task);
            contributionNode.estimatedOperationsPerSubstep += programmable ? task.bindings.size() + 1 : task.expression.operationCount();
            contributionNode.contributions.push_back(std::move(task));
        };

        buildContribution(outputNodeId, outputStateId, false);

        if (value(edge, "directionality") == "bidirectional") {
            // A bidirectional edge applies the same computed value to both connected nodes, with
            // the sign flipped for the other side -- what leaves one enters the other. The other
            // side's state is the edge's own source/target stateId when the model provides one
            // (see src/renderer/renderer.mjs's edge creation, which defaults it to the endpoint
            // node's first state); otherwise fall back to that node's first state directly, so an
            // older saved edge without one still resolves sensibly.
            const auto otherNodeId = outputRole == "target" ? idValue(edge, "source.nodeId") : idValue(edge, "target.nodeId");
            const auto otherStateField = outputRole == "target" ? "source.stateId" : "target.stateId";
            const auto otherStateText = value(edge, otherStateField);
            const auto& otherNode = plan.nodes.at(nodeIndexes.at(otherNodeId));
            if (otherNode.stateIds.empty()) {
                throw std::runtime_error("A bidirectional relationship's other endpoint has no states.");
            }
            EntityId otherStateId = otherNode.stateIds.front();
            if (!otherStateText.empty()) {
                std::size_t consumed = 0;
                const auto parsed = std::stoull(otherStateText, &consumed);
                if (parsed && consumed == otherStateText.size() &&
                    std::find(otherNode.stateIds.begin(), otherNode.stateIds.end(), parsed) != otherNode.stateIds.end()) {
                    otherStateId = parsed;
                }
            }
            buildContribution(otherNodeId, otherStateId, true);
        }
    }
    orderAlgebraicOutputs(plan);
    std::sort(plan.stateIds.begin(), plan.stateIds.end());
    plan.taskSubmissionOrder = planTaskSubmissionOrder(plan.nodes);
    const auto scheduled = [](const std::vector<ContributionTask>& tasks) {
        return std::any_of(tasks.begin(), tasks.end(), [](const auto& task) {
            return std::any_of(task.parameters.begin(), task.parameters.end(), [](const auto& parameter) { return parameter.schedule != nullptr; });
        });
    };
    for (auto& node : plan.nodes) {
        node.hasParameterSchedules = scheduled(node.contributions) || scheduled(node.algebraicTasks) || (node.nodeProvider &&
            std::any_of(node.nodeProvider->parameters.begin(), node.nodeProvider->parameters.end(), [](const auto& parameter) { return parameter.schedule != nullptr; }));
    }
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

const std::string& providerProcessKey(const ContributionTask& task) {
    return task.providerProcessKeyCache;
}

namespace {

double finalizeContribution(const ContributionTask& task, double contribution) {
    if (task.negateOutput) contribution = -contribution;
    if (!std::isfinite(contribution)) throw std::runtime_error("A contribution task produced a non-finite derivative.");
    return contribution;
}

}

std::vector<EvaluatedContribution> evaluateContributionTasks(
    const NodeExecutionPlan& node,
    const StateValues& localStates,
    const StateValues& synchronizationSnapshot,
    const NodeParameterValues& parameterValues,
    double simulationTime,
    double stepSize,
    ProviderEvaluator* providerEvaluator,
    std::vector<std::pair<std::size_t, double>>* algebraicNodeProviderWrites,
    const std::vector<double>* nodeProviderParameterValues) {
    std::vector<EvaluatedContribution> evaluated;
    evaluated.reserve(node.contributions.size());

    // Provider tasks are collected by process key rather than evaluated immediately, so every
    // instance of a shared provider in this node can go out in a single evaluateBatch call
    // instead of one round trip per contribution. A real node typically has only a handful of
    // provider tasks (often exactly one), so this groups by a linear scan over key pointers
    // rather than an unordered_map: providerProcessKey() returns a reference into each task's
    // own precomputed cache, so grouping this way never hashes or copies that (potentially
    // long, since it is derived from the provider's whole inline source) string at all.
    std::vector<std::pair<const std::string*, std::vector<std::size_t>>> providerGroups;
    std::vector<std::vector<double>> symbolsByTask(node.contributions.size());

    for (std::size_t taskIndex = 0; taskIndex < node.contributions.size(); ++taskIndex) {
        const auto& task = node.contributions[taskIndex];
        auto& symbols = symbolsByTask[taskIndex];
        symbols.resize(task.bindings.size());
        for (std::size_t index = 0; index < task.bindings.size(); ++index) {
            const auto& binding = task.bindings[index];
            if (binding.source == BindingSource::parameter) {
                symbols[index] = parameterValues.at(taskIndex).at(binding.parameterIndex);
            } else if (binding.source == BindingSource::localState) symbols[index] = localStates.at(binding.valueIndex);
            else if (binding.source == BindingSource::simulationTime) symbols[index] = simulationTime;
            else symbols[index] = synchronizationSnapshot.at(binding.valueIndex);
        }

        if (task.implementation == ContributionImplementation::equation) {
            const auto contribution = finalizeContribution(task, task.expression.evaluate(symbols));
            evaluated.push_back({task.sequence, task.outputStateIndex, contribution});
        } else {
            const auto& key = providerProcessKey(task);
            const auto found = std::find_if(providerGroups.begin(), providerGroups.end(),
                [&](const auto& group) { return *group.first == key; });
            if (found != providerGroups.end()) found->second.push_back(taskIndex);
            else providerGroups.emplace_back(&key, std::vector<std::size_t>{taskIndex});
        }
    }

    for (const auto& [key, taskIndexes] : providerGroups) {
        if (!providerEvaluator) throw std::runtime_error("A programmable relationship requires an initialized provider runtime.");

        std::vector<const ContributionTask*> tasks;
        std::vector<std::span<const double>> inputs;
        tasks.reserve(taskIndexes.size());
        inputs.reserve(taskIndexes.size());
        for (const auto taskIndex : taskIndexes) {
            tasks.push_back(&node.contributions[taskIndex]);
            inputs.emplace_back(symbolsByTask[taskIndex]);
        }

        const auto results = providerEvaluator->evaluateBatch(tasks, inputs, simulationTime, stepSize);
        if (results.size() != tasks.size()) {
            throw std::runtime_error("A provider batch evaluation returned the wrong number of results.");
        }
        for (std::size_t index = 0; index < tasks.size(); ++index) {
            const auto& task = *tasks[index];
            const auto contribution = finalizeContribution(task, results[index]);
            evaluated.push_back({task.sequence, task.outputStateIndex, contribution});
        }
    }

    if (node.nodeProvider) {
        const auto& task = *node.nodeProvider;
        std::vector<double> inputs(task.bindings.size());
        for (std::size_t index = 0; index < task.bindings.size(); ++index) {
            const auto& binding = task.bindings[index];
            if (binding.source == BindingSource::parameter) {
                if (!nodeProviderParameterValues) throw std::runtime_error("A computational-node provider's parameter was evaluated without its values.");
                inputs[index] = nodeProviderParameterValues->at(binding.parameterIndex);
            } else if (binding.source == BindingSource::simulationTime) {
                inputs[index] = simulationTime;
            } else {
                inputs[index] = binding.source == BindingSource::localState
                    ? localStates.at(binding.valueIndex) : synchronizationSnapshot.at(binding.valueIndex);
            }
        }
        if (!providerEvaluator) throw std::runtime_error("A computational-node provider requires an initialized provider runtime.");
        const auto outputs = providerEvaluator->evaluateNode(task, inputs, simulationTime, stepSize);
        for (const auto& [outputKey, outputValue] : outputs) {
            const auto found = std::find_if(task.outputs.begin(), task.outputs.end(),
                [&](const auto& output) { return output.key == outputKey; });
            if (found == task.outputs.end()) {
                throw std::runtime_error("A computational-node provider returned an undeclared output key '" + outputKey + "'.");
            }
            if (!std::isfinite(outputValue)) throw std::runtime_error("A computational-node provider produced a non-finite value.");
            if (found->setsValue) {
                // A plain replacement, exactly like applyAlgebraicTasks -- see
                // NodeProviderOutputBinding::setsValue and this function's declaration comment.
                if (!algebraicNodeProviderWrites) {
                    throw std::runtime_error("A setsValue computational-node-provider output requires the caller to accept algebraic writes.");
                }
                algebraicNodeProviderWrites->emplace_back(found->stateIndex, outputValue);
            } else {
                const auto sequence = node.contributions.size() + static_cast<std::size_t>(std::distance(task.outputs.begin(), found));
                evaluated.push_back({sequence, found->stateIndex, outputValue});
            }
        }
    }

    return evaluated;
}

double evaluateParameterSchedule(const ParameterSchedule& schedule, double simulationTime) {
    switch (schedule.mode) {
    case ParameterSchedule::Mode::step:
        return schedule.targetValue;
    case ParameterSchedule::Mode::ramp: {
        const auto elapsed = simulationTime - schedule.startTime;
        if (schedule.duration <= 0 || elapsed >= schedule.duration) return schedule.targetValue;
        if (elapsed <= 0) return schedule.baseValue;
        const auto fraction = elapsed / schedule.duration;
        return schedule.baseValue + fraction * (schedule.targetValue - schedule.baseValue);
    }
    case ParameterSchedule::Mode::pulse: {
        const auto elapsed = simulationTime - schedule.startTime;
        return (elapsed >= 0 && elapsed < schedule.duration) ? schedule.targetValue : schedule.baseValue;
    }
    case ParameterSchedule::Mode::piecewise: {
        if (schedule.samples.empty()) return schedule.baseValue;
        if (simulationTime <= schedule.samples.front().first) return schedule.samples.front().second;
        if (simulationTime >= schedule.samples.back().first) return schedule.samples.back().second;
        // The first sample later than simulationTime (a binary search: a stored schedule may hold a
        // year of daily samples, resolved every substep). Its predecessor is at or before it.
        const auto upper = std::upper_bound(schedule.samples.begin(), schedule.samples.end(), simulationTime,
            [](double time, const auto& sample) { return time < sample.first; });
        const auto [lowerTime, lowerValue] = *(upper - 1);
        if (schedule.hold) return lowerValue;
        const auto [upperTime, upperValue] = *upper;
        const auto fraction = upperTime > lowerTime ? (simulationTime - lowerTime) / (upperTime - lowerTime) : 0.0;
        return lowerValue + fraction * (upperValue - lowerValue);
    }
    }
    return schedule.targetValue;
}

namespace {
// controlId defaults to 0 for a CompiledParameter built directly (tests, tools) rather than through
// compileParameter; those are controlled by their own id.
EntityId controlIdOf(const CompiledParameter& parameter) { return parameter.controlId ? parameter.controlId : parameter.id; }

// Among every schedule recorded for this parameter, the one whose startTime is the latest that
// has already arrived governs -- a later intervention layered onto an earlier one takes over the
// instant it begins, matching how a real operator's most recent decision supersedes an earlier
// one already in effect. Falls through to the flat live-override map, then the compiled constant,
// exactly as before schedules existed, when no schedule for this parameter has started yet.
double resolveParameterValue(const CompiledParameter& parameter, const EntityValues& liveParameterValues,
                              const std::vector<ParameterSchedule>& activeSchedules, double simulationTime) {
    // A stored schedule replaces the constant: the parameter's own value at this time.
    const double ownValue = parameter.schedule ? evaluateParameterSchedule(*parameter.schedule, simulationTime) : parameter.value;
    if (!parameter.live) return ownValue;
    const ParameterSchedule* active = nullptr;
    for (const auto& schedule : activeSchedules) {
        if (schedule.parameterId != controlIdOf(parameter) || schedule.startTime > simulationTime) continue;
        if (!active || schedule.startTime > active->startTime) active = &schedule;
    }
    if (active) return evaluateParameterSchedule(*active, simulationTime);
    const auto override = liveParameterValues.find(controlIdOf(parameter));
    return override != liveParameterValues.end() ? override->second : ownValue;
}
}

NodeParameterValues resolveParameterValues(const std::vector<ContributionTask>& tasks, const EntityValues& liveParameterValues,
                                            const std::vector<ParameterSchedule>& activeSchedules, double simulationTime) {
    NodeParameterValues resolved;
    resolved.reserve(tasks.size());
    for (const auto& task : tasks) {
        auto& values = resolved.emplace_back();
        values.reserve(task.parameters.size());
        for (const auto& parameter : task.parameters) {
            values.push_back(resolveParameterValue(parameter, liveParameterValues, activeSchedules, simulationTime));
        }
    }
    return resolved;
}

std::vector<double> resolveNodeProviderParameterValues(const NodeProviderTask& task, const EntityValues& liveParameterValues,
                                                       const std::vector<ParameterSchedule>& activeSchedules, double simulationTime) {
    std::vector<double> values;
    values.reserve(task.parameters.size());
    for (const auto& parameter : task.parameters) values.push_back(resolveParameterValue(parameter, liveParameterValues, activeSchedules, simulationTime));
    return values;
}

NodeParameterValues resolveParameterValues(const NodeExecutionPlan& node, const EntityValues& liveParameterValues,
                                            const std::vector<ParameterSchedule>& activeSchedules, double simulationTime) {
    return resolveParameterValues(node.contributions, liveParameterValues, activeSchedules, simulationTime);
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

void applyAlgebraicTasks(const std::vector<ContributionTask>& algebraicTasks, StateValues& localStates,
                         const NodeParameterValues& parameterValues, double evaluationTime, double stepSize,
                         ProviderEvaluator* providerEvaluator) {
    for (std::size_t taskIndex = 0; taskIndex < algebraicTasks.size(); ++taskIndex) {
        const auto& task = algebraicTasks[taskIndex];
        std::vector<double> symbols(task.bindings.size());
        for (std::size_t index = 0; index < task.bindings.size(); ++index) {
            const auto& binding = task.bindings[index];
            if (binding.source == BindingSource::parameter) {
                symbols[index] = parameterValues.at(taskIndex).at(binding.parameterIndex);
            } else if (binding.source == BindingSource::localState) {
                symbols[index] = localStates.at(binding.valueIndex);
            } else if (binding.source == BindingSource::simulationTime) {
                symbols[index] = evaluationTime;
            } else {
                // Structurally unreachable: compileBindings() forces every source term's
                // bindings to BindingSource::localState unconditionally (an algebraic task is
                // always a source term), so this should never fire. Fail loudly rather than
                // silently reading a stale cross-node snapshot if that invariant is ever broken.
                throw std::runtime_error("An algebraic task unexpectedly referenced the cross-node synchronization snapshot.");
            }
        }

        double value = 0;
        if (task.implementation == ContributionImplementation::equation) {
            value = task.expression.evaluate(symbols);
        } else {
            if (!providerEvaluator) throw std::runtime_error("A programmable algebraic source term requires an initialized provider runtime.");
            const std::vector<const ContributionTask*> batchTasks{&task};
            const std::vector<std::span<const double>> inputs{symbols};
            // The provider sees the same instant as the states it reads (see the declaration).
            const auto results = providerEvaluator->evaluateBatch(batchTasks, inputs, evaluationTime, stepSize);
            if (results.size() != 1) throw std::runtime_error("A provider batch evaluation returned the wrong number of results.");
            value = results.front();
        }
        if (!std::isfinite(value)) throw std::runtime_error("An algebraic source term produced a non-finite value.");
        // A plain replacement, never accumulated and never divided by anything -- this is the
        // whole point: an algebraic state is recomputed fresh, not integrated, so it composes
        // with any solver (see NodeExecutionPlan::algebraicTasks and this function's declaration
        // comment in executionPlan.hpp).
        localStates.at(task.outputStateIndex) = value;
    }
}

void settleAlgebraicStates(const ExecutionPlan& plan, StateValues& states, const EntityValues& liveParameterValues,
                           double time, double stepSize, ProviderEvaluator* providerEvaluator,
                           const std::vector<ParameterSchedule>& activeSchedules) {
    for (const auto& node : plan.nodes) {
        if (node.algebraicTasks.empty()) continue;
        StateValues localStates(node.stateIndexes.size());
        for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) localStates[index] = states.at(node.stateIndexes[index]);
        const auto parameterValues = resolveParameterValues(node.algebraicTasks, liveParameterValues, activeSchedules, time);
        applyAlgebraicTasks(node.algebraicTasks, localStates, parameterValues, time, stepSize / static_cast<double>(node.substeps), providerEvaluator);
        for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) states.at(node.stateIndexes[index]) = localStates[index];
    }
}

NodeIntegrationResult integrateNode(const NodeExecutionPlan& node,
                                    const StateValues& synchronizationSnapshot,
                                    const EntityValues& liveParameterValues,
                                    double simulationTime,
                                    double synchronizationStep,
                                    ProviderEvaluator* providerEvaluator,
                                    const std::vector<ParameterSchedule>& activeSchedules) {
    const auto startedAt = std::chrono::steady_clock::now();
    StateValues localStates(node.stateIndexes.size());
    for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) {
        localStates[index] = synchronizationSnapshot.at(node.stateIndexes[index]);
    }
    const auto nodeTimeStep = synchronizationStep / static_cast<double>(node.substeps);
    // Re-resolving every substep only matters for a ramp/pulse mid-transition (ordinary live
    // overrides and step schedules are already constant across one global step, same as before
    // schedules existed) -- gated on activeSchedules being non-empty so a node with no pending
    // intervention pays zero extra allocation cost even at node.substeps in the hundreds/thousands
    // (multi-rate models like HFT order routing per docs/proposals/fintechToolbox.md).
    const auto hasSchedules = !activeSchedules.empty() || node.hasParameterSchedules;
    auto parameterValues = resolveParameterValues(node.contributions, liveParameterValues, activeSchedules, simulationTime);
    auto algebraicParameterValues = resolveParameterValues(node.algebraicTasks, liveParameterValues, activeSchedules, simulationTime);
    // Semi-implicit: the node's contributions, one group per state it updates, in the node's order.
    std::vector<NodeExecutionPlan> semiImplicitTasks;
    if (node.semiImplicit) {
        if (node.nodeProvider) throw std::runtime_error("A node with a computational-node provider is integrated explicitly.");
        semiImplicitTasks.resize(node.stateIndexes.size());
        for (const auto& task : node.contributions) semiImplicitTasks.at(task.outputStateIndex).contributions.push_back(task);
    }
    for (std::size_t substep = 0; substep < node.substeps; ++substep) {
        const double substepTime = simulationTime + static_cast<double>(substep) * nodeTimeStep;
        if (hasSchedules && substep > 0) {
            parameterValues = resolveParameterValues(node.contributions, liveParameterValues, activeSchedules, substepTime);
            algebraicParameterValues = resolveParameterValues(node.algebraicTasks, liveParameterValues, activeSchedules, substepTime);
        }
        // Algebraic states are recomputed first, in their precomputed dependency order, from the
        // states at the start of this substep and at its start time, so a later algebraic task and
        // every ordinary (differential) contribution evaluated next read g(x_k, t_k) -- the same
        // instant explicit Euler evaluates everything else at.
        applyAlgebraicTasks(node.algebraicTasks, localStates, algebraicParameterValues, substepTime, nodeTimeStep, providerEvaluator);
        std::vector<std::pair<std::size_t, double>> algebraicNodeProviderWrites;
        // The provider's parameters at this substep's start, as its other inputs are read then.
        const auto providerParameterValues = node.nodeProvider && !node.nodeProvider->parameters.empty()
            ? resolveNodeProviderParameterValues(*node.nodeProvider, liveParameterValues, activeSchedules, substepTime) : std::vector<double>{};
        if (node.semiImplicit) {
            // Each state in the node's order, from contributions evaluated with the states updated before it.
            for (std::size_t stateIndex = 0; stateIndex < node.stateIndexes.size(); ++stateIndex) {
                const auto& stateTasks = semiImplicitTasks[stateIndex];
                if (stateTasks.contributions.empty()) continue;
                const auto stateParameters = resolveParameterValues(stateTasks.contributions, liveParameterValues, activeSchedules, substepTime);
                const auto stateEvaluated = evaluateContributionTasks(stateTasks, localStates, synchronizationSnapshot, stateParameters, substepTime, nodeTimeStep, providerEvaluator);
                for (const auto& derivative : reduceContributions(stateEvaluated)) localStates.at(derivative.first) += nodeTimeStep * derivative.second;
            }
            continue;
        }
        const auto evaluated = evaluateContributionTasks(
            node, localStates, synchronizationSnapshot, parameterValues,
            substepTime, nodeTimeStep, providerEvaluator, &algebraicNodeProviderWrites, &providerParameterValues);
        // Same plain-replacement treatment as applyAlgebraicTasks, applied here rather than inside
        // evaluateContributionTasks itself -- see that function's declaration comment. Order versus
        // the Euler integration below never matters: a setsValue nodeProvider output's state index
        // can never also appear in `derivatives` (validated as its state's sole contributor), so the
        // two loops always touch disjoint state indices.
        for (const auto& [stateIndex, algebraicValue] : algebraicNodeProviderWrites) localStates.at(stateIndex) = algebraicValue;
        const auto derivatives = reduceContributions(evaluated);
        for (const auto& derivative : derivatives) localStates.at(derivative.first) += nodeTimeStep * derivative.second;
    }
    // And once more after the last update, so the node hands back g(x_{k+1}, t_{k+1}) beside x_{k+1}.
    // Other nodes read this through the next step's synchronization snapshot; without it they would
    // read a value computed from the states one step earlier, and a bidirectional edge reading it
    // would add one amount at this end and subtract another at the other.
    if (!node.algebraicTasks.empty()) {
        const auto endTime = simulationTime + synchronizationStep;
        if (hasSchedules) algebraicParameterValues = resolveParameterValues(node.algebraicTasks, liveParameterValues, activeSchedules, endTime);
        applyAlgebraicTasks(node.algebraicTasks, localStates, algebraicParameterValues, endTime, nodeTimeStep, providerEvaluator);
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - startedAt).count();
    return {std::move(localStates), static_cast<std::uint64_t>(std::max<std::int64_t>(0, elapsed))};
}

void evaluateAlgebraicRelationships(const ExecutionPlan& plan, StateValues& states, const EntityValues& liveParameterValues,
                                    const std::vector<ParameterSchedule>& activeSchedules, double simulationTime) {
    if (plan.algebraicOutputs.empty()) return;
    for (const auto index : plan.algebraicStateIndexes) states.at(index) = 0;
    // Each relationship's parameters, resolved once for this instant.
    std::vector<std::vector<double>> parameterValues(plan.algebraicRelationships.size());
    std::vector<bool> resolved(plan.algebraicRelationships.size(), false);
    std::vector<double> symbols;
    for (const auto& output : plan.algebraicOutputs) {
        const auto& relationship = plan.algebraicRelationships[output.relationship];
        if (!resolved[output.relationship]) {
            auto& values = parameterValues[output.relationship];
            for (const auto& parameter : relationship.parameters) values.push_back(resolveParameterValue(parameter, liveParameterValues, activeSchedules, simulationTime));
            resolved[output.relationship] = true;
        }
        const auto& values = parameterValues[output.relationship];
        symbols.assign(relationship.bindings.size() + relationship.definitions.size(), 0.0);
        for (std::size_t index = 0; index < relationship.bindings.size(); ++index) {
            const auto& binding = relationship.bindings[index];
            if (binding.source == BindingSource::parameter) symbols[index] = values.at(binding.parameterIndex);
            else if (binding.source == BindingSource::simulationTime) symbols[index] = simulationTime;
            else symbols[index] = states.at(binding.valueIndex);
        }
        for (const auto definition : output.definitions) {
            symbols[relationship.bindings.size() + definition] = relationship.definitions[definition].evaluate(symbols);
        }
        const auto result = output.expression.evaluate(symbols);
        if (!std::isfinite(result)) {
            throw std::runtime_error("The relationship " + std::to_string(relationship.edgeId) + " produced a non-finite value for state " +
                std::to_string(output.outputStateId) + " at " + std::to_string(simulationTime) + " s.");
        }
        states.at(output.outputStateIndex) += result;
    }
}

}
