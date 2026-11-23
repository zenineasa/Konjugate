/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Rodas4, the stiff method, applied to the whole model at once (docs/proposals/integrators.md): a six-stage Rosenbrock method of order
// four with an embedded order-three error estimate, L-stable and stiffly accurate, with a third-order dense output (Hairer and Wanner,
// Solving Ordinary Differential Equations II, IV.7; the coefficients of the RODAS code, its first method). Each step works out the
// Jacobian J = df/dy (exactly where the model's derivatives are known, the rest by finite differences, perturbing at once every column
// of one colour of the model's structure; stiffSystem.hpp's assembleJacobian), factorises
// I / (h gamma) - J once and solves six linear systems with it; no Newton iteration and no history, so a step can stop on any global
// step and a run can restart from any checkpoint. Plain C++ with no dependency beyond the standard library (and linearSolve.hpp, also
// Konjugate's own): the engine includes it, and C++ code export pastes it into the program it writes.

#include "stiffSystem.hpp"

#include <algorithm>
#include <cmath>
#include <concepts>
#include <cstddef>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifndef KONJUGATE_INTEGRATORS_STAGE_REJECTED
#define KONJUGATE_INTEGRATORS_STAGE_REJECTED
namespace konjugate::integrators {

// Thrown by an evaluation at a stage to say its states are outside what it can compute (a program's OutOfDomain, or a value that is not a
// finite number): an adaptive or stiff method rejects the step and tries a smaller one, as it does for too large an error
// (docs/proposals/programSdkV2.md, Exceptions and non-finite values). At the step's start, or with the error control off, it stops the run.
struct StageRejected : std::runtime_error {
    using std::runtime_error::runtime_error;
};

// After each step the method accepts, `events.accepted(time, step, states)` when the events object has one (the engine's: programs'
// memory advanced, docs/proposals/programSdkV2.md); whether the derivative at the step's end must be worked out again because what it
// reads changed. Never called for a step rejected or taken again to land on an event.
template <typename Events>
bool acceptedStep(Events& events, double time, double step, const std::vector<double>& states) {
    if constexpr (requires { { events.accepted(time, step, states) } -> std::convertible_to<bool>; }) return events.accepted(time, step, states);
    else return false;
}

}
#endif


