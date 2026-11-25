/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Rodas5P, the fifth-order stiff method, applied to the whole model at once (docs/proposals/integrators.md): an eight-stage Rosenbrock
// method of order five with an embedded order-four error estimate, L-stable and stiffly accurate, with a fourth-order dense output
// (Steinebach, Construction of Rosenbrock-Wanner method Rodas5P and numerical benchmarks within the Julia Differential Equations
// package, BIT Numerical Mathematics 63, 27 (2023); the coefficients as that paper and OrdinaryDiffEq.jl give them). It is Rodas4's
// scheme with two more stages: each step works out the Jacobian J = df/dy as Rodas4 does (stiffSystem.hpp's assembleJacobian),
// factorises I / (h gamma) - J once and solves eight linear systems with it; no Newton iteration and no history, so a step can stop on
// any global step and a run can restart from any checkpoint. Where Rodas4 needs many small steps for a tight tolerance, Rodas5P's
// higher order takes far fewer, each a little dearer. Its controller, its memory, its statistics and its tolerances are Rodas4's.
// Plain C++ with no dependency beyond the standard library (and rodas4.hpp, stiffSystem.hpp and linearSolve.hpp, Konjugate's own): the
// engine includes it, and C++ code export pastes it into the program it writes.

#include "rodas4.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace konjugate::integrators {

