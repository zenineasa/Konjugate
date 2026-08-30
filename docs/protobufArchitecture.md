<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Protobuf architecture

Konjugate is migrating performance-sensitive native-engine boundaries from JSON to versioned Protobuf messages. JSON remains appropriate for infrequent human-facing configuration and external AI-provider APIs; it is not the live simulation transport.

The first protocol version is defined using Protobuf Edition 2024 in `protocol/engineProtocol.proto`. The C++ engine uses generated Protobuf bindings. Electron uses a small schema-specific wire decoder during the initial vertical slice, avoiding a second runtime dependency; generated JavaScript bindings should replace it when more message types are added. Edition 2024 requires a Protobuf toolchain that supports editions; the repository's pinned vcpkg dependency and development setup provide that toolchain.

## Live framing

When Electron launches a run it requests `--event-stream protobuf`. The engine writes events to stdout as a four-byte unsigned big-endian payload length followed by one serialized `EngineEvent`. stderr remains text diagnostics. Files remain responsible for durable results and recovery while the migration is incomplete.

Electron also requests `--control-stream protobuf` and writes length-prefixed `EngineCommand` messages to the engine's stdin. Commands carry protocol version 1, a strictly increasing sequence number and one of `SetPacing`, `SetRunState` or `SetParameterValue`. The engine rejects malformed, oversized, unsupported and out-of-order frames. It queues valid commands immediately, then applies them only at the existing synchronization-boundary control checks. Transport latency therefore improves without changing numerical timesteps or deterministic solver ordering.

The engine publishes a stable state table once. Sample batches subsequently contain packed timestamps and packed double values in sample-major state-table order. Numeric state IDs are therefore not repeated for every value. The binary result segment embedded in `.kjt` uses the same packed columnar representation for samples and checkpoint state vectors. See [Embedded binary result storage](resultFileFormat.md).

Run `npm run benchmark:protocol` to compare the implemented live-sample wire shape with the previous newline-delimited JSON records. The benchmark reports bytes only; end-to-end CPU and memory measurements can now cover the binary checkpoint and result path as well as the live stream.

Protocol messages carry an explicit protocol version, frames are size-limited and order-sensitive collections use repeated fields rather than maps. IEEE-754 doubles are transferred without decimal conversion. These choices preserve deterministic state association and exact numerical values.

The engine compatibility suite compares the raw IEEE-754 bit patterns received in live Protobuf samples with the corresponding durable engine-result values. Solver regression tolerances remain separate and are not weakened to accommodate transport.

Closed native control values such as execution backend, backend-selection reason, pacing mode and run state are parsed from current JSON strings once and represented as strong enums thereafter. Compiled expression symbols and parameter bindings use stable integer slots. Execution-plan compilation also maps persistent state IDs to dense global snapshot slots and compact node-local slots. Each contribution therefore evaluates from contiguous double vectors without state, symbol or parameter hash-map lookups during node substeps. Persistent model identities remain positive JSON-safe integers and state-table IDs use Protobuf `uint64`.

## Migration sequence

1. Completed: measure and deploy framed live sample batches.
2. Completed: move live pacing, parameter and lifecycle commands to framed stdin messages.
3. Completed: define an embedded binary result segment containing packed samples and checkpoints.
4. Define the integer-ID-backed project and typed equation schemas, then introduce a Protobuf payload in the `.kjt` container.
5. Remove Boost.PropertyTree model ingestion and obsolete JSON protocol code after numerical and cross-language regression coverage is complete.
