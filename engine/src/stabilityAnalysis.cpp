/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "stabilityAnalysis.hpp"
#include "konjugate/integrators/dormandPrince54.hpp"
#include "konjugate/integrators/rodas4.hpp"
#include "konjugate/integrators/rungeKutta4.hpp"
#include <Eigen/Dense>
#include <algorithm>
#include <cmath>
#include <complex>
#include <limits>
#include <set>

namespace konjugate {
namespace {

bool isEquationOnly(const NodeExecutionPlan& node) {
    if (node.nodeProvider) return false;
    const auto equationOnly = [](const ContributionTask& task) { return task.implementation == ContributionImplementation::equation; };
    return std::all_of(node.contributions.begin(), node.contributions.end(), equationOnly)
        && std::all_of(node.algebraicTasks.begin(), node.algebraicTasks.end(), equationOnly);
}

// The exact per-substep derivative computation integrateNode itself performs (applyAlgebraicTasks,
// then evaluateContributionTasks, then reduceContributions), minus the final Euler `+=` -- returns
// one derivative value per entry of node.stateIndexes, in that same order, 0 for any state with no
// contribution at all (matching reduceContributions' own "absent means zero" convention). Never
// passed a providerEvaluator: only ever called once isEquationOnly(node) is already known true, so
// every task here is ContributionImplementation::equation and never needs one.
//
// reduceContributions' own stateIndex is already a LOCAL (per-node, 0-based) position -- the exact
// same value integrateNode's real substep loop writes straight into its own node-local localStates
// with (executionPlan.cpp: `localStates.at(derivative.first) += ...`), no translation of any kind.
std::vector<double> evaluateNodeDerivative(
    const NodeExecutionPlan& node, StateValues localStates, const StateValues& synchronizationSnapshot,
    const NodeParameterValues& parameterValues, const NodeParameterValues& algebraicParameterValues,
    double simulationTime, double nodeStepSize) {
    applyAlgebraicTasks(node.algebraicTasks, localStates, algebraicParameterValues, simulationTime, nodeStepSize, nullptr);
    const auto evaluated = evaluateContributionTasks(
        node, localStates, synchronizationSnapshot, parameterValues, simulationTime, nodeStepSize, nullptr);
    const auto derivatives = reduceContributions(evaluated);
    std::vector<double> result(node.stateIndexes.size(), 0.0);
    for (const auto& [localStateIndex, derivative] : derivatives) result[localStateIndex] = derivative;
    return result;
}

}

std::optional<NodeStabilityAssessment> assessNodeStability(
    const NodeExecutionPlan& node, const StateValues& synchronizationSnapshot, double globalTimeStep,
    const std::vector<std::size_t>& relationshipSet) {
    if (!isEquationOnly(node)) return std::nullopt;

    const std::set<std::size_t> setByRelationships(relationshipSet.begin(), relationshipSet.end());
    std::set<std::size_t> algebraicLocalIndices;
    for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) {
        if (setByRelationships.contains(node.stateIndexes[index])) algebraicLocalIndices.insert(index);
        for (const auto& task : node.algebraicTasks) {
            if (task.outputStateIndex == node.stateIndexes[index]) algebraicLocalIndices.insert(index);
        }
    }
    // A differential state nothing contributes to has a rate of exactly zero whatever the others are: its row of the
    // Jacobian is nothing, so it adds an eigenvalue of zero (an amplification of exactly 1) and leaves the others as
    // the rest of the Jacobian has them. It is left out of the Jacobian, which a node holding many such states (a
    // robot's rows' settings, hundreds) would otherwise make cubically costly, and its zero is counted below.
    std::set<std::size_t> writtenLocalIndices;
    for (const auto& task : node.contributions) writtenLocalIndices.insert(task.outputStateIndex);
    std::vector<std::size_t> differentialLocalIndices;
    std::size_t idleStateCount = 0;
    for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) {
        if (algebraicLocalIndices.contains(index)) continue;
        if (writtenLocalIndices.contains(index)) differentialLocalIndices.push_back(index);
        else idleStateCount += 1;
    }
    if (differentialLocalIndices.empty() && idleStateCount == 0) return std::nullopt;

    StateValues localStates(node.stateIndexes.size());
    for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) {
        localStates[index] = synchronizationSnapshot.at(node.stateIndexes[index]);
    }
    const auto parameterValues = resolveParameterValues(node.contributions, {});
    const auto algebraicParameterValues = resolveParameterValues(node.algebraicTasks, {});
    const auto nodeStepSize = globalTimeStep / static_cast<double>(node.substeps);

    // Central-difference Jacobian, restricted to the node's own differential states (both rows and
    // columns): perturbing state j by ±epsilon and re-running the exact substep derivative
    // computation gives column j directly, with no baseline (unperturbed) evaluation needed.
    const auto stateCount = differentialLocalIndices.size();
    Eigen::MatrixXd jacobian(static_cast<Eigen::Index>(stateCount), static_cast<Eigen::Index>(stateCount));
    for (std::size_t column = 0; column < stateCount; ++column) {
        const auto localIndex = differentialLocalIndices[column];
        const auto magnitude = std::abs(localStates[localIndex]);
        const auto epsilon = std::max(1e-6, magnitude * 1e-6);

        auto perturbedUp = localStates;
        perturbedUp[localIndex] += epsilon;
        const auto derivativeUp = evaluateNodeDerivative(
            node, perturbedUp, synchronizationSnapshot, parameterValues, algebraicParameterValues, 0.0, nodeStepSize);

        auto perturbedDown = localStates;
        perturbedDown[localIndex] -= epsilon;
        const auto derivativeDown = evaluateNodeDerivative(
            node, perturbedDown, synchronizationSnapshot, parameterValues, algebraicParameterValues, 0.0, nodeStepSize);

        for (std::size_t row = 0; row < stateCount; ++row) {
            const auto rowIndex = differentialLocalIndices[row];
            jacobian(static_cast<Eigen::Index>(row), static_cast<Eigen::Index>(column)) =
                (derivativeUp[rowIndex] - derivativeDown[rowIndex]) / (2 * epsilon);
        }
    }

    // computeEigenvectors is only actually consulted below when the node turns out unstable (the
    // attribution step), but EigenSolver's own decomposition cost is dominated by stateCount cubed
    // regardless -- requesting eigenvectors too adds negligible cost on top for the small per-node
    // matrices this function ever sees, so there is no reason to conditionally re-decompose later.
    NodeStabilityAssessment assessment;
    assessment.nodeId = node.nodeId;
    assessment.substeps = node.substeps;
    assessment.nodeStepSize = nodeStepSize;
    // The idle states' zeros: |1 + h·0| = 1.
    if (idleStateCount) assessment.maxAmplificationFactor = 1;
    if (differentialLocalIndices.empty()) return assessment;
    const Eigen::EigenSolver<Eigen::MatrixXd> solver(jacobian, /*computeEigenvectors=*/true);

    // A conserved total (a quantity passed round among a node's states) or a running sum has a rate
    // of exactly zero, but the finite-difference Jacobian gives it round-off of either sign, about
    // 1e-10 of the node's fastest rate. So a mode below a millionth of the fastest rate is taken as
    // neutral: neither a slow decay (which would make every such node look stiff, with ratios of
    // 1e10 and more) nor a growing mode. A genuine decay a million times slower than the fastest
    // does not move over the fast timescale either, so leaving it out loses nothing that matters here.
    double spectralRadius = 0;
    for (Eigen::Index index = 0; index < solver.eigenvalues().size(); ++index) spectralRadius = std::max(spectralRadius, std::abs(solver.eigenvalues()(index)));
    const auto neutralRate = 1e-6 * spectralRadius;

    double slowestNegativeRate = 0;
    double fastestNegativeRate = 0;
    std::size_t negativeRealPartCount = 0;
    Eigen::Index dominantIndex = 0;
    bool hasNonNegativeRealPart = false;
    bool hasGrowingRealPart = false;
    double minStableNodeStepSize = std::numeric_limits<double>::infinity();
    for (Eigen::Index index = 0; index < solver.eigenvalues().size(); ++index) {
        const auto eigenvalue = solver.eigenvalues()(index);
        const auto amplificationReal = 1.0 + nodeStepSize * eigenvalue.real();
        const auto amplificationImaginary = nodeStepSize * eigenvalue.imag();
        const auto amplification = std::sqrt(amplificationReal * amplificationReal + amplificationImaginary * amplificationImaginary);
        if (amplification > assessment.maxAmplificationFactor) dominantIndex = index;
        assessment.maxAmplificationFactor = std::max(assessment.maxAmplificationFactor, amplification);

        if (eigenvalue.real() < -neutralRate) {
            const auto rate = std::abs(eigenvalue.real());
            if (!negativeRealPartCount || rate < slowestNegativeRate) slowestNegativeRate = rate;
            if (!negativeRealPartCount || rate > fastestNegativeRate) fastestNegativeRate = rate;
            negativeRealPartCount += 1;
            // Solving |1 + h·λ| ≤ 1 for h gives h ≤ -2·Re(λ)/|λ|² (std::norm(λ) is |λ|² without a
            // sqrt) -- the largest node step size that keeps THIS eigenvalue's own mode stable.
            // The tightest bound across every eigenvalue is what actually stabilizes the node.
            minStableNodeStepSize = std::min(minStableNodeStepSize, -2 * eigenvalue.real() / std::norm(eigenvalue));
        } else if (eigenvalue.real() > neutralRate || std::abs(eigenvalue.imag()) > neutralRate) {
            // Growing, or oscillating without decay: Explicit Euler amplifies either at every step size.
            hasNonNegativeRealPart = true;
            if (eigenvalue.real() > neutralRate) hasGrowingRealPart = true;
        }
    }
    // A small tolerance above the exact 1.0 boundary, not a real stability margin: the
    // finite-difference Jacobian itself carries perturbation noise on the order of epsilon, which
    // can nudge a genuinely-exactly-marginal amplification factor either side of 1.0 -- flagging a
    // model as "unstable" purely from that noise, right at the boundary, would be a false positive
    // this heuristic doesn't need to produce.
    assessment.stable = assessment.maxAmplificationFactor <= 1.0 + 1e-6;
    if (negativeRealPartCount >= 2 && slowestNegativeRate > 0) {
        assessment.stiffnessRatio = fastestNegativeRate / slowestNegativeRate;
    }
    if (!assessment.stable) {
        // Mutually exclusive by construction: for Re(λ) ≥ 0, |1+h·λ| ≥ 1 for every h > 0, so no
        // finite step size stabilizes that mode at all -- there is no bound to report.
        assessment.unconditionallyUnstable = hasNonNegativeRealPart;
        assessment.undampedOscillation = hasNonNegativeRealPart && !hasGrowingRealPart && !node.semiImplicit && !node.verlet && stateCount > 1;
        if (!hasNonNegativeRealPart) {
            assessment.requiredSubsteps = static_cast<std::size_t>(std::ceil(globalTimeStep / minStableNodeStepSize));
        }
    }

    // A Verlet node (NodeExecutionPlan::verlet): one substep of the linearized node y' = J y is K D K, K moving the first
    // part's states by half a step (I + h/2 J on their rows) and D the second's by a whole one (I + h J on theirs), so its
    // amplification is the spectral radius of K D K, not Euler's |1 + h λ|. Each part's rates read only the other's, so J's
    // eigenvalues come in pairs ±μ: an oscillation (μ imaginary) is stable up to a step (h |μ| ≤ 2 for one), and any other
    // pair has a growing mode that no substep count stabilizes.
    if (node.verlet) {
        const auto size = static_cast<Eigen::Index>(stateCount);
        const auto amplificationAt = [&](double stepSize) {
            Eigen::MatrixXd kick = Eigen::MatrixXd::Identity(size, size);
            Eigen::MatrixXd drift = Eigen::MatrixXd::Identity(size, size);
            for (Eigen::Index row = 0; row < size; ++row) {
                if (node.verletKicked.at(differentialLocalIndices[static_cast<std::size_t>(row)])) kick.row(row) += 0.5 * stepSize * jacobian.row(row);
                else drift.row(row) += stepSize * jacobian.row(row);
            }
            const Eigen::MatrixXd step = kick * drift * kick;
            return step.eigenvalues().cwiseAbs().maxCoeff();
        };
        const auto stableAt = [&](std::size_t substeps) { return amplificationAt(globalTimeStep / static_cast<double>(substeps)) <= 1.0 + 1e-6; };
        assessment.maxAmplificationFactor = std::max(idleStateCount ? 1.0 : 0.0, amplificationAt(nodeStepSize));
        assessment.stable = assessment.maxAmplificationFactor <= 1.0 + 1e-6;
        assessment.unconditionallyUnstable = false;
        assessment.requiredSubsteps.reset();
        const auto& eigenvalues = solver.eigenvalues();
        bool growing = false;
        for (Eigen::Index index = 0; index < eigenvalues.size(); ++index) growing = growing || eigenvalues(index).real() > neutralRate;
        // The mode the finding names: the fastest growing one if there is one, else the fastest oscillation, which limits the step.
        dominantIndex = 0;
        for (Eigen::Index index = 1; index < eigenvalues.size(); ++index) {
            const auto eigenvalue = eigenvalues(index);
            const auto dominant = eigenvalues(dominantIndex);
            if (growing ? eigenvalue.real() > dominant.real() : std::abs(eigenvalue) > std::abs(dominant)) dominantIndex = index;
        }
        if (!assessment.stable) {
            constexpr std::size_t mostSubsteps = 10000;
            std::size_t low = node.substeps;
            std::size_t high = node.substeps;
            while (!growing && high < mostSubsteps && !stableAt(high)) {
                low = high;
                high = std::min(mostSubsteps, high * 2);
            }
            if (growing || !stableAt(high)) {
                assessment.unconditionallyUnstable = true;
            } else {
                // The fewest substeps from low (unstable) to high (stable) that are stable.
                while (high - low > 1) {
                    const auto middle = low + (high - low) / 2;
                    (stableAt(middle) ? high : low) = middle;
                }
                assessment.requiredSubsteps = high;
            }
        }
    }

    // A semi-implicit node updates its states one after another in the order it lists them, each from the states already updated
    // (docs/projectSchema.md, numerics.integration): linearised, a substep is x' = x + h(L x' + (D + U) x), with L the part of the
    // Jacobian below its diagonal, so its amplification matrix is (I - hL)^-1 (I + h(D + U)), not Euler's I + hJ. An undamped
    // oscillation, which Euler amplifies at every step, is then neutral (|μ| = 1) up to hω = 2. One state has nothing before it,
    // and the two agree.
    if (node.semiImplicit && stateCount > 1) {
        const auto size = static_cast<Eigen::Index>(stateCount);
        const Eigen::MatrixXd lower = jacobian.triangularView<Eigen::StrictlyLower>();
        const Eigen::MatrixXd rest = jacobian - lower;
        const auto amplificationAt = [&](double stepSize) {
            const Eigen::MatrixXd identity = Eigen::MatrixXd::Identity(size, size);
            const Eigen::MatrixXd amplificationMatrix = (identity - stepSize * lower).triangularView<Eigen::Lower>().solve(identity + stepSize * rest);
            const Eigen::EigenSolver<Eigen::MatrixXd> amplificationSolver(amplificationMatrix, /*computeEigenvectors=*/false);
            double largest = idleStateCount ? 1.0 : 0.0;
            for (Eigen::Index index = 0; index < amplificationSolver.eigenvalues().size(); ++index) largest = std::max(largest, std::abs(amplificationSolver.eigenvalues()(index)));
            return largest;
        };
        const auto stableAt = [&](double amplification) { return amplification <= 1.0 + 1e-6; };
        assessment.maxAmplificationFactor = amplificationAt(nodeStepSize);
        assessment.stable = stableAt(assessment.maxAmplificationFactor);
        assessment.unconditionallyUnstable = false;
        assessment.requiredSubsteps.reset();
        if (!assessment.stable && hasGrowingRealPart) {
            // The equations themselves grow (Re(λ) > 0): no method and no step holds that, as for Explicit Euler above.
            assessment.unconditionallyUnstable = true;
        } else if (!assessment.stable) {
            // The fewest substeps that make it stable: doubled until it is, then halved back by bisection, up to a million times
            // the substeps; beyond that no count is offered.
            constexpr std::size_t searchLimit = 1u << 20;
            std::size_t stableCount = 0;
            std::size_t unstableCount = node.substeps;
            for (std::size_t count = node.substeps * 2; count <= node.substeps * searchLimit; count *= 2) {
                if (stableAt(amplificationAt(globalTimeStep / static_cast<double>(count)))) { stableCount = count; break; }
                unstableCount = count;
            }
            if (!stableCount) {
                assessment.unconditionallyUnstable = true;
            } else {
                while (stableCount - unstableCount > 1) {
                    const auto middle = unstableCount + (stableCount - unstableCount) / 2;
                    if (stableAt(amplificationAt(globalTimeStep / static_cast<double>(middle)))) stableCount = middle; else unstableCount = middle;
                }
                assessment.requiredSubsteps = stableCount;
            }
        }
    }

    // Attribution, not just detection (see this function's own doc comment): only worth the extra
    // evaluations once a node is actually flagged. The dominant eigenvalue's eigenvector says which
    // single state the unstable mode is concentrated in; every task feeding that state's own
    // derivative is a candidate, ranked by how much perturbing each of its parameters moves that
    // state's derivative.
    if (!assessment.stable) {
        // Eigen::EigenSolver::eigenvectors() computes and returns its matrix by value, not a
        // stored member -- binding `.col(...)` of that temporary straight to `auto` would leave a
        // Block referencing an already-destroyed temporary (a classic Eigen expression-template
        // dangling-reference pitfall). Materializing it into a named matrix first keeps it alive
        // for as long as `eigenvectors` itself is in scope.
        const Eigen::MatrixXcd eigenvectors = solver.eigenvectors();
        const auto eigenvector = eigenvectors.col(dominantIndex);
        std::size_t dominantLocalIndex = 0;
        double largestComponent = -1;
        for (std::size_t row = 0; row < stateCount; ++row) {
            const auto magnitude = std::abs(eigenvector(static_cast<Eigen::Index>(row)));
            if (magnitude > largestComponent) { largestComponent = magnitude; dominantLocalIndex = row; }
        }
        const auto dominantStateIndex = differentialLocalIndices[dominantLocalIndex];
        const auto dominantStateId = node.stateIds[dominantStateIndex];
        assessment.dominantStateId = dominantStateId;

        const auto baselineDerivative = evaluateNodeDerivative(
            node, localStates, synchronizationSnapshot, parameterValues, algebraicParameterValues, 0.0, nodeStepSize);

        // Only node.contributions can ever match: a setsValue term's task lives in
        // node.algebraicTasks precisely because its own output is an algebraic state, and
        // dominantStateId is always drawn from differentialLocalIndices (an algebraic and a
        // differential state are never the same one) -- so node.algebraicTasks has no task whose
        // outputStateId could ever equal it. This means attribution only ever names a parameter
        // that DIRECTLY feeds the dominant state's own equation; a parameter reaching it only
        // indirectly (through an algebraic state the dominant state's own equation reads) is not
        // attributed to here -- a known, narrower-than-ideal scope matching this feature's own
        // design doc, not an oversight.
        double bestSensitivity = 1e-9;
        for (std::size_t taskIndex = 0; taskIndex < node.contributions.size(); ++taskIndex) {
            const auto& task = node.contributions[taskIndex];
            if (task.outputStateId != dominantStateId) continue;
            for (std::size_t parameterIndex = 0; parameterIndex < task.parameters.size(); ++parameterIndex) {
                auto perturbedParameterValues = parameterValues;
                const auto baseValue = perturbedParameterValues.at(taskIndex).at(parameterIndex);
                const auto epsilon = std::max(1e-6, std::abs(baseValue) * 1e-6);
                perturbedParameterValues[taskIndex][parameterIndex] = baseValue + epsilon;

                const auto perturbedDerivative = evaluateNodeDerivative(
                    node, localStates, synchronizationSnapshot, perturbedParameterValues, algebraicParameterValues, 0.0, nodeStepSize);
                const auto sensitivity = std::abs(perturbedDerivative[dominantStateIndex] - baselineDerivative[dominantStateIndex]) / epsilon;
                if (sensitivity > bestSensitivity) {
                    bestSensitivity = sensitivity;
                    assessment.dominantParameter = ParameterAttribution{task.sourceId, task.parameters[parameterIndex].id, sensitivity};
                }
            }
        }
    }
    return assessment;
}


