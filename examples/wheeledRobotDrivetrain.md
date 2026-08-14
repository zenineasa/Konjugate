<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Wheeled Robot Drivetrain

## Overview

A single driven wheel converting a motor's rotation into a chassis's straight-line motion — the rotational-to-translational conversion at the heart of a wheeled robot's drivetrain. Motion is confined to one axis; there's no heading or steering state, since the point is the conversion itself, not full 2-D navigation.

## Model structure

- **Drive supply:** a fixed 24 V voltage source
- **Drive motor:** armature current and angular velocity
- **Bearing friction:** a small (0.02 N·m) fixed resisting torque, standing in for bearing and gearbox losses
- **Chassis:** position and velocity along a single axis, with the self-referencing source term that integrates one into the other
- **Traction:** converts the motor's current into chassis acceleration via the wheel radius — the new template this example introduces

Unlike Two Link Arm, this uses **Shaft dynamics** (against Bearing friction), not Rotational drive — so the motor's own angular velocity is genuinely driven here, and back-EMF properly engages.

## Equations

### The governing equations

Kirchhoff's voltage law for the armature circuit:

$$V = L\dot{i} + Ri + k_e\omega$$

Newton's second law for the rotor:

$$J\dot{\omega} = k_t i - b\omega - \tau_{bearing}$$

Newton's second law for the chassis — traction force (motor torque divided by wheel radius) accelerates its mass, with nothing opposing it:

$$m\dot{v} = \frac{k_t i}{r}$$

The chassis's own kinematic relation:

$$\dot{x} = v$$

### As edge and source-term contributions

$$\dot{i}=\frac{V-Ri-k_e\omega}{L} \quad\text{— \textbf{Armature dynamics}, Drive supply → Drive motor}$$

$$\dot{\omega}=\frac{k_t i-b\omega-\tau_{bearing}}{J} \quad\text{— \textbf{Shaft dynamics}, Bearing friction → Drive motor}$$

$$\dot{v}=\frac{k_t i}{rm} \quad\text{— \textbf{Traction}, Drive motor → Chassis}$$

$$\dot{x}=v \quad\text{— self-referencing source term on Chassis (needs only its own state, no edge)}$$

**States**:

- $V$ (`sourceVoltage`) — Drive supply's own voltage, read by Armature dynamics
- $i$ (`targetCurrent` in Armature dynamics and Shaft dynamics; `sourceCurrent` in Traction) — Drive motor's own current, read by all three edges under different bound names depending on which role Motor plays in each
- $\omega$ (`targetAngularVelocity`) — Drive motor's own angular velocity, read (for back-EMF) and written (by Shaft dynamics) — properly driven here, unlike Two Link Arm's Rotational drive pairing
- $\tau_{bearing}$ (`sourceTorque`) — Bearing friction's own state, read by Shaft dynamics
- $v$ — Chassis's own velocity: the output of Traction, and read directly by the chassis's own kinematic source term

**Parameters**:

- $R$ (`resistance`), $L$ (`inductance`), $k_e$ (`backEmfConstant`) — Armature dynamics
- $k_t$ (`torqueConstant`), $b$ (`viscousFriction`), $J$ (`rotorInertia`) — Shaft dynamics
- $k_t$ (a separate `torqueConstant` instance), $r$ (`wheelRadius`), $m$ (`chassisMass`) — Traction

## Expected behaviour

Current and angular velocity rise the same way as Single Joint Actuator's, settling to a steady nonzero current once motor torque balances bearing friction. Because Traction feeds that settled current straight into chassis acceleration with nothing opposing it, the chassis doesn't coast to a terminal velocity — it accelerates at a roughly constant rate indefinitely, once current has settled.

## Simplifications

Traction reads the motor's current directly with no wheel-slip, rolling-resistance or chassis-inertia reaction back onto the motor's own shaft. That absence is exactly why the chassis never reaches a terminal velocity here — a real drivetrain would need at least a speed-dependent resistance term (aerodynamic drag, rolling resistance) to balance the steady traction force and produce one.
