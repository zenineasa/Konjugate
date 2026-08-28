/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "engineProtocol.pb.h"
#include "modelValidator.hpp"
#include "nloptBackend.hpp"
#include "parameterFitting.hpp"
#include "parameterFittingReport.hpp"
#include "simulationRunner.hpp"
#include <algorithm>
#include <boost/property_tree/json_parser.hpp>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <numbers>
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

void everyRemainingNloptAlgorithmRecoversAKnownRate() {
    // BOBYQA and SLSQP each get their own dedicated test above; this covers the rest of
    // nloptAlgorithmIds() in one pass so a newly added algorithm id is exercised automatically
    // rather than needing a hand-written test of its own. ISRES (global, population-based) gets
    // a looser tolerance and a larger evaluation budget than the local algorithms -- it explores
    // rather than converging tightly, and this is a 1-dimensional problem so its default
    // population size is already generous relative to what it needs.
    constexpr double trueRate = 0.5;
    const auto measured = generateMeasuredSeries(trueRate, 0.05, 40);

    for (const auto& backendId : konjugate::nloptAlgorithmIds()) {
        if (backendId == "nlopt-bobyqa" || backendId == "nlopt-slsqp") continue;

        konjugate::FittingProblem problem;
        problem.baseDocument = buildDocument(0.2, 0.01, 2.0);
        problem.measured = measured;
        problem.mapping = {
            {"sourceTemperature", 11, 1.0},
            {"targetTemperature", 12, 1.0},
        };
        problem.tunableParameters = konjugate::findTunableParameters(problem.baseDocument);
        problem.optimizerBackendId = backendId;
        const bool isGlobal = backendId == "nlopt-isres";
        problem.options.maxIterations = isGlobal ? 5000 : 200;

        const auto report = konjugate::runParameterFit(problem);
        require(report.finalParameters.size() == 1,
            "Expected exactly one fitted parameter value back for backend " + backendId);
        const auto fittedRate = report.finalParameters.front().second;
        const double tolerance = isGlobal ? 0.05 : 0.02;
        require(approxEqual(fittedRate, trueRate, tolerance),
            backendId + " should recover the true rate (0.5) starting from a perturbed value (0.2), got " +
                std::to_string(fittedRate));
    }
}

// A three-node chain, Source -> Middle -> Target, with an independently tunable rate on each
// edge -- exercises the multi-dimensional path through the real fitting pipeline (finite-
// difference gradients over more than one variable, and the optimizer actually searching a
// 2-D space) rather than the 1-D case every other test above uses, where a "gradient" is just a
// scalar and can't reveal a dimension-indexing bug.
boost::property_tree::ptree buildTwoParameterDocument(double rate1Value, double rate2Value) {
    std::ostringstream json;
    json << R"json({
        "format": "konjugate",
        "version": 1,
        "nodes": [
            {"id": 1, "name": "Source", "states": [{"id": 11, "name": "Source temperature", "symbol": "sourceTemperature", "initialValue": 310}], "sourceTerms": []},
            {"id": 2, "name": "Middle", "states": [{"id": 14, "name": "Middle temperature", "symbol": "middleTemperature", "initialValue": 300}], "sourceTerms": []},
            {"id": 3, "name": "Target", "states": [{"id": 12, "name": "Target temperature", "symbol": "targetTemperature", "initialValue": 290}], "sourceTerms": []}
        ],
        "edges": [
            {
                "id": 4, "name": "Relaxation1",
                "source": {"nodeId": 1, "stateId": 11}, "target": {"nodeId": 2, "stateId": 14},
                "parameters": [{"id": 13, "name": "Rate1", "symbol": "rate1", "value": )json" << rate1Value
         << R"json(, "mode": "constant", "tuning": {"minimum": 0.01, "maximum": 2.0}}],
                "equation": "rate1\\cdot(sourceTemperature-middleTemperature)",
                "equationModel": {
                    "bindings": [
                        {"symbol": "sourceTemperature", "stateId": 11, "nodeId": 1},
                        {"symbol": "middleTemperature", "stateId": 14, "nodeId": 2},
                        {"symbol": "rate1", "kind": "parameter", "parameterId": 13}
                    ],
                    "mathJson": ["Multiply", "rate1", ["Add", "sourceTemperature", ["Negate", "middleTemperature"]]],
                    "output": {"role": "target", "stateId": 14}
                }
            },
            {
                "id": 6, "name": "Relaxation2",
                "source": {"nodeId": 2, "stateId": 14}, "target": {"nodeId": 3, "stateId": 12},
                "parameters": [{"id": 15, "name": "Rate2", "symbol": "rate2", "value": )json" << rate2Value
         << R"json(, "mode": "constant", "tuning": {"minimum": 0.01, "maximum": 2.0}}],
                "equation": "rate2\\cdot(middleTemperature-targetTemperature)",
                "equationModel": {
                    "bindings": [
                        {"symbol": "middleTemperature", "stateId": 14, "nodeId": 2},
                        {"symbol": "targetTemperature", "stateId": 12, "nodeId": 3},
                        {"symbol": "rate2", "kind": "parameter", "parameterId": 15}
                    ],
                    "mathJson": ["Multiply", "rate2", ["Add", "middleTemperature", ["Negate", "targetTemperature"]]],
                    "output": {"role": "target", "stateId": 12}
                }
            }
        ]
    })json";
    boost::property_tree::ptree document;
    std::istringstream input(json.str());
    boost::property_tree::read_json(input, document);
    return document;
}

