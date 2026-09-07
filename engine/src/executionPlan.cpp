/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "executionPlan.hpp"
#include <algorithm>
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
                task.parameters.push_back({idValue(parameter, "id"), parameter.get<double>("value", 0), value(parameter, "mode") == "live"});
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
            for (const auto& task : algebraicCandidates) {
                for (const auto& binding : task.bindings) {
                    if (binding.source == BindingSource::localState && binding.valueId == task.outputStateId) {
                        throw std::runtime_error(
                            "A source term that sets its value directly may not reference its own state.");
                    }
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
                for (const auto& binding : algebraicCandidates[index].bindings) {
                    if (binding.source != BindingSource::localState) continue;
                    const auto found = algebraicIndexByStateId.find(binding.valueId);
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
            if (const auto bindingsNode = implementation->get_child_optional("bindings")) {
                providerTask.bindings = compileBindings(*bindingsNode, compiledNode.nodeId, true,
                    plan.stateIndexes, localStateIndexes, "key");
            }
            for (const auto& outputItem : implementation->get_child("outputs")) {
                const auto& outputEntry = outputItem.second;
                NodeProviderOutputBinding output;
                output.key = value(outputEntry, "key");
                output.stateId = idValue(outputEntry, "stateId");
                output.stateIndex = localStateIndexes.at(output.stateId);
                providerTask.outputs.push_back(std::move(output));
            }
            providerTask.providerProcessKeyCache = (kind == "cpp" ? "cpp:" : "py:") + providerTask.providerSource;
            compiledNode.estimatedOperationsPerSubstep += providerTask.bindings.size() + providerTask.outputs.size() + 1;
            compiledNode.nodeProvider = std::move(providerTask);
        }
        nodeIndexes[compiledNode.nodeId] = plan.nodes.size();
        plan.nodes.push_back(std::move(compiledNode));
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
                task.parameters.push_back({idValue(parameter, "id"), parameter.get<double>("value", 0), value(parameter, "mode") == "live"});
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
    ProviderEvaluator* providerEvaluator) {
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
                throw std::runtime_error("A computational-node provider binding cannot reference a parameter.");
            }
            inputs[index] = binding.source == BindingSource::localState
                ? localStates.at(binding.valueIndex) : synchronizationSnapshot.at(binding.valueIndex);
        }
        if (!providerEvaluator) throw std::runtime_error("A computational-node provider requires an initialized provider runtime.");
        const auto outputs = providerEvaluator->evaluateNode(task, inputs, simulationTime, stepSize);
        for (const auto& [outputKey, outputValue] : outputs) {
            const auto found = std::find_if(task.outputs.begin(), task.outputs.end(),
                [&](const auto& output) { return output.key == outputKey; });
            if (found == task.outputs.end()) {
                throw std::runtime_error("A computational-node provider returned an undeclared output key '" + outputKey + "'.");
            }
            if (!std::isfinite(outputValue)) throw std::runtime_error("A computational-node provider produced a non-finite derivative.");
            const auto sequence = node.contributions.size() + static_cast<std::size_t>(std::distance(task.outputs.begin(), found));
            evaluated.push_back({sequence, found->stateIndex, outputValue});
        }
    }

    return evaluated;
}

NodeParameterValues resolveParameterValues(const std::vector<ContributionTask>& tasks, const EntityValues& liveParameterValues) {
    NodeParameterValues resolved;
    resolved.reserve(tasks.size());
    for (const auto& task : tasks) {
        auto& values = resolved.emplace_back();
        values.reserve(task.parameters.size());
        for (const auto& parameter : task.parameters) {
            const auto override = liveParameterValues.find(parameter.id);
            values.push_back(parameter.live && override != liveParameterValues.end() ? override->second : parameter.value);
        }
    }
    return resolved;
}

NodeParameterValues resolveParameterValues(const NodeExecutionPlan& node, const EntityValues& liveParameterValues) {
    return resolveParameterValues(node.contributions, liveParameterValues);
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
                         const NodeParameterValues& parameterValues, double simulationTime, double stepSize,
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
            // simulationTime + stepSize (this substep's END, not its start) is deliberate, not a
            // typo against evaluateContributionTasks' own convention: a differential
            // contribution's derivative is sampled at the START of the interval it will be
            // Euler-applied over (standard forward-Euler), but an algebraic task's result IS the
            // state's value -- it needs to represent "this state's value once this substep
            // completes," the same instant the Euler-updated differential states it composes
            // with will represent. Using the start time here would make a time-dependent
            // algebraic provider (e.g. src/providerTemplate.mjs's causal-inference CSV replay)
            // report every value one substep late. This matches the standard semi-explicit DAE
            // convention of resolving the algebraic relationship at the new time step before
            // using it in that same step's differential update.
            const auto results = providerEvaluator->evaluateBatch(batchTasks, inputs, simulationTime + stepSize, stepSize);
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

NodeIntegrationResult integrateNode(const NodeExecutionPlan& node,
                                    const StateValues& synchronizationSnapshot,
                                    const EntityValues& liveParameterValues,
                                    double simulationTime,
                                    double synchronizationStep,
                                    ProviderEvaluator* providerEvaluator) {
    const auto startedAt = std::chrono::steady_clock::now();
    StateValues localStates(node.stateIndexes.size());
    for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) {
        localStates[index] = synchronizationSnapshot.at(node.stateIndexes[index]);
    }
    const auto parameterValues = resolveParameterValues(node.contributions, liveParameterValues);
    const auto algebraicParameterValues = resolveParameterValues(node.algebraicTasks, liveParameterValues);
    const auto nodeTimeStep = synchronizationStep / static_cast<double>(node.substeps);
    for (std::size_t substep = 0; substep < node.substeps; ++substep) {
        const double substepTime = simulationTime + static_cast<double>(substep) * nodeTimeStep;
        // Algebraic states are recomputed first, in their precomputed dependency order, so both
        // a later algebraic task and every ordinary (differential) contribution evaluated next
        // in this same substep see the fresh value -- never the previous substep's.
        applyAlgebraicTasks(node.algebraicTasks, localStates, algebraicParameterValues, substepTime, nodeTimeStep, providerEvaluator);
        const auto evaluated = evaluateContributionTasks(
            node, localStates, synchronizationSnapshot, parameterValues,
            substepTime, nodeTimeStep, providerEvaluator);
        const auto derivatives = reduceContributions(evaluated);
        for (const auto& derivative : derivatives) localStates.at(derivative.first) += nodeTimeStep * derivative.second;
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - startedAt).count();
    return {std::move(localStates), static_cast<std::uint64_t>(std::max<std::int64_t>(0, elapsed))};
}

}
