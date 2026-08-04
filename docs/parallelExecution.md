<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Parallel execution

Konjugate can execute a simulation with a serial loop, a shared thread pool or communication-aware partitions. The selected backend changes how independent node work is scheduled. It does not change the model equations, timestep, node substeps, pacing or deterministic synchronization semantics.

## Selecting a backend

Execution settings belong to the active run configuration. In the application:

1. Stop the current simulation if one is running.
2. Close the results view to return to model-editing mode.
3. Select **Run configuration** using the gear button beside **Run**.
4. Under **Execution**, select a backend and worker limit.
5. Select **Apply**, then start a new run.

The backend cannot be changed during an active run. A completed or stopped result records the backend that produced it, so changing the run configuration affects only the next run. The execution button in the bottom result bar opens a summary of the recorded decision and its measurements.

For most models, **Automatic** is the recommended setting. A small model may legitimately report **Serial · 1 worker** even on a computer with many processor cores because parallel scheduling and synchronization would cost more than the estimated work.

## Backends

### Automatic

The engine chooses a backend for the current compiled model:

- A one-node model uses `serial`.
- A model whose estimated work is below the configured parallel work threshold uses `serial`.
- A sufficiently large model whose proposed partitioning cuts too much inter-node communication uses `threadPool`.
- Otherwise, the model uses `partitioned`.

The result records the requested backend, effective backend and selection reason. Automatic selection is deterministic for a given model and execution configuration. It is a heuristic, not a hardware benchmark, so an explicit backend remains useful for measurement and diagnosis.

### Serial

The engine integrates nodes sequentially on one worker. This has the least scheduling overhead and is normally best for small models. Selecting serial forces the effective worker count to one.

### Thread pool

The engine submits node integrations to a persistent shared worker pool. Nodes with the greatest estimated work are submitted first. Every task reads the same synchronization-boundary snapshot, and results are committed in stable node order after all tasks finish.

Thread-pool execution is useful when node workloads are large enough to run concurrently but partition boundaries would exchange too much state.

### Partitioned

The engine groups nodes using METIS k-way partitioning or the built-in communication-aware greedy partitioner. METIS uses estimated node computation as vertex weights and aggregated state-dependency traffic as edge weights. The built-in algorithm balances estimated computation while keeping strongly communicating nodes together. Each partition has a persistent worker and receives an immutable, versioned boundary message for each global synchronization step.

Partitioned execution currently runs inside one C++ engine process and uses an in-memory transport. It is not multi-process, distributed or multi-machine execution yet. The transport abstraction and explicit message boundary provide a foundation for those later implementations.

## Numerical semantics

All backends preserve the same snapshot-coupled explicit Euler algorithm:

1. At the beginning of a global step, the engine freezes the complete synchronized state.
2. Each node integrates its own states using its configured local substeps.
3. During those substeps, references to that node use its latest local state. References to other nodes use the frozen global snapshot.
4. Contributions are reduced in their stable compiled sequence.
5. Node results are committed in deterministic order at the global boundary.

Consequently, parallel workers never predict another node's future state and never mutate a shared state vector during a synchronization step. Backend selection should not change numerical results. Numerical regression tests compare all execution paths against recorded reference results.

Simulation pacing is independent of execution backend. **Offline** runs without a wall-clock limit. **Online** pacing may deliberately wait after a synchronization step, but it does not alter numerical timesteps or create additional parallelism.

## Configuration reference

The `execution` object is stored in a run configuration:

```json
{
    "execution": {
        "backend": "automatic",
        "workerThreads": 8,
        "partitionAlgorithm": "automatic",
        "partitionCount": 8,
        "partitionCommunicationBias": 4,
        "automaticParallelThreshold": 128,
        "automaticMaximumPartitionCutFraction": 0.25
    }
}
```

| Field | Meaning | Valid values | Default |
| --- | --- | --- | --- |
| `backend` | Requested execution strategy | `automatic`, `serial`, `threadPool`, `partitioned` | `automatic` |
| `workerThreads` | Maximum workers available to a parallel backend | Integer from 1 through 256 | Logical processor count reported by the system |
| `partitionAlgorithm` | Requested graph partitioner | `automatic`, `metisKway`, `communicationAwareGreedy` | `automatic` |
| `partitionCount` | Requested number of graph partitions | Integer from 1 through 256 | Logical processor count reported by the system |
| `partitionCommunicationBias` | Strength of the preference to keep communicating nodes together | Finite number greater than or equal to 0 | `4` |
| `automaticParallelThreshold` | Estimated operations per node required before automatic mode considers parallel execution | Integer from 1 through 1,000,000 | `128` |
| `automaticMaximumPartitionCutFraction` | Largest communication-cut fraction for which automatic mode selects partitioned execution | Finite number from 0 through 1 | `0.25` |

The effective worker count never exceeds the number of model nodes. For automatic and partitioned execution, the number of executable partitions is also capped by the worker limit. The effective partition count may be lower than requested when the graph has fewer nodes.

Two additional engine-facing settings are supported but are not currently exposed in the application:

- `partitionReceiveTimeoutMilliseconds` controls how long a partition waits for its boundary message. It accepts an integer from 1 through 60,000 and defaults to 5,000 ms.
- Backend and partition fields may be supplied in the run-configuration JSON used by `konjugate run`.

## How automatic selection works

The compiled execution plan estimates each node's work from expression operations, contribution tasks and node substeps. Automatic mode compares the total estimated operations per synchronization step with:

