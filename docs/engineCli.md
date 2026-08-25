<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Engine CLI contract

The installed command will be `konjugate`; the development binary is `konjugateEngine`.

```text
konjugate inspect model.kjt --report report.json
konjugate validate model.kjt --report validation.json
konjugate run model.kjt --configuration runConfiguration.json --output simulationResult.bin
konjugate infer series.csv --report inference.json [--skeleton-threshold X] [--coefficient-threshold X] [--validation-fraction X] [--lags 1,2,3] [--ridge-penalties 0.01,0.1,1.0,10.0]
```

Reports are written atomically. Machine consumers should always provide `--report`; concise human output may be added later.

`infer` is the one command that does not take a `.kjt` project: its input is a CSV of multivariate time-series data (a numeric, strictly increasing, evenly spaced time column, then one numeric column per variable) and its report is a candidate-edge list, not a project report. It has no knowledge of Konjugate node/state IDs — its output is keyed by CSV column name, and a caller resolves those to concrete nodes/states itself. See [Causal inference](causalInference.md) for the algorithm and [Project schema](projectSchema.md) for how a candidate becomes a real edge.

Exit codes:

| Code | Meaning |
| ---: | --- |
| 0 | Command succeeded; validation found no errors |
| 2 | Validation completed and found blocking errors |
| 3 | Input, container, or payload is invalid |
| 4 | Encryption requires credentials or an unsupported feature |
| 5 | Engine execution failed |
| 64 | Invalid command-line usage |

Passwords must never be supplied as command-line arguments. The initial non-interactive integration uses the inherited `KONJUGATE_PASSWORD` environment variable; interactive prompting and protected platform channels may be added later.

The version 1 CLI run request contains a name plus finite positive `targetTime`, `globalTimeStep`, and `outputInterval` numbers; timestep and output interval cannot exceed the target time, and output interval is an integer multiple of the global timestep. It may also select automatic, serial, thread-pool or partitioned execution. See [Parallel execution](parallelExecution.md) for the configuration, selection rules and result telemetry.

A run configuration's `providers` object controls how programmable (C++/Python) relationships and source terms are built and executed — compiler/interpreter overrides and, for C++ providers, which of three execution transports to use. See [Provider execution transports](providerExecution.md).

The engine uses deterministic snapshot-coupled, node-local explicit Euler subcycling. The low-level `run` command writes an internal binary result segment for its Electron caller; it is not a user-facing project format. The segment contains engine and run metadata, global step count, each node's substep count and effective timestep, final state values, packed sampled states, complete checkpoints and execution diagnostics. Konjugate embeds this segment in `.kjt` when the user saves a model with results. See [Embedded binary result storage](resultFileFormat.md).
