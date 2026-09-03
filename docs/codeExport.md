<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Exporting a simulation as standalone code

The "Export simulation code" button in the title bar (next to "Export results as CSV") turns the
currently loaded model into one self-contained `.cpp` or `.py` file that reproduces a full
simulation run with no runtime dependency on the Konjugate engine binary or GUI. It is implemented
entirely in JS (`src/codeExport.mjs`), reading the same flattened `nodes`/`edges` document the
engine itself validates and runs against (`executionProjectDocument()` + `stripEdgeGroups()`) —
there is no engine-side "codegen mode."

## What is reproduced

The generator targets exact numerical fidelity with the engine's own solver, which is Explicit
Euler and nothing else (there is no RK4/implicit integrator in this codebase):

- **Fixed-step, multi-rate integration.** Each node advances at `globalTimeStep /
  substepsPerGlobalStep`. A binding into a *different* node's state always reads a frozen snapshot
  taken at the start of the current global step; a binding into the *same* node's own state (or any
  source-term binding) reads that node's live, substep-updated value.
- **Contribution order.** Contributions to the same state are summed in the same order the engine
  uses — a node's own source terms in their JSON order, then edges touching that node in document
  order — since floating-point addition is not associative.
- **Bidirectional edges** apply the same evaluated expression to both endpoints, negated on the
  other side.
- **Disabled nodes/edges** are excluded exactly as the engine excludes them.
- **Live parameters** (`mode: "live"`) are emitted as plain constants using their stored value — a
  runtime control-message override only matters for the interactive GUI, which the exported program
  has no equivalent of.
- **Same-language inline providers** (C++ or Python relationship/source-term/computational-node
  providers) are embedded by pasting their raw source into the generated file, alongside a small
  vendored copy of the author-facing SDK types (`ScalarPort`, `EvaluationContext`,
  `OutputCollector`, etc.) that a provider's own source already targets. Provider instances are
  created once and persist for the whole run — not recreated per step — since a stateful provider
  (e.g. a PI controller's integral term) depends on that.

## What is not supported

Export is blocked outright, with an error naming the offending node or edge, when:

- **A provider is implemented in the other language.** A model with a C++ provider cannot be
  exported to Python, and vice versa — provider source is never auto-translated.
- **A provider is an installed plugin reference** (`implementation.kind: "plugin"`), which has no
  embeddable source to paste in.
- **A computational-node provider is exported to C++.** C++ computational-node execution does not
  exist in the engine either, so there is no C++ shape to generate.

Beyond blocking, a few things are deliberately out of scope for the generated program itself:

- **No restart/checkpoint support.** Export reproduces one fresh run from the model's initial
  values; a computational-node provider's `checkpoint()`/`restore()` methods are never called.
- **No parallel/distributed execution.** The engine's thread-pool and multi-process partitioning
  are a scaling detail, not part of the model's math — the generated program is a single sequential
  loop, which is exactly as correct and much simpler.
- **`Sqrt`/`Log`/`Power` domain divergence.** `std::sqrt`/`std::log`/`std::pow` return `NaN` on an
  out-of-domain input (e.g. a negative square root); Python's `math.sqrt`/`math.log`/`math.pow`
  raise a `ValueError` in the same situation instead. Both fail loudly rather than silently
  continuing with bad data, so this is a documented divergence, not a wrong-physics bug.

## Run configuration

`globalTimeStep` and `outputInterval` are baked in from the model's active run configuration.
`targetTime` is a transient launch parameter, not part of the project schema, so the generated
program exposes it (and the output CSV path) as a command-line flag with a default taken from
whatever the "Run" dialog's target time was set to at export time:

```
./exported --target-time 10 --output results.csv
python3 exported.py --target-time 10 --output results.csv
```

The output CSV uses the same `time (s)`, `NodeName — StateName (unit)` header convention as
Konjugate's own "Export results as CSV" button.

## Verifying fidelity against the real engine

`tests/codeExport.test.mjs` only checks the generated source's shape (structural fragments, brace
balance) — it can't compile or run C++/Python, so it can't confirm the numbers are actually right.
That confirmation is `npm run test:codeExportFidelity`
(`tests/engine/codeExportFidelity.mjs`): it builds a 5-node fixture exercising cross-node snapshot
reads, a bidirectional edge, a multi-substep node, `Add`/`Multiply`/`Power`/`Sqrt`/`Abs`, and a live
parameter, runs it through the real `konjugateEngine` binary, then separately generates, compiles
(`c++ -std=c++20`) and runs both the C++ and Python export, and asserts every state matches the real
engine's own result at every sampled time to within `1e-6`. It needs a C++ compiler (`CXX` env var,
default `c++`) and `python3` (`PYTHON` env var) in addition to the built engine binary, so — unlike
`npm run test:engine` — it is not wired into the automatic CI test chain and must be run explicitly.
