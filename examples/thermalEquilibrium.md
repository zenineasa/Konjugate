<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Thermal Equilibrium

## Overview

Two isolated thermal masses at different temperatures, connected by a single bidirectional conductive relationship — the simplest possible demonstration of Konjugate's bidirectional edge feature: one equation, evaluated once, applies equal and opposite contributions to both connected nodes. Battery Powered Joint uses the same feature twice over, each instance layered alongside other contributions to its node; this is the model to check first when the underlying conduction law itself is in question.

## Model structure

- **Hot body:** temperature, starting at 350 K
- **Cold body:** temperature, starting at 290 K
- **Conduction:** the single bidirectional relationship connecting them — the only heat path in this model

## Equations

### The governing equations

Newton's law of cooling for conduction between the two bodies, with equal and opposite effects on each:

$$Q=k(T_{hot}-T_{cold}) \qquad \dot{T}_{hot}=-\frac{Q}{C} \qquad \dot{T}_{cold}=\frac{Q}{C}$$

### As edge and source-term contributions

This is the only relationship in the model, and it's necessarily an edge — a bidirectional one, so it's authored and evaluated once rather than as two independent directed edges:

$$\dot{T}_{hot}, \dot{T}_{cold} = \mp\frac{k(T_{hot}-T_{cold})}{C} \quad\text{— \textbf{Conduction} (bidirectional), Hot body ↔ Cold body}$$

Neither body's temperature receives a second contribution from anywhere else — the cleanest possible illustration of the bidirectional edge, with nothing else to sum against.

**States**:

- $T_{hot}$ (`sourceTemperature`) — Hot body's own temperature
- $T_{cold}$ (`targetTemperature`) — Cold body's own temperature

**Parameters**:

- $k$ (`conductance`), $C$ (`thermalCapacitance`) — Conduction, one shared parameter set for both directions, since a bidirectional edge has only one equation rather than two

## Expected behaviour

The temperature difference decays exponentially toward zero while the two bodies' combined temperature stays constant, since they share the same thermal capacitance: heat lost by the hot body exactly equals heat gained by the cold one. By the end of the 60 s reference run (0.01 s global timestep) the two temperatures sit within a fraction of a kelvin of their shared equilibrium value — 320.07 K and 319.93 K, either side of 320 K, the average of the two starting temperatures.

## Simplifications

Both bodies share the same thermal capacitance, so the equilibrium temperature is a simple average; conduction is instantaneous and linear in the temperature difference, and no other heat paths (radiation, environment) are modelled.
