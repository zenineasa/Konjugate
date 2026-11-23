/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "eventLocation.hpp"
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <set>
#include <stdexcept>

namespace konjugate {

namespace {

bool isOrdering(ExpressionOperation operation) {
    return operation == ExpressionOperation::less || operation == ExpressionOperation::lessEqual ||
           operation == ExpressionOperation::greater || operation == ExpressionOperation::greaterEqual;
}

// Whether the expression has a Which whose conditions compare by order: a switching condition.
bool hasSwitchingCondition(const CompiledExpression& expression);

bool conditionCompares(const CompiledExpression& condition) {
    if (isOrdering(condition.operation) && condition.arguments.size() >= 2) return true;
    if (condition.operation == ExpressionOperation::logicalAnd || condition.operation == ExpressionOperation::logicalOr ||
        condition.operation == ExpressionOperation::logicalNot) {
        return std::any_of(condition.arguments.begin(), condition.arguments.end(), conditionCompares);
    }
    return hasSwitchingCondition(condition);
}

bool hasSwitchingCondition(const CompiledExpression& expression) {
    if (expression.operation == ExpressionOperation::conditional) {
        for (std::size_t index = 0; index < expression.arguments.size(); ++index) {
            const bool condition = index % 2 == 0 && index + 1 < expression.arguments.size();
            if (condition ? conditionCompares(expression.arguments[index]) : hasSwitchingCondition(expression.arguments[index])) return true;
        }
        return false;
    }
    return std::any_of(expression.arguments.begin(), expression.arguments.end(), hasSwitchingCondition);
}

// Rewrites a stage term so each comparison of a condition reads a latch, adding a switching function for each.
struct Latcher {
    ContributionTask& task;
    std::size_t node;
    std::vector<SwitchingFunction>& functions;

    ContributionTask side(const CompiledExpression& expression) const {
        ContributionTask copy = task;
        copy.expression = expression;
        copy.program = compileExpressionProgram(copy.expression);
        copy.latchSlots.clear();
        copy.negateOutput = false;
        copy.implementation = ContributionImplementation::equation;
        return copy;
    }

    CompiledExpression latch(unsigned char comparison, const CompiledExpression& left, const CompiledExpression& right) {
        SwitchingFunction function;
        function.node = node;
        function.sourceId = task.sourceId;
        function.stateId = task.outputStateId;
        function.comparison = comparison;
        function.left = side(left);
        function.right = side(right);
        CompiledExpression read;
        read.operation = ExpressionOperation::symbol;
        read.symbol = "latch";
        read.symbolIndex = task.bindings.size() + task.latchSlots.size();
        task.latchSlots.push_back(functions.size());
        functions.push_back(std::move(function));
        return read;
    }

    void condition(CompiledExpression& expression) {
        if (isOrdering(expression.operation) && expression.arguments.size() >= 2) {
            const auto comparison = static_cast<unsigned char>(static_cast<int>(expression.operation) - static_cast<int>(ExpressionOperation::less));
            std::vector<CompiledExpression> reads;
            for (std::size_t pair = 0; pair + 1 < expression.arguments.size(); ++pair) {
                reads.push_back(latch(comparison, expression.arguments[pair], expression.arguments[pair + 1]));
            }
            if (reads.size() == 1) {
                expression = std::move(reads.front());
            } else {
                // A chain holds when every pair does.
                CompiledExpression all;
                all.operation = ExpressionOperation::logicalAnd;
                all.arguments = std::move(reads);
                expression = std::move(all);
            }
            return;
        }
        if (expression.operation == ExpressionOperation::logicalAnd || expression.operation == ExpressionOperation::logicalOr ||
            expression.operation == ExpressionOperation::logicalNot) {
            for (auto& argument : expression.arguments) condition(argument);
            return;
        }
        walk(expression);
    }

