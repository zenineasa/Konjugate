---
type: Proposal
title: Toolbox mechanisms, model merging and design optimisation
description: RFC for three core capabilities a robotics toolbox needs, each useful to every toolbox - rebuilding only a toolbox's own part of a model, providers that solve a group of nodes and edges together, and optimisation towards a design objective with constraints.
tags: [proposals, addons, launcher, providers, optimisation, robotics]
status: proposed
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Toolbox mechanisms, model merging and design optimisation

**Status: proposed.** Nothing here is built. It comes from planning the robotics toolbox (`konjugate-robotics`, see its `docs/direction.md`), but each part is meant to serve the logistics and fintech toolboxes too.

## Problem

The robotics toolbox is a CAD-like launcher window: people build a robot from solids joined at chosen frames, or import one from MJCF or URDF, and each robot becomes a mechanism subsystem in the canvas. Its joints and named frames (end effector, payload) are nodes inside it that people wire motors, servos, controllers and sensors to; its dynamics run in MuJoCo, embedded in one provider. Three things stand in the way today.

1. **A rebuild replaces the whole model.** `launcherOpenInCanvas` (`src/launcherHost.mjs`) sends the importer's model to the project window, which loads it in place of the current one. That is right for logistics, where the canvas mostly shows what the window built. A robot, though, is the start of a model: people wire controllers, batteries and sensors around it by hand, and the next rebuild from the window would throw that work away. The window also cannot read the canvas model, so nothing edited there can flow back.
2. **There is no way to solve several nodes and edges together.** The engine integrates with snapshot-coupled explicit Euler, relationships contribute one scalar derivative each, and a source term reads only its own node. Coupled rigid-body dynamics and closed kinematic loops do not fit that: the four-bar example approximates rigid rods with stiff springs, needs a 0.002 s step and still drifts 2 to 3 percent, and the arm examples leave their joints uncoupled. Computational-node providers come closest (several outputs, their own checkpoint and restore, in process for C++, and since October 2026 reading other nodes' states through the step's snapshot and shared parameters) but write only to their own node and cannot be packaged in a plugin.
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

## Part 2: group providers

A **group provider** owns a declared set of nodes and edges (a subsystem is the natural boundary) and computes the derivatives, or sets the values, of their states together, once per substep:

- it reads any state or parameter of its group and declared inputs from outside the group (a motor's torque, say);
- it writes the states of every node in its group, as derivatives or algebraic values (`setsValue`), not only its own node's;
- it may integrate internally with its own substeps across one engine step, as an FMU does in co-simulation, and reports its states back at the synchronisation boundary;
- it checkpoints and restores like a computational-node provider, so forks and restarts work;
- it reads parameters every step, so live sliders, schedules, interventions and fitting reach it like any equation.

For robotics the group is one mechanism subsystem and the provider embeds MuJoCo (Apache-2.0; chosen over Pinocchio for contact, closed loops through equality constraints and native MJCF, while Pinocchio's analytic derivatives would go unused by Part 3's finite differences). Inside the subsystem:

- each joint is a node with angle, speed and servo current states, whose parameters (axis, frame, limits, servo gains) the provider reads;
- each named frame is a node with pose and force states;
- each solid is a node with pose and velocity states, so poses and contact forces are result signals like any other.

The canvas shows the solids, joints and frames; the engine sees one coupled task.

The provider's substeps (around 1 ms) are also where fast loops belong, since explicit Euler at the engine step cannot hold them. A joint in **servo mode** (a smart servo with its own position loop, such as the Feetech STS3215) runs that loop inside the provider at every substep: the graph sends setpoints at the engine step and reads back the current the servo draws, for the battery and thermal models. A joint in **torque mode** takes its torque from a motor in the graph, whose current the toolbox makes quasi-static (`setsValue`) by default so the engine step need not resolve the motor's L/R. So a group provider must be able to keep internal state that is not a node state (a servo's integrator) and include it in its checkpoint.

Groups must be packaged in plugins (`kind: "groupProvider"` in `plugin.json`), C++ in process first, as the robotics toolbox will ship its provider that way. The validator checks that no state of a group is also written by an ordinary relationship from outside it, unless the provider declares that state as an input.

Open points: whether the partitioned backend keeps a group in one partition (it should, simply); how a group appears in code export and FMU export (perhaps as an FMU-like call, or not exported at first); whether vectors in provider ports are needed for performance (a 7-joint arm has around 100 scalars); how a plugin links a third-party C library such as MuJoCo on every platform; and whether validation should warn when a relationship's time constant (a motor's L/R, say) is close to or below the engine step, which belongs with the numerical stability diagnostics proposal.

### Who else gains

Anything with stiff or algebraic coupling: hydraulic networks, electrical circuits solved as a whole, a logistics routing step solved per day rather than per edge.

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
2. Part 2, group providers (robotics milestone A, MuJoCo fed by MJCF and URDF import, can start as an inline computational-node provider on one mechanism node while this is built).
3. Part 3, design objectives (robotics milestone E).
4. Part 1, reading the model.
