/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "executionPlan.hpp"
#include <optional>

namespace konjugate {

struct NodeStabilityAssessment {
    EntityId nodeId = 0;
    std::size_t substeps = 1;
    double nodeStepSize = 0;
    // The largest |1 + nodeStepSize·λ| over every eigenvalue λ of the node's own local Jacobian
    // (differential states only -- see assessNodeStability's own comment). Explicit Euler is
    // stable at this step size, for this linearization, iff this is <= 1 (a small tolerance is
    // applied internally to absorb finite-difference perturbation noise, not a real stability
    // margin).
    double maxAmplificationFactor = 0;
    bool stable = true;
    // Fastest / slowest |Re(λ)| among eigenvalues with a negative real part -- std::nullopt when
    // fewer than two such eigenvalues exist, since a ratio needs at least two rates to compare. A
    // high ratio flags a node that's nominally stable but forces an inefficiently tiny step to
    // stay that way (see docs/proposals/numericalStabilityDiagnostics.md's pre-run section).
    std::optional<double> stiffnessRatio;
};

// Pre-run (validate-time) phase of docs/proposals/numericalStabilityDiagnostics.md's three-phase
// stability diagnostic: computes a node's own local Jacobian via finite-difference perturbation of
// the EXACT sequence integrateNode's own substep loop calls (applyAlgebraicTasks then
// evaluateContributionTasks then reduceContributions) -- no new solver or symbolic-differentiation
// machinery, just repeated calls to code that already exists, perturbed one state at a time around
// synchronizationSnapshot (the node's initial values, at validate time). From that Jacobian's
// eigenvalues (Eigen::EigenSolver, since a nonlinear system's Jacobian is not generally symmetric
// and can have genuinely complex eigenvalues for an oscillatory unstable mode), checks Explicit
// Euler's real stability condition |1 + nodeStepSize·λ| ≤ 1.
//
// Only a node's DIFFERENTIAL states are perturbed and checked -- never an algebraic (setsValue)
// state, which is recomputed fresh every substep rather than integrated via `+= stepSize *
// derivative`, so Explicit Euler's stability condition does not apply to it the same way (its own
// "stability" is a DAE-consistency question, not this one). An algebraic state's CURRENT value
// still fully participates in the Jacobian computation, though: perturbing a differential state
// and re-running applyAlgebraicTasks recomputes every algebraic state fresh from that perturbed
// value first, so any indirect coupling through an algebraic state is captured correctly in the
// differential states' own sensitivities -- exactly as it would be during a real run.
//
// Returns std::nullopt when there is nothing meaningful to check: a node with zero differential
// states (nothing Explicit Euler ever integrates there), or a node whose contributions,
// algebraic tasks, or own computational-node provider are not equation-only. A programmable
// (cpp/python) implementation is opaque, arbitrary user code -- probing it here would mean
// actually compiling and spawning a real provider (ProviderRuntime) just to validate a document,
// which is a much larger and riskier undertaking than this heuristic, local, equation-only check;
// see docs/proposals/numericalStabilityDiagnostics.md for that scoping decision.
std::optional<NodeStabilityAssessment> assessNodeStability(
    const NodeExecutionPlan& node,
    const StateValues& synchronizationSnapshot,
    double globalTimeStep);

}
