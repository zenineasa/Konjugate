/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "finiteDifferenceGradient.hpp"
#include <algorithm>
#include <cmath>

namespace konjugate {

std::vector<double> finiteDifferenceGradient(const LossFunction& loss, const std::vector<double>& point,
    double relativeStep) {
    std::vector<double> gradient(point.size(), 0.0);
    for (std::size_t index = 0; index < point.size(); ++index) {
        // A pure relative step vanishes at exactly zero, so floor it -- an absolute step is still
        // meaningful there, just not scaled to the parameter's own magnitude.
        const double step = std::max(1e-8, std::abs(point[index]) * relativeStep);
        auto forward = point;
        forward[index] += step;
        auto backward = point;
        backward[index] -= step;
        gradient[index] = (loss(forward) - loss(backward)) / (2.0 * step);
    }
    return gradient;
}

}
