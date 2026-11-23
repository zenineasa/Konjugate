---
type: Proposal
title: Integrators
description: Three integration methods written in Konjugate's own code -- fixed-step Runge-Kutta 4, adaptive Dormand-Prince 5(4) and a stiff Rosenbrock method (Rodas4) -- applied to the whole model at once, stage by stage, so that the coupling between nodes is as accurate as the method rather than first order; how stages meet Updates, programs, FMUs, live control and checkpoints; where the choice lives; and how the benchmark suite proves each method, with explicit Euler node by node staying the default to the bit.
tags: [proposals, engine, numerics, solvers, integrators, execution]
status: draft
implementation: partial
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Integrators

**Status: proposed 23 November 2026; stage 1, Runge–Kutta 4 for the whole model, and stage 2, Adaptive (Dormand–Prince 5(4)), built. Rodas4 and the later stages are not built. The methods are Konjugate's own code: no SUNDIALS or other solver library (a decision already made, not reopened here). The open questions are decided: see [Decisions](#decisions).**

## The problem

Konjugate integrates with fixed-step Euler: explicit by default, or semi-implicit (symplectic) for a node whose `numerics.integration` is `semiImplicit` (`engine/src/executionPlan.cpp`, `compileExecutionPlan` and `integrateNode`). Each global step $H$, every node takes its own substeps and reads every other node through a snapshot frozen at the start of the step ([Parallel execution](../parallelExecution.md)). That rule is what makes the serial, thread-pool and partitioned backends give the same numbers to the bit, and it is worth keeping.

The [benchmark suite](../../benchmarks/README.md) measures what this costs:

- **Both methods are first order**, observed 1.00 to 1.06 on every problem. Accuracy is bought only by a smaller step, at a cost that doubles for each halving of the error.
- **Explicit Euler is poor on oscillations and conserved quantities**: an undamped oscillator's energy grows about $9 \times 10^6$-fold over 1024 s, a pendulum's drifts 47 %, Lotka–Volterra's invariant 1163 %. Semi-implicit Euler keeps them within 0.8 %, 0.13 % and 2.1 %.
- **The coupling between nodes is first order in the global step, and substeps do not help it.** In `benchmarks/coupling/graphSplit`, three masses on springs written as three nodes differ from the same system written as one node by an error of observed order 0.99 in $H$; doubling every node's substeps shrinks it by a factor of only about 1.08.

