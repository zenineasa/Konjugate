<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Binary result format

`.kjr` is Konjugate's only durable simulation-result format. It is a binary container and is not JSON-compatible.

The container begins with the four bytes `KJR\x01`, followed by a four-byte unsigned big-endian Protobuf payload length and one serialized `ResultFile` from `protocol/engineProtocol.proto`. Readers reject an unknown magic value, inconsistent length or unsupported result version.

`ResultFile` contains a stable numeric state table, one columnar `SampleBatch` and complete restart checkpoints. Sample timestamps and state values are packed IEEE-754 doubles in sample-major state-table order. Each checkpoint stores its UUID, time, solver identity and one packed state vector in the same order. State IDs are therefore recorded once rather than repeated for every numerical value.

Execution, dependency, partition and lifecycle metadata remains a UTF-8 JSON field during this migration slice. It does not contain sample or checkpoint arrays. A later protocol revision can replace that field with typed messages without changing the packed numerical layout.

Live samples use the same `SampleBatch` layout over the framed stdout event stream. The engine aggregates all samples available between result publications into one event. Live `.kjr` snapshots contain metadata but do not repeatedly rewrite accumulated numerical history; stopped and completed snapshots contain the complete packed samples and checkpoints. Electron validates dimensions before reconstructing the current renderer-facing result view.

There is intentionally no legacy JSON `.kjr` reader in early alpha.
