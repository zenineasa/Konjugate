/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

// Event location's model side (docs/proposals/integrators.md, Event location): the switching conditions found in a model's equations,
// the whole-model stage terms rewritten to read them latched, the switching functions evaluated, and the method's state with the
// latches for checkpoints. The location itself is konjugate/integrators/events.hpp.

#include "executionPlan.hpp"
#include "wholeModelIntegration.hpp"
#include <cstddef>
#include <string>
#include <vector>

namespace konjugate {

// One switching condition: a comparison inside a Which condition of a Rate term written as an equation, g = left - right.
struct SwitchingFunction {
    std::size_t node = 0;
    EntityId sourceId = 0;
    EntityId stateId = 0;
    // events.hpp's switchingLess .. switchingGreaterEqual.
    unsigned char comparison = 0;
    // The comparison's two sides as tasks of their own, with the term's bindings and parameters.
    ContributionTask left;
    ContributionTask right;
};

struct EventPlan {
    std::vector<SwitchingFunction> functions;
};

// The switching conditions of every node that takes part in stages, its stage terms (whole.nodes[].stageNode.contributions) rewritten so
// each comparison of a condition reads its latch. A model without conditions comes back with no functions and its plan untouched.
EventPlan compileEventPlan(const ExecutionPlan& plan, WholeModelPlan& whole);

// The Rate terms written as equations whose conditions a node-by-node run does not locate, as (sourceId, stateId), each once, in plan
// order, for the run's summary.
std::vector<std::pair<EntityId, EntityId>> unlocatedConditions(const ExecutionPlan& plan);

// Every switching function's value at (time, states), from the same live parameters and schedules the stages read.
void evaluateSwitchingFunctions(const ExecutionPlan& plan, const EventPlan& events, const StateValues& states,
                                const EntityValues& liveParameterValues, const std::vector<ParameterSchedule>& activeSchedules, double time,
                                std::vector<double>& values);

// The method's hidden state with event location: version 2 of the solver_state record, the controller of Adaptive or Stiff (a proposed step of 0
// when there is none, and Stiff's last accepted step) and every condition's latch and armed flag.
std::string encodeEventSolverState(double proposedStep, double previousError, double previousStep, const std::vector<double>& latches,
                                   const std::vector<unsigned char>& armed);
// Read back; false, and nothing changed, unless it is a version 2 record for exactly this many conditions.
bool decodeEventSolverState(const std::string& record, double& proposedStep, double& previousError, double& previousStep, std::vector<double>& latches,
                            std::vector<unsigned char>& armed);

}
