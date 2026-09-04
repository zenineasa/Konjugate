<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Exporting a simulation as standalone code

The "Export simulation code" button in the title bar (next to "Export results as CSV") turns the currently loaded model into one self-contained `.cpp` or `.py` file that reproduces a full simulation run with no runtime dependency on the Konjugate engine binary or GUI. It is implemented entirely in JS (`src/codeExport.mjs`), reading the same flattened `nodes`/`edges` document the engine itself validates and runs against (`executionProjectDocument()` + `stripEdgeGroups()`) — there is no engine-side "codegen mode."

## What is reproduced

The generator targets exact numerical fidelity with the engine's own solver, which is Explicit Euler and nothing else (there is no RK4/implicit integrator in this codebase):

- **Fixed-step, multi-rate integration.** Each node advances at `globalTimeStep / substepsPerGlobalStep`. A binding into a *different* node's state always reads a frozen snapshot taken at the start of the current global step; a binding into the *same* node's own state (or any source-term binding) reads that node's live, substep-updated value.
- **Contribution order.** Contributions to the same state are summed in the same order the engine uses — a node's own source terms in their JSON order, then edges touching that node in document order — since floating-point addition is not associative.
- **Bidirectional edges** apply the same evaluated expression to both endpoints, negated on the other side.
- **Disabled nodes/edges** are excluded exactly as the engine excludes them.
- **Live parameters** (`mode: "live"`) are emitted as plain constants using their stored value — a runtime control-message override only matters for the interactive GUI, which the exported program has no equivalent of.
- **Same-language inline providers** (C++ or Python relationship/source-term/computational-node providers) are embedded by pasting their raw source into the generated file, alongside a small vendored copy of the author-facing SDK types (`ScalarPort`, `EvaluationContext`, `OutputCollector`, etc.) that a provider's own source already targets. Provider instances are created once and persist for the whole run — not recreated per step — since a stateful provider (e.g. a PI controller's integral term) depends on that.

## What is not supported

Export is blocked outright, with an error naming the offending node or edge, when:

- **A provider is implemented in the other language.** A model with a C++ provider cannot be exported to Python, and vice versa — provider source is never auto-translated.
- **A provider is an installed plugin reference** (`implementation.kind: "plugin"`), which has no embeddable source to paste in.
- **A computational-node provider is exported to C++.** C++ computational-node execution does not exist in the engine either, so there is no C++ shape to generate.

Beyond blocking, a few things are deliberately out of scope for the generated program itself:

- **No restart/checkpoint support.** Export reproduces one fresh run from the model's initial values; a computational-node provider's `checkpoint()`/`restore()` methods are never called.
- **`Sqrt`/`Log`/`Power` domain divergence.** `std::sqrt`/`std::log`/`std::pow` return `NaN` on an out-of-domain input (e.g. a negative square root); Python's `math.sqrt`/`math.log`/`math.pow` raise a `ValueError` in the same situation instead. Both fail loudly rather than silently continuing with bad data, so this is a documented divergence, not a wrong-physics bug.
- **The Python export has no thread-based parallel option.** `openmp`/`stdThread` are rejected outright for a Python export: Python's GIL means threads would not actually run this CPU-bound loop in parallel, so offering them would be misleading rather than merely unoptimized. `mpi` *is* available for Python (via `mpi4py`) — see below.

## Parallelism

The export dialog's "Execution" choice picks how the generated program dispatches its per-global-step node work. Every mode runs the *exact same math* (verified — see below) — each node's computation only ever reads the frozen `snapshot` (for other nodes) or its own live local state, and only ever writes its own states back into the global state list, so nothing about correctness depends on execution order or concurrency. C++ offers all four modes; Python offers only `serial` and `mpi` (see above for why threading is excluded).

