<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Two-Room Building

## Overview

Two thermal zones, each losing heat through its own envelope to cold outdoor air, exchange heat with each other through an internal partition — the only example in this set with more than two thermal nodes, and a look at how a partition can be modelled as two ordinary directed edges instead of one bidirectional edge.

## Model structure

- **Living room:** air temperature, starting at 295.15 K
- **Bedroom:** air temperature, starting at 290.15 K
- **Outdoor air:** a fixed 278.15 K temperature boundary
- **Living room envelope loss / Bedroom envelope loss:** independent outdoor-to-zone relationships, each with its own envelope conductance and thermal capacitance
- **Heat transfer to living room / Heat transfer to bedroom:** the partition, authored as two separate directed edges rather than one bidirectional edge

## Equations

### The governing equations

Each zone loses heat through its own envelope to outdoor air, and exchanges heat with the other zone through the shared partition:

$$C_i\dot{T}_i=U_{env,i}(T_o-T_i)+U_p(T_j-T_i)$$

### As edge and source-term contributions

Every relationship here needs a state from another node, so there's no source term anywhere in this model — four edges, one per governing-equation term:

$$\dot{T}_{living} = \frac{U_{env,living}(T_o-T_{living})}{C_{living}} \quad\text{— \textbf{Living room envelope loss}, Outdoor air → Living room}$$

$$\dot{T}_{bed} = \frac{U_{env,bed}(T_o-T_{bed})}{C_{bed}} \quad\text{— \textbf{Bedroom envelope loss}, Outdoor air → Bedroom}$$

$$\dot{T}_{living} = \frac{U_p(T_{bed}-T_{living})}{C_{living}} \quad\text{— \textbf{Heat transfer to living room}, Bedroom → Living room}$$

$$\dot{T}_{bed} = \frac{U_p(T_{living}-T_{bed})}{C_{bed}} \quad\text{— \textbf{Heat transfer to bedroom}, Living room → Bedroom}$$

Unlike Thermal Equilibrium's single bidirectional Conduction edge, the partition here is two separate directed edges sharing the same partition conductance (80 W/K) but each carrying its own zone thermal capacitance — the same trade-off Battery Powered Joint's Ambient air runs into with multiple incoming conduction edges, just authored by hand twice here instead of relying on the bidirectional feature once. Each zone's temperature receives two separate contributions (its own envelope loss and its own side of the partition transfer) that sum.

**States**:

- $T_o$ (`sourceTemperature` in both envelope-loss edges) — Outdoor air's own temperature
- $T_{living}$ (`targetTemperature` in Living room envelope loss and Heat transfer to living room; `sourceTemperature` in Heat transfer to bedroom) — Living room's own temperature
- $T_{bed}$ (`targetTemperature` in Bedroom envelope loss and Heat transfer to bedroom; `sourceTemperature` in Heat transfer to living room) — Bedroom's own temperature

**Parameters**:

- $U_{env,living}$ (`envelopeConductance`), $C_{living}$ (`zoneThermalCapacitance`) — Living room envelope loss
- $U_{env,bed}$ (a separate `envelopeConductance` instance), $C_{bed}$ (a separate `zoneThermalCapacitance` instance) — Bedroom envelope loss
- $U_p$ (`partitionConductance`), $C_{living}$ (a separate instance, matching Living room envelope loss's own value) — Heat transfer to living room
- $U_p$ (a separate instance, numerically equal), $C_{bed}$ (a separate instance, matching Bedroom envelope loss's own value) — Heat transfer to bedroom

## Expected behaviour

Both rooms cool toward outdoor air while also approaching each other through the partition. The living room starts warmer (295.15 K vs. 290.15 K) and stays warmer throughout the one-hour reference run, reaching 287.52 K against the bedroom's 286.51 K by the end.

## Simplifications

Each zone is a single thermal mass. Solar gains, occupancy, infiltration and HVAC equipment are omitted.
