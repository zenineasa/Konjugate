/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "parameterFitting.hpp"
#include "nloptBackend.hpp"
#include "simulationRunner.hpp"
#include "engineProtocol.pb.h"
#include <algorithm>
#include <cctype>
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
    const auto edgesOptional = document.get_child_optional("edges");
    if (!edgesOptional) return found;
    std::size_t edgeIndex = 0;
    for (const auto& edgeEntry : *edgesOptional) {
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
        bool matched = false;
        for (const auto& nodeEntry : *nodesOptional) {
            if (matched) break;
            const auto statesOptional = nodeEntry.second.get_child_optional("states");
            if (!statesOptional) continue;
            for (const auto& stateEntry : *statesOptional) {
                const auto& state = stateEntry.second;
                const auto symbol = lowercase(state.get<std::string>("symbol", ""));
                const auto name = lowercase(state.get<std::string>("name", ""));
                if (normalizedColumn == symbol || normalizedColumn == name) {
                    mapping.push_back({columnName, state.get<std::uint64_t>("id"), 1.0});
                    matched = true;
                    break;
                }
            }
        }
    }
    return mapping;
}

double evaluateFittingLoss(const FittingProblem& problem, const std::vector<double>& parameterValues,
    const std::filesystem::path& scratchOutputPath) {
    // ptree assignment is a deep copy -- each trial gets its own document, the base is untouched.
    boost::property_tree::ptree document = problem.baseDocument;
    auto& edges = document.get_child("edges");
    for (std::size_t index = 0; index < problem.tunableParameters.size(); ++index) {
        const auto& tunable = problem.tunableParameters[index];
        auto& edge = childAt(edges, tunable.edgeIndex);
        auto& parameters = edge.get_child("parameters");
        childAt(parameters, tunable.parameterIndex).put("value", parameterValues[index]);
    }

    const auto rowCount = problem.measured.rows.size();
    if (rowCount < 2) throw std::runtime_error("The measured series needs at least two rows to define a fitting run's duration.");
    boost::property_tree::ptree configuration;
    configuration.put("targetTime", problem.measured.timeStep * static_cast<double>(rowCount - 1));
    configuration.put("globalTimeStep", problem.measured.timeStep);
    configuration.put("outputInterval", problem.measured.timeStep);

    runSimulation(document, configuration, scratchOutputPath);
    const auto samples = readSimulationSamples(scratchOutputPath);

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
    return totalLoss;
}

FittingReport runParameterFit(const FittingProblem& problem, const FittingProgressCallback& onProgress) {
    const auto backend = createOptimizerBackend(problem.optimizerBackendId);
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

    std::vector<FittingProgressUpdate> iterationLog;
    const LossFunction loss = [&](const std::vector<double>& values) {
        return evaluateFittingLoss(problem, values, scratchPath);
    };
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
    report.converged = outcome.converged;
    report.terminationReason = outcome.terminationReason;
    report.finalLoss = outcome.loss;
    report.finalParameters.reserve(problem.tunableParameters.size());
    for (std::size_t index = 0; index < problem.tunableParameters.size(); ++index) {
        report.finalParameters.emplace_back(problem.tunableParameters[index].parameterId, outcome.parameterValues[index]);
    }
    return report;
}

}
