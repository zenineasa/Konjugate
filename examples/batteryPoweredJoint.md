<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Battery Powered Joint

## Overview

A single joint actuator, but powered by a depleting battery instead of a fixed supply, with two separate resistive-heating paths — the motor's own winding losses, and the battery's own internal resistance — each conducting away to the same ambient boundary. Thermal, electrical and mechanical behavior are coupled through one continuous chain — this is the interdisciplinary flagship of the set, tying together templates from all three domains rather than demonstrating them separately.

## Model structure

- **Battery:** voltage, state of charge and its own temperature — spans electrical and thermal, since a real battery's electrical and thermal behavior are coupled
- **Motor** and **Load torque:** the same actuator pair as Single Joint Actuator
- **Motor housing:** a thermal mass representing the motor's casing, starting at ambient temperature
- **Ambient air:** a fixed-temperature boundary
- **Resistive heating:** I²R losses from the motor's current, injected into the housing
- **Internal resistance heating:** the same Resistive heating template, applied a second time, from the motor's current into the battery's own temperature — it only needs a current-bearing source and a temperature-bearing target, which describes a battery's own internal resistance exactly as well as a motor's winding, with a much smaller resistance and a larger thermal mass reflecting a battery pack's own characteristics
- **Discharge:** depletes the battery's state of charge in proportion to current drawn
- **Housing conduction, Battery conduction:** both *bidirectional* Conduction edges into the same Ambient air node — heat leaving either body exactly equals heat entering ambient, not just approximately balanced

## Equations

### The governing equations

Kirchhoff's voltage law for the armature circuit, and Newton's second law for the rotor — the same pair as Single Joint Actuator, just with a battery in place of a fixed supply:

$$V = L\dot{i} + Ri + k_e\omega \qquad J\dot{\omega} = k_t i - b\omega - \tau_{load}$$

Battery discharge, proportional to current drawn:

$$\dot{Q}_{batt} = -\alpha i$$

I²R (Ohmic) heating — the same law applies to any current-carrying resistance, whether it's a winding or a cell's own internal resistance:

$$C\dot{T} = Ri^2$$

Newton's law of cooling for conduction between two thermal bodies:

$$\dot{T}_1, \dot{T}_2 = \mp\frac{k(T_1-T_2)}{C}$$

### As edge and source-term contributions

Every relationship in this model is an edge — none of these five nodes' states can be computed from just their own states, so there's no source term anywhere here:

$$\dot{i} = \frac{V-Ri-k_e\omega}{L} \quad\text{— \textbf{Armature dynamics}, Battery → Motor}$$

$$\dot{\omega} = \frac{k_t i - b\omega-\tau_{load}}{J} \quad\text{— \textbf{Shaft dynamics}, Load torque → Motor}$$

$$\dot{T}_{housing} = \frac{R_{winding}i^2}{C_{housing}} \quad\text{— \textbf{Resistive heating}, Motor → Motor housing}$$

$$\dot{T}_{batt} = \frac{R_{internal}i^2}{C_{batt}} \quad\text{— \textbf{Internal resistance heating}, Motor → Battery}$$

$$\dot{Q}_{batt} = -\alpha i \quad\text{— \textbf{Discharge}, Motor → Battery}$$

$$\dot{T}_{housing}, \dot{T}_{ambient} = \mp\frac{k_1(T_{housing}-T_{ambient})}{C_{housing}} \quad\text{— \textbf{Housing conduction} (bidirectional), Motor housing ↔ Ambient air}$$

$$\dot{T}_{batt}, \dot{T}_{ambient} = \mp\frac{k_2(T_{batt}-T_{ambient})}{C_{batt}} \quad\text{— \textbf{Battery conduction} (bidirectional), Battery ↔ Ambient air}$$

Motor housing's and Battery's temperatures each receive *two* separate contributions (their own heating, plus their own conduction edge), and Ambient air's receives contributions from *both* conduction edges — these sum, per Konjugate's rule that multiple relationships targeting the same state contribute additively.

