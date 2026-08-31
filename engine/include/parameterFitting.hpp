/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "causalInference.hpp"
#include "optimizerBackend.hpp"
#include <boost/property_tree/ptree.hpp>
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace konjugate {

// One CSV column mapped to a model state -- which measured signal corresponds to which
// simulated state, for scoring simulated-vs-measured error. Entity ids are plain uint64_t here
// (rather than pulling in executionPlan.hpp's EntityId alias) to keep this header's dependencies
// minimal; the two are the same underlying type.
struct FittingSignalMapping {
    std::string csvColumnName;
    std::uint64_t stateId = 0;
    double weight = 1.0;
};

// A tunable parameter found in the document (parameters[].tuning present). Located positionally
// (edge index, parameter index within that edge's parameters[] array) rather than by id, since a
// boost::property_tree::ptree has no id-indexed lookup -- every trial clones the base document
// and re-addresses the same position, which is stable because the clone has the same structure.
struct TunableParameter {
    bool sourceTerm = false;
    std::size_t edgeIndex = 0;
    std::size_t nodeIndex = 0;
    std::size_t sourceTermIndex = 0;
    std::size_t parameterIndex = 0;
    std::uint64_t parameterId = 0;
    std::string name;
    double initialValue = 0.0;
    ParameterBounds bounds;
};

// Scans relationship and source-term parameters for every entry with a "tuning" child.
std::vector<TunableParameter> findTunableParameters(const boost::property_tree::ptree& document);

// Case-insensitive exact match of each CSV column name against every state's own symbol or
// name, across document.nodes[].states[] -- the same matching convention as the renderer's own
// csvImport.mjs mapColumnsToNodes() (deliberately no fuzzy matching either, for the same reason:
// a wrong silent match is worse than an unmapped column). A column with no match is simply
// omitted from the result, not an error -- not every CSV column need correspond to a fitting
// signal. Every returned mapping has weight 1.0; a caller wanting different weights adjusts them
// afterward.
std::vector<FittingSignalMapping> autoMapColumnsToStates(const std::vector<std::string>& csvColumnNames,
    const boost::property_tree::ptree& document);

struct FittingProblem {
    boost::property_tree::ptree baseDocument;
    InferenceSeries measured; // parseInferenceCsv()'s output -- reused as-is for the measured data
    std::vector<FittingSignalMapping> mapping;
    std::vector<TunableParameter> tunableParameters;
    std::string optimizerBackendId = "nlopt-bobyqa";
    FittingOptions options;
};

struct FittingReport {
    std::string backend;
    std::vector<FittingProgressUpdate> iterations;
    std::vector<std::pair<std::uint64_t, double>> finalParameters; // parameterId -> fitted value
    bool converged = false;
    std::string terminationReason;
    double finalLoss = 0.0;
};

// The packed samples read back from a completed simulation's binary result file (see
// docs/resultFileFormat.md) -- exposed mainly so tests can generate reference "measured" data by
// running the real simulator once with a known-true parameter value, through the exact same
// discretization the fitting loop itself will later try to match (rather than comparing against
// an idealized closed-form solution, which would conflate fitting accuracy with Euler
// discretization error). See engine/src/parameterFitting.cpp for the read implementation.
struct SimulationSamples {
    std::vector<std::uint64_t> stateIds; // stateIds[i] matches valuesByTime[*][i]
    std::vector<double> times;
    std::vector<std::vector<double>> valuesByTime;
};
SimulationSamples readSimulationSamples(const std::filesystem::path& resultPath);

// Runs one simulation trial with the given tunable-parameter values baked in, and scores it
// against the measured series via weighted least-squares, paired row-by-row against the
// simulation's own output samples (no interpolation -- the trial's targetTime/outputInterval are
// derived from measured.timeStep and row count in runParameterFit(), so both grids match by
// construction). `scratchOutputPath` is a file the trial's simulation result is written to and
// then read back from -- reused across every trial in one fit run rather than one temp file per
// trial.
double evaluateFittingLoss(const FittingProblem& problem, const std::vector<double>& parameterValues,
    const std::filesystem::path& scratchOutputPath);

// Drives the chosen optimizer backend (see optimizerBackend.hpp, nloptBackend.hpp) to minimize
// evaluateFittingLoss() over problem.tunableParameters, starting from their current values.
FittingReport runParameterFit(const FittingProblem& problem, const FittingProgressCallback& onProgress = nullptr);

}
