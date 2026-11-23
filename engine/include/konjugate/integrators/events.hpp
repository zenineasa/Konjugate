/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Event location for the whole-model methods (docs/proposals/integrators.md, Event location): a model's switching conditions, each a
// comparison inside a piecewise equation's condition, watched through their switching functions g = a - b; each condition latched
// through a step, so a step never integrates across a switch; a crossing found after a step on the step's own interpolant, the step
// retaken to end exactly on it, and the latch flipped there. Plain C++ with no dependency beyond the standard library: the engine
// includes it, and C++ code export pastes it into the program it writes, so the exported program locates the same events.

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <utility>
#include <vector>

namespace konjugate::integrators {

// A switching condition's comparison: its condition holds when g = a - b is below, at most, above or at least zero.
enum : unsigned char { switchingLess = 0, switchingLessEqual = 1, switchingGreater = 2, switchingGreaterEqual = 3 };

inline bool switchingHolds(unsigned char comparison, double g) {
    switch (comparison) {
    case switchingLess: return g < 0.0;
    case switchingLessEqual: return g <= 0.0;
    case switchingGreater: return g > 0.0;
    default: return g >= 0.0;
    }
}

// A model's switching conditions and what the event location knows of them. `evaluate(time, states, values)` writes every switching
// function's value at (time, states) into `values`. The latches are what the equations read for the conditions through a step (1 holds,
// 0 does not); a condition is armed to be located again once its function has moved away from zero after its last event, so one that
// would flip straight back (a diode at zero current) does not make events without end; and a global step stops locating after `limit`
// events, reading its conditions as they are at each step's start for the rest of it (chattering).
template <typename Evaluate>
struct Switching {
    Evaluate evaluate;
    std::vector<unsigned char> comparisons;
    std::vector<double> latches;
    std::vector<unsigned char> armed;
    // Each function's largest magnitude seen, for how far from zero counts as away.
    std::vector<double> scales;
    std::size_t limit = 100;
    std::size_t eventsThisGlobalStep = 0;
    bool chattering = false;
    // Whether the latches have been read once: a change at a global step's start after that is an event (a switch on the boundary, or
    // one an Update, a control or a schedule made), the first reading of a run is not.
    bool established = false;
    // The events located, (time, condition), appended as they happen; the caller takes them.
    std::vector<std::pair<double, std::size_t>> fired;
    // Scratch.
    std::vector<double> values;
    std::vector<double> point;
    std::vector<std::size_t> candidates;
    std::vector<std::size_t> flipping;

    Switching(Evaluate evaluateFunctions, std::vector<unsigned char> functionComparisons)
        : evaluate(std::move(evaluateFunctions)), comparisons(std::move(functionComparisons)), latches(comparisons.size(), 0.0),
          armed(comparisons.size(), 1), scales(comparisons.size(), 0.0), values(comparisons.size(), 0.0) {}

    bool active() const { return !comparisons.empty(); }

    // Every condition read afresh and armed: a run's start, or states replaced.
    void reset() {
        std::fill(armed.begin(), armed.end(), static_cast<unsigned char>(1));
        std::fill(scales.begin(), scales.end(), 0.0);
        established = false;
    }

    // A global step's start: each armed condition latched as it holds there (Updates, controls and schedules may have changed it since
    // the last step), a condition that flipped at an event and has not yet moved away from zero kept as the event left it.
    void beginGlobalStep(double time, const std::vector<double>& states) {
        eventsThisGlobalStep = 0;
        chattering = false;
        relatch(time, states, established);
        established = true;
    }

    void relatch(double time, const std::vector<double>& states, bool record = false) {
        evaluate(time, states, values);
        for (std::size_t index = 0; index < comparisons.size(); ++index) {
            scales[index] = std::max(scales[index], std::abs(values[index]));
            rearm(index, values[index]);
            if (!armed[index]) continue;
            const double holds = switchingHolds(comparisons[index], values[index]) ? 1.0 : 0.0;
            if (record && holds != latches[index]) fired.emplace_back(time, index);
            latches[index] = holds;
        }
    }

