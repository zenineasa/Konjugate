/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace konjugate {

// A name an objective expression may use, and what it stands for.
struct ObjectiveVariable {
    enum class Kind { state, parameter, measured };
    std::string name;
    Kind kind = Kind::state;
    std::uint64_t id = 0;     // the state's id, or the parameter's id
    std::string column;       // the measured CSV column (Kind::measured)
    double value = 0.0;       // a parameter's value when it is not being tuned
};

// What one simulation leaves for an objective to read: states and measured columns at each sample time (all the same length), and
// each parameter's value in the trial.
struct ObjectiveData {
    std::vector<double> times;
    std::map<std::uint64_t, std::vector<double>> states;     // by state id
    std::map<std::string, std::vector<double>> measured;     // by CSV column name
    std::map<std::uint64_t, double> parameters;              // by parameter id
};

struct ObjectiveNode;

// A number computed from a run, written as text: `integral((block - 320)^2) + 0.1 * k^2`. Numbers, the names of the variables it was
// given, + - * / ^, brackets, the functions abs sqrt exp ln sin cos tan, and the summaries over a whole run, which take one
// expression evaluated at every sample time: final (the last sample), max, min, mean, and integral (trapezoid rule over the sample
// times). A state or measured column only has a value at an instant, so outside a summary it is rejected, which is what keeps the
// result a single number. Throws std::invalid_argument, with a sentence a person can act on, for anything it cannot make sense of.
class FittingObjective {
public:
    FittingObjective(const std::string& expression, const std::vector<ObjectiveVariable>& variables);
    ~FittingObjective();
    FittingObjective(FittingObjective&&) noexcept;
    FittingObjective& operator=(FittingObjective&&) noexcept;

    double evaluate(const ObjectiveData& data) const;

private:
    std::unique_ptr<ObjectiveNode> root_;
    std::vector<ObjectiveVariable> variables_;
};

}
