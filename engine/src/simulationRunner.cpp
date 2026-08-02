/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "simulationRunner.hpp"
#include <boost/property_tree/json_parser.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <random>
#include <set>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <unordered_map>
#include <vector>

namespace konjugate {
namespace {
using Values = std::unordered_map<std::string, double>;
struct Sample { double time; Values states; };
struct Checkpoint { std::string uuid; double time; Values states; };
struct Pacing { std::string mode = "fastest"; double ratio = 1; };
struct RunControl { Pacing pacing; std::string executionState = "running"; };

std::string value(const boost::property_tree::ptree& tree, const std::string& key) {
    return tree.get<std::string>(key, "");
}

double number(const std::string& input) {
    std::size_t consumed = 0;
    const auto result = std::stod(input, &consumed);
    if (consumed != input.size() || !std::isfinite(result)) throw std::runtime_error("Expression contains a non-finite number.");
    return result;
}

std::string createUuid() {
    static thread_local std::mt19937_64 generator(std::random_device{}());
    std::uniform_int_distribution<unsigned int> octet(0, 255);
    unsigned int bytes[16];
    for (auto& byte : bytes) byte = octet(generator);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    std::ostringstream value;
    value << std::hex << std::setfill('0');
    for (std::size_t index = 0; index < 16; ++index) {
        if (index == 4 || index == 6 || index == 8 || index == 10) value << '-';
        value << std::setw(2) << bytes[index];
    }
    return value.str();
}

double evaluate(const boost::property_tree::ptree& expression, const Values& symbols) {
    if (expression.empty()) {
        const auto token = expression.data();
        if (const auto found = symbols.find(token); found != symbols.end()) return found->second;
        try { return number(token); } catch (...) { throw std::runtime_error("Unknown executable symbol: " + token + "."); }
    }
    std::vector<const boost::property_tree::ptree*> items;
    for (const auto& item : expression) items.push_back(&item.second);
    if (items.empty()) throw std::runtime_error("Expression array is empty.");
    const auto operation = items.front()->data();
    const auto argument = [&](std::size_t index) { return evaluate(*items.at(index + 1), symbols); };
    if (operation == "Add") { double result = 0; for (std::size_t i = 0; i + 1 < items.size(); ++i) result += argument(i); return result; }
    if (operation == "Multiply") { double result = 1; for (std::size_t i = 0; i + 1 < items.size(); ++i) result *= argument(i); return result; }
    if (operation == "Negate") return -argument(0);
    if (operation == "Divide") return argument(0) / argument(1);
    if (operation == "Power") return std::pow(argument(0), argument(1));
    if (operation == "Sqrt") return std::sqrt(argument(0));
    if (operation == "Abs") return std::abs(argument(0));
    if (operation == "Exp") return std::exp(argument(0));
    if (operation == "Ln" || operation == "Log") return std::log(argument(0));
    if (operation == "Sin") return std::sin(argument(0));
    if (operation == "Cos") return std::cos(argument(0));
    if (operation == "Tan") return std::tan(argument(0));
    if (operation == "Min") return std::min(argument(0), argument(1));
    if (operation == "Max") return std::max(argument(0), argument(1));
    throw std::runtime_error("Unsupported executable operation: " + operation + ".");
}

std::string escape(const std::string& input) {
    std::string output;
    for (const char character : input) {
        if (character == '\\' || character == '"') output += '\\';
        output += character;
    }
    return output;
}

void atomicWrite(const std::filesystem::path& path, const std::string& content) {
    const auto temporary = path.string() + ".tmp";
    std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
    if (!stream) throw std::runtime_error("The simulation result could not be created.");
    stream << content;
    stream.close();
    std::error_code error;
    std::filesystem::rename(temporary, path, error);
    if (error) {
        std::filesystem::remove(path, error);
        std::filesystem::rename(temporary, path);
    }
}

Pacing pacingFromTree(const boost::property_tree::ptree& tree, const Pacing& fallback = {}) {
    Pacing pacing;
    pacing.mode = tree.get<std::string>("pacing.mode", tree.get<std::string>("mode", fallback.mode));
    pacing.ratio = tree.get<double>("pacing.simulationSecondsPerWallSecond",
        tree.get<double>("simulationSecondsPerWallSecond", fallback.ratio));
    if (pacing.mode == "realTime") pacing.ratio = 1;
    if (pacing.mode != "fastest" && pacing.mode != "realTime" && pacing.mode != "limitedRatio") {
        throw std::runtime_error("Pacing mode must be fastest, realTime, or limitedRatio.");
    }
    if (pacing.mode == "limitedRatio" && (!(pacing.ratio > 0) || !std::isfinite(pacing.ratio))) {
        throw std::runtime_error("Limited pacing requires a finite positive simulationSecondsPerWallSecond value.");
    }
    return pacing;
}

RunControl readRunControl(const std::filesystem::path& path, const RunControl& current) {
    if (path.empty() || !std::filesystem::exists(path)) return current;
    try {
        boost::property_tree::ptree control;
        boost::property_tree::read_json(path.string(), control);
        const auto executionState = control.get<std::string>("executionState", current.executionState);
        if (executionState != "running" && executionState != "paused" && executionState != "stopped") return current;
        return {pacingFromTree(control, current.pacing), executionState};
    } catch (...) {
        return current;
    }
}
}

void runSimulation(const boost::property_tree::ptree& document,
                   const boost::property_tree::ptree& configuration,
                   const std::filesystem::path& outputPath,
                   const std::filesystem::path& pacingControlPath) {
    const auto targetTime = configuration.get<double>("targetTime");
    const auto globalTimeStep = configuration.get<double>("globalTimeStep", configuration.get<double>("timeStep", 0.01));
    const auto outputInterval = configuration.get<double>("outputInterval", globalTimeStep);
    const auto outputRatio = outputInterval / globalTimeStep;
    auto pacing = pacingFromTree(configuration);
    RunControl runControl{pacing, "running"};
    if (!(targetTime > 0) || !(globalTimeStep > 0) || globalTimeStep > targetTime || !(outputInterval > 0) ||
        !std::isfinite(targetTime) || !std::isfinite(globalTimeStep) || !std::isfinite(outputInterval)) {
        throw std::runtime_error("A run requires a finite positive targetTime and numerical timestep values.");
    }
    if (outputInterval < globalTimeStep || std::abs(outputRatio - std::round(outputRatio)) > 1e-9) {
        throw std::runtime_error("outputInterval must be an integer multiple of globalTimeStep.");
    }

    Values states;
    std::unordered_map<std::string, std::string> stateNodes;
    std::unordered_map<std::string, std::size_t> nodeSubsteps;
    std::unordered_map<std::string, std::vector<std::string>> nodeStates;
    for (const auto& nodeItem : document.get_child("nodes")) {
        const auto nodeId = value(nodeItem.second, "id");
        const auto substeps = nodeItem.second.get<std::size_t>("numerics.substepsPerGlobalStep", 1);
        if (!substeps || substeps > 10000) throw std::runtime_error("Node substepsPerGlobalStep must be an integer from 1 through 10000.");
        nodeSubsteps[nodeId] = substeps;
        for (const auto& stateItem : nodeItem.second.get_child("states")) {
            const auto stateId = value(stateItem.second, "id");
            states[stateId] = stateItem.second.get<double>("initialValue", 0);
            stateNodes[stateId] = nodeId;
            nodeStates[nodeId].push_back(stateId);
        }
    }

    double startTime = 0;
    if (const auto checkpoint = configuration.get_child_optional("startCheckpoint")) {
        startTime = checkpoint->get<double>("time");
        std::set<std::string> restored;
        for (const auto& stateItem : checkpoint->get_child("states")) {
            const auto stateId = value(stateItem.second, "stateId");
            if (!states.contains(stateId) || !restored.insert(stateId).second) throw std::runtime_error("The restart checkpoint does not match the model state vector.");
            states[stateId] = stateItem.second.get<double>("value");
        }
        if (restored.size() != states.size()) throw std::runtime_error("The restart checkpoint is missing model states.");
    }
    if (!(startTime >= 0) || !(targetTime > startTime)) throw std::runtime_error("targetTime must be later than the restart checkpoint.");

    std::vector<std::string> stateIds;
    for (const auto& item : states) stateIds.push_back(item.first);
    std::sort(stateIds.begin(), stateIds.end());
    std::vector<std::string> nodeIds;
    for (const auto& item : nodeSubsteps) nodeIds.push_back(item.first);
    std::sort(nodeIds.begin(), nodeIds.end());

    const auto steps = static_cast<std::size_t>(std::ceil((targetTime - startTime) / globalTimeStep));
    std::vector<Sample> samples = {{startTime, states}};
    std::vector<Checkpoint> checkpoints = {{createUuid(), startTime, states}};
    const auto streamPath = std::filesystem::path(outputPath.string() + ".stream");
    std::ofstream resultStream(streamPath, std::ios::binary | std::ios::trunc);
    if (!resultStream) throw std::runtime_error("The live result stream could not be created.");
    const auto appendStreamRecord = [&](const std::string& type, double time, const Values& recordStates, const std::string& uuid = {}) {
        resultStream << std::setprecision(17) << "{\"type\":\"" << type << "\",\"time\":" << time;
        if (!uuid.empty()) resultStream << ",\"uuid\":\"" << uuid << "\",\"solver\":{\"kind\":\"explicitEuler\",\"version\":1}";
        resultStream << ",\"states\":[";
        for (std::size_t stateIndex = 0; stateIndex < stateIds.size(); ++stateIndex) {
            if (stateIndex) resultStream << ',';
            const auto& stateId = stateIds[stateIndex];
            resultStream << "{\"stateId\":\"" << escape(stateId) << "\",\"value\":" << recordStates.at(stateId) << '}';
        }
        resultStream << "]}\n";
    };
    appendStreamRecord("sample", startTime, states);
    appendStreamRecord("checkpoint", startTime, states, checkpoints.front().uuid);
    double currentTime = startTime;
    const auto captureBoundary = [&]() {
        if (currentTime > samples.back().time + 1e-12) {
            samples.push_back({currentTime, states});
            appendStreamRecord("sample", currentTime, states);
        }
        if (currentTime > checkpoints.back().time + 1e-12) {
            checkpoints.push_back({createUuid(), currentTime, states});
            appendStreamRecord("checkpoint", currentTime, states, checkpoints.back().uuid);
        }
    };
    const auto writeResult = [&](const std::string& lifecycle, double simulationTime, bool completeSnapshot = false) {
        resultStream.flush();
        std::ostringstream json;
        json << std::setprecision(17) << "{\"resultVersion\":1,\"engineVersion\":\"0.2.0\",\"configurationName\":\""
             << escape(configuration.get<std::string>("name", "Untitled")) << "\",\"snapshotMode\":\"" << (completeSnapshot ? "full" : "live")
             << "\",\"lifecycle\":\"" << lifecycle
             << "\",\"simulationTime\":" << simulationTime << ",\"availableResultTime\":" << samples.back().time
             << ",\"pacing\":{\"mode\":\"" << escape(pacing.mode) << "\",\"simulationSecondsPerWallSecond\":" << pacing.ratio << "}"
             << ",\"targetTime\":" << targetTime << ",\"globalTimeStep\":" << globalTimeStep << ",\"outputInterval\":" << outputInterval
             << ",\"globalSteps\":" << steps << ",\"nodeTimesteps\":[";
        for (std::size_t index = 0; index < nodeIds.size(); ++index) {
            if (index) json << ',';
            const auto& nodeId = nodeIds[index];
            json << "{\"nodeId\":\"" << escape(nodeId) << "\",\"substepsPerGlobalStep\":" << nodeSubsteps.at(nodeId)
                 << ",\"effectiveTimeStep\":" << globalTimeStep / static_cast<double>(nodeSubsteps.at(nodeId)) << '}';
        }
        json << "],\"states\":[";
        for (std::size_t index = 0; index < stateIds.size(); ++index) {
            if (index) json << ',';
            const auto& stateId = stateIds[index];
            json << "{\"nodeId\":\"" << escape(stateNodes.at(stateId)) << "\",\"stateId\":\"" << escape(stateId)
                 << "\",\"value\":" << states.at(stateId) << '}';
        }
        json << "],\"samples\":[";
        for (std::size_t sampleIndex = 0; completeSnapshot && sampleIndex < samples.size(); ++sampleIndex) {
            if (sampleIndex) json << ',';
            json << "{\"time\":" << samples[sampleIndex].time << ",\"states\":[";
            for (std::size_t stateIndex = 0; stateIndex < stateIds.size(); ++stateIndex) {
                if (stateIndex) json << ',';
                const auto& stateId = stateIds[stateIndex];
                json << "{\"stateId\":\"" << escape(stateId) << "\",\"value\":" << samples[sampleIndex].states.at(stateId) << '}';
            }
            json << "]}";
        }
        json << "],\"checkpoints\":[";
        for (std::size_t checkpointIndex = 0; completeSnapshot && checkpointIndex < checkpoints.size(); ++checkpointIndex) {
            if (checkpointIndex) json << ',';
            const auto& checkpoint = checkpoints[checkpointIndex];
            json << "{\"uuid\":\"" << checkpoint.uuid << "\",\"time\":" << checkpoint.time
                 << ",\"solver\":{\"kind\":\"explicitEuler\",\"version\":1},\"states\":[";
            for (std::size_t stateIndex = 0; stateIndex < stateIds.size(); ++stateIndex) {
                if (stateIndex) json << ',';
                const auto& stateId = stateIds[stateIndex];
                json << "{\"stateId\":\"" << escape(stateId) << "\",\"value\":" << checkpoint.states.at(stateId) << '}';
            }
            json << "]}";
        }
        json << "]}";
        atomicWrite(outputPath, json.str());
    };
    writeResult("running", startTime);
    auto lastPublishedAt = std::chrono::steady_clock::now();
    auto lastControlReadAt = std::chrono::steady_clock::now() - std::chrono::seconds(1);
    const auto refreshRunControl = [&](bool force = false) {
        const auto now = std::chrono::steady_clock::now();
        if (force || now - lastControlReadAt >= std::chrono::milliseconds(10)) {
            runControl = readRunControl(pacingControlPath, runControl);
            lastControlReadAt = now;
        }
    };
    auto nextOutputTime = startTime + outputInterval;
    for (std::size_t step = 0; step < steps; ++step) {
        refreshRunControl();
        pacing = runControl.pacing;
        if (runControl.executionState == "paused") {
            captureBoundary();
            writeResult("paused", currentTime);
            while (runControl.executionState == "paused") {
                std::this_thread::sleep_for(std::chrono::milliseconds(40));
                refreshRunControl(true);
            }
            pacing = runControl.pacing;
            if (runControl.executionState == "stopped") {
                writeResult("stopped", currentTime, true);
                resultStream.close();
                std::filesystem::remove(streamPath);
                return;
            }
            writeResult("running", currentTime);
        } else if (runControl.executionState == "stopped") {
            captureBoundary();
            writeResult("stopped", currentTime, true);
            resultStream.close();
            std::filesystem::remove(streamPath);
            return;
        }
        const auto wallStepStarted = std::chrono::steady_clock::now();
        const auto synchronizationStep = std::min(globalTimeStep, targetTime - startTime - static_cast<double>(step) * globalTimeStep);
        const auto snapshot = states;
        auto synchronizedStates = snapshot;
        for (const auto& nodeItem : document.get_child("nodes")) {
            const auto& node = nodeItem.second;
            const auto nodeId = value(node, "id");
            auto localStates = snapshot;
            const auto substeps = nodeSubsteps.at(nodeId);
            const auto nodeTimeStep = synchronizationStep / static_cast<double>(substeps);
            for (std::size_t substep = 0; substep < substeps; ++substep) {
                Values derivatives;
                for (const auto& termItem : node.get_child("sourceTerms")) {
                    const auto& term = termItem.second;
                    Values symbols;
                    for (const auto& bindingItem : term.get_child("expressionModel.bindings")) {
                        symbols[value(bindingItem.second, "symbol")] = localStates.at(value(bindingItem.second, "stateId"));
                    }
                    const auto outputState = value(term, "expressionModel.output.stateId");
                    const auto contribution = evaluate(term.get_child("expressionModel.mathJson"), symbols);
                    if (!std::isfinite(contribution)) throw std::runtime_error("A source term produced a non-finite derivative.");
                    derivatives[outputState] += contribution;
                }
                for (const auto& edgeItem : document.get_child("edges")) {
                    const auto& edge = edgeItem.second;
                    const auto outputState = value(edge, "equationModel.output.stateId");
                    if (stateNodes.at(outputState) != nodeId) continue;
                    Values symbols;
                    std::unordered_map<std::string, double> parameters;
                    for (const auto& parameterItem : edge.get_child("parameters")) {
                        parameters[value(parameterItem.second, "id")] = parameterItem.second.get<double>("value", 0);
                    }
                    for (const auto& bindingItem : edge.get_child("equationModel.bindings")) {
                        const auto& binding = bindingItem.second;
                        const auto symbol = value(binding, "symbol");
                        if (value(binding, "kind") == "parameter") symbols[symbol] = parameters.at(value(binding, "parameterId"));
                        else {
                            const auto stateId = value(binding, "stateId");
                            symbols[symbol] = value(binding, "nodeId") == nodeId ? localStates.at(stateId) : snapshot.at(stateId);
                        }
                    }
                    const auto contribution = evaluate(edge.get_child("equationModel.mathJson"), symbols);
                    if (!std::isfinite(contribution)) throw std::runtime_error("An equation produced a non-finite derivative.");
                    derivatives[outputState] += contribution;
                }
                for (const auto& derivative : derivatives) localStates.at(derivative.first) += nodeTimeStep * derivative.second;
            }
            for (const auto& stateId : nodeStates.at(nodeId)) synchronizedStates[stateId] = localStates.at(stateId);
        }
        states = std::move(synchronizedStates);
        const auto elapsed = std::min(targetTime, startTime + static_cast<double>(step + 1) * globalTimeStep);
        currentTime = elapsed;
        while (pacing.mode != "fastest") {
            const auto targetDuration = std::chrono::duration<double>(synchronizationStep / pacing.ratio);
            const auto spent = std::chrono::steady_clock::now() - wallStepStarted;
            if (spent >= targetDuration) break;
            const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(targetDuration - spent);
            std::this_thread::sleep_for(std::min(remaining, std::chrono::milliseconds(20)));
            refreshRunControl(true);
            pacing = runControl.pacing;
            if (runControl.executionState != "running") break;
        }
        if (elapsed + 1e-12 >= nextOutputTime || step + 1 == steps) {
            samples.push_back({elapsed, states});
            appendStreamRecord("sample", elapsed, states);
            if (step + 1 == steps && elapsed > checkpoints.back().time + 1e-12) {
                checkpoints.push_back({createUuid(), elapsed, states});
                appendStreamRecord("checkpoint", elapsed, states, checkpoints.back().uuid);
            }
            while (nextOutputTime <= elapsed + 1e-12) nextOutputTime += outputInterval;
            const auto publicationTime = std::chrono::steady_clock::now();
            if (step + 1 == steps || publicationTime - lastPublishedAt >= std::chrono::milliseconds(250)) {
                writeResult(step + 1 == steps ? "completed" : "running", elapsed, step + 1 == steps);
                lastPublishedAt = publicationTime;
            }
        }
    }
    resultStream.close();
    std::filesystem::remove(streamPath);
}

}