namespace {

// An explicit method's stability function, from its tableau: (I - zA) k = 1 by forward substitution (A is strictly lower triangular);
// R = 1 + z b^T k.
template <typename Tableau>
std::complex<double> explicitStabilityFunction(std::complex<double> z) {
    std::complex<double> k[Tableau::stages];
    std::complex<double> result = 1.0;
    for (std::size_t row = 0; row < Tableau::stages; ++row) {
        k[row] = 1.0;
        for (std::size_t column = 0; column < row; ++column) k[row] += z * Tableau::a[row][column] * k[column];
        result += z * Tableau::b[row] * k[row];
    }
    return result;
}

template <typename Tableau>
double explicitLargestStableStep(std::complex<double> eigenvalue) {
    const auto magnitude = std::abs(eigenvalue);
    if (magnitude == 0) return std::numeric_limits<double>::infinity();
    if (eigenvalue.real() > 0) return 0;
    const auto direction = eigenvalue / magnitude;
    const auto grows = [&](double reach) { return std::abs(explicitStabilityFunction<Tableau>(reach * direction)) > 1.0 + 1e-12; };
    // Every explicit method's region is bounded: Runge–Kutta 4's reaches about 2.83 from the origin and Dormand–Prince's about 3.4, so
    // a scan to 8 finds its edge.
    constexpr double scanStep = 1e-3;
    double reach = 0;
    while (reach < 8 && !grows(reach + scanStep)) reach += scanStep;
    if (reach >= 8) return std::numeric_limits<double>::infinity();
    double outside = reach + scanStep;
    for (int iteration = 0; iteration < 60; ++iteration) {
        const auto middle = 0.5 * (reach + outside);
        (grows(middle) ? outside : reach) = middle;
    }
    return reach / magnitude;
}

}

