/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// The engine's one way of scoring a run (docs/proposals/tuningEditorsAndPrograms.md, "One family of scoring classes"): a tuning's
// objective and each of its limits are each a RunMeasure, which says what run it needs and turns a simulated run into a number. The
// squared error against measured data and an objective written as an expression are two kinds of it, and a program written by a
// person is the next; evaluateFittingTrial() only asks the objective, asks each limit, and combines them, whatever kind each is.

#include "childProcess.hpp"
#include "fittingObjective.hpp"
#include "parameterFitting.hpp"
#include <memory>
#include <optional>
#include <utility>
#include <vector>

namespace konjugate {

// One trial's simulated run, with what a measure may read beside it: the problem's measured data and the trial's parameter values.
// The run as an objective sees it (each state's series, each measured column, each parameter) is put together once, when first asked.
class TrialRun {
public:
    TrialRun(const SimulationSamples& samples, const FittingProblem& problem, const std::vector<double>& parameterValues)
        : samples(samples), problem(problem), parameterValues(parameterValues) {}

    const SimulationSamples& samples;
    const FittingProblem& problem;
    const std::vector<double>& parameterValues;

    const ObjectiveData& objectiveData() const;

private:
    mutable std::optional<ObjectiveData> data_;
};

// How long a run a measure needs, and at what step.
struct RunLength {
    double targetTime = 0.0;
    double timeStep = 0.0;
};

class RunMeasure {
public:
    virtual ~RunMeasure() = default;
    // Throws when the problem cannot give a run (too few measured rows, no length or step), as a trial that cannot be run.
    virtual RunLength runLength() const = 0;
    virtual double evaluate(const TrialRun& run) const = 0;
};

// Fitting measured data: the weighted squared difference between each mapped column and its state, the rows paired with the samples
// by index (both are on the measured series' own grid).
class SquaredErrorMeasure final : public RunMeasure {
public:
    explicit SquaredErrorMeasure(const FittingProblem& problem) : problem_(problem) {}
    RunLength runLength() const override;
    double evaluate(const TrialRun& run) const override;

private:
    const FittingProblem& problem_;
};

// An expression over the run (fittingObjective.hpp), read once and evaluated for every trial.
class ExpressionMeasure final : public RunMeasure {
public:
    ExpressionMeasure(const FittingProblem& problem, const std::string& expression)
        : problem_(problem), expression_(expression, problem.objectiveVariables) {}
    RunLength runLength() const override;
    double evaluate(const TrialRun& run) const override;

private:
    const FittingProblem& problem_;
    FittingObjective expression_;
};

// A person's program (docs/proposals/tuningEditorsAndPrograms.md, "How a program is run"): made ready once (a C++ one compiled,
// against the SDK header and the glue main), started once, and given each trial's run as a framed ObjectiveRunRequest, its answer
// read back with a time limit. A program that crashes, hangs past the limit or raises fails that trial with its own message and is
// started again for the next, so a mistake in it cannot take the tuning or the engine down. It runs in its own process, never in the
// engine's.
class ProgramMeasure final : public RunMeasure {
public:
    // Throws std::invalid_argument, in words a person can act on, when the program cannot be made ready.
    ProgramMeasure(const FittingProblem& problem, const ObjectiveProgram& program);
    RunLength runLength() const override;
    double evaluate(const TrialRun& run) const override;
    // What the last trial reported beside its number, by name.
    const std::vector<std::pair<std::string, double>>& reports() const { return reports_; }

private:
    const FittingProblem& problem_;
    ObjectiveProgram program_;
    std::vector<std::vector<std::string>> commands_;
    std::vector<std::pair<std::string, std::string>> environment_;
    mutable std::unique_ptr<ChildProcess> process_;
    mutable std::vector<std::pair<std::string, double>> reports_;
};

// A limit on a number the objective program reports beside its own (docs/proposals/tuningEditorsAndPrograms.md, "An objective that is
// a program"): read from what the program said about the same trial, which the objective has been asked for first. A trial whose
// program did not report it fails, with the names it did report.
class ReportMeasure final : public RunMeasure {
public:
    ReportMeasure(const ProgramMeasure& program, std::string name) : program_(program), name_(std::move(name)) {}
    RunLength runLength() const override { return program_.runLength(); }
    double evaluate(const TrialRun& run) const override;

private:
    const ProgramMeasure& program_;
    std::string name_;
};

// What a fit scores with, made once for the whole fit: the objective (as written; the caller negates it when maximising) and each
// limit with the measure of what it limits.
struct FittingMeasures {
    std::unique_ptr<RunMeasure> objective;
    std::vector<std::pair<FittingConstraint, std::unique_ptr<RunMeasure>>> limits;
};

FittingMeasures makeFittingMeasures(const FittingProblem& problem);

// One trial with measures already made (evaluateFittingTrial makes them each time it is called on its own).
FittingTrialScore scoreFittingTrial(const FittingProblem& problem, const FittingMeasures& measures, const std::vector<double>& parameterValues,
    const std::filesystem::path& scratchOutputPath);

}
