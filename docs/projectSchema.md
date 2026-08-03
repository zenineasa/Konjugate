<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Project document schema, version 1

The decoded `.kjt` payload is UTF-8 JSON with these top-level fields:

- `format`: literal `konjugate`
- `version`: integer `1`
- `copyright`: optional attribution string
- `metadata.units`: unit-system identifier
- `nodes`: array of node records
- `edges`: array of relationship records

Every persistent entity uses a globally unique UUID. User-facing names are mutable and must never be references.

A node contains `id`, `name`, optional `type`, three-number `position`, `states`, `sourceTerms`, `numerics`, and `appearance`. State symbols are unique lower-camel-case identifiers within their node. Source terms identify their updated state by symbol in version 1. `numerics.substepsPerGlobalStep` is an integer from 1 through 10,000 and defaults to 1.

An edge contains `id`, `name`, source and target node/state references, directionality, LaTeX equation, optional normalized `equationModel`, parameters, and appearance. Parameter symbols are unique lower-camel-case identifiers within their edge. Normalized equation bindings and outputs use UUID references.

For an executable relationship, `equationModel` is required and contains:

- `latex`: the editable presentation expression.
- `bindings`: UUID-backed state and parameter bindings with stable expression symbols.
- `output`: the state receiving the expression's derivative contribution.
- `mathJson`: the executable expression tree. Version 1 supports numeric literals, bound symbols, `Add`, `Multiply`, `Negate`, `Divide`, `Power`, `Sqrt`, `Abs`, `Exp`, `Ln`, `Log`, `Sin`, `Cos`, `Tan`, `Min`, and `Max`.

LaTeX is never executed directly. Multiple relationships targeting the same state contribute additively to its derivative.

Source terms use the same structure under `expressionModel`: UUID-backed local-state bindings, an output state, editable LaTeX, and executable MathJSON. Source terms and relationships targeting the same state are summed before each integration step.

Projects may contain named numerical `runConfigurations` and an `activeRunConfigurationId`. A numerical configuration contains `globalTimeStep` and `outputInterval` in seconds; output interval is an integer multiple of the global timestep. It may also contain the `execution` settings described in [Parallel execution](parallelExecution.md). Target time and pacing belong to the transient launch request rather than the model. Pacing selects `fastest`, `realTime`, or `limitedRatio`; limited pacing also supplies a positive `simulationSecondsPerWallSecond`. Pacing limits wall-clock execution and does not alter numerical timesteps. During each global step, every node advances with `globalTimeStep / substepsPerGlobalStep`. References to the advancing node use its latest local state; references to other nodes use the frozen state snapshot from the start of the global step. Nodes synchronize at the global boundary.

Engine results distinguish display `samples` from restart `checkpoints`. Each checkpoint has a UUID, simulation time, complete state vector, and solver identity. Explicit Euler currently has no additional hidden solver state; future integrators extend the checkpoint record rather than treating plot samples as restart data.

The engine accepts an optional `startCheckpoint` in a launch request. Its complete state vector replaces model initial values and its time becomes the segment start. `targetTime` is absolute and must be later than that checkpoint. The current UI uses this only to continue a stopped partial run from its latest checkpoint. Branch creation and earlier-checkpoint restart remain deferred until their interaction model is designed.

Unknown fields must be preserved when possible. Readers reject unsupported major schema versions. Additive fields may be introduced within a schema version when older readers can safely ignore them.