namespace konjugate::integrators {

// The method's coefficients in Hairer's form: stage i is evaluated at t + c[i] h from y + sum_j a[i][j] k_j, and solves
// (I / (h gamma) - J) k_i = f(stage) + sum_j (C[i][j] / h) k_j + h d[i] df/dt; the step ends at the sixth stage's values plus k6, and k6
// is the error estimate (the solution less the embedded one). The dense output's coefficients are hd (rows 1 and 2).
struct Rodas4Tableau {
    static constexpr std::size_t stages = 6;
    static constexpr double gamma = 0.25;
    static constexpr double c[stages] = {0.0, 0.386, 0.21, 0.63, 1.0, 1.0};
    static constexpr double d[4] = {0.25, -0.1043, 0.1035, -0.03620000000000023};
    static constexpr double a[5][4] = {
        {0.0, 0.0, 0.0, 0.0},
        {1.544, 0.0, 0.0, 0.0},
        {0.9466785280815826, 0.2557011698983284, 0.0, 0.0},
        {3.314825187068521, 2.896124015972201, 0.9986419139977817, 0.0},
        {1.221224509226641, 6.019134481288629, 12.53708332932087, -0.6878860361058950}};
    static constexpr double C[6][5] = {
        {0.0, 0.0, 0.0, 0.0, 0.0},
        {-5.6688, 0.0, 0.0, 0.0, 0.0},
        {-2.430093356833875, -0.2063599157091915, 0.0, 0.0, 0.0},
        {-0.1073529058151375, -9.594562251023355, -20.47028614809616, 0.0, 0.0},
        {7.496443313967647, -10.24680431464352, -33.99990352819905, 11.70890893206160, 0.0},
        {8.083246795921522, -7.981132988064893, -31.52159432874371, 16.31930543123136, -6.058818238834054}};
    static constexpr double hd[2][5] = {
        {10.12623508344586, -7.487995877610167, -34.80091861555747, -7.992771707568823, 1.025137723295662},
        {-0.6762803392801253, 6.087714651680015, 16.43084320892478, 24.76722511418386, -6.594389125716872}};
};

// The model's structure, its Jacobian and the factorisation of I / (h gamma) - J are the stiff methods' shared machinery
// (stiffSystem.hpp).
inline constexpr std::size_t rodas4DenseLimit = stiffDenseLimit;
using Rodas4System = StiffSystem;

inline Rodas4System makeRodas4System(const std::vector<unsigned char>& integrated, const std::vector<std::vector<std::size_t>>& reads,
                                     const std::vector<std::vector<std::size_t>>& errorGroups) {
    return makeStiffSystem(integrated, reads, errorGroups);
}

// The controller's memory between steps, and so between global steps (and in a checkpoint's solver_state): the step it proposes next
// (0 before the first, which the initial step algorithm then chooses), and the last accepted step and its error, which Gustafsson's
// predictive controller reads (0 before the first accepted step).
struct Rodas4Controller {
    double proposedStep = 0.0;
    double previousError = 1.0e-2;
    double previousStep = 0.0;
};

struct Rodas4Statistics {
    std::size_t acceptedSteps = 0;
    std::size_t rejectedSteps = 0;
    std::size_t evaluations = 0;
    std::size_t jacobians = 0;
    std::size_t factorisations = 0;
    // Factorisations the sparse LU could not pivot on its diagonal for, solved densely instead.
    std::size_t denseFallbacks = 0;
    double smallestStep = std::numeric_limits<double>::infinity();
    double largestStep = 0.0;
};

// The tolerances: a state's error is measured against absolute[i] + relative max(|y_i|, |y_i new|), and a step is accepted when the
// root mean square of the measured errors over every integrated state is at most 1. `absolute` has one entry per state.
struct Rodas4Tolerance {
    double relative = 1.0e-6;
    std::vector<double> absolute;
};

namespace rodas4Detail {

template <typename Value>
double groupedSumOfSquares(const std::vector<std::vector<std::size_t>>& groups, Value&& value) {
    double total = 0.0;
    for (const auto& group : groups) {
        double partial = 0.0;
        for (const auto index : group) {
            const double term = value(index);
            partial += term * term;
        }
        total += partial;
    }
    return total;
}

}

// One global step from `startTime` to `endTime`, taken in as many steps as the tolerance asks for, the last landing exactly on
// `endTime` and, on the way, on every `breakpoints` time (sorted, strictly between the two), as Dormand–Prince 5(4) lands. `states`
// holds every state at the start and the states reached at the end; only the system's integrated states are integrated, and every
// other state holds its value through every stage.
//
// `fixedSteps`, when not 0, turns the error control off: the global step is taken as that many equal steps, every one accepted,
// breakpoints not landed on (for checking the method's order; the Run dialog does not offer it).
//
// `readsTime`: whether the model's derivatives may depend on time (an equation reading it, a schedule, a program); when they may, df/dt
// is worked out by one more evaluation each step, and when not it is zero.
//
// `evaluate(evaluation, time, stageStates, derivatives)` as Dormand–Prince's: every integrated state's derivative at `stageStates` and
// `time`, `evaluation` counting this global step's evaluations from 0, the first at its start. A stage at the end of a step that lands
// is evaluated at the time just before it, so a schedule that jumps there is read as it was during the step.
//
// `sampleTimes` and `sample(time, values)` as Dormand–Prince's, from Rodas4's third-order dense output.
//
// `events` (rodas4GlobalStepWithEvents; events.hpp's Switching) as Dormand–Prince's: after each step the error control accepts, a
// switching condition that changed within it is located on the step's dense output, and the step is taken again, with the same Jacobian,
// to land on that instant, where the condition flips and the derivative and Jacobian are worked out again. Not with the error control
// off.
template <typename Events, typename Evaluate, typename Sample>
void rodas4GlobalStepWithEvents(double startTime, double endTime, std::vector<double>& states, Rodas4System& system, const Rodas4Tolerance& tolerance,
                                const std::vector<double>& breakpoints, const std::vector<double>& sampleTimes, std::size_t fixedSteps, bool readsTime,
                                Rodas4Controller& controller, Rodas4Statistics& statistics, Events& events, Evaluate&& evaluate, Sample&& sample) {
    using T = Rodas4Tableau;
    const std::size_t count = states.size();
    const std::size_t n = system.integratedStates.size();
    const auto& integratedStates = system.integratedStates;
    const double globalStep = endTime - startTime;
    const double stateCount = static_cast<double>(std::max<std::size_t>(1, n));
    std::vector<double> f0(count, 0.0), derivative(count, 0.0), dT(n, 0.0), jacobian(system.rowStart[n], 0.0);
    std::vector<double> k1(n), k2(n), k3(n), k4(n), k5(n), k6(n), rhs(n);
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

    // Hairer's initial step, for order four: from the size of y and f, then one more evaluation to estimate the second derivative.
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
        const double fromSecond = largest <= 1.0e-15 ? std::max(1.0e-6, guess * 1.0e-3) : std::pow(0.01 / largest, 1.0 / 4.0);
        controller.proposedStep = std::min({100.0 * guess, fromSecond, globalStep});
    }

