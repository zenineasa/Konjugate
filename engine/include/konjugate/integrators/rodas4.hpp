/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Rodas4, the stiff method, applied to the whole model at once (docs/proposals/integrators.md): a six-stage Rosenbrock method of order
// four with an embedded order-three error estimate, L-stable and stiffly accurate, with a third-order dense output (Hairer and Wanner,
// Solving Ordinary Differential Equations II, IV.7; the coefficients of the RODAS code, its first method). Each step works out the
// Jacobian J = df/dy by finite differences, perturbing at once every column of one colour of the model's structure, factorises
// I / (h gamma) - J once and solves six linear systems with it; no Newton iteration and no history, so a step can stop on any global
// step and a run can restart from any checkpoint. Plain C++ with no dependency beyond the standard library (and linearSolve.hpp, also
// Konjugate's own): the engine includes it, and C++ code export pastes it into the program it writes.

#include "linearSolve.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <vector>

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

// Above this many integrated states the linear systems are solved by the sparse LU; at or below it, by the dense one.
inline constexpr std::size_t rodas4DenseLimit = 200;

// What the stiff method knows of the model before it runs, worked out once: the integrated states, the pattern of the Jacobian among
// them (entry (i, j) can be non-zero only where state i's derivative reads state j, from the model's graph), the columns' colours, and
// the sparse LU's ordering when the model is large enough to need it.
struct Rodas4System {
    // The plan's indexes of the integrated states, in plan order; position p in every vector below is integratedStates[p].
    std::vector<std::size_t> integratedStates;
    // The Jacobian's pattern by rows of positions, the diagonal always included; its entries, flattened row by row, are the order
    // the Jacobian's values are kept in.
    SparsityRows rows;
    std::vector<std::size_t> rowStart;
    // For each column, the flattened entries in it, as (row, entry).
    std::vector<std::vector<std::pair<std::size_t, std::size_t>>> columnEntries;
    std::vector<std::size_t> colour;
    std::size_t colours = 0;
    // The columns of each colour, in order.
    std::vector<std::vector<std::size_t>> colourColumns;
    std::vector<std::size_t> diagonalEntry;
    bool sparse = false;
    SparseLu sparseLu;
    // The integrated states node by node in node order, each node's in its order: the order the error norm is summed in.
    std::vector<std::vector<std::size_t>> errorGroups;
};