```text
automaticParallelThreshold × nodeCount
```

Work below that value selects serial execution. For larger models, the partitioner computes:

```text
communicationCutFraction = cutCommunicationWeight / totalCommunicationWeight
```

A dependency contributes to the cut when its source and target nodes are assigned to different partitions. If the cut fraction exceeds `automaticMaximumPartitionCutFraction`, automatic mode selects the shared thread pool. Otherwise it selects partitioned execution. A sufficiently large model with no inter-node communication selects partitioned execution as independent parallel work.

Selection reasons recorded in results are:

| Reason | Meaning |
| --- | --- |
| `explicitSelection` | The run configuration requested a non-automatic backend |
| `singleNode` | There is no node-level parallel work |
| `belowParallelWorkThreshold` | Estimated work is too small to justify parallel overhead |
| `partitionCommunicationCutTooHigh` | Parallel work is worthwhile, but the proposed partition boundary is too communication-heavy |
| `partitionCutWithinLimit` | The proposed communication cut is acceptable |
| `independentParallelWork` | Substantial node work exists without inter-node communication |

## Partition planning

The dependency graph is derived from compiled equation bindings, not from visual proximity. It records node compute weights, remote state dependencies and estimated communication weights.

`automatic` partitioner selection prefers `metisKway` when the engine was compiled with METIS. If METIS is unavailable or cannot partition a particular graph, it records a fallback reason and uses `communicationAwareGreedy`. An explicit `metisKway` request fails rather than silently falling back, making reproducible CLI and benchmark runs possible.

`metisKway` converts the directed dependency graph into METIS weighted compressed sparse row form. Opposing or parallel dependencies between a pair of nodes are aggregated into one undirected edge. Estimated operations per synchronization become vertex weights, communication weights become edge weights and a fixed seed makes planning repeatable. METIS then balances vertex weight while minimizing the weighted edge cut. `partitionCommunicationBias` does not affect METIS because scaling every edge weight equally would not change its optimization problem.

The `communicationAwareGreedy` partitioner assigns nodes while considering both load balance and cut communication. Increasing `partitionCommunicationBias` more strongly favors colocating connected nodes. A value of zero emphasizes computation balance alone. Excessively high values may preserve locality at the expense of worker balance, so the default should be changed only after inspecting measurements.

The result identifies the requested and effective algorithms, effective algorithm version, METIS availability and any fallback reason. It includes metrics for the selected assignment, the built-in greedy baseline and round-robin placement. The baselines are diagnostic and are not used to execute a METIS plan.

### Building with METIS

CMake discovers an installed METIS library automatically. On macOS it can be installed with `brew install metis`; common Linux distributions provide a `libmetis-dev` or equivalent development package. Configure with `-DKONJUGATE_ENABLE_METIS=OFF` to exercise the dependency-free fallback build.

macOS builds copy the METIS runtime library and its license into the engine output directory, rewrite the runtime reference to `@loader_path/libmetis.dylib` and therefore remain self-contained when that directory is packaged. Other packaging targets must likewise ship the applicable METIS shared library or build without METIS.

## Execution summary and result telemetry

The execution summary presents the most useful fields from the result:

- effective backend, worker count and automatic-selection reason
- planning time and synchronization time
- accumulated node computation time
- effective partitioning algorithm and compute imbalance
- selected and round-robin communication cuts
- boundary-message count and payload size
- message preparation, publish and boundary-wait time

The full `.kjr` execution record also contains per-node invocation, substep, contribution and compute measurements, the dependency graph and complete partition assignments. Times are diagnostic wall-clock measurements in nanoseconds. They vary with hardware and system load and must not be treated as model outputs.

Accumulated node computation can exceed elapsed wall time because work performed concurrently by several workers is added together. Likewise, synchronization time includes orchestration and waiting around concurrent work; the displayed categories are not intended to sum into a single exclusive profile.

## Choosing and tuning a backend

Start with automatic mode. If a representative model is slow:

1. Run the same model and numerical configuration with `serial`, `threadPool` and `partitioned`.
2. Compare elapsed wall time over several runs rather than relying on a single measurement.
3. Check whether node compute dominates planning and synchronization overhead.
4. Check compute imbalance and communication cut before increasing the partition count.
5. Keep the numerical timestep, output interval and pacing identical during comparisons.

More workers are not always faster. Small nodes, uneven workloads, frequent global synchronization, heavy cross-partition dependencies and an over-partitioned graph can all make a parallel backend slower than serial execution.

The repository benchmark can compare backends without changing numerical settings:

```text
npm run benchmark:engine
```

Set `KONJUGATE_BENCHMARK_TOPOLOGY=ring` to exercise a communicating graph; the default topology uses independent node work. Benchmark results are performance observations for the current machine, not regression baselines.

## Reliability and current limits

The engine rejects invalid backend and partitioner names, worker and partition counts, thresholds, cut fractions and receive timeouts. The partition transport rejects duplicate messages, associates messages with a synchronization index and fails a run when a required message does not arrive before its timeout. Tests cover METIS-enabled and dependency-free builds, explicit and automatic partitioner selection, delayed, missing and duplicate messages, partition-worker failures, deterministic reduction, partition quality and numerical agreement across backends.

Current parallelism is node-grained. A single computationally expensive node is not divided among workers. Partition transport serialization time is reported as zero because the in-memory implementation passes native values. Process isolation, network transport, accelerator execution, dynamic repartitioning and a programming interface for compiled equation kernels remain future work.
