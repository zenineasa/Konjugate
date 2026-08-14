<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Four Bar Linkage

## Overview

Four points in 3-D space, two of them fixed, one driven by a live-speed crank, and one whose motion is entirely emergent — held at fixed distances from its two neighbors by nothing but stiff spring-dampers approximating rigid rods. This is the largest, most mechanically involved example in the set: it has no constraint solver to lean on (Konjugate doesn't have one), so it demonstrates the standard technique real-time physics engines use in its absence — penalty-based rigid-rod approximation — while reusing exactly one node template (Free body) in three different roles purely by choice of wiring.

## Model structure

All four nodes are the same **Free body** template (full 6-DOF pose plus linear velocity), used differently:

- **Ground pivot A, Ground pivot D:** nothing is connected to drive them, so they simply stay at their initial position — the degenerate case of "kinematically prescribed."
- **Crank pin B:** driven kinematically by **Crank drive X/Y**, a live-speed circular motion about pivot A (2 rad/s by default) using the identity $\dot{x}=-\omega(y-y_0)$, $\dot{y}=\omega(x-x_0)$ — no separate angle state needed, and the radius is whatever the initial A–B distance happens to be, not a set parameter.
- **Coupler-rocker pin C:** driven by **Rod X/Y** applied twice — once holding it 3 m from B (the coupler), once holding it 2.5 m from D (the rocker) — a standard Grashof crank-rocker geometry with ground link A–D = 3 m and crank A–B = 1 m.

Every rod pulls only the end genuinely free to move: since B's motion is already fully determined by the crank drive and D never moves, both rod pairs are applied single-direction (correcting only C), not the mirrored pair you'd use between two equally free bodies.

## Equations

### The governing equations

A rigid rod holds two points at a fixed distance — the constraint a real constraint solver would enforce directly, and the thing Rod X/Rod Y only *approximate*:

$$|P_t - P_s| = L_0$$

Approximated as a stiff spring-damper along the rod's axis instead — Hooke's law plus linear damping, combined through Newton's second law:

$$m\dot{\vec{v}} = k(L_0-d)\hat{u} - c(\vec{v}_t-\vec{v}_s), \qquad d = |P_t-P_s|, \quad \hat{u} = \frac{P_t-P_s}{d}$$

Uniform circular motion about a fixed center, the standard parametric form:

$$x(t) = x_A + r\cos(\omega t+\phi), \qquad y(t) = y_A + r\sin(\omega t+\phi)$$

### As edge and source-term contributions

Differentiating the circular-motion equations directly gives Crank drive's rate form — no separate angle state needed, since $r\cos(\omega t+\phi)=x-x_A$ and $r\sin(\omega t+\phi)=y-y_A$ substitute straight back in:

$$\dot{x}_B=-\omega(y_B-y_A) \quad\text{— \textbf{Crank drive X}, Ground pivot A → Crank pin B}$$

$$\dot{y}_B=\omega(x_B-x_A) \quad\text{— \textbf{Crank drive Y}, Ground pivot A → Crank pin B}$$

Taking the X component of the rod's spring-damper equation (Rod Y is identical with X and Y swapped) gives the rate form each Rod edge computes:

$$\dot{v}_x=\frac{k(L_0-d)(x_t-x_s)}{dm}-\frac{c(v_{x,t}-v_{x,s})}{m} \quad\text{— \textbf{Rod X}, applied twice: Crank pin B → Coupler-rocker pin C (coupler), Ground pivot D → Coupler-rocker pin C (rocker)}$$

The position and velocity states themselves are integrated by each Free body's own self-referencing source terms ($\dot{x}=v_x$, $\dot{y}=v_y$, $\dot{z}=v_z$) — not edges, since they only ever need the node's own states.

**States** — every Rod edge needs the full position (and, for damping, velocity) of both its endpoints; every Crank drive edge needs both pivot points' positions:

- $x,y,z$ on both endpoints of a Rod edge (`sourceX/Y/Z`, `targetX/Y/Z`) — used together to compute the distance $d$ and direction $\hat{u}$
- $v_x$ (or $v_y$, for Rod Y) on both endpoints (`sourceVx`/`targetVx`) — used for the damping term; the *other* axis's velocity isn't read, since damping here is per-axis, not strictly along the rod (see Rod X's own template description)
- $x,y$ on both the pivot and the crank pin (`sourceX/Y`, `targetX/Y`) — Crank drive reads both to compute the pin's position relative to the pivot, and writes back into the pin's own $x$ or $y$

**Parameters**:

- $L_0$ (`restLength`), $k$ (`stiffness`), $c$ (`damping`), $m$ (`mass`) — every Rod X/Rod Y edge (four separate instances here: coupler X, coupler Y, rocker X, rocker Y)
- $\omega$ (`angularVelocity`, live) — every Crank drive edge (two separate instances, X and Y, kept in sync manually — this app has no shared/linked parameters across edges)

## Expected behaviour

Pin B traces a circle of radius 1 m around A at the commanded angular rate. Pin C follows the classic four-bar coupler curve, oscillating back and forth as B rotates continuously — the defining behavior of a crank-rocker linkage, where a fully rotating crank drives a rocking (not fully rotating) output. With the shipped rod stiffness and damping, both rod lengths stay within roughly 2–3% of their nominal 3 m and 2.5 m throughout a full crank revolution — a real, visible tracking error from the penalty approximation, not zero, but bounded and periodic rather than drifting or diverging.

## Simplifications

Distance is held by a stiff spring-damper, not an exact constraint — see "Expected behaviour" for the resulting tolerance. Damping is applied per-axis rather than strictly along each rod's instantaneous direction, which doesn't change the settled shape, only how directly it's damped. Orientation states (roll, pitch, yaw) exist on every node but are never driven here, since a rod constrains distance, not relative orientation; a rod that also resisted rotation (a rigid weld rather than a ball-jointed strut) would need real torque coupling between the two bodies, a genuinely bigger step than this example takes. There is currently no visualizer that would show these positions moving in 3-D — the state dashboard shows the numbers evolving, which is enough to confirm the linkage is doing the right thing, but seeing it move is a natural next tool to build.

This example's stiff rods also need a much smaller timestep than the rest of this set to stay numerically stable — its own run configuration uses 0.002 s rather than the usual 0.01 s default; if you copy its edges into a model with the default timestep, expect the rods to blow up rather than settle.
