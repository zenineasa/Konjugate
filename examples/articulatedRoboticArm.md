<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Articulated Robotic Arm

## Overview

Three independently actuated joints — Shoulder, Elbow, Wrist — chained together the same way Two Link Arm chains two, each built from the same Motor/Rotational link/Armature dynamics/Rotational drive template pattern. Where Two Link Arm's point was that the pattern composes at all, this example's point is what happens once it's composed three deep with a physically sensible taper: voltage drops down the chain (24 V, 18 V, 12 V) the way a real arm's outer joints usually carry less powerful actuators, and moment of inertia drops even faster (0.02, 0.01, 0.005 kg·m²) the way a real arm's outer links are lighter than what carries them. The two tapers don't cancel — the lighter, less powerful Wrist ends up accelerating *fastest* of the three, not slowest.

## Model structure

- **Shoulder supply → Shoulder motor → Shoulder link:** 24 V, moment of inertia 0.02 kg·m²
- **Elbow supply → Elbow motor → Elbow link:** 18 V, moment of inertia 0.01 kg·m²
- **Wrist supply → Wrist motor → Wrist link:** 12 V, moment of inertia 0.005 kg·m²

All three joints share the same armature resistance, inductance, back-EMF constant and torque constant — only supply voltage and moment of inertia vary — so the taper described above is the only thing distinguishing one joint's behavior from another's. As in Two Link Arm, each link is a **Rotational link** (its own angle and angular velocity, with the self-referencing source term that integrates one into the other) driven by **Rotational drive**, not a fixed Torque load — the point is each joint's own moving angle, not a known disturbance.

## Equations

### The governing equations

Kirchhoff's voltage law for each joint's armature circuit:

$$V = L\dot{i} + Ri + k_e\omega_{motor}$$

Newton's second law for each link, driven directly with no separate friction or load term:

$$J\dot{\omega}_{link} = k_t i$$

Each link's own kinematic relation — angle is the integral of its own angular velocity:

$$\dot{\theta} = \omega_{link}$$

### As edge and source-term contributions

$$\dot{i}=\frac{V-Ri-k_e\omega_{motor}}{L} \quad\text{— \textbf{Armature dynamics}, Joint supply → Joint motor}$$

$$\dot{\omega}_{link}=\frac{k_t i}{J} \quad\text{— \textbf{Rotational drive}, Joint motor → Joint link}$$

$$\dot{\theta}=\omega_{link} \quad\text{— self-referencing source term on Joint link (needs only the link's own state, no edge)}$$

**States** (per joint):

- $V$ (`sourceVoltage`) — Joint supply's own voltage, read by Armature dynamics
- $i$ (`targetCurrent` in Armature dynamics, `sourceCurrent` in Rotational drive) — Motor's own current, read by *both* edges under different bound names, since Motor is the target of one and the source of the other
- $\omega_{motor}$ (`targetAngularVelocity`) — Motor's own angular velocity, read by Armature dynamics for back-EMF — but as the Expected behaviour below explains, nothing in this model ever writes to it
- $\omega_{link}$ — Joint link's own angular velocity: the output of Rotational drive, and read directly (no role prefix, since it's a source term) by the link's own kinematic source term

**Parameters** (shared across all three joints):

- $R$ (`resistance`) = 2 Ω, $L$ (`inductance`) = 0.5 H, $k_e$ (`backEmfConstant`) = 0.1 V·s/rad — Armature dynamics
- $k_t$ (`torqueConstant`) = 0.1 N·m/A — Rotational drive; $J$ (`momentOfInertia`) varies per joint (see Model structure)

## Expected behaviour

Exactly as in Two Link Arm, Rotational drive writes angular velocity onto the *link*, never onto the motor's own `angularVelocity` state — so the back-EMF term in Armature dynamics stays at zero for the entire run, and current on every joint settles cleanly at $V/R$ rather than a back-EMF-limited value: **12 A** (Shoulder), **9 A** (Elbow), **6 A** (Wrist), confirmed by running the model. With current settled and nothing opposing it, each link undergoes constant angular acceleration $k_t i/J$ indefinitely — also confirmed by running the model, reading the angular velocity slope once current has settled: **60 rad/s²** (Shoulder), **90 rad/s²** (Elbow), **120 rad/s²** (Wrist).

That ordering is the reason this example exists. Voltage and current both fall monotonically down the chain — Wrist draws the least current of the three, at exactly half Shoulder's — so Wrist also produces the least torque ($k_t i$: 1.2 N·m for Shoulder down to 0.6 N·m for Wrist, again exactly half). If moment of inertia were shared across joints the way every other parameter is, torque alone would decide the ordering and Wrist would accelerate slowest. It doesn't, because moment of inertia falls *faster* than torque does — a quarter of Shoulder's by Wrist, against torque's mere half — so the smaller denominator wins and Wrist ends up with the highest angular acceleration of the three. The same two-taper structure would apply to any real cascaded-joint arm: whichever falls faster down the chain, drive strength or carried mass, decides which end moves quickest, and it isn't always the end you'd guess from voltage alone.

## Simplifications

Exactly as in Two Link Arm: the three joints are fully decoupled (this models three independent actuators, not a real arm's coupled dynamics, where an outer link's own weight and orientation would load every joint upstream of it — building that coupling would need genuine multi-body dynamics beyond what a template pattern can express), and each joint keeps its motor's own `angularVelocity` and its link's `angularVelocity` as two separate, unconnected states, so back-EMF never actually opposes motion here. Grouping each joint's three nodes into a subsystem is a reasonable way to keep three of them visually organized as you build on this — more so than with two, since the cascade reads less immediately as "one arm" without it.
