---
type: Reference
title: Engine CLI contract
description: Command-line invocation syntax, arguments, validation, and exit code contracts for the native konjugateEngine CLI.
tags: [cli, engine, headless, reference]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Engine CLI contract

The installed command will be `konjugate`; the development binary is `konjugateEngine`.

```text
konjugate capabilities [--protobuf]
konjugate inspect model.kjt --report report.json
konjugate validate model.kjt --report validation.json
konjugate run model.kjt --configuration runConfiguration.json --output simulationResult.bin
konjugate infer series.csv --report inference.json [--skeleton-threshold X] [--coefficient-threshold X] [--validation-fraction X] [--lags 1,2,3] [--ridge-penalties 0.01,0.1,1.0,10.0] [--degrees 1,3] [--include-interaction-terms true]
konjugate fit model.kjt measured.csv --report report.json [--backend nlopt-bobyqa] [--max-iterations 200]
konjugate session model.kjt --configuration session.json
```

Reports are written atomically. Machine consumers should always provide `--report`; concise human output may be added later.

`capabilities` reports what this build can do, without touching a project at all: METIS partitioner availability/version and the list of optimizer backend IDs `fit` will accept in this build. Plain `capabilities` prints one line of JSON to stdout (`{"metis":{"available":...,"version":"..."},"optimizerBackendIds":[...]}`); `capabilities --protobuf` writes a framed `EngineEvent` with a `capabilities` field instead, matching `run --event-stream protobuf`'s wire format. Both exit `0` unconditionally.

`session` sets a validated model up once and then stays running, driven by framed protobuf `EngineCommand`s on stdin and answering with `EngineEvent`s on stdout until stdin closes ([Live engine session](proposals/liveEngineSession.md)). Its configuration has a `globalTimeStep` and an `outputInterval`, no `targetTime`, and optionally `reportedStateIds` (whose samples are sent; every state by default), `checkpointInterval` (the output interval by default) and the run's `execution` and `providers` settings. It first sends a `stateTable` with every state, in the order whole state vectors are given and taken in. Its commands: `advanceTo` (step to a time, a whole number of steps after the time last restored to, sending the reported states' samples and keeping checkpoints at checkpoint times only when `take_checkpoints` is set), `restoreCheckpoint` (back to a kept checkpoint with some states replaced; a state the model computes from others is refused), `restoreState` (the whole state, every node provider's saved state and every version 2 program's memory, from the command), `appendInputSamples` (readings that drive a shared parameter, held between them, ahead of any other value; `replace` with `replace_from` drops the readings from that time first, for a correction), `retainCheckpointsFrom` (forget older checkpoints and input readings), and the run's own pacing and parameter commands. Each is answered by a `sessionReply` naming its sequence, with `ok`, the reason when it was not carried out, the session's time, how long it took, how many checkpoints an advance kept, and for a restore the whole state, the provider states and the programs' memory. A command that fails changes nothing, and the commands after it with the same `batch` number are not carried out. `src/engineSession.mjs` is the client the app and the tests use.

