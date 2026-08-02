<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# DC Motor

## Overview

A permanent-magnet DC motor is driven by a fixed voltage source while acting against a constant mechanical load.

## Model structure

- **DC motor:** armature current and angular velocity
- **DC supply:** prescribed voltage
- **Mechanical load:** prescribed load torque
- **Armature dynamics / Shaft dynamics:** coupled electrical and mechanical equations

## Equations

$$\dot{i}=\frac{V-Ri-k_e\omega}{L}$$
$$\dot{\omega}=\frac{k_ti-b\omega-\tau_L}{J}$$

## Expected behaviour

Current rises rapidly, produces torque and accelerates the shaft. Back EMF then reduces current as the motor approaches approximately 9.8 A and 44 rad/s.

## Simplifications

Magnetic saturation, switching electronics, shaft compliance and temperature dependence are omitted.
