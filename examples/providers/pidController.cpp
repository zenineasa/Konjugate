// Copyright © 2026 Zenin Easa Panthakkalakath

// A digital PID controller sampled every 10 ms, reading a noisy temperature sensor, with anti-windup: a node program with memory and a
// clock (docs/programs.md). Its memory is exact, not an approximation: a digital controller is discrete by nature.

#include <konjugate/sdk/v2/program.hpp>

#include <algorithm>
#include <memory>

namespace k = konjugate::sdk::v2;

namespace {

// A PID controller sampled every 10 ms, reading a noisy temperature sensor, with anti-windup.
class PidController final : public k::Node {
public:
    k::Input     measurement{this, "measurement", "K"};
    k::Parameter setpoint   {this, "setpoint",    "K"};
    k::Constant  kp         {this, "kp",          "W/K"};
    k::Constant  ki         {this, "ki",          "W/(K*s)"};
    k::Constant  kd         {this, "kd",          "W*s/K"};
    k::Constant  maxPower   {this, "maxPower",    "W"};
    k::Constant  sensorNoise{this, "sensorNoise", "K", k::optional(0.0)};
    k::Output    power      {this, "power",       "W"};   // bound to the node's Update state "power"

    k::Clock clock{this, 0.01};                          // advance() at 0, 10 ms, 20 ms, ...

    k::Memory<double>    integral     {this, "integral",      0.0, "K*s"};
    k::Memory<double>    previousError{this, "previousError", 0.0, "K"};
    k::Memory<double>    held         {this, "held",          0.0, "W"};
    k::Memory<k::Random> noise        {this, "noise"};

    // The command is held between samples, as a real controller's output is.
    void evaluate(double, const k::Inputs& x, k::Outputs& y) const override {
        y[power] = x[held];
    }

    void advance(const k::Step& step, const k::Inputs& x, k::MemoryWriter& m) const override {
        const double measured = x[measurement] + x[sensorNoise] * m[noise].normal();
        const double error = x[setpoint] - measured;
        const double derivative = step.first ? 0.0 : (error - x[previousError]) / step.size;
        const double candidate = x[integral] + error * step.size;
        const double unclamped = x[kp] * error + x[ki] * candidate + x[kd] * derivative;
        const double command = std::clamp(unclamped, 0.0, x[maxPower]);
        if (command == unclamped) m[integral] = candidate;   // stop integrating while saturated
        m[previousError] = error;
        m[held] = command;
    }
};

}

std::unique_ptr<k::Program> createProgram() { return std::make_unique<PidController>(); }
