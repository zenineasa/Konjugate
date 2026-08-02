<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Spring–Mass–Damper

## Overview

A displaced mass is attached to a fixed support through a spring and viscous damper. The two mechanisms are represented as separate parallel relationships.

## Model structure

- **Suspended mass:** displacement and velocity
- **Fixed support:** zero displacement and velocity boundary
- **Spring force:** depends on relative displacement
- **Damper force:** depends on relative velocity
- **Kinematic source term:** converts velocity into displacement rate

## Equations

$$\dot{x}=v$$
$$\dot{v}=\frac{k(x_s-x)}{m}+\frac{c(v_s-v)}{m}$$

The example uses `m = 1 kg`, `k = 4 N/m` and `c = 0.4 N·s/m`.

## Expected behaviour

The mass oscillates about the fixed support while the damper dissipates mechanical energy. Four local substeps are used per global timestep.

## Simplifications

The spring is linear, damping is viscous and motion is restricted to one dimension.
