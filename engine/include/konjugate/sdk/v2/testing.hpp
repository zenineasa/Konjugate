/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// A harness for trying a version 2 program outside Konjugate (docs/programs.md, "Testing a program"): construct it, set its constants,
// call evaluate() and advance() with inputs of your choosing, look at its memory, and run the standard checks Konjugate's Check
// program runs. No test framework is needed:
//
//   k::testing::Harness<PidController> h{{.constants = {{"kp", 50}, {"ki", 5}, {"kd", 1}, {"maxPower", 2000}}, .seed = 7}};
//   h.tick(0.0, {{h.program().setpoint, 293.15}, {h.program().measurement, 290.0}});
//   const auto report = h.check({{h.program().setpoint, 293.15}, {h.program().measurement, 290.0}});
//   if (!report.ok()) { std::puts(report.text().c_str()); return 1; }

#include "program.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <functional>
#include <map>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace konjugate::sdk::v2::testing {

// Inputs by port: {{h.program().hot, 310.0}, {h.program().cold, 295.0}}. An input not given reads its default, or 0.
using Values = std::vector<std::pair<std::reference_wrapper<const Input>, double>>;

struct Options {
    std::map<std::string, double> constants;   // by key, as the project file binds them
    std::uint64_t seed = 0;                    // the program's seed, as its card would set it
    std::uint64_t owner = 1;                   // the id of the node or relationship it stands for
    double startTime = 0.0;
};

// What check() found: each problem in a sentence.
class Report {
public:
    [[nodiscard]] bool ok() const noexcept { return problems_.empty(); }
    [[nodiscard]] const std::vector<std::string>& problems() const noexcept { return problems_; }
    [[nodiscard]] std::string text() const {
        if (problems_.empty()) return "Every check passed.";
        std::string out;
        for (const auto& problem : problems_) out += problem + "\n";
        return out;
    }
    void add(std::string problem) { problems_.push_back(std::move(problem)); }

private:
    std::vector<std::string> problems_;
};

namespace detail {

// What an output holds before evaluate() runs: a NaN no arithmetic makes, so an output left unwritten is told from one set to NaN.
inline double unsetOutput() { return std::bit_cast<double>(std::uint64_t{0x7FF4B1D0DEADBEEFULL}); }
inline bool isUnset(double value) { return std::bit_cast<std::uint64_t>(value) == 0x7FF4B1D0DEADBEEFULL; }
inline bool sameBits(double left, double right) { return std::bit_cast<std::uint64_t>(left) == std::bit_cast<std::uint64_t>(right); }
inline std::string number(double value) {
    std::ostringstream stream;
    stream << value;
    return stream.str();
}

}

template <class P>
class Harness {
public:
    explicit Harness(Options options = {}) : options_(std::move(options)) { start(program_, memory_); }

    P& program() noexcept { return program_; }
    const P& program() const noexcept { return program_; }

    // Every output's value at time t, in declaration order (a relationship has one).
    std::vector<double> evaluate(double t, const Values& values = {}) const { return evaluateWith(program_, memory_, t, values); }
    // One output's value.
    double evaluate(double t, const Values& values, const Output& output) const { return evaluate(t, values).at(output.index()); }

    // advance() as at the end of an accepted step of `size` ending at `time`.
    void advance(double time, double size, const Values& values = {}) { advanceWith(program_, memory_, time, size, values); }
    // advance() at a clock tick: the step is the clock's period.
    void tick(double time, const Values& values = {}) {
        const auto& registry = program_.registry();
        const double period = registry.clockConstant ? inputValues({}).at(*registry.clockConstant) : registry.clockPeriod;
        advance(time, period, values);
    }

    // The program's memory now, field by field: a real, an integer or a flag as one number, an array or a stream as several.
    [[nodiscard]] std::map<std::string, std::vector<double>> memory() const {
        std::map<std::string, std::vector<double>> fields;
        for (const auto& field : program_.registry().memory) fields[field.name] = fieldValues(field);
        return fields;
    }

