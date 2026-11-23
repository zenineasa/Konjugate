<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Konjugate benchmarks

Konjugate is evaluated against established numerical and engineering benchmarks, with reproducible reference comparisons, conservation checks and performance measurements. This directory holds those benchmarks: each problem's model, its reference, its configuration and its thresholds, and the runner that measures Konjugate against them and writes a report.

The benchmarks measure what Konjugate does today, including where it is weak. They are not a claim that Konjugate is accurate for every problem; they say how accurate it is for these, and why.

## What is being measured

By default Konjugate integrates every node with fixed-step Euler: explicit Euler, or semi-implicit (symplectic) Euler for a node whose `numerics.integration` is `semiImplicit` (`engine/src/executionPlan.cpp`, `compileExecutionPlan` and `integrateNode`). A semi-implicit node updates its states one after another in the order it lists them, each from contributions evaluated with the states already updated. Both methods are first order. A run configuration may instead choose Runge–Kutta 4 (`method: "rungeKutta4"`, [Integrators](../docs/proposals/integrators.md)), the classical fourth-order method applied to the whole model at once: at each of its four stages every node is evaluated from every node's stage values, so the coupling between nodes is as accurate as the method. There is no adaptive or stiff method yet.

Under Euler, each global step, every node takes its own substeps (`numerics.substepsPerGlobalStep`) and reads every other node through a snapshot frozen at the start of the global step ([Parallel execution](../docs/parallelExecution.md)). A relationship's bindings to its own target node read that node's live state; bindings to any other node read the snapshot. Coupling between nodes is therefore first order in the global step, whatever the substeps, and a semi-implicit node's sequential update applies only to its own states, never across nodes.