// The method's coefficients in the same form as Rodas4's: stage i is evaluated at t + c[i] h from y + sum_j a[i][j] k_j, and solves
// (I / (h gamma) - J) k_i = f(stage) + sum_j (C[i][j] / h) k_j + h d[i] df/dt; the step ends at the eighth stage's values plus k8, and
// k8 is the error estimate (the solution less the embedded one). The dense output's coefficients are H: w_r = sum_i H[r][i] k_i, and
// y(t + theta h) = y0 (1 - theta) + theta (y1 + (1 - theta) (w1 + theta (w2 + theta w3))).
struct Rodas5PTableau {
    static constexpr std::size_t stages = 8;
    static constexpr double gamma = 0.21193756319429014;
    static constexpr double c[stages] = {0.0, 0.6358126895828704, 0.4095798393397535, 0.9769306725060716, 0.4288403609558664, 1.0, 1.0, 1.0};
    static constexpr double d[stages] = {
        0.21193756319429014, -0.42387512638858027, -0.3384627126235924, 1.8046452872882734, 2.325825639765069, 0.0, 0.0, 0.0};
    static constexpr double a[stages][stages - 1] = {
        {0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
        {3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
        {2.849394379747939, 0.45842242204463923, 0.0, 0.0, 0.0, 0.0, 0.0},
        {-6.954028509809101, 2.489845061869568, -10.358996098473584, 0.0, 0.0, 0.0, 0.0},
        {2.8029986275628964, 0.5072464736228206, -0.3988312541770524, -0.04721187230404641, 0.0, 0.0, 0.0},
        {-7.502846399306121, 2.561846144803919, -11.627539656261098, -0.18268767659942256, 0.030198172008377946, 0.0, 0.0},
        {-7.502846399306121, 2.561846144803919, -11.627539656261098, -0.18268767659942256, 0.030198172008377946, 1.0, 0.0},
        {-7.502846399306121, 2.561846144803919, -11.627539656261098, -0.18268767659942256, 0.030198172008377946, 1.0, 1.0}};
    static constexpr double C[stages][stages - 1] = {
        {0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
        {-14.155112264123755, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
        {-17.97296035885952, -2.859693295451294, 0.0, 0.0, 0.0, 0.0, 0.0},
        {147.12150275711716, -1.41221402718213, 71.68940251302358, 0.0, 0.0, 0.0, 0.0},
        {165.43517024871676, -0.4592823456491126, 42.90938336958603, -5.961986721573306, 0.0, 0.0, 0.0},
        {24.854864614690072, -3.0009227002832186, 47.4931110020768, 5.5814197821558125, -0.6610691825249471, 0.0, 0.0},
        {30.91273214028599, -3.1208243349937974, 77.79954646070892, 34.28646028294783, -19.097331116725623, -28.087943162872662, 0.0},
        {37.80277123390563, -3.2571969029072276, 112.26918849496327, 66.9347231244047, -40.06618937091002, -54.66780262877968, -9.48861652309627}};
    static constexpr double H[3][stages] = {
        {25.948786856663858, -2.5579724845846235, 10.433815404888879, -2.3679251022685204, 0.524948541321073, 1.1241088310450404,
         0.4272876194431874, -0.17202221070155493},
        {-9.91568850695171, -0.9689944594115154, 3.0438037242978453, -24.495224566215796, 20.176138334709044, 15.98066361424651,
         -6.789040303419874, -6.710236069923372},
        {11.419903575922262, 2.8879645146136994, 72.92137995996029, 80.12511834622643, -52.072871366152654, -59.78993625266729,
         -0.15582684282751913, 4.883087185713722}};
};

// Rodas5P keeps what Rodas4 keeps: its controller's memory (proposed step, last accepted step and its error), its statistics, its
// tolerances and its system. A checkpoint's solver_state for either is the same record.
using Rodas5PController = Rodas4Controller;
using Rodas5PStatistics = Rodas4Statistics;
using Rodas5PTolerance = Rodas4Tolerance;
using Rodas5PSystem = Rodas4System;

// One global step, as rodas4GlobalStepWithEvents takes it (its comment says what every argument is), with Rodas5P's eight stages, its
// fourth-order dense output and its controller's exponent 1/5 (the error estimate being of order four).
template <typename Events, typename Evaluate, typename Sample>
void rodas5pGlobalStepWithEvents(double startTime, double endTime, std::vector<double>& states, Rodas5PSystem& system,
                                 const Rodas5PTolerance& tolerance, const std::vector<double>& breakpoints, const std::vector<double>& sampleTimes,
                                 std::size_t fixedSteps, bool readsTime, Rodas5PController& controller, Rodas5PStatistics& statistics,
                                 Events& events, Evaluate&& evaluate, Sample&& sample) {
    using T = Rodas5PTableau;
    constexpr std::size_t S = T::stages;
    const std::size_t count = states.size();
    const std::size_t n = system.integratedStates.size();
    const auto& integratedStates = system.integratedStates;
    const double globalStep = endTime - startTime;
    const double stateCount = static_cast<double>(std::max<std::size_t>(1, n));
    std::vector<double> f0(count, 0.0), derivative(count, 0.0), dT(n, 0.0), jacobian(system.rowStart[n], 0.0);
    std::vector<std::vector<double>> k(S, std::vector<double>(n, 0.0));
    std::vector<double> rhs(n), w1(n), w2(n), w3(n);
    std::vector<double> stage(states), next(states), point(states), estimate(count, 0.0);
    std::size_t evaluation = 0;
    const auto call = [&](double time, const std::vector<double>& values, std::vector<double>& derivatives) {
        evaluate(evaluation, time, values, derivatives);
        ++evaluation;
        ++statistics.evaluations;
    };
    ShiftedFactorisation factorisation;
    // Solves (I / (h gamma) - J) x = rhs in place.
    const auto solve = [&](std::vector<double>& values) { factorisation.solve(system, values); };

    double time = startTime;
    call(time, states, f0);

    // Hairer's initial step, for order five: from the size of y and f, then one more evaluation to estimate the second derivative.
    const double firstTarget = breakpoints.empty() ? endTime : breakpoints.front();
    if (!fixedSteps && !(controller.proposedStep > 0.0)) {
        const auto scale = [&](std::size_t index) { return tolerance.absolute[index] + tolerance.relative * std::abs(states[index]); };
        const double derivativeSize = rodas4Detail::groupedSumOfSquares(system.errorGroups, [&](std::size_t index) { return f0[index] / scale(index); });
        const double stateSize = rodas4Detail::groupedSumOfSquares(system.errorGroups, [&](std::size_t index) { return states[index] / scale(index); });
        double guess = derivativeSize <= 1.0e-10 || stateSize <= 1.0e-10 ? 1.0e-6 : std::sqrt(stateSize / derivativeSize) * 0.01;
        guess = std::min(guess, firstTarget - startTime);
        for (const auto index : integratedStates) stage[index] = states[index] + guess * f0[index];
        call(time + guess, stage, derivative);
        for (const auto index : integratedStates) stage[index] = states[index];
        const double secondDerivative = std::sqrt(rodas4Detail::groupedSumOfSquares(system.errorGroups,
            [&](std::size_t index) { return (derivative[index] - f0[index]) / scale(index); }) / stateCount) / guess;
        const double largest = std::max(std::abs(secondDerivative), std::sqrt(derivativeSize / stateCount));
        const double fromSecond = largest <= 1.0e-15 ? std::max(1.0e-6, guess * 1.0e-3) : std::pow(0.01 / largest, 1.0 / 5.0);
        controller.proposedStep = std::min({100.0 * guess, fromSecond, globalStep});
    }

    // Hairer's controller (RODAS's), as Rodas4's: safety 0.9, a step at most six times and at least a fifth of the one before, and
    // Gustafsson's predictive step after an accepted one; the exponent 1/5 for an error estimate of order four.
    constexpr double safety = 0.9;
    constexpr double shrinkLimit = 5.0;
    constexpr double growLimit = 1.0 / 6.0;
    constexpr double exponent = 0.2;
    std::size_t breakpoint = 0;
    std::size_t nextSample = 0;
    std::size_t fixedStep = 0;
    bool rejectedLast = false;
    // Why the last step was refused at a stage, said if the step then becomes too small to take.
    std::string refused;
    bool haveJacobian = false;
    // A located event the step is to land on; NaN for none.
    double eventTarget = std::numeric_limits<double>::quiet_NaN();
    const bool locating = !fixedSteps && events.active();
    // The dense output's three combinations of the stages, w_r = sum_i H[r][i] k_i, for the step just taken.
    const auto denseCombinations = [&] {
        for (std::size_t row = 0; row < n; ++row) {
            double first = 0.0, second = 0.0, third = 0.0;
            for (std::size_t stageIndex = 0; stageIndex < S; ++stageIndex) {
                first += T::H[0][stageIndex] * k[stageIndex][row];
                second += T::H[1][stageIndex] * k[stageIndex][row];
                third += T::H[2][stageIndex] * k[stageIndex][row];
            }
            w1[row] = first;
            w2[row] = second;
            w3[row] = third;
        }
    };
    // y(t + theta h) from the dense output, into `out` (every state; those not integrated hold their values).
    const auto dense = [&](double theta, std::vector<double>& out) {
        const double theta1 = 1.0 - theta;
        for (std::size_t index = 0; index < count; ++index) out[index] = states[index];
        for (std::size_t row = 0; row < n; ++row) {
            const auto index = integratedStates[row];
            out[index] = states[index] * theta1 + theta * (next[index] + theta1 * (w1[row] + theta * (w2[row] + theta * w3[row])));
        }
    };
    while (true) {
        if (locating) events.beginStep(time, states);
        const double scheduled = breakpoint < breakpoints.size() ? breakpoints[breakpoint] : endTime;
        const bool towardEvent = eventTarget <= scheduled;
        const double target = towardEvent ? eventTarget : scheduled;
        if (!haveJacobian) {
            // The Jacobian at the step's start, and df/dt over a time step no longer than half the way to the next landing.
            assembleJacobian(system, time, states, f0, tolerance.absolute, tolerance.relative, readsTime, globalStep, 0.5 * (target - time),
                stage, derivative, jacobian, dT, call);
            ++statistics.jacobians;
            haveJacobian = true;
        }

        const double wanted = fixedSteps ? globalStep / static_cast<double>(fixedSteps) : std::min(controller.proposedStep, globalStep);
        double step = wanted;
        bool lands = false;
        if (fixedSteps) {
            lands = fixedStep + 1 == fixedSteps;
            if (lands) step = endTime - time;
        } else if (step >= (target - time) * (1.0 - 1.0e-12) || target - time - step <= 100.0 * std::abs(target) * std::numeric_limits<double>::epsilon()) {
            // Landing, also when what would be left is too little for the time to resolve, late in a long run.
            step = target - time;
            lands = true;
        }
        // Too small only when it could no longer move the time on (Hairer's test).
        if (!(step > std::numeric_limits<double>::min()) || !std::isfinite(step) || 0.1 * step <= std::abs(time) * std::numeric_limits<double>::epsilon()) {
            std::ostringstream message;
            message.precision(17);
            if (!refused.empty()) message << "The last step was refused: " << refused << " ";
            message << "The stiff method's step became too small to take at " << time << " s: the model may change too fast there for its "
                    << "tolerance, or be singular.";
            throw std::runtime_error(message.str());
        }
        const bool landsOnEvent = lands && towardEvent;
        const bool landsOnEnd = lands && !landsOnEvent && (fixedSteps || breakpoint == breakpoints.size());
        const double end = !lands ? (fixedSteps ? startTime + static_cast<double>(fixedStep + 1) * step : time + step) : (landsOnEnd ? endTime : target);
        // A stage at the step's end (c = 1) of a step that lands is evaluated at the time just before it, as Rodas4's are.
        const double endStage = lands ? std::nextafter(end, startTime) : end;

        // The matrix I / (h gamma) - J, factorised once for the step's eight solves.
        const double diagonal = 1.0 / (step * T::gamma);
        ++statistics.factorisations;
        const bool factored = factorisation.factor(system, jacobian, diagonal, statistics.denseFallbacks);
        if (!factored) {
            // Singular to working precision at this step: half the step from the same start.
            if (fixedSteps) throw std::runtime_error("The stiff method's matrix is singular at a fixed step; take more steps per global step.");
            controller.proposedStep = 0.5 * step;
            rejectedLast = true;
            ++statistics.rejectedSteps;
            continue;
        }

        const double inverse = 1.0 / step;
        try {
            for (std::size_t stageIndex = 0; stageIndex < S; ++stageIndex) {
                // The stage's values y + sum_j a[i][j] k_j, and its derivative there (the first stage's is the step's start, f0).
                const std::vector<double>* stageDerivative = &f0;
                if (stageIndex > 0) {
                    for (std::size_t row = 0; row < n; ++row) {
                        const auto index = integratedStates[row];
                        double value = states[index];
                        for (std::size_t column = 0; column < stageIndex; ++column) value += T::a[stageIndex][column] * k[column][row];
                        stage[index] = value;
                    }
                    call(T::c[stageIndex] == 1.0 ? endStage : time + T::c[stageIndex] * step, stage, derivative);
                    stageDerivative = &derivative;
                }
                const double dStage = step * T::d[stageIndex];
                for (std::size_t row = 0; row < n; ++row) {
                    double coupling = 0.0;
                    for (std::size_t column = 0; column < stageIndex; ++column) coupling += T::C[stageIndex][column] * inverse * k[column][row];
                    rhs[row] = (*stageDerivative)[integratedStates[row]] + dStage * dT[row] + coupling;
                }
                solve(rhs);
                k[stageIndex] = rhs;
            }
            // The solution: the last stage's values plus k8.
            for (std::size_t row = 0; row < n; ++row) next[integratedStates[row]] = stage[integratedStates[row]] + k[S - 1][row];
        } catch (const StageRejected& refusal) {
            // A stage refused its states: a smaller step from the same start, with the same Jacobian, as for too large an error.
            if (fixedSteps) throw;
            refused = refusal.what();
            controller.proposedStep = step / shrinkLimit;
            rejectedLast = true;
            ++statistics.rejectedSteps;
            for (const auto index : integratedStates) stage[index] = states[index];
            continue;
        }

        double error = 0.0;
        if (!fixedSteps) {
            // k8 is the error estimate, by position; the groups list the plan's indexes.
            for (std::size_t row = 0; row < n; ++row) estimate[integratedStates[row]] = k[S - 1][row];
            error = std::sqrt(rodas4Detail::groupedSumOfSquares(system.errorGroups, [&](std::size_t index) {
                return estimate[index] / (tolerance.absolute[index] + tolerance.relative * std::max(std::abs(states[index]), std::abs(next[index])));
            }) / stateCount);
        }
        if (!(error <= 1.0)) {
            // Rejected (a non-finite error too): a smaller step from the same start, with the same Jacobian.
            const double factor = std::isfinite(error) ? std::max(growLimit, std::min(shrinkLimit, std::pow(error, exponent) / safety)) : shrinkLimit;
            controller.proposedStep = step / factor;
            rejectedLast = true;
            ++statistics.rejectedSteps;
            for (const auto index : integratedStates) stage[index] = states[index];
            continue;
        }

        denseCombinations();
        // A switching condition that changed within the step: the step is taken again to land on the instant it changed.
        if (locating && !landsOnEvent) {
            const auto at = [&](double when, std::vector<double>& out) {
                out.resize(count);
                if (when == end) { for (std::size_t index = 0; index < count; ++index) out[index] = next[index]; return; }
                dense((when - time) / step, out);
            };
            double eventTime = 0.0;
            if (events.locate(time, end, at, eventTime)) {
                for (const auto index : integratedStates) stage[index] = states[index];
                if (!(eventTime > time)) {
                    // At the step's very start: the condition flips there, and the derivative and Jacobian are worked out again in the
                    // new mode.
                    events.fire(time);
                    call(time, states, f0);
                    haveJacobian = false;
                } else {
                    eventTarget = eventTime;
                }
                continue;
            }
        }

        // Accepted.
        ++statistics.acceptedSteps;
        statistics.smallestStep = std::min(statistics.smallestStep, step);
        statistics.largestStep = std::max(statistics.largestStep, step);
        while (nextSample < sampleTimes.size() && sampleTimes[nextSample] <= end) {
            dense((sampleTimes[nextSample] - time) / step, point);
            sample(sampleTimes[nextSample], static_cast<const std::vector<double>&>(point));
            ++nextSample;
        }
        for (const auto index : integratedStates) {
            states[index] = next[index];
            stage[index] = next[index];
        }
        time = end;
        if (!fixedSteps) {
            double factor = std::max(growLimit, std::min(shrinkLimit, std::pow(error, exponent) / safety));
            if (controller.previousStep > 0.0) {
                const double predictive = std::max(growLimit, std::min(shrinkLimit,
                    controller.previousStep / step * std::pow(error * error / controller.previousError, exponent) / safety));
                factor = std::max(factor, predictive);
            }
            double proposed = step / factor;
            controller.previousStep = step;
            controller.previousError = std::max(1.0e-2, error);
            if (rejectedLast) proposed = std::min(proposed, step);
            // A step cut short to land is no sign that a longer one would fail: the step wanted before the cut is still good.
            if (lands && step < wanted) proposed = std::max(proposed, wanted);
            controller.proposedStep = std::min(proposed, globalStep);
        }
        rejectedLast = false;
        ++fixedStep;
        if (landsOnEvent) {
            events.fire(time);
            eventTarget = std::numeric_limits<double>::quiet_NaN();
        }
        // The programs' memory advanced with the step accepted, before the derivative where it ended is worked out.
        acceptedStep(events, time, step, states);
        refused.clear();
        while (breakpoint < breakpoints.size() && breakpoints[breakpoint] <= time) ++breakpoint;
        if (landsOnEnd || (landsOnEvent && !(time < endTime))) break;
        // The next step starts from the derivative and Jacobian where this one ended.
        call(time, states, f0);
        haveJacobian = false;
    }
}

// rodas5pGlobalStepWithEvents with no switching conditions located.
template <typename Evaluate, typename Sample>
void rodas5pGlobalStep(double startTime, double endTime, std::vector<double>& states, Rodas5PSystem& system, const Rodas5PTolerance& tolerance,
                       const std::vector<double>& breakpoints, const std::vector<double>& sampleTimes, std::size_t fixedSteps, bool readsTime,
                       Rodas5PController& controller, Rodas5PStatistics& statistics, Evaluate&& evaluate, Sample&& sample) {
    Rodas4NoEvents none;
    rodas5pGlobalStepWithEvents(startTime, endTime, states, system, tolerance, breakpoints, sampleTimes, fixedSteps, readsTime, controller,
        statistics, none, evaluate, sample);
}

}
