<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Interaction providers

## Status

This document originated as a pre-implementation architecture proposal. The initial vertical slice it scoped — stateless C++ and Python providers, evaluated inline with equation semantics — is now implemented, tested and in active use, and is described below as built rather than proposed. The broader architecture (reusable plugins, computational-node providers, FMU/live/remote providers, the public API, packaging) remains a direction for discussion and does not yet define a stable plugin ABI or engine protocol beyond the relationship/source-term provider contract described here. The central proposal is that a relationship, a node's own source term, and eventually a computational node, may delegate behavior to an execution provider supplied inline or by an engine plugin. Existing equations remain the simplest built-in provider.

See [Implementation status](#implementation-status) for a concrete summary of what exists today versus what remains a proposal.

## Initial implementation scope

The first vertical slice is deliberately narrower than the complete architecture. It adds two programmable implementation kinds, available on both relationships (edges) and a node's own source terms:

- Implemented by C++ source compiled into a native provider executable
- Implemented by Python source run with a selected interpreter

Both are managed local child processes using the same engine-owned protocol and lifecycle. The user writes the calculation, while a Konjugate-provided language wrapper handles protocol framing, binding tables and process startup. Provider source and binding metadata are stored with the project. The selected compiler or interpreter path remains a machine-local preference.

The initial providers are stateless, accept bound scalar states (and, for relationships, parameters), and return one derivative contribution to an explicitly selected output state. They are evaluated with the same simulation-time semantics as an equation. Persistent provider state, computational-node providers, algebraic outputs, events and commands are deferred until checkpoint and solver interactions have been designed.

The initial implementation does not integrate FMUs, Simulink, Modelica, hardware, remote services or arbitrary third-party applications. Those systems will generally require a dedicated plugin and protocol adapter. The generalized manifest, binding and lifecycle design should avoid preventing such plugins later, but no external-software integration is required to validate the first C++ and Python relationship providers.

## Implementation status

This section is the concrete, current-state counterpart to the rest of this document, which mostly still reads as architectural discussion. Update it alongside any change to the provider engine, SDKs or editor UI.

### Built and tested

- **Protocol**: `protocol/relationshipProvider.proto` — a versioned Protobuf handshake/initialize/evaluateBatch/shutdown exchange over framed stdin/stdout, matching [External-process protocol](#external-process-protocol).
- **C++ SDK**: `engine/include/konjugate/relationshipProvider.hpp` (the public, engine-independent header a provider author includes) plus `engine/src/providerWorker.cpp` (the worker `main()` Konjugate supplies, linked together with the author's implementation into one executable). The wire codec on this side is hand-rolled rather than linked against libprotobuf, so a provider build never needs protobuf installed — see [Author-facing provider classes](#author-facing-provider-classes) for the actual shipped interface, which is a simplified single-`inputs`-list version of the sketch below.
- **Python SDK**: `engine/sdk/python/konjugate/__init__.py` (author-facing classes) and `__main__.py` (the worker, `python -m konjugate <source>`), with the same hand-rolled wire codec for the same reason.
- **C++ build pipeline**: `ProviderRuntime` compiles inline C++ source together with the SDK header and worker wrapper on first use, using a discovered compiler (`xcrun -find clang++` plus SDK sysroot on macOS, falling back to `c++`) and caching the built executable by a hash of the source text. A titlebar settings dialog (⚒, next to the model assistant button) lets the user override the auto-detected compiler and interpreter path per machine, with Browse/Test actions — see [Local toolchains and runtimes](#local-toolchains-and-runtimes).
- **Packaged builds ship the SDK sources**: the C++ header, `providerWorker.cpp`, and the Python `konjugate` package are installed alongside the engine binary (`engine/CMakeLists.txt`) and bundled into a packaged app's resources, so inline providers build and run the same way from a packaged `.app`/installer as from a dev checkout.
- **Engine integration**: `executionPlan.cpp` compiles a programmable edge or source term into the same `ContributionTask`/`ProviderEvaluator` abstraction an equation uses, so provider and equation contributions share evaluation cadence, ordering and reduction. `modelValidator.cpp` validates provider structure (API version, source non-empty, binding key format/uniqueness, output reference) before a run starts.
- **Concurrency safety**: one child process serves every relationship or source term instance sharing the same inline source (or plugin artifact, in the future), per [Own one worker per plugin artifact](#3-own-one-worker-per-plugin-artifact). Calls into a given `ProviderProcess` are mutex-serialized, since the engine's thread-pool/partitioned execution backends evaluate different nodes concurrently and a raw pipe round-trip is not reentrant. Task-to-instance routing uses each edge/source term's stable numeric ID, not a per-node local index, so two contributions on different nodes never collide.
- **Source terms as a first-class provider location**: a node's own source term now supports the same Equation/C++/Python choice as a relationship, with no source/target duality — bindings and the output always reference the owning node's own states only. See [Source terms](#source-terms) below; this was not in the original scope of this document and is documented here as an adopted extension of it.
- **Validation stance on bindings**: neither a relationship nor a source term is required to declare any input binding — a provider may legitimately compute from parameters, time, or nothing at all. The one exception is a soft warning (not an error) when a provider has zero bindings *and* its source still contains the generated template's unedited `TODO: read` marker, since that combination signals the author has not started implementing it. Writing any real source clears the warning regardless of whether bindings are ever added.
- **Editor UI**: both the relationship editor/builder and a new dedicated source-term editor/builder offer an Implementation selector (Equation / C++ program / Python program), a bindings list, an output-key field, starter-template generation (`src/providerTemplate.mjs`, regenerable via "Reset template"), and an "Open code editor" button that opens a dedicated syntax-highlighted, live-validated editor window — see [User experience](#user-experience).

### Not yet built

- Discovery among *multiple* compatible compilers/interpreters (today it's still auto-detect-one-or-manually-override, not a list to choose from); Windows/Linux auto-detection beyond the plain `c++`/`python3` fallback.
- Recording compiler identity, build configuration and artifact hash in the project or results (see [Reproducibility and results](#reproducibility-and-results), [Packaging and portability](#packaging-and-portability)).
- Everything scoped as a non-goal below: reusable plugin packaging, stateful/computational-node providers, algebraic outputs, events and commands, FMU/live/remote providers, the public engine API, and multi-output relationships.

## Add-ons and plugins

Konjugate uses two extension concepts with deliberately different responsibilities:

| Extension | Layer | Examples | Consequence of failure |
| --- | --- | --- | --- |
| Add-on | Electron application and presentation | Result visualizer, dashboard, modelling interface | The optional interface closes or becomes unavailable |
| Plugin | Native engine and numerical execution | Relationship provider, computational node, external-system adapter | A dependent model cannot run or the active run fails |

Add-ons are hosted by Electron through browser-facing, permission-controlled bridges. They are normally optional, asynchronous and unnecessary for CLI execution. Plugins are resolved and supervised by the native engine, are required when referenced by a model and affect numerical behavior or reproducibility. The current result-visualizer add-on architecture remains separate and does not need to become a generic execution host.

The two systems may share low-level conventions for identifiers, semantic versions, hashes, signatures, licensing and installation presentation. They retain separate manifests, registries, permission models, API versions and runtime hosts. A package distributor may offer a visualizer add-on and a numerical plugin as one product, but installing or trusting one must not grant authority to the other.

The long-term plugin system may support contribution kinds such as:

| Plugin contribution | Responsibility |
| --- | --- |
| `relationshipProvider` | Calculate declared contributions from bound relationship inputs |
| `nodeProvider` | Implement a stateful computational component with checkpoint support |
| `connector` | Adapt an approved application, service or physical device to engine data and lifecycle APIs |
| `validator` | Add domain-specific diagnostics without replacing native validation |

This list is directional. The initial implementation adds only `relationshipProvider` for C++ and Python. “Anyone can create anything” means developers can build any numerical or integration behavior expressible through a declared plugin interface. It does not mean a plugin receives mutable engine memory or ambient authority. Narrow interfaces protect users and allow the engine to evolve without breaking every plugin.

### Inline code and reusable plugins

Inline C++ and Python relationships are the authoring entry point. Their source, bindings and configuration belong to one project. A useful inline relationship may later be promoted into a reusable plugin contribution with stable identity, a configuration schema, tests, licenses and versioned artifacts:

```text
Inline C++ or Python relationship
                 │
                 └── package and publish
                          │
                          └── reusable relationship-provider plugin
```

An installed plugin can contribute one or more named relationship types. Its manifest supplies parameter and binding schemas from which Konjugate can generate an ordinary configuration interface. A user of a prebuilt plugin chooses it, binds its declared ports and enters parameters without needing to read source or configure a compiler.

External-software support follows the same model later. An FMI, Simulink, CAN or vendor-solver integration should normally be a `connector`, `relationshipProvider`, `nodeProvider` or combination of contributions supplied by a plugin. The engine provides generalized lifecycle and data APIs rather than hardcoded knowledge of each external product. A separate add-on may provide a specialized configuration or visualization interface for that plugin through the existing application-facing boundaries.

## Motivation

Konjugate currently evaluates relationships from validated equations. This is appropriate for compact constitutive laws but it cannot directly host a substantial controller, vendor model, machine-learning surrogate, specialist solver, physical device or proprietary black box. Treating all of those cases as “scripts” would make the feature appear smaller than it is and would encourage implementation-specific APIs.

An interaction provider is a generalized implementation of behavior at a graph boundary. It consumes explicitly bound model values and produces declared contributions, values, events or commands. The graph owns identity and connectivity while the provider owns an implementation that may range from one equation to a separately developed program.

Potential applications include:

- Proprietary tire, motor, inverter, battery or material models
- C++ constitutive laws compiled into native provider executables
- FMU/FMI co-simulation components
- Simulink, Modelica or other generated models
- Python or ONNX machine-learning surrogates
- PLC, CAN, serial and hardware-in-the-loop adapters
- Remote solvers and organization-hosted simulation services
- Live telemetry and digital-twin inputs

## Architectural principle

Equations should become one provider kind rather than a special execution path that every plugin must bypass. A relationship would declare its endpoints, bindings and outputs independently from how those outputs are calculated:

```text
Node A ── relationship ── Node B
                 │
                 └── execution provider
                     equation | native process | FMU | native extension | live
```

The native C++ validator remains the source of truth. It validates the provider description, bindings, artifacts and compatibility with the requested run configuration before the engine begins a run.

## State ownership

Nodes should continue to own meaningful model state. A stateless provider on an edge is a natural representation for heat flow, force, current, mass transfer, contact, a constitutive law or a command derived from endpoint values. If a program represents a controller integrator, actuator dynamics, accumulated damage, transport volume or another independently meaningful evolving system, it should normally be represented as a computational node with relationships connecting its inputs and outputs.

Some external black boxes inevitably contain internal state that cannot be exposed. Such state must not be treated as nonexistent. A stateful provider must declare that it owns opaque state and must define checkpoint and restore behavior. Results should identify opaque provider state separately from graph state. A provider that owns opaque state but cannot checkpoint it cannot support continuation, rollback, deterministic replay or migration between workers.

This distinction preserves the graph-native model without forbidding realistic proprietary or generated components:

| Behavior | Preferred placement |
| --- | --- |
| Stateless interaction between endpoint values | Relationship provider |
| Stateful physical or logical component | Computational node provider |
| Stateful black box whose internals cannot be exposed | Node provider with declared opaque state |
| External program supervising several relationships | Explicit supervisory node or subsystem |

## Source terms

**Implemented.** A node's own source term — a contribution to one of that node's own states, with no other endpoint — is structurally the same kind of stateless, edge-boundary-free contribution described above, and the engine already represents it identically: both a relationship and a source term compile into the same `ContributionTask`, share `ProviderRuntime`, and are evaluated with the same substep-synchronous cadence. This document did not originally scope source terms as a programmable location; the implementation extended the relationship-provider work to cover them once it became clear the underlying engine contract required no changes to do so.

The one real difference from a relationship provider is the absence of source/target duality:

- A source term has exactly one owning node. Bindings only ever reference that node's own states — there is no "which endpoint" choice, and no node-level parameter concept to bind against (parameters belong to relationships, not nodes).
- The output is `{key, stateId}` with no `role` field, since there is only one node it could belong to.
- A binding is declared as `{key, kind: "state", stateId}`, again with no `nodeId`/`role` disambiguation needed.
- Zero declared bindings is legitimate (a source term may be a constant or purely time-based contribution); see [Recommended decisions before implementation](#recommended-decisions-before-implementation) for the shared warning-not-error stance this and relationships now take on that.

Everything else — the C++/Python SDK, the build/interpreter pipeline, the validator's provider-structure checks, the editor's Implementation selector, template generation and the dedicated code-editor window — is shared verbatim between relationships and source terms.

## Provider kinds

The architecture should eventually allow several provider adapters behind one conceptual contract. The initial implementation supports Equation, C++ program and Python program only. Supporting a future kind does not imply that it is trusted or suitable for every execution mode.

### Equation

The existing stable-ID-backed equation and MathJSON implementation. It is deterministic, portable, inspectable and inexpensive to evaluate at every substep.

### Native external process

A separately launched local program communicates with the engine through a versioned protocol. This is the preferred programmable-provider mechanism. A C++ provider is compiled into a native executable for the current operating system and architecture. A Python provider is launched using a selected interpreter and environment. Existing programs written in other languages can participate by implementing the same protocol.

The provider process remains alive for the run and serves repeated evaluation requests after one initialization handshake. It is not relaunched for each relationship or timestep. Process isolation limits crash propagation and avoids a shared C++ library ABI, but it does not create a security sandbox. Launch authority, filesystem access, network access and device access remain explicit trust decisions.

The engine should support batching multiple provider instances into one request and one process. Stable binding tables are sent during initialization, while repeated evaluations exchange packed numeric arrays. Shared memory may be added for measured high-volume cases without changing the conceptual provider contract.

For the initial implementation, Konjugate supplies separate C++ and Python wrappers over this common protocol. Relationship authors implement the managed provider-class lifecycle described below rather than process management. Exact SDK type names and convenience accessors may be refined, but the source interface must not expose mutable engine memory.

### FMU/FMI

This is deferred. A future plugin could host an FMU using its declared model-exchange or co-simulation semantics, map Konjugate bindings to FMI variables and report the FMU version, platform support, rollback capability and preferred communication step.

### Trusted native extension

A separately installed native library offers the lowest call overhead and unrestricted platform integration. It also has the greatest security, ABI and crash risk. Native extensions should be installed and trusted independently of a project. A `.kjt` should reference an installed extension by identifier, version and artifact hash rather than silently load an embedded native library.

### Live or remote provider

This is deferred. A future plugin could connect a device, service or telemetry source that operates according to wall time and may be unavailable, delayed or nondeterministic. Such an adapter requires explicit buffering, timestamp, validity, timeout and failure policies and is fundamentally different from an offline provider called synchronously at every numerical substep.

## Plugin manifest

Every reusable non-equation provider should expose a declarative `plugin.json` before any implementation is executed. Inline code uses the same relationship-provider description inside its project-owned definition without pretending to be a globally installed plugin. A provisional reusable-package shape is shown only to make the required information concrete:

```json
{
    "pluginId": "example.fluidModels",
    "name": "Fluid Models",
    "version": "2.1.0",
    "manifestVersion": 1,
    "contributes": [{
        "kind": "relationshipProvider",
        "providerId": "controlValve",
        "apiVersion": 1,
        "runtime": "cpp",
        "determinism": "deterministic",
        "inputs": [],
        "outputs": [],
        "artifacts": []
    }],
    "permissions": []
}
```

The final format should describe at least:

- Stable plugin and provider identifiers, plugin version and Konjugate provider API version
- Input and output ports with scalar type, shape, unit and semantic role
- Whether state is absent, explicit or opaque
- Initialization, checkpoint, restore and shutdown capabilities
- Timing and communication-step requirements
- Determinism, reentrancy and threading guarantees
- Supported operating systems and architectures where applicable
- Artifact hashes, signatures, licenses and required notices
- Requested permissions and external dependencies
- Reference vectors or conformance tests

Project bindings should use stable numeric model IDs. Human-readable names and symbols remain mutable presentation metadata and must not be the authoritative reference.

### Plugin interface boundaries

A relationship provider receives only declared input values and returns only declared contributions. A node provider receives declared values and explicit checkpoint storage. A connector receives only explicitly granted endpoint or device access. Sharing a plugin package must not cause one contribution to inherit another contribution's authority.

Add-ons remain outside this interface. A result visualizer continues to receive read-only, bounded result access through its Electron bridge. Installing an add-on must not grant engine-plugin permissions, and installing a plugin must not grant application UI or result-storage access.

## Author-facing provider classes

**Implemented**, as `engine/include/konjugate/relationshipProvider.hpp`. It defines the `konjugate::sdk::v1::RelationshipProvider` abstract class and SDK-owned description, port, input-view and output-collector types. A C++ author implements that class rather than writing a `main` function or handling the worker protocol.

The shipped interface is a deliberate simplification of this document's original sketch: `describe()` returns one flat `inputs` list (states and parameters are not distinguished at the SDK level — both are just named scalar ports) and one scalar `output`, rather than separate `inputs`/`parameters`/`outputs` collections. Exact type names may still evolve, but this is the real, versioned interface providers are written against today:

```cpp
namespace konjugate::sdk::v1 {

struct ScalarPort {
    std::string key;
    std::string name;
    std::string unit;
};

struct RelationshipDescription {
    std::string providerId;
    std::string name;
    std::vector<ScalarPort> inputs;
    ScalarPort output;
};

struct InitializationContext {
    std::uint64_t instanceId = 0;
};

class InputView {
public:
    double at(std::size_t index) const;
    double at(std::string_view key) const;
};

struct EvaluationContext {
    double simulationTime = 0;
    double stepSize = 0;
    InputView inputs;
};

class OutputCollector {
public:
    void addGradient(double value) noexcept;
};

class RelationshipProvider {
public:
    virtual ~RelationshipProvider() = default;
    virtual RelationshipDescription describe() const = 0;
    virtual void initialize(const InitializationContext&) {}
    virtual void evaluate(const EvaluationContext&, OutputCollector&) = 0;
    virtual void shutdown() noexcept {}
};

}

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider();
```

An implementation resembles:

```cpp
#include <konjugate/relationshipProvider.hpp>

class ThermalConduction final : public konjugate::sdk::v1::RelationshipProvider {
public:
    konjugate::sdk::v1::RelationshipDescription describe() const override {
        return {
            "thermalConduction", "Thermal conduction",
            {
                {"sourceTemperature", "Source temperature", "K"},
                {"targetTemperature", "Target temperature", "K"},
                {"conductance", "Conductance", "W/K"}
            },
            {"targetTemperatureGradient", "Target temperature gradient", "K/s"}
        };
    }

    void evaluate(const konjugate::sdk::v1::EvaluationContext& context,
                  konjugate::sdk::v1::OutputCollector& output) override {
        const double difference = context.inputs.at("sourceTemperature") - context.inputs.at("targetTemperature");
        output.addGradient(context.inputs.at("conductance") * difference);
    }
};

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider() {
    return std::make_unique<ThermalConduction>();
}
```

`initialize()` and `shutdown()` default to no-ops and only need overriding when a provider allocates non-model caches. Note that `describe()` collapses the doc's separate "states/parameters" and "gradient outputs" concepts into one `inputs` list and one `output` port — a stateless provider does not need to know at the SDK level whether a bound value came from a state or a parameter; the engine resolves that distinction when it builds the binding table. The default-generated starter template (`src/providerTemplate.mjs`, surfaced via "Reset template" in the editor) always produces exactly this shape, with one `ScalarPort` per declared binding.

Konjugate supplies the worker wrapper containing `main` (`engine/src/providerWorker.cpp`). The provider build combines the public SDK header, user implementation and version-matched wrapper into one native executable. The wrapper calls the factory, handles the wire protocol, resolves instance bindings, constructs SDK views, converts exceptions into structured failures and guarantees shutdown. `ProviderRuntime` (`engine/src/providerRuntime.cpp`) performs this build automatically the first time a given inline source is used in a run, caching the result by a hash of the source text.

```text
Public SDK header
+ user implementation
+ Konjugate worker wrapper
            │
            └── native compiler ── provider executable
                                         ↕ Protobuf
                                  Konjugate engine
```

The abstract C++ interface never crosses the process boundary. The user implementation and worker wrapper are compiled together, so the engine does not share C++ object layout, exception ABI or standard-library containers with the provider. Only the versioned Protobuf-shaped protocol crosses between processes. A separately compiled shared library would require a different stable ABI and is not part of the initial design.

Both worker wrappers (`providerWorker.cpp` for C++, `__main__.py` for Python) implement the wire format from `protocol/relationshipProvider.proto` by hand — encoding/decoding the same field numbers and wire types Protobuf would — rather than linking libprotobuf, so a compiled provider executable never needs protobuf as a build dependency. The engine side (`providerRuntime.cpp`) does use generated Protobuf code from the same `.proto` file, so the schema has one source of truth even though the wire codec is duplicated by hand on the worker side; keep the three implementations in sync if the protocol changes.

The public SDK must remain independent of engine implementation types. It should expose small versioned value types, numeric views and metadata rather than Boost property trees, execution-plan objects or mutable engine containers. Exceptions do not cross processes; the wrapper catches them and returns structured provider errors.

### Description and binding

`describe()` declares provider-local input and output ports. It does not enumerate or acquire access to project states. The relationship or source-term editor binds those ports to concrete states and parameters using stable numeric model IDs, and the native validator approves the complete binding before a worker is initialized. A source term's bindings only ever reference its own node's states — there is no source/target duality and no node-level parameter concept, so a binding is simply `{key, kind: "state", stateId}` with no `nodeId`/`role`.

For example:

```text
sourceTemperature input  → Battery.temperature, state ID 42
targetTemperature input  → Coolant.temperature, state ID 91
targetTemperature output → Coolant.temperature, state ID 91
```

Renaming either node or state does not break the binding. The provider continues to use its own stable port identifiers while display names remain presentation metadata.

### Initialization

`initialize()` receives one resolved, validated relationship-instance configuration. It may inspect relationship and instance IDs, binding metadata, parameter values, units, initial simulation time, timestep information and run metadata. It receives only the states and outputs explicitly granted through the binding.

The initial provider contract is mathematically stateless. Initialization may allocate buffers or precompute constants, but it must not create hidden evolving model state. Meaningful persistent behavior belongs to a future node-provider and checkpoint contract.

### Evaluation

`evaluate()` receives the current simulation context and read-only values for the declared inputs and parameters. It adds values to declared gradient outputs through an SDK-owned collector. It cannot replace a state, retain a mutable view into engine memory or contribute to an undeclared state.

The initial implementation permits one bound gradient output. The description model may be designed so that multiple outputs can be introduced later, but they must not be enabled until scheduling between endpoint nodes with different substep counts has defined semantics.

### Shutdown

`shutdown()` releases instance-owned caches and resources. It is invoked after normal completion, cancellation, a stopped run, engine failure and application shutdown whenever initialization succeeded. The method is `noexcept`; cleanup failures are reported by the wrapper without allowing an exception to escape process teardown.

### Python equivalent

**Implemented**, as `engine/sdk/python/konjugate/__init__.py`. `RelationshipProvider` is an `abc.ABC`; `describe()`/`evaluate()` are abstract, `initialize()`/`shutdown()` default to no-ops — the same shape as the C++ SDK, including the single flat `inputs` list and single `output` port rather than separate parameter/output collections:

```python
from konjugate import (
    EvaluationContext,
    InputView,
    OutputCollector,
    RelationshipDescription,
    RelationshipProvider,
    ScalarPort,
)


class ThermalConduction(RelationshipProvider):
    def describe(self):
        return RelationshipDescription(
            "thermalConduction",
            "Thermal conduction",
            [
                ScalarPort("sourceTemperature", "Source temperature", "K"),
                ScalarPort("targetTemperature", "Target temperature", "K"),
                ScalarPort("conductance", "Conductance", "W/K"),
            ],
            ScalarPort("targetTemperatureGradient", "Target temperature gradient", "K/s"),
        )

    def evaluate(self, context, inputs, outputs):
        difference = inputs["sourceTemperature"] - inputs["targetTemperature"]
        outputs.add_gradient(inputs["conductance"] * difference)
```

Konjugate launches the selected Python interpreter (`python3` by default; no interpreter-discovery UI exists yet, only a `pythonInterpreter` configuration field) with its supplied worker module, `python -m konjugate <source path>`. The worker imports the provider, validates its methods, handles the same wire protocol as the C++ side and translates Python exceptions into structured failures. C++ and Python providers therefore share binding, timing and contribution semantics even though their language-level SDKs remain idiomatic. The Python worker never executes arbitrary source as part of *validation* — the editor's live syntax check (see [User experience](#user-experience)) uses `ast.parse` only, never imports or runs the module — so validation-while-typing cannot execute what the user has typed.

## Runtime contract

The author-facing class is the initial stateless subset of a broader process-level lifecycle. The generated worker owns validation, batching and protocol operations. Future stateful provider kinds may extend the process contract with commit, checkpoint and restore without adding those methods prematurely to the initial relationship-provider SDK.

The broader conceptual lifecycle is:

```text
describe → validate → initialize → evaluate/commit → checkpoint → shutdown
                                      ↑       │
                                      └───────┘
```

Possible operations are:

| Operation | Purpose |
| --- | --- |
| `describe` | Return interface and capability metadata without executing model behavior |
| `initialize` | Create one run-scoped instance from validated configuration and initial bindings |
| `evaluate` | Calculate tentative outputs for a stated simulation time and step |
| `commit` | Accept a tentative step when the integration strategy requires separation from evaluation |
| `checkpoint` | Serialize complete provider-owned state into a versioned opaque payload |
| `restore` | Restore the exact state represented by a compatible checkpoint |
| `shutdown` | Release workers, callbacks, files, devices and child processes reliably |

The distinction between `evaluate` and `commit` matters for solvers that retry a step, evaluate an algebraic loop or roll back after an event. A first implementation may support only providers whose evaluation has no irreversible side effects, but the contract should not assume every evaluation is automatically committed.

Only `describe`, `initialize`, `evaluate` and `shutdown` are implemented today, matching the stateless relationship/source-term SDK above. `commit`, `checkpoint` and `restore` remain future work pending the stateful computational-node provider design.

## Outputs

A provider should not receive unrestricted write access to the engine state vector. It should return declared outputs that the engine validates and applies in stable order. Candidate output roles include:

- Derivative contribution to a bound node state
- Algebraic value published through a provider port
- Discrete event with simulation timestamp
- Parameter or actuator command accepted at a synchronization boundary
- Diagnostic or measurement channel recorded in results

The initial relationship-provider contract returns one derivative contribution. Multiple declared contributions may later be useful for conservative interactions, but their scheduling semantics must be defined when endpoint nodes use different substep counts. Direct state replacement should be exceptional because it complicates integration, conservation and reproducibility.

## Timing models

Providers need explicit timing semantics. Initial C++ and Python relationship providers follow equation semantics and are evaluated at every applicable node substep. Future co-simulation, live and remote providers may require a different cadence; treating all future providers as substep functions would be incorrect and potentially prohibitively expensive.

### Substep synchronous

The provider is a pure or rollback-safe numerical function called by the integrator. Equations and sufficiently fast native provider processes fit this mode. Evaluation must be bounded and deterministic enough for the selected backend. The execution planner should batch calls where possible because even a native process has communication overhead.

### Synchronization-boundary co-simulation

The provider exchanges values at global synchronization boundaries and may advance its own internal solver over the communication interval. FMUs, generated programs and substantial external solvers fit this mode. The provider declares its accepted communication-step range and rollback capability.

### Wall-clock asynchronous

The provider receives or emits timestamped information independently of numerical steps. Hardware and remote services fit this mode. The run configuration defines whether simulation time follows wall time, how data are interpolated or held, the maximum accepted age and what occurs when data arrive late.

### Event driven

The provider is invoked when declared inputs change or an event is scheduled. This can avoid unnecessary calls for supervisory logic but requires deterministic event ordering and clear interaction with continuous integration.

## Parallel and partitioned execution

**Partially implemented.** Today `ProviderProcess` simply mutex-serializes every pipe round-trip to a given provider worker, so it is safe to call from the engine's thread-pool and partitioned backends but does not yet reentrantly parallelize across concurrent evaluations. Tasks are routed to a worker by `ContributionTask::sourceId` (a stable identifier), not `::sequence` (a per-node-local index), because the latter collides across nodes/edges under concurrent evaluation. The declared-reentrancy, cost-aware partitioning and invocation-cost reporting described below remain unimplemented.

Provider capabilities must participate in execution planning. A provider may declare itself reentrant, one-instance-per-worker, single-threaded or externally serialized. The partitioner should account for provider computation cost and communication cadence. A stateful instance must remain attached to its owning node or partition unless it supports checkpoint-based migration.

An external-process call across every graph cut could dominate numerical work. Execution summaries should therefore report provider invocation counts, evaluation time, serialization volume, wait time, timeouts and fallback decisions. Automatic backend selection must be allowed to avoid partitioning when provider placement or communication makes it counterproductive.

Serial, thread-pool and partitioned paths must apply provider outputs in deterministic graph order when the provider itself is deterministic. Parallel completion order must not become numerical contribution order.

## External-process protocol

The existing engine protocol suggests using versioned Protobuf framing for local process providers. The protocol should exchange numeric arrays and stable binding tables without converting every evaluation through JSON. Large static metadata can be sent during initialization rather than repeated on every call.

The engine should launch a provider process with explicit pipes or a narrowly scoped local transport, complete a capability handshake, validate protocol and provider versions then establish a run-scoped session. Requests require monotonically increasing sequence numbers and simulation timestamps. Shutdown must close streams, reject outstanding callbacks, terminate children within a bounded grace period and report abnormal exits.

Remote providers require a separate transport adapter. A local process protocol should not imply that arbitrary network endpoints are safe or numerically suitable.

## Local toolchains and runtimes

**Partially implemented.** C++ auto-detection today is a fixed macOS path only: `xcrun -find clang++` plus the Apple SDK sysroot from `xcrun --show-sdk-path`, falling back to the plain `c++`/`python3` on other platforms. A manual override does exist now: the titlebar's "Provider toolchains" dialog (⚒) lets the user set an explicit compiler/interpreter path per machine, Browse to one via a native file picker, and Test it before saving (`providerToolchainStore.mjs`, `userData/providers/toolchains.json`) — this is consumed both by the live editor's syntax check and by the actual engine run (`providers.cpp.compiler`/`providers.python.interpreter`). What's still missing is discovery *among several* installed options presented as a list, and Windows/Linux auto-detection beyond the bare fallback names. Compiled C++ providers are cached by a hash of their source, so an unchanged provider is not rebuilt on every run, but the resulting artifact identity, compiler identity and build configuration are not yet recorded in the project or results.

Source-based providers require tools that are installed on the user's computer. Konjugate should discover common compilers and interpreters, validate them and let the user choose among compatible options. It should also allow an executable path to be selected manually. Discovery should inspect documented platform mechanisms and standard executable paths rather than search the entire filesystem.

### C++ compilers

Likely discovery mechanisms include Apple Clang through `xcrun` on macOS, Visual Studio and MSVC discovery on Windows, and Clang or GCC from standard paths on Linux. Each option should display its implementation, version, executable path, target architecture and supported provider ABI. Finding a compiler does not imply that every project dependency is installed, so a provider build must still perform an explicit configuration check.

A source provider package may include a narrowly defined CMake project or another documented build description. Konjugate builds it in a provider-specific directory, runs its declared conformance tests and records the compiler identity, build configuration and resulting executable hash. Builds should not write into the source package or silently fetch dependencies. Dependency acquisition requires a separate explicit action.

Native artifacts are platform and architecture specific. A provider package may include several prebuilt executables, while source allows a compatible artifact to be built locally. The project records provider requirements and artifact identity, not an absolute compiler path from one developer's machine.

### Python interpreters

Likely discovery mechanisms include the Windows Python launcher, standard `python3` and `python` executables, project virtual environments and recognizable Conda environments. Each option should display its version, executable path and environment identity. Users may select another interpreter explicitly.

Python providers run out of process through the same provider protocol as C++ executables. Dependencies should be declared through a lockable environment description such as `pyproject.toml` or a requirements file. Konjugate should prefer a provider-specific virtual environment and must not install packages into a system interpreter automatically. Environment creation and dependency installation require explicit user approval.

### Local preferences and project requirements

Selected compiler and interpreter paths belong to local application settings because those paths are machine specific. A `.kjt` or provider lock records language and runtime requirements, provider version, build inputs and executable hash. Opening the project on another computer initiates dependency resolution rather than attempting to use a path copied from the original machine.

Prebuilt providers should require no compiler or interpreter setup from ordinary users. Toolchain configuration is primarily an authoring and source-rebuild workflow.

## Public API for external programs

The provider protocol answers “how does Konjugate call an implementation attached to the graph?” A separate public API must answer “how does another program use Konjugate?” These directions should share identifiers, messages and result types where useful but should not be conflated. A provider participates inside numerical execution; an automation client controls the engine from outside it.

The public API should target the native engine rather than automate Electron controls. Electron, command-line tools, test runners, organization-specific applications and future services should all be clients of the same authoritative engine contract.

```text
Electron application ─┐
Command-line client ──┼── public engine API ── native validator and simulator
Python/C++ client ────┤                              │
Automation service ───┘                              └── provider protocol ── black boxes
```

### Control plane

External programs need a versioned control plane for comparatively infrequent lifecycle operations:

- Query engine version, capabilities, supported schema and optional integrations
- Submit or reference a `.kjt` project
- Validate a project and receive structured diagnostics
- Create a run from an explicit configuration
- Start, pause, resume, stop and cancel a run
- Update declared live parameters at synchronization boundaries
- Request checkpoints and continue from compatible checkpoints
- Query job status, execution summaries and provider provenance
- Close sessions and release every associated resource

Opening a project should not create an executable session automatically. Validation, session creation and execution are separate requests so a client can inspect errors and dependencies without running code.

### Data and event plane

Long-running jobs need a streaming plane that does not poll or convert large numerical payloads through JSON. A client should be able to subscribe selectively to:

- Run state and progress
- Structured warnings and failures
- Bounded sample batches for chosen state IDs
- Checkpoint availability
- Provider health and timing measurements
- Final result metadata and result-file availability

Subscriptions require explicit state selections, sample cadence and buffer limits. The engine should apply backpressure or bounded downsampling rather than allow a slow client to increase simulation memory without limit. Full-fidelity results remain in the indexed binary result representation and can be queried by state and time range after or during a run where safe.

### Model-edit transactions

External tools may eventually create or edit models, but direct mutation of engine memory would bypass review and validation. The API should accept either a complete project document or a transactional set of typed model operations. An operation batch is applied to an isolated candidate, validated by the native engine and returned with diagnostics and a concrete diff. It becomes the active model only through an explicit commit request.

The initial public API does not need model editing. Project submission, validation, execution and result access form a useful and considerably smaller first contract. Typed edit transactions can follow after the model-operation vocabulary is mature.

### Sessions and identity

Every request should carry an API version, session or job identifier and monotonically increasing sequence number where ordering matters. Model entities continue to use project-scoped numeric IDs. Engine-generated session and job identifiers are runtime identities and must not be confused with persistent model IDs.

A session owns its project snapshot, provider instances, live overrides, subscriptions, temporary files and child processes. Closing a session or losing its controlling connection must invoke a defined cleanup policy. Detached jobs, if supported later, require an explicit retention policy rather than becoming accidental orphan processes.

### Transport and language bindings

Versioned Protobuf messages should define the transport-independent contract. The first transport can remain framed standard input/output for local child-process use because it is portable, testable and already aligned with the engine workflow. A local socket transport can support multiple clients or persistent engine processes later. gRPC can expose the same conceptual service to remote or organization-managed deployments when authentication, authorization, cancellation and resource ownership have been designed.

Language SDKs should be thin generated or hand-maintained clients rather than alternative implementations of simulation behavior. A Python SDK, for example, should submit projects, control runs and decode results while the native engine continues to validate and simulate. C++, JavaScript and other bindings should observe the same protocol semantics.

### API profiles and authority

Not every client needs every operation. Deployments should be able to expose explicit profiles such as read results, execute validated projects, control live parameters, edit models or administer providers. Local desktop use may grant authority through the owning process, while remote transports require authenticated identities and server-side authorization.

Provider installation, native-code trust and credential management should not be ordinary project-edit calls. They are administrative operations with separate review and storage boundaries.

### Compatibility

The API version, project schema version, provider ABI version and result format version solve different compatibility problems and should remain independently negotiated. A client begins with a capability handshake and fails clearly when a required feature is unavailable. Additive optional fields may evolve without changing numerical meaning, while incompatible behavioral changes require an explicit version boundary.

## Reproducibility and results

A result must record enough information to identify the exact behavior that produced it:

- Provider identifier, version, kind and ABI version
- Cryptographic hash of every executable artifact and relevant configuration
- Declared determinism and checkpoint capabilities
- Platform, architecture and runtime version when those can affect results
- Effective timing model and communication step
- Granted permissions and external resource identities
- Provider diagnostics, failures and nondeterministic-data provenance

For a deterministic native provider, the `.kjt` may contain an appropriate platform artifact, its source package or both when licensing permits. A project intended for several platforms may contain multiple signed artifacts or carry source and build requirements. Installed and remote providers use locked references. Opening a project with a missing or mismatched provider should allow read-only inspection but must prevent execution until the dependency is resolved explicitly.

Result playback uses recorded outputs and must not rerun a provider. Continuing a run requires a compatible checkpoint for every stateful provider. A result without the necessary provider checkpoint may remain playable but cannot be extended.

## Security and trust

Provider flexibility creates an execution boundary, not merely a file-format feature. A project received from another person must never execute embedded or referenced code merely because it was opened.

Suggested trust levels are:

| Level | Example | Default authority |
| --- | --- | --- |
| Built in | Equation provider | Runs after normal model validation |
| Isolated but privileged | Native C++, Python or another local process | Requires explicit launch approval and permission review |
| Installed trusted | Native extension | Requires separate installation and trust decision |
| External | Remote service or hardware | Requires endpoint/device approval and run-time availability checks |

Permission prompts should describe concrete capabilities such as filesystem paths, network origins, child processes, devices or environment variables. Trust should attach to an artifact hash and permission set rather than only a mutable provider name. Credentials must remain in Electron secure storage and should be passed through narrowly scoped runtime channels rather than embedded in projects or provider configuration.

Resource limits should include memory, execution time, message size, outstanding requests and output count. Failure to meet a limit should stop or degrade the run according to an explicit policy; it must not silently substitute values.

## Failure semantics

Each provider binding needs a declared failure policy compatible with its physical meaning. Candidate policies include stopping the run, pausing for operator intervention, holding the last valid output for a bounded duration or using an explicitly configured fallback provider. Substitution with zero or stale data must never be implicit.

Failures should identify the provider, simulation time, lifecycle phase, request sequence and whether the last step was committed. Cleanup must run after validation failures, cancellations, engine errors, application shutdown and unexpected provider exits.

## Packaging and portability

An embedded provider package may contain a manifest, platform-specific executable artifacts, optional source, build requirements, schemas, tests, license files and signatures. The `.kjt` container can embed that package when licensing permits. Installed providers use a lock record rather than copying unrelated machine-specific binaries into the project.

Projects should declare portability before execution:

- Portable: a compatible deterministic artifact is embedded for each declared target, or reproducible source and build requirements are available
- Resolvable: required providers are named and can be installed or connected
- Machine constrained: a native extension or device restricts execution to compatible environments
- Unavailable: a locked dependency is missing or has the wrong hash

Packaging must include notices for redistributed provider artifacts. Nothing should depend on untracked package-manager license files.

## User experience

**Implemented for the initial slice.** Both the relationship editor/builder and the node source-term editor default to Equation and offer an Implementation selector with Equation, C++ program and Python program. Prebuilt providers, installed extensions, FMUs and live connections appear only if their separately designed adapters become available later.

Choosing C++ or Python generates a starter template (`src/providerTemplate.mjs`) scoped to the current bindings and output key, with explicit multi-line comments showing how to read each input and write the output. A "Reset template" action regenerates it after confirmation; it is not shown until the author has started editing, so it never displaces a first look at the generated starter.

Editing happens in a dedicated auxiliary window (`src/providerEditor/`, mirroring the existing example-guide window) rather than inline in the relationship or source-term editor. It hosts a CodeMirror 6 editor with language-aware syntax highlighting and runs the source through a live validity check as the author types (debounced): C++ sources are checked with a real `clang++` syntax-only invocation (`-fsyntax-only`), Python sources are checked with `python3 -c "ast.parse(...)"`. The status indicator reflects `valid`/`invalid`/checking, and Apply is only enabled while the last check passed. Applying writes the source back into the same live-edit session (`beginEquationEditSession`/`finishEquationEdit`) used by the inline equation editors, so the whole edit collapses into one undo/redo entry. An earlier design considered delegating editing to the user's external editor of choice; it was dropped because there is no single correct default editor to launch for every user, and the in-app editor avoids that choice entirely while still providing highlighting and validation.

Before application, the review UI should show:

- Plugin, provider and implementation identity
- Every state, parameter and port binding
- Outputs and the model entities they may affect
- State, timing and determinism declarations
- Requested permissions and resource limits
- Artifact hashes, source availability and validation results
- Portability and continuation limitations

Results mode should show the effective provider versions and any nondeterministic inputs. Editing a provider or its binding after a run must not mutate the completed result. Starting a new run uses the edited model and clears or separates the previous session according to the existing results workflow.

## Deliberate non-goals for an initial implementation

- Running arbitrary native code embedded in a project without a trust decision
- Allowing provider code unrestricted access to the engine state vector
- Hiding meaningful state from checkpoints and results
- Integrating FMUs, Simulink, Modelica, hardware, remote services or arbitrary third-party programs
- Implementing the plugins and protocol adapters those external systems would require
- Supporting stateful provider programs or provider-backed computational nodes
- Producing algebraic values, events or commands from provider code
- Treating remote calls as if they were inexpensive deterministic equations
- Supporting every solver rollback and algebraic-loop scenario immediately
- Defining a stable third-party ABI before at least two substantially different adapters exercise it

## Possible implementation sequence

This sequence is illustrative. The conceptual author-facing class lifecycle is selected above; exact SDK type names and convenience APIs may still be refined during implementation.

1. **Not done.** Define a separate engine-plugin manifest, registry and trust boundary without changing the existing result-visualizer add-on API.
2. **Done**, and extended to node source terms as well as relationships. Define the stateless scalar `relationshipProvider` contract, inline source representation, bindings, output selection and trust prompt. (No trust prompt exists yet — see [Security and trust](#security-and-trust).)
3. **Done.** Define one internal Protobuf worker protocol with persistent process lifetime, strict lifecycle cleanup and batched evaluation.
4. **Done**, macOS-only discovery. Implement compiler discovery, a Konjugate C++ wrapper, native build validation and a C++ relationship editor.
5. **Done**, `python3`-on-`PATH` only, no discovery UI. Implement interpreter discovery, a Konjugate Python wrapper, environment validation and a Python relationship editor over the same protocol.
6. **Partially done.** Source and bindings are recorded in the project; toolchain identity, artifact hash and provider timing are not yet recorded.
7. **Done.** Add native and interaction regressions proving that equation, C++ and Python edges receive identical bindings and contribution semantics. The same regressions were extended to source terms.
8. **Not done.** Package an inline provider as a reusable plugin and verify generated configuration without adding provider-specific host code.
9. **Not done.** Measure process and batching overhead before expanding the output contract or adding another plugin contribution kind.
10. **Not done.** Design stateful computational-node providers, checkpoints and external-software plugins as separate later phases.

## Recommended decisions before implementation

### 1. Use a managed provider-class lifecycle

C++ providers implement the public abstract `RelationshipProvider` class and expose a known factory. Python providers implement the equivalent methods through a base class or validated protocol. Both provide `describe`, `initialize`, `evaluate` and `shutdown`. Konjugate supplies the worker entry point and Protobuf implementation.

Provider-local input identifiers remain stable interface keys and plugin instances map them to numeric model IDs before execution. User code receives only declared read-only inputs and contributes through declared gradient outputs; it never receives mutable engine memory. Exact SDK type names and convenience accessors may evolve without changing this lifecycle.

### 2. Preserve equation evaluation semantics

Programmable relationships should be evaluated at every applicable node substep, exactly like equation relationships. Restricting them to global synchronization boundaries would give two implementations of the same relationship different numerical meaning. Calls that share a plugin, simulation time and execution boundary should be batched where possible. Performance should be measured and optimized without silently changing evaluation cadence.

### 3. Own one worker per plugin artifact

One run should create one worker process for each unique plugin artifact, not one process per edge or one process for an entire programming language. Multiple relationship instances using the same plugin share its worker and can be evaluated in batches. Different plugins remain isolated. Each unique inline source implementation behaves like a private project-owned plugin artifact and may serve several instances of that implementation.

### 4. Retain source for inline implementations

Source is mandatory for inline C++ and Python implementations authored inside Konjugate. A reusable plugin may distribute source, native artifacts or both. A proprietary plugin may remain source-opaque, but every project reference locks its plugin identity, provider identity, version and executable artifact hash.

### 5. Begin with standard-library-only code

The first C++ and Python providers should use only their respective standard libraries. General dependency support introduces package repositories, environment locking, native libraries, licensing and network authority before the provider contract has been proven. Explicit CMake dependencies and isolated Python environments can be added later through a separately designed dependency workflow.

### 6. Begin with scalar floating-point ports

The initial contract supports scalar `float64` inputs, parameters and one scalar derivative contribution. Provider ports declare unit strings. A binding should use the identical unit or require an explicit conversion in the model; Konjugate should not silently infer conversions before it has dimensional analysis. Vectors, matrices and variable-length arrays are deferred.

### 7. Scope reproducibility claims

Determinism is declared within an execution envelope consisting of the plugin artifact hash, compiler or interpreter identity, platform, architecture, engine version and numerical configuration. The same deterministic artifact and engine configuration should reproduce its behavior. Konjugate should not promise bit-identical output across different compilers, Python versions, standard libraries or processor architectures. Numerical regression tolerances remain the cross-toolchain comparison mechanism.

### 8. Keep the first manifest small

The first stateless relationship plugin requires plugin identity, plugin version, manifest version, provider identity, provider API version, runtime, source or artifact entry, declared scalar inputs, declared parameters, one derivative output, determinism, hashes, permissions, copyright and licensing metadata. Checkpoint, rollback, event, algebraic-output and migration declarations should not appear until those behaviors exist.

### 9. Separate project requirements from local trust

The project stores the plugin dependency, version, artifact hash, bindings and requested permissions. Local settings store trust for the exact artifact and permission set, the resolved installation path and selected compiler or interpreter. Opening a project never executes plugin code. Changing inline source changes its hash and invalidates prior approval. CLI execution of project-embedded code requires an explicit trust option rather than silently inheriting Electron preferences.

### 10. Use connector plugins for future external software

A future FMI, Simulink, CAN, device or vendor-solver integration should use an engine-managed connector plugin. The plugin owns product-specific behavior. The engine owns process lifecycle, timing, sequence validation, data bindings, timeouts, checkpoint requests, failures and cleanup. Co-simulation will require a richer lifecycle than the initial stateless relationship contract but should extend the plugin system instead of adding product-specific engine behavior.

### 11. Strengthen the CLI before adding an SDK

The CLI should be the first non-Electron public client because it already exercises the native engine directly. Its initial public surface should cover capabilities, validation, execution, control-stream pause/resume/stop, structured diagnostics and result retrieval. A Python or C++ SDK can follow once the protocol is stable and should wrap the engine rather than reimplement validation or simulation.

### 12. Retain one engine process per client initially

The first public transport remains framed standard input/output with one engine process owned by one controlling client. This gives clear cleanup, job isolation, cross-platform behavior and straightforward automated testing without introducing authentication or multi-client resource ownership. Persistent daemons, sockets and gRPC remain later transport adapters.

### 13. Share installation presentation, not authority

The application may present one Extensions interface with separate Add-ons and Plugins sections. Add-ons and plugins retain separate directories, registries, manifests, permissions, trust records and runtime hosts. Shared presentation can cover identity, versions, updates, licenses and diagnostics without implying equivalent authority.

### 14. Treat empty bindings as a warning, never a hard error

**Implemented.** A programmable relationship or source term with no input bindings is valid: an edge's contribution can depend only on its own parameters, and a source term can depend only on the node's own state, either of which is a legitimate implementation. The validator therefore never rejects a programmable block for having zero bindings, on either edges or source terms.

Instead, the validator emits a non-blocking `warning`-severity diagnostic (`providerImplementationIncomplete` for edges, `sourceTermImplementationIncomplete` for source terms) when bindings are empty **and** the source still looks like the untouched generated template — detected by the literal marker text `TODO: read` that the templates in `src/providerTemplate.mjs` include in their input-reading comments. Writing any real implementation removes that marker and clears the warning, even if the author's logic still uses no bindings. This keeps the common "forgot to implement it" case visible without blocking valid no-input implementations, and applies identically to relationships and source terms.
