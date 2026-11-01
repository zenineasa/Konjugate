/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "parameterFitting.hpp"
#include "nloptBackend.hpp"
#include "simulationRunner.hpp"
#include "engineProtocol.pb.h"
#include <boost/property_tree/json_parser.hpp>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <limits>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace konjugate {
namespace {

boost::property_tree::ptree& childAt(boost::property_tree::ptree& parent, std::size_t index) {
    auto iterator = parent.begin();
    std::advance(iterator, static_cast<std::ptrdiff_t>(index));
    return iterator->second;
}

std::unique_ptr<OptimizerBackend> createOptimizerBackend(const std::string& backendId) {
    if (backendId.starts_with("nlopt-")) return createNloptBackend(backendId);
    throw std::invalid_argument("Unrecognized optimizer backend id: " + backendId);
}

std::uint32_t readUint32BigEndian(const std::string& content, std::size_t offset) {
    if (offset + 4 > content.size()) throw std::runtime_error("The fitting trial's result file is truncated.");
    return (static_cast<std::uint32_t>(static_cast<unsigned char>(content[offset])) << 24) |
        (static_cast<std::uint32_t>(static_cast<unsigned char>(content[offset + 1])) << 16) |
        (static_cast<std::uint32_t>(static_cast<unsigned char>(content[offset + 2])) << 8) |
        static_cast<std::uint32_t>(static_cast<unsigned char>(content[offset + 3]));
}

}

// Minimal reader for the binary result format described in docs/resultFileFormat.md, built
// specifically for the fitting loop's own needs (just the packed samples, nothing about
// checkpoints or execution metadata) rather than a general-purpose result reader -- deliberately
// separate from runSimulation()'s own writer so the well-exercised `run` path stays untouched.
// Reads the trailing index first (footer magic "KJIX", then its own length, then the ResultIndex
// payload), exactly mirroring how the writer appends it -- see simulationRunner.cpp's
// writeResult().
SimulationSamples readSimulationSamples(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw std::runtime_error("The fitting trial's result file could not be opened.");
    std::ostringstream buffer;
    buffer << stream.rdbuf();
    const std::string content = buffer.str();
    if (content.size() < 8 || content.compare(0, 4, "KJR\x02", 4) != 0) {
        throw std::runtime_error("The fitting trial's result file is not a recognized result container.");
    }

    const auto headerLength = readUint32BigEndian(content, 4);
    protocol::ResultFile header;
    if (8 + headerLength > content.size() || !header.ParseFromArray(content.data() + 8, static_cast<int>(headerLength))) {
        throw std::runtime_error("The fitting trial's result header could not be parsed.");
    }

    if (content.compare(content.size() - 4, 4, "KJIX") != 0) {
        throw std::runtime_error("The fitting trial's result file is missing its footer.");
    }
    const auto indexLengthOffset = content.size() - 8;
    const auto indexLength = readUint32BigEndian(content, indexLengthOffset);
    if (indexLength > indexLengthOffset) throw std::runtime_error("The fitting trial's result index length is invalid.");
    const auto indexPayloadOffset = indexLengthOffset - indexLength;
    protocol::ResultIndex index;
    if (!index.ParseFromArray(content.data() + indexPayloadOffset, static_cast<int>(indexLength))) {
        throw std::runtime_error("The fitting trial's result index could not be parsed.");
    }

    SimulationSamples result;
    result.stateIds.reserve(static_cast<std::size_t>(header.state_table().states_size()));
    for (const auto& descriptor : header.state_table().states()) result.stateIds.push_back(descriptor.state_id());

    for (const auto& batchEntry : index.batches()) {
        // batchEntry.offset() is where the frame's own 4-byte length prefix begins (see
        // writeResult() in simulationRunner.cpp: set_offset(container.size()) is recorded before
        // appendLength()+payload are appended) -- the payload itself starts 4 bytes after that.
        const auto payloadOffset = batchEntry.offset() + 4;
        if (payloadOffset + batchEntry.length() > content.size()) {
            throw std::runtime_error("A fitting trial's result sample batch is out of bounds.");
        }
        protocol::SampleBatch batch;
        if (!batch.ParseFromArray(content.data() + payloadOffset, static_cast<int>(batchEntry.length()))) {
            throw std::runtime_error("A fitting trial's result sample batch could not be parsed.");
        }
        const auto stateCount = static_cast<std::size_t>(batch.state_count());
        for (int sampleIndex = 0; sampleIndex < batch.times_size(); ++sampleIndex) {
            result.times.push_back(batch.times(sampleIndex));
            std::vector<double> row(stateCount);
            for (std::size_t stateIndex = 0; stateIndex < stateCount; ++stateIndex) {
                row[stateIndex] = batch.values(static_cast<int>(static_cast<std::size_t>(sampleIndex) * stateCount + stateIndex));
            }
            result.valuesByTime.push_back(std::move(row));
        }
    }
    return result;
}

