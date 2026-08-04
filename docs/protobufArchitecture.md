<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Protobuf architecture

Konjugate is migrating performance-sensitive native-engine boundaries from JSON
to versioned Protobuf messages. JSON remains appropriate for infrequent human-facing
configuration and external AI-provider APIs; it is not the live simulation transport.

The first protocol version is defined in `protocol/engineProtocol.proto`. The C++
engine uses generated Protobuf bindings. Electron uses a small schema-specific wire
decoder during the initial vertical slice, avoiding a second runtime dependency;
generated JavaScript bindings should replace it when more message types are added.

## Live framing

When Electron launches a run it requests `--event-stream protobuf`. The engine writes
events to stdout as a four-byte unsigned big-endian payload length followed by one
serialized `EngineEvent`. stderr remains text diagnostics. Files remain responsible
for durable results and recovery while the migration is incomplete.

The engine publishes a stable state table once. Sample batches subsequently contain
packed timestamps and packed double values in sample-major state-table order. UUIDs
are therefore not repeated for every value. Checkpoints and the final `.kjr` remain
JSON in this slice.

Run `npm run benchmark:protocol` to compare the implemented live-sample wire shape
with the previous newline-delimited JSON records. The benchmark reports bytes only;
end-to-end CPU and memory measurements will be added when binary checkpoints and
results remove the remaining JSON work.

Protocol messages carry an explicit protocol version, frames are size-limited and
order-sensitive collections use repeated fields rather than maps. IEEE-754 doubles
are transferred without decimal conversion. These choices preserve deterministic
state association and exact numerical values.

The engine compatibility suite compares the raw IEEE-754 bit patterns received in
live Protobuf samples with the corresponding durable engine-result values. Solver
regression tolerances remain separate and are not weakened to accommodate transport.

Closed native control values such as execution backend, backend-selection reason,
pacing mode and run state are parsed from current JSON strings once and represented
as strong enums thereafter. Compiled expression symbols and parameter bindings use
stable integer slots, so each contribution evaluates from a contiguous double vector
without rebuilding symbol and parameter hash maps during every node substep. UUIDs
remain the persistent identity and JSON output remains unchanged.

## Migration sequence

1. Measure and deploy framed live sample batches.
2. Move live pacing, parameter and lifecycle commands from polled JSON files to
   framed stdin messages.
3. Define a binary `.kjr` result containing packed samples and checkpoints.
4. Define the UUID-backed project and typed equation schemas, then introduce a
   Protobuf payload in the `.kjt` container.
5. Remove Boost.PropertyTree model ingestion and obsolete JSON protocol code after
   numerical and cross-language regression coverage is complete.
