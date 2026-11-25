/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "wholeModelIntegration.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <set>
#include <stdexcept>

namespace konjugate {

IntegrationSettings integrationSettingsFromTree(const boost::property_tree::ptree& configuration) {
    IntegrationSettings settings;
    const auto method = configuration.get<std::string>("method", "nodeByNode");
    if (method == "nodeByNode") settings.method = IntegrationMethod::nodeByNode;
    else if (method == "rungeKutta4") settings.method = IntegrationMethod::rungeKutta4;
    else if (method == "dormandPrince54") settings.method = IntegrationMethod::dormandPrince54;
    else if (method == "tsit5") settings.method = IntegrationMethod::tsit5;
    else if (method == "rodas4") settings.method = IntegrationMethod::rodas4;
    else if (method == "rodas5p") settings.method = IntegrationMethod::rodas5p;
    else if (method == "bdf") settings.method = IntegrationMethod::bdf;
    else {
        throw std::runtime_error("The run's method \"" + method + "\" is not one this version of Konjugate knows (it knows nodeByNode, "
            "rungeKutta4, dormandPrince54, tsit5, rodas4, rodas5p and bdf); open the model in the version that wrote it, or choose another method.");
    }
    // BDF always chooses its own steps and orders: a multistep method has no fixed-step form to check here.
    if (settings.method == IntegrationMethod::bdf && configuration.get_optional<std::string>("stepsPerGlobalStep")) {
        throw std::runtime_error("stepsPerGlobalStep does not apply to the bdf method, which chooses its own steps.");
    }
    // The stiff methods' Jacobian: analytic unless the run says otherwise.
    if (const auto jacobian = configuration.get_optional<std::string>("jacobian")) {
        if (!isRosenbrock(settings.method) && settings.method != IntegrationMethod::bdf) {
            throw std::runtime_error("jacobian applies to the stiff methods, rodas4, rodas5p and bdf, which work out a Jacobian; this run's method does not.");
        }
        if (*jacobian == "analytic") settings.jacobian = JacobianMethod::analytic;
        else if (*jacobian == "finiteDifference") settings.jacobian = JacobianMethod::finiteDifference;
        else if (*jacobian == "check") settings.jacobian = JacobianMethod::check;
        else {
            throw std::runtime_error("The run's jacobian \"" + *jacobian + "\" is not one this version of Konjugate knows (it knows analytic, "
                "finiteDifference and check).");
        }
    }
    // Dormand–Prince, Tsit5, Rodas4 and Rodas5P choose their own steps unless told how many to take.
    if (isExplicitPair(settings.method) || isRosenbrock(settings.method) || settings.method == IntegrationMethod::bdf) {
        settings.stepsPerGlobalStep = 0;
    }
    if (const auto steps = configuration.get_optional<std::string>("stepsPerGlobalStep")) {
        char* end = nullptr;
        const auto value = std::strtod(steps->c_str(), &end);
        if (steps->empty() || end != steps->c_str() + steps->size() || !(value >= 1) || value > 10000 || value != std::floor(value)) {
            throw std::runtime_error("stepsPerGlobalStep must be an integer from 1 through 10000.");
        }
        settings.stepsPerGlobalStep = static_cast<std::size_t>(value);
    }
    // A relative tolerance is a fraction, below 1; an absolute one is in the state's own unit, any finite positive number.
    const auto positive = [&](const char* key, double fallback, bool fraction, const char* message) {
        const auto text = configuration.get_optional<std::string>(key);
        if (!text) return fallback;
        char* end = nullptr;
        const auto value = std::strtod(text->c_str(), &end);
        if (text->empty() || end != text->c_str() + text->size() || !std::isfinite(value) || !(value > 0) || (fraction && !(value < 1))) {
            throw std::runtime_error(message);
        }
        return value;
    };
    settings.relativeTolerance = positive("tolerance.relative", settings.relativeTolerance, true,
        "The run's relative tolerance must be a number greater than 0 and less than 1.");
    settings.absoluteTolerance = positive("tolerance.absolute", settings.absoluteTolerance, false,
        "The run's absolute tolerance must be a finite number greater than 0.");
    return settings;
}

bool isAdaptive(const IntegrationSettings& settings) noexcept {
    return isExplicitPair(settings.method) && settings.stepsPerGlobalStep == 0;
}

bool isExplicitPair(IntegrationMethod method) noexcept {
    return method == IntegrationMethod::dormandPrince54 || method == IntegrationMethod::tsit5;
}

bool isRosenbrock(IntegrationMethod method) noexcept {
    return method == IntegrationMethod::rodas4 || method == IntegrationMethod::rodas5p;
}

bool isStiff(const IntegrationSettings& settings) noexcept {
    return isRosenbrock(settings.method) && settings.stepsPerGlobalStep == 0;
}

bool hasTolerance(IntegrationMethod method) noexcept {
    return isExplicitPair(method) || isRosenbrock(method) || method == IntegrationMethod::bdf;
}

std::string_view integrationMethodName(IntegrationMethod method) noexcept {
    switch (method) {
    case IntegrationMethod::rungeKutta4: return "rungeKutta4";
    case IntegrationMethod::dormandPrince54: return "dormandPrince54";
    case IntegrationMethod::tsit5: return "tsit5";
    case IntegrationMethod::rodas4: return "rodas4";
    case IntegrationMethod::rodas5p: return "rodas5p";
    case IntegrationMethod::bdf: return "bdf";
    case IntegrationMethod::nodeByNode: break;
    }
    return "nodeByNode";
}

std::string_view solverKindName(IntegrationMethod method) noexcept {
    switch (method) {
    case IntegrationMethod::rungeKutta4: return "rungeKutta4";
    case IntegrationMethod::dormandPrince54: return "dormandPrince54";
    case IntegrationMethod::tsit5: return "tsit5";
    case IntegrationMethod::rodas4: return "rodas4";
    case IntegrationMethod::rodas5p: return "rodas5p";
    case IntegrationMethod::bdf: return "bdf";
    case IntegrationMethod::nodeByNode: break;
    }
    return "explicitEuler";
}

std::size_t integrationMethodStages(IntegrationMethod method) noexcept {
    switch (method) {
    case IntegrationMethod::rungeKutta4: return 4;
    case IntegrationMethod::dormandPrince54: return 6;
    case IntegrationMethod::tsit5: return 6;
    // Rodas4: six stages, and the Jacobian's evaluations besides (one per colour of the model's structure), not counted here.
    case IntegrationMethod::rodas4: return 6;
    // Rodas5P: eight stages, the Jacobian's evaluations besides.
    case IntegrationMethod::rodas5p: return 8;
    // BDF: about two Newton iterations a step, its Jacobian kept from step to step.
    case IntegrationMethod::bdf: return 2;
    case IntegrationMethod::nodeByNode: break;
    }
    return 1;
}

std::vector<double> absoluteTolerances(const boost::property_tree::ptree& document, const ExecutionPlan& plan, double runAbsoluteTolerance) {
    std::vector<double> tolerances(plan.initialStates.size(), runAbsoluteTolerance);
    const auto nodes = document.get_child_optional("nodes");
    if (!nodes) return tolerances;
    for (const auto& node : *nodes) {
        const auto states = node.second.get_child_optional("states");
        if (!states) continue;
        for (const auto& state : *states) {
            const auto text = state.second.get_optional<std::string>("numerics.absoluteTolerance");
            if (!text) continue;
            const auto stateId = state.second.get<EntityId>("id", 0);
            char* end = nullptr;
            const auto value = std::strtod(text->c_str(), &end);
            if (text->empty() || end != text->c_str() + text->size() || !std::isfinite(value) || !(value > 0)) {
                throw std::runtime_error("State " + std::to_string(stateId) + "'s absolute tolerance must be a finite number greater than 0.");
            }
            const auto index = plan.stateIndexes.find(stateId);
            if (index != plan.stateIndexes.end()) tolerances[index->second] = value;
        }
    }
    return tolerances;
}

namespace {

void addScheduleCorners(const ParameterSchedule& schedule, double from, double to, std::vector<double>& times) {
    const auto add = [&](double time) { if (time > from && time < to) times.push_back(time); };
    add(schedule.startTime);
    switch (schedule.mode) {
    case ParameterSchedule::Mode::step:
        return;
    case ParameterSchedule::Mode::ramp:
    case ParameterSchedule::Mode::pulse:
        add(schedule.startTime + schedule.duration);
        return;
    case ParameterSchedule::Mode::piecewise: {
        const auto first = std::upper_bound(schedule.samples.begin(), schedule.samples.end(), from,
            [](double time, const auto& sample) { return time < sample.first; });
        for (auto sample = first; sample != schedule.samples.end() && sample->first < to; ++sample) add(sample->first);
        return;
    }
    case ParameterSchedule::Mode::waveform:
        break;
    }
    const double end = schedule.duration > 0 ? schedule.startTime + schedule.duration : std::numeric_limits<double>::infinity();
    if (schedule.duration > 0) add(end);
    if (!(schedule.frequency > 0) || !std::isfinite(schedule.frequency)) return;
    // The fractions of a cycle at which the shape jumps or turns (waveformUnitValue); noise holds each value for a whole cycle,
    // counted from the start without the phase.
    std::vector<double> fractions;
    double phase = schedule.phaseDegrees / 360.0;
    switch (schedule.shape) {
    case ParameterSchedule::Shape::sine: return;
    case ParameterSchedule::Shape::square: fractions = {0.0, schedule.dutyCycle > 0 ? schedule.dutyCycle : 0.5}; break;
    case ParameterSchedule::Shape::triangle: fractions = {0.25, 0.75}; break;
    case ParameterSchedule::Shape::sawtooth: fractions = {0.5}; break;
    case ParameterSchedule::Shape::noise: fractions = {0.0}; phase = 0; break;
    }
    const double windowStart = std::max(from, schedule.startTime);
    const double windowEnd = std::min(to, end);
    if (!(windowEnd > windowStart)) return;
    const double firstCycle = std::floor((windowStart - schedule.startTime) * schedule.frequency + phase) - 1;
    const double lastCycle = std::ceil((windowEnd - schedule.startTime) * schedule.frequency + phase) + 1;
    for (double cycle = firstCycle; cycle <= lastCycle; ++cycle) {
        for (const auto fraction : fractions) {
            const double time = schedule.startTime + (cycle + fraction - phase) / schedule.frequency;
            if (time > windowStart && time < windowEnd) add(time);
        }
    }
}

}

std::vector<double> scheduleBreakpoints(const ExecutionPlan& plan, const std::vector<ParameterSchedule>& active, double from, double to) {
    std::vector<double> times;
    for (const auto& schedule : active) addScheduleCorners(schedule, from, to, times);
    std::set<const ParameterSchedule*> stored;
    const auto collect = [&](const std::vector<CompiledParameter>& parameters) {
        for (const auto& parameter : parameters) if (parameter.schedule) stored.insert(parameter.schedule.get());
    };
    // Every stored schedule the model reads, Updates' and algebraic relationships' too (though stages hold those), as code export
    // lands on every schedule it writes: the same breakpoints, so an exported program takes the engine's steps.
    for (const auto& node : plan.nodes) {
        for (const auto& task : node.contributions) collect(task.parameters);
        for (const auto& task : node.algebraicTasks) collect(task.parameters);
        if (node.nodeProvider) collect(node.nodeProvider->parameters);
    }
    for (const auto& relationship : plan.algebraicRelationships) collect(relationship.parameters);
    for (const auto* schedule : stored) addScheduleCorners(*schedule, from, to, times);
    // Sorted, so the order the schedules were visited in does not matter.
    std::sort(times.begin(), times.end());
    const double gap = std::max(1e-9 * (to - from), 1e3 * std::numeric_limits<double>::epsilon() * std::max(std::abs(from), std::abs(to)));
    std::vector<double> kept;
    for (const auto time : times) {
        if (time - from <= gap || to - time <= gap) continue;
        if (!kept.empty() && time - kept.back() <= gap) continue;
        kept.push_back(time);
    }
    return kept;
}

// Version 1 of the record: a byte 1, then the proposed step and the previous error as IEEE doubles, little-endian.
std::string encodeAdaptiveSolverState(double proposedStep, double previousError) {
    if (!(proposedStep > 0)) return {};
    std::string record(17, '\0');
    record[0] = 1;
    for (const auto [offset, value] : {std::pair{1, proposedStep}, std::pair{9, previousError}}) {
        std::uint64_t bits = 0;
        std::memcpy(&bits, &value, sizeof bits);
        for (int byte = 0; byte < 8; ++byte) record[static_cast<std::size_t>(offset + byte)] = static_cast<char>((bits >> (8 * byte)) & 0xffU);
    }
    return record;
}

bool decodeAdaptiveSolverState(const std::string& record, double& proposedStep, double& previousError) {
    if (record.size() != 17 || record[0] != 1) return false;
    double values[2];
    for (int which = 0; which < 2; ++which) {
        std::uint64_t bits = 0;
        for (int byte = 7; byte >= 0; --byte) bits = (bits << 8) | static_cast<unsigned char>(record[static_cast<std::size_t>(1 + 8 * which + byte)]);
        std::memcpy(&values[which], &bits, sizeof bits);
    }
    if (!(values[0] > 0) || !std::isfinite(values[0]) || !(values[1] > 0) || !std::isfinite(values[1])) return false;
    proposedStep = values[0];
    previousError = values[1];
    return true;
}

// Version 1 of Rodas4's record: a byte 1, then the proposed step, the previous error and the previous step as IEEE doubles,
// little-endian.
std::string encodeStiffSolverState(double proposedStep, double previousError, double previousStep) {
    if (!(proposedStep > 0)) return {};
    std::string record(25, '\0');
    record[0] = 1;
    for (const auto [offset, value] : {std::pair{1, proposedStep}, std::pair{9, previousError}, std::pair{17, previousStep}}) {
        std::uint64_t bits = 0;
        std::memcpy(&bits, &value, sizeof bits);
        for (int byte = 0; byte < 8; ++byte) record[static_cast<std::size_t>(offset + byte)] = static_cast<char>((bits >> (8 * byte)) & 0xffU);
    }
    return record;
}

bool decodeStiffSolverState(const std::string& record, double& proposedStep, double& previousError, double& previousStep) {
    if (record.size() != 25 || record[0] != 1) return false;
    double values[3];
    for (int which = 0; which < 3; ++which) {
        std::uint64_t bits = 0;
        for (int byte = 7; byte >= 0; --byte) bits = (bits << 8) | static_cast<unsigned char>(record[static_cast<std::size_t>(1 + 8 * which + byte)]);
        std::memcpy(&values[which], &bits, sizeof bits);
    }
    if (!(values[0] > 0) || !std::isfinite(values[0]) || !(values[1] > 0) || !std::isfinite(values[1]) || !(values[2] >= 0) || !std::isfinite(values[2])) {
        return false;
    }
    proposedStep = values[0];
    previousError = values[1];
    previousStep = values[2];
    return true;
}

namespace {

void appendBits(std::string& record, std::uint64_t bits, int bytes) {
    for (int byte = 0; byte < bytes; ++byte) record.push_back(static_cast<char>((bits >> (8 * byte)) & 0xffU));
}

void appendDouble(std::string& record, double value) {
    std::uint64_t bits = 0;
    std::memcpy(&bits, &value, sizeof bits);
    appendBits(record, bits, 8);
}

std::uint64_t readBits(const std::string& record, std::size_t& offset, int bytes) {
    std::uint64_t bits = 0;
    for (int byte = bytes - 1; byte >= 0; --byte) bits = (bits << 8) | static_cast<unsigned char>(record[offset + static_cast<std::size_t>(byte)]);
    offset += static_cast<std::size_t>(bytes);
    return bits;
}

double readDouble(const std::string& record, std::size_t& offset) {
    const auto bits = readBits(record, offset, 8);
    double value = 0;
    std::memcpy(&value, &bits, sizeof value);
    return value;
}

}

// BDF's record, little-endian: a version byte (1, or 2 with switching conditions), the order (one byte), the steps taken at it (four
// bytes), the step (a double), the numbers of integrated states and of states (four bytes each), the table's rows 0 .. order + 2 (each a
// double per integrated state; the rows above are never read before they are written), and every state as the method left it; then, in
// version 2, the number of conditions (four bytes), each condition's latch (a double) and each one's armed flag (a byte).
std::string encodeBdfSolverState(const integrators::BdfHistory& history, const std::vector<double>* latches, const std::vector<unsigned char>* armed) {
    if (!history.order) return {};
    const std::size_t integrated = history.differences.empty() ? 0 : history.differences[0].size();
    const std::size_t rows = std::min(history.order + 3, history.differences.size());
    std::string record;
    record.reserve(22 + 8 * (rows * integrated + history.reached.size()));
    record.push_back(latches && armed ? 2 : 1);
    appendBits(record, history.order, 1);
    appendBits(record, history.equalSteps, 4);
    appendDouble(record, history.step);
    appendBits(record, integrated, 4);
    appendBits(record, history.reached.size(), 4);
    for (std::size_t row = 0; row < rows; ++row) for (const auto value : history.differences[row]) appendDouble(record, value);
    for (const auto value : history.reached) appendDouble(record, value);
    if (latches && armed) {
        appendBits(record, latches->size(), 4);
        for (const auto value : *latches) appendDouble(record, value);
        for (const auto flag : *armed) record.push_back(static_cast<char>(flag));
    }
    return record;
}

bool decodeBdfSolverState(const std::string& record, std::size_t integratedCount, std::size_t stateCount, integrators::BdfHistory& history,
                          std::vector<double>* latches, std::vector<unsigned char>* armed) {
    constexpr std::size_t maximumOrder = integrators::BdfCoefficients::maximumOrder;
    if (record.size() < 22 || (record[0] != 1 && record[0] != 2)) return false;
    const bool withConditions = record[0] == 2;
    std::size_t offset = 1;
    const auto order = static_cast<std::size_t>(readBits(record, offset, 1));
    const auto equalSteps = static_cast<std::size_t>(readBits(record, offset, 4));
    const double step = readDouble(record, offset);
    const auto integrated = static_cast<std::size_t>(readBits(record, offset, 4));
    const auto states = static_cast<std::size_t>(readBits(record, offset, 4));
    if (!order || order > maximumOrder || !(step > 0) || !std::isfinite(step) || integrated != integratedCount || states != stateCount) return false;
    const std::size_t rows = order + 3;
    const std::size_t tableEnd = offset + 8 * (rows * integrated + states);
    if (withConditions ? record.size() < tableEnd + 4 : record.size() != tableEnd) return false;
    std::size_t conditions = 0;
    if (withConditions) {
        std::size_t at = tableEnd;
        conditions = static_cast<std::size_t>(readBits(record, at, 4));
        if (record.size() != tableEnd + 4 + 9 * conditions || (latches && latches->size() != conditions)) return false;
    }
    integrators::BdfHistory read;
    read.order = order;
    read.equalSteps = equalSteps;
    read.step = step;
    read.differences.assign(maximumOrder + 3, std::vector<double>(integrated, 0.0));
    for (std::size_t row = 0; row < rows; ++row) for (auto& value : read.differences[row]) value = readDouble(record, offset);
    read.reached.resize(states);
    for (auto& value : read.reached) value = readDouble(record, offset);
    if (withConditions && latches && armed) {
        offset += 4;
        std::vector<double> readLatches(conditions);
        for (auto& value : readLatches) value = readDouble(record, offset);
        std::vector<unsigned char> readArmed(conditions);
        for (auto& flag : readArmed) flag = static_cast<unsigned char>(record[offset++]);
        *latches = std::move(readLatches);
        *armed = std::move(readArmed);
    }
    history = std::move(read);
    return true;
}

void checkRequiredFeatures(const boost::property_tree::ptree& document) {
    const auto required = document.get_child_optional("requires");
    if (!required) return;
    // The features this engine knows that a model may require. None yet: the list exists so that the next feature that changes a
    // model's numbers can be required by name and refused by every engine from this one on that does not know it.
    static const std::set<std::string> known;
    for (const auto& entry : *required) {
        const auto name = entry.second.get_value<std::string>();
        if (!known.contains(name)) {
            throw std::runtime_error("This model requires \"" + name + "\", which this version of Konjugate does not know; open it in a newer version.");
        }
    }
}

WholeModelPlan buildWholeModelPlan(const ExecutionPlan& plan, const ProviderEvaluator* providers) {
    WholeModelPlan whole;
    whole.integrated.assign(plan.initialStates.size(), 0);
    const auto pure = [&](const std::string& key) { return providers && providers->declaredPure(key); };
    for (std::size_t index = 0; index < plan.nodes.size(); ++index) {
        const auto& node = plan.nodes[index];
        WholeModelNode compiled;
        const auto& provider = node.nodeProvider;
        // A provider that sets its states' values is a co-simulation step (an imported FMU): it can only be told to step. A version 2 node
        // program's outputs into Update states are values read at the update instant instead (docs/proposals/programSdkV2.md), so it
        // takes part in the stages with its other outputs.
        compiled.stepped = provider && (!pure(provider->providerProcessKeyCache) || (provider->programVersion != 2 &&
            std::any_of(provider->outputs.begin(), provider->outputs.end(), [](const auto& output) { return output.setsValue; })));
        if (compiled.stepped) {
            whole.steppedNodes.push_back(index);
            whole.nodes.push_back(std::move(compiled));
            continue;
        }
        compiled.stageNode.nodeId = compiled.heldNode.nodeId = node.nodeId;
        compiled.stageNode.stateIds = compiled.heldNode.stateIds = node.stateIds;
        compiled.stageNode.stateIndexes = compiled.heldNode.stateIndexes = node.stateIndexes;
        compiled.stageNode.nodeProvider = provider;
        std::set<std::size_t> integrated;
        for (const auto& task : node.contributions) {
            const bool held = task.implementation != ContributionImplementation::equation && !pure(providerProcessKey(task));
            (held ? compiled.heldNode : compiled.stageNode).contributions.push_back(task);
            if (held) whole.heldTerms.push_back({task.sourceId, task.outputStateId});
            integrated.insert(task.outputStateIndex);
        }
        if (provider) {
            for (const auto& output : provider->outputs) if (!output.setsValue) integrated.insert(output.stateIndex);
        }
        for (const auto local : integrated) {
            compiled.integratedStates.push_back(node.stateIndexes.at(local));
            whole.integrated.at(node.stateIndexes.at(local)) = 1;
        }
        whole.errorGroups.push_back(compiled.integratedStates);
        whole.nodes.push_back(std::move(compiled));
    }
    return whole;
}

void compileStageKernels(const ExecutionPlan& plan, WholeModelPlan& whole) {
    for (auto& node : whole.nodes) {
        node.kernel.reset();
        if (node.stepped || !node.heldNode.contributions.empty()) continue;
        node.kernel = compileNodeStageKernel(node.stageNode, plan.initialStates.size());
    }
}

namespace {

// The bindings an equation's expression uses, by position: the node editor binds every state of a node to each of its terms, but only
// the ones the expression names can change its value (code export reads an equation's states the same way).
void markUsedBindings(const CompiledExpression& expression, std::vector<unsigned char>& used) {
    if (expression.operation == ExpressionOperation::symbol && expression.symbolIndex < used.size()) used[expression.symbolIndex] = 1;
    for (const auto& argument : expression.arguments) markUsedBindings(argument, used);
}

std::vector<unsigned char> usedBindings(const ContributionTask& task) {
    std::vector<unsigned char> used(task.bindings.size(), task.implementation == ContributionImplementation::equation ? 0 : 1);
    if (task.implementation == ContributionImplementation::equation) markUsedBindings(task.expression, used);
    return used;
}

// The plan's index of the state a binding reads, or none for a parameter or the time.
std::size_t boundState(const NodeExecutionPlan& node, const CompiledBinding& binding) {
    if (binding.source == BindingSource::localState) return node.stateIndexes.at(binding.valueIndex);
    if (binding.source == BindingSource::synchronizationSnapshot) return binding.valueIndex;
    return std::numeric_limits<std::size_t>::max();
}

}

std::vector<std::vector<std::size_t>> stageReads(const ExecutionPlan& plan, const WholeModelPlan& whole, const ProviderEvaluator* providers) {
    std::vector<std::vector<std::size_t>> reads(plan.initialStates.size());
    // A version 2 program's declared dependencies: only the bindings to those inputs can change the output.
    const auto narrow = [&](EntityId owner, const std::string& outputKey, const std::vector<CompiledBinding>& bindings, std::vector<unsigned char>& used) {
        if (!providers) return;
        const auto declared = providers->programOutputDependencies(owner, outputKey);
        if (!declared) return;
        for (std::size_t binding = 0; binding < bindings.size(); ++binding) {
            if (std::find(declared->begin(), declared->end(), bindings[binding].symbol) == declared->end()) used[binding] = 0;
        }
    };
    for (std::size_t index = 0; index < plan.nodes.size(); ++index) {
        const auto& wholeNode = whole.nodes[index];
        if (wholeNode.stepped) continue;
        const auto& node = plan.nodes[index];
        for (const auto& task : wholeNode.stageNode.contributions) {
            const auto output = node.stateIndexes.at(task.outputStateIndex);
            auto used = usedBindings(task);
            if (task.programVersion == 2) narrow(task.sourceId, task.providerOutputKey, task.bindings, used);
            for (std::size_t binding = 0; binding < task.bindings.size(); ++binding) {
                const auto state = used[binding] ? boundState(node, task.bindings[binding]) : std::numeric_limits<std::size_t>::max();
                if (state != std::numeric_limits<std::size_t>::max()) reads[output].push_back(state);
            }
        }
        if (const auto& provider = wholeNode.stageNode.nodeProvider) {
            for (const auto& output : provider->outputs) {
                if (output.setsValue) continue;
                std::vector<unsigned char> used(provider->bindings.size(), 1);
                if (provider->programVersion == 2) narrow(node.nodeId, output.key, provider->bindings, used);
                for (std::size_t index = 0; index < provider->bindings.size(); ++index) {
                    if (!used[index]) continue;
                    const auto& binding = provider->bindings[index];
                    const auto state = boundState(node, binding);
                    if (state != std::numeric_limits<std::size_t>::max()) reads[node.stateIndexes.at(output.stateIndex)].push_back(state);
                }
            }
        }
    }
    for (auto& list : reads) {
        std::sort(list.begin(), list.end());
        list.erase(std::unique(list.begin(), list.end()), list.end());
    }
    return reads;
}

bool stagesReadTime(const ExecutionPlan& plan, const WholeModelPlan& whole) {
    for (std::size_t index = 0; index < plan.nodes.size(); ++index) {
        const auto& wholeNode = whole.nodes[index];
        if (wholeNode.stepped) continue;
        if (wholeNode.stageNode.nodeProvider) return true;
        for (const auto& task : wholeNode.stageNode.contributions) {
            if (task.implementation != ContributionImplementation::equation) return true;
            const auto used = usedBindings(task);
            for (std::size_t binding = 0; binding < task.bindings.size(); ++binding) {
                if (!used[binding]) continue;
                const auto& compiled = task.bindings[binding];
                if (compiled.source == BindingSource::simulationTime) return true;
                if (compiled.source == BindingSource::parameter && compiled.parameterIndex < task.parameters.size() &&
                    task.parameters[compiled.parameterIndex].schedule) return true;
            }
        }
    }
    return false;
}

NodeStageResult evaluateNodeStage(const NodeExecutionPlan& node, const WholeModelNode& stageNode, const StateValues& stageStates,
                                  const EntityValues& liveParameterValues, const std::vector<ParameterSchedule>& activeSchedules,
                                  double stageTime, double stepSize, bool evaluateHeld, double heldStepSize,
                                  std::vector<EvaluatedContribution>& held, ProviderEvaluator* providerEvaluator,
                                  const std::vector<double>* latches) {
    NodeStageResult result;
    evaluateNodeStageInto(node, stageNode, stageStates, liveParameterValues, activeSchedules, stageTime, stepSize, evaluateHeld, heldStepSize,
        held, providerEvaluator, latches, result);
    return result;
}

void shareStageTime(std::vector<NodeStageResult>& results, const std::vector<bool>& evaluated, std::uint64_t stageNanoseconds) {
    thread_local std::vector<std::uint64_t> weights, shares;
    weights.resize(results.size());
    shares.resize(results.size());
    for (std::size_t index = 0; index < results.size(); ++index) {
        weights[index] = results[index].evaluatedContributions;
        shares[index] = results[index].computeNanoseconds;
    }
    shareMeasuredTime(weights, evaluated, stageNanoseconds, shares);
    for (std::size_t index = 0; index < results.size(); ++index) results[index].computeNanoseconds = shares[index];
}

namespace {
// What one stage of one node needs in passing, kept per thread so a stage allocates nothing once each buffer has grown to the
// largest node's size. Every buffer is overwritten before it is read.
struct StageScratch {
    StateValues localStates;
    NodeParameterValues parameters;
    std::vector<double> providerParameters;
    std::vector<EvaluatedContribution> evaluated;
    std::vector<std::vector<double>> symbolsByTask;
};
}

void evaluateNodeStageInto(const NodeExecutionPlan& node, const WholeModelNode& stageNode, const StateValues& stageStates,
                           const EntityValues& liveParameterValues, const std::vector<ParameterSchedule>& activeSchedules,
                           double stageTime, double stepSize, bool evaluateHeld, double heldStepSize,
                           std::vector<EvaluatedContribution>& held, ProviderEvaluator* providerEvaluator,
                           const std::vector<double>* latches, NodeStageResult& result, bool timeNode) {
    const auto startedAt = timeNode ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
    thread_local StageScratch scratch;
    if (evaluateHeld) held.clear();
    // The compiled kernel, when the node has one and holds nothing: the same derivatives without the bookkeeping.
    if (stageNode.kernel && held.empty()) {
        const auto& stage = stageNode.stageNode;
        if (stageNode.kernel->hasParameters) {
            resolveParameterValuesInto(stage.contributions, liveParameterValues, activeSchedules, stageTime, scratch.parameters);
        }
        result.evaluatedContributions = evaluateNodeStageKernel(*stageNode.kernel, stage, stageStates, scratch.parameters, stageTime, latches,
            result.derivatives);
        result.computeNanoseconds = timeNode ? static_cast<std::uint64_t>(std::max<std::int64_t>(0,
            std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - startedAt).count())) : 0;
        return;
    }
    auto& localStates = scratch.localStates;
    localStates.resize(node.stateIndexes.size());
    for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) localStates[index] = stageStates[node.stateIndexes[index]];
    if (evaluateHeld) {
        held.clear();
        if (!stageNode.heldNode.contributions.empty()) {
            resolveParameterValuesInto(stageNode.heldNode.contributions, liveParameterValues, activeSchedules, stageTime, scratch.parameters);
            evaluateContributionTasksInto(stageNode.heldNode, localStates, stageStates, scratch.parameters, stageTime, heldStepSize, providerEvaluator,
                nullptr, nullptr, nullptr, held, scratch.symbolsByTask);
        }
    }
    const auto& stage = stageNode.stageNode;
    resolveParameterValuesInto(stage.contributions, liveParameterValues, activeSchedules, stageTime, scratch.parameters);
    static const std::vector<double> noProviderParameters;
    const std::vector<double>* providerParameters = &noProviderParameters;
    if (stage.nodeProvider && !stage.nodeProvider->parameters.empty()) {
        scratch.providerParameters = resolveNodeProviderParameterValues(*stage.nodeProvider, liveParameterValues, activeSchedules, stageTime);
        providerParameters = &scratch.providerParameters;
    }
    auto& evaluated = scratch.evaluated;
    evaluateContributionTasksInto(stage, localStates, stageStates, scratch.parameters, stageTime, stepSize, providerEvaluator, nullptr,
        providerParameters, latches, evaluated, scratch.symbolsByTask);
    // A provider's outputs come after every contribution of the node, as node by node orders them, held contributions included.
    const auto shift = node.contributions.size() - stage.contributions.size();
    for (auto& contribution : evaluated) if (contribution.sequence >= stage.contributions.size()) contribution.sequence += shift;
    result.evaluatedContributions = evaluated.size();
    evaluated.insert(evaluated.end(), held.begin(), held.end());
    reduceContributionsInto(evaluated, result.derivatives);
    result.computeNanoseconds = timeNode ? static_cast<std::uint64_t>(std::max<std::int64_t>(0,
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - startedAt).count())) : 0;
}

}