    // The standard checks (docs/programs.md, "Testing a program"), at time t with these inputs: every port declared once with a key
    // valid in a file; evaluate() finite at the inputs with every output set; purity (two calls give identical bits and leave memory
    // as it was); the memory round trip (memory saved and restored into a fresh instance gives identical outputs and identical further
    // advance()s); and a Jacobian, if the program gives one, agreeing with differences.
    Report check(const Values& values = {}, double t = 0.0) {
        Report report;
        const auto& registry = program_.registry();
        const std::regex identifier("^[a-z][A-Za-z0-9]*$");
        std::set<std::string> keys;
        for (const auto* list : {&registry.inputs, &registry.outputs}) {
            for (const auto& port : *list) {
                if (!std::regex_match(port.key, identifier)) {
                    report.add("The port '" + port.key + "' is not a valid key: it must start with a small letter and hold only letters and digits.");
                }
                if (!keys.insert(port.key).second) report.add("The port '" + port.key + "' is declared twice.");
            }
        }
        std::set<std::string> names;
        for (const auto& field : registry.memory) {
            if (!std::regex_match(field.name, identifier)) report.add("The memory '" + field.name + "' is not a valid name.");
            if (!names.insert(field.name).second) report.add("The memory '" + field.name + "' is declared twice.");
        }
        if (registry.outputs.empty()) report.add("The program declares no output.");
        if (!report.ok()) return report;

        std::vector<double> first;
        try {
            first = evaluateRaw(program_, memory_, t, values);
        } catch (const std::exception& error) {
            report.add(std::string("evaluate() failed: ") + error.what());
            return report;
        }
        for (std::size_t index = 0; index < first.size(); ++index) {
            const auto& key = registry.outputs[index].key;
            if (detail::isUnset(first[index])) report.add("evaluate() did not set '" + key + "' (at t = " + detail::number(t) + ").");
            else if (!std::isfinite(first[index])) report.add("evaluate() gave " + detail::number(first[index]) + " for '" + key + "'.");
        }
        const auto memoryBefore = memory_;
        const auto second = evaluateRaw(program_, memory_, t, values);
        for (std::size_t index = 0; index < first.size(); ++index) {
            if (!detail::sameBits(first[index], second[index])) {
                report.add("The program gave a different '" + registry.outputs[index].key + "' when called twice with the same inputs at t = " +
                    detail::number(t) + " (" + detail::number(first[index]) + ", then " + detail::number(second[index]) +
                    "). evaluate() must not change anything: keep what it remembers in declared memory and change it in advance().");
            }
        }
        if (memory_ != memoryBefore) report.add("evaluate() changed the program's memory.");

        // The round trip: memory copied into a fresh instance, then both advanced and evaluated alike.
        P fresh;
        std::vector<std::byte> freshMemory;
        start(fresh, freshMemory);
        freshMemory = memory_;
        auto original = memory_;
        const double size = registry.clockPeriod > 0 ? registry.clockPeriod : 0.01;
        try {
            for (int round = 0; round < 3; ++round) {
                const double time = t + size * (round + 1);
                advanceRaw(program_, original, time, size, values, false);
                advanceRaw(fresh, freshMemory, time, size, values, false);
                if (original != freshMemory) {
                    report.add("Memory restored into a fresh instance did not advance as the original did: something the program "
                        "remembers is not declared as memory (a member changed in initialize() or advance() from what it reads).");
                    break;
                }
                const auto left = evaluateRaw(program_, original, time, values);
                const auto right = evaluateRaw(fresh, freshMemory, time, values);
                if (!std::equal(left.begin(), left.end(), right.begin(), right.end(), detail::sameBits)) {
                    report.add("A fresh instance with the same memory gave different outputs: the program keeps something outside its "
                        "declared memory.");
                    break;
                }
            }
        } catch (const std::exception& error) {
            report.add(std::string("advance() failed: ") + error.what());
        }

        // The Jacobian, if given, against central differences.
        const auto inputs = inputValues(values);
        std::vector<double> entries(registry.inputs.size() * registry.outputs.size(), 0.0);
        Jacobian jacobian(entries.data(), registry.inputs.size());
        const Inputs view(inputs.data(), memory_.data(), nullptr);
        program_.jacobian(t, view, jacobian);
        if (jacobian.provided()) {
            for (std::size_t column = 0; column < registry.inputs.size(); ++column) {
                const double step = 1e-6 * std::max(1.0, std::abs(inputs[column]));
                auto above = inputs;
                auto below = inputs;
                above[column] += step;
                below[column] -= step;
                const auto high = evaluateValues(program_, memory_, t, above);
                const auto low = evaluateValues(program_, memory_, t, below);
                for (std::size_t row = 0; row < registry.outputs.size(); ++row) {
                    const double differenced = (high[row] - low[row]) / (2.0 * step);
                    const double given = entries[row * registry.inputs.size() + column];
                    if (std::abs(differenced - given) > 1e-4 * std::max(1.0, std::abs(differenced))) {
                        report.add("The Jacobian's entry for '" + registry.outputs[row].key + "' by '" + registry.inputs[column].key + "' is " +
                            detail::number(given) + ", but differences give " + detail::number(differenced) + ".");
                    }
                }
            }
        }
        return report;
    }

private:
    void start(P& program, std::vector<std::byte>& memory) const {
        const auto& registry = program.registry();
        memory.assign(registry.memorySize, std::byte{0});
        for (const auto& field : registry.memory) {
            std::copy(field.initial.begin(), field.initial.end(), memory.begin() + static_cast<std::ptrdiff_t>(field.offset));
            if (field.type == ::konjugate::sdk::v2::detail::MemoryType::random) {
                seedRandom(memory.data(), field.offset, randomSeed(options_.owner, options_.seed, field.name));
            }
        }
        const auto values = inputValues({}, &program);
        Setup setup{options_.owner, "the harness", options_.startTime, values.data()};
        MemoryWriter writer(memory.data());
        program.initialize(setup, writer);
    }