std::complex<double> rungeKutta4StabilityFunction(std::complex<double> z) {
    return explicitStabilityFunction<integrators::RungeKutta4Tableau>(z);
}

double rungeKutta4LargestStableStep(std::complex<double> eigenvalue) {
    return explicitLargestStableStep<integrators::RungeKutta4Tableau>(eigenvalue);
}

std::complex<double> dormandPrince54StabilityFunction(std::complex<double> z) {
    return explicitStabilityFunction<integrators::DormandPrince54Tableau>(z);
}

double dormandPrince54LargestStableStep(std::complex<double> eigenvalue) {
    return explicitLargestStableStep<integrators::DormandPrince54Tableau>(eigenvalue);
}

std::complex<double> rodas4StabilityFunction(std::complex<double> z) {
    // One step of Rodas4 on y' = lambda y from y = 1 with h = 1 and z = lambda: its Jacobian is z, its matrix 1 / gamma - z, and df/dt is
    // zero, so each stage solves k_i (1 / gamma - z) = z Y_i + sum_j C[i][j] k_j; the step ends at Y_6 + k_6.
    using T = integrators::Rodas4Tableau;
    const std::complex<double> matrix = 1.0 / T::gamma - z;
    std::complex<double> k[T::stages];
    std::complex<double> stage = 1.0;
    for (std::size_t row = 0; row < T::stages; ++row) {
        if (row >= 1 && row <= 4) {
            stage = 1.0;
            for (std::size_t column = 0; column < row; ++column) stage += T::a[row][column] * k[column];
        } else if (row == 5) {
            stage += k[4];
        }
        std::complex<double> right = z * stage;
        for (std::size_t column = 0; column < row; ++column) right += T::C[row][column] * k[column];
        k[row] = right / matrix;
    }
    return stage + k[T::stages - 1];
}

