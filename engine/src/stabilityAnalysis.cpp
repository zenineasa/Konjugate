/* Copyright © 2026 Zenin Easa Panthakkalakath */

#include "stabilityAnalysis.hpp"
#include <Eigen/Dense>
#include <algorithm>
#include <cmath>
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
std::vector<double> evaluateNodeDerivative(
    const NodeExecutionPlan& node, StateValues localStates, const StateValues& synchronizationSnapshot,
    const NodeParameterValues& parameterValues, const NodeParameterValues& algebraicParameterValues,
    double simulationTime, double nodeStepSize) {
    applyAlgebraicTasks(node.algebraicTasks, localStates, algebraicParameterValues, simulationTime, nodeStepSize, nullptr);
    const auto evaluated = evaluateContributionTasks(
        node, localStates, synchronizationSnapshot, parameterValues, simulationTime, nodeStepSize, nullptr);
    const auto derivatives = reduceContributions(evaluated);
    std::vector<double> result(node.stateIndexes.size(), 0.0);
    for (const auto& [stateIndex, derivative] : derivatives) {
        const auto found = std::find(node.stateIndexes.begin(), node.stateIndexes.end(), stateIndex);
        if (found != node.stateIndexes.end()) result[static_cast<std::size_t>(std::distance(node.stateIndexes.begin(), found))] = derivative;
    }
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

    const Eigen::EigenSolver<Eigen::MatrixXd> solver(jacobian, /*computeEigenvectors=*/false);
    NodeStabilityAssessment assessment;
    assessment.nodeId = node.nodeId;
    assessment.substeps = node.substeps;
    assessment.nodeStepSize = nodeStepSize;

    double slowestNegativeRate = 0;
    double fastestNegativeRate = 0;
    std::size_t negativeRealPartCount = 0;
    for (Eigen::Index index = 0; index < solver.eigenvalues().size(); ++index) {
        const auto eigenvalue = solver.eigenvalues()(index);
        const auto amplificationReal = 1.0 + nodeStepSize * eigenvalue.real();
        const auto amplificationImaginary = nodeStepSize * eigenvalue.imag();
        const auto amplification = std::sqrt(amplificationReal * amplificationReal + amplificationImaginary * amplificationImaginary);
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
    return assessment;
}

}
