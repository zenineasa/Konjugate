/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "optimizerBackend.hpp"
#include <vector>

namespace konjugate {

// Central-difference gradient of `loss` at `point`: for each dimension, two extra evaluations
// of `loss` (one full simulation trial each -- see parameterFitting.cpp). This is the only
// gradient available anywhere in the engine -- there is no analytic/adjoint sensitivity, since
// the loss is a black-box "run a whole simulation and score it" function. Shared by every
// gradient-requiring backend so the finite-difference behavior (step size, clamping) is
// consistent regardless of which solver is driving it.
std::vector<double> finiteDifferenceGradient(const LossFunction& loss, const std::vector<double>& point,
    double relativeStep = 1e-4);

}
