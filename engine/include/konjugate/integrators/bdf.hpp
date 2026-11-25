/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// BDF, the stiff method for large models, applied to the whole model at once (docs/proposals/integrators.md, BDF): the numerical
// differentiation formulas of orders 1 to 5 (Klopfenstein and Shampine; the variable-step, variable-order form of Shampine and Reichelt's
// ode15s and of SciPy's BDF), kept as a table of backward differences D, rescaled whenever the step changes. Each step predicts from the
// table and corrects by a simplified Newton iteration with the matrix I / c - J, c = h / alpha[order]: the Jacobian and its factorisation
// are kept from step to step for as long as Newton converges with them -- the point of BDF beside Rodas4, which works out both every
// step -- the factorisation redone when the step or the order changes, the Jacobian only when Newton stalls, and both at every global
// step's start, so a run continued from a checkpoint takes the uninterrupted run's steps. The table is the method's memory, carried from
// one global step to the next and kept in checkpoints; it starts again at order 1 where the model's inputs jump: a schedule's corner
// inside a step, an Update or intervention that changed a state between global steps, a live parameter set. Plain C++ with no
// dependency beyond the standard library and stiffSystem.hpp: the engine includes it, and C++ code export pastes it in.

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

// The formulas' coefficients: kappa, each order's departure from BDF (NDF's, ode15s's; 0 at order 5, which is BDF's), gamma[k] the sum
// of 1/j for j = 1..k, alpha = (1 - kappa) gamma, and the error constants kappa gamma + 1 / (k + 1).
struct BdfCoefficients {
    static constexpr std::size_t maximumOrder = 5;
    double kappa[maximumOrder + 1] = {0.0, -0.1850, -1.0 / 9.0, -0.0823, -0.0415, 0.0};
    double gamma[maximumOrder + 1] = {};
    double alpha[maximumOrder + 1] = {};
    double errorConstant[maximumOrder + 1] = {};
    BdfCoefficients() {
        for (std::size_t order = 1; order <= maximumOrder; ++order) gamma[order] = gamma[order - 1] + 1.0 / static_cast<double>(order);
        for (std::size_t order = 0; order <= maximumOrder; ++order) {
            alpha[order] = (1.0 - kappa[order]) * gamma[order];
            errorConstant[order] = kappa[order] * gamma[order] + 1.0 / static_cast<double>(order + 1);
        }
    }
};

// The method's memory between steps, and so between global steps (and in a checkpoint's solver_state): the table of backward differences
// (rows 0 .. maximumOrder + 2, each one value per integrated state, by position), the order, the step, how many steps in a row it has
// been taken at, and every state as the method left it at the last global step's end (to see whether an Update, an intervention or a
// restored state changed one). Empty (`order` 0) before the first step, which then chooses its step.
struct BdfHistory {
    std::size_t order = 0;
    double step = 0.0;
    std::size_t equalSteps = 0;
    std::vector<std::vector<double>> differences;
    std::vector<double> reached;
};

struct BdfStatistics {
    std::size_t acceptedSteps = 0;
    std::size_t rejectedSteps = 0;
    std::size_t evaluations = 0;
    std::size_t jacobians = 0;
    std::size_t factorisations = 0;
    std::size_t newtonIterations = 0;
    // Times the table started again at order 1, the run's first step not counted.
    std::size_t restarts = 0;
    std::size_t denseFallbacks = 0;
    std::size_t highestOrder = 0;
    double smallestStep = std::numeric_limits<double>::infinity();
    double largestStep = 0.0;
};

struct BdfTolerance {
    double relative = 1.0e-6;
    std::vector<double> absolute;
};

