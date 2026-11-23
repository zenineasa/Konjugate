/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Konjugate's own linear algebra for the stiff method (docs/proposals/integrators.md, Jacobians for Rodas4): the colouring that lets
// a finite-difference Jacobian perturb many columns at once, a dense LU with partial pivoting, and a sparse LU with a fill-reducing
// ordering worked out once from the model's structure. Plain C++ with no dependency beyond the standard library: the engine includes
// it, and C++ code export pastes it into the program it writes, so the exported program solves with exactly this arithmetic. Every
// choice -- the colour order, the elimination order, the order of every sum -- is fixed, so the numbers are the same on every run.

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <set>
#include <vector>

namespace konjugate::integrators {

// A square sparsity pattern by rows: rows[i] lists, sorted and each once, the columns j at which entry (i, j) may be non-zero.
using SparsityRows = std::vector<std::vector<std::size_t>>;

// Columns coloured so that no two columns of one colour have a non-zero in the same row (Curtis, Powell and Reid): every column of a
// colour can then be perturbed in one evaluation. Greedy, in column order, each column taking the lowest colour none of the columns
// sharing a row with it has. Returns each column's colour; `colours` is set to how many there are.
inline std::vector<std::size_t> colourColumns(const SparsityRows& rows, std::size_t& colours) {
    const std::size_t count = rows.size();
    std::vector<std::vector<std::size_t>> columnRows(count);
    for (std::size_t row = 0; row < count; ++row) for (const auto column : rows[row]) columnRows[column].push_back(row);
    std::vector<std::size_t> colour(count, 0);
    std::vector<std::size_t> usedBy;
    colours = 0;
    for (std::size_t column = 0; column < count; ++column) {
        usedBy.assign(colours + 1, std::numeric_limits<std::size_t>::max());
        for (const auto row : columnRows[column]) {
            for (const auto other : rows[row]) {
                if (other < column) usedBy[colour[other]] = column;
            }
        }
        std::size_t chosen = 0;
        while (chosen < colours && usedBy[chosen] == column) ++chosen;
        colour[column] = chosen;
        if (chosen == colours) ++colours;
    }
    return colour;
}

// A dense LU factorisation with partial pivoting (row interchanges), of a matrix given by rows, n by n.
class DenseLu {
public:
    // Factorises `matrix` (row-major, n * n, overwritten by the factors). False when a pivot is zero or not finite: the matrix is
    // singular, to working precision, and nothing can be solved with it.
    bool factor(std::vector<double> matrix, std::size_t n) {
        size_ = n;
        factors_ = std::move(matrix);
        pivots_.assign(n, 0);
        for (std::size_t column = 0; column < n; ++column) {
            std::size_t pivot = column;
            double largest = std::abs(factors_[column * n + column]);
            for (std::size_t row = column + 1; row < n; ++row) {
                const double size = std::abs(factors_[row * n + column]);
                if (size > largest) { largest = size; pivot = row; }
            }
            pivots_[column] = pivot;
            if (!(largest > 0.0) || !std::isfinite(largest)) return false;
            if (pivot != column) {
                for (std::size_t index = 0; index < n; ++index) std::swap(factors_[column * n + index], factors_[pivot * n + index]);
            }
            const double diagonal = factors_[column * n + column];
            for (std::size_t row = column + 1; row < n; ++row) {
                const double multiplier = factors_[row * n + column] / diagonal;
                factors_[row * n + column] = multiplier;
                if (multiplier == 0.0) continue;
                for (std::size_t index = column + 1; index < n; ++index) factors_[row * n + index] -= multiplier * factors_[column * n + index];
            }
        }
        return true;
    }

