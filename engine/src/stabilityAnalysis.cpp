/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "stabilityAnalysis.hpp"
#include <Eigen/Dense>
#include <algorithm>
#include <cmath>
#include <complex>
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
    const NodeExecutionPlan& node, const StateValues& synchronizationSnapshot, double globalTimeStep) {
    if (!isEquationOnly(node)) return std::nullopt;

    std::set<std::size_t> algebraicLocalIndices;
    for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) {
        for (const auto& task : node.algebraicTasks) {
            if (task.outputStateIndex == node.stateIndexes[index]) algebraicLocalIndices.insert(index);
        }
    }
    std::vector<std::size_t> differentialLocalIndices;
    for (std::size_t index = 0; index < node.stateIndexes.size(); ++index) {
        if (!algebraicLocalIndices.contains(index)) differentialLocalIndices.push_back(index);
    }
    if (differentialLocalIndices.empty()) return std::nullopt;

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
    const Eigen::EigenSolver<Eigen::MatrixXd> solver(jacobian, /*computeEigenvectors=*/true);
    NodeStabilityAssessment assessment;
    assessment.nodeId = node.nodeId;
    assessment.substeps = node.substeps;
    assessment.nodeStepSize = nodeStepSize;

    double slowestNegativeRate = 0;
    double fastestNegativeRate = 0;
    std::size_t negativeRealPartCount = 0;
    Eigen::Index dominantIndex = 0;
    for (Eigen::Index index = 0; index < solver.eigenvalues().size(); ++index) {
        const auto eigenvalue = solver.eigenvalues()(index);
        const auto amplificationReal = 1.0 + nodeStepSize * eigenvalue.real();
        const auto amplificationImaginary = nodeStepSize * eigenvalue.imag();
        const auto amplification = std::sqrt(amplificationReal * amplificationReal + amplificationImaginary * amplificationImaginary);
        if (amplification > assessment.maxAmplificationFactor) dominantIndex = index;
        assessment.maxAmplificationFactor = std::max(assessment.maxAmplificationFactor, amplification);

        if (eigenvalue.real() < 0) {
            const auto rate = std::abs(eigenvalue.real());
            if (!negativeRealPartCount || rate < slowestNegativeRate) slowestNegativeRate = rate;
            if (!negativeRealPartCount || rate > fastestNegativeRate) fastestNegativeRate = rate;
            negativeRealPartCount += 1;
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

}