konjugate::InferenceSeries generateTwoParameterMeasuredSeries(double trueRate1, double trueRate2, double timeStep,
    std::size_t rowCount) {
    const auto document = buildTwoParameterDocument(trueRate1, trueRate2);
    const auto validation = konjugate::validateModel(document);
    if (!validation.valid) {
        for (const auto& issue : validation.issues) std::cerr << "[" << issue.severity << "] " << issue.code << ": " << issue.message << '\n';
    }
    require(validation.valid, "The two-parameter fixture document should validate cleanly.");

    boost::property_tree::ptree configuration;
    configuration.put("targetTime", timeStep * static_cast<double>(rowCount - 1));
    configuration.put("globalTimeStep", timeStep);
    configuration.put("outputInterval", timeStep);
    const auto scratchPath = std::filesystem::temp_directory_path() / "konjugateFittingTestTwoParameterReference.bin";
    konjugate::runSimulation(document, configuration, scratchPath);
    const auto samples = konjugate::readSimulationSamples(scratchPath);
    std::error_code removeError;
    std::filesystem::remove(scratchPath, removeError);

    const auto indexOf = [&](std::uint64_t stateId) {
        return static_cast<std::size_t>(std::distance(samples.stateIds.begin(),
            std::find(samples.stateIds.begin(), samples.stateIds.end(), stateId)));
    };
    const auto sourceIndex = indexOf(11);
    const auto middleIndex = indexOf(14);
    const auto targetIndex = indexOf(12);

    konjugate::InferenceSeries series;
    series.columnNames = {"sourceTemperature", "middleTemperature", "targetTemperature"};
    series.timeStep = timeStep;
    series.rows.reserve(samples.valuesByTime.size());
    for (const auto& row : samples.valuesByTime) {
        series.rows.push_back({row[sourceIndex], row[middleIndex], row[targetIndex]});
    }
    return series;
}

