<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Engine job protocol

**This document previously described a file-based status/cancellation protocol (`status.json`, `cancel.request`, `diagnostics.json`) that no longer exists.** It's been replaced by the live protobuf control/event stream described here and in [Protobuf architecture](protobufArchitecture.md); nothing in the current codebase reads or writes those three file names (confirmed by search — see `src/engineAdapter.mjs` for the real mechanism).

Each execution (`startEngineRun` in `src/engineAdapter.mjs`) uses a private temp directory holding only the static input/output files:

```text
konjugateRun-<random>/
├── input.kjt
├── runConfiguration.json
└── simulationResult.bin
```

Everything else — lifecycle, progress, cancellation, diagnostics — is live, not file-polled-on-disk-by-name:

- **The engine subprocess is spawned with `--control-stream protobuf`** (and `--event-stream protobuf` when a live consumer is attached). Sample data streams out over the child's **stdout** as framed protobuf `EngineEvent` messages (`FramedEngineEventDecoder`), decoded incrementally as they arrive — not read back from a file.
- **Cancellation and pacing changes are sent as commands over the child's stdin**, framed protobuf `EngineCommand` messages (e.g. `sendCommand({ type: 'setRunState', state: 'stopped' })`), not by creating a `cancel.request` file.
- **Lifecycle state** (`running`/`paused`/`completed`/`stopped`) is read from the `metadata_json` field embedded in `simulationResult.bin` itself — the engine writes this file incrementally during a live run, and the adapter polls and decodes it (`decodeResultFile`) every 100ms for as long as a consumer is attached, rather than maintaining a separate `status.json`. See [Result file format](resultFileFormat.md) for the embedded metadata field's shape.
- **Diagnostics** are captured directly from the child process's **stderr** stream into memory (`src/engineAdapter.mjs`), not written to a `diagnostics.json` file.

A job UUID is still generated (`randomUUID()`) and used as the in-app key for tracking a live run (`activeEngineJobs` in `src/main.mjs`), but it names an in-memory map entry, not the temp directory — the directory itself is an anonymous `mkdtemp` path, removed (`rm -rf`) once the run completes and its result has been consumed.

See [Protobuf architecture](protobufArchitecture.md) for the wire-level message shapes and the migration history that replaced the old file-based mechanism, and [Result file format](resultFileFormat.md) for what `simulationResult.bin` actually contains.
