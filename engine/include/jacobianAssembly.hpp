/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Exact Jacobians for the stiff methods (docs/proposals/integrators.md, Jacobians for Rodas4 and BDF): every equation differentiated
// symbolically, once, with respect to each symbol it binds, and the derivatives assembled into the Jacobian's columns at each step. A
// column is worked out exactly when every term reading its state can give its derivatives (an equation, or a program that supplies its
// own); the others stay coloured finite differences (stiffSystem.hpp).

#include "executionPlan.hpp"
#include "wholeModelIntegration.hpp"
#include "konjugate/integrators/stiffSystem.hpp"

#include <functional>
#include <optional>
#include <vector>

namespace konjugate {

// The derivative of `expression` with respect to its symbol `symbolIndex`, as an expression of the same symbols; none when it is zero
// everywhere. The rules (and the few simplifications: a term whose derivative is zero dropped, a factor of 1 not written) are mirrored
// exactly by code export's differentiation of MathJSON (src/expressionDerivative.mjs), so the engine and an exported program evaluate
// the same derivative, operation for operation. A Which is differentiated through its branches, its conditions kept: the derivative of
// the branch that holds. Abs, Min and Max likewise through the side that holds; a comparison has none.
std::optional<CompiledExpression> differentiateExpression(const CompiledExpression& expression, std::size_t symbolIndex);

// One equation's derivative with respect to one of its bindings, added into one entry of the Jacobian (or, for the time, into df/dt).
struct JacobianTerm {
    std::size_t node = 0;
    std::size_t task = 0;
    CompiledExpression expression;
    ExpressionProgram program;
    // The entry it is added into, or for a time term the row (position) of df/dt.
    std::size_t target = 0;
    bool negate = false;
};

// What is worked out exactly, compiled once from the stage terms (after event location has made their conditions read latches).
struct JacobianPlan {
    // Per position: whether its column is exact.
    std::vector<unsigned char> exactColumn;
    // Every entry of every exact column, set to zero before the terms are added.
    std::vector<std::size_t> exactEntries;
    // In node order, each node's terms in plan order, each term's bindings in order.
    std::vector<JacobianTerm> terms;
    // df/dt: the derivatives with respect to a time binding, in the same order; usable only when `exactTime`.
    std::vector<JacobianTerm> timeTerms;
    bool exactTime = false;
    // The equations differentiated, and the derivatives they gave.
    std::size_t differentiatedTerms = 0;
};

// `providers`, as for stageReads: a version 2 program's declared dependencies narrow the columns it makes finite differences.
JacobianPlan compileJacobianPlan(const ExecutionPlan& plan, const WholeModelPlan& whole, const integrators::StiffSystem& system,
                                 const ProviderEvaluator* providers = nullptr);

// Writes every exact column's entries of `jacobian` at (time, states), and with `dT`, df/dt at every position, from the stage terms'
// derivatives, with the parameters as the stage terms resolve them and the conditions' latches.
void evaluateExactJacobian(const ExecutionPlan& plan, const WholeModelPlan& whole, const JacobianPlan& jacobianPlan, double time,
                           const std::vector<double>& states, const EntityValues& liveParameterValues,
                           const std::vector<ParameterSchedule>& activeSchedules, const std::vector<double>* latches,
                           std::vector<double>& jacobian, std::vector<double>* dT);

// For the stability analysis: every equation term of `tasks` differentiated exactly at its symbols, `valueOf` giving each binding's
// value (parameters from `parameters`, the time `time`), and each derivative with respect to a binding `stateOf` maps to a state
// (none: std::numeric_limits<std::size_t>::max()) handed to add(the term's output state index, that state, the derivative, sign
// applied). Only for equations: a program has no expression to differentiate.
void addExactDerivatives(const std::vector<ContributionTask>& tasks, const NodeParameterValues& parameters, double time,
                         const std::function<double(const CompiledBinding&)>& valueOf,
                         const std::function<std::size_t(const CompiledBinding&)>& stateOf,
                         const std::function<void(std::size_t, std::size_t, double)>& add);

}