void runParameterFitRecoversTwoKnownRatesSimultaneously() {
    constexpr double trueRate1 = 0.5;
    constexpr double trueRate2 = 0.3; // deliberately different from trueRate1 -- a bug that swapped
                                       // which gradient component belongs to which parameter would
                                       // still "work" if both true values were equal.
    const auto measured = generateTwoParameterMeasuredSeries(trueRate1, trueRate2, 0.05, 40);

    for (const std::string& backendId : {std::string("nlopt-bobyqa"), std::string("nlopt-slsqp")}) {
        konjugate::FittingProblem problem;
        problem.baseDocument = buildTwoParameterDocument(0.9, 0.9); // both perturbed, away from and
                                                                     // on the same side of both truths
        problem.measured = measured;
        problem.mapping = {
            {"sourceTemperature", 11, 1.0},
            {"middleTemperature", 14, 1.0},
            {"targetTemperature", 12, 1.0},
        };
        problem.tunableParameters = konjugate::findTunableParameters(problem.baseDocument);
        require(problem.tunableParameters.size() == 2, "Expected both edge rates to be found as tunable.");
        problem.optimizerBackendId = backendId;
        problem.options.maxIterations = 300;

        const auto report = konjugate::runParameterFit(problem);
        require(report.finalParameters.size() == 2, backendId + ": expected two fitted parameter values back.");
        // finalParameters is parameterId -> value; order follows tunableParameters (parameterId 13
        // is rate1, 15 is rate2 -- see buildTwoParameterDocument()).
        const auto fittedRate1 = report.finalParameters[0].second;
        const auto fittedRate2 = report.finalParameters[1].second;
        require(report.finalParameters[0].first == 13 && report.finalParameters[1].first == 15,
            backendId + ": expected fitted parameters in (rate1, rate2) parameterId order.");
        require(approxEqual(fittedRate1, trueRate1, 0.03),
            backendId + ": expected rate1 to recover 0.5, got " + std::to_string(fittedRate1));
        require(approxEqual(fittedRate2, trueRate2, 0.03),
            backendId + ": expected rate2 to recover 0.3, got " + std::to_string(fittedRate2));
    }
}

// Uses the OptimizerBackend interface directly, with a hand-constructed analytic loss, rather
// than routing through a simulated document -- constructing genuine multimodality out of this
// engine's actual ODE-based fitting model would require a contrived oscillatory/aliasing fixture
// that's fragile to tune and slow to iterate on. This tests the same interface runParameterFit()
// drives (see parameterFitting.cpp's createOptimizerBackend()), just with a controlled, known
// landscape instead of a simulated one.
//
// A *rotated* 2-D Rastrigin: rastrigin1d applied not to x and y directly but to a 45-degree
// rotation of them (u,v). Two earlier, unrotated attempts were tried and dropped: plain 1-D
// Rastrigin (only ~10 basins on one axis) and plain *separable* 2-D Rastrigin both turned out
// solvable by every NLopt algorithm tried at generous iteration budgets, because several of them
// (notably the moving-asymptote gradient methods) can exploit axis-aligned separable structure to
// solve each coordinate almost independently (verified by actually running both, not assumed).
// Rotating the ripple pattern 45 degrees relative to the x/y axes breaks that decomposition. The
// global minimum is still at x=y=0 (u=v=0, f=0); local minima sit at integer (u,v) lattice points.
// Starting at x=y=3.2 puts (u,v) at roughly (4.53, 0) -- several basins from the origin along u.
double multimodalLoss(const std::vector<double>& point) {
    constexpr double twoPi = 2.0 * std::numbers::pi;
    constexpr double invSqrt2 = 0.70710678118654752440;
    const auto rastrigin1d = [twoPi](double value) { return value * value - 10.0 * std::cos(twoPi * value) + 10.0; };
    const double u = (point[0] + point[1]) * invSqrt2;
    const double v = (point[0] - point[1]) * invSqrt2;
    return rastrigin1d(u) + rastrigin1d(v);
}