std::vector<TunableParameter> findTunableParameters(const boost::property_tree::ptree& document) {
    std::vector<TunableParameter> found;
    if (const auto sharedParameters = document.get_child_optional("sharedParameters")) {
        std::size_t sharedIndex = 0;
        for (const auto& sharedEntry : *sharedParameters) {
            const auto& parameter = sharedEntry.second;
            if (parameter.get_child_optional("tuning")) {
                TunableParameter tunable;
                tunable.shared = true;
                tunable.sharedIndex = sharedIndex;
                tunable.parameterId = parameter.get<std::uint64_t>("id");
                tunable.name = parameter.get<std::string>("name", "");
                tunable.initialValue = parameter.get<double>("value");
                tunable.bounds.minimum = parameter.get<double>("tuning.minimum");
                tunable.bounds.maximum = parameter.get<double>("tuning.maximum");
                found.push_back(std::move(tunable));
            }
            ++sharedIndex;
        }
    }
    const auto edgesOptional = document.get_child_optional("edges");
    std::size_t edgeIndex = 0;
    if (edgesOptional) for (const auto& edgeEntry : *edgesOptional) {
        const auto& edge = edgeEntry.second;
        if (const auto parameterList = edge.get_child_optional("parameters")) {
            std::size_t parameterIndex = 0;
            for (const auto& parameterEntry : *parameterList) {
                const auto& parameter = parameterEntry.second;
                if (parameter.get_child_optional("tuning")) {
                    TunableParameter tunable;
                    tunable.edgeIndex = edgeIndex;
                    tunable.parameterIndex = parameterIndex;
                    tunable.parameterId = parameter.get<std::uint64_t>("id");
                    tunable.name = parameter.get<std::string>("name", "");
                    tunable.initialValue = parameter.get<double>("value");
                    tunable.bounds.minimum = parameter.get<double>("tuning.minimum");
                    tunable.bounds.maximum = parameter.get<double>("tuning.maximum");
                    found.push_back(std::move(tunable));
                }
                ++parameterIndex;
            }
        }
        ++edgeIndex;
    }
    if (const auto nodes = document.get_child_optional("nodes")) {
        std::size_t nodeIndex = 0;
        for (const auto& nodeEntry : *nodes) {
            std::size_t sourceTermIndex = 0;
            if (const auto terms = nodeEntry.second.get_child_optional("sourceTerms")) for (const auto& termEntry : *terms) {
                std::size_t parameterIndex = 0;
                if (const auto parameters = termEntry.second.get_child_optional("parameters")) for (const auto& parameterEntry : *parameters) {
                    const auto& parameter = parameterEntry.second;
                    if (parameter.get_child_optional("tuning")) {
                        TunableParameter tunable;
                        tunable.sourceTerm = true;
                        tunable.nodeIndex = nodeIndex;
                        tunable.sourceTermIndex = sourceTermIndex;
                        tunable.parameterIndex = parameterIndex;
                        tunable.parameterId = parameter.get<std::uint64_t>("id");
                        tunable.name = parameter.get<std::string>("name", "");
                        tunable.initialValue = parameter.get<double>("value");
                        tunable.bounds.minimum = parameter.get<double>("tuning.minimum");
                        tunable.bounds.maximum = parameter.get<double>("tuning.maximum");
                        found.push_back(std::move(tunable));
                    }
                    ++parameterIndex;
                }
                ++sourceTermIndex;
            }
            ++nodeIndex;
        }
    }
    return found;
}