    void walk(CompiledExpression& expression) {
        if (expression.operation == ExpressionOperation::conditional) {
            for (std::size_t index = 0; index < expression.arguments.size(); ++index) {
                const bool isCondition = index % 2 == 0 && index + 1 < expression.arguments.size();
                if (isCondition) condition(expression.arguments[index]);
                else walk(expression.arguments[index]);
            }
            return;
        }
        for (auto& argument : expression.arguments) walk(argument);
    }
};

void appendDouble(std::string& record, double value) {
    std::uint64_t bits = 0;
    std::memcpy(&bits, &value, sizeof bits);
    for (int byte = 0; byte < 8; ++byte) record.push_back(static_cast<char>((bits >> (8 * byte)) & 0xffU));
}

double readDouble(const std::string& record, std::size_t offset) {
    std::uint64_t bits = 0;
    for (int byte = 7; byte >= 0; --byte) bits = (bits << 8) | static_cast<unsigned char>(record[offset + static_cast<std::size_t>(byte)]);
    double value = 0;
    std::memcpy(&value, &bits, sizeof value);
    return value;
}

}

EventPlan compileEventPlan(const ExecutionPlan& plan, WholeModelPlan& whole) {
    EventPlan events;
    for (std::size_t node = 0; node < whole.nodes.size() && node < plan.nodes.size(); ++node) {
        auto& wholeNode = whole.nodes[node];
        if (wholeNode.stepped) continue;
        for (auto& task : wholeNode.stageNode.contributions) {
            if (task.implementation != ContributionImplementation::equation || !hasSwitchingCondition(task.expression)) continue;
            Latcher latcher{task, node, events.functions};
            latcher.walk(task.expression);
            if (!task.latchSlots.empty()) task.program = compileExpressionProgram(task.expression);
        }
    }
    return events;
}

std::vector<std::pair<EntityId, EntityId>> unlocatedConditions(const ExecutionPlan& plan) {
    std::vector<std::pair<EntityId, EntityId>> found;
    std::set<std::pair<EntityId, EntityId>> seen;
    for (const auto& node : plan.nodes) {
        for (const auto& task : node.contributions) {
            if (task.implementation != ContributionImplementation::equation || !hasSwitchingCondition(task.expression)) continue;
            const std::pair<EntityId, EntityId> key{task.sourceId, task.outputStateId};
            if (seen.insert(key).second) found.push_back(key);
        }
    }
    return found;
}

void evaluateSwitchingFunctions(const ExecutionPlan& plan, const EventPlan& events, const StateValues& states,
                                const EntityValues& liveParameterValues, const std::vector<ParameterSchedule>& activeSchedules, double time,
                                std::vector<double>& values) {
    values.assign(events.functions.size(), 0.0);
    // Node by node, in plan order, each node's functions evaluated together from its states as a stage reads them: the same values on
    // every backend, worked out here on one thread.
    std::size_t first = 0;
    while (first < events.functions.size()) {
        const auto node = events.functions[first].node;
        std::size_t last = first;
        while (last < events.functions.size() && events.functions[last].node == node) ++last;
        const auto& compiled = plan.nodes.at(node);
        NodeExecutionPlan sides;
        sides.nodeId = compiled.nodeId;
        sides.stateIds = compiled.stateIds;
        sides.stateIndexes = compiled.stateIndexes;
        for (std::size_t index = first; index < last; ++index) {
            sides.contributions.push_back(events.functions[index].left);
            sides.contributions.push_back(events.functions[index].right);
        }
        StateValues local(compiled.stateIndexes.size());
        for (std::size_t index = 0; index < local.size(); ++index) local[index] = states[compiled.stateIndexes[index]];
        const auto parameters = resolveParameterValues(sides.contributions, liveParameterValues, activeSchedules, time);
        const auto evaluated = evaluateContributionTasks(sides, local, states, parameters, time);
        for (std::size_t index = first; index < last; ++index) {
            const auto position = 2 * (index - first);
            values[index] = evaluated.at(position).value - evaluated.at(position + 1).value;
        }
        first = last;
    }
}

// Version 2: a byte 2; the proposed step and the previous error as little-endian doubles; the number of conditions as four little-endian
// bytes; then each condition's latch (0 or 1) and armed flag (0 or 1), a byte each.
std::string encodeEventSolverState(double proposedStep, double previousError, double previousStep, const std::vector<double>& latches,
                                   const std::vector<unsigned char>& armed) {
    std::string record;
    record.push_back(2);
    appendDouble(record, proposedStep > 0 ? proposedStep : 0.0);
    appendDouble(record, previousError);
    appendDouble(record, previousStep);
    const auto count = static_cast<std::uint32_t>(latches.size());
    for (int byte = 0; byte < 4; ++byte) record.push_back(static_cast<char>((count >> (8 * byte)) & 0xffU));
    for (const auto latch : latches) record.push_back(latch != 0.0 ? 1 : 0);
    for (const auto flag : armed) record.push_back(flag ? 1 : 0);
    return record;
}

bool decodeEventSolverState(const std::string& record, double& proposedStep, double& previousError, double& previousStep, std::vector<double>& latches,
                            std::vector<unsigned char>& armed) {
    if (record.size() < 29 || record[0] != 2) return false;
    std::uint32_t count = 0;
    for (int byte = 3; byte >= 0; --byte) count = (count << 8) | static_cast<unsigned char>(record[25 + static_cast<std::size_t>(byte)]);
    if (count != latches.size() || record.size() != 29 + 2 * static_cast<std::size_t>(count)) return false;
    proposedStep = readDouble(record, 1);
    previousError = readDouble(record, 9);
    previousStep = readDouble(record, 17);
    for (std::size_t index = 0; index < count; ++index) {
        latches[index] = record[29 + index] ? 1.0 : 0.0;
        armed[index] = record[29 + count + index] ? 1 : 0;
    }
    return true;
}

}
