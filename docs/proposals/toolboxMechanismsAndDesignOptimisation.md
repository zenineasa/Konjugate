---
type: Proposal
title: Toolbox mechanisms, model merging and design optimisation
description: RFC for three core capabilities a robotics toolbox needs, each useful to every toolbox - rebuilding only a toolbox's own part of a model, relationships that set their endpoints' states at each instant (so coupled dynamics stay in the graph), and optimisation towards a design objective with constraints.
tags: [proposals, addons, launcher, providers, optimisation, robotics]
status: draft
implementation: none
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Toolbox mechanisms, model merging and design optimisation

**Status: proposed; Part 2 built (October 2026, not yet released).** It comes from planning the robotics toolbox (`konjugate-robotics`, see its `docs/direction.md`), but each part is meant to serve the logistics and fintech toolboxes too.

## Problem

The robotics toolbox is a CAD-like launcher window: people build a robot from solids joined at chosen frames, or import one from MJCF or URDF, and each robot becomes a mechanism subsystem in the canvas. Its joints and named frames (end effector, payload) are nodes inside it that people wire motors, servos, controllers and sensors to; its dynamics are its joints' own equations. Three things stand in the way today.

1. **A rebuild replaces the whole model.** `launcherOpenInCanvas` (`src/launcherHost.mjs`) sends the importer's model to the project window, which loads it in place of the current one. That is right for logistics, where the canvas mostly shows what the window built. A robot, though, is the start of a model: people wire controllers, batteries and sensors around it by hand, and the next rebuild from the window would throw that work away. The window also cannot read the canvas model, so nothing edited there can flow back.
2. **Coupled dynamics do not fit one derivative per relationship.** The engine integrates with snapshot-coupled explicit Euler, and each relationship contributes one scalar derivative. A chain of rigid bodies is coupled: how fast an elbow turns depends on the whole arm. The arm examples leave their joints uncoupled, and the four-bar example approximates rigid rods with stiff springs, needs a 0.002 s step and still drifts 2 to 3 percent. Solving the whole mechanism inside one node (a provider running a physics engine and setting every solid's states) would work, but it hides the solver outside the graph, against Konjugate's main idea that nodes influence each other only through edges.
3. **Optimisation only fits data.** The `OptimizerBackend` and NLopt run a whole simulation per evaluation over bounded parameters, but the loss is always the error against a CSV. Designing (shortest cycle time with every joint torque within its motor's limit, say) needs an objective computed from the results and constraints.

## Part 1: toolbox-owned regions of a model

### Ownership

Every node, edge, shared parameter and subsystem an importer creates carries the launcher's `addonId` and a stable key the importer chooses (`owner: { addonId, key }`). Keys let a rebuild match what it made last time to what it makes now.

Robotics depends on this more than the others. A subsystem's ports are derived from the relationships that cross its boundary, and subsystems are flattened before the engine runs, so there is no declared port to keep. What people wire to is a real node inside the mechanism subsystem, one per joint and per named frame, keyed by name (`joint:elbow`, `frame:gripper`). The user's motor edges end on those nodes, and they survive a rebuild only because the keys do.

### Merging instead of replacing

A new option, `openInCanvas(scenarioId, { merge: true })` (with `requires: ["mergeModel"]`), changes only what the launcher owns:

- an owned entity whose key is still produced is updated in place, keeping its id, so the user's edges to it, result signals and Pose Visualizer choices survive;
- an owned entity no longer produced is removed, together with the user's edges that touched it, and the window is told which (so it can warn before rebuilding);
- an entity the launcher does not own is never touched;
- a parameter the user has changed by hand in the canvas keeps the user's value unless the launcher marks the parameter as one it drives.

The whole merge is one undo step in the project window.

### Reading the model and hearing its changes (later)

`readModel()` and `onModelChanged(callback)` under a new permission, `model.read`, return the launcher's owned entities and their direct neighbours (not the whole model by default). This lets an edit in the canvas (a joint limit changed in the inspector, say) reach the window. It is the second step; merging alone already makes the window and the canvas safe to use together.

### Who else gains

Logistics: a user could add their own cost node or a hand-made link to a built network without losing it on the next build. Fintech the same for its markets models.

## Part 2: algebraic relationships

Coupled rigid-body dynamics can stay in the graph when the method splits along the joints. Featherstone's articulated-body method does: written with every spatial quantity in the world frame about the world's origin, each joint needs only its two solids' states. Outward, it sets its child's pose and velocity; inward, it passes the child's articulated inertia and bias force to its parent (a parent sums what its children pass); outward again, it works out its own acceleration and sets its child's. What core needs for that is general:

- **A relationship with several equations, each setting a state on one of its two endpoints** (`equationModel.outputs`, each with `role` `source` or `target`, a state, MathJSON and `setsValue: true`, sharing the relationship's `bindings` and named `definitions`, intermediate values used by several equations). An equation reads states of the relationship's own two endpoints and its parameters, never anything else, so influence still flows only along edges.
- **Evaluated at each instant, across the model, in dependency order:** at the start of a run and after each step, every such equation is evaluated once, after the equations setting the states it reads. Equations setting the same state are summed, which is how a parent collects what each of its children passes up. A model whose equations depend on each other in a loop is refused (`algebraicLoop`), as is a state both set this way and integrated (`algebraicStateMixed`).
- **Semi-implicit integration for a node** (`numerics.integration: "semiImplicit"`): its states are updated in the order listed, each from the ones updated before it, so a joint's speed is updated first and its position from the new speed. This keeps an undamped pendulum's energy bounded where explicit Euler lets it grow.
- **Arcsin, Arccos, Arctan, Arctan2 and Tanh** in equations, for angles from rotation matrices and smooth friction.

Each joint is then one relationship of a few dozen equations, which the canvas shows as MathJSON with LaTeX beside it. Live parameters, schedules, interventions, forks and fitting reach them as they reach any equation. Built and tested in the engine (`engine/tests/algebraicRelationshipTests.cpp`); the robotics toolbox checks a drawn pendulum, two-link arm and a cart carrying two pendulums against an independent Newton-Euler solution and agrees to within 1e-9. A launcher whose models use it requires `algebraicRelationships`.

Not covered yet: closed loops (a four-bar) and contact, which need constraint and contact forces. Both can be edges too: a loop's closing joint as a relationship applying the force that keeps it closed, contact as one between the solids that touch. They will be proposed when built.

Fast loops still need a step well below their time constant: a smart servo's position loop is part of its joint's equations and runs at the engine step, so a robot's step is around a millisecond.

### Who else gains

Anything with algebraic coupling along a chain or tree: an electrical ladder network, a hydraulic line of pipes and valves, a supply chain whose stocks pass demand upstream within a day.

## Part 3: design objectives and constraints

Optimisation gains a second mode beside fitting:

- **Variables:** parameters with bounds, as `tuning` today, marked as design variables.
- **Objective:** an expression over results, built from reductions of signals (`max`, `min`, `final`, `integral`, `mean`, `timeAbove(threshold)`), combined with weights. For example `final(cycleTime) + 0.5 * mass` or `integral(motorPower)`.
- **Constraints:** inequalities in the same language, `max(abs(elbowTorque)) <= 4.2`, `final(distance(endEffector, target)) <= 0.002`, passed to NLopt algorithms that support them (COBYLA, SLSQP, ISRES).
- **Results:** each evaluated design can be kept as a branch, so candidates are compared with the existing branch tools; with two objectives, the window shows a Pareto front of kept candidates.
- **Provenance:** variables, bounds, objective, constraints, algorithm and engine version are recorded with the result, as the Tuning section of `productStrategy.md` already asks for fitting.

Discrete choices (which motor from a catalog) stay outside the engine: the toolbox runs one optimisation per choice and compares them.

Each evaluation is a whole run and gradients are finite differences, so the UI should say plainly that this suits a handful of variables and short runs.

### Who else gains

Logistics: least cost with every store's service level at or above a target. Fintech: least risk for a given return. Thermal and other examples: smallest heat exchanger that keeps a temperature below a limit.

## Order

1. Part 1, merging (robotics milestone B, sizing motors wired by hand to an imported robot, needs it so a rebuild keeps them; logistics benefits at once).
2. Part 2, algebraic relationships (robotics milestone A; built).
3. Part 3, design objectives (robotics milestone E).
4. Part 1, reading the model.
