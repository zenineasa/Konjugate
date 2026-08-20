<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Heated Water Tank

## Overview

A 100 kg lumped water volume is heated by a constant 2 kW electric heater while losing heat to ambient air — the simplest possible thermal example in this set, with no bidirectional edges and no multi-node chains, just two independent contributions landing on the same state.

## Model structure

- **Water tank:** water temperature, starting at 293.15 K
- **Electric heater:** a fixed 2 kW prescribed heat flow
- **Ambient air:** a fixed 293.15 K temperature boundary
- **Heater input / Ambient heat loss:** two independent thermal relationships, both writing to the tank's own temperature

## Equations

### The governing equations

A prescribed heat injection from the heater, and Newton's law of cooling for the tank's own loss to ambient:

$$C_{water}\dot{T} = Q_{heater} - UA(T-T_{ambient})$$

### As edge and source-term contributions

Both relationships need a state from the *other* node (the heater's own heat flow, or ambient's own temperature), so neither can be a source term — each is its own edge:

$$\dot{T} = \frac{Q_{heater}}{C_{water}} \quad\text{— \textbf{Heater input}, Electric heater → Water tank}$$

$$\dot{T} = \frac{UA(T_{ambient}-T)}{C_{water}} \quad\text{— \textbf{Ambient heat loss}, Ambient air → Water tank}$$

Water tank's temperature receives two separate contributions (Heater input and Ambient heat loss) that sum, the same additive rule every other example in this set relies on.

**States**:

- $Q_{heater}$ (`sourceQDot`) — Electric heater's own state, read by Heater input
- $T$ (`targetTemperature` in both edges) — Water tank's own temperature, written by both
- $T_{ambient}$ (`sourceTemperature`) — Ambient air's own temperature, read by Ambient heat loss

**Parameters**:

- $C_{water}$ (`waterThermalCapacitance`) — Heater input
- $UA$ (`heatLossCoefficient`), $C_{water}$ (a separate `waterThermalCapacitance` instance, numerically equal here but nothing keeps them in sync automatically) — Ambient heat loss

## Expected behaviour

Water temperature rises monotonically toward the steady value set by heater power and ambient loss, reaching 309.31 K by the end of the one-hour reference run (1 s global timestep) — still climbing toward the theoretical steady state of roughly 426 K, which this run is far too short to reach.

## Simplifications

The tank is perfectly mixed, and water mass, heat capacity and the overall heat-loss coefficient remain constant.
