<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Interaction providers

## Status

This document is a pre-implementation architecture proposal. It records a direction for discussion and does not define a stable project schema, plugin ABI or engine protocol. The central proposal is that a relationship, and eventually a computational node, may delegate behavior to an execution provider supplied inline or by an engine plugin. Existing equations remain the simplest built-in provider.

## Initial implementation scope

The first vertical slice is deliberately narrower than the complete architecture. It adds two programmable relationship kinds:

- A relationship implemented by C++ source compiled into a native provider executable
- A relationship implemented by Python source run with a selected interpreter

Both are managed local child processes using the same engine-owned protocol and lifecycle. The user writes the relationship calculation, while a Konjugate-provided language wrapper handles protocol framing, binding tables and process startup. Provider source and binding metadata are stored with the project. The selected compiler or interpreter path remains a machine-local preference.

The initial providers are stateless, accept bound scalar states and parameters, and return one derivative contribution to an explicitly selected endpoint state. They are evaluated with the same simulation-time semantics as an equation. Persistent provider state, computational-node providers, algebraic outputs, events and commands are deferred until checkpoint and solver interactions have been designed.

The initial implementation does not integrate FMUs, Simulink, Modelica, hardware, remote services or arbitrary third-party applications. Those systems will generally require a dedicated plugin and protocol adapter. The generalized manifest, binding and lifecycle design should avoid preventing such plugins later, but no external-software integration is required to validate the first C++ and Python relationship providers.

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

Konjugate should ship a small, versioned C++ SDK header such as `konjugate/relationshipProvider.hpp`. It defines an abstract relationship-provider class and SDK-owned context, description, input-view and output-collector types. A C++ author implements that class rather than writing a `main` function or handling the worker protocol.

The following interface is conceptual; exact type names and convenience functions may change during implementation:

```cpp
namespace konjugate {

class RelationshipProvider
{
public:
    virtual ~RelationshipProvider() = default;

    virtual ProviderDescription describe() const = 0;

    virtual void initialize(
        const InitializationContext& context
    ) = 0;

    virtual void evaluate(
        const EvaluationContext& context,
        const InputValues& inputs,
        GradientContributions& outputs
    ) = 0;

    virtual void shutdown() noexcept = 0;
};

}
```

An implementation could resemble:

```cpp
#include <konjugate/relationshipProvider.hpp>

class ThermalConduction final
    : public konjugate::RelationshipProvider
{
public:
    konjugate::ProviderDescription describe() const override
    {
        return {
            .inputs = {
                konjugate::stateInput("sourceTemperature", "K"),
                konjugate::stateInput("targetTemperature", "K")
            },
            .parameters = {
                konjugate::parameter("conductance", "W/K")
            },
            .outputs = {
                konjugate::gradientOutput("targetTemperature", "K/s")
            }
        };
    }

    void initialize(
        const konjugate::InitializationContext& context
    ) override
    {
        // Validate resolved configuration or prepare non-model caches.
    }

    void evaluate(
        const konjugate::EvaluationContext& context,
        const konjugate::InputValues& inputs,
        konjugate::GradientContributions& outputs
    ) override
    {
        const double difference =
            inputs["sourceTemperature"] -
            inputs["targetTemperature"];

        outputs.add(
            "targetTemperature",
            inputs["conductance"] * difference
        );
    }

    void shutdown() noexcept override
    {
    }
};
```

The provider exposes a known factory that returns the implementation through the SDK interface:

```cpp
std::unique_ptr<konjugate::RelationshipProvider>
createRelationshipProvider()
{
    return std::make_unique<ThermalConduction>();
}
```

Konjugate supplies the worker wrapper containing `main`. The provider build combines the public SDK header, user implementation and version-matched wrapper into one native executable. The wrapper calls the factory, handles Protobuf framing, resolves instance bindings, constructs SDK views, batches evaluation calls, converts exceptions into structured failures and guarantees shutdown.

```text
Public SDK header
+ user implementation
+ Konjugate worker wrapper
            │
            └── native compiler ── provider executable
                                         ↕ Protobuf
                                  Konjugate engine
```

The abstract C++ interface never crosses the process boundary. The user implementation and worker wrapper are compiled together, so the engine does not share C++ object layout, exception ABI or standard-library containers with the provider. Only the versioned Protobuf protocol crosses between processes. A separately compiled shared library would require a different stable ABI and is not part of the initial design.

