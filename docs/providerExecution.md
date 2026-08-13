<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Provider execution transports

A relationship or source term can be programmable: instead of an equation, it runs inline C++ or
Python source the user authors in the Provider Editor. See [Project schema](projectSchema.md) for
the `implementation` field's JSON shape and `engine/include/konjugate/relationshipProvider.hpp`
for the C++ authoring API (`RelationshipProvider::describe()`/`evaluate()`). This document covers
a different axis from [Parallel execution](parallelExecution.md): that document is about how node
work is *scheduled*; this one is about how one programmable contribution's code actually *runs*
relative to the engine process, once it has been scheduled.

## Modes

`ProviderExecutionMode` (`engine/include/providerRuntime.hpp`) selects how `cppProvider`
contributions are dispatched. Python providers always use `pipeWorker`; neither faster transport
below has a story for an interpreted language.

| Mode | Mechanism | Isolation | Relative speed |
| --- | --- | --- | --- |
| `pipeWorker` | Each unique provider source runs as its own process; the engine exchanges framed protobuf messages over its stdin/stdout pipe. | Full: a crash or hang only takes down that provider's process. | Baseline (slowest) |
| `sharedMemoryWorker` | Same worker process as `pipeWorker`, but the hot evaluate path uses a shared-memory mailbox plus a pair of named POSIX semaphores instead of the pipe. Handshake/initialize/shutdown still go over the pipe. | Full, same as `pipeWorker`. | A few times faster, more for models with many instances sharing one provider |
| `inProcess` | The provider is compiled to a shared library and `dlopen()`/`LoadLibrary()`'d directly into the engine process; calls go straight through a C ABI vtable, no IPC at all. | **None.** A crash, hang, or stack overflow in the provider's own code takes the whole engine process down. | Close to equation-mode speed |

`sharedMemoryWorker` is POSIX-only (the cross-process semaphore mechanism has no portable
Windows equivalent used here); `inProcess` is available on every platform, since
`LoadLibrary`/`GetProcAddress` carry none of that portability concern. `ProviderRuntime`
resolves the requested mode per provider process with a fallback chain — `inProcess` falls back
to `sharedMemoryWorker` (POSIX only) which falls back to `pipeWorker` — so a single
unsupported/misconfigured host never blocks a whole run; a fallback logs to stderr but does not
fail the run.

Because `inProcess` gives up isolation entirely, it is meant to stay an explicit choice for
provider code the user already trusts, never a silent default.

## Choosing a mode

Nothing in the application defaults to anything other than `sharedMemoryWorker`. A user can
change it in **Provider Toolchains** (⚒ in the titlebar) under **Advanced: C++ provider
execution mode**; selecting **In-process (fastest, experimental)** shows an inline warning about
the isolation tradeoff. The setting is a machine-local preference stored alongside the compiler/
interpreter overrides (`providerToolchainStore.mjs`), not a per-project setting.

Precedence, from `engineAdapter.mjs`'s `startEngineRun()`:

1. An explicit `configuration.providers.executionMode` (not set by anything in the app today, but available to callers/tests).
2. The `KONJUGATE_PROVIDER_EXECUTION_MODE` environment variable — a developer's session-scoped override.
3. The user's saved choice in the Provider Toolchains dialog.
4. `sharedMemoryWorker`, the default.

The engine itself reads a top-level `providers.executionMode` string in the run configuration
JSON (`""`/absent, `"pipeWorker"`, `"sharedMemoryWorker"`, or `"inProcess"`; anything else is
treated as absent) — this is the field every layer above ultimately writes into before invoking
`konjugate run`.

## Build artifacts