**States**:

- $V$ (`sourceVoltage`) — Battery's own voltage, read by Armature dynamics
- $i$ (`targetCurrent` in Armature dynamics and Shaft dynamics; `sourceCurrent` in Resistive heating, Internal resistance heating and Discharge) — Motor's own current, read by all five current-consuming edges
- $\omega$ (`targetAngularVelocity`) — Motor's own angular velocity, read for back-EMF and written by Shaft dynamics
- $\tau_{load}$ (`sourceTorque`) — Load torque's own state, read by Shaft dynamics
- $T_{housing}$ (`targetTemperature` in Resistive heating; `sourceTemperature`/`targetTemperature` in Housing conduction, depending on role) — Motor housing's own temperature
- $T_{batt}$ (`targetTemperature` in Internal resistance heating; `sourceTemperature` in Battery conduction) — Battery's own temperature
- $Q_{batt}$ (`targetStateOfCharge`) — Battery's own state of charge, written by Discharge
- $T_{ambient}$ (the complementary side of both bidirectional conduction edges) — Ambient air's own temperature

**Parameters**:

- $R$ (`resistance`), $L$ (`inductance`), $k_e$ (`backEmfConstant`) — Armature dynamics
- $k_t$ (`torqueConstant`), $b$ (`viscousFriction`), $J$ (`rotorInertia`) — Shaft dynamics
- $R_{winding}$ (`resistance`), $C_{housing}$ (`thermalCapacitance`) — Resistive heating
- $R_{internal}$ (a separate `resistance` instance), $C_{batt}$ (a separate `thermalCapacitance` instance) — Internal resistance heating
- $\alpha$ (`dischargeCoefficient`) — Discharge
- $k_1$ (`conductance`), $C_{housing}$ (matching Resistive heating's own value) — Housing conduction
- $k_2$ (`conductance`), $C_{batt}$ (matching Internal resistance heating's own value) — Battery conduction

## Expected behaviour

Current and angular velocity rise and settle exactly as in Single Joint Actuator, current settling around 9.8 A. Both the housing and the battery warm from their own I²R losses, but at very different rates: the housing's larger winding resistance (2 Ω) against a smaller thermal mass (50 J/K) heats quickly (293.15 K → 424 K over 60 s in a reference run), while the battery's much smaller internal resistance (0.2 Ω) against a larger thermal mass (100 J/K) warms far more slowly (→ 328 K over the same 60 s) — the contrast is itself a reasonable teaching point about why winding losses usually dominate a small actuator's total heat budget. Battery state of charge decreases steadily and linearly for as long as the motor keeps drawing its settled current.

Ambient air is not a passive bystander here: it receives real heat from *both* conduction edges simultaneously and has no outgoing path of its own, so its temperature rises too (→ 368 K over the same 60 s in that reference run) — faster than the battery's own rise, since it's accumulating contributions from two sources at once.

## Simplifications

Battery voltage stays fixed regardless of state of charge (a real battery sags as it depletes), and the discharge coefficient is a flat linear scaling rather than a real cell's nonlinear capacity curve. Resistive heating's winding and internal resistances are simplified, illustrative values, not derived from a shared physical model or a real component's datasheet.

Ambient air's temperature is a more pointed illustration of a simplification already present in Thermal Equilibrium-style bidirectional edges: each Conduction edge treats the *far* side as sharing *its own* thermal capacitance parameter, since the equation only carries one such value. With a single incoming edge that's a modest approximation; here, with two incoming edges using different capacitances (50 J/K from the housing, 100 J/K from the battery), Ambient air doesn't have one consistent effective thermal mass at all — it's really two separate approximations landing on the same state and summing. A true infinite boundary, or one node genuinely receiving multiple heat paths with dimensionally consistent bookkeeping, would need a capacitance that belongs to the receiving node itself rather than to each edge — a real modeling upgrade beyond what a shared-parameter bidirectional edge can express, not something to paper over here.
