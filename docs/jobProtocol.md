<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# File-based job protocol

Each execution uses a private directory named by job UUID:

```text
jobUuid/
├── input.kjt
├── runConfiguration.json
├── status.json
├── cancel.request
├── diagnostics.json
└── simulationResult.bin
```

Writers create a sibling temporary file and atomically rename it into place. Readers must ignore temporary files. `status.json` includes protocol version, job UUID, lifecycle state, progress, simulation time, and update sequence. Creating `cancel.request` asks the engine to stop at its next safe point. Successful jobs may be removed after results are imported; failed job directories may be retained with user consent.
