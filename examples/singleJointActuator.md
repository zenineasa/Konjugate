<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Single Joint Actuator

## Overview

A DC motor driving a single revolute joint against a fixed external load — the foundational electromechanical building block every other robotics example in this set is assembled from. It's built entirely from three component-library templates (Voltage source, Motor, Torque load) connected by two more (Armature dynamics, Shaft dynamics), so it also doubles as the simplest possible demonstration of the library: nothing here was hand-authored beyond picking values.

## Model structure

- **DC supply:** a fixed 24 V voltage source
- **Motor:** armature current and angular velocity states, starting at rest
- **Load torque:** a fixed 0.1 N·m external resisting torque (bearing friction, a held payload, gravity on an arm — whatever the application calls for)
- **Armature dynamics:** the electrical relationship, from the supply to the motor
- **Shaft dynamics:** the mechanical relationship, from the load to the motor's own rotor

## Equations

### The governing equations

Kirchhoff's voltage law for the armature circuit — the supply voltage is spent across resistive drop, back-EMF and the inductor:

$$V = L\dot{i} + Ri + k_e\omega$$

Newton's second law for the rotor — net torque (motor torque minus viscous friction minus the load) accelerates its inertia:

$$J\dot{\omega} = k_t i - b\omega - \tau_{load}$$

### As edge and source-term contributions

Solving each for its own derivative gives exactly the two relationships this model uses — one edge per equation, since each needs a state from the *other* node (voltage, or load torque) as well as the motor's own. Neither is a source term: a source term can only reference states already on its own node, and both of these need one that lives elsewhere.

$$\dot{i}=\frac{V-Ri-k_e\omega}{L} \quad\text{— \textbf{Armature dynamics}, Voltage source → Motor}$$

$$\dot{\omega}=\frac{k_t i-b\omega-\tau_{load}}{J} \quad\text{— \textbf{Shaft dynamics}, Load torque → Motor}$$

**States** — read from a connected node, auto-bound by name (`sourceX`/`targetX`):

- $V$ (`sourceVoltage`) — DC supply's own voltage, read by Armature dynamics
- $i$ (`targetCurrent`) — Motor's own current, read by both edges
- $\omega$ (`targetAngularVelocity`) — Motor's own angular velocity, read by both edges
- $\tau_{load}$ (`sourceTorque`) — Load torque's own state, read by Shaft dynamics

**Parameters** — constants set directly on the edge, not read from any node:

- $R$ (`resistance`), $L$ (`inductance`), $k_e$ (`backEmfConstant`) — Armature dynamics
- $k_t$ (`torqueConstant`), $b$ (`viscousFriction`), $J$ (`rotorInertia`) — Shaft dynamics

## Expected behaviour

Current rises quickly toward its steady electrical limit while angular velocity ramps up more slowly against the rotor's own inertia, settling once the motor torque exactly balances viscous friction plus the load torque. The two states are coupled in both directions — back-EMF (the $k_e\omega$ term) feeds back into the current equation, so the motor's own speed limits how much current it draws as it spins up.

## Simplifications

The load torque is fixed rather than a function of the joint's own motion (no gravity-like $\sin(\theta)$ dependence), there's no gearbox ratio between motor and joint, and the motor's electrical and mechanical time constants are simplified, textbook-typical values rather than a specific real motor's datasheet figures.
