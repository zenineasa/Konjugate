/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// A tuning objective written as a C++ program (docs/proposals/tuningEditorsAndPrograms.md, "An objective that is a program"). Write
//
//     #include <konjugate/objectiveProgram.hpp>
//
//     double objective(const konjugate::Run& run) {
//         const auto& temperature = run.series("temperature");   // a state's value at every output time, by its binding's key
//         ...
//         run.report("peak", peak);                               // further numbers, by name, if any
//         return cost;                                            // the number the search makes small (or large)
//     }
//
// The engine compiles it once for a whole tuning and gives it every trial's run in turn. A key is bound in the tuning card to a
// state (its series), a measured column (its series) or a tuned parameter (its value in the trial). An exception thrown from
// objective() fails that trial, with the exception's message shown; the tuning carries on.

#include <map>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace konjugate {

class Run {
public:
    // The output times, in seconds.
    const std::vector<double>& times() const { return times_; }

    // A bound state's or measured column's series, one value per output time.
    const std::vector<double>& series(const std::string& key) const {
        const auto found = series_.find(key);
        if (found == series_.end()) throw std::out_of_range("No series is bound to the key \"" + key + "\".");
        return found->second;
    }

    // A bound parameter's value in this trial.
    double value(const std::string& key) const {
        const auto found = values_.find(key);
        if (found == values_.end()) throw std::out_of_range("No value is bound to the key \"" + key + "\".");
        return found->second;
    }

    bool has(const std::string& key) const { return series_.count(key) || values_.count(key); }

    // A further number, by name, reported beside the objective.
    void report(const std::string& key, double value) const { reports_.emplace_back(key, value); }

    // Filled by the glue that runs the program; not for the program itself.
    std::vector<double> times_;
    std::map<std::string, std::vector<double>> series_;
    std::map<std::string, double> values_;
    mutable std::vector<std::pair<std::string, double>> reports_;
};

}

// Written by the person: the number this run scores.
double objective(const konjugate::Run& run);