    std::vector<double> inputValues(const Values& values, const P* program = nullptr) const {
        const auto& registry = (program ? *program : program_).registry();
        std::vector<double> inputs(registry.inputs.size(), 0.0);
        for (std::size_t index = 0; index < registry.inputs.size(); ++index) {
            const auto& port = registry.inputs[index];
            if (port.hasDefault) inputs[index] = port.defaultValue;
            if (const auto found = options_.constants.find(port.key); found != options_.constants.end()) inputs[index] = found->second;
        }
        for (const auto& [port, value] : values) inputs.at(port.get().index()) = value;
        return inputs;
    }

    std::vector<double> evaluateValues(const P& program, const std::vector<std::byte>& memory, double t, const std::vector<double>& inputs) const {
        const auto& registry = program.registry();
        std::vector<double> outputs(registry.outputs.size(), detail::unsetOutput());
        const Inputs view(inputs.data(), memory.data(), nullptr);
        if constexpr (std::is_base_of_v<Node, P>) {
            Outputs written(outputs.data());
            program.evaluate(t, view, written);
        } else {
            outputs.at(0) = program.evaluate(t, view);
        }
        return outputs;
    }

    std::vector<double> evaluateRaw(const P& program, const std::vector<std::byte>& memory, double t, const Values& values) const {
        return evaluateValues(program, memory, t, inputValues(values, &program));
    }

    std::vector<double> evaluateWith(const P& program, const std::vector<std::byte>& memory, double t, const Values& values) const {
        auto outputs = evaluateRaw(program, memory, t, values);
        for (std::size_t index = 0; index < outputs.size(); ++index) {
            if (detail::isUnset(outputs[index])) fail("evaluate() did not set '" + program.registry().outputs[index].key + "'.");
        }
        return outputs;
    }

    void advanceRaw(const P& program, std::vector<std::byte>& memory, double time, double size, const Values& values, bool first) const {
        const auto inputs = inputValues(values, &program);
        const Inputs view(inputs.data(), memory.data(), nullptr);
        MemoryWriter writer(memory.data());
        program.advance(Step{time, size, first}, view, writer);
    }

    void advanceWith(const P& program, std::vector<std::byte>& memory, double time, double size, const Values& values) {
        advanceRaw(program, memory, time, size, values, !advanced_);
        advanced_ = true;
    }

    std::vector<double> fieldValues(const ::konjugate::sdk::v2::detail::MemoryRecord& field) const {
        using ::konjugate::sdk::v2::detail::MemoryType;
        const auto* at = memory_.data() + field.offset;
        std::vector<double> out;
        if (field.type == MemoryType::real || field.type == MemoryType::reals) {
            for (std::size_t index = 0; index < field.count; ++index) {
                double value = 0;
                std::memcpy(&value, at + index * 8, 8);
                out.push_back(value);
            }
        } else if (field.type == MemoryType::integer) {
            std::int64_t value = 0;
            std::memcpy(&value, at, 8);
            out.push_back(static_cast<double>(value));
        } else if (field.type == MemoryType::flag) {
            out.push_back(static_cast<unsigned char>(at[0]) ? 1.0 : 0.0);
        } else {
            std::uint64_t counter = 0;
            std::memcpy(&counter, at + 8, 8);
            out.push_back(static_cast<double>(counter));
        }
        return out;
    }

    Options options_;
    P program_;
    std::vector<std::byte> memory_;
    bool advanced_ = false;
};

}