// `integrated` marks the states the method integrates; `reads[i]`, for each integrated state i (the plan's index), lists the states
// its derivative reads (any order, repeats and states not integrated allowed: they are dropped); `errorGroups` as Dormand–Prince's.
inline Rodas4System makeRodas4System(const std::vector<unsigned char>& integrated, const std::vector<std::vector<std::size_t>>& reads,
                                     const std::vector<std::vector<std::size_t>>& errorGroups) {
    Rodas4System system;
    system.errorGroups = errorGroups;
    std::vector<std::size_t> position(integrated.size(), std::numeric_limits<std::size_t>::max());
    for (std::size_t index = 0; index < integrated.size(); ++index) {
        if (!integrated[index]) continue;
        position[index] = system.integratedStates.size();
        system.integratedStates.push_back(index);
    }
    const std::size_t count = system.integratedStates.size();
    system.rows.assign(count, {});
    for (std::size_t row = 0; row < count; ++row) {
        auto& columns = system.rows[row];
        columns.push_back(row);
        const auto state = system.integratedStates[row];
        if (state < reads.size()) {
            for (const auto read : reads[state]) if (read < position.size() && position[read] != std::numeric_limits<std::size_t>::max()) columns.push_back(position[read]);
        }
        std::sort(columns.begin(), columns.end());
        columns.erase(std::unique(columns.begin(), columns.end()), columns.end());
    }
    system.rowStart.assign(count + 1, 0);
    system.columnEntries.assign(count, {});
    system.diagonalEntry.assign(count, 0);
    for (std::size_t row = 0; row < count; ++row) {
        system.rowStart[row + 1] = system.rowStart[row] + system.rows[row].size();
        for (std::size_t index = 0; index < system.rows[row].size(); ++index) {
            const auto column = system.rows[row][index];
            const auto entry = system.rowStart[row] + index;
            system.columnEntries[column].push_back({row, entry});
            if (column == row) system.diagonalEntry[row] = entry;
        }
    }
    system.colour = colourColumns(system.rows, system.colours);
    system.colourColumns.assign(system.colours, {});
    for (std::size_t column = 0; column < count; ++column) system.colourColumns[system.colour[column]].push_back(column);
    system.sparse = count > rodas4DenseLimit;
    if (system.sparse) system.sparseLu.analyse(system.rows);
    return system;
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
template <typename Evaluate, typename Sample>
void rodas4GlobalStep(double startTime, double endTime, std::vector<double>& states, Rodas4System& system, const Rodas4Tolerance& tolerance,
                      const std::vector<double>& breakpoints, const std::vector<double>& sampleTimes, std::size_t fixedSteps, bool readsTime,
                      Rodas4Controller& controller, Rodas4Statistics& statistics, Evaluate&& evaluate, Sample&& sample) {
    using T = Rodas4Tableau;
    const std::size_t count = states.size();
    const std::size_t n = system.integratedStates.size();
    const auto& integratedStates = system.integratedStates;
    const double globalStep = endTime - startTime;
    const double stateCount = static_cast<double>(std::max<std::size_t>(1, n));
    const double root = std::sqrt(std::numeric_limits<double>::epsilon());
    std::vector<double> f0(count, 0.0), derivative(count, 0.0), dT(n, 0.0), jacobian(system.rowStart[n], 0.0);
    std::vector<double> k1(n), k2(n), k3(n), k4(n), k5(n), k6(n), rhs(n), matrix, entries(system.rowStart[n], 0.0);
    std::vector<double> stage(states), next(states), point(states), estimate(count, 0.0);
    std::size_t evaluation = 0;
    const auto call = [&](double time, const std::vector<double>& values, std::vector<double>& derivatives) {
        evaluate(evaluation, time, values, derivatives);
        ++evaluation;
        ++statistics.evaluations;
    };
    DenseLu dense;
    bool useDense = !system.sparse;
    // Solves (I / (h gamma) - J) x = rhs in place.
    const auto solve = [&](std::vector<double>& values) {
        if (useDense) dense.solve(values);
        else system.sparseLu.solve(values);
    };

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
    bool haveJacobian = false;
    while (true) {
        const double target = breakpoint < breakpoints.size() ? breakpoints[breakpoint] : endTime;
        if (!haveJacobian) {
            // The Jacobian at the step's start, column group by column group: every column of a colour perturbed at once, each by
            // sqrt(eps) max(|y_j|, absolute_j / relative), the perturbation taken as the difference the rounding actually made.
            for (std::size_t colour = 0; colour < system.colours; ++colour) {
                for (const auto column : system.colourColumns[colour]) {
                    const auto index = integratedStates[column];
                    const double size = root * std::max(std::abs(states[index]), tolerance.absolute[index] / tolerance.relative);
                    stage[index] = states[index] + size;
                }
                call(time, stage, derivative);
                for (const auto column : system.colourColumns[colour]) {
                    const auto index = integratedStates[column];
                    const double perturbation = stage[index] - states[index];
                    for (const auto& [row, entry] : system.columnEntries[column]) {
                        const auto rowIndex = integratedStates[row];
                        jacobian[entry] = (derivative[rowIndex] - f0[rowIndex]) / perturbation;
                    }
                    stage[index] = states[index];
                }
            }
            // df/dt by a forward difference, over a time step no longer than half the way to the next landing.
            if (readsTime) {
                const double size = std::min(root * std::max(std::abs(time), globalStep), 0.5 * (target - time));
                const double later = time + size;
                call(later, states, derivative);
                const double perturbation = later - time;
                for (std::size_t row = 0; row < n; ++row) {
                    const auto index = integratedStates[row];
                    dT[row] = (derivative[index] - f0[index]) / perturbation;
                }
            }
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
            message << "The stiff method's step became too small to take at " << time << " s: the model may change too fast there for its "
                    << "tolerance, or be singular.";
            throw std::runtime_error(message.str());
        }
        const bool landsOnEnd = lands && (fixedSteps || breakpoint == breakpoints.size());
        const double end = !lands ? (fixedSteps ? startTime + static_cast<double>(fixedStep + 1) * step : time + step) : (landsOnEnd ? endTime : target);
        const double endStage = lands ? std::nextafter(end, startTime) : end;

        // The matrix I / (h gamma) - J, factorised once for the step's six solves.
        const double diagonal = 1.0 / (step * T::gamma);
        for (std::size_t entry = 0; entry < entries.size(); ++entry) entries[entry] = -jacobian[entry];
        for (std::size_t row = 0; row < n; ++row) entries[system.diagonalEntry[row]] += diagonal;
        ++statistics.factorisations;
        bool factored = false;
        useDense = !system.sparse;
        if (system.sparse) {
            factored = system.sparseLu.factor(entries);
            if (!factored) {
                ++statistics.denseFallbacks;
                useDense = true;
            }
        }
        if (useDense) {
            matrix.assign(n * n, 0.0);
            for (std::size_t row = 0; row < n; ++row) {
                for (std::size_t entry = system.rowStart[row]; entry < system.rowStart[row + 1]; ++entry) {
                    matrix[row * n + system.rows[row][entry - system.rowStart[row]]] = entries[entry];
                }
            }
            factored = dense.factor(matrix, n);
        }
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
        if (landsOnEnd) break;
        if (lands) ++breakpoint;
        // The next step starts from the derivative and Jacobian where this one ended.
        call(time, states, f0);
        haveJacobian = false;
    }
}

}
