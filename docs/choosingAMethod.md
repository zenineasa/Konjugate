---
type: Guide
title: Choosing a method
description: When to use each integration method, from the signs a run shows, with the benchmark behind each. Written from src/integrationMethods.mjs (methodGuide), which the Run dialog's "?" shows.
tags: [integration, methods, help, in-app]
status: stable
---

# Choosing a method

<!-- Written by scripts/writeMethodGuide.mjs from src/integrationMethods.mjs (methodGuide); edit it there. -->

Start with Euler, node by node. Change the method when you see one of these signs.

## Signs

* **Halving the global step changes the results you care about.** Use Runge–Kutta 4, or Adaptive to have the steps chosen for you. Evidence: [Convergence order](../benchmarks/verification/convergenceOrder).
* **Energy grows in an oscillator that should keep it: a spring, a pendulum, an LC circuit.** On the node's Numerics tab, set Integration to Semi-implicit Euler, or Verlet for second order. Evidence: [Harmonic oscillator](../benchmarks/mechanical/harmonicOscillator), [Pendulum](../benchmarks/mechanical/pendulum).
* **Results jump or lag at a switch: a PWM, a thermostat, a contact.** Use Runge–Kutta 4, Adaptive or Stiff: each finds the instant a condition switches and steps to it. Evidence: [Switched circuits](../benchmarks/electrical/switchedCircuits), [Bouncing ball](../benchmarks/mechanical/bouncingBall).
* **Tightly coupled nodes need many substeps, or disagree with the same model built as one node.** Use Runge–Kutta 4, Adaptive or Stiff, which step every node together. Evidence: [Graph split](../benchmarks/coupling/graphSplit).
* **The model check says the model is stiff, or Adaptive takes tiny steps and rejects many.** Use Stiff. Evidence: [Robertson](../benchmarks/chemistry/robertson), [Van der Pol](../benchmarks/oscillators/vanDerPol), [Prothero–Robinson](../benchmarks/verification/protheroRobinson).
* **A stiff model with thousands of states is slow under Stiff.** Under Stiff, try the BDF solver, which factorises less often. Keep Rosenbrock if the model switches often. Evidence: [Stiff network](../benchmarks/scaling/stiffNetwork).

## The methods

* **Euler, node by node**: The default. Each node steps on its own: quick, and fine for a first look. A node's Integration can be Explicit, Semi-implicit or Verlet.
* **Semi-implicit Euler and Verlet**: For a node that oscillates: its energy stays bounded instead of growing. Verlet is second order.
* **Runge–Kutta 4**: Smooth models, accurate at a step you choose.
* **Adaptive**: An accurate answer without choosing the step: it keeps the error within a tolerance.
* **Stiff, Rosenbrock**: Models with very fast and very slow parts together. Best for most stiff models.
* **Stiff, BDF**: Large stiff models, thousands of states, that switch rarely: it factorises less often than Rosenbrock, which pays where factorising is slow.
