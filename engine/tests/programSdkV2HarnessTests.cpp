/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The C++ side of version 2 of the program SDK (konjugate/sdk/v2/program.hpp and testing.hpp), outside the engine: the worked examples
// pass every standard check, and each check fails, with its message, for a program broken on purpose (a counter in a member, a missing
// output, memory kept outside declared memory, a wrong Jacobian); memory, clocks and the seeded random stream behave as declared.

#include "konjugate/sdk/v2/testing.hpp"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>

namespace k = konjugate::sdk::v2;

namespace {

int failures = 0;

void expect(bool condition, const std::string& what) {
    if (condition) return;
    std::fprintf(stderr, "FAILED: %s\n", what.c_str());
    ++failures;
}

bool mentions(const k::testing::Report& report, const std::string& text) {
    return std::any_of(report.problems().begin(), report.problems().end(), [&](const auto& problem) { return problem.find(text) != std::string::npos; });
}

class Conduction final : public k::Relationship {
public:
    k::Input hot{this, "hot", "K"};
    k::Input cold{this, "cold", "K"};
    k::Parameter conductance{this, "conductance", "W/K"};
    k::Parameter capacity{this, "capacity", "J/K"};
    k::Output warming{this, "warming", "K/s", k::dependsOn(hot, cold)};

    double evaluate(double, const k::Inputs& x) const override { return x[conductance] * (x[hot] - x[cold]) / x[capacity]; }
    void jacobian(double, const k::Inputs& x, k::Jacobian& J) const override {
        J(warming, hot) = x[conductance] / x[capacity];
        J(warming, cold) = -x[conductance] / x[capacity];
        J(warming, conductance) = (x[hot] - x[cold]) / x[capacity];
        J(warming, capacity) = -x[conductance] * (x[hot] - x[cold]) / (x[capacity] * x[capacity]);
    }
};

class PidController final : public k::Node {
public:
    k::Input measurement{this, "measurement", "K"};
    k::Parameter setpoint{this, "setpoint", "K"};
    k::Constant kp{this, "kp", "W/K"};
    k::Constant ki{this, "ki", "W/(K*s)"};
    k::Constant kd{this, "kd", "W*s/K"};
    k::Constant maxPower{this, "maxPower", "W"};
    k::Constant sensorNoise{this, "sensorNoise", "K", k::optional(0.0)};
    k::Output power{this, "power", "W"};
    k::Clock clock{this, 0.01};
    k::Memory<double> integral{this, "integral", 0.0, "K*s"};
    k::Memory<double> previousError{this, "previousError", 0.0, "K"};
    k::Memory<double> held{this, "held", 0.0, "W"};
    k::Memory<k::Random> noise{this, "noise"};

    void evaluate(double, const k::Inputs& x, k::Outputs& y) const override { y[power] = x[held]; }
    void advance(const k::Step& step, const k::Inputs& x, k::MemoryWriter& m) const override {
        const double measured = x[measurement] + x[sensorNoise] * m[noise].normal();
        const double error = x[setpoint] - measured;
        const double derivative = step.first ? 0.0 : (error - x[previousError]) / step.size;
        const double candidate = x[integral] + error * step.size;
        const double unclamped = x[kp] * error + x[ki] * candidate + x[kd] * derivative;
        const double command = std::clamp(unclamped, 0.0, x[maxPower]);
        if (command == unclamped) m[integral] = candidate;
        m[previousError] = error;
        m[held] = command;
    }
};

class Counting final : public k::Relationship {
public:
    k::Input a{this, "a"};
    k::Output y{this, "y"};
    double evaluate(double, const k::Inputs& x) const override { return x[a] + static_cast<double>(++calls_); }

private:
    mutable int calls_ = 0;
};

class Missing final : public k::Node {
public:
    k::Input a{this, "a"};
    k::Output y{this, "y"};
    k::Output z{this, "z"};
    void evaluate(double, const k::Inputs& x, k::Outputs& out) const override { out[y] = x[a]; }
};

// Keeps a count in a member that initialize() sets and advance() cannot change: the round trip into a fresh instance differs.
class Hidden final : public k::Node {
public:
    k::Input a{this, "a"};
    k::Output y{this, "y"};
    k::Memory<double> total{this, "total", 0.0};
    void initialize(const k::Setup&, k::MemoryWriter& m) override {
        static int instances = 0;
        offset_ = ++instances;
        m[total] = 0.0;
    }
    void evaluate(double, const k::Inputs& x, k::Outputs& out) const override { out[y] = x[total] + offset_; }
    void advance(const k::Step&, const k::Inputs& x, k::MemoryWriter& m) const override { m[total] = x[total] + x[a]; }

private:
    int offset_ = 0;
};

class WrongJacobian final : public k::Relationship {
public:
    k::Input a{this, "a"};
    k::Output y{this, "y"};
    double evaluate(double, const k::Inputs& x) const override { return x[a] * x[a]; }
    void jacobian(double, const k::Inputs& x, k::Jacobian& J) const override { J(y, a) = x[a]; }
};

class BadKey final : public k::Relationship {
public:
    k::Input a{this, "Bad Key"};
    k::Output y{this, "y"};
    double evaluate(double, const k::Inputs& x) const override { return x[a]; }
};

}