// The tolerance BDF works to, for the one asked. BDF's estimate is of the error of the solution it keeps, as in SciPy's BDF and ode15s,
// so each step spends about the whole tolerance; Rodas4 estimates the error of its third-order companion and keeps the fourth-order
// solution, whose error is far smaller. At the same tolerance BDF's answer was therefore 10 to 200 times further out than Rodas4's
// (docs/proposals/integrators.md, BDF, Error control). Working to 0.125 r^1.1 for a relative tolerance r, and the absolute tolerances
// scaled by the same ratio, brings it within a few times Rodas4's error at every tolerance from 1e-3 to 1e-9 on Robertson, Van der Pol at
// mu = 1000, HIRES, a stiff thermal grid and a spread of decays: a thirtieth of the tolerance at 1e-6. Never below 100 epsilon, where
// the differences in the table are rounding, nor above the tolerance asked.
inline BdfTolerance bdfWorkingTolerance(const BdfTolerance& asked) {
    const double floor = 100.0 * std::numeric_limits<double>::epsilon();
    const double relative = std::min(asked.relative, std::max(floor, 0.125 * std::pow(asked.relative, 1.1)));
    const double ratio = relative / asked.relative;
    BdfTolerance working{relative, asked.absolute};
    for (auto& absolute : working.absolute) absolute *= ratio;
    return working;
}

namespace bdfDetail {

inline constexpr std::size_t newtonIterations = 4;
inline constexpr double shrinkLimit = 0.2;
inline constexpr double growLimit = 10.0;

// R(order, factor): the matrix that rescales the table to a step `factor` times the current one (Shampine and Reichelt).
inline void rescaleMatrix(std::size_t order, double factor, double out[BdfCoefficients::maximumOrder + 1][BdfCoefficients::maximumOrder + 1]) {
    for (std::size_t column = 0; column <= order; ++column) out[0][column] = 1.0;
    for (std::size_t row = 1; row <= order; ++row) {
        for (std::size_t column = 0; column <= order; ++column) {
            const double entry = column == 0 ? 0.0
                : (static_cast<double>(row) - 1.0 - factor * static_cast<double>(column)) / static_cast<double>(row);
            out[row][column] = out[row - 1][column] * entry;
        }
    }
}

// The table rescaled for a step `factor` times the current one: rows 0 .. order become (R U)^T times themselves.
inline void rescale(std::vector<std::vector<double>>& differences, std::size_t order, double factor) {
    constexpr std::size_t size = BdfCoefficients::maximumOrder + 1;
    double r[size][size], u[size][size], ru[size][size];
    rescaleMatrix(order, factor, r);
    rescaleMatrix(order, 1.0, u);
    for (std::size_t row = 0; row <= order; ++row) {
        for (std::size_t column = 0; column <= order; ++column) {
            double sum = 0.0;
            for (std::size_t k = 0; k <= order; ++k) sum += r[row][k] * u[k][column];
            ru[row][column] = sum;
        }
    }
    const std::size_t count = differences[0].size();
    std::vector<double> column(order + 1);
    for (std::size_t position = 0; position < count; ++position) {
        for (std::size_t k = 0; k <= order; ++k) column[k] = differences[k][position];
        for (std::size_t row = 0; row <= order; ++row) {
            double sum = 0.0;
            for (std::size_t k = 0; k <= order; ++k) sum += ru[k][row] * column[k];
            differences[row][position] = sum;
        }
    }
}

// The root mean square of value(position) over the integrated states, summed node by node in node order (groups of positions).
template <typename Value>
double norm(const std::vector<std::vector<std::size_t>>& groups, std::size_t count, Value&& value) {
    double total = 0.0;
    for (const auto& group : groups) {
        double partial = 0.0;
        for (const auto position : group) {
            const double term = value(position);
            partial += term * term;
        }
        total += partial;
    }
    return std::sqrt(total / static_cast<double>(std::max<std::size_t>(1, count)));
}

}

// The latches of an events object that has them (events.hpp's Switching), or none.
template <typename Events>
auto latchesOf(const Events& events, int) -> decltype(&events.latches) { return &events.latches; }
template <typename Events>
const std::vector<double>* latchesOf(const Events&, long) { return nullptr; }