    // Solves A x = b with the factors, `values` holding b and then x: the row interchanges first, in the order they were made (the
    // factors' rows, multipliers included, were interchanged as a whole), then L and U in turn.
    void solve(std::vector<double>& values) const {
        const std::size_t n = size_;
        for (std::size_t column = 0; column < n; ++column) {
            if (pivots_[column] != column) std::swap(values[column], values[pivots_[column]]);
        }
        for (std::size_t column = 0; column < n; ++column) {
            const double value = values[column];
            for (std::size_t row = column + 1; row < n; ++row) values[row] -= factors_[row * n + column] * value;
        }
        for (std::size_t row = n; row-- > 0;) {
            double sum = values[row];
            for (std::size_t index = row + 1; index < n; ++index) sum -= factors_[row * n + index] * values[index];
            values[row] = sum / factors_[row * n + row];
        }
    }

private:
    std::size_t size_ = 0;
    std::vector<double> factors_;
    std::vector<std::size_t> pivots_;
};

// A minimum-degree ordering of a pattern's symmetric graph (an edge between i and j where (i, j) or (j, i) is in the pattern): rows
// and columns are eliminated one at a time, each time the one with the fewest neighbours still to eliminate (the lowest index among
// equals), its neighbours then joined to one another as elimination fills them in. Returns the order: order[k] is the k-th
// eliminated row and column.
inline std::vector<std::size_t> minimumDegreeOrder(const SparsityRows& rows) {
    const std::size_t count = rows.size();
    std::vector<std::set<std::size_t>> neighbours(count);
    for (std::size_t row = 0; row < count; ++row) {
        for (const auto column : rows[row]) {
            if (column == row) continue;
            neighbours[row].insert(column);
            neighbours[column].insert(row);
        }
    }
    std::vector<unsigned char> eliminated(count, 0);
    std::set<std::pair<std::size_t, std::size_t>> byDegree;
    for (std::size_t index = 0; index < count; ++index) byDegree.insert({neighbours[index].size(), index});
    std::vector<std::size_t> order;
    order.reserve(count);
    while (!byDegree.empty()) {
        const auto chosen = byDegree.begin()->second;
        byDegree.erase(byDegree.begin());
        eliminated[chosen] = 1;
        order.push_back(chosen);
        const std::vector<std::size_t> around(neighbours[chosen].begin(), neighbours[chosen].end());
        for (const auto node : around) {
            byDegree.erase({neighbours[node].size(), node});
            neighbours[node].erase(chosen);
        }
        for (const auto node : around) {
            for (const auto other : around) if (other != node) neighbours[node].insert(other);
        }
        for (const auto node : around) byDegree.insert({neighbours[node].size(), node});
        neighbours[chosen].clear();
    }
    return order;
}

// A sparse LU factorisation with a fixed ordering: the rows and columns are reordered symmetrically by a minimum-degree ordering,
// worked out once from the pattern (analyse), with the pattern of the factors, fill included; each factorisation then pivots on the
// diagonal in that order. The stiff method's matrix I / (h gamma) - J has a strong diagonal for the steps it takes; when a pivot is
// too small for that to hold (below 1e-10 of the largest entry of its row), factor says so, and the caller solves densely instead.
// Without row interchanges elimination can grow the entries and lose digits, so every solve is refined once: the residual of the
// first solution, worked out from the matrix's own entries, is solved for and added.
class SparseLu {
public:
    // Works out the ordering and the factors' pattern from `rows`, which must include every diagonal entry.
    void analyse(const SparsityRows& rows) {
        size_ = rows.size();
        order_ = minimumDegreeOrder(rows);
        position_.assign(size_, 0);
        for (std::size_t index = 0; index < size_; ++index) position_[order_[index]] = index;
        // Where each entry of the original pattern goes: entry e of the flattened rows is (original row, column), placed at row
        // position_[row] and column position_[column] of the reordered matrix.
        entryStart_.assign(size_ + 1, 0);
        for (std::size_t row = 0; row < size_; ++row) entryStart_[row + 1] = entryStart_[row] + rows[row].size();
        entryColumn_.clear();
        for (const auto& columns : rows) entryColumn_.insert(entryColumn_.end(), columns.begin(), columns.end());
        // The reordered matrix's pattern, then the factors' (fill included): row i's columns are its own, and the columns after k of
        // every earlier row k that row i reaches, in increasing k (row i reaching k makes it reach k's columns too).
        std::vector<std::set<std::size_t>> pattern(size_);
        for (std::size_t row = 0; row < size_; ++row) for (const auto column : rows[row]) pattern[position_[row]].insert(position_[column]);
        rowStart_.assign(size_ + 1, 0);
        columns_.clear();
        diagonal_.assign(size_, 0);
        for (std::size_t row = 0; row < size_; ++row) {
            auto& structure = pattern[row];
            for (auto entry = structure.begin(); entry != structure.end() && *entry < row; ++entry) {
                const auto earlier = *entry;
                for (std::size_t index = diagonal_[earlier] + 1; index < rowStart_[earlier + 1]; ++index) structure.insert(columns_[index]);
            }
            for (const auto column : structure) {
                if (column == row) diagonal_[row] = columns_.size();
                columns_.push_back(column);
            }
            rowStart_[row + 1] = columns_.size();
        }
        // Each original entry's place among the factors' entries.
        entryPlace_.assign(entryStart_[size_], 0);
        for (std::size_t row = 0; row < size_; ++row) {
            for (std::size_t index = 0; index < rows[row].size(); ++index) {
                const auto newRow = position_[row];
                const auto newColumn = position_[rows[row][index]];
                const auto first = columns_.begin() + static_cast<std::ptrdiff_t>(rowStart_[newRow]);
                const auto last = columns_.begin() + static_cast<std::ptrdiff_t>(rowStart_[newRow + 1]);
                entryPlace_[entryStart_[row] + index] = static_cast<std::size_t>(std::lower_bound(first, last, newColumn) - columns_.begin());
            }
        }
        values_.assign(columns_.size(), 0.0);
        work_.assign(size_, 0.0);
    }

