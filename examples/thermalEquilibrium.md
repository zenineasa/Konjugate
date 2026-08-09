<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Thermal Equilibrium

## Overview

Two isolated thermal masses at different temperatures are connected by a single conductive relationship. This example exists to demonstrate a genuinely bidirectional edge: one equation, evaluated once, applies equal and opposite contributions to both connected nodes — heat leaving the hot body is exactly the heat entering the cold one.

## Model structure

- **Hot body:** temperature, starts at 350 K
- **Cold body:** temperature, starts at 290 K
- **Conduction:** a single bidirectional relationship connecting them, with no other heat paths

## Equations

$$Q=k(T_{hot}-T_{cold})$$
$$\dot{T}_{hot}=-\frac{Q}{C}$$
$$\dot{T}_{cold}=\frac{Q}{C}$$

## Expected behaviour

The temperature difference decays exponentially toward zero while both bodies' combined temperature stays constant, since they share the same thermal capacitance: heat lost by the hot body exactly equals heat gained by the cold one. By the end of the numerical regression run (60 s, 0.01 s global timestep) the two temperatures sit within a fraction of a kelvin of their shared equilibrium value, 320 K — the average of the two starting temperatures.

## Simplifications

Both bodies share the same thermal capacitance, so the equilibrium temperature is a simple average; conduction is instantaneous and linear in the temperature difference, and no other heat paths (radiation, environment) are modelled.
