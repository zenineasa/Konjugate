// Copyright © 2026 Zenin Easa Panthakkalakath

// Heat conducted from a hot body to a cold one: a pure relationship program (docs/programs.md).

#include <konjugate/sdk/v2/program.hpp>

#include <memory>

namespace k = konjugate::sdk::v2;

namespace {

// Warms the cold side at G (Th - Tc) / C.
class Conduction final : public k::Relationship {
public:
    k::Input     hot        {this, "hot",         "K"};
    k::Input     cold       {this, "cold",        "K"};
    k::Parameter conductance{this, "conductance", "W/K"};
    k::Parameter capacity   {this, "capacity",    "J/K"};
    k::Output    warming    {this, "warming",     "K/s"};

    double evaluate(double, const k::Inputs& x) const override {
        return x[conductance] * (x[hot] - x[cold]) / x[capacity];
    }
};

}

std::unique_ptr<k::Program> createProgram() { return std::make_unique<Conduction>(); }