std::vector<FittingSignalMapping> autoMapColumnsToStates(const std::vector<std::string>& csvColumnNames,
    const boost::property_tree::ptree& document) {
    const auto lowercase = [](std::string text) {
        std::transform(text.begin(), text.end(), text.begin(), [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
        return text;
    };
    std::vector<FittingSignalMapping> mapping;
    const auto nodesOptional = document.get_child_optional("nodes");
    if (!nodesOptional) return mapping;
    for (const auto& columnName : csvColumnNames) {
        const auto normalizedColumn = lowercase(columnName);
        // "Node — State (unit)" is the heading Konjugate's own CSV export writes; it names one state
        // unambiguously even when several nodes share state names. A trailing "(unit)" is ignored.
        auto qualifiedColumn = normalizedColumn;
        if (!qualifiedColumn.empty() && qualifiedColumn.back() == ')') {
            const auto open = qualifiedColumn.rfind('(');
            if (open != std::string::npos) {
                qualifiedColumn.erase(open);
                while (!qualifiedColumn.empty() && qualifiedColumn.back() == ' ') qualifiedColumn.pop_back();
            }
        }
        bool matched = false;
        for (const auto& nodeEntry : *nodesOptional) {
            if (matched) break;
            const auto statesOptional = nodeEntry.second.get_child_optional("states");
            if (!statesOptional) continue;
            const auto nodeName = lowercase(nodeEntry.second.get<std::string>("name", ""));
            for (const auto& stateEntry : *statesOptional) {
                const auto& state = stateEntry.second;
                const auto symbol = lowercase(state.get<std::string>("symbol", ""));
                const auto name = lowercase(state.get<std::string>("name", ""));
                if (normalizedColumn == symbol || normalizedColumn == name ||
                    (!nodeName.empty() && qualifiedColumn == nodeName + " \xE2\x80\x94 " + name)) {
                    mapping.push_back({columnName, state.get<std::uint64_t>("id"), 1.0});
                    matched = true;
                    break;
                }
            }
        }
    }
    return mapping;
}

void loadFittingObjective(const std::filesystem::path& path, FittingProblem& problem) {
    boost::property_tree::ptree objective;
    boost::property_tree::read_json(path.string(), objective);
    problem.objective = objective.get<std::string>("expression");
    problem.maximize = objective.get<std::string>("direction", "minimise") == "maximise";
    problem.targetTime = objective.get<double>("targetTime", 0.0);
    problem.timeStep = objective.get<double>("timeStep", 0.0);
    if (const auto constraints = objective.get_child_optional("constraints")) for (const auto& entry : *constraints) {
        FittingConstraint constraint;
        constraint.expression = entry.second.get<std::string>("expression");
        constraint.atMost = entry.second.get<std::string>("relation", "<=") != ">=";
        constraint.limit = entry.second.get<double>("limit");
        problem.constraints.push_back(std::move(constraint));
    }
    if (const auto variables = objective.get_child_optional("variables")) for (const auto& entry : *variables) {
        ObjectiveVariable variable;
        variable.name = entry.second.get<std::string>("name");
        const auto kind = entry.second.get<std::string>("kind");
        variable.kind = kind == "state" ? ObjectiveVariable::Kind::state
            : kind == "measured" ? ObjectiveVariable::Kind::measured : ObjectiveVariable::Kind::parameter;
        variable.id = entry.second.get<std::uint64_t>("id", 0);
        variable.column = entry.second.get<std::string>("column", "");
        variable.value = entry.second.get<double>("value", 0.0);
        problem.objectiveVariables.push_back(std::move(variable));
    }
}

void checkFittingObjective(const FittingProblem& problem) {
    if (problem.objective.empty()) return;
    FittingObjective(problem.objective, problem.objectiveVariables);
    for (const auto& constraint : problem.constraints) FittingObjective(constraint.expression, problem.objectiveVariables);
}

double evaluateFittingLoss(const FittingProblem& problem, const std::vector<double>& parameterValues,
    const std::filesystem::path& scratchOutputPath) {
    return evaluateFittingTrial(problem, parameterValues, scratchOutputPath).objective;
}

FittingTrialScore evaluateFittingTrial(const FittingProblem& problem, const std::vector<double>& parameterValues,
    const std::filesystem::path& scratchOutputPath) {
    // ptree assignment is a deep copy -- each trial gets its own document, the base is untouched.
    boost::property_tree::ptree document = problem.baseDocument;
    auto& edges = document.get_child("edges");
    auto& nodes = document.get_child("nodes");
    for (std::size_t index = 0; index < problem.tunableParameters.size(); ++index) {
        const auto& tunable = problem.tunableParameters[index];
        if (tunable.shared) {
            childAt(document.get_child("sharedParameters"), tunable.sharedIndex).put("value", parameterValues[index]);
            continue;
        }
        auto& parameters = tunable.sourceTerm
            ? childAt(childAt(nodes, tunable.nodeIndex).get_child("sourceTerms"), tunable.sourceTermIndex).get_child("parameters")
            : childAt(edges, tunable.edgeIndex).get_child("parameters");
        childAt(parameters, tunable.parameterIndex).put("value", parameterValues[index]);
    }

    const bool useObjective = !problem.objective.empty();
    const auto rowCount = problem.measured.rows.size();
    boost::property_tree::ptree configuration;
    if (useObjective) {
        if (!(problem.targetTime > 0.0) || !(problem.timeStep > 0.0)) throw std::runtime_error("An objective needs a run length and a time step above zero.");
        configuration.put("targetTime", problem.targetTime);
        configuration.put("globalTimeStep", problem.timeStep);
        configuration.put("outputInterval", problem.timeStep);
    } else {
        if (rowCount < 2) throw std::runtime_error("The measured series needs at least two rows to define a fitting run's duration.");
        configuration.put("targetTime", problem.measured.timeStep * static_cast<double>(rowCount - 1));
        configuration.put("globalTimeStep", problem.measured.timeStep);
        configuration.put("outputInterval", problem.measured.timeStep);
    }

    runSimulation(document, configuration, scratchOutputPath);
    const auto samples = readSimulationSamples(scratchOutputPath);

    if (useObjective) {
        ObjectiveData data;
        data.times = samples.times;
        for (std::size_t column = 0; column < samples.stateIds.size(); ++column) {
            auto& series = data.states[samples.stateIds[column]];
            series.reserve(samples.valuesByTime.size());
            for (const auto& row : samples.valuesByTime) series.push_back(row[column]);
        }
        for (std::size_t column = 0; column < problem.measured.columnNames.size(); ++column) {
            auto& series = data.measured[problem.measured.columnNames[column]];
            for (const auto& row : problem.measured.rows) series.push_back(row[column]);
        }
        for (std::size_t index = 0; index < problem.tunableParameters.size(); ++index) {
            data.parameters[problem.tunableParameters[index].parameterId] = parameterValues[index];
        }
        const double value = FittingObjective(problem.objective, problem.objectiveVariables).evaluate(data);
        FittingTrialScore score;
        score.objective = problem.maximize ? -value : value;
        for (const auto& constraint : problem.constraints) {
            const double reached = FittingObjective(constraint.expression, problem.objectiveVariables).evaluate(data);
            const double excess = constraint.atMost ? reached - constraint.limit : constraint.limit - reached;
            // Relative to the limit; against the size of the value itself when the limit is zero, which has no size to be relative to.
            const double scale = constraint.limit != 0.0 ? std::abs(constraint.limit) : std::max(1.0, std::abs(reached));
            const double relative = std::isnan(excess) ? std::numeric_limits<double>::infinity() : std::max(0.0, excess) / scale;
            score.violationSquares += relative * relative;
            score.worstViolation = std::max(score.worstViolation, relative);
        }
        return score;
    }

    // Resolve each mapping's simulated-state column index and measured-CSV column index once,
    // outside the row loop below, rather than searching per row.
    std::vector<std::size_t> stateIndexByMapping(problem.mapping.size());
    std::vector<std::size_t> csvColumnIndexByMapping(problem.mapping.size());
    for (std::size_t mappingIndex = 0; mappingIndex < problem.mapping.size(); ++mappingIndex) {
        const auto& mapping = problem.mapping[mappingIndex];
        const auto stateIt = std::find(samples.stateIds.begin(), samples.stateIds.end(), mapping.stateId);
        if (stateIt == samples.stateIds.end()) throw std::runtime_error("A mapped signal's state did not appear in the simulated result.");
        stateIndexByMapping[mappingIndex] = static_cast<std::size_t>(std::distance(samples.stateIds.begin(), stateIt));
        const auto columnIt = std::find(problem.measured.columnNames.begin(), problem.measured.columnNames.end(), mapping.csvColumnName);
        if (columnIt == problem.measured.columnNames.end()) throw std::runtime_error("A mapped CSV column was not found in the measured series.");
        csvColumnIndexByMapping[mappingIndex] = static_cast<std::size_t>(std::distance(problem.measured.columnNames.begin(), columnIt));
    }

    // Paired by row index, not by searching for the nearest timestamp -- both grids were built
    // from the same step size and start time (see runParameterFit()/this function's own
    // configuration above), so row i of the CSV and sample i of the simulation are the same
    // instant by construction. Clamped to the shorter of the two as a defensive measure against a
    // boundary-condition off-by-one in the simulation's own output cadence, not because the
    // counts are expected to differ.
    const auto pairedRowCount = std::min(rowCount, samples.valuesByTime.size());
    double totalLoss = 0.0;
    for (std::size_t row = 0; row < pairedRowCount; ++row) {
        for (std::size_t mappingIndex = 0; mappingIndex < problem.mapping.size(); ++mappingIndex) {
            const double measuredValue = problem.measured.rows[row][csvColumnIndexByMapping[mappingIndex]];
            const double simulatedValue = samples.valuesByTime[row][stateIndexByMapping[mappingIndex]];
            const double residual = simulatedValue - measuredValue;
            totalLoss += problem.mapping[mappingIndex].weight * residual * residual;
        }
    }
    FittingTrialScore score;
    score.objective = totalLoss;
    return score;
}

namespace {
// Thrown from inside the loss to unwind an optimizer when the fit is to end now; the optimizer backends turn any exception from the
// loss into an early return, and runParameterFit() reads the best simulated values from its own record, not from the optimizer.
struct FittingStopped : std::runtime_error {
    explicit FittingStopped(const std::string& reason) : std::runtime_error(reason) {}
};
}

FittingReport runParameterFit(const FittingProblem& problem, const FittingProgressCallback& onProgress, const FittingMonitor& monitor) {
    const auto backend = createOptimizerBackend(problem.optimizerBackendId);
    // An objective that cannot be read is the person's to fix, so it ends the fit before any simulation instead of scoring every trial as failed.
    checkFittingObjective(problem);
    // The search always minimises; maximising searches for the smallest negative. What is reported is the objective as written.
    const auto shown = [&](double loss) { return problem.maximize ? -loss : loss; };
    const auto scratchPath = std::filesystem::temp_directory_path() /
        ("konjugateFittingTrial-" + std::to_string(reinterpret_cast<std::uintptr_t>(&problem)) + ".bin");

    std::vector<double> initialValues;
    std::vector<ParameterBounds> bounds;
    initialValues.reserve(problem.tunableParameters.size());
    bounds.reserve(problem.tunableParameters.size());
    for (const auto& tunable : problem.tunableParameters) {
        initialValues.push_back(tunable.initialValue);
        bounds.push_back(tunable.bounds);
    }

    const auto started = std::chrono::steady_clock::now();
    const auto elapsedSeconds = [&] { return std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count(); };
    std::size_t evaluations = 0;
    std::size_t failedTrials = 0;
    double bestLoss = std::numeric_limits<double>::infinity();
    double worstLoss = 0.0;
    bool haveFinite = false;
    std::vector<double> bestValues = initialValues;
    std::string stopReason;
    // Constraints add `penaltyScale * (relative violation)^2` to the score. The scale is set from the starting values' own objective, so that
    // breaking a limit by 1% costs about a tenth of it, and any real violation outweighs the objective's own changes.
    double penaltyScale = 0.0;
    double bestViolation = 0.0;

    // Every simulation goes through here: it asks whether to go on, runs it, keeps the best, and tells the monitor.
    const auto score = [&](const std::vector<double>& values, bool baseline) {
        if (!baseline) {
            if (monitor.stopRequested && monitor.stopRequested()) {
                stopReason = "stoppedByUser";
                throw FittingStopped(stopReason);
            }
            if (problem.options.maxSeconds > 0.0 && elapsedSeconds() >= problem.options.maxSeconds) {
                stopReason = "maxTimeReached";
                throw FittingStopped(stopReason);
            }
        }
        evaluations += 1;
        double loss = 0.0;
        double violation = 0.0;
        bool failed = false;
        try {
            const auto trial = evaluateFittingTrial(problem, values, scratchPath);
            if (baseline) penaltyScale = std::isfinite(trial.objective) ? 1e3 * std::max(1.0, std::abs(trial.objective)) : 1e6;
            loss = trial.objective + penaltyScale * trial.violationSquares;
            violation = trial.worstViolation;
            failed = !std::isfinite(loss);
        } catch (const std::exception&) {
            failed = true;
        }
        if (failed) {
            failedTrials += 1;
            loss = haveFinite ? std::max(10.0 * worstLoss, 1e-12) : 1e12;
        } else {
            haveFinite = true;
            worstLoss = std::max(worstLoss, loss);
            if (loss < bestLoss) {
                bestLoss = loss;
                bestValues = values;
                bestViolation = violation;
            }
        }
        if (monitor.onTrial) {
            FittingTrialEvent event;
            event.iteration = evaluations;
            event.loss = shown(loss);
            event.bestLoss = shown(bestLoss);
            event.failed = failed;
            event.failedTrials = failedTrials;
            event.elapsedSeconds = elapsedSeconds();
            event.parameterValues = values;
            event.bestParameterValues = bestValues;
            event.baseline = baseline;
            event.violation = failed ? 0.0 : violation;
            event.bestViolation = bestViolation;
            if (baseline) for (const auto& tunable : problem.tunableParameters) event.parameterIds.push_back(tunable.parameterId);
            monitor.onTrial(event);
        }
        return loss;
    };

    // The starting values first, on their own: it is what every later value is compared with, and how long it took is the cost of
    // one simulation, which is what lets the app say how long the rest should take.
    score(initialValues, true);

    std::vector<FittingProgressUpdate> iterationLog;
    const LossFunction loss = [&](const std::vector<double>& values) { return score(values, false); };
    const FittingProgressCallback captureProgress = [&](const FittingProgressUpdate& update) {
        iterationLog.push_back(update);
        if (onProgress) onProgress(update);
    };

    const auto outcome = backend->optimize(loss, initialValues, bounds, problem.options, captureProgress);

    std::error_code removeError;
    std::filesystem::remove(scratchPath, removeError);

    FittingReport report;
    report.backend = problem.optimizerBackendId;
    report.iterations = std::move(iterationLog);
    report.stopped = !stopReason.empty();
    report.converged = report.stopped ? false : outcome.converged;
    report.terminationReason = report.stopped ? stopReason : outcome.terminationReason;
    report.evaluations = evaluations;
    report.failedTrials = failedTrials;
    report.elapsedSeconds = elapsedSeconds();
    // The best values actually simulated, unless every simulation failed, when the optimizer's own answer is all there is.
    const bool haveBest = std::isfinite(bestLoss);
    report.finalLoss = shown(haveBest ? bestLoss : outcome.loss);
    report.finalViolation = haveBest ? bestViolation : 0.0;
    const auto& finalValues = haveBest ? bestValues : outcome.parameterValues;
    report.finalParameters.reserve(problem.tunableParameters.size());
    for (std::size_t index = 0; index < problem.tunableParameters.size(); ++index) {
        report.finalParameters.emplace_back(problem.tunableParameters[index].parameterId, finalValues[index]);
    }
    return report;
}

}
