// Copyright © 2026 Zenin Easa Panthakkalakath

// A valve's flow by its opening, from a table of measured points: a pure relationship program (docs/programs.md). Between two points
// the flow is interpolated linearly; an opening outside the table is refused with OutOfDomain, so Adaptive and Stiff try a smaller step
// and Euler and Runge–Kutta 4 stop with the message, rather than the program inventing a value it was never given.

#include <konjugate/sdk/v2/program.hpp>

#include <array>
#include <cstddef>
#include <memory>
#include <string>

namespace k = konjugate::sdk::v2;

namespace {

// The measured points: the opening (0 closed, 1 open) and the flow through the valve at it.
constexpr std::array<double, 5> openings{0.0, 0.25, 0.5, 0.75, 1.0};
constexpr std::array<double, 5> flows{0.0, 0.02, 0.07, 0.14, 0.2};

class LookupTable final : public k::Relationship {
public:
    k::Input opening{this, "opening"};
    k::Output flow{this, "flow", "m3/s"};

    double evaluate(double, const k::Inputs& x) const override {
        const double value = x[opening];
        if (!(value >= openings.front() && value <= openings.back())) {
            throw k::OutOfDomain("The opening " + std::to_string(value) + " is outside the table, which runs from 0 to 1.");
        }
        std::size_t index = 0;
        while (index + 2 < openings.size() && value > openings[index + 1]) ++index;
        const double fraction = (value - openings[index]) / (openings[index + 1] - openings[index]);
        return flows[index] + fraction * (flows[index + 1] - flows[index]);
    }
};

}

std::unique_ptr<k::Program> createProgram() { return std::make_unique<LookupTable>(); }