The public SDK must remain independent of engine implementation types. It should expose small versioned value types, numeric views and metadata rather than Boost property trees, execution-plan objects or mutable engine containers. Exceptions do not cross processes; the wrapper catches them and returns structured provider errors.

### Description and binding

`describe()` declares provider-local input, parameter and output ports. It does not enumerate or acquire access to project states. The relationship editor binds those ports to concrete states and parameters using stable numeric model IDs, and the native validator approves the complete binding before a worker is initialized.

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

The Python SDK should expose the same lifecycle and concepts without requiring artificial C++ syntax. A base class or runtime-checkable protocol can document the contract, while the loader may accept any class that implements the required methods.

```python
from konjugate import (
    RelationshipProvider,
    ProviderDescription,
    state_input,
    parameter,
    gradient_output,
)


class ThermalConduction(RelationshipProvider):
    def describe(self):
        return ProviderDescription(
            inputs=[
                state_input("sourceTemperature", "K"),
                state_input("targetTemperature", "K"),
            ],
            parameters=[
                parameter("conductance", "W/K"),
            ],
            outputs=[
                gradient_output("targetTemperature", "K/s"),
            ],
        )

    def initialize(self, context):
        # Validate resolved configuration or prepare non-model caches.
        pass

    def evaluate(self, context, inputs, outputs):
        difference = (
            inputs["sourceTemperature"] -
            inputs["targetTemperature"]
        )
        outputs.add(
            "targetTemperature",
            inputs["conductance"] * difference,
        )

    def shutdown(self):
        pass
```

Konjugate launches the selected Python interpreter with its supplied worker module. The worker imports the provider, validates its methods, handles the same Protobuf protocol and translates Python exceptions into structured failures. C++ and Python providers therefore share binding, timing and contribution semantics even though their language-level SDKs remain idiomatic.

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

Provider capabilities must participate in execution planning. A provider may declare itself reentrant, one-instance-per-worker, single-threaded or externally serialized. The partitioner should account for provider computation cost and communication cadence. A stateful instance must remain attached to its owning node or partition unless it supports checkpoint-based migration.

An external-process call across every graph cut could dominate numerical work. Execution summaries should therefore report provider invocation counts, evaluation time, serialization volume, wait time, timeouts and fallback decisions. Automatic backend selection must be allowed to avoid partitioning when provider placement or communication makes it counterproductive.

Serial, thread-pool and partitioned paths must apply provider outputs in deterministic graph order when the provider itself is deterministic. Parallel completion order must not become numerical contribution order.

## External-process protocol

The existing engine protocol suggests using versioned Protobuf framing for local process providers. The protocol should exchange numeric arrays and stable binding tables without converting every evaluation through JSON. Large static metadata can be sent during initialization rather than repeated on every call.

The engine should launch a provider process with explicit pipes or a narrowly scoped local transport, complete a capability handshake, validate protocol and provider versions then establish a run-scoped session. Requests require monotonically increasing sequence numbers and simulation timestamps. Shutdown must close streams, reject outstanding callbacks, terminate children within a bounded grace period and report abnormal exits.

Remote providers require a separate transport adapter. A local process protocol should not imply that arbitrary network endpoints are safe or numerically suitable.

## Local toolchains and runtimes

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

The relationship editor should continue to default to Equation. Its initial implementation selector offers Equation, C++ program and Python program. Prebuilt providers, installed extensions, FMUs and live connections appear only if their separately designed adapters become available later.

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

1. Define a separate engine-plugin manifest, registry and trust boundary without changing the existing result-visualizer add-on API.
2. Define the stateless scalar `relationshipProvider` contract, inline source representation, bindings, output selection and trust prompt.
3. Define one internal Protobuf worker protocol with persistent process lifetime, strict lifecycle cleanup and batched evaluation.
4. Implement compiler discovery, a Konjugate C++ wrapper, native build validation and a C++ relationship editor.
5. Implement interpreter discovery, a Konjugate Python wrapper, environment validation and a Python relationship editor over the same protocol.
6. Record source, bindings, toolchain identity, artifact hash and provider timing in projects and results.
7. Add native and interaction regressions proving that equation, C++ and Python edges receive identical bindings and contribution semantics.
8. Package an inline provider as a reusable plugin and verify generated configuration without adding provider-specific host code.
9. Measure process and batching overhead before expanding the output contract or adding another plugin contribution kind.
10. Design stateful computational-node providers, checkpoints and external-software plugins as separate later phases.

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