// One global step from `startTime` to `endTime`, in as many steps as the tolerance asks for, the last landing exactly on `endTime` and,
// on the way, on every `breakpoints` time (sorted, strictly between the two), after which the table starts again at order 1. `states`
// holds every state at the start and the states reached at the end; only the system's integrated states are integrated, and every other
// state holds its value. `restart` starts the table again at order 1 (a live parameter set at this global step); a state that is not
// what the method left at the last global step's end does too.
//
// `evaluate(evaluation, time, values, derivatives)` as Rodas4's: every integrated state's derivative, `evaluation` counting this global
// step's evaluations from 0, the first at its start. An evaluation at the end of a step that lands is made at the time just before it, so
// a schedule that jumps there is read as it was during the step.
//
// `sampleTimes` (sorted, strictly between `startTime` and `endTime`) and `sample(time, values)`: the states there from the step's
// interpolating polynomial (BDF's dense output), every state not integrated held.
//
// `events` (bdfGlobalStepWithEvents; events.hpp's Switching) as Rodas4's: after each step the error control accepts, a switching
// condition that changed within it is located on the step's interpolating polynomial, and the step is taken again to land on that instant,
// where the condition flips; the right-hand side jumps there, so the derivative and the Jacobian are worked out again and the table starts
// again at order 1, as after a schedule's corner.
template <typename Events, typename Evaluate, typename Sample>
void bdfGlobalStepWithEvents(double startTime, double endTime, std::vector<double>& states, StiffSystem& system, const BdfTolerance& asked,
                             const std::vector<double>& breakpoints, const std::vector<double>& sampleTimes, bool restart, BdfHistory& history,
                             BdfStatistics& statistics, Events& events, Evaluate&& evaluate, Sample&& sample) {
    using namespace bdfDetail;
    static const BdfCoefficients coefficients;
    const BdfTolerance tolerance = bdfWorkingTolerance(asked);
    constexpr std::size_t maximumOrder = BdfCoefficients::maximumOrder;
    const std::size_t count = states.size();
    const std::size_t n = system.integratedStates.size();
    const auto& integratedStates = system.integratedStates;
    const double globalStep = endTime - startTime;
    const double epsilon = std::numeric_limits<double>::epsilon();
    if (n == 0) return;

    // The error groups by position.
    std::vector<std::size_t> position(count, std::numeric_limits<std::size_t>::max());
    for (std::size_t row = 0; row < n; ++row) position[integratedStates[row]] = row;
    std::vector<std::vector<std::size_t>> groups;
    for (const auto& group : system.errorGroups) {
        groups.emplace_back();
        for (const auto index : group) if (position[index] != std::numeric_limits<std::size_t>::max()) groups.back().push_back(position[index]);
    }

    std::vector<double> f0(count, 0.0), derivative(count, 0.0), dT(n, 0.0), jacobian(system.rowStart[n], 0.0);
    std::vector<double> stage(states), predicted(n), corrected(n), correction(n), psi(n), delta(n), scale(n), point(states);
    std::size_t evaluation = 0;
    const auto call = [&](double time, const std::vector<double>& values, std::vector<double>& derivatives) {
        evaluate(evaluation, time, values, derivatives);
        ++evaluation;
        ++statistics.evaluations;
    };
    ShiftedFactorisation factorisation;
    bool factored = false;
    double factoredShift = 0.0;

    double time = startTime;
    call(time, states, f0);
    // The Jacobian afresh at every global step's start.
    assembleJacobian(system, time, states, f0, tolerance.absolute, tolerance.relative, false, globalStep, 0.0, stage, derivative, jacobian, dT, call);
    ++statistics.jacobians;

    // Whether the table still describes where the run is: the integrated states where it left them, every other state unchanged.
    const bool fresh = history.order == 0;
    if (!fresh && !restart) restart = history.reached != states;
    const double newtonTolerance = std::max(10.0 * epsilon / tolerance.relative, std::min(0.03, std::sqrt(tolerance.relative)));
    const auto startTable = [&](double step) {
        history.differences.assign(maximumOrder + 3, std::vector<double>(n, 0.0));
        for (std::size_t row = 0; row < n; ++row) {
            history.differences[0][row] = states[integratedStates[row]];
            history.differences[1][row] = step * f0[integratedStates[row]];
        }
        history.order = 1;
        history.step = step;
        history.equalSteps = 0;
        factored = false;
    };
    const double firstTarget = breakpoints.empty() ? endTime : breakpoints.front();
    if (fresh) {
        // Hairer's initial step for order one: from the size of y and f, then one more evaluation to estimate the second derivative.
        const auto weight = [&](std::size_t row) { return tolerance.absolute[integratedStates[row]] + tolerance.relative * std::abs(states[integratedStates[row]]); };
        const double derivativeSize = norm(groups, n, [&](std::size_t row) { return f0[integratedStates[row]] / weight(row); });
        const double stateSize = norm(groups, n, [&](std::size_t row) { return states[integratedStates[row]] / weight(row); });
        double guess = derivativeSize < 1.0e-5 || stateSize < 1.0e-5 ? 1.0e-6 : 0.01 * stateSize / derivativeSize;
        guess = std::min(guess, firstTarget - startTime);
        for (std::size_t row = 0; row < n; ++row) stage[integratedStates[row]] = states[integratedStates[row]] + guess * f0[integratedStates[row]];
        call(time + guess, stage, derivative);
        for (std::size_t row = 0; row < n; ++row) stage[integratedStates[row]] = states[integratedStates[row]];
        const double secondDerivative = norm(groups, n, [&](std::size_t row) {
            return (derivative[integratedStates[row]] - f0[integratedStates[row]]) / weight(row); }) / guess;
        const double fromSecond = derivativeSize <= 1.0e-15 && secondDerivative <= 1.0e-15 ? std::max(1.0e-6, guess * 1.0e-3)
            : std::sqrt(0.01 / std::max(derivativeSize, secondDerivative));
        startTable(std::min({100.0 * guess, fromSecond, globalStep}));
    } else if (restart) {
        ++statistics.restarts;
        startTable(std::min(history.step, globalStep));
    }
    auto& D = history.differences;

    std::size_t breakpoint = 0;
    std::size_t nextSample = 0;
    std::size_t rejectedInARow = 0;
    // Why the last step was refused at an evaluation (a program's OutOfDomain), said if no step can then be taken.
    std::string refused;
    // A located event the step is to land on; NaN for none.
    double eventTarget = std::numeric_limits<double>::quiet_NaN();
    const bool locating = events.active();
    std::vector<double> updated(BdfCoefficients::maximumOrder + 3);
    // The Jacobian afresh where the run is, and the table started again at order 1: after the right-hand side jumps. The differences'
    // scratch holds the states it starts from (after an accepted step it still held the step's start, so the columns were perturbed
    // about a point the others were not at).
    const auto startAgain = [&](double step) {
        call(time, states, f0);
        for (std::size_t index = 0; index < count; ++index) stage[index] = states[index];
        assembleJacobian(system, time, states, f0, tolerance.absolute, tolerance.relative, false, globalStep, 0.0, stage, derivative, jacobian, dT, call);
        ++statistics.jacobians;
        ++statistics.restarts;
        startTable(step);
    };
    // The latches the table was built under: a condition read afresh at a step's start (once a global step has chattered, it is no
    // longer located but read as it holds) that has flipped is a jump, and the table starts again.
    const std::vector<double>* latches = locating ? latchesOf(events, 0) : nullptr;
    std::vector<double> builtUnder = latches ? *latches : std::vector<double>{};
    while (true) {
        if (locating) events.beginStep(time, states);
        if (latches && *latches != builtUnder) {
            // Read afresh at each step's start, a condition that slides along its switch flips at nearly every step: the table starts
            // again with a step that may grow tenfold, as at any change of order, or a step of order one could never grow from a sliver.
            startAgain(std::min(globalStep, growLimit * history.step));
            builtUnder = *latches;
        }
        const double scheduled = breakpoint < breakpoints.size() ? breakpoints[breakpoint] : endTime;
        const bool towardEvent = eventTarget <= scheduled;
        const double target = towardEvent ? eventTarget : scheduled;
        if (rejectedInARow == 100) {
            std::ostringstream message;
            message.precision(17);
            message << "The stiff method could not take a step at " << time << " s: a hundred tries in a row failed; the model may be singular "
                    << "there, or change faster than its tolerance allows.";
            if (!refused.empty()) message << " The last try was refused: " << refused;
            throw std::runtime_error(message.str());
        }
        // The step is at most the global step.
        if (history.step > globalStep) {
            rescale(D, history.order, globalStep / history.step);
            history.step = globalStep;
            history.equalSteps = 0;
        }
        const std::size_t order = history.order;
        // The way to the landing in equal steps, when it would otherwise end in a sliver: within four steps of the landing, where the
        // last step would be under half of this one, what is left is divided into as many steps of at most this one as it takes (two to
        // four), each the same, so the last lands exactly. Landing with a sliver leaves the table at the sliver's step, which then takes
        // many steps to grow back (at most tenfold, and only after order + 1 equal steps): on a model whose global step is a few of BDF's
        // steps, two to five times the steps. Where the last step would be half of this one or more, it lands as before, one change of
        // step either way. The table is rescaled exactly to the planned step; its count of equal steps starts again only for a change
        // beyond rounding, so a landing that is the last of the planned steps carries it on.
        {
            const double left = target - time;
            const double steps = left / history.step;
            const double fraction = steps - std::floor(steps);
            if (history.step < left * (1.0 - 1.0e-12) && steps <= 4.0 && fraction > 1.0e-9 && fraction < 0.5) {
                const double pieces = std::ceil(steps * (1.0 - 1.0e-12));
                const double planned = left / pieces;
                if (planned != history.step) {
                    const double factor = planned / history.step;
                    rescale(D, order, factor);
                    history.step = planned;
                    if (std::abs(factor - 1.0) > 1.0e-9) history.equalSteps = 0;
                }
            }
        }
        double step = history.step;
        bool lands = false;
        // Landing, also when what would be left is under a thousandth of this step: a sliver of a step is all rounding, and Newton
        // cannot tell its correction from noise.
        if (step >= (target - time) * (1.0 - 1.0e-12) || target - time - step <= std::max(1.0e-3 * step, 100.0 * std::abs(target) * epsilon)) {
            // The table rescaled for the shorter (or a hair longer) step. The next step goes on from this one, the table
            // grown again only as the error allows: stretching it back at once extrapolates its polynomial, which a steep transient
            // punishes.
            const double landing = target - time;
            // A landing within rounding of the step (the last of the planned equal steps) is rescaled to it exactly, but is the same step:
            // its count of equal steps carries on.
            if (landing != step) {
                rescale(D, order, landing / step);
                if (std::abs(landing - step) > 1.0e-9 * step) history.equalSteps = 0;
            }
            step = landing;
            history.step = step;
            lands = true;
        }
        if (!(step > std::numeric_limits<double>::min()) || !std::isfinite(step) || 0.1 * step <= std::abs(time) * epsilon) {
            std::ostringstream message;
            message.precision(17);
            message << "The stiff method's step became too small to take at " << time << " s: the model may change too fast there for its "
                    << "tolerance, or be singular.";
            throw std::runtime_error(message.str());
        }
        const bool landsOnEvent = lands && towardEvent;
        const bool landsOnEnd = lands && !landsOnEvent && breakpoint == breakpoints.size();
        const double end = !lands ? time + step : (landsOnEnd ? endTime : target);
        const double endEvaluation = lands ? std::nextafter(end, startTime) : end;

        // Predict from the table; psi carries the formula's history into the corrector.
        for (std::size_t row = 0; row < n; ++row) {
            double sum = 0.0;
            for (std::size_t k = 0; k <= order; ++k) sum += D[k][row];
            predicted[row] = sum;
            double past = 0.0;
            for (std::size_t k = 1; k <= order; ++k) past += D[k][row] * coefficients.gamma[k];
            psi[row] = past / coefficients.alpha[order];
            scale[row] = tolerance.absolute[integratedStates[row]] + tolerance.relative * std::abs(predicted[row]);
        }
        const double c = step / coefficients.alpha[order];

        // Correct by simplified Newton: (I / c - J) dy = f - (psi + d) / c, with the Jacobian kept, worked out again at most once a step.
        bool converged = false;
        bool refusedStep = false;
        bool currentJacobian = false;
        std::size_t iterations = 0;
        while (true) {
            if (!factored || factoredShift != 1.0 / c) {
                factoredShift = 1.0 / c;
                ++statistics.factorisations;
                factored = factorisation.factor(system, jacobian, factoredShift, statistics.denseFallbacks);
            }
            converged = false;
            if (factored) {
                for (std::size_t row = 0; row < n; ++row) {
                    corrected[row] = predicted[row];
                    correction[row] = 0.0;
                    stage[integratedStates[row]] = predicted[row];
                }
                double previousNorm = -1.0;
                for (iterations = 0; iterations < newtonIterations; ++iterations) {
                    // States an evaluation refuses (a program's OutOfDomain): as a Newton iteration that does not converge, the step halved.
                    try {
                        call(endEvaluation, stage, derivative);
                    } catch (const StageRejected& refusal) {
                        refused = refusal.what();
                        refusedStep = true;
                        break;
                    }
                    ++statistics.newtonIterations;
                    bool finite = true;
                    for (std::size_t row = 0; row < n; ++row) {
                        const double value = derivative[integratedStates[row]];
                        if (!std::isfinite(value)) finite = false;
                        delta[row] = value - (psi[row] + correction[row]) / c;
                    }
                    if (!finite) break;
                    factorisation.solve(system, delta);
                    const double deltaNorm = norm(groups, n, [&](std::size_t row) { return delta[row] / scale[row]; });
                    const double rate = previousNorm >= 0.0 ? deltaNorm / previousNorm : -1.0;
                    if (rate >= 0.0 && (rate >= 1.0 || std::pow(rate, static_cast<double>(newtonIterations - iterations)) / (1.0 - rate) * deltaNorm > newtonTolerance)) {
                        break;
                    }
                    for (std::size_t row = 0; row < n; ++row) {
                        corrected[row] += delta[row];
                        correction[row] += delta[row];
                        stage[integratedStates[row]] = corrected[row];
                    }
                    // Converged: by the rate's estimate of what is left, or at once when the correction is already far below the
                    // tolerance (where the rate measures only rounding).
                    if (deltaNorm <= 1.0e-3 * newtonTolerance || (rate >= 0.0 && rate / (1.0 - rate) * deltaNorm < newtonTolerance)) {
                        converged = true;
                        ++iterations;
                        break;
                    }
                    previousNorm = deltaNorm;
                }
            }
            if (converged || currentJacobian || refusedStep) break;
            // Newton stalled with an old Jacobian: work it out again where the step is going, and try once more.
            for (std::size_t row = 0; row < n; ++row) stage[integratedStates[row]] = predicted[row];
            call(endEvaluation, stage, f0);
            for (std::size_t index = 0; index < count; ++index) point[index] = stage[index];
            assembleJacobian(system, endEvaluation, stage, f0, tolerance.absolute, tolerance.relative, false, globalStep, 0.0, point, derivative,
                jacobian, dT, call);
            for (std::size_t index = 0; index < count; ++index) point[index] = states[index];
            ++statistics.jacobians;
            factored = false;
            currentJacobian = true;
        }
        for (std::size_t row = 0; row < n; ++row) stage[integratedStates[row]] = states[integratedStates[row]];
        if (!converged && step <= 1.0e4 * epsilon * std::abs(end)) {
            // A sliver of a step, a few thousand units in the last place of the time, cannot be corrected (a rate that switches with a
            // state right there sends Newton back and forth) and cannot change a state measurably: its prediction is taken as it is.
            for (std::size_t row = 0; row < n; ++row) {
                corrected[row] = predicted[row];
                correction[row] = 0.0;
            }
            converged = true;
            iterations = newtonIterations;
        }
        if (!converged) {
            // Half the step from the same start.
            rescale(D, order, 0.5);
            history.step = 0.5 * step;
            history.equalSteps = 0;
            ++statistics.rejectedSteps;
            ++rejectedInARow;
            continue;
        }

        const double safety = 0.9 * static_cast<double>(2 * newtonIterations + 1) / static_cast<double>(2 * newtonIterations + iterations);
        for (std::size_t row = 0; row < n; ++row) scale[row] = tolerance.absolute[integratedStates[row]] + tolerance.relative * std::abs(corrected[row]);
        const double error = norm(groups, n, [&](std::size_t row) { return coefficients.errorConstant[order] * correction[row] / scale[row]; });
        if (!(error <= 1.0)) {
            const double factor = std::isfinite(error) ? std::max(shrinkLimit, safety * std::pow(error, -1.0 / static_cast<double>(order + 1))) : shrinkLimit;
            rescale(D, order, factor);
            history.step = step * factor;
            history.equalSteps = 0;
            ++statistics.rejectedSteps;
            ++rejectedInARow;
            continue;
        }

        // A switching condition that changed within the step: the step is taken again to land on the instant it changed. The step's
        // interpolating polynomial is the table as this step would leave it, worked out aside, since the table must not move yet.
        if (locating && !landsOnEvent) {
            const auto at = [&](double when, std::vector<double>& out) {
                out.resize(count);
                for (std::size_t index = 0; index < count; ++index) out[index] = states[index];
                if (when == end) {
                    for (std::size_t row = 0; row < n; ++row) out[integratedStates[row]] = corrected[row];
                    return;
                }
                for (std::size_t row = 0; row < n; ++row) {
                    updated[order + 1] = correction[row];
                    for (std::size_t k = order + 1; k-- > 0;) updated[k] = D[k][row] + updated[k + 1];
                    double value = updated[0];
                    double product = 1.0;
                    for (std::size_t k = 0; k < order; ++k) {
                        product *= (when - (end - step * static_cast<double>(k))) / (step * static_cast<double>(k + 1));
                        value += updated[k + 1] * product;
                    }
                    out[integratedStates[row]] = value;
                }
            };
            double eventTime = 0.0;
            if (events.locate(time, end, at, eventTime)) {
                if (!(eventTime > time)) {
                    // At the step's very start: the condition flips there, and the method starts again in the new mode.
                    events.fire(time);
                    startAgain(history.step);
                    if (latches) builtUnder = *latches;
                } else {
                    eventTarget = eventTime;
                }
                continue;
            }
        }

        // Accepted: the table moves on.
        rejectedInARow = 0;
        ++statistics.acceptedSteps;
        statistics.smallestStep = std::min(statistics.smallestStep, step);
        statistics.largestStep = std::max(statistics.largestStep, step);
        statistics.highestOrder = std::max(statistics.highestOrder, order);
        ++history.equalSteps;
        for (std::size_t row = 0; row < n; ++row) {
            D[order + 2][row] = correction[row] - D[order + 1][row];
            D[order + 1][row] = correction[row];
        }
        for (std::size_t k = order + 1; k-- > 0;) {
            for (std::size_t row = 0; row < n; ++row) D[k][row] += D[k + 1][row];
        }
        // The dense output: the interpolating polynomial through the step's end and the order before it, at every sample time it covers.
        while (nextSample < sampleTimes.size() && sampleTimes[nextSample] <= end) {
            const double at = sampleTimes[nextSample];
            for (std::size_t index = 0; index < count; ++index) point[index] = states[index];
            for (std::size_t row = 0; row < n; ++row) {
                double value = D[0][row];
                double product = 1.0;
                for (std::size_t k = 0; k < order; ++k) {
                    product *= (at - (end - step * static_cast<double>(k))) / (step * static_cast<double>(k + 1));
                    value += D[k + 1][row] * product;
                }
                point[integratedStates[row]] = value;
            }
            sample(at, static_cast<const std::vector<double>&>(point));
            ++nextSample;
        }
        for (std::size_t index = 0; index < count; ++index) point[index] = states[index];
        for (std::size_t row = 0; row < n; ++row) states[integratedStates[row]] = corrected[row];
        time = end;

        // The order and the next step: after order + 1 steps at this order, the order among order - 1, order and order + 1 that allows
        // the longest step.
        if (history.equalSteps >= order + 1) {
            const double lower = order > 1
                ? norm(groups, n, [&](std::size_t row) { return coefficients.errorConstant[order - 1] * D[order][row] / scale[row]; })
                : std::numeric_limits<double>::infinity();
            const double higher = order < maximumOrder
                ? norm(groups, n, [&](std::size_t row) { return coefficients.errorConstant[order + 1] * D[order + 2][row] / scale[row]; })
                : std::numeric_limits<double>::infinity();
            const double errors[3] = {lower, error, higher};
            double best = -1.0;
            std::size_t choice = 0;
            for (std::size_t which = 0; which < 3; ++which) {
                const double factor = std::pow(errors[which], -1.0 / static_cast<double>(order + which));
                if (factor > best) { best = factor; choice = which; }
            }
            const std::size_t newOrder = order + choice - 1;
            const double factor = std::min(growLimit, safety * best);
            history.order = newOrder;
            rescale(D, newOrder, factor);
            history.step = step * factor;
            history.equalSteps = 0;
        }
        if (landsOnEvent) {
            events.fire(time);
            eventTarget = std::numeric_limits<double>::quiet_NaN();
        }
        // The programs' memory advanced with the step accepted (never for one rejected or taken again to land on an event). The table holds
        // the states the steps reached, which a change of memory leaves true, so it carries on: the next step's Newton iteration reads the
        // new memory, and a jump it makes shows in the error estimate, which shortens the step, as at any corner not located. (Started
        // again after every step whose memory changed, as an accumulator's does every step, the table would never leave order 1.)
        acceptedStep(events, time, step, states);
        refused.clear();
        const std::size_t breakpointBefore = breakpoint;
        while (breakpoint < breakpoints.size() && breakpoints[breakpoint] <= time) ++breakpoint;
        if (landsOnEnd) break;
        if (landsOnEvent && !(time < endTime)) {
            // An event on the global step's end: the table starts again here, in the new mode, for the next global step.
            startAgain(history.step);
            break;
        }
        if (landsOnEvent) {
            // Past an event the right-hand side has jumped: the Jacobian afresh, and the table from order 1.
            startAgain(history.step);
            if (latches) builtUnder = *latches;
        } else if (breakpoint != breakpointBefore) {
            // Past a schedule's corner the history no longer describes the model: start again at order 1 from here.
            call(time, states, f0);
            ++statistics.restarts;
            startTable(history.step);
        }
    }
    // What the next global step checks: every state, as the method leaves it.
    history.reached = states;
}

// No switching conditions located.
struct BdfNoEvents {
    bool active() const { return false; }
    void beginStep(double, const std::vector<double>&) {}
    template <typename At>
    bool locate(double, double, At&&, double&) { return false; }
    void fire(double) {}
};

// bdfGlobalStepWithEvents with no switching conditions located.
template <typename Evaluate, typename Sample>
void bdfGlobalStep(double startTime, double endTime, std::vector<double>& states, StiffSystem& system, const BdfTolerance& tolerance,
                   const std::vector<double>& breakpoints, const std::vector<double>& sampleTimes, bool restart, BdfHistory& history,
                   BdfStatistics& statistics, Evaluate&& evaluate, Sample&& sample) {
    BdfNoEvents none;
    bdfGlobalStepWithEvents(startTime, endTime, states, system, tolerance, breakpoints, sampleTimes, restart, history, statistics, none, evaluate,
        sample);
}

}
