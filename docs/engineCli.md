<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Engine CLI contract

The installed command will be `konjugate`; the development binary is `konjugateEngine`.

```text
konjugate inspect model.kjt --report report.json
konjugate validate model.kjt --report validation.json
konjugate run model.kjt --configuration runConfiguration.json --output simulationResults.kjr
```

Reports are written atomically. Machine consumers should always provide `--report`; concise human output may be added later.

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

The version 1 run configuration contains a name plus finite positive `duration`, `globalTimeStep`, and `outputInterval` numbers; timestep and output interval cannot exceed duration, and output interval is an integer multiple of the global timestep. The engine uses deterministic snapshot-coupled, node-local explicit Euler subcycling. A `.kjr` result contains `resultVersion`, engine and run metadata, global step count, each node's substep count and effective timestep, final state values, and sampled states at the requested synchronization intervals.