`checkProgram program.(cpp|py) --configuration check.json --report report.json` runs Check program ([Writing a program](programs.md#testing-a-program)) on a version 2 program: `check.json` is `{ kind: "cpp" | "python", providers, inputs: { key: value }, time }`, and the program is loaded as a run loads it (a C++ one compiled and run in-process, a Python one in its worker). The report is `{ ok, program, kind, inputs, problems, outputs, memory }`: each problem a sentence (a key a file cannot bind, a port declared twice, an output not set or not a finite number, an evaluation that differs when made twice, memory that does not survive a round trip into a fresh instance, a Jacobian that disagrees with differences, or why the program could not be loaded, with its line). It exits `0` whenever it could write the report. The web engine answers the same command with the same report (`checkProgramWithWebEngine` in `src/webEngineAdapter.mjs`, `window.engine.checkProgram` in the web edition), a Python program served by the in-browser Python a run uses; it cannot load a C++ program yet, and says so as the report's one problem.

`describeProgram program.(cpp|py) --configuration describe.json --report report.json` describes a version 2 program for the code editor's Ports panel: the program is loaded as a run loads it and `initialize()` runs once, and nothing is evaluated. `describe.json` is `{ kind: "cpp" | "python", providers, inputs: { key: value }, ports: { inputs: { key: boundUnit }, outputs: { key: { unit, rate } } } }`, all but `kind` optional: `inputs` are the values `initialize()` sees (one not given reads its default, or 0), and `ports` says what each port is bound to, an input by the unit of the state or parameter it reads, an output by its state's unit and whether that is a Rate state (which takes the unit per second). It exits `0` whenever it could write the report, and the web engine answers the same command with the same report (`describeProgramWithWebEngine` in `src/webEngineAdapter.mjs`; `describeProgramWithEngine` in `src/engineAdapter.mjs` on the desktop). The report:

```
{
  "ok": true,                      // false when there is a problem
  "language": "cpp" | "python",
  "program": "PidController",      // "" when the program could not be loaded
  "kind": "node" | "relationship", // "" when the program could not be loaded
  "inputs": [{ "key", "kind": "input" | "parameter" | "constant", "unit", "default"?, "line", "conversion"? }],
  "outputs": [{ "key", "unit", "dependsOn"?: [key], "line", "conversion"? }],
  "memory": [{ "name", "type": "real" | "integer" | "flag" | "reals" | "random", "count", "unit", "start": [number] | null, "line" }],
  "clock": null | { "period": number | null, "constant": key | null, "line" },
  "problems": [{ "message", "line" }]
}
```

Ports, memory and the clock are in declaration order. `line` is the 1-based line of the source that declares it, or `null`: Python's SDK records it as the class is made; for C++ it is the first line of code (comments left out) whose declaration names the key after `this` (`k::Input setpoint{this, "setpoint", "K"}`). `start` is the field's value after `initialize()`, `null` for a random stream or when `initialize()` failed. A clock's `period` is in seconds, read from its constant when it has one. `conversion` is present only for a port `ports` names, and is the conversion a run applies there, from the engine's unit catalogue (the app's, src/units.mjs): `{ scale, offset, identity, text }` (value in the port's unit = bound value × scale + offset for an input; value in the state's unit = output × scale + offset for an output, with no offset into a Rate state; `text` such as `"°C → K at the port"`, or `null` when nothing is converted), or `{ error }` when the units measure different kinds of quantity or one is not known. A port or a binding without a unit is not checked and converts nothing. A problem's `line` is the line it names (a compiler's `file.cpp:41:32: error`, a program's "Line 18."), or `null`. The same conversions are worked out without the engine by `src/programPortUnits.mjs`, which `tests/engine/programDescription.mjs` holds to the engine's answers.

`infer` is the one command that does not take a `.kjt` project: its input is a CSV of multivariate time-series data (a numeric, strictly increasing, evenly spaced time column, then one numeric column per variable) and its report is a candidate-edge list, not a project report. It has no knowledge of Konjugate node/state IDs — its output is keyed by CSV column name, and a caller resolves those to concrete nodes/states itself. See [Causal inference](causalInference.md) for the algorithm and [Project schema](projectSchema.md) for how a candidate becomes a real edge.

`fit` calibrates a model's own `parameters[].tuning`-marked parameters, and its `sharedParameters[].tuning`-marked shared parameters (one optimization variable each, however many parameters link to it), against a measured CSV (same shape as `infer`'s input: a time column plus one column per variable), auto-mapping CSV columns to states by name -- a bare state symbol or name, or the `Node — State (unit)` heading the CSV export writes (the unit suffix is ignored), which names one state unambiguously even when several nodes share state names, so a run exported from the app can be used directly as measured data. It requires the project to have at least one tunable parameter and at least one CSV column that maps to a state, and fails outright before optimizing if either is empty. `--backend` selects one of the optimizer backend IDs `capabilities` lists; `--max-iterations` bounds the optimizer's own iteration budget. Unlike every other command, `fit` distinguishes "ran to completion" from "found a good fit" -- see the exit-code table below. `--objective-file` replaces the squared error with an objective: `{ expression, direction, targetTime, timeStep, variables, constraints }`, each constraint `{ expression, relation: "<=" | ">=", limit }` or, for an objective that is a program, `{ report, relation, limit }`, which limits the number the program reports by that name on the same trial (a trial whose program did not report it fails, saying what it did report; a `report` limit with an objective that is not a program is refused before the fit), or, in place of `expression`, `program: { language: "cpp" | "python", source, bindings: [{ key, kind: "state" | "parameter" | "measured", id, column }], python: { interpreter, sdkPath }, cpp: { compiler, sdkPath }, buildDirectory, timeoutSeconds }`. A program is given each trial's run, by the keys of its bindings, and returns the number; it runs in its own process, started once for the fit (a C++ one compiled first against `include/konjugate/objectiveProgram.hpp` and linked with `src/objectiveProgramMain.cpp`, a Python one as `python -m konjugate.objective`), and a crash, a hang past `timeoutSeconds` or an exception fails only that trial. A program that cannot be made ready (does not compile, binds a parameter that is not tuned) stops the fit before any simulation, with the reason.

Exit codes:

| Code | Meaning |
| ---: | --- |
| 0 | Command succeeded; validation found no errors |
| 1 | `fit` ran to completion but did not converge |
| 2 | Validation completed and found blocking errors |
| 3 | Input, container, or payload is invalid |
| 4 | Encryption requires credentials or an unsupported feature |
| 5 | Engine execution failed |
| 64 | Invalid command-line usage |

Passwords must never be supplied as command-line arguments. The initial non-interactive integration uses the inherited `KONJUGATE_PASSWORD` environment variable; interactive prompting and protected platform channels may be added later.

The version 1 CLI run request contains a name plus finite positive `targetTime`, `globalTimeStep`, and `outputInterval` numbers; timestep and output interval cannot exceed the target time, and output interval is an integer multiple of the global timestep. It may also choose the integration `method`, `nodeByNode` (the default, also when absent), `rungeKutta4`, with `stepsPerGlobalStep` (an integer from 1 through 10,000, absent meaning 1), or `dormandPrince54` (Adaptive), `rodas4` (Stiff) or `bdf` (BDF, which refuses `stepsPerGlobalStep`), each with `tolerance.relative` (above 0 and below 1, absent meaning 1e-6) and `tolerance.absolute` (above 0, absent meaning 1e-9), each state's `numerics.absoluteTolerance` in the document overriding the absolute one, and, to turn its error control off, `stepsPerGlobalStep` equal steps a global step; a method the engine does not know is refused by name ([Integrators](proposals/integrators.md)). It may also select automatic, serial, thread-pool or partitioned execution. See [Parallel execution](parallelExecution.md) for the configuration, selection rules and result telemetry.

A run configuration's `providers` object controls how programmable (C++/Python) relationships and source terms are built and executed — compiler/interpreter overrides and, for C++ providers, which of three execution transports to use. See [Provider execution transports](providerExecution.md).

By default the engine uses deterministic snapshot-coupled, node-local explicit Euler subcycling; under `rungeKutta4` it steps the whole model at once, stage by stage, with every backend evaluating each stage from one immutable vector of stage values, so serial, thread-pool and partitioned runs give the same bits. A result of a whole-model run records `integration` in its metadata (`method`, `stepsPerGlobalStep`, the `steppedNodeIds` stepped on their own and the `heldTerms` held; under `dormandPrince54` also its `tolerance`, the `steps` it took, the `rejectedSteps`, its `evaluations` of the model, its `smallestStep` and `largestStep`, and `stiffnessDetectedAt` when its stiffness test fired, which also adds the stability finding `adaptiveStepsLimitedByStiffness`; under `rodas4` its `tolerance`, `steps`, `rejectedSteps`, `evaluations`, `smallestStep` and `largestStep` as well, and its linear algebra: how the Jacobian was worked out (`jacobian`: `analytic`, the default, `finiteDifference` or `check`, as the run configuration's `jacobian` says, refused by name when unknown or given to a method that works out no Jacobian), how many of its columns exactly from the equations' derivatives (`exactColumns`), the `jacobians` it worked out, the `jacobianColours` each took an evaluation per for its other columns, under `check` a `jacobianCheck` (the Jacobians `checks`ed against finite differences and the `largestDifference`, each entry scaled as the error control weighs the states and relative to the largest so scaled, with its `time`, `rowStateId` and `columnStateId`), its `factorisations`, the `linearSystemSize`, whether it was solved `sparse`, and `denseFallbacks` when the sparse LU could not pivot on its diagonal; under `bdf` the same, with its `newtonIterations`, the `highestOrder` it reached and the `restarts` of its history at order 1), and, for a model with switching conditions (comparisons inside a `Which` condition of a Rate equation), `switchingConditions`, the `events` located (instants) and an `eventList` of the first thousand (`time`, `sourceId`, `stateId`), each switch located and stepped to under every whole-model method; under Euler, node by node, such a result says instead which conditions it did not locate (`unlocatedConditions`, top level), and a run whose switches chatter adds the stability finding `eventsChattering`. Its checkpoints' `solver_kind` is `rungeKutta4`, `dormandPrince54`, `rodas4` or `bdf` rather than `explicitEuler`, and with switching conditions their `solver_state` (record version 2) also keeps every condition's latch; a `dormandPrince54` checkpoint's `solver_state` keeps the step the controller proposes next and its previous error, a `rodas4` one also the last accepted step, and a `bdf` one its table of differences, order and step and every state as it left them (with switching conditions, record version 2 of its own, the latches after them), so a run continued from it, passed back as `startCheckpoint` with its `solver` (`kind`, and `state` as base64), takes the uninterrupted run's steps to the bit. A document whose `requires` names a feature this engine does not know is refused by name by every command. The low-level `run` command writes an internal binary result segment for its Electron caller; it is not a user-facing project format. The segment contains engine and run metadata, global step count, each node's substep count and effective timestep, final state values, packed sampled states, complete checkpoints and execution diagnostics. Each node's compute time in those diagnostics is measured node by node on the thread-pool and partitioned backends. On the serial backend, where the nodes run one after another, each global step (node by node) or stage (whole model) is timed once and its time shared among the nodes, by each one's estimated operations a substep times its substeps or by the contributions it evaluated (timing every node cost from a quarter to over half of a run of small nodes), so the total stays a measurement and each node's figure is an estimate. Konjugate embeds this segment in `.kjt` when the user saves a model with results. See [Embedded binary result storage](resultFileFormat.md).

## Getting a portable result: `konjugate --cli`

Everything above is the low-level engine binary's own contract -- its `run` command exists for Konjugate's Electron process to spawn, and its binary output is that internal segment format, not something to read directly. For an actual end-user command that runs a project and writes a portable result file, use the `--cli` wrapper instead (implemented in `src/main.mjs`'s `runCliMode()`, spawning the same engine underneath):

```text
konjugate --cli run <project.kjt> --target-time <seconds> [--configuration <name-or-id>] [--output-kjt <path>] [--output-csv <path>]
konjugate --cli validate <project.kjt>
```

In the development tree (unpackaged), invoke it as `electron . --cli run ...` from the repo root; the packaged/installed `konjugate` binary accepts the same `--cli run|validate ...` arguments directly. Call the app's own executable, not a shortcut or `open`, so that output streams back and the exit code is the run's:

```bash
# macOS
/Applications/Konjugate.app/Contents/MacOS/Konjugate --cli run model.kjt --target-time 30 --output-csv result.csv

# Windows
Konjugate.exe --cli run model.kjt --target-time 30 --output-csv result.csv

# Linux: the apt package puts konjugate on PATH; an AppImage is run directly
konjugate --cli run model.kjt --target-time 30 --output-csv result.csv
./Konjugate-*-$(uname -m).AppImage --cli run model.kjt --target-time 30 --output-csv result.csv
```

A command-line run is always its own process, even while the app is open.

- `--target-time <seconds>` is required for `run`; the project's active run configuration is used unless `--configuration` names or numbers a specific one. A project that keeps no run configuration (most of the bundled examples) runs with the one the app gives it when it opens: "Default", a 0.01 s step and a 0.1 s output interval.
- `--output-kjt <path>` writes the original project with the result embedded, in the same format Konjugate itself saves when you keep a run's results (see [Embedded binary result storage](resultFileFormat.md)) -- reopen it in the app to inspect the run visually.
- `--output-csv <path>` writes a plain CSV: one `time (s)` column, then one column per state headed `Node — State (unit)`, one row per sample. This is not a separate converter reading the binary segment back out -- it calls the exact same conversion function (`resultSignalsToCsv` in `src/resultExport.mjs`) the in-app "Export CSV" button uses, so CLI and GUI output are guaranteed to agree. Pass either or both flags; if neither is given, the run still executes but nothing is written.
- `validate` prints the validation report as JSON to stdout, exit code `0` if valid, `2` if it found blocking errors.
- A project saved with a password is read with the password in the `KONJUGATE_PASSWORD` environment variable, never a flag, so it stays out of shell history and the process list.
- Exit codes: `0` done, `1` the project could not be read or the engine failed, `2` the command was wrong (usage, `--target-time`, an unknown `--configuration`) or `validate` found blocking errors. [tests/cliMode.e2e.mjs](../tests/cliMode.e2e.mjs) checks each of these against the app itself (`npm run test:cli`).

### The push service from the command line

```
konjugate --cli serve [--port 8737] [--grpc-port 8738] [--record <file.csv>] [--inputs <signal,...>]
                      [--network [--certificate <file.pem> --private-key <file.pem>]]
konjugate --cli serve keys list
konjugate --cli serve keys add <name> --signals <signal,...>
konjugate --cli serve keys revoke <name>
```

`serve` runs the push service ([The push service](proposals/pushService.md), implemented in `src/pushCli.mjs`) in the foreground on the loopback address, for a lab computer with no screen: it prints the addresses, each client as it connects and the rate every ten seconds, and writes what arrives to a Konjugate data log as it comes (`pushed <time>.csv` in the current folder unless `--record` names one), with the signals named by `--inputs` as inputs and the rest measured. Ctrl+C stops it, telling each open connection why. The keys are the app's own (kept in its folder as hashes), so a key made here works in the app and the other way round; `keys add` shows the key once. `serve` refuses to start with no keys, since no script could send anything. With `--network` it listens on every interface, encrypted (HTTPS, secure WebSockets and gRPC over TLS), with Konjugate's own certificate (the app's, made the first time) or the one given with `--certificate` and `--private-key`, and prints the addresses, the certificate's file and SHA-256 fingerprint to give to the scripts, and the command that runs the simulated rig against it (`examples/dataSources/pushTankRig.py`).

Exit codes for `--cli` are simpler than the low-level table above, not the same values: `0` success, `2` bad usage (missing `--target-time`, an unresolvable `--configuration`, a project with no run configurations, or `validate` finding errors), `1` any runtime failure (the project couldn't be read, the engine was unavailable, the simulation itself failed, or an output path couldn't be written).