    // Hairer's controller (RODAS's): safety 0.9, a step at most six times and at least a fifth of the one before, and Gustafsson's
    // predictive step after an accepted one.
    constexpr double safety = 0.9;
    constexpr double shrinkLimit = 5.0;
    constexpr double growLimit = 1.0 / 6.0;
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
        // Too small only when it could no longer move the time on (Hairer's test): a stiff model's first steps may be far smaller than
        // the global step, a species starting at zero with a tiny absolute tolerance among them.
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
        const double endStage = lands ? std::nextafter(end, startTime) : end;

        // The matrix I / (h gamma) - J, factorised once for the step's six solves.
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
        const double c21 = T::C[1][0] * inverse;
        const double c31 = T::C[2][0] * inverse, c32 = T::C[2][1] * inverse;
        const double c41 = T::C[3][0] * inverse, c42 = T::C[3][1] * inverse, c43 = T::C[3][2] * inverse;
        const double c51 = T::C[4][0] * inverse, c52 = T::C[4][1] * inverse, c53 = T::C[4][2] * inverse, c54 = T::C[4][3] * inverse;
        const double c61 = T::C[5][0] * inverse, c62 = T::C[5][1] * inverse, c63 = T::C[5][2] * inverse, c64 = T::C[5][3] * inverse,
                     c65 = T::C[5][4] * inverse;
        const double d1 = step * T::d[0], d2 = step * T::d[1], d3 = step * T::d[2], d4 = step * T::d[3];

        try {
        for (std::size_t row = 0; row < n; ++row) rhs[row] = f0[integratedStates[row]] + d1 * dT[row];
        solve(rhs);
        k1 = rhs;
        for (std::size_t row = 0; row < n; ++row) stage[integratedStates[row]] = states[integratedStates[row]] + T::a[1][0] * k1[row];
        call(time + T::c[1] * step, stage, derivative);
        for (std::size_t row = 0; row < n; ++row) rhs[row] = derivative[integratedStates[row]] + d2 * dT[row] + c21 * k1[row];
        solve(rhs);
        k2 = rhs;
        for (std::size_t row = 0; row < n; ++row) {
            const auto index = integratedStates[row];
            stage[index] = states[index] + T::a[2][0] * k1[row] + T::a[2][1] * k2[row];
        }
        call(time + T::c[2] * step, stage, derivative);
        for (std::size_t row = 0; row < n; ++row) rhs[row] = derivative[integratedStates[row]] + d3 * dT[row] + (c31 * k1[row] + c32 * k2[row]);
        solve(rhs);
        k3 = rhs;
        for (std::size_t row = 0; row < n; ++row) {
            const auto index = integratedStates[row];
            stage[index] = states[index] + T::a[3][0] * k1[row] + T::a[3][1] * k2[row] + T::a[3][2] * k3[row];
        }
        call(time + T::c[3] * step, stage, derivative);
        for (std::size_t row = 0; row < n; ++row) {
            rhs[row] = derivative[integratedStates[row]] + d4 * dT[row] + (c41 * k1[row] + c42 * k2[row] + c43 * k3[row]);
        }
        solve(rhs);
        k4 = rhs;
        for (std::size_t row = 0; row < n; ++row) {
            const auto index = integratedStates[row];
            stage[index] = states[index] + T::a[4][0] * k1[row] + T::a[4][1] * k2[row] + T::a[4][2] * k3[row] + T::a[4][3] * k4[row];
        }
        call(endStage, stage, derivative);
        for (std::size_t row = 0; row < n; ++row) {
            rhs[row] = derivative[integratedStates[row]] + (c51 * k1[row] + c52 * k2[row] + c53 * k3[row] + c54 * k4[row]);
        }
        solve(rhs);
        k5 = rhs;
        for (std::size_t row = 0; row < n; ++row) stage[integratedStates[row]] += k5[row];
        call(endStage, stage, derivative);
        for (std::size_t row = 0; row < n; ++row) {
            rhs[row] = derivative[integratedStates[row]] + (c61 * k1[row] + c62 * k2[row] + c63 * k3[row] + c64 * k4[row] + c65 * k5[row]);
        }
        solve(rhs);
        k6 = rhs;
        for (std::size_t row = 0; row < n; ++row) next[integratedStates[row]] = stage[integratedStates[row]] + k6[row];
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
            // k6 is the error estimate, by position; the groups list the plan's indexes.
            for (std::size_t row = 0; row < n; ++row) estimate[integratedStates[row]] = k6[row];
            error = std::sqrt(rodas4Detail::groupedSumOfSquares(system.errorGroups, [&](std::size_t index) {
                return estimate[index] / (tolerance.absolute[index] + tolerance.relative * std::max(std::abs(states[index]), std::abs(next[index])));
            }) / stateCount);
        }
        if (!(error <= 1.0)) {
            // Rejected (a non-finite error too): a smaller step from the same start, with the same Jacobian.
            const double factor = std::isfinite(error) ? std::max(growLimit, std::min(shrinkLimit, std::pow(error, 0.25) / safety)) : shrinkLimit;
            controller.proposedStep = step / factor;
            rejectedLast = true;
            ++statistics.rejectedSteps;
            for (const auto index : integratedStates) stage[index] = states[index];
            continue;
        }

