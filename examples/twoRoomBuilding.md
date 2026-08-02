<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Two-Room Building

## Overview

Two thermal zones exchange heat through an internal partition and independently lose heat through their envelopes to cold outdoor air.

## Model structure

- **Living room / Bedroom:** zone-air temperatures
- **Outdoor air:** fixed temperature boundary
- **Envelope losses:** separate outside-to-zone relationships
- **Partition transfer:** complementary relationships between the rooms

## Equations

$$C_i\dot{T}_i=U_{env,i}(T_o-T_i)+U_p(T_j-T_i)$$

## Expected behaviour

Both rooms cool toward outdoor temperature while also approaching one another. The warmer living room remains warmer during the one-hour reference run.

## Simplifications

Each zone is a single thermal mass. Solar gains, occupancy, infiltration and HVAC equipment are omitted.