    // A step's start: only while chattering, each condition read as it is.
    void beginStep(double time, const std::vector<double>& states) {
        if (chattering) relatch(time, states);
    }

    bool disagrees(std::size_t index, double g) const { return switchingHolds(comparisons[index], g) != (latches[index] != 0.0); }

    // A condition that flipped is located again once its function is clear of zero, on either side: on the latched side it has moved on,
    // on the other it has turned back (a motion sliding along the switch), which is a change of its own.
    void rearm(std::size_t index, double g) {
        if (!armed[index] && std::abs(g) > 1e-10 * scales[index]) armed[index] = 1;
    }

    // After a step from t0 to t1 (`at(time, states)` writing the states at any time within it, the step's own interpolant): whether an
    // armed condition no longer holds as latched at t1, and if so the earliest time it changes, found by bisection to a tolerance of
    // 1e-12 of the step or rounding, as `eventTime` (the end of the final bracket, where the change has happened), with the conditions
    // that have changed there in `flipping`. Conditions that agree at t1 and have moved away from zero are armed again.
    template <typename At>
    bool locate(double t0, double t1, At&& at, double& eventTime) {
        if (!active() || chattering) return false;
        point.resize(0);
        at(t1, point);
        evaluate(t1, point, values);
        candidates.clear();
        for (std::size_t index = 0; index < comparisons.size(); ++index) {
            scales[index] = std::max(scales[index], std::abs(values[index]));
            rearm(index, values[index]);
            if (armed[index] && disagrees(index, values[index])) candidates.push_back(index);
        }
        if (candidates.empty()) return false;
        const auto anyChanged = [&](double time) {
            at(time, point);
            evaluate(time, point, values);
            for (const auto index : candidates) if (disagrees(index, values[index])) return true;
            return false;
        };
        double low = t0;
        double high = t1;
        const double tolerance = 1e-12 * (t1 - t0) + 4.0 * std::numeric_limits<double>::epsilon() * std::max(std::abs(t0), std::abs(t1));
        if (anyChanged(t0)) {
            high = t0;
        } else {
            while (high - low > tolerance) {
                const double middle = low + 0.5 * (high - low);
                if (!(middle > low && middle < high)) break;
                (anyChanged(middle) ? high : low) = middle;
            }
        }
        // The conditions that have changed, read where they have; then a change within the tolerance of either end is put at that end,
        // so no step is left a sliver long (a switch on a global step's boundary is found at the next step's very start).
        at(high, point);
        evaluate(high, point, values);
        flipping.clear();
        for (const auto index : candidates) if (disagrees(index, values[index])) flipping.push_back(index);
        if (high - t0 <= tolerance) high = t0;
        else if (t1 - high <= tolerance) high = t1;
        eventTime = high;
        return !flipping.empty();
    }

