<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Pump Suction Hydraulics

## Overview

A transient digital twin of a pump suction line, modeling a real API 675 controlled-volume metering pump's NPSHa (Net Positive Suction Head available) and cavitation margin. Rather than computing NPSHa with a static formula, this model simulates the actual transient hydraulics — fluid inertia, pipe friction, and a genuinely pulsating pump suction demand — and lets the cavitation margin emerge from letting the system run, the same way a real experimental validation of it would have to. A reciprocating pump's pulsating suction flow is often approximated with an empirical correction term; here that pulsation is real, computed directly from simulated time, not approximated.

## Model structure

Pressure and flow are modeled via the standard hydraulic-electrical analogy (pressure↔voltage, flow↔current, pipe friction↔nonlinear resistance, fluid inertia↔inductance, compressibility↔capacitance) — the same lumped-parameter idiom this engine already uses for thermal and electrical domains, applied here to a new one.

- **Tank**: a `pressure` state representing the tank's liquid-surface absolute pressure, with a deliberately huge capacitance so it acts as a near-fixed boundary condition — a large reservoir barely moves in the few seconds this model takes to settle.
- **Suction Line 1 / 2 / 3**: each a `flowRate` state, one per pipe section (tank outlet to first reducer, common suction run, individual pump branch). Governed by fluid-inertance momentum — literally Newton's second law for the fluid column — plus a self-referencing friction source term.
- **Suction Manifold Junction / Branch Junction**: each a `pressure` state at a section boundary, governed by capacitance (net flow imbalance charges or discharges it). Branch Junction sits at the one real diameter transition in this model (2" to 1/2"), which is why only it — not Suction Manifold Junction, whose neighboring sections are the same nominal size — uses the concentric-reducer shape.
- **Pump**: the suction-side pressure state, plus three extra states purely for a readable result: `npshHead` (a fast first-order tracker of the real NPSH margin), `pressureAveraged` (a slow tracker filtering out the pump's own pulsation), and `npshDesign` (`npshHead` minus a tunable design safety margin, defaulting to 1 m — a common design-margin convention for this kind of sizing check). All three settle to the same steady answer `pressure` does, just without the ripple, so the settled margin — with or without a safety allowance — is directly readable on the chart. `npshDesign` is a comparison-stage readout only: the safety margin it subtracts is a policy choice, not a physical loss, so it is deliberately never wired into the momentum/capacitance equations above — it can't feed back and change the actual simulated hydraulics.

Only one representative suction branch is modeled — a worst-case simplification (the branch with the least margin) — not the second parallel pump branch a real multi-head skid would also have.

## Equations

### Fluid inertance (per suction line)

$$\frac{dQ}{dt}=\frac{P_{upstream}-P_{downstream}-\Delta P_{friction}(Q)}{\rho L/A}$$

The two pressure terms arrive as ordinary edges from the neighboring junction/tank nodes (additive, like every other coupling in this engine). $\Delta P_{friction}(Q)$ is a self-referencing source term using the Darcy-Weisbach equation with an explicit-Colebrook friction-factor approximation (valid directly, without iterating to convergence the way the implicit Colebrook-White equation would need). Suction Line 1's source term also carries the one-time static-head gain (tank surface to pump elevation), applied once rather than localized to a specific section.

A small amount of additional linear damping is added on top of the real quadratic friction above — the real friction is far too weak, on its own, to counteract explicit Euler's inherent instability on this section's otherwise lightly-damped resonance (a purely oscillatory mode is never stable under explicit Euler, for any timestep). Sized against each section's own critical-damping resistance.

### Capacitance (per junction, tank, and the pump's own suction state)

$$\frac{dP}{dt}=\frac{Q_{in}-Q_{out}}{C}$$

$C$ here is an artificial, tunable compliance — not the real (near-incompressible) bulk modulus of the liquid, which would be numerically brutal for an explicit integrator. This is Chorin's artificial compressibility method: a well-established technique for turning an otherwise-stiff incompressible problem into a numerically tractable pseudo-transient one.

### Pump withdrawal (programmable Python source term, Pump node)

$$Q_{pump}(t)=\mathrm{ramp}(t)\cdot Q_{mean}\cdot\pi\cdot\max\left(0,\sin(2\pi f t)\right)$$

The only place in this model that reads simulated time directly, via a programmable provider (`context.simulation_time`) rather than an equation — genuine pulsating suction demand, one pulse per shaft revolution ($f=$ pump rpm / 60), instead of a static correction term. The waveform is a half-rectified sine, not a smooth ripple: a simplex, single-acting plunger only draws flow during half its stroke and delivers zero the rest of the cycle, peaking at $\pi\times$ the mean flow rather than gently oscillating around it — consistent with the standard $2/\pi$ acceleration-head factor used for simplex pumps in API 675-style sizing. `ramp(t)` brings the demand up smoothly over the first second rather than snapping to full withdrawal instantly, matching how a real pump doesn't reach speed immediately.

### States and parameters

Every pipe section's inertance, friction-factor coefficients, and equivalent length come from real pipe geometry and fittings data (pipe ID, roughness, viscosity, density, and a Le/D sum per section covering elbows, tees, valves, and reducers), converted to SI.

## Expected behaviour

Starting from rest (every flow rate at zero, every pressure at the tank's own resting value), suction flow builds up over roughly the first 1-2 seconds as fluid inertia accelerates, then settles into a steady pulsating pattern riding on a converged mean. In a reference run to 20 s (`globalTimeStep` 0.01 s, 120 substeps per node — this system's fast pressure/flow dynamics need much finer resolution than the thermal examples' usual default), sampled over the settled window (16-20 s):

| Quantity | Range | Mean |
| --- | ---: | ---: |
| `npshHead` (m) | 3.58 – 3.95 | 3.76 |
| `npshDesign` (m, with 1 m safety margin) | 2.61 – 2.93 | 2.76 |

`pressure` at the Pump node visibly pulsates at the pump's own ~1.65 Hz shaft frequency once flow has developed, with `pressureAveraged` and `npshHead` settling to stable values within about 10-15 s.

**On the model's own numerical tuning** — this model's numerical stabilization terms (the damping note under Fluid inertance, and the artificial capacitance under Capacitance) were investigated directly rather than left unexamined:

- Switching the pump waveform from a smooth ripple to the physically-correct half-rectified sine (above) grew the pulsation amplitude roughly 3x but left the *mean* margin essentially unchanged.
- Hand-estimating the added linear damping's own contribution at the operating flow rates puts it around 2 m of head loss — nearly 10x the real Darcy-Weisbach friction (0.159 m total). Most of this model's head loss beyond real friction is numerical stabilization overhead, not physics.
- Halving that damping was tested directly: the settled mean margin *rose* (to ~4.5 m) rather than falling, confirming the damping term is genuinely suppressing the margin, not hiding a different answer underneath.
- Shrinking the artificial capacitance (which would let pressure respond more sharply to flow imbalances, a more physically direct lever) was attempted but hit a practical wall: capacitance small enough to meaningfully change the answer needs proportionally more substeps to stay numerically stable, and every substep round-trips through the Python provider process — a 10x capacitance reduction with enough substeps to remain stable made a 3 s test run take over a minute, impractical to tune further.

Closing that numerical gap further would need either a C++ (rather than Python) pump-withdrawal provider to make finer numerical resolution practical, or a fundamentally different integration scheme — both out of scope here, noted as a real limitation rather than smoothed over.

## Simplifications

Only one suction branch is modeled (a worst-case simplification), not a real multi-head skid's additional parallel pump branches. Every capacitance value is an artificial numerical-stability choice (Chorin's method), tuned for a clean, watchable settling time rather than derived from real fluid/pipe compliance — and, per the investigation above, tuned to a coarser resolution than would be needed to fully separate numerical damping from genuine inertial physics. The added linear damping term exists to keep the explicit integrator well-behaved on top of the real (and much weaker) Darcy-Weisbach friction, and was confirmed (not just assumed) to be the dominant source of this model's head loss beyond real friction — it is deliberately not a claimed physical effect, and the guide above reports its estimated size rather than hiding it.
