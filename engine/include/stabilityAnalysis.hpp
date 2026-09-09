/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include "executionPlan.hpp"
#include <optional>

namespace konjugate {

// Identifies the parameter estimated to most strongly drive a node's dominant (highest-
// amplification) eigenvalue mode -- see NodeStabilityAssessment::dominantParameter and
// assessNodeStability's own comment for the full method. sourceId is an edge id or source-term
// id, whichever owns this parameter -- disambiguating between the two, and resolving it to a
// human-facing name/symbol, is left to the caller against the original document, since this
// module never sees the document/ptree, only the already-compiled plan.
struct ParameterAttribution {
    EntityId sourceId = 0;
    EntityId parameterId = 0;
    double sensitivity = 0;
};

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
    // Only set when `!stable`, and only when the dominant mode's own state actually has a
    // candidate parameter to attribute to (see assessNodeStability's own comment).
    std::optional<ParameterAttribution> dominantParameter;
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
//
// When a node comes back unstable, one more finite-difference step attributes it to a specific
// parameter, not just the node: the dominant eigenvalue's own eigenvector (now requested from
// EigenSolver) says which single differential state the unstable mode is concentrated in --
// whichever component has the largest magnitude. Every ContributionTask (ordinary or algebraic)
// that writes to that one state is a candidate; each of its parameters is perturbed in turn (same
// relative-epsilon rule as the state perturbations above) and the resulting change in that state's
// own derivative is measured directly -- no new machinery, just more calls to the same
// evaluateNodeDerivative already used to build the Jacobian. The parameter with the largest
// resulting sensitivity is kept. This generalizes to non-linear relations for the same reason the
// Jacobian itself already does: nothing here is symbolic or linear-only, it's a numerical
// perturbation of whatever the node's real (possibly non-linear) equations actually compute --
// but, like the Jacobian, it is only ever a LOCAL read at synchronizationSnapshot, so it should be
// treated as "the parameter most responsible for the instability near this operating point," not
// a global claim.
std::optional<NodeStabilityAssessment> assessNodeStability(
    const NodeExecutionPlan& node,
    const StateValues& synchronizationSnapshot,
    double globalTimeStep);

}
