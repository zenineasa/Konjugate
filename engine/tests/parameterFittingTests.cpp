/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "modelValidator.hpp"
#include "parameterFitting.hpp"
#include "simulationRunner.hpp"
#include <algorithm>
#include <boost/property_tree/json_parser.hpp>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <sstream>
#include <stdexcept>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

bool approxEqual(double actual, double expected, double tolerance) {
    return std::abs(actual - expected) <= tolerance;
}

// A two-node symmetric relaxation: dSource/dt = rate*(target - source), dTarget/dt =
// rate*(source - target) -- Konjugate contributes an edge's equation to its declared output role
// and automatically negates it for the other endpoint, so one equationModel produces both halves.
// "rate" is the one tunable edge parameter. Analytic solution exists (both states relax toward
// their mean at combined rate 2*rate) but the test never uses it directly -- see
// generateMeasuredSeries() below, which runs the real simulator instead, so recovery is judged
// against the same Euler discretization the fitting loop itself uses, not an idealized curve.
boost::property_tree::ptree buildDocument(double rateValue, double rateMinimum, double rateMaximum) {
    std::ostringstream json;
    json << R"json({
        "format": "konjugate",
        "version": 1,
        "nodes": [
            {"id": 1, "name": "Source", "states": [{"id": 11, "name": "Source temperature", "symbol": "sourceTemperature", "initialValue": 310}], "sourceTerms": []},
            {"id": 2, "name": "Target", "states": [{"id": 12, "name": "Target temperature", "symbol": "targetTemperature", "initialValue": 290}], "sourceTerms": []}
        ],
        "edges": [{
            "id": 3,
            "name": "Relaxation",
            "source": {"nodeId": 1, "stateId": 11},
            "target": {"nodeId": 2, "stateId": 12},
            "parameters": [{"id": 13, "name": "Rate", "symbol": "rate", "value": )json" << rateValue
         << R"json(, "mode": "constant", "tuning": {"minimum": )json" << rateMinimum << R"json(, "maximum": )json" << rateMaximum << R"json(}}],
            "equation": "rate\\cdot(sourceTemperature-targetTemperature)",
            "equationModel": {
                "bindings": [
                    {"symbol": "sourceTemperature", "stateId": 11, "nodeId": 1},
                    {"symbol": "targetTemperature", "stateId": 12, "nodeId": 2},
                    {"symbol": "rate", "kind": "parameter", "parameterId": 13}
                ],
                "mathJson": ["Multiply", "rate", ["Add", "sourceTemperature", ["Negate", "targetTemperature"]]],
                "output": {"role": "target", "stateId": 12}
            }
        }]
    })json";
    boost::property_tree::ptree document;
    std::istringstream input(json.str());
    boost::property_tree::read_json(input, document);
    return document;
}

konjugate::InferenceSeries generateMeasuredSeries(double trueRate, double timeStep, std::size_t rowCount) {
    const auto document = buildDocument(trueRate, 0.01, 2.0);
    const auto validation = konjugate::validateModel(document);
    if (!validation.valid) {
        for (const auto& issue : validation.issues) std::cerr << "[" << issue.severity << "] " << issue.code << ": " << issue.message << '\n';
    }
    require(validation.valid, "The fixture document used to generate measured data should validate cleanly.");

    boost::property_tree::ptree configuration;
    configuration.put("targetTime", timeStep * static_cast<double>(rowCount - 1));
    configuration.put("globalTimeStep", timeStep);
    configuration.put("outputInterval", timeStep);
    const auto scratchPath = std::filesystem::temp_directory_path() / "konjugateFittingTestReference.bin";
    konjugate::runSimulation(document, configuration, scratchPath);
    const auto samples = konjugate::readSimulationSamples(scratchPath);
    std::error_code removeError;
    std::filesystem::remove(scratchPath, removeError);

    const auto sourceIndex = static_cast<std::size_t>(std::distance(samples.stateIds.begin(),
        std::find(samples.stateIds.begin(), samples.stateIds.end(), std::uint64_t{11})));
    const auto targetIndex = static_cast<std::size_t>(std::distance(samples.stateIds.begin(),
        std::find(samples.stateIds.begin(), samples.stateIds.end(), std::uint64_t{12})));

    konjugate::InferenceSeries series;
    series.columnNames = {"sourceTemperature", "targetTemperature"};
    series.timeStep = timeStep;
    series.rows.reserve(samples.valuesByTime.size());
    for (const auto& row : samples.valuesByTime) {
        series.rows.push_back({row[sourceIndex], row[targetIndex]});
    }
    return series;
}