double rodas4LargestStableStep(std::complex<double> eigenvalue) {
    // L-stable: |R(z)| <= 1 over the whole left half-plane and R(z) -> 0 far into it, so no step is too large for a decaying mode. A
    // growing mode (positive real part) grows in the model itself, whatever the step.
    return eigenvalue.real() > 0 ? 0.0 : std::numeric_limits<double>::infinity();
}

namespace {

bool isEquationOnlyForStages(const NodeExecutionPlan& node) {
    if (node.nodeProvider) return false;
    return std::all_of(node.contributions.begin(), node.contributions.end(),
        [](const ContributionTask& task) { return task.implementation == ContributionImplementation::equation; });
}

}

std::optional<WholeModelStabilityAssessment> assessWholeModelStability(
    const ExecutionPlan& plan, const StateValues& states, double globalTimeStep, std::size_t stepsPerGlobalStep, std::size_t denseLimit,
    IntegrationMethod method) {
    const bool dormandPrince = method == IntegrationMethod::dormandPrince54;
    // BDF is judged as Rodas4 is, stable for every mode that decays, and its higher orders' limit near the imaginary axis by the angle
    // of the model's modes (largestDecayingAngleDegrees).
    const bool rodas = method == IntegrationMethod::rodas4 || method == IntegrationMethod::bdf;
    const auto stabilityFunction = rodas ? rodas4StabilityFunction : dormandPrince ? dormandPrince54StabilityFunction : rungeKutta4StabilityFunction;
    const auto largestStableStep = rodas ? rodas4LargestStableStep : dormandPrince ? dormandPrince54LargestStableStep : rungeKutta4LargestStableStep;
    // Adaptive (no steps per global step) is judged at the global step, the largest step it may take.
    const bool adaptive = dormandPrince && stepsPerGlobalStep == 0;
    stepsPerGlobalStep = std::max<std::size_t>(1, stepsPerGlobalStep);
    if (!std::all_of(plan.nodes.begin(), plan.nodes.end(), isEquationOnlyForStages)) return std::nullopt;
    // The integrated states, in plan order, with their nodes: those a node's Rate terms add to.
    std::vector<std::size_t> integrated;
    std::vector<std::size_t> nodeOf;
    for (std::size_t node = 0; node < plan.nodes.size(); ++node) {
        std::set<std::size_t> written;
        for (const auto& task : plan.nodes[node].contributions) written.insert(plan.nodes[node].stateIndexes.at(task.outputStateIndex));
        for (const auto index : written) { integrated.push_back(index); nodeOf.push_back(node); }
    }
    if (integrated.empty()) return std::nullopt;
    WholeModelStabilityAssessment assessment;
    assessment.stateCount = integrated.size();
    assessment.perNode = integrated.size() > denseLimit;
    assessment.stepsPerGlobalStep = stepsPerGlobalStep;
    assessment.stepSize = globalTimeStep / static_cast<double>(stepsPerGlobalStep);
    std::vector<NodeParameterValues> parameters;
    for (const auto& node : plan.nodes) parameters.push_back(resolveParameterValues(node.contributions, {}));
    // Each node's derivatives at `values` (every state of the plan), as a stage evaluates them: the node's own states and its
    // neighbours' read alike from the one vector.
    const auto derivatives = [&](std::size_t node, const StateValues& values) {
        const auto& compiled = plan.nodes[node];
        StateValues local(compiled.stateIndexes.size());
        for (std::size_t index = 0; index < local.size(); ++index) local[index] = values[compiled.stateIndexes[index]];
        std::vector<double> result(values.size(), 0.0);
        for (const auto& [localIndex, value] : reduceContributions(evaluateContributionTasks(compiled, local, values, parameters[node]))) {
            result[compiled.stateIndexes[localIndex]] = value;
        }
        return result;
    };
    // The groups judged together: the whole model, or each node on its own.
    std::vector<std::vector<std::size_t>> groups;
    if (!assessment.perNode) {
        groups.emplace_back();
        for (std::size_t index = 0; index < integrated.size(); ++index) groups.back().push_back(index);
    } else {
        groups.resize(plan.nodes.size());
        for (std::size_t index = 0; index < integrated.size(); ++index) groups[nodeOf[index]].push_back(index);
    }
    double fastest = 0;
    double slowest = 0;
    std::size_t decaying = 0;
    double largestStable = std::numeric_limits<double>::infinity();
    double dominantAmplification = -1;
    for (const auto& group : groups) {
        if (group.empty()) continue;
        const auto size = static_cast<Eigen::Index>(group.size());
        Eigen::MatrixXd jacobian(size, size);
        for (Eigen::Index column = 0; column < size; ++column) {
            const auto state = integrated[group[static_cast<std::size_t>(column)]];
            const auto epsilon = std::max(1e-6, std::abs(states[state]) * 1e-6);
            auto up = states;
            up[state] += epsilon;
            auto down = states;
            down[state] -= epsilon;
            // Only the nodes in the group are evaluated; in a whole-model group, that is every node.
            std::vector<double> rateUp(states.size(), 0.0);
            std::vector<double> rateDown(states.size(), 0.0);
            std::set<std::size_t> nodes;
            for (const auto member : group) nodes.insert(nodeOf[member]);
            for (const auto node : nodes) {
                const auto upRates = derivatives(node, up);
                const auto downRates = derivatives(node, down);
                for (const auto index : plan.nodes[node].stateIndexes) { rateUp[index] = upRates[index]; rateDown[index] = downRates[index]; }
            }
            for (Eigen::Index row = 0; row < size; ++row) {
                const auto rowState = integrated[group[static_cast<std::size_t>(row)]];
                jacobian(row, column) = (rateUp[rowState] - rateDown[rowState]) / (2 * epsilon);
            }
        }
        const Eigen::EigenSolver<Eigen::MatrixXd> solver(jacobian, true);
        double spectralRadius = 0;
        for (Eigen::Index index = 0; index < size; ++index) spectralRadius = std::max(spectralRadius, std::abs(solver.eigenvalues()(index)));
        // As assessNodeStability: a rate below a millionth of the fastest is the differences' round-off, taken as neutral.
        const auto neutral = 1e-6 * spectralRadius;
        for (Eigen::Index index = 0; index < size; ++index) {
            auto eigenvalue = solver.eigenvalues()(index);
            if (std::abs(eigenvalue.real()) <= neutral) eigenvalue = {0.0, std::abs(eigenvalue.imag()) <= neutral ? 0.0 : eigenvalue.imag()};
            const auto amplification = std::abs(stabilityFunction(assessment.stepSize * eigenvalue));
            if (amplification > dominantAmplification) {
                dominantAmplification = amplification;
                const Eigen::MatrixXcd vectors = solver.eigenvectors();
                Eigen::Index largest = 0;
                for (Eigen::Index row = 0; row < size; ++row) if (std::abs(vectors(row, index)) > std::abs(vectors(largest, index))) largest = row;
                const auto member = group[static_cast<std::size_t>(largest)];
                assessment.dominantStateId = 0;
                for (const auto& [stateId, stateIndex] : plan.stateIndexes) if (stateIndex == integrated[member]) assessment.dominantStateId = stateId;
                assessment.dominantNodeId = plan.nodes[nodeOf[member]].nodeId;
            }
            assessment.maxAmplificationFactor = std::max(assessment.maxAmplificationFactor, amplification);
            if (eigenvalue.real() < 0) {
                const auto rate = -eigenvalue.real();
                if (!decaying || rate > fastest) fastest = rate;
                if (!decaying || rate < slowest) slowest = rate;
                ++decaying;
            }
            if (eigenvalue.real() < 0) {
                assessment.largestDecayingAngleDegrees = std::max(assessment.largestDecayingAngleDegrees,
                    std::atan2(std::abs(eigenvalue.imag()), -eigenvalue.real()) * 180.0 / 3.14159265358979323846);
            }
            const auto bound = largestStableStep(eigenvalue);
            if (bound == 0) assessment.unconditionallyUnstable = true;
            largestStable = std::min(largestStable, bound);
        }
    }
    assessment.stable = assessment.maxAmplificationFactor <= 1.0 + 1e-6;
    if (decaying >= 2 && slowest > 0) assessment.stiffnessRatio = fastest / slowest;
    // Adaptive keeps itself stable by taking smaller steps: what the analysis says is the step stability holds it to.
    if (adaptive && std::isfinite(largestStable) && largestStable > 0) assessment.largestStableStep = largestStable;
    if (!assessment.stable) {
        if (assessment.unconditionallyUnstable) return assessment;
        assessment.unconditionallyUnstable = false;
        assessment.largestStableStep = largestStable;
        assessment.requiredStepsPerGlobalStep = static_cast<std::size_t>(std::ceil(globalTimeStep / largestStable));
    }
    return assessment;
}

}