The last finding decides the design. With the snapshot frozen, a node sees each neighbour as a constant over the step, a zero-order hold: the neighbour's real value moves by $O(H)$ during the step, so the node's derivative is wrong by $O(H)$, each step adds $O(H^2)$ and the run $O(H)$. That error does not depend on how the node integrates itself. **A fourth-order method inside each node, with the snapshot as it is, gives a fourth-order node and first-order coupling**: exact for a model drawn as one node, and no better than Euler for any model drawn as a graph, which is what Konjugate is for. Phase 3 of the benchmark suite (Lorenz, Van der Pol across $\mu$, Robertson's stiff kinetics) needs methods that are accurate across the graph, adaptive, and stable on stiff problems.

## Decisions in brief

1. **Three methods**: fixed-step **Runge–Kutta 4**; adaptive **Dormand–Prince 5(4)** with error control and dense output; and **Rodas4**, a stiff Rosenbrock method with a Jacobian, one LU factorisation a step and no history.
2. **They apply to the whole model at once, stage by stage**: at every stage, every node is evaluated from every node's stage values. Each stage is a snapshot in today's sense, so determinism and partitioned execution carry over; the coupling is then exactly as accurate as the method, and the split model equals the one-node model.
3. **Today's scheme stays as a method of its own**, "Euler, node by node": the default, the only one with per-node substeps (multi-rate), and running through today's code path untouched, so every existing model gives the same numbers to the bit.
4. **What cannot take part in stages is stepped as today and held**: an imported FMU, and a program that cannot be known to keep no memory between calls (every version 1 program; see decision 5), advance once per global step against the snapshot, and the rest reads them held through the step. Their coupling stays first order, and the run says so.
5. **Updates are untouched**: they are replaced at the end of each global step, from the Rate states the method reached. Stages never see a new Update, and the global step stays the one instant at which Updates, live control, samples and checkpoints happen; an adaptive method lands on every global step.
6. **The choice lives in the run configuration**, beside the timestep, as **Method** in the Run dialog; a file says it only when it is not the default.
7. **A coupling correction for node-by-node runs** (neighbours extrapolated from the last two snapshots, second order, no extra synchronisation) is proposed as a later, opt-in stage; iterating the step (waveform relaxation) is not.

## The methods

### Runge–Kutta 4 (fixed step)

The classical four-stage, fourth-order method. **Why**: it is the simplest method that removes most of Euler's error on smooth problems: four evaluations a step instead of one, error falling sixteen-fold per halving instead of two-fold. With no error estimate and no hidden state it is the easiest to make bit-reproducible, to restart, to export and to teach, and it is the first test of the stage-wise architecture below, which the other two methods reuse. A fixed step is also what live control and pacing expect: every global step costs the same.

### Dormand–Prince 5(4) (adaptive)

Seven stages, first-same-as-last (six new evaluations a step), fifth-order solution with an embedded fourth-order error estimate, the method behind MATLAB's `ode45` and SciPy's `RK45` ([Dormand and Prince, 1980](https://doi.org/10.1016/0771-050X(80)90013-3); Hairer, Nørsett and Wanner, *Solving Ordinary Differential Equations I*, II.5). **Why**: it is the reference adaptive explicit method; its free continuous extension gives fourth-order **dense output** from the stages already computed; and Hairer's stiffness test on its stages comes almost free, so the method can say when a model needs the stiff one. The step controller is Hairer's PI controller (`DOPRI5`'s), with mixed relative and absolute tolerances. **Dense output** is the base for later work (event location first, then multi-rate stages); it does not write samples, which stay on global steps with the Updates (decided while building stage 2), and synchronisation instants are always exact step ends, never interpolated (see [Interventions, live control and pacing](#interventions-live-control-and-pacing)).

### Rodas4 (stiff)

A six-stage Rosenbrock method of order 4 with an embedded order-3 estimate, L-stable and stiffly accurate, with a third-order dense output (Hairer and Wanner, *Solving Ordinary Differential Equations II*, IV.7; the `RODAS` code). Each step evaluates the Jacobian $J = \partial f/\partial y$ (and $\partial f/\partial t$ when the model reads time), factorises $I - h\gamma J$ once, and solves six linear systems with that factorisation. **Why a Rosenbrock method**: it is linearly implicit, so it needs no Newton iteration and no convergence test, and it is a **one-step method with no history**. That matters more in Konjugate than raw efficiency: a step can stop on any global step, live control can change a parameter between steps, a checkpoint can restart a run and a live twin can rewind with states replaced, all without rebuilding a history. Stiffly accurate and L-stable, it handles Robertson's kinetics and Van der Pol at $\mu = 1000$, and it preserves linear invariants (Robertson's $y_1 + y_2 + y_3 = 1$) to rounding.

### Left out, and why

| Method | Why not now |
| --- | --- |
| **BDF / NDF** (variable order, `ode15s`-like) | Cheaper than Rodas4 on large stiff models (it reuses one Jacobian over many steps), but it carries a Nordsieck history whose order and step sizes are hidden state: every intervention, rewind, state override and schedule corner forces a restart at order 1, and the checkpoint must carry the history to restart to the bit. Proposed only if a benchmark shows Rodas4's factorisation a step dominating on a model of thousands of stiff states. |
| **Implicit Runge–Kutta** (Radau IIA) | More accurate per step on very stiff problems, but a coupled $3n$ system and a Newton iteration; Rodas4 covers the phase 3 problems. |
| **DOP853** | A second adaptive tableau for tight tolerances; cheap to add on the same code once Dormand–Prince 5(4) exists, so it is not a design question. |
| **Higher-order symplectic** (Störmer–Verlet, velocity Verlet) | The right tool for long conservative runs, where Runge–Kutta drifts too, slowly. A whole-model form needs to know which states are positions and which their velocities; the second-order states of [One editor for nodes and relationships](unifiedEntityEditors.md) give exactly that, so it is the natural follow-up to them, not part of this proposal. |
| **IMEX and multi-rate Runge–Kutta** (MRI-GARK) | Would keep per-node substeps inside a high-order whole-model method; research-grade, and only worth it once a benchmark shows a multi-rate model that needs both. |
| **DAE solvers** | Updates are not algebraic constraints solved at the instant ([Rates and updates](ratesAndUpdates.md)); no DAE is needed. |
| **Event location** | Dense output makes it possible later; events are out of scope here as they are in Rates and updates. |

## How they fit the graph

### Two ways to step a model

**Node by node** (today, and the default). Each node integrates its own states over the global step with its own substeps and method (explicit or semi-implicit Euler), reading other nodes from the snapshot. Multi-rate and as parallel as the graph allows; coupling first order in $H$.

**Whole model** (Runge–Kutta 4, Dormand–Prince 5(4), Rodas4). The method is applied to the vector of every Rate state of every node. A step of an $s$-stage method is $s$ **stage snapshots**: for each stage $k$, the engine forms the stage values $Y_k$ of every state, every node evaluates its contributions reading $Y_k$ (its own states and its neighbours' alike), the contributions to each state are reduced in their stable compiled order, and the stage derivatives $K_k$ are kept; the step's end is $y_{n+1} = y_n + h \sum_k b_k K_k$, summed per state in stage order. Nothing reads a value another worker is still writing, as now; there are simply $s$ synchronisation points a step instead of one.

### What each does to coupling accuracy

| Scheme | Coupling error | Per-node error | Extra cost a step | Determinism and partitioned execution |
| --- | --- | --- | --- | --- |
| Euler node by node (today) | $O(H)$ | $O(H/n)$ with $n$ substeps | -- | as today |
| A higher-order method inside each node, snapshot held | $O(H)$, unchanged | $O((H/n)^p)$ | $s$ evaluations per substep | as today |
| **Whole-model method of order $p$** (proposed) | $O(H^p)$: the same as the method's | the same | $s$ evaluations and $s$ synchronisations; no per-node substeps | bit-identical across backends; $s$ boundary messages a step |
| **Extrapolated snapshot**, node by node (proposed, later) | $O(H^2)$ | $O(H/n)$ | none: two snapshots kept instead of one | bit-identical; no extra messages; stability narrower |
| Iterated step (Jacobi waveform relaxation), $m$ sweeps | $O(H^{\min(m, p)})$ | the node's | $m$ times the work and $m$ synchronisations | bit-identical; programs and FMUs need roll-back every sweep |

So the answer to "how does a method improve the coupling" is: **only by evaluating the coupling where the method evaluates everything else**. A whole-model method does; a per-node method cannot. On `graphSplit`, a whole-model method gives the split model the one-node model's numbers (to rounding: the same method on the same equations, summed in the same order per state), so the coupling error the study measures becomes zero, and the observed order of the split model's error against the exact solution becomes the method's.

**Extrapolated snapshots** keep node by node for models that need it (multi-rate models with substeps in the hundreds, where one step size for the whole model would be wasteful). Instead of holding a neighbour at its value $x_j(t_n)$, a node reads $x_j(t_n) + \frac{\tau}{H}\,(x_j(t_n) - x_j(t_{n-1}))$ at time $t_n + \tau$ within the step. That is second order in $H$, costs no extra synchronisation or message (each worker keeps the previous snapshot too), and is deterministic because every worker reads the same two snapshots. Its costs: extrapolation is known to narrow the stable range of stiff couplings (it is the co-simulation literature's standard caution), it is wrong across a jump, so a neighbour falls back to held for the step after an Update of its own changed or an intervention landed, and the previous snapshot becomes solver state in a checkpoint. It is opt-in (`coupling: "extrapolated"`), measured on `graphSplit` before it is offered, and never the default.

**Iterating the step is not proposed.** For the same accuracy it costs as much as a whole-model method or more, and it needs every program with memory and every FMU to roll back each sweep (many FMUs cannot). It remains the route for a future multi-process model whose parts must stay separate, where it can be reconsidered.

### Determinism

The rule that makes backends agree today -- every evaluation reads an immutable snapshot, every reduction runs in a stable order, every node writes only its own states -- holds per stage. Three new reductions need care:

- **The error norm** of the adaptive methods is a sum over every state. Each node sums its own states in its own order; the per-node partial sums are then combined in node order (a vector of one double per node gathered at the step's end), never in the order workers finish, so the norm, and therefore every step-size decision, is the same on every backend and every worker count.
- **The Jacobian** is assembled column group by column group (below); each entry is written by exactly one evaluation, so assembly order does not matter.
- **The linear solve** runs on one worker, with a fixed ordering computed once at compile time. It is deterministic by construction; a parallel sparse factorisation is not proposed.

Across platforms, numbers differ only by rounding, as now; under an adaptive method a rounding difference can, rarely, tip a step's acceptance and give a different (equally valid) step sequence. The benchmark compares platforms against the reference, within tolerance, not against each other to the bit.

### Partitioned and parallel execution

Partitions keep their persistent workers and their boundary messages, one per stage rather than one per step: a partition evaluates its nodes' contributions for stage $k$, sends its boundary states' stage values, receives its neighbours', and goes on to stage $k+1$. Automatic backend selection weighs a node's work as `estimatedOperationsPerSubstep` times stages, and the communication-aware partitioner counts boundary traffic times stages, so a model that partitions well under Euler may pick the thread pool under Runge–Kutta 4. Rodas4 adds a serial section a step (the factorisation and the $s$ solves) between parallel evaluations; for the phase 3 problems it is microseconds, and the result's execution summary reports it so a model where it dominates is visible.

### Updates and settling

Nothing changes in the rule of [Rates and updates](ratesAndUpdates.md), which already says what is needed: Rate states are integrated over the step reading every Update as it was at $t$; Updates are replaced at the end of the step, reading the Rate states at $t + H$. Under a whole-model method, every stage reads Updates held at their values from $t$, the method integrates the Rate states to $t + H$, and the update phase (and settling, where a node asks for it) runs once, exactly as now. Updates are not stage quantities and never enter the Jacobian (within a step they are constants). An adaptive method's internal steps inside one global step do not replace Updates; only the global step does, so a model's discrete-time Updates mean the same thing under every method. A rejected step touches no Update.

### Programs

A term written as a program (C++, Python, an installed plugin) is called once per substep today, and may keep memory of its own between calls ([Rates and updates, Terms](ratesAndUpdates.md#terms)). Called at six stage points, possibly again for a rejected step, a program with memory would advance its memory six times. So:

- **A pure program** -- its outputs depend only on its inputs, parameters and time, and calling it twice for the same inputs changes nothing -- would be evaluated at every stage like an equation, in one `evaluateBatch` round trip per stage, so a Python program's cost grows by the number of stages. This proposal first planned a `pure` declaration on version 1 programs; it was dropped (decision 5) for [Program SDK version 2](programSdkV2.md), in which purity follows from a program's shape rather than from a promise its author could get wrong. The engine asks `ProviderEvaluator::declaredPure` of every program, which no version 1 program answers yes to.
- **A program written against version 1 of the SDK** -- every program today -- is **held**: it is evaluated once per global step, at its start, as it is today, with the global step as its step size, and its outputs are held through the stages. Its node's other terms still take part in stages. The coupling through a held program is first order, and the Run dialog and the run's result say which programs are held.
- **A computational-node provider** follows the same rule: a version 1 node program is stepped as today, the whole node (below). Its `checkpoint()` and `restore()` are not used for stages.

### Nodes that cannot take stages: FMUs and stateful node providers

An imported FMU is a Co-Simulation slave with its own integrator: it can only be told to step. Under a whole-model method, such a node, and a node whose provider is not pure, is **stepped**: once per global step, with its own substeps, against the step-start snapshot, exactly as node by node, while the rest of the model takes stages and reads it held at its start-of-step values. This is the zero-order hold Konjugate uses now, confined to the nodes that need it, and the run's result names them ("3 nodes stepped on their own, coupled to the rest at first order: …"). An FMU imported for Model Exchange could take part in stages; importing Model Exchange is outside this proposal. A stepped node is not differentiated for Rodas4's Jacobian: its states are constants within the step to the rest of the model, as they are to their neighbours today.

### Interventions, live control and pacing

The global step stays the instant at which the world can act on a run: a live parameter set lands at the next global step, samples and checkpoints are taken on it, the stability monitor observes it, and pacing waits after it. Fixed-step methods take exactly one step (or a stated number, below) per global step. **Adaptive methods land on every global step**: the internal step is capped so that the last one ends on $t + H$, and the next starts with the step size the controller proposed. The global step becomes the largest step the method may take, and its natural setting is the output interval or the interval at which live control must be able to act, not the accuracy the model needs, which the tolerance now sets.

Inside a global step, the internal steps also land on **breakpoints known in advance**: a held schedule's sample times and a ramp's or pulse's corners, where the derivative jumps. A schedule read at a stage time is read at that time, as substeps read it today. Pacing is unchanged; what changes is that an adaptive global step's cost varies, which a live twin's speed budget ([Prediction-actual window](predictionActualWindow.md)) already measures rather than assumes.

### Checkpoints and restart

A checkpoint records `solver_kind` and `solver_version` (`protocol/engineProtocol.proto`, `ResultCheckpoint`; today always `explicitEuler`, 1). The solver identity grows with the methods:

| `solver_kind` | Hidden state needed to continue to the bit |
| --- | --- |
| `explicitEuler` (node by node, with semi-implicit nodes) | none |
| `extrapolatedEuler` | the previous snapshot, $x(t_{n-1})$ |
| `rungeKutta4` | none |
| `dormandPrince54` | the proposed next step size and the controller's previous error (built: a 17-byte record, a version byte 1 and the two as little-endian doubles); the first-same-as-last derivative is not carried: every global step starts by evaluating the derivative at its start, where the held programs are evaluated and the Updates have just been replaced |
| `rodas4` | the proposed next step size and the controller's previous error; the Jacobian is recomputed each step anyway |

The hidden state is one new field, `bytes solver_state = 7` on `ResultCheckpoint`, holding a small versioned record (empty for methods with none). Restarting with the method a checkpoint was made with continues to the bit; restarting with a different method (a fork or extension whose Run dialog changed it) discards the hidden state, as changing the timestep at a continuation makes a new segment today. A live twin's rewind with states replaced resets the controller (the starting step is chosen again by Hairer's initial step algorithm, which is deterministic). This is also why BDF is left out: its checkpoint would carry a Nordsieck array, its order and its recent step sizes, and every rewind with states replaced would discard them.

### Jacobians for Rodas4

**Structure from the graph.** The compiled plan already knows, for every contribution, which states it reads (its bindings). The Jacobian's sparsity is therefore known exactly at compile time, per state rather than per node: entry $(i, j)$ can be non-zero only if a term reaching state $i$ binds state $j$. Updates, held programs and stepped nodes add no columns.

**Finite differences, coloured (first).** Columns whose rows do not overlap are perturbed together (Curtis, Powell and Reid), so a model whose states each read a handful of others needs a handful of evaluations per Jacobian, not one per state. Colouring is greedy in state order, computed once, deterministic. Each perturbation is $\sqrt{\varepsilon}\max(|y_j|, \text{scale}_j)$; $\partial f/\partial t$ is one more evaluation when the model reads time or a schedule. This works for every term, programs included, and is what Rodas4 ships with: Hairer's `RODAS` code uses difference Jacobians by default.

**Analytic, from MathJSON (later).** Equations are MathJSON trees compiled to `ExpressionProgram`s. Differentiating a tree symbolically at compile time (sums, products, quotients, powers, the elementary functions, and a piecewise expression through its active branch) gives an exact derivative program per term and bound state, evaluated in one pass. There is no symbolic differentiation in Konjugate yet; it is a contained piece of work, and it serves more than Rodas4: the stability analysis's Jacobian (today central differences, `engine/src/stabilityAnalysis.cpp`) and the gradients of parameter tuning could use it too. Columns whose terms are all equations use it; the rest stay finite differences.

**The linear solve is Konjugate's own**: dense LU with partial pivoting up to a few hundred states, and a sparse LU with a fill-reducing ordering computed once from the graph's structure above that. Eigen (already in the engine, native and WebAssembly) is the reference the tests check it against, not the implementation, because code export must reproduce the same arithmetic in a file with no dependencies (below).

## Where the choice lives

**In the run configuration**, beside `globalTimeStep` and `outputInterval`, because it is a property of how a model is run, not of the model: the same model is run with Euler for a quick look and Rodas4 for the answer, a fork may change it as it may change the timestep, and the command line and code export already read their numerics from the active run configuration.

```json
"runConfigurations": [{
  "id": "…", "globalTimeStep": 0.01, "outputInterval": 0.1,
  "method": "rungeKutta4",
  "stepsPerGlobalStep": 4,
  "tolerance": { "relative": 1e-6, "absolute": 1e-9 },
  "coupling": "extrapolated"
}]
```

- `method`: `nodeByNode` (absent), `rungeKutta4`, `dormandPrince54` or `rodas4`.
- `stepsPerGlobalStep` (Runge–Kutta 4 only): an integer from 1 through 10,000, absent meaning 1: the whole-model counterpart of a node's substeps, so the integration step can be finer than the instant Updates and live control act on.
- `tolerance` (adaptive methods only): relative and absolute, absent meaning $10^{-6}$ and $10^{-9}$, each written only when it is not its default. A state may override the absolute tolerance with its own `numerics.absoluteTolerance` (on the state, edited on its node's Numerics tab), written only when set, because one absolute tolerance cannot suit a temperature in kelvin and a concentration in mol/L in one model.
- `coupling` (node by node only): `held` (absent) or `extrapolated`.

**Per node**, `numerics.substepsPerGlobalStep` and `numerics.integration` keep their meaning under node by node, and apply to stepped nodes under a whole-model method; for every other node they are not used while a whole-model method is chosen, and the node's Numerics tab says so rather than hiding them. **Per node methods are not proposed**: a fourth-order node inside the held snapshot is still first order across the graph (above), and offering it would invite the belief that it is not.

**The result records the method**, its settings, the nodes stepped and the programs held, as it records the backend: the result bar's execution summary shows it, and a continued or forked run's dialog opens with it.

## In the app

The Run dialog, which already holds the target time, the timestep and output interval, and Execution, gains **Method**, a plainly named choice with one line under each:

- **Euler, node by node** (default): "Each node steps on its own, reading the others as they were at the start of the step. Quick, and fine for a first look; first order, so halving the step halves the error."
- **Runge–Kutta 4**: "The whole model is evaluated at four points in each step. Far more accurate for smooth models, for about four times the work a step."
- **Adaptive**: "Chooses its own steps to keep the error within a tolerance, smaller where things change fast. Use it when you want an accurate answer without choosing the step." Shows **Tolerance**, relative and absolute.
- **Stiff**: "For models with very fast and very slow parts together -- chemistry, stiff springs, circuits with tiny time constants -- where the others need tiny steps. Solves a set of equations each step."

Under the timestep, a line says what the global step means for the chosen method ("Updates, controls and samples happen at least this often; Adaptive chooses smaller steps within it"). Choosing Runge–Kutta 4 shows **Steps per global step**. If the model has nodes that will be stepped or programs that will be held, the dialog says so under Method, naming them, before the run starts.

**The method is reached from where it is needed, not only from the dialog**, following the project's rule that a feature has a short path to a working result:

- A stability finding that recommends substeps also offers the method that removes the need: "Use Stiff" when the eigenvalues say the model is stiff, "Use Runge–Kutta 4" when an undamped oscillation grows; one click changes the active run configuration, undoably.
- Under Adaptive, Dormand–Prince's stiffness test becomes a finding ("this model looks stiff: Adaptive is taking steps limited by stability, not accuracy") with "Use Stiff".
- A node's Numerics tab, under a whole-model method, says "This model is run with Runge–Kutta 4 (Run settings ›); substeps and the node's integration don't apply" with the link.
- A tutorial ("Choosing a method") runs the bundled oscillator with each method and shows the energy, once the tutorials list grows; the help page explains the four in a paragraph each.

## Code export, FMI export, the web and stability analysis

**Code export** ([Code export](../codeExport.md)) reproduces the engine's arithmetic exactly, and refuses by name what it cannot write (it refuses semi-implicit nodes today). Each method is written the way the engine computes it: the tableaux, the step controller, the breakpoints, the coloured finite-difference Jacobian and the LU. So the methods' stepping code lives in headers of their own (`engine/include/konjugate/integrators/`), plain C++ with no dependency, which the engine includes and C++ export pastes in verbatim, as it pastes the SDK types today; the Python export carries a line-for-line port. Each method is exported in the stage that builds it, and refused by name until then. The OpenMP, `std::thread` and MPI modes synchronise per stage as the engine does. Analytic Jacobians, once built, are exported as generated expressions.

**FMI export** runs the chosen method inside `fmi2DoStep`, an adaptive one landing on the communication point as it lands on the global step; the FMU's state for `fmi2GetFMUstate` and serialisation includes the solver state above. Model Exchange export stays not offered, for the reason it is not offered now: Konjugate's numbers are only Konjugate's if Konjugate integrates.

**The web edition** gains no dependency: the methods, the colouring and the LU are Konjugate's own code, compiled by Emscripten like the rest of the engine, and Eigen, used only by the tests and the stability analysis, is already in the WebAssembly build. The threaded web build synchronises per stage like the native thread pool.

**Stability analysis** (`assessNodeStability`) today finds the largest stable node step from the eigenvalues $\lambda$ of a node's Jacobian and Euler's amplification $1 + h\lambda$. It generalises to any Runge–Kutta method through its stability function $R(z) = 1 + z\,b^{\mathsf T}(I - zA)^{-1}\mathbf{1}$, computed from the tableau: for each eigenvalue, the largest $h$ along its ray with $|R(h\lambda)| \le 1$ (scanned to the first crossing, since Runge–Kutta 4's region is not a disc). Under a whole-model method the analysis uses the whole model's Jacobian, which is the right one there (the coupling's eigenvalues are in it), up to a size where a dense eigen-solve is cheap, and per node above it with a note; its recommendation becomes a global timestep (or steps per global step) instead of substeps. Rodas4 is L-stable: the analysis reports no step limit, only the stiffness ratio. Under Adaptive, the analysis reports the step stability allows, which the controller will be held to. Semi-implicit nodes get their own amplification matrix rather than Euler's.

## Backwards compatibility

The hard rule: every file a released version wrote opens and gives the same numbers to the bit; a file this version writes without the new features is byte for byte the file the version before wrote; new fields are written only when not default.

**Default unchanged, by construction.** A run configuration without `method` runs node by node through today's `integrateNode`, not through the stage machinery with one stage: the code path that produces today's numbers is the code path that keeps producing them. The new methods are new functions beside it.

### Project document

| Change | Written when | Older files in this version | This version's files in older versions |
| --- | --- | --- | --- |
| `runConfigurations[].method` | only when not `nodeByNode` | absent: node by node, identical numbers | ignored: an older engine runs Euler node by node and its result records `explicitEuler` (decision 2) |
| `stepsPerGlobalStep`, `tolerance`, `coupling` on a run configuration | only when set and not default | absent | ignored; they only mean something with a method an older engine does not know |
| A state's `numerics.absoluteTolerance` | only when set | absent | kept by the codec's pass-through of unknown fields, ignored by the engine |
| The project document's `requires` | only when a model needs a feature that changes its numbers and that an engine must refuse rather than ignore; nothing writes it yet | absent: requires nothing | ignored by engines before this one; refused by name, entry by entry, by this engine and every later one that does not know an entry |

### Results and checkpoints

| Change | Older results in this version | This version's results in older versions |
| --- | --- | --- |
| `ResultCheckpoint.solver_kind` with new values | `explicitEuler`: continued node by node, as now | samples open and play; continuing from such a checkpoint in an older engine runs Euler (it does not check `solver_kind` today), from states that are exact |
| `ResultCheckpoint.solver_state` (field 7) | absent: no hidden state | skipped as an unknown protobuf field |
| The method and the stepped nodes in the result's execution summary | absent: node by node | skipped |

**Older engines reading a file that chooses a method** ignore `method` and run Euler, giving different numbers without saying so. The result records `explicitEuler`, so it is not hidden, but it is silent; this is accepted (decision 2), rather than writing a marker on every node that released engines would refuse. From the version that ships this, the engine refuses a `method` it does not know, by name, so the next method added cannot be silently ignored; and it refuses, by name, any entry of the document's `requires` it does not know, the lever later features that change numbers can use.

## Verification

The [benchmark suite](../../benchmarks/README.md) is the proof, with its rules unchanged: committed models, exact or independent references, thresholds in each `benchmark.json`, and a variant applied to a committed model recorded in every row (the method joins `integration` and substeps as a variant).

**The default, to the bit.**

- Every bundled example's digest (`tests/engine/expected/exampleDigests.json`) unchanged, and the same for the runs of the Logistics and Robotics Toolboxes' engine tests, replayed on the engine before and after each stage, as [Rates and updates](ratesAndUpdates.md) did.
- `benchmark:accuracy` passing with no threshold changed: its bands around explicit Euler's known weaknesses would catch any change to the default in either direction.
- A run configuration that says `method: "nodeByNode"` gives bits identical to one that says nothing; a file saved without new features is byte-identical to the previous version's.

**Order.** `verification/convergenceOrder` gains each method over the same halvings, on the thermal network, both RLC circuits, the oscillator and the pendulum: Runge–Kutta 4 between 3.9 and 4.1 over the halvings before the error reaches rounding; Dormand–Prince 5(4) run at fixed step (control off) between 4.9 and 5.1; Rodas4 between 3.9 and 4.1 on the same non-stiff problems. Adaptive methods are judged by **tolerance proportionality**: over tolerances from $10^{-3}$ to $10^{-10}$, the achieved error against the reference falls in proportion to the tolerance (fitted slope near 1) and stays within a stated factor of it, with a work–precision plot (evaluations against error) for each method in the report.

**Coupling.** `coupling/graphSplit` gains each whole-model method: the split model equals the one-node model to $10^{-12}$ relative, and its error against the exact solution has the method's order. Extrapolated coupling, when built: the split model's coupling error has order 2, and a stiffly coupled variant shows the stability limit it trades for it.

**Phase 3 problems.**

- **Lorenz** ($\sigma = 10$, $\rho = 28$, $\beta = 8/3$): trajectory error against a DOP853 reference at rtol $10^{-13}$ up to the horizon where the reference's own error is still negligible ($t \approx 20$); beyond it, properties of the attractor, not the trajectory.
- **Van der Pol** at $\mu = 1, 10, 1000$: error against a Radau reference; at $\mu = 1000$, Rodas4 completes in hundreds of steps where Dormand–Prince takes orders of magnitude more, and Dormand–Prince's stiffness finding fires.
- **Robertson** to $t = 10^{11}$, as one node and as three: concentrations against the published reference values at the standard checkpoints, $y_1 + y_2 + y_3 = 1$ to rounding, step count, and Rodas4's split model equal to its one-node model.
- **Prothero–Robinson** ($y' = \lambda(y - \varphi(t)) + \varphi'(t)$, $\lambda = -10^6$): Rodas4 keeps its order where a method that is not stiffly accurate loses it.
- **Stability boundaries**: for $y' = \lambda y$ at each method, the stability analysis's predicted largest step and the step at which a run begins to grow agree within 2 %.

**Determinism and restart.** Each method gives bits identical across serial, thread pool and partitioned at several worker counts, on `graphSplit`, Robertson as three nodes, and a toolbox model; a run to $T$ equals, to the bit, a run to $T/2$ continued from its checkpoint, for every method; a live parameter set and a held schedule's corner land on step ends under Adaptive (the internal steps are checked to stop there). WebAssembly against native: within rounding on the accuracy problems.

**Export.** The C++ export of each method reproduces the engine's samples to the bit, and the FMU fidelity and round-trip tests (`test:fmiExportFidelity`, `test:fmiRoundTrip`) run with each method, including `fmi2GetFMUstate` across an adaptive step.

## Order of work

1. **Runge–Kutta 4, whole model.** Built. The stage machinery on every backend; `method` and `stepsPerGlobalStep` read, validated and refused by name when unknown; stepped nodes and held programs (the `pure` declaration first planned here is left to [Program SDK version 2](programSdkV2.md), decision 5); the checkpoint's solver identity and `solver_state`; the Run dialog's Method with Euler and Runge–Kutta 4; the stability analysis through $R(z)$ and the whole model's Jacobian; the benchmark's order and coupling studies for it; C++ and Python export of it. Nothing ships until every digest is unchanged. FMU export refuses a whole-model method by name until FMI export of the methods is built; code export refuses, by name, a node that is a program of its own under a whole-model method.
2. **Dormand–Prince 5(4).** Built: `engine/include/konjugate/integrators/dormandPrince54.hpp`, with Hairer's PI controller (DOPRI5's constants), his initial step, his fourth-order dense output and his stiffness test ($h|\lambda| > 3.25$ for 15 accepted steps); tolerances and each state's own absolute tolerance; every step landing on the global step's end and on the corners of the schedules a stage can read (a step's, ramp's or pulse's start and end, a piecewise schedule's samples, a square, triangle, sawtooth or noise waveform's corners, from recorded interventions, input streams and stored schedules), the stages at a step's end that lands read just before it, so a jump there is not seen inside the step, and the next step starting from a fresh derivative; the error norm summed node by node in node order, so every backend and worker count gives the same bits; the stiffness test as the run's finding `adaptiveStepsLimitedByStiffness` ("Use Stiff" comes with stage 3); the controller's memory in the checkpoint's `solver_state`, so a run continued from a checkpoint is the uninterrupted run to the bit, and a session restored with states replaced starts the controller afresh; the result's execution summary with the steps taken and rejected and the model's evaluations; Adaptive in the Run dialog with its two tolerances, and the per-state tolerance on the node's Numerics tab, shown only under it; the stability analysis through Dormand–Prince's $R(z)$, which under Adaptive names a stiff model and the step stability will hold it to rather than calling any step unstable; tuning noting Adaptive on its card (decision 8); C++ and Python export, the header pasted in and ported line for line. Dense output is built (in the header, exported, and checked to be fourth order) but writes no samples: the output interval stays a whole number of global steps under every method, because Updates change only at global steps, and a sample between them would show Rate states at that instant beside Updates still at their values from the step's start (a sensor reading disagreeing with the level it is worked out from). It is kept for event location, the next stage. Given `stepsPerGlobalStep`, `dormandPrince54` takes that many equal steps with its error control off, which is how the benchmark measures its order (4.9 to 5.1); the Run dialog does not offer it. The benchmark's tolerance study runs relative tolerances from $10^{-3}$ to $10^{-10}$ on the order problems: slopes of 0.84 to 1.07, a little under 1 being Dormand–Prince's known behaviour (its error estimate is of order four), the error within 20 times the tolerance, with every run's work and a work–precision plot. FMU export still refuses it, as it refuses Runge–Kutta 4. Lorenz and Van der Pol at $\mu = 1, 10$ follow the benchmark's phase 3 problems.
3. **Rodas4.** The graph's Jacobian structure, coloured finite differences, Konjugate's own dense and sparse LU (checked against Eigen); Stiff in the dialog, and "Use Stiff" from the findings; Robertson, Van der Pol at $\mu = 1000$ and Prothero–Robinson in the benchmark.
4. **Analytic Jacobians** from MathJSON, used by Rodas4, the stability analysis and, where it helps, tuning; Rodas4's code and FMU export with the shared LU.
5. **Extrapolated coupling** for node by node, if the `graphSplit` study and a stiffly coupled variant show its accuracy is worth its narrower stability.
6. A **tutorial** on choosing a method, and the help page.
7. **Semi-implicit Euler made more prominent** (decision 1): the library's mechanical and electrical templates and the toolboxes' generated nodes write `integration: "semiImplicit"`, and the stability finding for a growing undamped oscillation offers "Use semi-implicit" for the node, and "Use Runge–Kutta 4" for the run, each one click and undoable. Not built in stage 1.

## Decisions

Taken on 23 November 2026, in answer to the proposal's eight open questions, with one addition.

1. **Semi-implicit Euler becomes more prominent, not a default.** The library's templates for mechanical and electrical parts, and the toolboxes' generated nodes, write `integration: "semiImplicit"` explicitly on the nodes they create, so new models get it and the file says so; the stability finding for a growing undamped oscillation offers "Use semi-implicit". Existing files never change meaning: absent `numerics.integration` stays explicit forever. Not a default by model type, for the reasons the proposal gave: "mechanical" is not something the engine can tell from a model, semi-implicit Euler depends on the order the states are listed, and it improves a node only within itself. This is a later stage (Order of work, item 7).
2. **No per-node marker for older engines.** A file that chooses a method does not write `numerics.integration: "model"` on its nodes. An older Konjugate opening it ignores `method` and runs Euler, node by node, and its result records `explicitEuler`: silent, but labelled, and the cost of a field on every node of such a file is not paid.
3. **New models keep Euler node by node as their default for now.** Whether a new model should start with Runge–Kutta 4 or Adaptive is decided after stage 3, with the benchmark's numbers.
4. **Default tolerances**: relative $10^{-6}$ and absolute $10^{-9}$ for the run, with a per-state absolute tolerance on a node's Numerics tab, shown only for the adaptive and stiff methods (stages 2 and 3).
5. **No `pure` declaration on version 1 programs, and the starter templates are unchanged.** First decided as "the templates declare `pure = true`"; replaced the same day by [Program SDK version 2](programSdkV2.md)'s open question 1, answered yes: a wrong declaration would corrupt results with no symptom, and, once the templates wrote it, every file made from them would carry it for good. Under a whole-model method every version 1 program is held (a term) or stepped (a node), and named, until it is written against version 2, whose purity follows from its shape. The engine keeps the question in one place (`ProviderEvaluator::declaredPure`), for version 2 to answer.
6. **Adaptive methods always land on the global step** (stage 2): exact restarts, and Updates and live control as now.
7. **Names**: "Method" in the Run dialog, with "Euler, node by node" and "Runge–Kutta 4" (and "Adaptive" and "Stiff" when they are built); `method` and `nodeByNode`, `rungeKutta4`, `dormandPrince54` and `rodas4` in the file; "Integration" stays the per-node word. The tableau is named only in the help and the result's execution summary ("Runge–Kutta 4 (classical, four stages, fourth order)").
8. **Tuning uses the run's method**: parameter tuning runs with the active run configuration's method and steps per global step. The tuning card notes it when the method is adaptive (stage 2).

**Addition: `requires` on the project document.** A list of the features a model needs that change its numbers, each named. This engine and every later one check it and refuse, by name, any entry they do not know, so a feature that must not be silently ignored by an engine that predates it has a way to say so. It is written only when needed, and nothing writes it yet: Runge–Kutta 4 does not, because its choice lives in the run configuration, which engines from this one on already refuse when they do not know the method, and engines before this one ignore `requires` as they ignore `method` (decision 2 accepts that). The engine knows no entries yet; the first feature that needs one adds its name to the engine's list.
