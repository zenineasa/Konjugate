<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Battery Thermal Management

## Overview

A battery module generates heat through electrical losses and exchanges heat by convection with a finite enclosed-air volume.

## Model structure

- **Battery module:** temperature and state of charge
- **Enclosed air:** air temperature
- **Electrical losses:** prescribed heat flow
- **Air convection gain / Battery convection loss:** complementary energy-transfer relationships

## Equations

### The governing equations

Newton's law of cooling for convective heat transfer between the battery and the enclosed air:

$$Q_{conv} = hA(T_b-T_a)$$

Energy balance for each body — heat in minus heat out, divided by thermal capacitance:

$$C_b\dot{T}_b = Q_{loss} - Q_{conv} \qquad C_a\dot{T}_a = Q_{conv}$$

### As edge and source-term contributions

This example predates the component library's *bidirectional* edge feature (used elsewhere in this set, e.g. Battery Powered Joint's Conduction), so the same convective law is authored twice by hand instead — once per direction, each free to use its own thermal capacitance rather than being forced to share one:

$$\dot{T}_a = \frac{hA(T_b-T_a)}{C_a} \quad\text{— \textbf{Air convection gain}, Battery module → Enclosed air}$$

$$\dot{T}_b = \frac{hA(T_a-T_b)}{C_b} \quad\text{— \textbf{Battery convection loss}, Enclosed air → Battery module}$$

$$\dot{T}_b = \frac{Q_{loss}}{C_b} \quad\text{— \textbf{Heat source}, Electrical losses → Battery module}$$

Battery module's temperature receives two separate contributions (Battery convection loss and Heat source) that sum, the same additive rule every other example in this set relies on.

**States**:

- $T_b$ (`sourceTemperature` in Air convection gain; `targetTemperature` in Battery convection loss and Heat source) — Battery module's own temperature
- $T_a$ (`targetTemperature` in Air convection gain; `sourceTemperature` in Battery convection loss) — Enclosed air's own temperature
- $Q_{loss}$ (`sourceQDot`) — Electrical losses' own state, read by Heat source

**Parameters**:

- $h$ (`heatTransferCoefficient`), $A$ (`surfaceArea`), $C_a$ (`airThermalCapacitance`) — Air convection gain
- $h$, $A$ (separate instances, numerically equal here but not linked), $C_b$ (`batteryThermalCapacitance`) — Battery convection loss
- $C_b$ (`heatCapacity`, a separate parameter instance from Battery convection loss's own — numerically equal here, but nothing keeps them in sync automatically) — Heat source

## Expected behaviour

The initially hot battery cools, the enclosed air warms and their combined energy increases only by the electrical-loss input. The numerical regression runs for 1 s with a 0.01 s global timestep.

## Simplifications

Temperatures are spatially uniform, material properties are constant and radiation and conduction through structural supports are omitted.