- **Serial** (default): a plain sequential loop over the nodes. Simplest, no build flags needed.
- **OpenMP**: `#pragma omp parallel for` over the same nodes. Mirrors the real engine's own thread-pool backend (see [Parallel execution](parallelExecution.md)) — genuinely just a flag on top of the serial structure. Needs `-fopenmp` (Linux/MSVC `/openmp`); **macOS's shipped `clang++` has no bundled OpenMP** — `brew install libomp` once, then compile with `-Xpreprocessor -fopenmp -I"$(brew --prefix libomp)/include" -L"$(brew --prefix libomp)/lib" -lomp` (libomp is keg-only, so the `-I`/`-L` paths must be given explicitly — a bare `-lomp` will fail to link).
- **`std::thread`**: the same parallel dispatch, spawning and joining one `std::thread` per node every global step instead of using an OpenMP pragma. No special compiler flag beyond `-pthread` (harmless/unneeded on Windows), at the cost of a fresh thread spawn every step rather than a reused worker pool — the simplest correct option when a project can't or doesn't want to depend on OpenMP.
- **MPI**: genuinely new territory, not mirroring existing engine code — the real engine's own "partitioned" backend explicitly stops at one process ("not multi-process, distributed or multi-machine execution yet," per [Parallel execution](parallelExecution.md)). Nodes are split into **contiguous blocks by node count** across ranks (computed at runtime from `MPI_Comm_size`, since the rank count is an `mpirun -n` choice) — a simple, unweighted partition, unlike the engine's own METIS/communication-aware partitioner, so a lopsided model could load-balance poorly. Each rank integrates only its own block, then one `MPI_Allgatherv(MPI_IN_PLACE, ...)` per step reconciles the full state vector across ranks (contiguous-by-node-order blocks give every rank a contiguous global-state-index range, which is what makes a single collective call sufficient). Only rank 0 writes the output CSV. Needs an MPI implementation (OpenMPI, MPICH, …); build with `mpic++` and run with `mpirun -n <ranks>`, exactly like any other compiled program. The **Python** `mpi` export is the same algorithm via `mpi4py` (`pip install mpi4py`, needing the same system MPI install) — `comm.allgather()` on each rank's own contiguous state slice, concatenated in rank order, stands in for `MPI_Allgatherv` (mpi4py's fast buffer-based API would need NumPy arrays, which the Python export otherwise has no reason to depend on).

## Run configuration

`globalTimeStep` and `outputInterval` are baked in from the model's active run configuration. `targetTime` is a transient launch parameter, not part of the project schema, so the generated program exposes it (and the output CSV path) as a command-line flag with a default taken from whatever the "Run" dialog's target time was set to at export time:

```
./exported --target-time 10 --output results.csv
python3 exported.py --target-time 10 --output results.csv
```

The output CSV uses the same `time (s)`, `NodeName — StateName (unit)` header convention as Konjugate's own "Export results as CSV" button.

## Verifying fidelity against the real engine

`tests/codeExport.test.mjs` only checks the generated source's shape (structural fragments, brace balance) — it can't compile or run C++/Python, so it can't confirm the numbers are actually right. That confirmation is `npm run test:codeExportFidelity` (`tests/engine/codeExportFidelity.mjs`): it builds a 5-node fixture exercising cross-node snapshot reads, a bidirectional edge, a multi-substep node, `Add`/`Multiply`/`Power`/`Sqrt`/`Abs`, and a live parameter, runs it through the real `konjugateEngine` binary, then separately generates, compiles and runs the plain Python export plus every C++ parallelism variant (serial, openmp, stdThread — mpi too when `mpic++`/`mpirun` are found on `PATH`, skipped with a console note otherwise), and asserts every state from every variant matches the real engine's own result at every sampled time to within `1e-6`. The Python `mpi` variant is checked the same way when both `mpirun` and an importable `mpi4py` are available, skipped otherwise. It needs a C++ compiler (`CXX` env var, default `c++`) and `python3` (`PYTHON` env var) in addition to the built engine binary, so — unlike `npm run test:engine` — it is not wired into the automatic CI test chain and must be run explicitly.
