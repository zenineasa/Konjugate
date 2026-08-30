<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Project document schema, version 1

The decoded `.kjt` payload is UTF-8 JSON with these top-level fields:

- `format`: literal `konjugate`
- `version`: integer `1`
- `copyright`: optional attribution string
- `metadata.units`: unit-system identifier
- `nodes`: array of node records
- `edges`: array of relationship records
- `subsystems`: array of authoring-hierarchy records grouping nodes into navigable containers -- see [Subsystems](subsystems.md)
- `edgeGroups`: array of shared-relationship records that expand into a mesh of edges across a live member-node set -- see [Edge groups](edgeGroups.md)

Every persistent model entity uses a project-scoped positive integer `id` from 1 through `Number.MAX_SAFE_INTEGER` (`9,007,199,254,740,991`). IDs are unique across nodes, states, source terms, edges, parameters, run configurations, subsystems, subsystem ports and edge groups in one project. User-facing names are mutable and must never be references. Version 1 does not accept legacy UUID identifiers.

A node contains `id`, `name`, optional `type`, three-number `position`, `states`, `sourceTerms`, `numerics`, `appearance`, and optional `enabled`. It may also contain three-number `rotation` (Euler angles in radians, XYZ order) and `scale`, both purely cosmetic canvas placement -- neither affects simulation. Both are additive fields: omitted entirely when at their identity value (`[0,0,0]` for rotation, `[1,1,1]` for scale), and older readers that don't know about them can safely ignore them, per the additive-field rule above. State symbols are unique lower-camel-case identifiers within their node. Source terms identify their updated state by symbol in version 1. `numerics.substepsPerGlobalStep` is an integer from 1 through 10,000 and defaults to 1. A node may also contain an `implementation` object, additive alongside `sourceTerms`, declaring a computational-node provider that owns the node's dynamics -- see below.

A node may also carry `subsystemId`, referencing an entry in the top-level `subsystems` array -- pure authoring hierarchy with no effect on simulation. Before validation and execution, the host strips `subsystems` and every node's `subsystemId`, so the engine always sees the same flat node-and-edge graph regardless of hierarchy. See [Subsystems](subsystems.md) for the full record shape.

An edge contains `id`, `name`, source and target node/state references, directionality, LaTeX equation, optional normalized `equationModel`, parameters, appearance, and optional `enabled`. Parameter symbols are unique lower-camel-case identifiers within their edge. Normalized equation bindings and outputs use numeric entity references.

Each entry in an edge's `parameters` array contains `id`, `name`, `symbol`, `value`, optional `unit`, and `mode` (`"constant"` or `"live"`, default `"constant"`). Two further fields may accompany it:

- `control`: `{ minimum, maximum, step }`, present only when `mode` is `"live"`. Governs the interactive slider shown during a run — `minimum < maximum`, `step > 0`, and `value` must fall within `[minimum, maximum]`.
- `tuning`: `{ minimum, maximum }`, marking the parameter as a fitting target for the digital-twin parameter-tuning feature (see [Causal inference](causalInference.md) for the related, but distinct, structure-discovery feature). Presence of `tuning` is what makes a parameter tunable. `minimum < maximum` and `value` must fall within `[minimum, maximum]`; both are validated the same way `control`'s bounds are. Mutually exclusive with `mode: "live"` — a live parameter is adjusted interactively during a run and has no fixed baseline worth calibrating beforehand, so the authoring UI disables tuning while a parameter is live, and clears any existing `tuning` the moment `mode` becomes `"live"`.

`enabled` (boolean, default `true` when absent) marks a node or edge as disabled without removing it: unlike a UI delete, a disabled entity is written to the file and round-trips through save and load. The engine treats a disabled node or edge exactly as if it had been deleted — its states are not part of the state vector, and it contributes nothing — but its definition, bindings and equations are preserved and are not validated while disabled. An edge is inert if it is disabled itself, or if either endpoint node is disabled, even if the edge's own `enabled` is `true`; re-enabling the node alone is enough to restore that edge without needing to touch it directly.

For an executable relationship, `equationModel` is required and contains:

- `latex`: the editable presentation expression.
- `bindings`: integer-ID-backed state and parameter bindings with stable expression symbols.
- `output`: the state receiving the expression's derivative contribution.
- `mathJson`: the executable expression tree. Version 1 supports numeric literals, bound symbols, `Add`, `Multiply`, `Negate`, `Divide`, `Power`, `Sqrt`, `Abs`, `Exp`, `Ln`, `Log`, `Sin`, `Cos`, `Tan`, `Min`, and `Max`.

LaTeX is never executed directly. Multiple relationships targeting the same state contribute additively to its derivative.

Source terms use the same structure under `expressionModel`: integer-ID-backed local-state bindings, an output state, editable LaTeX, and executable MathJSON. Source terms and relationships targeting the same state are summed before each integration step.

An edge or source term may be programmable instead of an equation: it carries an `implementation` object (in place of `equationModel`/`expressionModel`) and its own top-level `expression`/`equation` field is left empty. `implementation` contains:

- `kind`: `cpp` or `python`.
- `providerApiVersion`: integer, currently `1`.
- `source`: the inline C++ or Python source text the user authored in the Provider Editor, or (for Python) a path to a standalone script.
- `bindings`: an array naming the provider's own port keys. A state binding is `{ key, kind: "state", nodeId, stateId }`; an edge may also bind `{ key, kind: "parameter", parameterId }`. No `role` is needed on a binding (unlike `equationModel`/`expressionModel` bindings) — it just names which state or parameter feeds that port key, for either a source term's one local side or either of an edge's two endpoints.
- `output`: `{ key, stateId }` for a source term, or `{ key, role, stateId }` for an edge — the port key the provider's `addGradient()` call fills, mapped to the state receiving the contribution (`role` disambiguates a bidirectional edge's two endpoints, exactly as it does for `equationModel`'s output).

An installed provider may be referenced without embedding its source by using `kind: "plugin"`, `pluginId`, `pluginVersion` and `providerId` instead of `source`. Before validation and execution, the host resolves that reference to the installed plugin's declared `cpp` or `python` provider artifact. The version is required so numerical behavior is not silently changed by an upgrade. Plugin packages and their installation rules are documented in [Plugin development](pluginDevelopment.md).

At run time, the engine compiles `source` (for `cpp`) into a native provider artifact and evaluates it out-of-process or in-process depending on the configured transport; see [Provider execution transports](providerExecution.md). The C++ authoring API lives in `engine/include/konjugate/relationshipProvider.hpp`.

A node may itself carry an `implementation` object: a computational-node provider that owns the node's own dynamics, evaluated once per substep alongside (or instead of) equation-based `sourceTerms`. This release accepts only `kind: "python"` (C++ computational-node execution is not implemented yet). `providerApiVersion`, `source` and `bindings` follow the same shape as a source term's -- own-node states only, `{ key, kind: "state", stateId }`, no `nodeId`/`role` disambiguation, and a node has no parameter concept to bind against. Unlike an edge or source term's single `output`, a node's `implementation` declares `outputs`: a non-empty array of `{ key, stateId }` pairs, each naming one of the node's own states and the named gradient key the provider's `add_gradient(key, value)` call contributes to it. A computational-node provider is checkpointable; see the checkpoint and `startCheckpoint` paragraphs below.

An edge may also carry `groupId`, referencing an entry in the top-level `edgeGroups` array: `{ id, name, memberNodeIds, color, definition }`. `definition` holds one shared relationship definition -- an `equation` or `implementation`, plus `parameters`, using the same shapes as an edge's own -- except its bindings are **symbol-keyed** rather than ID-keyed, since the definition has no fixed pair of nodes to bind against: `output` is just `{ symbol }` (every generated edge contributes to its own target by construction, so there is no role to store), and an implementation binding is `{ role, symbol }` in place of `{ nodeId, stateId }`. It expands into a complete mesh across `memberNodeIds`: one **directed** edge for every ordered pair of members -- both A → B and B → A, never a single bidirectional edge; see [Edge and relationship directionality](edgeDirectionality.md) for why -- each an ordinary edge record carrying `groupId` and its own fully resolved, ID-keyed bindings (resolved the same way a Component Library edge template auto-binds, by exact state-symbol match on each pair's two nodes). Editing a group's `definition` re-resolves and overwrites every member edge; no member edge may diverge from it independently. Like subsystems, this is authoring/editing-layer structure: the host strips `edgeGroups` and every edge's `groupId` before validation and execution, so the engine sees only ordinary, individually-resolved edges. See [Edge groups](edgeGroups.md) for the full design.

Projects may contain named numerical `runConfigurations` and an `activeRunConfigurationId`. A numerical configuration contains `globalTimeStep` and `outputInterval` in seconds; output interval is an integer multiple of the global timestep. It may also contain the `execution` settings described in [Parallel execution](parallelExecution.md). Target time and pacing belong to the transient launch request rather than the model. Pacing selects `fastest`, `realTime`, or `limitedRatio`; limited pacing also supplies a positive `simulationSecondsPerWallSecond`. Pacing limits wall-clock execution and does not alter numerical timesteps. During each global step, every node advances with `globalTimeStep / substepsPerGlobalStep`. References to the advancing node use its latest local state; references to other nodes use the frozen state snapshot from the start of the global step. Nodes synchronize at the global boundary.

Engine results distinguish display `samples` from restart `checkpoints`. Each checkpoint has a UUID, simulation time, complete state vector, and solver identity. Explicit Euler currently has no additional hidden solver state; future integrators extend the checkpoint record rather than treating plot samples as restart data. A node carrying a computational-node provider is the first case of *provider-owned*, not solver-owned, hidden checkpoint state: each checkpoint additionally carries a `providerStates` array of `{ nodeId, payload }` entries, one per node with an `implementation`, where `payload` is that provider instance's opaque `checkpoint()` output (base64-encoded when it appears in a plain-JSON launch request, raw bytes in the binary result format).

The engine accepts an optional `startCheckpoint` in a launch request. Its complete state vector replaces model initial values and its time becomes the segment start. If the model contains any computational-node provider, `startCheckpoint` must also carry a `providerStates` array with exactly one `{ nodeId, payload }` entry per such node; a restart is rejected outright if any is missing, rather than silently resetting a provider's internal state to its `initialize()` default. `targetTime` is absolute and must be later than that checkpoint. The current UI uses this only to continue a stopped partial run from its latest checkpoint. Branch creation and earlier-checkpoint restart remain deferred until their interaction model is designed.

Unknown fields must be preserved when possible. Readers reject unsupported major schema versions. Additive fields may be introduced within a schema version when older readers can safely ignore them.
