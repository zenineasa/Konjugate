/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Dormand–Prince 5(4), adaptive, applied to the whole model at once (docs/proposals/integrators.md): seven stages, the seventh the
// next step's first (first same as last), a fifth-order solution with an embedded fourth-order error estimate, Hairer's PI step
// controller, his stiffness test and his fourth-order dense output (Hairer, Nørsett and Wanner, Solving Ordinary Differential
// Equations I, II.4 to II.6; the DOPRI5 code). Plain C++ with no dependency beyond the standard library: the engine includes it, and
// C++ code export pastes it into the program it writes, so the exported program steps with exactly this arithmetic.

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

// The method's Butcher tableau: stage k is evaluated at time t + c[k] h, from the states y + h sum_j a[k][j] K_j; the step ends at
// y + h sum_k b[k] K_k, and its error is estimated as h sum_k e[k] K_k (the fifth-order solution less the fourth-order one). The
// stability analysis reads it to work out the method's stability function.
struct DormandPrince54Tableau {
    static constexpr std::size_t stages = 7;
    static constexpr double c[stages] = {0.0, 1.0 / 5.0, 3.0 / 10.0, 4.0 / 5.0, 8.0 / 9.0, 1.0, 1.0};
    static constexpr double a[stages][stages] = {
        {0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
        {1.0 / 5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
        {3.0 / 40.0, 9.0 / 40.0, 0.0, 0.0, 0.0, 0.0, 0.0},
        {44.0 / 45.0, -56.0 / 15.0, 32.0 / 9.0, 0.0, 0.0, 0.0, 0.0},
        {19372.0 / 6561.0, -25360.0 / 2187.0, 64448.0 / 6561.0, -212.0 / 729.0, 0.0, 0.0, 0.0},
        {9017.0 / 3168.0, -355.0 / 33.0, 46732.0 / 5247.0, 49.0 / 176.0, -5103.0 / 18656.0, 0.0, 0.0},
        {35.0 / 384.0, 0.0, 500.0 / 1113.0, 125.0 / 192.0, -2187.0 / 6784.0, 11.0 / 84.0, 0.0}};
    static constexpr double b[stages] = {35.0 / 384.0, 0.0, 500.0 / 1113.0, 125.0 / 192.0, -2187.0 / 6784.0, 11.0 / 84.0, 0.0};
    static constexpr double e[stages] = {71.0 / 57600.0, 0.0, -71.0 / 16695.0, 71.0 / 1920.0, -17253.0 / 339200.0, 22.0 / 525.0, -1.0 / 40.0};
    // The dense output's fifth coefficient vector (DOPRI5's d), for the continuous extension of order four.
    static constexpr double d[stages] = {-12715105075.0 / 11282082432.0, 0.0, 87487479700.0 / 32700410799.0, -10690763975.0 / 1880347072.0,
                                         701980252875.0 / 199316789632.0, -1453857185.0 / 822651844.0, 69997945.0 / 29380423.0};
};

// The controller's memory between steps, and so between global steps: the step it proposes next (0 before the first step, which the
// initial step algorithm then chooses) and the error of the last accepted step, which the PI controller reads. A checkpoint keeps
// both (solver_state), so a run continued from it takes the steps the uninterrupted run took, to the bit.
struct DormandPrince54Controller {
    double proposedStep = 0.0;
    double previousError = 1.0e-4;
};

// Hairer's stiffness test, run on every accepted step: h |lambda| estimated from the last two stages; 15 steps in a row near the
// edge of the stability region (h |lambda| > 3.25, with fewer than 6 steps away from it in between) mean the steps are limited by
// stability, not accuracy. It changes no number: it only says so.
struct DormandPrince54Stiffness {
    std::size_t stiffSteps = 0;
    std::size_t nonStiffSteps = 0;
    // The time of the step at which the test first said so; NaN until then.
    double detectedAt = std::numeric_limits<double>::quiet_NaN();
};

struct DormandPrince54Statistics {
    std::size_t acceptedSteps = 0;
    std::size_t rejectedSteps = 0;
    std::size_t evaluations = 0;
    // The smallest and largest accepted step.
    double smallestStep = std::numeric_limits<double>::infinity();
    double largestStep = 0.0;
};

// The tolerances: a state's error is measured against absolute[i] + relative max(|y_i|, |y_i new|), and a step is accepted when the
// root mean square of the measured errors over every integrated state is at most 1.
struct DormandPrince54Tolerance {
    double relative = 1.0e-6;
    std::vector<double> absolute;
};

namespace dormandPrince54Detail {

// The sum of the squares of `value(i)` over the integrated states, group by group in the groups' order and, within a group, in its
// order: the groups are the model's nodes in node order and each node's states in its order (docs/proposals/integrators.md,
// Determinism), so the sum, and every step-size decision made from it, is the same on every backend and in every exported program.
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

inline std::size_t groupedCount(const std::vector<std::vector<std::size_t>>& groups) {
    std::size_t count = 0;
    for (const auto& group : groups) count += group.size();
    return count;
}

}

// One global step from `startTime` to `endTime`, taken in as many steps as the tolerance asks for, the last landing exactly on
// `endTime` and, on the way, on every `breakpoints` time (sorted, strictly between the two): where a schedule's value or slope jumps,
// so no step straddles a jump. The global step is the largest step taken. `states` holds every state at the start and the states
// reached at the end; only the states `integrated` marks are integrated, and every other state holds its value through every stage.
//
// `errorGroups` lists the integrated states, node by node in node order, each node's in its order: the order the error norm is summed
// in. `tolerance.absolute` has one entry per state of `states`.
//
// `fixedSteps`, when not 0, turns the error control off: the global step is taken as that many equal steps, every one accepted, as
// a fixed-step method of order five, breakpoints not landed on (for checking the method's order; the Run dialog does not offer it).
//
// `evaluate(evaluation, time, stageStates, derivatives)` writes into `derivatives` every integrated state's derivative at the stage
// values `stageStates` and the time `time`; `evaluation` counts the evaluations of this global step from 0, the first being at its
// start. A stage at the end of a step that lands on a breakpoint or on `endTime` is evaluated at the time just before it (the
// largest double below it), so a schedule that jumps there is read as it was during the step, and the next step starts by
// evaluating the derivative there again (the first same as last is not reused across a jump).
//
// `sampleTimes` (sorted, strictly between `startTime` and `endTime`) are times at which `sample(time, values)` is called with the
// states there, from the dense output of the step that covers the time: values for every state (an integrated state interpolated,
// every other state held).
//
// `events` (dormandPrince54GlobalStepWithEvents; events.hpp's Switching) locates the model's switching conditions: after each accepted
// step it is asked, on the step's dense output, whether a condition changed within it, and if so the step is retaken to land on that
// instant, as on a breakpoint, and the condition flips there (docs/proposals/integrators.md, Event location). Not with the error control
// off.
template <typename Events, typename Evaluate, typename Sample>
void dormandPrince54GlobalStepWithEvents(double startTime, double endTime, std::vector<double>& states, const std::vector<unsigned char>& integrated,
                                         const std::vector<std::vector<std::size_t>>& errorGroups, const DormandPrince54Tolerance& tolerance,
                                         const std::vector<double>& breakpoints, const std::vector<double>& sampleTimes, std::size_t fixedSteps,
                                         DormandPrince54Controller& controller, DormandPrince54Stiffness& stiffness,
                                         DormandPrince54Statistics& statistics, Events& events, Evaluate&& evaluate, Sample&& sample) {
    using T = DormandPrince54Tableau;
    const std::size_t count = states.size();
    const double globalStep = endTime - startTime;
    const double stateCount = static_cast<double>(std::max<std::size_t>(1, dormandPrince54Detail::groupedCount(errorGroups)));
    std::vector<double> k1(count, 0.0), k2(count, 0.0), k3(count, 0.0), k4(count, 0.0), k5(count, 0.0), k6(count, 0.0), k7(count, 0.0);
    std::vector<double> stage(states), next(states), sixth(states), point(states);
    std::size_t evaluation = 0;
    const auto call = [&](double time, const std::vector<double>& values, std::vector<double>& derivatives) {
        evaluate(evaluation, time, values, derivatives);
        ++evaluation;
        ++statistics.evaluations;
    };
    double time = startTime;
    call(time, states, k1);
    // Why the last step was refused at a stage, said if the step then becomes too small to take.
    std::string refused;

    // Hairer's initial step: from the size of y and f, then one more evaluation to estimate the second derivative. Used only when
    // the controller has proposed nothing yet: the run's first step, or a run started from states the controller did not reach.
    const double firstTarget = breakpoints.empty() ? endTime : breakpoints.front();
    if (!fixedSteps && !(controller.proposedStep > 0.0)) {
        const auto scale = [&](std::size_t index) { return tolerance.absolute[index] + tolerance.relative * std::abs(states[index]); };
        const double derivativeSize = dormandPrince54Detail::groupedSumOfSquares(errorGroups, [&](std::size_t index) { return k1[index] / scale(index); });
        const double stateSize = dormandPrince54Detail::groupedSumOfSquares(errorGroups, [&](std::size_t index) { return states[index] / scale(index); });
        double guess = derivativeSize <= 1.0e-10 || stateSize <= 1.0e-10 ? 1.0e-6 : std::sqrt(stateSize / derivativeSize) * 0.01;
        guess = std::min(guess, firstTarget - startTime);
        for (std::size_t index = 0; index < count; ++index) if (integrated[index]) stage[index] = states[index] + guess * k1[index];
        call(time + guess, stage, k2);
        for (std::size_t index = 0; index < count; ++index) stage[index] = states[index];
        const double secondDerivative = std::sqrt(dormandPrince54Detail::groupedSumOfSquares(errorGroups,
            [&](std::size_t index) { return (k2[index] - k1[index]) / scale(index); }) / stateCount) / guess;
        const double largest = std::max(std::abs(secondDerivative), std::sqrt(derivativeSize / stateCount));
        const double fromSecond = largest <= 1.0e-15 ? std::max(1.0e-6, guess * 1.0e-3) : std::pow(0.01 / largest, 1.0 / 5.0);
        controller.proposedStep = std::min({100.0 * guess, fromSecond, globalStep});
    }

    // Hairer's PI controller (DOPRI5's): beta 0.04, safety 0.9, a step at most ten times and at least a fifth of the one before.
    constexpr double beta = 0.04;
    constexpr double exponent = 0.2 - beta * 0.75;
    constexpr double safety = 0.9;
    constexpr double shrinkLimit = 1.0 / 0.2;
    constexpr double growLimit = 1.0 / 10.0;
    std::size_t breakpoint = 0;
    std::size_t nextSample = 0;
    std::size_t fixedStep = 0;
    bool rejectedLast = false;
    // A located event the step is to land on; NaN for none.
    double eventTarget = std::numeric_limits<double>::quiet_NaN();
    const bool locating = !fixedSteps && events.active();
    while (true) {
        if (locating) events.beginStep(time, states);
        const double scheduled = breakpoint < breakpoints.size() ? breakpoints[breakpoint] : endTime;
        const bool towardEvent = eventTarget <= scheduled;
        const double target = towardEvent ? eventTarget : scheduled;
        const double wanted = fixedSteps ? globalStep / static_cast<double>(fixedSteps) : std::min(controller.proposedStep, globalStep);
        double step = wanted;
        bool lands = false;
        if (fixedSteps) {
            // Error control off: equal steps, the last ending exactly on endTime; breakpoints are not landed on.
            lands = fixedStep + 1 == fixedSteps;
            if (lands) step = endTime - time;
        } else if (step >= (target - time) * (1.0 - 1.0e-12) || target - time - step <= 100.0 * std::abs(target) * std::numeric_limits<double>::epsilon()) {
            // Landing: the step reaches the target, or would end so close short of it that the time could not resolve what is left.
            // Late in a long run (t / H past about 450) rounding can leave a step a few ulps short of a global step, which the first
            // test, relative to the distance left, misses; the sliver left was then refused as too small a step. As Rodas4 lands.
            step = target - time;
            lands = true;
        }
        // Too small to take: Hairer's test, a step the time cannot resolve (a legitimately tiny first step at t = 0 is allowed).
        if (!(step > std::numeric_limits<double>::min()) || !std::isfinite(step) || 0.1 * step <= std::abs(time) * std::numeric_limits<double>::epsilon()) {
            std::ostringstream message;
            message.precision(17);
            message << "The adaptive method's step became too small to take at " << time << " s: the model may change too fast there "
                    << "for its tolerance, or be stiff or singular.";
            if (!refused.empty()) message << " The last step was refused: " << refused;
            throw std::runtime_error(message.str());
        }
        const bool landsOnEvent = lands && towardEvent;
        const bool landsOnEnd = lands && !landsOnEvent && (fixedSteps || breakpoint == breakpoints.size());
        const double end = !lands ? (fixedSteps ? startTime + static_cast<double>(fixedStep + 1) * step : time + step) : (landsOnEnd ? endTime : target);
        // A stage at the step's end is read just before it when the step lands, so a jump at `target` is not seen inside the step.
        const double endStage = lands ? std::nextafter(end, startTime) : end;
        try {
        for (std::size_t index = 0; index < count; ++index) {
            if (integrated[index]) stage[index] = states[index] + step * (T::a[1][0] * k1[index]);
        }
        call(time + T::c[1] * step, stage, k2);
        for (std::size_t index = 0; index < count; ++index) {
            if (integrated[index]) stage[index] = states[index] + step * (T::a[2][0] * k1[index] + T::a[2][1] * k2[index]);
        }
        call(time + T::c[2] * step, stage, k3);
        for (std::size_t index = 0; index < count; ++index) {
            if (integrated[index]) stage[index] = states[index] + step * (T::a[3][0] * k1[index] + T::a[3][1] * k2[index] + T::a[3][2] * k3[index]);
        }
        call(time + T::c[3] * step, stage, k4);
        for (std::size_t index = 0; index < count; ++index) {
            if (integrated[index]) {
                stage[index] = states[index] + step * (T::a[4][0] * k1[index] + T::a[4][1] * k2[index] + T::a[4][2] * k3[index] + T::a[4][3] * k4[index]);
            }
        }
        call(time + T::c[4] * step, stage, k5);
        for (std::size_t index = 0; index < count; ++index) {
            if (integrated[index]) {
                sixth[index] = states[index] + step * (T::a[5][0] * k1[index] + T::a[5][1] * k2[index] + T::a[5][2] * k3[index] +
                    T::a[5][3] * k4[index] + T::a[5][4] * k5[index]);
            }
        }
        call(endStage, sixth, k6);
        for (std::size_t index = 0; index < count; ++index) {
            if (integrated[index]) {
                next[index] = states[index] + step * (T::b[0] * k1[index] + T::b[2] * k3[index] + T::b[3] * k4[index] + T::b[4] * k5[index] +
                    T::b[5] * k6[index]);
            }
        }
        call(endStage, next, k7);
        } catch (const StageRejected& refusal) {
            // A stage refused its states: a smaller step from the same start, as for too large an error.
            if (fixedSteps) throw;
            refused = refusal.what();
            controller.proposedStep = step / shrinkLimit;
            rejectedLast = true;
            ++statistics.rejectedSteps;
            continue;
        }

        double error = 0.0;
        if (!fixedSteps) {
            error = std::sqrt(dormandPrince54Detail::groupedSumOfSquares(errorGroups, [&](std::size_t index) {
                const double estimate = step * (T::e[0] * k1[index] + T::e[2] * k3[index] + T::e[3] * k4[index] + T::e[4] * k5[index] +
                    T::e[5] * k6[index] + T::e[6] * k7[index]);
                return estimate / (tolerance.absolute[index] + tolerance.relative * std::max(std::abs(states[index]), std::abs(next[index])));
            }) / stateCount);
        }
        if (!(error <= 1.0)) {
            // Rejected (a non-finite error too): a smaller step from the same start; the first stage's derivative is still good.
            const double factor = std::isfinite(error) ? std::min(shrinkLimit, std::pow(error, exponent) / safety) : shrinkLimit;
            controller.proposedStep = step / factor;
            rejectedLast = true;
            ++statistics.rejectedSteps;
            continue;
        }

        // A switching condition that changed within the step: the step is taken again to land on the instant it changed.
        if (locating && !landsOnEvent) {
            const auto at = [&](double when, std::vector<double>& out) {
                out.resize(count);
                if (when == end) { for (std::size_t index = 0; index < count; ++index) out[index] = next[index]; return; }
                const double theta = (when - time) / step;
                const double theta1 = 1.0 - theta;
                for (std::size_t index = 0; index < count; ++index) {
                    if (!integrated[index]) { out[index] = states[index]; continue; }
                    const double difference = next[index] - states[index];
                    const double spline = step * k1[index] - difference;
                    const double fourth = difference - step * k7[index] - spline;
                    const double fifth = step * (T::d[0] * k1[index] + T::d[2] * k3[index] + T::d[3] * k4[index] + T::d[4] * k5[index] +
                        T::d[5] * k6[index] + T::d[6] * k7[index]);
                    out[index] = states[index] + theta * (difference + theta1 * (spline + theta * (fourth + theta1 * fifth)));
                }
            };
            double eventTime = 0.0;
            if (events.locate(time, end, at, eventTime)) {
                for (std::size_t index = 0; index < count; ++index) {
                    stage[index] = states[index];
                    next[index] = states[index];
                    sixth[index] = states[index];
                }
                if (!(eventTime > time)) {
                    // At the step's very start: the condition flips there, and the derivative is evaluated again in the new mode.
                    events.fire(time);
                    call(time, states, k1);
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
        {
            const double stiffNumerator = dormandPrince54Detail::groupedSumOfSquares(errorGroups, [&](std::size_t index) { return k7[index] - k6[index]; });
            const double stiffDenominator = dormandPrince54Detail::groupedSumOfSquares(errorGroups, [&](std::size_t index) { return next[index] - sixth[index]; });
            if (stiffDenominator > 0.0 && step * std::sqrt(stiffNumerator / stiffDenominator) > 3.25) {
                stiffness.nonStiffSteps = 0;
                if (++stiffness.stiffSteps == 15 && std::isnan(stiffness.detectedAt)) stiffness.detectedAt = time;
            } else if (++stiffness.nonStiffSteps == 6) {
                stiffness.stiffSteps = 0;
            }
        }
        // The dense output: the step's continuous extension of order four, at every sample time it covers.
        while (nextSample < sampleTimes.size() && sampleTimes[nextSample] <= end) {
            const double theta = (sampleTimes[nextSample] - time) / step;
            const double theta1 = 1.0 - theta;
            for (std::size_t index = 0; index < count; ++index) {
                if (!integrated[index]) { point[index] = states[index]; continue; }
                const double difference = next[index] - states[index];
                const double spline = step * k1[index] - difference;
                const double fourth = difference - step * k7[index] - spline;
                const double fifth = step * (T::d[0] * k1[index] + T::d[2] * k3[index] + T::d[3] * k4[index] + T::d[4] * k5[index] +
                    T::d[5] * k6[index] + T::d[6] * k7[index]);
                point[index] = states[index] + theta * (difference + theta1 * (spline + theta * (fourth + theta1 * fifth)));
            }
            sample(sampleTimes[nextSample], static_cast<const std::vector<double>&>(point));
            ++nextSample;
        }
        for (std::size_t index = 0; index < count; ++index) if (integrated[index]) states[index] = next[index];
        time = end;
        if (!fixedSteps) {
            const double powered = std::pow(error, exponent);
            const double factor = std::max(growLimit, std::min(shrinkLimit, powered / std::pow(controller.previousError, beta) / safety));
            double proposed = step / factor;
            if (rejectedLast) proposed = std::min(proposed, step);
            // A step cut short to land is no sign that a longer one would fail: the step wanted before the cut is still good.
            if (lands && step < wanted) proposed = std::max(proposed, wanted);
            controller.proposedStep = std::min(proposed, globalStep);
            controller.previousError = std::max(error, 1.0e-4);
        }
        rejectedLast = false;
        refused.clear();
        ++fixedStep;
        if (landsOnEvent) {
            events.fire(time);
            eventTarget = std::numeric_limits<double>::quiet_NaN();
        }
        // What the next step reads may have changed with the step accepted (programs' memory): then its first stage is not the last.
        const bool changed = acceptedStep(events, time, step, states);
        while (breakpoint < breakpoints.size() && breakpoints[breakpoint] <= time) ++breakpoint;
        if (landsOnEnd || (landsOnEvent && !(time < endTime))) break;
        if (lands || changed) {
            // Across a jump, or a condition's change, the last stage's derivative is not the next step's first: it is evaluated again.
            call(time, states, k1);
        } else {
            for (std::size_t index = 0; index < count; ++index) if (integrated[index]) k1[index] = k7[index];
        }
        for (std::size_t index = 0; index < count; ++index) {
            stage[index] = states[index];
            next[index] = states[index];
            sixth[index] = states[index];
        }
    }
}


// No switching conditions located.
struct DormandPrince54NoEvents {
    bool active() const { return false; }
    void beginStep(double, const std::vector<double>&) {}
    template <typename At>
    bool locate(double, double, At&&, double&) { return false; }
    void fire(double) {}
};

// dormandPrince54GlobalStepWithEvents with no switching conditions located.
template <typename Evaluate, typename Sample>
void dormandPrince54GlobalStep(double startTime, double endTime, std::vector<double>& states, const std::vector<unsigned char>& integrated,
                               const std::vector<std::vector<std::size_t>>& errorGroups, const DormandPrince54Tolerance& tolerance,
                               const std::vector<double>& breakpoints, const std::vector<double>& sampleTimes, std::size_t fixedSteps,
                               DormandPrince54Controller& controller, DormandPrince54Stiffness& stiffness,
                               DormandPrince54Statistics& statistics, Evaluate&& evaluate, Sample&& sample) {
    DormandPrince54NoEvents none;
    dormandPrince54GlobalStepWithEvents(startTime, endTime, states, integrated, errorGroups, tolerance, breakpoints, sampleTimes, fixedSteps,
        controller, stiffness, statistics, none, evaluate, sample);
}

}
