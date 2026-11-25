/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Tsit5, adaptive, applied to the whole model at once (docs/proposals/integrators.md): Tsitouras's 5(4) pair (Ch. Tsitouras, Runge–Kutta
// pairs of order 5(4) satisfying only the first column simplifying assumption, Computers & Mathematics with Applications 62, 770–775,
// 2011; the coefficients as OrdinaryDiffEq.jl gives them), seven stages, the seventh the next step's first (first same as last), a
// fifth-order solution with an embedded fourth-order error estimate and a fourth-order dense output from the same stages. It is
// Dormand–Prince 5(4)'s scheme with other coefficients, chosen for a smaller error at the same cost rather than for the simplifying
// assumptions Dormand and Prince imposed, and a stability region reaching a little further (3.51 along the negative real axis, against
// 3.31). Its controller, stiffness test, statistics and tolerances are Dormand–Prince 5(4)'s, so the two differ only in the tableau.
// Plain C++ with no dependency beyond the standard library (and dormandPrince54.hpp, Konjugate's own): the engine includes it, and C++
// code export pastes it into the program it writes, so the exported program steps with exactly this arithmetic.

#include "dormandPrince54.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace konjugate::integrators {

// The method's Butcher tableau, in Dormand–Prince 5(4)'s form: stage k is evaluated at t + c[k] h from y + h sum_j a[k][j] K_j; the step
// ends at y + h sum_k b[k] K_k (b is the seventh row of a), and its error is estimated as h sum_k e[k] K_k. The dense output is
// y(t + theta h) = y + h sum_k b_k(theta) K_k, with b_1(theta) = theta (r[0][0] + theta (r[0][1] + theta (r[0][2] + theta r[0][3]))) and,
// for k > 1, b_k(theta) = theta^2 (r[k][1] + theta (r[k][2] + theta r[k][3])). The stability analysis reads a and b.
struct Tsit5Tableau {
    static constexpr std::size_t stages = 7;
    static constexpr double c[stages] = {0.0, 0.161, 0.327, 0.9, 0.9800255409045097, 1.0, 1.0};
    static constexpr double a[stages][stages] = {
        {0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
        {0.161, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
        {-0.008480655492356989, 0.335480655492357, 0.0, 0.0, 0.0, 0.0, 0.0},
        {2.8971530571054935, -6.359448489975075, 4.3622954328695815, 0.0, 0.0, 0.0, 0.0},
        {5.325864828439257, -11.748883564062828, 7.4955393428898365, -0.09249506636175525, 0.0, 0.0, 0.0},
        {5.86145544294642, -12.92096931784711, 8.159367898576159, -0.071584973281401, -0.028269050394068383, 0.0, 0.0},
        {0.09646076681806523, 0.01, 0.4798896504144996, 1.379008574103742, -3.290069515436081, 2.324710524099774, 0.0}};
    static constexpr double b[stages] = {0.09646076681806523, 0.01, 0.4798896504144996, 1.379008574103742, -3.290069515436081, 2.324710524099774, 0.0};
    static constexpr double e[stages] = {-0.00178001105222577714, -0.0008164344596567469, 0.007880878010261995, -0.1447110071732629,
                                         0.5823571654525552, -0.45808210592918697, 0.015151515151515152};
    static constexpr double r[stages][4] = {
        {1.0, -2.763706197274826, 2.9132554618219126, -1.0530884977290216},
        {0.0, 0.13169999999999998, -0.2234, 0.1017},
        {0.0, 3.9302962368947516, -5.941033872131505, 2.490627285651253},
        {0.0, -12.411077166933676, 30.33818863028232, -16.548102889244902},
        {0.0, 37.50931341651104, -88.1789048947664, 47.37952196281928},
        {0.0, -27.896526289197286, 65.09189467479366, -34.87065786149661},
        {0.0, 1.5, -4.0, 2.5}};
};

using Tsit5Controller = DormandPrince54Controller;
using Tsit5Stiffness = DormandPrince54Stiffness;
using Tsit5Statistics = DormandPrince54Statistics;
using Tsit5Tolerance = DormandPrince54Tolerance;
using Tsit5NoEvents = DormandPrince54NoEvents;

// One global step from `startTime` to `endTime`, exactly as dormandPrince54GlobalStepWithEvents takes it (its comment says what every
// argument means), with Tsit5's tableau, dense output and stiffness threshold.
template <typename Events, typename Evaluate, typename Sample>
void tsit5GlobalStepWithEvents(double startTime, double endTime, std::vector<double>& states, const std::vector<unsigned char>& integrated,
                               const std::vector<std::vector<std::size_t>>& errorGroups, const Tsit5Tolerance& tolerance,
                               const std::vector<double>& breakpoints, const std::vector<double>& sampleTimes, std::size_t fixedSteps,
                               Tsit5Controller& controller, Tsit5Stiffness& stiffness, Tsit5Statistics& statistics, Events& events,
                               Evaluate&& evaluate, Sample&& sample) {
    using T = Tsit5Tableau;
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

    // Hairer's initial step, as Dormand–Prince 5(4) chooses it.
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

    // Hairer's PI controller, as Dormand–Prince 5(4)'s: beta 0.04, safety 0.9, a step at most ten times and at least a fifth of the one before.
    constexpr double beta = 0.04;
    constexpr double exponent = 0.2 - beta * 0.75;
    constexpr double safety = 0.9;
    constexpr double shrinkLimit = 1.0 / 0.2;
    constexpr double growLimit = 1.0 / 10.0;
    // Hairer's stiffness test at Tsit5's stability boundary: DOPRI5's 3.25 is 0.983 of Dormand–Prince's 3.3066, and the same fraction of
    // Tsit5's 3.5069 is 3.45.
    constexpr double stiffnessThreshold = 3.45;
    std::size_t breakpoint = 0;
    std::size_t nextSample = 0;
    std::size_t fixedStep = 0;
    bool rejectedLast = false;
    // A located event the step is to land on; NaN for none.
    double eventTarget = std::numeric_limits<double>::quiet_NaN();
    const bool locating = !fixedSteps && events.active();
    // The dense output's weights b_k(theta), k = 1 to 7, for theta in (0, 1].
    const auto denseWeights = [](double theta, double (&weight)[T::stages]) {
        weight[0] = theta * (T::r[0][0] + theta * (T::r[0][1] + theta * (T::r[0][2] + theta * T::r[0][3])));
        const double theta2 = theta * theta;
        for (std::size_t k = 1; k < T::stages; ++k) weight[k] = theta2 * (T::r[k][1] + theta * (T::r[k][2] + theta * T::r[k][3]));
    };
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
                next[index] = states[index] + step * (T::b[0] * k1[index] + T::b[1] * k2[index] + T::b[2] * k3[index] + T::b[3] * k4[index] +
                    T::b[4] * k5[index] + T::b[5] * k6[index]);
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
                const double estimate = step * (T::e[0] * k1[index] + T::e[1] * k2[index] + T::e[2] * k3[index] + T::e[3] * k4[index] +
                    T::e[4] * k5[index] + T::e[5] * k6[index] + T::e[6] * k7[index]);
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

        // The step's dense output at `when`, within it.
        const auto interpolate = [&](double when, std::vector<double>& out) {
            out.resize(count);
            if (when == end) { for (std::size_t index = 0; index < count; ++index) out[index] = next[index]; return; }
            double weight[T::stages];
            denseWeights((when - time) / step, weight);
            for (std::size_t index = 0; index < count; ++index) {
                if (!integrated[index]) { out[index] = states[index]; continue; }
                out[index] = states[index] + step * (weight[0] * k1[index] + weight[1] * k2[index] + weight[2] * k3[index] + weight[3] * k4[index] +
                    weight[4] * k5[index] + weight[5] * k6[index] + weight[6] * k7[index]);
            }
        };

        // A switching condition that changed within the step: the step is taken again to land on the instant it changed.
        if (locating && !landsOnEvent) {
            double eventTime = 0.0;
            if (events.locate(time, end, interpolate, eventTime)) {
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
            if (stiffDenominator > 0.0 && step * std::sqrt(stiffNumerator / stiffDenominator) > stiffnessThreshold) {
                stiffness.nonStiffSteps = 0;
                if (++stiffness.stiffSteps == 15 && std::isnan(stiffness.detectedAt)) stiffness.detectedAt = time;
            } else if (++stiffness.nonStiffSteps == 6) {
                stiffness.stiffSteps = 0;
            }
        }
        // The dense output: the step's continuous extension of order four, at every sample time it covers.
        while (nextSample < sampleTimes.size() && sampleTimes[nextSample] <= end) {
            interpolate(sampleTimes[nextSample], point);
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

// tsit5GlobalStepWithEvents with no switching conditions located.
template <typename Evaluate, typename Sample>
void tsit5GlobalStep(double startTime, double endTime, std::vector<double>& states, const std::vector<unsigned char>& integrated,
                     const std::vector<std::vector<std::size_t>>& errorGroups, const Tsit5Tolerance& tolerance,
                     const std::vector<double>& breakpoints, const std::vector<double>& sampleTimes, std::size_t fixedSteps,
                     Tsit5Controller& controller, Tsit5Stiffness& stiffness, Tsit5Statistics& statistics, Evaluate&& evaluate, Sample&& sample) {
    Tsit5NoEvents none;
    tsit5GlobalStepWithEvents(startTime, endTime, states, integrated, errorGroups, tolerance, breakpoints, sampleTimes, fixedSteps,
        controller, stiffness, statistics, none, evaluate, sample);
}

}