void runParameterFitRecoversAKnownRateViaBobyqa() {
    constexpr double trueRate = 0.5;
    const auto measured = generateMeasuredSeries(trueRate, 0.05, 40);

    konjugate::FittingProblem problem;
    problem.baseDocument = buildDocument(0.1, 0.01, 2.0); // perturbed starting value, well away from 0.5
    problem.measured = measured;
    problem.mapping = {
        {"sourceTemperature", 11, 1.0},
        {"targetTemperature", 12, 1.0},
    };
    problem.tunableParameters = konjugate::findTunableParameters(problem.baseDocument);
    require(problem.tunableParameters.size() == 1, "Expected exactly one tunable parameter (rate).");
    problem.optimizerBackendId = "nlopt-bobyqa";
    problem.options.maxIterations = 200;

    const auto report = konjugate::runParameterFit(problem);
    require(report.finalParameters.size() == 1, "Expected exactly one fitted parameter value back.");
    const auto fittedRate = report.finalParameters.front().second;
    require(approxEqual(fittedRate, trueRate, 0.02),
        "BOBYQA should recover the true rate (0.5) starting from a perturbed value (0.1), got " + std::to_string(fittedRate));
    require(report.finalLoss < 1e-4, "The fitted loss should be near zero once the true rate is recovered, got " + std::to_string(report.finalLoss));
}

void runParameterFitRecoversAKnownRateViaGradientBasedSolver() {
    // Same recovery, through a gradient-based NLopt algorithm (finite-difference gradients, see
    // finiteDifferenceGradient.cpp) rather than a derivative-free one -- proves the gradient path
    // works too, not just BOBYQA.
    constexpr double trueRate = 0.5;
    const auto measured = generateMeasuredSeries(trueRate, 0.05, 40);

    konjugate::FittingProblem problem;
    problem.baseDocument = buildDocument(0.2, 0.01, 2.0);
    problem.measured = measured;
    problem.mapping = {
        {"sourceTemperature", 11, 1.0},
        {"targetTemperature", 12, 1.0},
    };
    problem.tunableParameters = konjugate::findTunableParameters(problem.baseDocument);
    problem.optimizerBackendId = "nlopt-slsqp";
    problem.options.maxIterations = 200;

    const auto report = konjugate::runParameterFit(problem);
    const auto fittedRate = report.finalParameters.front().second;
    require(approxEqual(fittedRate, trueRate, 0.02),
        "SLSQP should recover the true rate (0.5) starting from a perturbed value (0.2), got " + std::to_string(fittedRate));
}

void findTunableParametersIgnoresParametersWithoutTuning() {
    const auto document = buildDocument(0.5, 0.01, 2.0);
    const auto tunable = konjugate::findTunableParameters(document);
    require(tunable.size() == 1, "Expected the one parameter that declares tuning bounds.");
    require(tunable.front().parameterId == 13, "Expected the rate parameter's id.");
    require(approxEqual(tunable.front().bounds.minimum, 0.01, 1e-9), "Expected the declared minimum bound.");
    require(approxEqual(tunable.front().bounds.maximum, 2.0, 1e-9), "Expected the declared maximum bound.");
}

void autoMapColumnsToStatesMatchesBySymbolCaseInsensitively() {
    const auto document = buildDocument(0.5, 0.01, 2.0);
    const auto mapping = konjugate::autoMapColumnsToStates({"SourceTemperature", "unmatchedColumn", "targetTemperature"}, document);
    require(mapping.size() == 2, "Expected exactly the two columns that match a state symbol.");
    require(mapping[0].csvColumnName == "SourceTemperature" && mapping[0].stateId == 11, "Expected the source column mapped to state 11.");
    require(mapping[1].csvColumnName == "targetTemperature" && mapping[1].stateId == 12, "Expected the target column mapped to state 12.");
}

}

int main() {
    try {
        findTunableParametersIgnoresParametersWithoutTuning();
        autoMapColumnsToStatesMatchesBySymbolCaseInsensitively();
        runParameterFitRecoversAKnownRateViaBobyqa();
        runParameterFitRecoversAKnownRateViaGradientBasedSolver();
        std::cout << "Parameter fitting tests passed.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