`buildCppProvider()` compiles an inline C++ provider's source once per `(source hash, artifact
kind)` pair, cached under the same hash-named directory regardless of mode:

- `pipeWorker`/`sharedMemoryWorker`: the source is paired with `providerWorker.cpp` and compiled
  to a standalone executable (`provider`/`provider.exe`).
- `inProcess`: the source is paired with `providerInProcessShim.cpp` and compiled to a shared
  library (`provider.dylib`/`provider.so`/`provider.dll`) with `-shared -fPIC` (or MSVC `/LD`).

Both glue files, plus the public SDK header, ship under `include/konjugate/`/`src/` in a packaged
build (see the `install()` rules in `engine/CMakeLists.txt`) so `buildCppProvider()` can find them
at the same layout in dev and packaged builds. `konjugateProviderWorker` and
`konjugateProviderInProcessShim` are compile-check-only CMake targets — they catch a broken glue
file during the ordinary build; the actual per-provider compile always happens at run time,
outside CMake.

## The in-process C ABI

`engine/include/konjugate/providerInProcessAbi.hpp` defines the boundary the engine's dlopen'd
call crosses. It is POD-only and never lets a C++ exception cross the boundary — the engine and a
user's provider library are not guaranteed to share a C++ ABI/STL, and even on the same toolchain,
throwing across a `dlopen()` boundary is not something to depend on. Every function that can fail
returns a `bool`/`nullptr` instead, with `lastError()` carrying the message; the shim
(`providerInProcessShim.cpp`) catches the user's `RelationshipProvider::evaluate()` internally and
translates any exception into that error path.

`InProcessProviderBackend` still serializes calls with a mutex, exactly like the other two
backends, even though there is no IPC left to serialize: a real provider implementation may hold
mutable member state across calls, so the concurrency guarantee those two backends already gave
such code is preserved rather than silently imposing a new thread-safety requirement.

## Benchmarking

Two tools, at different levels:

```text
npm run benchmark:providers
```

Drives the real `konjugateEngine` CLI (project file → run configuration → decoded result), the
same way the app does, comparing equation mode against all three `ProviderExecutionMode`s on
identical trivial arithmetic. This is the integrated, whole-path measurement — it is what caught
a real bug (see below).

```text
../out/engine/providerBatchingBenchmark   # from engine/tests, after building the engine target
```

An engine-internal microbenchmark that hand-constructs execution-plan objects and calls
`ProviderRuntime` directly, isolating per-call transport cost from everything else (process
startup, project parsing, the per-synchronization-step loop). Useful for measuring a transport
change in isolation; not representative of end-to-end wall time on its own.

Neither tool is a regression baseline — like the `parallelExecution.md` benchmark, treat results
as observations for the current machine, not thresholds to assert against.

## A cautionary note on verifying performance work

An early version of `inProcess` mode left `simulationRunner.cpp`'s run-configuration
parser only recognizing `"sharedMemoryWorker"` as a non-default string; `"inProcess"` silently
fell through to `pipeWorker`. Every JSON/CLI-driven run that requested it — including interaction
tests run with `KONJUGATE_PROVIDER_EXECUTION_MODE=inProcess` — was actually exercising the pipe
transport the whole time, just computing correct results more slowly, which made the bug
invisible to a correctness check alone. The engine-level unit tests for
`InProcessProviderBackend` stayed valid throughout (they set the C++ enum directly, bypassing the
string parser), but nothing outside that suite could reach the backend at all until
`npm run benchmark:providers` measured a real run and the numbers didn't match the isolated
microbenchmark's prediction. The lesson: a transport-level change needs a whole-path benchmark
before its numbers are trusted, not just a functional test — a mode that is silently never
selected still produces correct output.

## Current limits

`sharedMemoryWorker` is compiled and exercised on POSIX (macOS/Linux) but not verified on
Windows beyond compiling; the Windows environment-variable-passing path in
`ProviderControlChannel::spawn()` mirrors the existing PYTHONPATH-passing code there but has not
been run on Windows. `inProcess`'s `LoadLibrary`/`GetProcAddress` path is similarly
implemented-but-unverified on Windows, though it is a much smaller surface (no cross-process
synchronization primitive) than the shared-memory transport.
