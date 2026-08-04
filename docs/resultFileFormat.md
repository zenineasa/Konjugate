<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Binary result format

`.kjr` is Konjugate's only durable simulation-result format. It is a binary container and is not JSON-compatible.

The container begins with the four bytes `KJR\x01`, followed by a four-byte unsigned big-endian Protobuf payload length and one serialized `ResultFile` from `protocol/engineProtocol.proto`. Readers reject an unknown magic value, inconsistent length or unsupported result version.

`ResultFile` contains a stable numeric state table, one columnar `SampleBatch` and complete restart checkpoints. Sample timestamps and state values are packed IEEE-754 doubles in sample-major state-table order. Each checkpoint stores its UUID, time, solver identity and one packed state vector in the same order. State IDs are therefore recorded once rather than repeated for every numerical value.

Execution, dependency, partition and lifecycle metadata remains a UTF-8 JSON field during this migration slice. It does not contain sample or checkpoint arrays. A later protocol revision can replace that field with typed messages without changing the packed numerical layout.

Live samples use the same `SampleBatch` layout over the framed stdout event stream. The engine aggregates samples available between result publications into a representative batch of at most 256 samples, retaining both time boundaries. This live projection does not alter the complete samples written to the final `.kjr`. Live `.kjr` snapshots contain metadata but do not repeatedly rewrite accumulated numerical history; stopped and completed snapshots contain the complete packed samples and checkpoints. Electron retains only the latest streamed batch for live presentation instead of repeatedly cloning a growing history. It validates dimensions before reconstructing the current renderer-facing result view.

Electron's main process owns the completed result and does not transfer its complete nested sample graph to the renderer. The renderer receives a time-preserving playback projection bounded by both sample count and scalar value count. Full-resolution state series are filtered and downsampled in the main process on request, and the retained result is released when results mode closes. This keeps playback and plots responsive without weakening the authoritative `.kjr` data.

Completed-result playback follows a wall-clock playhead rather than creating one timer for every stored sample. Numeric playback rates are literal: 1× advances one simulated second per wall-clock second. When a result completes, the UI selects 1× for durations through 300 seconds, 2× through 600 seconds, 5× through 1,800 seconds and 10× for longer results. Automatic selection is therefore never below 1× or above 10×. This presentation control remains independent from engine pacing.

The bounded renderer projection does not limit active playback cadence. While playing, the renderer advances its wall-clock playhead at a preferred 10 frames per second and requests the nearest exact full-resolution stored sample from the main process. The playhead remains time-driven, so faster rates naturally skip recorded samples instead of slowing playback to render every value. Visible state updates are limited by this presentation cadence, the configured output interval and IPC response time; no interpolated numerical values are invented.

There is intentionally no legacy JSON `.kjr` reader in early alpha.
