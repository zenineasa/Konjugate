<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Heated Water Tank

## Overview

A 100 kg lumped water volume is heated by a constant 2 kW electric heater while losing heat to ambient air.

## Model structure

- **Water tank:** water temperature
- **Electric heater:** prescribed heat flow
- **Ambient air:** fixed temperature boundary
- **Heater input / Ambient heat loss:** independent thermal relationships

## Equation

$$\dot{T}=\frac{Q_{heater}+UA(T_{ambient}-T)}{C_{water}}$$

## Expected behaviour

Water temperature rises monotonically toward the steady temperature set by heater power and ambient loss. The reference run covers one hour with a 1 s timestep.

## Simplifications

The tank is perfectly mixed and water mass, heat capacity and the overall heat-loss coefficient remain constant.
