<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Two Link Arm

## Overview

Two independently actuated joints, each a motor driving its own rotating link, built by applying the same Motor/Rotational link/Armature dynamics/Rotational drive templates twice. The point isn't new physics — it's proving those templates compose: the exact same four-template pattern that builds one joint builds a second one just as easily, with no extra authoring beyond choosing values.

## Model structure

- **Joint 1 supply → Joint 1 motor → Joint 1 link:** a 24 V supply driving the first joint
- **Joint 2 supply → Joint 2 motor → Joint 2 link:** a 12 V supply driving the second, at half the drive voltage so the two joints visibly swing at different rates
- Unlike Single Joint Actuator, each link here is a **Rotational link** (its own angle and angular velocity, with the self-referencing source term that integrates one into the other), not a fixed Torque load — because the point is to track each joint's own moving angle, not fight a known disturbance. That's what **Rotational drive** is for: connecting a motor directly to a link's inertia, rather than **Shaft dynamics**, which the Single Joint Actuator example uses instead.

## Equations

### The governing equations

Kirchhoff's voltage law for the armature circuit:

$$V = L\dot{i} + Ri + k_e\omega_{motor}$$

Newton's second law for the link, driven directly with no separate friction or load term:

$$J\dot{\omega}_{link} = k_t i$$

The link's own kinematic relation — angle is the integral of its own angular velocity:

$$\dot{\theta} = \omega_{link}$$

### As edge and source-term contributions

$$\dot{i}=\frac{V-Ri-k_e\omega_{motor}}{L} \quad\text{— \textbf{Armature dynamics}, Joint supply → Joint motor}$$

$$\dot{\omega}_{link}=\frac{k_t i}{J} \quad\text{— \textbf{Rotational drive}, Joint motor → Joint link}$$

$$\dot{\theta}=\omega_{link} \quad\text{— self-referencing source term on Joint link (needs only the link's own state, no edge)}$$

**States**:

- $V$ (`sourceVoltage`) — Joint supply's own voltage, read by Armature dynamics
- $i$ (`targetCurrent` in Armature dynamics, `sourceCurrent` in Rotational drive) — Motor's own current, read by *both* edges under different bound names, since Motor is the target of one and the source of the other
- $\omega_{motor}$ (`targetAngularVelocity`) — Motor's own angular velocity, read by Armature dynamics for back-EMF — but as the Expected behaviour below explains, nothing in this model ever writes to it
- $\omega_{link}$ — Joint link's own angular velocity: the output of Rotational drive, and read directly (no role prefix, since it's a source term) by the link's own kinematic source term

**Parameters**:

- $R$ (`resistance`), $L$ (`inductance`), $k_e$ (`backEmfConstant`) — Armature dynamics
- $k_t$ (`torqueConstant`), $J$ (`momentOfInertia`) — Rotational drive

## Expected behaviour

Current rises quickly and settles at $V/R$ — 12 A for Joint 1, 6 A for Joint 2 — rather than a back-EMF-limited value. That's because Rotational drive writes angular velocity onto the *link*, not onto the motor's own `angularVelocity` state, so the back-EMF term in Armature dynamics (which reads the motor's own angular velocity) never sees any motion: it stays at exactly zero for the entire run. With current settled and nothing opposing it, the link doesn't converge to a steady angular velocity either — it undergoes constant angular acceleration ($k_t i/J$: 120 rad/s² for Joint 1, 60 rad/s² for Joint 2) indefinitely, so its angle grows without bound. Both effects trace back to the same cause: Rotational drive is deliberately a motor → link relationship with no path back to the motor's own speed state.

## Simplifications

The two joints are fully decoupled — this models two independent actuators, not a real two-link arm's coupled dynamics, where the second link's own inertia and orientation would load the first joint's motor. Building that coupling would need genuine multi-body dynamics (shared inertia terms, gravity-dependent loading) beyond what a template pair can express; grouping each joint's three nodes into a subsystem is a reasonable way to keep the two visually organized as you build on this.

The motor/link state split described above is itself a simplification worth naming directly: a real direct-drive joint has one physical rotating mass, but this model keeps the motor's own `angularVelocity` and the link's `angularVelocity` as two separate states with no equation tying them together. That's fine here, since nothing in this example needs the motor's own speed for anything — but it's exactly the kind of gap Position Controlled Joint had to fix (with an explicit rate-feedback term) once a closed loop made that missing coupling matter for stability, not just accuracy.
