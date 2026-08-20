<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Spring–Mass–Damper

## Overview

A mass displaced 0.1 m from equilibrium is attached to a fixed support through parallel spring and damper relationships — the canonical mechanical oscillator, and the only example in this set where a source term and edges cooperate on the same node: the mass's own kinematics needs nothing from outside, but the forces acting on it both do.

## Model structure

- **Suspended mass:** displacement and velocity, starting displaced 0.1 m at rest
- **Fixed support:** a zero-displacement, zero-velocity boundary
- **Spring force:** the restoring force, from the support's own (fixed) displacement
- **Damper force:** the viscous dissipative force, from the support's own (fixed) velocity
- **Kinematic source term:** the mass's own displacement rate, computed from its own velocity

## Equations

### The governing equations

Newton's second law for the mass — spring and damper forces, referenced to the fixed support, accelerate it — alongside the ordinary kinematic relationship between velocity and displacement:

$$\dot{x}=v \qquad m\dot{v} = k(x_s-x) + c(v_s-v)$$

### As edge and source-term contributions

Displacement's rate depends only on velocity, a state already on the same node, so that's a source term. Both forces need the support's own displacement or velocity as well, so each must be an edge instead:

$$\dot{x} = v \quad\text{— \textbf{Kinematic source term}, Suspended mass's own velocity}$$

$$\dot{v} = \frac{k(x_s-x)}{m} \quad\text{— \textbf{Spring force}, Fixed support → Suspended mass}$$

$$\dot{v} = \frac{c(v_s-v)}{m} \quad\text{— \textbf{Damper force}, Fixed support → Suspended mass}$$

Suspended mass's velocity receives two separate contributions (Spring force and Damper force) that sum, the same additive rule every other example in this set relies on — displacement, in contrast, is written only by the source term, so no summing is involved there.

**States**:

- $x$ (`displacement`, read directly — a source term has no source/target prefix, since it only ever reads its own node) — Suspended mass's own displacement, written by Kinematic source term
- $v$ (`velocity`, read directly by the source term; `targetVelocity` in both edges) — Suspended mass's own velocity, written by Spring force and Damper force
- $x_s$ (`sourceDisplacement`) — Fixed support's own (fixed) displacement, read by Spring force
- $v_s$ (`sourceVelocity`) — Fixed support's own (fixed) velocity, read by Damper force

**Parameters**:

- $k$ (`stiffness`), $m$ (`mass`) — Spring force
- $c$ (`dampingCoefficient`), $m$ (a separate `mass` instance, numerically equal here but nothing keeps them in sync automatically) — Damper force

## Expected behaviour

The mass oscillates about the fixed support while the damper dissipates mechanical energy — kinetic plus spring potential energy strictly decreases over the run. Four local substeps are used per global timestep. Displacement decays from its initial 0.1 m, through -0.034 m at 5 s, to 0.008 m by 10 s in the reference run — still oscillating and shrinking toward zero.

## Simplifications

The spring is linear, damping is viscous, and motion is restricted to one dimension.
