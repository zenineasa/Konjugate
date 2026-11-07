/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "runMeasure.hpp"
#include "cppToolchain.hpp"
#include "engineProtocol.pb.h"
#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <sstream>
#include <stdexcept>

namespace konjugate {

const ObjectiveData& TrialRun::objectiveData() const {
    if (data_) return *data_;
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
    data_ = std::move(data);
    return *data_;
}

RunLength SquaredErrorMeasure::runLength() const {
    const auto rowCount = problem_.measured.rows.size();
    if (rowCount < 2) throw std::runtime_error("The measured series needs at least two rows to define a fitting run's duration.");
    return {problem_.measured.timeStep * static_cast<double>(rowCount - 1), problem_.measured.timeStep};
}

double SquaredErrorMeasure::evaluate(const TrialRun& run) const {
    const auto& samples = run.samples;
    // Resolve each mapping's simulated-state column index and measured-CSV column index once,
    // outside the row loop below, rather than searching per row.
    std::vector<std::size_t> stateIndexByMapping(problem_.mapping.size());
    std::vector<std::size_t> csvColumnIndexByMapping(problem_.mapping.size());
    for (std::size_t mappingIndex = 0; mappingIndex < problem_.mapping.size(); ++mappingIndex) {
        const auto& mapping = problem_.mapping[mappingIndex];
        const auto stateIt = std::find(samples.stateIds.begin(), samples.stateIds.end(), mapping.stateId);
        if (stateIt == samples.stateIds.end()) throw std::runtime_error("A mapped signal's state did not appear in the simulated result.");
        stateIndexByMapping[mappingIndex] = static_cast<std::size_t>(std::distance(samples.stateIds.begin(), stateIt));
        const auto columnIt = std::find(problem_.measured.columnNames.begin(), problem_.measured.columnNames.end(), mapping.csvColumnName);
        if (columnIt == problem_.measured.columnNames.end()) throw std::runtime_error("A mapped CSV column was not found in the measured series.");
        csvColumnIndexByMapping[mappingIndex] = static_cast<std::size_t>(std::distance(problem_.measured.columnNames.begin(), columnIt));
    }
    // Paired by row index, not by searching for the nearest timestamp -- both grids were built
    // from the same step size and start time (see runLength() above), so row i of the CSV and
    // sample i of the simulation are the same instant by construction. Clamped to the shorter of
    // the two as a defensive measure against a boundary-condition off-by-one in the simulation's
    // own output cadence, not because the counts are expected to differ.
    const auto pairedRowCount = std::min(problem_.measured.rows.size(), samples.valuesByTime.size());
    double totalLoss = 0.0;
    for (std::size_t row = 0; row < pairedRowCount; ++row) {
        for (std::size_t mappingIndex = 0; mappingIndex < problem_.mapping.size(); ++mappingIndex) {
            const double measuredValue = problem_.measured.rows[row][csvColumnIndexByMapping[mappingIndex]];
            const double simulatedValue = samples.valuesByTime[row][stateIndexByMapping[mappingIndex]];
            const double residual = simulatedValue - measuredValue;
            totalLoss += problem_.mapping[mappingIndex].weight * residual * residual;
        }
    }
    return totalLoss;
}

RunLength ExpressionMeasure::runLength() const {
    if (!(problem_.targetTime > 0.0) || !(problem_.timeStep > 0.0)) throw std::runtime_error("An objective needs a run length and a time step above zero.");
    return {problem_.targetTime, problem_.timeStep};
}

double ExpressionMeasure::evaluate(const TrialRun& run) const {
    return expression_.evaluate(run.objectiveData());
}

namespace {
std::string sourceHash(const std::string& text) {
    std::ostringstream hex;
    hex << std::hex << std::hash<std::string>{}(text);
    return hex.str();
}
}

ProgramMeasure::ProgramMeasure(const FittingProblem& problem, const ObjectiveProgram& program) : problem_(problem), program_(program) {
    if (program_.language != "cpp" && program_.language != "python") throw std::invalid_argument("An objective program is written in C++ or Python.");
    if (program_.source.find_first_not_of(" \t\r\n") == std::string::npos) throw std::invalid_argument("The objective program is empty.");
    std::vector<std::string> keys;
    for (const auto& binding : program_.bindings) {
        if (binding.key.empty()) throw std::invalid_argument("Every binding of the objective program needs a key.");
        if (std::find(keys.begin(), keys.end(), binding.key) != keys.end()) throw std::invalid_argument("The key \"" + binding.key + "\" is bound twice.");
        keys.push_back(binding.key);
        if (binding.kind == "parameter") {
            const auto tuned = std::any_of(problem_.tunableParameters.begin(), problem_.tunableParameters.end(), [&](const auto& tunable) { return tunable.parameterId == binding.id; });
            if (!tuned) throw std::invalid_argument("The key \"" + binding.key + "\" is bound to a parameter that is not tuned; a program reads only the tuned parameters' values.");
        } else if (binding.kind == "measured") {
            const auto& columns = problem_.measured.columnNames;
            if (std::find(columns.begin(), columns.end(), binding.column) == columns.end()) throw std::invalid_argument("The key \"" + binding.key + "\" is bound to a measured column the data does not have.");
        } else if (binding.kind != "state") {
            throw std::invalid_argument("A binding of the objective program is to a state, a parameter or a measured column.");
        }
    }
    const auto directory = program_.buildDirectory.empty() ? std::filesystem::temp_directory_path() / "konjugateObjectives" : std::filesystem::path(program_.buildDirectory);
    std::filesystem::create_directories(directory);
    const auto stem = "objective_" + sourceHash(program_.language + program_.source + program_.cppSdkPath);
    if (program_.language == "python") {
        const auto path = directory / (stem + ".py");
        std::ofstream(path, std::ios::binary | std::ios::trunc) << program_.source;
        const auto interpreter = program_.pythonInterpreter.empty() ? std::string("python3") : program_.pythonInterpreter;
        commands_.push_back({interpreter, "-m", "konjugate.objective", path.string()});
        if (program_.pythonInterpreter.empty()) commands_.push_back({"python", "-m", "konjugate.objective", path.string()});
        if (!program_.pythonSdkPath.empty()) {
            const char* existing = std::getenv("PYTHONPATH");
#ifdef _WIN32
            const char separator = ';';
#else
            const char separator = ':';
#endif
            environment_.emplace_back("PYTHONPATH", existing && *existing ? program_.pythonSdkPath + separator + existing : program_.pythonSdkPath);
        }
        return;
    }
    if (program_.cppSdkPath.empty()) throw std::invalid_argument("A C++ objective program needs the engine's SDK to be built against.");
    const auto sourcePath = directory / (stem + ".cpp");
#ifdef _WIN32
    const auto artifact = directory / (stem + ".exe");
#else
    const auto artifact = directory / stem;
#endif
    if (!std::filesystem::exists(artifact)) {
        std::ofstream(sourcePath, std::ios::binary | std::ios::trunc) << program_.source;
        try {
            cppToolchain::buildNativeArtifact(sourcePath, std::filesystem::path(program_.cppSdkPath) / "src" / "objectiveProgramMain.cpp",
                std::filesystem::path(program_.cppSdkPath) / "include", artifact, false, program_.cppCompiler, "the C++ objective program");
        } catch (const std::exception& error) {
            throw std::invalid_argument(error.what());
        }
    }
    commands_.push_back({artifact.string()});
}

RunLength ProgramMeasure::runLength() const {
    if (!(problem_.targetTime > 0.0) || !(problem_.timeStep > 0.0)) throw std::runtime_error("An objective needs a run length and a time step above zero.");
    return {problem_.targetTime, problem_.timeStep};
}

double ProgramMeasure::evaluate(const TrialRun& run) const {
    // Nothing from an earlier trial is ever read as this one's.
    reports_.clear();
    protocol::ObjectiveRunRequest request;
    for (const auto time : run.samples.times) request.add_times(time);
    const auto& data = run.objectiveData();
    for (const auto& binding : program_.bindings) {
        if (binding.kind == "parameter") {
            auto* value = request.add_values();
            value->set_key(binding.key);
            value->set_value(data.parameters.at(binding.id));
            continue;
        }
        const auto* series = binding.kind == "state"
            ? (data.states.count(binding.id) ? &data.states.at(binding.id) : nullptr)
            : (data.measured.count(binding.column) ? &data.measured.at(binding.column) : nullptr);
        if (!series) throw std::runtime_error("The key \"" + binding.key + "\" is bound to a state the run does not have.");
        auto* entry = request.add_series();
        entry->set_key(binding.key);
        for (const auto value : *series) entry->add_values(value);
    }
    std::string payload;
    if (!request.SerializeToString(&payload)) throw std::runtime_error("The run could not be put into a message for the program.");
    // A program that failed is started afresh for the next trial; one that is fine is kept for the whole fit.
    try {
        if (!process_) process_ = std::make_unique<ChildProcess>(commands_, environment_);
        process_->writeFrame(payload);
        std::string answer;
        if (!process_->readFrame(answer, std::chrono::milliseconds(static_cast<long long>(program_.timeoutSeconds * 1000)))) {
            const auto said = process_->diagnostics();
            process_.reset();
            throw std::runtime_error("The objective program stopped" + (said.empty() ? std::string(".") : ": " + said.substr(said.size() > 400 ? said.size() - 400 : 0)));
        }
        protocol::ObjectiveRunResult result;
        if (!result.ParseFromString(answer)) {
            process_.reset();
            throw std::runtime_error("The objective program answered with something that is not a result.");
        }
        if (!result.ok()) throw std::runtime_error(result.message().empty() ? std::string("The objective program gave no number.") : std::string(result.message()));
        for (const auto& reported : result.reports()) reports_.emplace_back(reported.key(), reported.value());
        return result.value();
    } catch (const std::runtime_error& error) {
        // Waiting too long, or the pipe gone: what is running is not to be trusted with the next trial.
        const std::string what = error.what();
        if (what.rfind("The objective program did not answer", 0) == 0 || what.rfind("The program", 0) == 0) process_.reset();
        throw;
    } catch (const std::exception& error) {
        process_.reset();
        throw std::runtime_error(error.what());
    }
}

double ReportMeasure::evaluate(const TrialRun&) const {
    std::string said;
    for (const auto& [name, value] : program_.reports()) {
        if (name == name_) return value;
        said += (said.empty() ? "" : ", ") + name;
    }
    throw std::runtime_error("The objective program reported no number named \"" + name_ + "\"" + (said.empty() ? std::string(" (it reported none).") : " (it reported " + said + ")."));
}

FittingMeasures makeFittingMeasures(const FittingProblem& problem) {
    FittingMeasures measures;
    if (problem.program) {
        auto program = std::make_unique<ProgramMeasure>(problem, *problem.program);
        // The objective is asked first in every trial, so a reported number is the same trial's.
        for (const auto& constraint : problem.constraints) {
            if (!constraint.report.empty()) measures.limits.emplace_back(constraint, std::make_unique<ReportMeasure>(*program, constraint.report));
            else measures.limits.emplace_back(constraint, std::make_unique<ExpressionMeasure>(problem, constraint.expression));
        }
        measures.objective = std::move(program);
        return measures;
    }
    if (problem.objective.empty()) {
        measures.objective = std::make_unique<SquaredErrorMeasure>(problem);
        return measures;
    }
    measures.objective = std::make_unique<ExpressionMeasure>(problem, problem.objective);
    for (const auto& constraint : problem.constraints) {
        measures.limits.emplace_back(constraint, std::make_unique<ExpressionMeasure>(problem, constraint.expression));
    }
    return measures;
}

}
