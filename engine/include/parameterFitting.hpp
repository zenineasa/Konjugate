/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <optional>

#include "causalInference.hpp"
#include "fittingObjective.hpp"
#include "optimizerBackend.hpp"
#include <boost/property_tree/ptree.hpp>
#include <cstdint>
#include <functional>
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
    // A project-level shared parameter (top-level "sharedParameters" entry) rather than one owned by
    // a relationship or source term: located by sharedIndex, and fitting it moves every parameter
    // linked to it at once.
    bool shared = false;
    std::size_t sharedIndex = 0;
    bool sourceTerm = false;
    // A state's initial value rather than a parameter (docs/proposals/predictionActualWindow.md, step 5): located by nodeIndex and
    // stateIndex, and parameterId holds the state's id (ids are unique across the whole document).
    bool state = false;
    std::size_t stateIndex = 0;
    std::size_t edgeIndex = 0;
    std::size_t nodeIndex = 0;
    std::size_t sourceTermIndex = 0;
    std::size_t parameterIndex = 0;
    std::uint64_t parameterId = 0;
    std::string name;
    double initialValue = 0.0;
    ParameterBounds bounds;
};

// Scans relationship, source-term and shared parameters, and states (their initial values), for every entry with a "tuning" child.
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

// A limit on a number the run produces, written like an objective: `expression` stays at most (or at least) `limit`. The search is not
// forbidden from breaking it; breaking it adds a penalty to the score that grows with the square of how far past the limit it went,
// relative to the limit, and is large against the starting objective, so the search settles inside the limit when it can.
struct FittingConstraint {
    std::string expression;
    bool atMost = true;
    double limit = 0.0;
};

// An objective written as a C++ or Python program (runMeasure.hpp's ProgramMeasure, docs/proposals/tuningEditorsAndPrograms.md): its
// source, the keys it reads and what each is bound to, and how to build and run it.
struct ProgramBinding {
    std::string key;
    std::string kind;          // "state", "parameter" or "measured"
    std::uint64_t id = 0;      // the state or the tuned parameter
    std::string column;        // the measured column
};

struct ObjectiveProgram {
    std::string language;      // "cpp" or "python"
    std::string source;
    std::vector<ProgramBinding> bindings;
    std::string pythonInterpreter;
    std::string pythonSdkPath;
    std::string cppCompiler;
    std::string cppSdkPath;    // the engine/ root: include/ and src/objectiveProgramMain.cpp
    std::string buildDirectory;
    double timeoutSeconds = 60.0;
};

struct FittingProblem {
    boost::property_tree::ptree baseDocument;
    InferenceSeries measured; // parseInferenceCsv()'s output -- reused as-is for the measured data
    std::vector<FittingSignalMapping> mapping;
    std::vector<TunableParameter> tunableParameters;
    std::string optimizerBackendId = "nlopt-bobyqa";
    FittingOptions options;
    // An objective written as an expression (see fittingObjective.hpp) in place of the squared error against `measured`. When it is set the
    // run's length and step come from targetTime and timeStep, since no measured series defines them, `mapping` is not used, and
    // `measured` (if any) is only there for columns the expression names. `maximize` makes the search maximise it; every value
    // the fit reports (events, the report) is the objective as written, rising when maximising.
    std::string objective;
    bool maximize = false;
    std::vector<ObjectiveVariable> objectiveVariables;
    double targetTime = 0.0;
    double timeStep = 0.0;
    std::vector<FittingConstraint> constraints; // used with an objective only
    // An objective written as a program, in place of `objective`; the run's length and step come from targetTime and timeStep as
    // for an expression, and limits are still expressions.
    std::optional<ObjectiveProgram> program;
};

// Reads the objective file `fit --objective-file` takes -- { expression, direction, targetTime, timeStep, variables, constraints } -- into
// `problem` (see FittingProblem). Throws on a file that is not that shape.
void loadFittingObjective(const std::filesystem::path& path, FittingProblem& problem);

// Throws std::invalid_argument, with a sentence a person can act on, when the objective or a limit in `problem` cannot be used.
void checkFittingObjective(const FittingProblem& problem);


struct FittingReport {
    std::string backend;
    std::vector<FittingProgressUpdate> iterations;
    std::vector<std::pair<std::uint64_t, double>> finalParameters; // parameterId -> fitted value
    bool converged = false;
    std::string terminationReason;
    double finalLoss = 0.0;
    std::size_t evaluations = 0;
    std::size_t failedTrials = 0;
    double elapsedSeconds = 0.0;
    bool stopped = false; // ended by a stop request or the time limit, with the best found so far
    double finalViolation = 0.0; // the largest relative constraint violation of the best values, 0 when they all hold
};

// One simulation of a fit, as it finishes: what the app shows while a fit runs (see FittingProgressEvent in the protocol).
struct FittingTrialEvent {
    std::size_t iteration = 0;
    double loss = 0.0;
    double bestLoss = 0.0;
    bool failed = false;
    std::size_t failedTrials = 0;
    double elapsedSeconds = 0.0;
    std::vector<double> parameterValues;
    std::vector<double> bestParameterValues;
    bool baseline = false;
    std::vector<std::uint64_t> parameterIds; // set on the baseline event only
    double violation = 0.0;
    double bestViolation = 0.0;
};

// What a caller may watch and ask of a running fit. Both are optional.
struct FittingMonitor {
    std::function<void(const FittingTrialEvent&)> onTrial;
    // Polled before each simulation; true ends the search at once, and the report carries the best found so far.
    std::function<bool()> stopRequested;
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
// One simulation, scored: the objective (negated when maximising, since the search always minimises) and how far the constraints were
// broken: the sum of squares of the relative violations, which is what the penalty is made from, and the largest single one.
struct FittingTrialScore {
    double objective = 0.0;
    double violationSquares = 0.0;
    double worstViolation = 0.0;
};
FittingTrialScore evaluateFittingTrial(const FittingProblem& problem, const std::vector<double>& parameterValues,
    const std::filesystem::path& scratchOutputPath);

double evaluateFittingLoss(const FittingProblem& problem, const std::vector<double>& parameterValues,
    const std::filesystem::path& scratchOutputPath);

// Drives the chosen optimizer backend (see optimizerBackend.hpp, nloptBackend.hpp) to minimize
// evaluateFittingLoss() over problem.tunableParameters, starting from their current values.
//
// A simulation that fails (it throws, or scores a value that is not a number) does not end the search: it scores as ten times the
// worst finite loss seen so far (1e12 before there is one), so the optimizer steers away from it, and it is counted in the report.
// The report always carries the best values actually simulated, which is what an optimizer's own answer is expected to be anyway.
FittingReport runParameterFit(const FittingProblem& problem, const FittingProgressCallback& onProgress = nullptr,
    const FittingMonitor& monitor = {});

}