    // The number of entries the factors hold, fill included.
    std::size_t factorEntries() const noexcept { return columns_.size(); }

    // Factorises the matrix whose entries, in the order of the pattern given to analyse (row by row, each row's columns in order), are
    // `entries`. False when a pivot is too small or not finite.
    bool factor(const std::vector<double>& entries) {
        entries_ = entries;
        std::fill(values_.begin(), values_.end(), 0.0);
        std::vector<double> rowLargest(size_, 0.0);
        for (std::size_t row = 0; row < size_; ++row) {
            for (std::size_t entry = entryStart_[row]; entry < entryStart_[row + 1]; ++entry) {
                values_[entryPlace_[entry]] = entries[entry];
                rowLargest[position_[row]] = std::max(rowLargest[position_[row]], std::abs(entries[entry]));
            }
        }
        for (std::size_t row = 0; row < size_; ++row) {
            for (std::size_t index = rowStart_[row]; index < rowStart_[row + 1]; ++index) work_[columns_[index]] = values_[index];
            for (std::size_t index = rowStart_[row]; index < diagonal_[row]; ++index) {
                const auto earlier = columns_[index];
                const double multiplier = work_[earlier] / values_[diagonal_[earlier]];
                work_[earlier] = multiplier;
                if (multiplier == 0.0) continue;
                for (std::size_t other = diagonal_[earlier] + 1; other < rowStart_[earlier + 1]; ++other) {
                    work_[columns_[other]] -= multiplier * values_[other];
                }
            }
            for (std::size_t index = rowStart_[row]; index < rowStart_[row + 1]; ++index) {
                values_[index] = work_[columns_[index]];
                work_[columns_[index]] = 0.0;
            }
            const double pivot = values_[diagonal_[row]];
            if (!std::isfinite(pivot) || !(std::abs(pivot) > 1.0e-10 * rowLargest[row])) return false;
        }
        return true;
    }

    // Solves A x = b with the factors, refined once, `values` holding b and then x.
    void solve(std::vector<double>& values) const {
        const std::vector<double> right = values;
        substitute(values);
        std::vector<double> residual(size_);
        for (std::size_t row = 0; row < size_; ++row) {
            double sum = right[row];
            for (std::size_t entry = entryStart_[row]; entry < entryStart_[row + 1]; ++entry) sum -= entries_[entry] * values[entryColumn_[entry]];
            residual[row] = sum;
        }
        substitute(residual);
        for (std::size_t row = 0; row < size_; ++row) values[row] += residual[row];
    }

private:
    // One solve with the factors: L and U in the reordered rows and columns.
    void substitute(std::vector<double>& values) const {
        std::vector<double> reordered(size_);
        for (std::size_t index = 0; index < size_; ++index) reordered[position_[index]] = values[index];
        for (std::size_t row = 0; row < size_; ++row) {
            double sum = reordered[row];
            for (std::size_t index = rowStart_[row]; index < diagonal_[row]; ++index) sum -= values_[index] * reordered[columns_[index]];
            reordered[row] = sum;
        }
        for (std::size_t row = size_; row-- > 0;) {
            double sum = reordered[row];
            for (std::size_t index = diagonal_[row] + 1; index < rowStart_[row + 1]; ++index) sum -= values_[index] * reordered[columns_[index]];
            reordered[row] = sum / values_[diagonal_[row]];
        }
        for (std::size_t index = 0; index < size_; ++index) values[index] = reordered[position_[index]];
    }

    std::size_t size_ = 0;
    std::vector<std::size_t> order_, position_, entryStart_, entryColumn_, entryPlace_, rowStart_, columns_, diagonal_;
    std::vector<double> entries_, values_, work_;
};

}
