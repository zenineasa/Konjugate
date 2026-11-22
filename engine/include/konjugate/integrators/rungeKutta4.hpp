/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// The classical four-stage, fourth-order Runge–Kutta method, applied to the whole model at once (docs/proposals/integrators.md).
// Plain C++ with no dependency beyond the standard library: the engine includes it, and C++ code export pastes it into the
// program it writes, so the exported program steps with exactly this arithmetic.

#include <cstddef>
#include <vector>

namespace konjugate::integrators {

// The method's Butcher tableau: stage k is evaluated at time t + c[k] h, from the states y + h sum_j a[k][j] K_j; the step ends at
// y + h sum_k b[k] K_k. The stability analysis reads it to work out the method's stability function.
struct RungeKutta4Tableau {
    static constexpr std::size_t stages = 4;
    static constexpr double c[stages] = {0.0, 0.5, 0.5, 1.0};
    static constexpr double a[stages][stages] = {{0.0, 0.0, 0.0, 0.0}, {0.5, 0.0, 0.0, 0.0}, {0.0, 0.5, 0.0, 0.0}, {0.0, 0.0, 1.0, 0.0}};
    static constexpr double b[stages] = {1.0 / 6.0, 1.0 / 3.0, 1.0 / 3.0, 1.0 / 6.0};
};

// One global step of length `globalStep` from `startTime`, taken as `steps` Runge–Kutta 4 steps of globalStep / steps each.
// `states` holds every state at the start and the states reached at the end. Only the states `integrated` marks are integrated;
// every other state (an Update, a state nothing adds a rate to, a state of a node stepped on its own) holds its value through
// every stage, so no arithmetic ever touches it.
//
// `evaluate(step, stage, time, stageStates, derivatives)` writes into `derivatives` every integrated state's derivative at the
// stage values `stageStates` and the time `time`; `step` is the internal step (0 .. steps - 1) and `stage` the stage (0 .. 3).
// It must write a value for every integrated state and must not change `stageStates`.
//
// The arithmetic is fixed, state by state and in this order, so that every backend and every exported program gives the same
// numbers: Y2 = y + (h / 2) K1, Y3 = y + (h / 2) K2, Y4 = y + h K3, and y + h (K1 + 2 K2 + 2 K3 + K4) / 6.
template <typename Evaluate>
void rungeKutta4GlobalStep(double startTime, double globalStep, std::size_t steps, std::vector<double>& states,
                           const std::vector<unsigned char>& integrated, Evaluate&& evaluate) {
    const std::size_t count = states.size();
    std::vector<double> k1(count, 0.0), k2(count, 0.0), k3(count, 0.0), k4(count, 0.0), stage(states);
    const double h = globalStep / static_cast<double>(steps);
    const double half = 0.5 * h;
    for (std::size_t step = 0; step < steps; ++step) {
        const double time = startTime + static_cast<double>(step) * h;
        evaluate(step, std::size_t{0}, time, static_cast<const std::vector<double>&>(states), k1);
        for (std::size_t index = 0; index < count; ++index) if (integrated[index]) stage[index] = states[index] + half * k1[index];
        evaluate(step, std::size_t{1}, time + half, static_cast<const std::vector<double>&>(stage), k2);
        for (std::size_t index = 0; index < count; ++index) if (integrated[index]) stage[index] = states[index] + half * k2[index];
        evaluate(step, std::size_t{2}, time + half, static_cast<const std::vector<double>&>(stage), k3);
        for (std::size_t index = 0; index < count; ++index) if (integrated[index]) stage[index] = states[index] + h * k3[index];
        evaluate(step, std::size_t{3}, time + h, static_cast<const std::vector<double>&>(stage), k4);
        for (std::size_t index = 0; index < count; ++index) {
            if (!integrated[index]) continue;
            states[index] = states[index] + h * (k1[index] + 2.0 * k2[index] + 2.0 * k3[index] + k4[index]) / 6.0;
            stage[index] = states[index];
        }
    }
}

}
