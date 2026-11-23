/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "jacobianAssembly.hpp"

#include <algorithm>
#include <limits>
#include <stdexcept>

namespace konjugate {

namespace {

using Expression = CompiledExpression;
using Operation = ExpressionOperation;

Expression literal(double value) {
    Expression expression;
    expression.operation = Operation::literal;
    expression.literal = value;
    return expression;
}

Expression node(Operation operation, std::vector<Expression> arguments) {
    Expression expression;
    expression.operation = operation;
    expression.arguments = std::move(arguments);
    return expression;
}

bool isOne(const Expression& expression) { return expression.operation == Operation::literal && expression.literal == 1.0; }

// The sum of the terms that are not zero: none is zero, one is itself.
std::optional<Expression> sum(std::vector<std::optional<Expression>> terms) {
    std::vector<Expression> kept;
    for (auto& term : terms) if (term) kept.push_back(std::move(*term));
    if (kept.empty()) return std::nullopt;
    if (kept.size() == 1) return std::move(kept.front());
    return node(Operation::add, std::move(kept));
}

// factors times a derivative, the derivative last and not written when it is 1.
Expression times(std::vector<Expression> factors, const Expression& derivative) {
    if (!isOne(derivative)) factors.push_back(derivative);
    if (factors.empty()) return literal(1.0);
    if (factors.size() == 1) return std::move(factors.front());
    return node(Operation::multiply, std::move(factors));
}

Expression orZero(const std::optional<Expression>& expression) { return expression ? *expression : literal(0.0); }

}

std::optional<CompiledExpression> differentiateExpression(const CompiledExpression& expression, std::size_t symbolIndex) {
    const auto& arguments = expression.arguments;
    const auto derive = [&](std::size_t index) { return differentiateExpression(arguments.at(index), symbolIndex); };
    switch (expression.operation) {
        case Operation::literal: return std::nullopt;
        case Operation::symbol: return expression.symbolIndex == symbolIndex ? std::optional<Expression>(literal(1.0)) : std::nullopt;
        case Operation::add: {
            std::vector<std::optional<Expression>> terms;
            for (std::size_t index = 0; index < arguments.size(); ++index) terms.push_back(derive(index));
            return sum(std::move(terms));
        }
        case Operation::multiply: {
            // The product rule: each factor's derivative in its place among the others.
            std::vector<std::optional<Expression>> terms;
            for (std::size_t index = 0; index < arguments.size(); ++index) {
                const auto derivative = derive(index);
                if (!derivative) { terms.push_back(std::nullopt); continue; }
                std::vector<Expression> factors;
                for (std::size_t other = 0; other < arguments.size(); ++other) {
                    if (other == index) { if (!isOne(*derivative)) factors.push_back(*derivative); }
                    else factors.push_back(arguments[other]);
                }
                terms.push_back(factors.empty() ? literal(1.0) : factors.size() == 1 ? factors.front() : node(Operation::multiply, std::move(factors)));
            }
            return sum(std::move(terms));
        }
        case Operation::negate: {
            const auto derivative = derive(0);
            if (!derivative) return std::nullopt;
            return node(Operation::negate, {*derivative});
        }
        case Operation::divide: {
            // u' / v - u v' / (v v)
            const auto& u = arguments.at(0);
            const auto& v = arguments.at(1);
            const auto du = derive(0);
            const auto dv = derive(1);
            std::optional<Expression> first, second;
            if (du) first = node(Operation::divide, {*du, v});
            if (dv) second = node(Operation::negate, {node(Operation::divide, {times({u}, *dv), node(Operation::multiply, {v, v})})});
            return sum({first, second});
        }
        case Operation::power: {
            const auto& u = arguments.at(0);
            const auto& v = arguments.at(1);
            const auto du = derive(0);
            const auto dv = derive(1);
            std::optional<Expression> first, second;
            if (du) {
                // A constant exponent c: c u^(c - 1) u'; any other: v u^(v - 1) u'.
                const auto lowered = v.operation == Operation::literal ? literal(v.literal - 1.0) : node(Operation::add, {v, literal(-1.0)});
                first = times({v, node(Operation::power, {u, lowered})}, *du);
            }
            if (dv) second = times({expression, node(Operation::logarithm, {u})}, *dv);
            return sum({first, second});
        }
        case Operation::squareRoot: {
            const auto du = derive(0);
            if (!du) return std::nullopt;
            return node(Operation::divide, {*du, node(Operation::multiply, {literal(2.0), expression})});
        }
        case Operation::absolute: {
            const auto du = derive(0);
            if (!du) return std::nullopt;
            const auto sign = node(Operation::conditional, {node(Operation::less, {arguments.at(0), literal(0.0)}), literal(-1.0), literal(1.0), literal(1.0)});
            return times({sign}, *du);
        }
        case Operation::exponential: {
            const auto du = derive(0);
            if (!du) return std::nullopt;
            return times({expression}, *du);
        }
        case Operation::logarithm: {
            const auto du = derive(0);
            if (!du) return std::nullopt;
            return node(Operation::divide, {*du, arguments.at(0)});
        }
        case Operation::sine: {
            const auto du = derive(0);
            if (!du) return std::nullopt;
            return times({node(Operation::cosine, {arguments.at(0)})}, *du);
        }
        case Operation::cosine: {
            const auto du = derive(0);
            if (!du) return std::nullopt;
            return node(Operation::negate, {times({node(Operation::sine, {arguments.at(0)})}, *du)});
        }
        case Operation::tangent: {
            const auto du = derive(0);
            if (!du) return std::nullopt;
            const auto cosine = node(Operation::cosine, {arguments.at(0)});
            return node(Operation::divide, {*du, node(Operation::multiply, {cosine, cosine})});
        }
        case Operation::arcsine:
        case Operation::arccosine: {
            const auto du = derive(0);
            if (!du) return std::nullopt;
            const auto& u = arguments.at(0);
            const auto root = node(Operation::squareRoot, {node(Operation::add, {literal(1.0), node(Operation::negate, {node(Operation::multiply, {u, u})})})});
            const auto derivative = node(Operation::divide, {*du, root});
            return expression.operation == Operation::arcsine ? derivative : node(Operation::negate, {derivative});
        }
        case Operation::arctangent: {
            const auto du = derive(0);
            if (!du) return std::nullopt;
            const auto& u = arguments.at(0);
            return node(Operation::divide, {*du, node(Operation::add, {literal(1.0), node(Operation::multiply, {u, u})})});
        }
        case Operation::arctangent2: {
            // atan2(y, x): (x y' - y x') / (x x + y y)
            const auto& y = arguments.at(0);
            const auto& x = arguments.at(1);
            const auto dy = derive(0);
            const auto dx = derive(1);
            std::optional<Expression> first, second;
            if (dy) first = times({x}, *dy);
            if (dx) second = node(Operation::negate, {times({y}, *dx)});
            const auto numerator = sum({first, second});
            if (!numerator) return std::nullopt;
            return node(Operation::divide, {*numerator, node(Operation::add, {node(Operation::multiply, {x, x}), node(Operation::multiply, {y, y})})});
        }
        case Operation::hyperbolicTangent: {
            const auto du = derive(0);
            if (!du) return std::nullopt;
            return times({node(Operation::add, {literal(1.0), node(Operation::negate, {node(Operation::multiply, {expression, expression})})})}, *du);
        }
        case Operation::minimum:
        case Operation::maximum: {
            // min(a, b) is b when b < a, else a; max(a, b) is b when a < b, else a: the derivative of the side taken.
            const auto da = derive(0);
            const auto db = derive(1);
            if (!da && !db) return std::nullopt;
            const auto& a = arguments.at(0);
            const auto& b = arguments.at(1);
            const auto takesB = expression.operation == Operation::minimum ? node(Operation::less, {b, a}) : node(Operation::less, {a, b});
            return node(Operation::conditional, {takesB, orZero(db), literal(1.0), orZero(da)});
        }
        case Operation::conditional: {
            // The derivative of the branch that holds, the conditions as they are.
            std::vector<Expression> branches;
            bool any = false;
            for (std::size_t index = 0; index + 1 < arguments.size(); index += 2) {
                const auto derivative = derive(index + 1);
                any = any || derivative.has_value();
                branches.push_back(arguments[index]);
                branches.push_back(orZero(derivative));
            }
            if (!any) return std::nullopt;
            return node(Operation::conditional, std::move(branches));
        }
        case Operation::less:
        case Operation::lessEqual:
        case Operation::greater:
        case Operation::greaterEqual:
        case Operation::equal:
        case Operation::notEqual:
        case Operation::logicalAnd:
        case Operation::logicalOr:
        case Operation::logicalNot:
            return std::nullopt;
    }
    throw std::runtime_error("An expression could not be differentiated.");
}

namespace {

// The plan's index of the state a binding reads, or none for a parameter or the time.
std::size_t boundState(const NodeExecutionPlan& node, const CompiledBinding& binding) {
    if (binding.source == BindingSource::localState) return node.stateIndexes.at(binding.valueIndex);
    if (binding.source == BindingSource::synchronizationSnapshot) return binding.valueIndex;
    return std::numeric_limits<std::size_t>::max();
}

}

JacobianPlan compileJacobianPlan(const ExecutionPlan& plan, const WholeModelPlan& whole, const integrators::StiffSystem& system,
                                 const ProviderEvaluator* providers) {
    JacobianPlan result;
    const std::size_t count = system.integratedStates.size();
    constexpr auto none = std::numeric_limits<std::size_t>::max();
    std::vector<std::size_t> position(plan.initialStates.size(), none);
    for (std::size_t index = 0; index < count; ++index) position[system.integratedStates[index]] = index;
    result.exactColumn.assign(count, 1);
    bool opaque = false;
    // A program's bindings, narrowed as stageReads narrows them to a version 2 program's declared dependencies.
    const auto programReads = [&](EntityId owner, const std::string& outputKey, std::uint32_t version, const std::vector<CompiledBinding>& bindings,
                                  const NodeExecutionPlan& node) {
        std::optional<std::vector<std::string>> declared;
        if (providers && version == 2) declared = providers->programOutputDependencies(owner, outputKey);
        for (const auto& binding : bindings) {
            if (declared && std::find(declared->begin(), declared->end(), binding.symbol) == declared->end()) continue;
            const auto state = boundState(node, binding);
            if (state != none && position[state] != none) result.exactColumn[position[state]] = 0;
        }
    };
    for (std::size_t index = 0; index < plan.nodes.size(); ++index) {
        const auto& wholeNode = whole.nodes[index];
        if (wholeNode.stepped) continue;
        const auto& node = plan.nodes[index];
        for (const auto& task : wholeNode.stageNode.contributions) {
            if (task.implementation == ContributionImplementation::equation) continue;
            // Its time dependence is not known: df/dt is differenced.
            opaque = true;
            // A program that supplies its own Jacobian leaves its columns exact: its derivatives are terms below.
            if (providers && providers->suppliesJacobian(task)) continue;
            programReads(task.sourceId, task.providerOutputKey, task.programVersion, task.bindings, node);
        }
        if (const auto& provider = wholeNode.stageNode.nodeProvider) {
            opaque = true;
            for (const auto& output : provider->outputs) {
                if (!output.setsValue) programReads(node.nodeId, output.key, provider->programVersion, provider->bindings, node);
            }
        }
    }
    // The entries of the exact columns, by (row, column).
    const auto entryOf = [&](std::size_t row, std::size_t column) {
        const auto& columns = system.rows[row];
        const auto found = std::lower_bound(columns.begin(), columns.end(), column);
        if (found == columns.end() || *found != column) throw std::runtime_error("A derivative falls outside the Jacobian's pattern.");
        return system.rowStart[row] + static_cast<std::size_t>(found - columns.begin());
    };
    for (std::size_t column = 0; column < count; ++column) {
        if (!result.exactColumn[column]) continue;
        for (const auto& [row, entry] : system.columnEntries[column]) {
            static_cast<void>(row);
            result.exactEntries.push_back(entry);
        }
    }
    std::sort(result.exactEntries.begin(), result.exactEntries.end());
    bool scheduled = false;
    for (std::size_t index = 0; index < plan.nodes.size(); ++index) {
        const auto& wholeNode = whole.nodes[index];
        if (wholeNode.stepped) continue;
        const auto& node = plan.nodes[index];
        const auto& tasks = wholeNode.stageNode.contributions;
        for (std::size_t taskIndex = 0; taskIndex < tasks.size(); ++taskIndex) {
            const auto& task = tasks[taskIndex];
            if (task.implementation != ContributionImplementation::equation) {
                if (!providers || !providers->suppliesJacobian(task)) continue;
                const auto row = position[node.stateIndexes.at(task.outputStateIndex)];
                if (row == none) continue;
                // Each binding to a state of an exact column, narrowed to the program's declared dependencies, as stageReads narrows them.
                const auto declared = providers->programOutputDependencies(task.sourceId, task.providerOutputKey);
                ++result.suppliedTerms;
                for (std::size_t binding = 0; binding < task.bindings.size(); ++binding) {
                    const auto& compiled = task.bindings[binding];
                    if (declared && std::find(declared->begin(), declared->end(), compiled.symbol) == declared->end()) continue;
                    const auto state = boundState(node, compiled);
                    if (state == none || position[state] == none || !result.exactColumn[position[state]]) continue;
                    JacobianTerm term;
                    term.node = index;
                    term.task = taskIndex;
                    term.supplied = true;
                    term.binding = binding;
                    term.negate = task.negateOutput;
                    term.target = entryOf(row, position[state]);
                    result.terms.push_back(std::move(term));
                }
                continue;
            }
            const auto output = node.stateIndexes.at(task.outputStateIndex);
            const auto row = position[output];
            if (row == none) continue;
            ++result.differentiatedTerms;
            for (std::size_t binding = 0; binding < task.bindings.size(); ++binding) {
                const auto& compiled = task.bindings[binding];
                if (compiled.source == BindingSource::parameter) {
                    if (compiled.parameterIndex < task.parameters.size() && task.parameters[compiled.parameterIndex].schedule) {
                        if (differentiateExpression(task.expression, binding)) scheduled = true;
                    }
                    continue;
                }
                const bool time = compiled.source == BindingSource::simulationTime;
                const auto state = time ? none : boundState(node, compiled);
                if (!time && (state == none || position[state] == none || !result.exactColumn[position[state]])) continue;
                auto derivative = differentiateExpression(task.expression, binding);
                if (!derivative) continue;
                JacobianTerm term;
                term.node = index;
                term.task = taskIndex;
                term.program = compileExpressionProgram(*derivative);
                term.expression = std::move(*derivative);
                term.negate = task.negateOutput;
                term.target = time ? row : entryOf(row, position[state]);
                (time ? result.timeTerms : result.terms).push_back(std::move(term));
            }
        }
    }
    result.exactTime = !opaque && !scheduled;
    return result;
}

void evaluateExactJacobian(const ExecutionPlan& plan, const WholeModelPlan& whole, const JacobianPlan& jacobianPlan, double time,
                           const std::vector<double>& states, const EntityValues& liveParameterValues,
                           const std::vector<ParameterSchedule>& activeSchedules, const std::vector<double>* latches,
                           std::vector<double>& jacobian, std::vector<double>* dT, ProviderEvaluator* providers) {
    for (const auto entry : jacobianPlan.exactEntries) jacobian[entry] = 0.0;
    if (dT) std::fill(dT->begin(), dT->end(), 0.0);
    // The symbols of each term of the node at hand, as evaluateContributionTasks binds them.
    std::size_t currentNode = std::numeric_limits<std::size_t>::max();
    std::vector<std::vector<double>> symbols;
    // A supplying program's derivatives by binding, asked once per term at this point.
    std::vector<std::vector<double>> supplied;
    std::vector<unsigned char> suppliedReady;
    const auto prepare = [&](std::size_t index) {
        if (index == currentNode) return;
        currentNode = index;
        const auto& node = plan.nodes[index];
        const auto& tasks = whole.nodes[index].stageNode.contributions;
        const auto parameters = resolveParameterValues(tasks, liveParameterValues, activeSchedules, time);
        symbols.assign(tasks.size(), {});
        supplied.assign(tasks.size(), {});
        suppliedReady.assign(tasks.size(), 0);
        for (std::size_t taskIndex = 0; taskIndex < tasks.size(); ++taskIndex) {
            const auto& task = tasks[taskIndex];
            auto& values = symbols[taskIndex];
            values.resize(task.bindings.size());
            for (std::size_t binding = 0; binding < task.bindings.size(); ++binding) {
                const auto& compiled = task.bindings[binding];
                if (compiled.source == BindingSource::parameter) values[binding] = parameters.at(taskIndex).at(compiled.parameterIndex);
                else if (compiled.source == BindingSource::localState) values[binding] = states.at(node.stateIndexes.at(compiled.valueIndex));
                else if (compiled.source == BindingSource::simulationTime) values[binding] = time;
                else values[binding] = states.at(compiled.valueIndex);
            }
            if (!task.latchSlots.empty()) {
                if (!latches) throw std::runtime_error("A latched condition was differentiated without its latches.");
                for (const auto slot : task.latchSlots) values.push_back(latches->at(slot));
            }
        }
    };
    const auto add = [&](const JacobianTerm& term, double& into) {
        prepare(term.node);
        if (term.supplied) {
            if (!suppliedReady[term.task]) {
                const auto& task = whole.nodes[term.node].stageNode.contributions[term.task];
                std::vector<std::vector<double>> derivatives;
                if (!providers || !providers->evaluateJacobianBatch({&task}, {std::span<const double>(symbols[term.task])}, time, 0.0, derivatives)) {
                    throw std::runtime_error("A program that gave its Jacobian at the run's start gave none now.");
                }
                supplied[term.task] = std::move(derivatives.front());
                suppliedReady[term.task] = 1;
            }
            const double value = supplied[term.task].at(term.binding);
            into += term.negate ? -value : value;
            return;
        }
        const double value = evaluateExpressionProgram(term.expression, term.program, symbols[term.task]);
        into += term.negate ? -value : value;
    };
    for (const auto& term : jacobianPlan.terms) add(term, jacobian[term.target]);
    if (dT) for (const auto& term : jacobianPlan.timeTerms) add(term, (*dT)[term.target]);
}

void addExactDerivatives(const std::vector<ContributionTask>& tasks, const NodeParameterValues& parameters, double time,
                         const std::function<double(const CompiledBinding&)>& valueOf,
                         const std::function<std::size_t(const CompiledBinding&)>& stateOf,
                         const std::function<void(std::size_t, std::size_t, double)>& add) {
    constexpr auto none = std::numeric_limits<std::size_t>::max();
    for (std::size_t taskIndex = 0; taskIndex < tasks.size(); ++taskIndex) {
        const auto& task = tasks[taskIndex];
        if (task.implementation != ContributionImplementation::equation) throw std::runtime_error("Only an equation can be differentiated.");
        std::vector<double> symbols(task.bindings.size());
        for (std::size_t binding = 0; binding < task.bindings.size(); ++binding) {
            const auto& compiled = task.bindings[binding];
            if (compiled.source == BindingSource::parameter) symbols[binding] = parameters.at(taskIndex).at(compiled.parameterIndex);
            else if (compiled.source == BindingSource::simulationTime) symbols[binding] = time;
            else symbols[binding] = valueOf(compiled);
        }
        for (std::size_t binding = 0; binding < task.bindings.size(); ++binding) {
            const auto state = stateOf(task.bindings[binding]);
            if (state == none) continue;
            const auto derivative = differentiateExpression(task.expression, binding);
            if (!derivative) continue;
            const double value = evaluateExpressionProgram(*derivative, ExpressionProgram{}, symbols);
            add(task.outputStateIndex, state, task.negateOutput ? -value : value);
        }
    }
}

}