        // A switching condition that changed within the step: the step is taken again to land on the instant it changed.
        if (locating && !landsOnEvent) {
            const auto at = [&](double when, std::vector<double>& out) {
                out.resize(count);
                if (when == end) { for (std::size_t index = 0; index < count; ++index) out[index] = next[index]; return; }
                const double theta = (when - time) / step;
                const double theta1 = 1.0 - theta;
                for (std::size_t index = 0; index < count; ++index) out[index] = states[index];
                for (std::size_t row = 0; row < n; ++row) {
                    const auto index = integratedStates[row];
                    const double w1 = T::hd[0][0] * k1[row] + T::hd[0][1] * k2[row] + T::hd[0][2] * k3[row] + T::hd[0][3] * k4[row] + T::hd[0][4] * k5[row];
                    const double w2 = T::hd[1][0] * k1[row] + T::hd[1][1] * k2[row] + T::hd[1][2] * k3[row] + T::hd[1][3] * k4[row] + T::hd[1][4] * k5[row];
                    out[index] = states[index] * theta1 + theta * (next[index] + theta1 * (w1 + theta * w2));
                }
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
        // The dense output: y0 (1 - theta) + theta (y1 + (1 - theta) (w1 + theta w2)), w1 and w2 from k1 .. k5.
        while (nextSample < sampleTimes.size() && sampleTimes[nextSample] <= end) {
            const double theta = (sampleTimes[nextSample] - time) / step;
            const double theta1 = 1.0 - theta;
            for (std::size_t index = 0; index < count; ++index) point[index] = states[index];
            for (std::size_t row = 0; row < n; ++row) {
                const auto index = integratedStates[row];
                const double w1 = T::hd[0][0] * k1[row] + T::hd[0][1] * k2[row] + T::hd[0][2] * k3[row] + T::hd[0][3] * k4[row] + T::hd[0][4] * k5[row];
                const double w2 = T::hd[1][0] * k1[row] + T::hd[1][1] * k2[row] + T::hd[1][2] * k3[row] + T::hd[1][3] * k4[row] + T::hd[1][4] * k5[row];
                point[index] = states[index] * theta1 + theta * (next[index] + theta1 * (w1 + theta * w2));
            }
            sample(sampleTimes[nextSample], static_cast<const std::vector<double>&>(point));
            ++nextSample;
        }
        for (const auto index : integratedStates) {
            states[index] = next[index];
            stage[index] = next[index];
        }
        time = end;
        if (!fixedSteps) {
            double factor = std::max(growLimit, std::min(shrinkLimit, std::pow(error, 0.25) / safety));
            if (controller.previousStep > 0.0) {
                const double predictive = std::max(growLimit, std::min(shrinkLimit,
                    controller.previousStep / step * std::pow(error * error / controller.previousError, 0.25) / safety));
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

// No switching conditions located.
struct Rodas4NoEvents {
    bool active() const { return false; }
    void beginStep(double, const std::vector<double>&) {}
    template <typename At>
    bool locate(double, double, At&&, double&) { return false; }
    void fire(double) {}
};

// rodas4GlobalStepWithEvents with no switching conditions located.
template <typename Evaluate, typename Sample>
void rodas4GlobalStep(double startTime, double endTime, std::vector<double>& states, Rodas4System& system, const Rodas4Tolerance& tolerance,
                      const std::vector<double>& breakpoints, const std::vector<double>& sampleTimes, std::size_t fixedSteps, bool readsTime,
                      Rodas4Controller& controller, Rodas4Statistics& statistics, Evaluate&& evaluate, Sample&& sample) {
    Rodas4NoEvents none;
    rodas4GlobalStepWithEvents(startTime, endTime, states, system, tolerance, breakpoints, sampleTimes, fixedSteps, readsTime, controller,
        statistics, none, evaluate, sample);
}

}