int main() {
    {
        k::testing::Harness<Conduction> h;
        const k::testing::Values inputs{{h.program().hot, 310}, {h.program().cold, 295}, {h.program().conductance, 4}, {h.program().capacity, 2}};
        expect(h.evaluate(0, inputs).at(0) == 30.0, "Conduction gives G (Th - Tc) / C.");
        const auto report = h.check(inputs);
        expect(report.ok(), "Conduction passes every check: " + report.text());
        expect(h.program().registry().outputs[0].declaresDependencies && h.program().registry().outputs[0].dependsOn.size() == 2,
            "An output's declared dependencies are kept.");
    }
    {
        k::testing::Harness<PidController> h{{.constants = {{"kp", 50}, {"ki", 5}, {"kd", 1}, {"maxPower", 2000}, {"sensorNoise", 0.1}}, .seed = 7}};
        const k::testing::Values inputs{{h.program().setpoint, 293.15}, {h.program().measurement, 290.0}};
        h.tick(0.0, inputs);
        const auto memory = h.memory();
        expect(memory.at("held").at(0) > 0 && memory.at("noise").at(0) == 2.0, "A tick advances memory and draws the stream twice.");
        expect(h.evaluate(0.0, inputs).at(0) == memory.at("held").at(0), "The command is held between samples.");
        expect(h.check(inputs).ok(), "The PID example passes every check: " + h.check(inputs).text());
        const auto& registry = h.program().registry();
        expect(registry.clockPeriod == 0.01 && registry.memorySize == 40, "The clock and memory are declared.");
        k::testing::Harness<PidController> again{{.constants = {{"kp", 50}, {"ki", 5}, {"kd", 1}, {"maxPower", 2000}, {"sensorNoise", 0.1}}, .seed = 7}};
        again.tick(0.0, inputs);
        expect(again.memory() == memory, "The same seed draws the same stream.");
    }
    {
        k::testing::Harness<Counting> h;
        const auto report = h.check({{h.program().a, 1.0}});
        expect(mentions(report, "gave a different 'y' when called twice with the same inputs") && mentions(report, "keep what it remembers in declared memory"),
            "A counter in a member is caught: " + report.text());
    }
    {
        k::testing::Harness<Missing> h;
        expect(mentions(h.check({{h.program().a, 1.0}}), "evaluate() did not set 'z'"), "A missing output is named.");
    }
    {
        k::testing::Harness<Hidden> h;
        expect(mentions(h.check({{h.program().a, 1.0}}), "A fresh instance with the same memory gave different outputs"),
            "Something kept outside declared memory is caught by the round trip.");
    }
    {
        k::testing::Harness<WrongJacobian> h;
        expect(mentions(h.check({{h.program().a, 3.0}}), "The Jacobian's entry for 'y' by 'a' is 3, but differences give 6"), "A wrong Jacobian is named.");
    }
    {
        k::testing::Harness<BadKey> h;
        expect(mentions(h.check(), "The port 'Bad Key' is not a valid key"), "A key the file cannot bind is named.");
    }
    expect(k::randomSeed(1, 0, "noise") != k::randomSeed(2, 0, "noise"), "Two instances draw different streams.");
    if (failures) return EXIT_FAILURE;
    std::puts("The C++ program SDK and its harness behave as documented.");
    return EXIT_SUCCESS;
}