void everyLocalNloptAlgorithmStaysTrappedWhileIsresEscapes() {
    // Even on the rotated landscape, this is a three-way split, established empirically by
    // surveying every backend's actual result rather than assumed in advance:
    //   - BOBYQA, COBYLA, Nelder-Mead, PRAXIS, SBPLX, SLSQP: with a small, realistic budget (20
    //     evaluations -- a fitting trial costs a full simulation in the real product, so a "quick
    //     local pass" budget is the honest comparison, not an unbounded one), all six settle at a
    //     nearby local minimum (observed losses 0.41-34.7) and never approach the true global one.
    //   - ISRES: reliably reaches near the true global minimum (observed losses 0-0.38 across
    //     repeated runs -- it's population-based/stochastic, so this only asserts "close", not
    //     "exact" or "identical every run").
    //   - CCSAQ: also reliably reaches the true global minimum, essentially exactly, even in only
    //     20 evaluations -- a genuine, reproducible property of this particular gradient-based
    //     method on this landscape (not a bug in the test), so it's grouped with ISRES rather than
    //     forced into the "trapped" bucket it doesn't belong in.
    //   - MMA: lands at an intermediate value (observed ~0.99) that isn't a clean fit for either
    //     bucket, so it only gets the baseline progress-reporting checks below, not a bucketed
    //     loss assertion.
    const std::vector<double> startingPoint = {3.2, 3.2};
    const konjugate::LossFunction loss = multimodalLoss;
    const std::vector<konjugate::ParameterBounds> bounds = {{-8.0, 8.0}, {-8.0, 8.0}};
    const std::vector<std::string> trappedLocally = {"nlopt-bobyqa", "nlopt-cobyla", "nlopt-neldermead",
        "nlopt-praxis", "nlopt-sbplx", "nlopt-slsqp"};
    const std::vector<std::string> reachesGlobal = {"nlopt-isres", "nlopt-ccsaq"};

    for (const auto& backendId : konjugate::nloptAlgorithmIds()) {
        const auto backend = konjugate::createNloptBackend(backendId);
        konjugate::FittingOptions options;
        options.maxIterations = backendId == "nlopt-isres" ? 20000 : 20;

        std::vector<konjugate::FittingProgressUpdate> progress;
        const auto result = backend->optimize(loss, startingPoint, bounds, options,
            [&](const konjugate::FittingProgressUpdate& update) { progress.push_back(update); });

        require(!progress.empty(), backendId + ": expected at least one progress update.");
        for (std::size_t index = 1; index < progress.size(); ++index) {
            require(progress[index].iteration >= progress[index - 1].iteration,
                backendId + ": expected non-decreasing iteration numbers in progress updates.");
        }
        require(progress.back().parameterValues.size() == 2,
            backendId + ": expected each progress update to report two parameter values.");

        const bool isTrappedGroup = std::find(trappedLocally.begin(), trappedLocally.end(), backendId) != trappedLocally.end();
        const bool isGlobalGroup = std::find(reachesGlobal.begin(), reachesGlobal.end(), backendId) != reachesGlobal.end();
        if (isGlobalGroup) {
            require(result.loss < 1.0,
                backendId + ": expected this backend to reach near the true global minimum at (0,0), got loss " +
                    std::to_string(result.loss));
        } else if (isTrappedGroup) {
            require(result.loss > 0.35,
                backendId + ": expected this local search, budgeted for a quick pass, to settle at *a* local "
                "minimum rather than the true global one, got loss " + std::to_string(result.loss));
        }
    }
}