The problems were chosen to suit these methods: smooth, non-stiff systems where a first-order method converges and its behaviour can be measured cleanly. Stiff problems (Robertson's chemical kinetics, Van der Pol at large μ) and chaotic ones over long horizons (Lorenz) are left for when Konjugate has methods for them; with fixed-step Euler they would measure only that Euler is unsuitable, which is known.

## The problems

| Directory | Problem | Reference | What it shows |
| --- | --- | --- | --- |
| `thermal/rcNetwork` | Four thermal masses, five conductances, a 500 W heater and a fixed ambient, one node per mass | Matrix exponential (exact); SciPy `expm` as an independent check | Transient error, steady-state error, energy balance from Konjugate's own states |
| `electrical/rlcCircuits` | A series RLC circuit, and two RLC loops coupled through a resistor (one node per loop), under a 10 V step | Matrix exponential and the energy balance (exact); SciPy `expm` | Current and voltage error, energy dissipated against exact, energy-balance defect, explicit against semi-implicit |
| `mechanical/harmonicOscillator` | An undamped mass on a spring, one node | Closed form | Trajectory error; energy over a long run, explicit against semi-implicit |
| `mechanical/pendulum` | A pendulum released from rest at 2 rad, one node | Jacobi elliptic functions (exact); SciPy `ellipj` and `solve_ivp` | Trajectory error at large amplitude; energy over a long run |
| `population/lotkaVolterra` | Predator and prey over about 50 cycles, as one node and as two | SciPy `solve_ivp` (DOP853, rtol = atol = 1e-12); the conserved quantity is analytic | Drift of the conserved quantity; trajectory error; one node against two |
| `verification/convergenceOrder` | The thermal network, both RLC circuits, the oscillator and the pendulum, over six halvings of the step, and Runge–Kutta 4 over halvings of its own | The problems' own exact references | The observed order of accuracy of each method |
| `coupling/graphSplit` | Three damped masses on springs, as one node and as three | Matrix exponential (exact) | The error the snapshot coupling adds, against the global step and the node substeps; under Runge–Kutta 4, the split model equal to the one-node model and its error fourth order |
| `scaling/graphScalability` | Generated thermal chains, grids and random sparse networks, 100 and 400 nodes (to 100,000 under `--full`), on the serial, thread-pool and partitioned backends | Sums of sines (exact, for the chain and grid at any size, and for each method's own steps); the matrix exponential and an independent stepping for the random network | The same bits on every backend, the work as counted, the method's exact steps to rounding, the error against the exact solution, conserved heat; under `--full`, wall time split into compiling, solving and the rest, throughput, peak memory, parallel speed-up and efficiency |
| `causal/reconstruction` | 23 synthetic time series from known graphs and equations: topologies, noise, nonlinear terms, cases outside the model class, a continuous-time system sampled at four intervals | The generating graph and equations (`data/*.truth.json`) | Edge precision, recall and F1, direction, the error of the recovered equations, by `infer`; where it fails, and why |

Each problem directory holds:

- `problem.mjs`: the model, built as an ordinary Konjugate project document; the reference; and the evaluation, which runs the model, compares it with the reference and reports rows, checks and plots. The header comment states the equations.
- `benchmark.json`: the runs (global steps, horizons, output intervals), the timing cases for `--full`, and the thresholds every check is judged against.
- The `.kjt` models, written by `node benchmarks/generateModels.mjs` through the same project encoder the app saves with. They open in Konjugate like any other project. The runner refuses to run if a committed model differs from what its `problem.mjs` builds, so a model and its reference cannot drift apart.
- `reference.json`, where the problem has numerical reference data: the data, the method, the tolerances and the versions of Python, NumPy and SciPy that made it.

A run may apply a variant to a committed model before running it, and only three kinds, recorded in every result row: the integration method of every node (`explicit` or `semiImplicit`), the substeps of every node, and the run's method (`rungeKutta4`, set on the run configuration the engine is given, not on the model). Everything else is the committed model.

### Graph scalability

`scaling/graphScalability` generates its models when it runs (`graphs.mjs` states the equations; no `.kjt` is committed): a chain of n thermal masses with both ends held at ambient, an m × m grid with its edges held at ambient, and a random sparse network (a ring plus n random paths, seeded, random conductances and capacities, no ambient). `node benchmarks/scaling/graphScalability/graphs.mjs <chain | grid | random> <nodes> <output.kjt>` writes one to open in Konjugate. The chain and grid start as a sum of three of their sine modes, so their exact motion, and each fixed-step method's exact result (a mode grows by 1 + hλ a step under Euler, by the fourth-order polynomial in hλ under Runge–Kutta 4), is known at every node at any size: Konjugate's numbers are checked against the method's exact steps (they agree to about 1e-14) and against the exact solution (the method's error). The random network is checked against the method stepped independently in the benchmark, by the matrix exponential at 100 nodes, and by its conserved total heat. Every graph runs on all three backends with the workers and partitions fixed (4 each), so the accuracy run's results do not depend on the machine; the backends must agree bit for bit. Methods are entries in its `benchmark.json`, so Dormand–Prince and Rodas4 can be added as variants: a method with no exact steps to compare with is judged against the exact solution only.

Under `--full`, the problem's `measure()` times the same families at 100, 1,000, 10,000 and 100,000 nodes (each case about a million node steps, three timed runs, two at 100,000 nodes), on every backend under every method, and sweeps the worker count from 1 to 8 on a 10,000-node grid. It reports the engine process's wall time split into compiling and planning (the engine's `planningNanoseconds`), solving (its synchronization compute time) and the rest (starting, reading and validating the project, writing the result), node steps per second of solving, peak resident memory, and each parallel backend's speed-up over serial and efficiency per worker. A million nodes is not measured: the project would be about 1.45 GB of JSON, more than the project encoder can hold in one string, and the engine's validation alone would take minutes; the report says so.

### Causal reconstruction

`causal/reconstruction` measures Konjugate's causal inference (`konjugateEngine infer`, [Causal inference](../docs/causalInference.md)) on datasets whose truth is known. `datasets.mjs` generates each one from a seed: a discrete structural model stepped once per row (lag-1 linear terms, a self-lag, powers of a source, a source-target product, and, deliberately outside the model `infer` fits, a delay of two rows, an effect within one row, a hidden variable and a near-noiseless copy), or a continuous-time linear system integrated by Euler–Maruyama and sampled every 0.1, 0.5, 1 or 2 s. The CSVs and their truths are committed in `data/` (about 1.1 MB); the runner regenerates each in memory and refuses to run if a committed CSV differs. For each, the graph is hidden and `infer` runs on the CSV alone, with its default settings except the polynomial degrees or interaction terms a dataset calls for. A proposed edge is one with a lagged fit and a direction (`continuousLagged`); precision, recall and F1 are over those, a skeleton F1 also counts the `correlationOnly` pairs, direction is the share of found true edges reported in exactly the right direction, and the equation error is ‖estimated − true rates‖ / ‖true rates‖ over every true or proposed edge, in the engine's own units (rates per second of the CSV's time column). Datasets inside the model class have a floor on F1 just below its observed value; datasets showing a known limit have a band on both sides of the measure that shows it, and each says why it fails.

## References

Analytic references are preferred, and every problem but Lotka–Volterra has one. Linear systems (the thermal network, the RLC circuits, the coupled masses) are solved exactly with the matrix exponential of the augmented system [[A, b], [0, 0]] (`lib/linearAlgebra.mjs`, Higham's scaling and squaring with a degree 13 Padé approximant), solved about an offset near the solution (the ambient temperature) so that the exponential stays well scaled. The pendulum's exact motion is in Jacobi elliptic functions, computed by the arithmetic-geometric mean (`lib/elliptic.mjs`). The energy an RLC circuit dissipates follows exactly from its energy balance: the source's work less the energy stored.

The analytic references are themselves checked: `reference/generateReferences.py` computes each one again, independently, in Python with SciPy (`scipy.linalg.expm`, `scipy.special.ellipj`), from its own copy of the constants and equations, and each benchmark run reports how closely the two agree (relative to each quantity's magnitude, currently between 3e-15 and 1e-12).

Where there is no closed form, the reference is a numerical solution by an independent high-accuracy solver: SciPy's `solve_ivp` with the 8th-order Dormand–Prince method (DOP853) at rtol = atol = 1e-12. A numerical reference is never treated as absolute truth. Its own error is recorded where it can be measured (the drift of Lotka–Volterra's conserved quantity in the reference is about 1e-10 of the orbit's size), and it is used only where that error is far below the errors being measured. The pendulum is also solved with DOP853, as a check of the method on a problem whose answer is known.

To regenerate the reference data, in a virtual environment outside the repository (the environment is not committed; the data and the script are):

```bash
python3 -m venv /tmp/konjugate-benchmarks-venv
/tmp/konjugate-benchmarks-venv/bin/pip install numpy scipy
/tmp/konjugate-benchmarks-venv/bin/python benchmarks/reference/generateReferences.py
```

## Metrics

Every comparison is made at the run's output samples, which are the same for every step size in a study.

- **Max abs error**: the largest |Konjugate - reference| over every compared state and sample, in the states' own units.
- **RMSE**: the root mean square of the same differences.
- **Relative error**: for each state, its largest absolute error divided by the reference's range over the run (max - min); the largest over the states. The range is used rather than the value, so a temperature near 300 K or a current passing through zero is judged against how much it actually moves.
- **Conservation error**: the problem's conserved or balanced quantity, from Konjugate's own states. For the thermal network, the energy balance Σ C ΔT against heat supplied less heat lost, relative to heat supplied. For the RLC circuits, the source's work V q against energy stored plus energy dissipated, relative to the source's work. For the oscillator and pendulum, the largest drift of the energy relative to its initial value (for the pendulum, relative to the energy above the bottom of the swing, E(0) + g L). For Lotka–Volterra, the largest drift of V = δx - γ ln x + βy - α ln y relative to V(0) - V*, the orbit's level above the equilibrium.
- **Steady-state error**: the largest difference between the final state of a long run and the exact equilibrium A x* = -b.
- **Observed order**: p in error ≈ C hᵖ, from each halving of the step (log₂ of the error ratio) and as the least-squares slope of log error against log h. Euler's methods should show p ≈ 1, Runge–Kutta 4 p ≈ 4. Runge–Kutta 4 is judged over step sizes of its own (`rungeKutta4GlobalSteps` in `verification/convergenceOrder/benchmark.json`), chosen where its error is well above rounding and its step inside its stability region: at Euler's steps its error would reach rounding within a halving or two.
- **Coupling error**: for the split model, its difference from the one-node model run at the same effective step (the global step divided by the substeps), relative to range.
- **Work**: the global steps, the node substeps executed and the contributions evaluated, summed over nodes, as the engine reports them (`execution.nodeMetrics`).

## Thresholds

Every check is judged against a threshold in its problem's `benchmark.json`, so a change in Konjugate's numbers shows up as a failing check rather than a silent difference. Accuracy is deterministic: the same engine on the same platform gives the same numbers, and across platforms they differ only by rounding. The thresholds are set as follows:

- An error at a configured step has a ceiling about 25 % above its observed value: a regression guard, not a claim that the error is small.
- A known weakness of explicit Euler (the growth of an undamped oscillator's energy, the drift of Lotka–Volterra's conserved quantity) has a band on both sides of its observed value, so a change to the integrator that alters it in either direction is noticed and the benchmark updated knowingly.
- Quantities that should be at rounding level (an energy balance that explicit Euler keeps exactly, a steady state it reaches exactly, the agreement of two exact references) have absolute limits a few orders above rounding.
- Identities (a split model with one substep against one node, semi-implicit against explicit integration for one-state nodes, and under Runge–Kutta 4 the split model against one node at any step) must hold exactly, or to 1e-12.
- Euler's observed orders must lie within 0.95 to 1.10 (fitted over all six steps) and 0.97 to 1.03 (from the finest halving); Runge–Kutta 4's within 3.9 to 4.1, both fitted and from the finest halving.

When a deliberate change to the engine moves a result, the threshold is updated with the change, and the reason recorded in its commit.

## Running

```bash
npm run benchmark:accuracy   # builds the engine, then: node benchmarks/run.mjs --accuracy
npm run benchmark:full       # builds the engine, then: node benchmarks/run.mjs --full
npm run benchmark:models     # writes the .kjt models from the problems
```

`--accuracy` runs every problem, deterministically and with no timing, and exits with status 1 if any check fails. It takes about twenty seconds and writes to `out/benchmarks/accuracy/`. `--full` runs the same accuracy checks and then the timing cases, and writes to `benchmarks/results/<version>/<machine>/`. Other options: `--engine <path>` (or `KONJUGATE_ENGINE`) to use a particular engine build, `--output <dir>`, `--only <text>` to run the problems whose ID contains the text, and for `--full`, `--repeats <n>` (default 7), `--warmup <n>` (default 1) and `--no-caffeinate`.

Each run writes:

- `report.html`: one self-contained page (no network, no external files) with every problem's plots of Konjugate against its reference, its checks and its result rows, and for `--full` the timings and the machine. Each plot has a data table, and its full data is in `plots/`.
- `results.csv`: every result row, with the columns described under Metrics.
- `checks.csv`: every check, its value, its threshold and whether it passed.
- `summary.json`: the run (versions, commit, mode), the totals, every problem's rows and checks, and for `--full` the machine and timings.
- `plots/<id>.svg` and `plots/<id>.csv`: each plot on its own, and its data.
- `timing.csv` (`--full` only): each timing case's runs, median and spread.

## Timing

Timing is measured only by `--full`, and only means anything on the machine that measured it. It depends on the processor, its power state and thermal state, the operating system's scheduling and whatever else is running, none of which travel with the code. So `--full` records the machine with its results (model, processor and core counts, memory, operating system, power source, battery charge and Low Power Mode where the platform reports them, and the load average at the start; never its host name, user or serial number), and its results are kept per version and per machine under `benchmarks/results/`. Comparing timings across machines, or across versions measured on different machines, compares the machines as much as Konjugate.

For each timing case, the runner makes untimed warm-up runs, then the timed runs one at a time, and reports the median wall time with its minimum, maximum and median absolute deviation, the median of the engine's own integration time (`execution.synchronizationComputeNanoseconds`), the node substeps integrated per second, and the engine process's peak resident memory (from `/usr/bin/time` on macOS and Linux). Wall time covers the whole engine process: starting, reading the model, integrating and writing the result.

Timing runs need a quiet machine. Before timing, the runner looks for Konjugate's interaction test runners, Konjugate's own Electron (the development build or the installed app) and test-driven Chrome, and warns if any is running, as it does when the computer is on battery or in Low Power Mode; the warning is kept in the report. On macOS it runs under `caffeinate -ims`, so the computer does not sleep or idle-throttle during the run.

## Running on release in CI

The accuracy benchmarks are suitable for CI, but no workflow runs them yet. To run them on every published release, a workflow like this one would do it (not active; add it to `.github/workflows/` when wanted):

```yaml
name: Benchmarks
on:
  release:
    types: [published]
jobs:
  accuracy:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npm run setup
      - run: npm run benchmark:accuracy
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: benchmark-accuracy
          path: out/benchmarks/accuracy/
```

Timing is deliberately not part of it: a shared CI runner's timings say more about the runner than about Konjugate.

## Adding a problem

Make a directory `benchmarks/<category>/<problem>/` with a `problem.mjs` exporting `directory`, `models` (each a function returning a project document, built with `lib/project.mjs`) and `evaluate({ engine, config })`, which returns `{ rows, checks, plots, notes }` (helpers in `lib/study.mjs`), and a `benchmark.json` with its runs, timing cases and a threshold for every check it adds. Register it in `problems.mjs`, write its models with `npm run benchmark:models`, and if it needs numerical reference data, add it to `reference/generateReferences.py`. A problem whose models are generated when it runs exports an empty `models`; one that times its own cases under `--full` (generated models, several backends) also exports `measure({ engine, config, repeats, warmupRuns })`, which returns `{ timings, rows, plots, notes }` (`scaling/graphScalability` does).