    // The step has landed on the event: the conditions found changing there flip and wait to move away from zero before they are
    // located again. Past `limit` events in a global step, the rest of it reads its conditions as they are at each step's start.
    void fire(double time) {
        for (const auto index : flipping) {
            latches[index] = latches[index] != 0.0 ? 0.0 : 1.0;
            armed[index] = 0;
            fired.emplace_back(time, index);
        }
        flipping.clear();
        if (++eventsThisGlobalStep >= limit) chattering = true;
    }
};

// The cubic Hermite interpolant of a step from (t0, y0, f0) to (t1, y1, f1), at `time`, for the states `integrated` marks; every other
// state holds y0. Third order in time, which keeps a fourth-order method's order in the states it lands on.
inline void hermiteAt(double t0, double t1, const std::vector<double>& y0, const std::vector<double>& f0, const std::vector<double>& y1,
                      const std::vector<double>& f1, const std::vector<unsigned char>& integrated, double time, std::vector<double>& out) {
    const double width = t1 - t0;
    const double s = width > 0.0 ? (time - t0) / width : 0.0;
    const double s2 = s * s;
    const double s3 = s2 * s;
    out.resize(y0.size());
    for (std::size_t index = 0; index < y0.size(); ++index) {
        if (!integrated[index]) { out[index] = y0[index]; continue; }
        out[index] = (2.0 * s3 - 3.0 * s2 + 1.0) * y0[index] + (s3 - 2.0 * s2 + s) * width * f0[index] + (-2.0 * s3 + 3.0 * s2) * y1[index] +
            (s3 - s2) * width * f1[index];
    }
}

// Runge–Kutta 4 for one global step, as rungeKutta4GlobalStep (the same arithmetic, so with no event it gives that function's numbers),
// with events located: after each step a changed condition is found on the step's cubic Hermite interpolant (its end's derivative one
// more evaluation, taken only then), the step is retaken from its start to end on the event, the condition flips, and the rest of the
// step is taken to return to the method's grid, so the global step still ends where it would. `evaluate(step, stage, time, states,
// derivatives)` as for rungeKutta4GlobalStep; a stage numbered 4 or more is an extra evaluation (a retaken step's, or an end's
// derivative), never the global step's first.
template <typename Evaluate, typename SwitchingType>
void rungeKutta4GlobalStepWithEvents(double startTime, double globalStep, std::size_t steps, std::vector<double>& states,
                                     const std::vector<unsigned char>& integrated, SwitchingType& switching, Evaluate&& evaluate) {
    const std::size_t count = states.size();
    std::vector<double> k1(count, 0.0), k2(count, 0.0), k3(count, 0.0), k4(count, 0.0), stage(states), next(states), endRates(count, 0.0);
    const double h = globalStep / static_cast<double>(steps);
    // One step of the method from (time, states) of length `length` into `next`; `first` numbers its stages 0 to 3, otherwise 4 to 7.
    const auto take = [&](std::size_t step, bool first, double time, double length) {
        const double half = 0.5 * length;
        const std::size_t offset = first ? 0 : 4;
        evaluate(step, offset + 0, time, static_cast<const std::vector<double>&>(states), k1);
        for (std::size_t index = 0; index < count; ++index) if (integrated[index]) stage[index] = states[index] + half * k1[index];
        evaluate(step, offset + 1, time + half, static_cast<const std::vector<double>&>(stage), k2);
        for (std::size_t index = 0; index < count; ++index) if (integrated[index]) stage[index] = states[index] + half * k2[index];
        evaluate(step, offset + 2, time + half, static_cast<const std::vector<double>&>(stage), k3);
        for (std::size_t index = 0; index < count; ++index) if (integrated[index]) stage[index] = states[index] + length * k3[index];
        evaluate(step, offset + 3, time + length, static_cast<const std::vector<double>&>(stage), k4);
        for (std::size_t index = 0; index < count; ++index) {
            next[index] = integrated[index] ? states[index] + length * (k1[index] + 2.0 * k2[index] + 2.0 * k3[index] + k4[index]) / 6.0 : states[index];
        }
    };
    for (std::size_t step = 0; step < steps; ++step) {
        const double gridStart = startTime + static_cast<double>(step) * h;
        double time = gridStart;
        bool firstOfStep = true;
        // Within the grid step: steps to the next event, until the grid step's end is reached.
        while (true) {
            switching.beginStep(time, states);
            const double length = firstOfStep ? h : (gridStart + h) - time;
            take(step, firstOfStep, time, length);
            const double end = time + length;
            bool endRatesTaken = false;
            const auto at = [&](double when, std::vector<double>& out) {
                if (when == time) { out = states; return; }
                if (when == end) { out = next; return; }
                if (!endRatesTaken) {
                    evaluate(step, std::size_t{8}, end, static_cast<const std::vector<double>&>(next), endRates);
                    endRatesTaken = true;
                }
                hermiteAt(time, end, states, k1, next, endRates, integrated, when, out);
            };
            double eventTime = 0.0;
            if (!switching.locate(time, end, at, eventTime)) {
                for (std::size_t index = 0; index < count; ++index) if (integrated[index]) states[index] = next[index];
                break;
            }
            if (eventTime > time) {
                take(step, false, time, eventTime - time);
                for (std::size_t index = 0; index < count; ++index) if (integrated[index]) states[index] = next[index];
            }
            switching.fire(eventTime);
            time = eventTime;
            firstOfStep = false;
            if (!(time < gridStart + h)) break;
        }
    }
}

}
