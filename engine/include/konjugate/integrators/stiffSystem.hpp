/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// What the stiff methods share (docs/proposals/integrators.md, Jacobians for Rodas4 and BDF): the model's structure worked out once --
// the integrated states, the Jacobian's pattern from the model's graph, its columns' colours and the sparse LU's ordering -- the
// Jacobian by coloured finite differences, and the factorisation of shift I - J with Konjugate's own LU, dense or sparse. Rodas4 works out
// a Jacobian and a factorisation every step; BDF keeps both across steps for as long as its Newton iteration converges with them. Plain
// C++ with no dependency beyond the standard library and linearSolve.hpp: the engine includes it, and C++ code export pastes it in.

#include "linearSolve.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <vector>

namespace konjugate::integrators {

// Above this many integrated states the linear systems are solved by the sparse LU; at or below it, by the dense one.
inline constexpr std::size_t stiffDenseLimit = 200;

// What a stiff method knows of the model before it runs, worked out once: the integrated states, the pattern of the Jacobian among
// them (entry (i, j) can be non-zero only where state i's derivative reads state j, from the model's graph), the columns' colours, and
// the sparse LU's ordering when the model is large enough to need it.
struct StiffSystem {
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
inline StiffSystem makeStiffSystem(const std::vector<unsigned char>& integrated, const std::vector<std::vector<std::size_t>>& reads,
                                   const std::vector<std::vector<std::size_t>>& errorGroups) {
    StiffSystem system;
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
    system.sparse = count > stiffDenseLimit;
    if (system.sparse) system.sparseLu.analyse(system.rows);
    return system;
}

// The Jacobian at (time, states), whose derivative there is f0, column group by column group: every column of a colour perturbed at
// once, each by sqrt(eps) max(|y_j|, absolute_j / relative), the perturbation taken as the difference the rounding actually made. `stage`
// holds `states` on entry and on return; `derivative` is scratch. With `readsTime`, df/dt too, by a forward difference over
// min(sqrt(eps) max(|time|, timeScale), timeLimit), into `dT` (one value per position). `call(time, values, derivatives)` evaluates.
template <typename Call>
void differenceJacobian(const StiffSystem& system, double time, const std::vector<double>& states, const std::vector<double>& f0,
                        const std::vector<double>& absolute, double relative, bool readsTime, double timeScale, double timeLimit,
                        std::vector<double>& stage, std::vector<double>& derivative, std::vector<double>& jacobian, std::vector<double>& dT,
                        Call&& call) {
    const auto& integratedStates = system.integratedStates;
    const double root = std::sqrt(std::numeric_limits<double>::epsilon());
    for (std::size_t colour = 0; colour < system.colours; ++colour) {
        for (const auto column : system.colourColumns[colour]) {
            const auto index = integratedStates[column];
            const double size = root * std::max(std::abs(states[index]), absolute[index] / relative);
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
    if (readsTime) {
        const double size = std::min(root * std::max(std::abs(time), timeScale), timeLimit);
        const double later = time + size;
        call(later, states, derivative);
        const double perturbation = later - time;
        for (std::size_t row = 0; row < integratedStates.size(); ++row) {
            const auto index = integratedStates[row];
            dT[row] = (derivative[index] - f0[index]) / perturbation;
        }
    }
}

// shift I - J, factorised with the sparse LU when the system is sparse (falling back to the dense one where it cannot pivot on its
// diagonal) and with the dense LU otherwise, and solved with whichever factorised it.
struct ShiftedFactorisation {
    DenseLu dense;
    bool useDense = true;
    std::vector<double> entries, matrix;

    // False when the matrix is singular to working precision. `denseFallbacks` counts the sparse LU's falls back to the dense one.
    bool factor(StiffSystem& system, const std::vector<double>& jacobian, double shift, std::size_t& denseFallbacks) {
        const std::size_t n = system.integratedStates.size();
        entries.resize(jacobian.size());
        for (std::size_t entry = 0; entry < entries.size(); ++entry) entries[entry] = -jacobian[entry];
        for (std::size_t row = 0; row < n; ++row) entries[system.diagonalEntry[row]] += shift;
        bool factored = false;
        useDense = !system.sparse;
        if (system.sparse) {
            factored = system.sparseLu.factor(entries);
            if (!factored) {
                ++denseFallbacks;
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
        return factored;
    }

    // Solves (shift I - J) x = values in place.
    void solve(const StiffSystem& system, std::vector<double>& values) const {
        if (useDense) dense.solve(values);
        else system.sparseLu.solve(values);
    }
};

}