void createNloptBackendRejectsAnUnrecognizedAlgorithmId() {
    bool threw = false;
    try {
        konjugate::createNloptBackend("nlopt-does-not-exist");
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    require(threw, "Expected createNloptBackend() to reject an unrecognized algorithm id.");
}

void runParameterFitRejectsAnUnrecognizedBackendId() {
    const auto measured = generateMeasuredSeries(0.5, 0.05, 40);
    konjugate::FittingProblem problem;
    problem.baseDocument = buildDocument(0.2, 0.01, 2.0);
    problem.measured = measured;
    problem.mapping = {{"sourceTemperature", 11, 1.0}, {"targetTemperature", 12, 1.0}};
    problem.tunableParameters = konjugate::findTunableParameters(problem.baseDocument);
    problem.optimizerBackendId = "totally-invalid-backend";

    bool threw = false;
    try {
        konjugate::runParameterFit(problem);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    require(threw, "Expected runParameterFit() to reject an unrecognized optimizer backend id.");
}

void modelValidatorRejectsATuningInitialValueOutsideItsOwnBounds() {
    // The initial value (12.0) sits above the declared tuning maximum (2.0) -- a document like
    // this should never reach the fitting pipeline at all; validateModel() is the gate.
    const auto document = buildDocument(12.0, 0.01, 2.0);
    const auto validation = konjugate::validateModel(document);
    require(!validation.valid, "Expected a tunable parameter's initial value outside its own bounds to fail validation.");
    const bool hasExpectedIssue = std::any_of(validation.issues.begin(), validation.issues.end(),
        [](const auto& issue) { return issue.code == "parameterTuningInvalid"; });
    require(hasExpectedIssue, "Expected the parameterTuningInvalid validation issue code specifically.");
}

void runParameterFitRecoversAKnownRateAtItsOwnTuningBoundary() {
    // The true rate sits exactly at the declared minimum bound (0.4) -- a physically realistic
    // case (a parameter pinned at its floor) that a naive bounds implementation could clip away
    // from instead of settling on. Represents each remaining shape of backend (derivative-free
    // local, gradient-based local, global) with one algorithm rather than all nine, to keep this
    // fast; everyRemainingNloptAlgorithmRecoversAKnownRate() already exercises every algorithm id.
    constexpr double trueRate = 0.4;
    constexpr double minimumBound = 0.4;
    constexpr double maximumBound = 2.0;

    std::ostringstream json;
    json << R"json({
        "format": "konjugate",
        "version": 1,
        "nodes": [
            {"id": 1, "name": "Source", "states": [{"id": 11, "name": "Source temperature", "symbol": "sourceTemperature", "initialValue": 310}], "sourceTerms": []},
            {"id": 2, "name": "Target", "states": [{"id": 12, "name": "Target temperature", "symbol": "targetTemperature", "initialValue": 290}], "sourceTerms": []}
        ],
        "edges": [{
            "id": 3, "name": "Relaxation",
            "source": {"nodeId": 1, "stateId": 11}, "target": {"nodeId": 2, "stateId": 12},
            "parameters": [{"id": 13, "name": "Rate", "symbol": "rate", "value": )json" << trueRate
         << R"json(, "mode": "constant", "tuning": {"minimum": )json" << minimumBound << R"json(, "maximum": )json" << maximumBound << R"json(}}],
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
    boost::property_tree::ptree referenceDocument;
    std::istringstream input(json.str());
    boost::property_tree::read_json(input, referenceDocument);
    require(konjugate::validateModel(referenceDocument).valid, "The boundary-value fixture document should validate cleanly.");

    boost::property_tree::ptree configuration;
    configuration.put("targetTime", 0.05 * 39.0);
    configuration.put("globalTimeStep", 0.05);
    configuration.put("outputInterval", 0.05);
    const auto scratchPath = std::filesystem::temp_directory_path() / "konjugateFittingTestBoundaryReference.bin";
    konjugate::runSimulation(referenceDocument, configuration, scratchPath);
    const auto samples = konjugate::readSimulationSamples(scratchPath);
    std::error_code removeError;
    std::filesystem::remove(scratchPath, removeError);
    const auto indexOf = [&](std::uint64_t stateId) {
        return static_cast<std::size_t>(std::distance(samples.stateIds.begin(),
            std::find(samples.stateIds.begin(), samples.stateIds.end(), stateId)));
    };
    konjugate::InferenceSeries measured;
    measured.columnNames = {"sourceTemperature", "targetTemperature"};
    measured.timeStep = 0.05;
    const auto sourceIndex = indexOf(11);
    const auto targetIndex = indexOf(12);
    measured.rows.reserve(samples.valuesByTime.size());
    for (const auto& row : samples.valuesByTime) measured.rows.push_back({row[sourceIndex], row[targetIndex]});

    for (const std::string& backendId : {std::string("nlopt-bobyqa"), std::string("nlopt-slsqp"), std::string("nlopt-isres")}) {
        konjugate::FittingProblem problem;
        problem.baseDocument = buildDocument(1.2, minimumBound, maximumBound); // starts well away from the boundary
        problem.measured = measured;
        problem.mapping = {{"sourceTemperature", 11, 1.0}, {"targetTemperature", 12, 1.0}};
        problem.tunableParameters = konjugate::findTunableParameters(problem.baseDocument);
        problem.optimizerBackendId = backendId;
        problem.options.maxIterations = backendId == "nlopt-isres" ? 5000 : 300;

        const auto report = konjugate::runParameterFit(problem);
        const auto fittedRate = report.finalParameters.front().second;
        require(fittedRate >= minimumBound - 1e-6,
            backendId + ": fitted rate must never fall below its declared tuning minimum, got " + std::to_string(fittedRate));
        require(approxEqual(fittedRate, trueRate, 0.03),
            backendId + ": expected the rate to settle at its own bound (0.4), got " + std::to_string(fittedRate));
    }
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

// Regression test for a real bug found in manual testing: a diverging fit can produce a
// non-finite loss (and, in principle, a non-finite parameter value). writeFittingReport() used to
// write hand-rolled JSON via raw std::ostringstream string concatenation, and C++'s default
// ostream formatting for a non-finite double prints the literal words "inf"/"-inf"/"nan" -- none
// of which are valid JSON tokens, so JSON.parse() on the JS side rejected the whole report
// outright rather than just this one field. writeFittingReport() now writes binary protobuf (see
// protocol/engineProtocol.proto's FittingReport message) instead, whose double fields natively
// represent Infinity/-Infinity/NaN -- this constructs a report with every kind of non-finite
// value in it and confirms each one round-trips exactly through a real decode, not just that the
// file parses as *something*.
void writeFittingReportPreservesNonFiniteValues() {
    konjugate::FittingReport report;
    report.backend = "nlopt-isres";
    report.converged = false;
    report.terminationReason = "diverging";
    report.finalLoss = std::numeric_limits<double>::infinity();
    report.iterations = {
        {1, std::numeric_limits<double>::quiet_NaN(), {0.5}},
        {2, -std::numeric_limits<double>::infinity(), {1.5}}
    };
    report.finalParameters = {{13, std::numeric_limits<double>::infinity()}};

    const auto scratchPath = std::filesystem::temp_directory_path() / "konjugateFittingReportNonFiniteTest.bin";
    konjugate::writeFittingReport(scratchPath, report);
    std::ifstream stream(scratchPath, std::ios::binary);
    const std::string bytes((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    std::error_code removeError;
    std::filesystem::remove(scratchPath, removeError);

    konjugate::protocol::FittingReport decoded;
    require(decoded.ParseFromString(bytes), "Expected the written report to parse as a valid FittingReport protobuf message.");
    require(std::isinf(decoded.final_loss()) && decoded.final_loss() > 0, "Expected finalLoss to round-trip as +Infinity exactly.");
    require(std::isnan(decoded.iterations(0).loss()), "Expected the first iteration's loss to round-trip as NaN exactly.");
    require(std::isinf(decoded.iterations(1).loss()) && decoded.iterations(1).loss() < 0, "Expected the second iteration's loss to round-trip as -Infinity exactly.");
    require(std::isinf(decoded.final_parameters(0).value()) && decoded.final_parameters(0).value() > 0,
        "Expected the fitted parameter's value to round-trip as +Infinity exactly.");
}

}

int main() {
    try {
        findTunableParametersIgnoresParametersWithoutTuning();
        autoMapColumnsToStatesMatchesBySymbolCaseInsensitively();
        writeFittingReportPreservesNonFiniteValues();
        runParameterFitRecoversAKnownRateViaBobyqa();
        runParameterFitRecoversAKnownRateViaGradientBasedSolver();
        everyRemainingNloptAlgorithmRecoversAKnownRate();
        runParameterFitRecoversTwoKnownRatesSimultaneously();
        everyLocalNloptAlgorithmStaysTrappedWhileIsresEscapes();
        createNloptBackendRejectsAnUnrecognizedAlgorithmId();
        runParameterFitRejectsAnUnrecognizedBackendId();
        modelValidatorRejectsATuningInitialValueOutsideItsOwnBounds();
        runParameterFitRecoversAKnownRateAtItsOwnTuningBoundary();
        std::cout << "Parameter fitting tests passed.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
