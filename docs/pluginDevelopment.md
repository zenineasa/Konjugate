# Plugin development

Konjugate plugins are installable `.kjp` packages that provide numerical
behavior and reusable modeling assets. The first plugin slice supports
versioned Python and C++ relationship-provider artifacts plus declarative
component templates. It reuses the existing
provider protocol and engine runtime; it does not introduce a second provider
ABI.

## Minimal plugin manifest

A plugin package contains `package.json`, `plugin.json` and its provider
artifacts:

```text
helloProvider.kjp
├── package.json
├── plugin.json
├── helloWorld.py
└── helloComponent.json
```

`plugin.json` declares the installed identity and provider contributions:

```json
{
    "pluginId": "example.helloProvider",
    "name": "Hello World Provider",
    "version": "0.1.0",
    "apiVersion": 1,
    "contributes": [{
        "providerId": "example.helloWorld",
        "apiVersion": 1,
        "runtime": "python",
        "entry": "helloWorld.py",
        "determinism": "deterministic"
    }],
    "permissions": []
}
```

The package ID, plugin ID and model reference must agree. A model references a
provider explicitly and pins its installed version:

```json
{
    "kind": "plugin",
    "pluginId": "example.helloProvider",
    "pluginVersion": "0.1.0",
    "providerId": "example.helloWorld",
    "providerApiVersion": 1,
    "bindings": [],
    "output": { "key": "output", "role": "target", "stateId": 4 }
}
```

Before validation or execution, Konjugate resolves this reference to the
existing provider contract with `kind: "python"` or `kind: "cpp"` and an
installed source path. The native validator and engine remain authoritative.

## Installation and trust

Install a `.kjp` through **Install add-on or plugin**. Installation validates
the archive and manifest, writes an immutable versioned directory and does not
execute provider code. A project must explicitly reference the plugin before
its code is launched during validation or simulation.

The current first slice supports local Python and C++ provider artifacts. A
future trust manager should add publisher signatures, artifact hashes,
platform selection, external dependency declarations and stronger review for
native code. A package being installed is not the same as a package being
trusted by every project.

The native engine now launches computational-node providers from a model: a node's `implementation` block (Python only this release) is compiled into the execution plan, evaluated once per substep through `ProviderRuntime`, and checkpointed/restored across pause, resume and restart alongside the ordinary state vector. See [examples/providers/piControllerNode.py](../examples/providers/piControllerNode.py) and [examples/providers/piControlledTankProject.json](../examples/providers/piControlledTankProject.json) for a runnable example, and [examples/providers/accumulatorNode.py](../examples/providers/accumulatorNode.py) for the underlying wire-contract demonstration. C++ computational-node execution, the partitioned execution backend, and plugin-packaged (as opposed to inline) node providers remain future work.

## Example

The source implementation is [examples/providers/helloWorld.py](../examples/providers/helloWorld.py), and its contribution metadata is
[examples/providers/helloWorld.plugin.json](../examples/providers/helloWorld.plugin.json).
The provider follows the author-facing contract documented in
[Interaction providers](interactionProviders.md).

The same plugin can contribute a reusable component template:

```json
{
    "kind": "component",
    "componentId": "helloComponent",
    "apiVersion": 1,
    "entry": "helloComponent.json"
}
```

After installation, the template appears in the existing Component Library.
Placement uses the normal model-creation path, so validation, undo/redo and
simulation semantics are identical to a bundled component. A plugin can now
extend the modeling vocabulary as well as the numerical runtime.

Generate the example package from the repository root with:

```bash
npm run package:examples
```

This writes `out/examples/helloProvider.kjp` alongside the add-on example
package `out/examples/helloWorld.kja`. The output directory is generated and
ignored; the package source and manifest remain the reviewable artifacts.

The current package archive tests and plugin resolver tests cover:

- version-pinned resolution;
- missing installations;
- missing provider entries;
- safe archive paths and manifest identities;
- execution through the existing Python provider worker contract.

Stateful providers, computational-node providers, FMUs, remote services and
hardware connectors remain future plugin kinds.

## Expanded plugin scope

Relationship providers are the first executable slice, not the intended limit
of the plugin system. A useful plugin ecosystem should eventually let a plugin
introduce behavior that cannot be represented as one stateless derivative
function.

The planned capability levels are:

| Capability | What it adds | Execution status |
| --- | --- | --- |
| Relationship provider | Stateless behavior on an edge or source term | Implemented |
| Component provider | A reusable node/edge vocabulary with declared ports and defaults | Planned |
| Computational-node provider | A stateful component with lifecycle and checkpoint support | Implemented (Python, inline source only) |
| Connector | Timestamped data from an approved device or external service | Planned |
| Domain validator | Additional diagnostics that supplement native validation | Planned |
| Visualization contribution | Read-only views synchronized with graph and result identity | Add-on API |

### Computational-node provider

This is the next major runtime capability because it enables controllers,
actuators, battery-management logic, reduced-order models, accumulated damage,
stateful surrogates and other components whose behavior is not naturally an
edge equation.

A computational-node provider should:

- own one declared provider instance per model node -- **done**;
- receive explicitly bound input states and parameters -- **done** (states only; a node has no parameter concept to bind against);
- emit derivatives for one or more engine-owned output states -- **done**;
- declare whether it is substep-aware or synchronization-step-only -- not done, always substep-synchronous today;
- separate speculative evaluation from committed side effects -- not done;
- support initialize, evaluate, commit, checkpoint, restore and shutdown -- **done** except `commit` (no speculative/committed distinction exists yet);
- identify its provider API, package version and artifact hash in results -- not done;
- run deterministically when the model requests a restartable result -- **done**: checkpoint/restore are wired into the engine's own checkpoint and `startCheckpoint` restart mechanism, not just the wire protocol.

The first implementation should keep physical state in Konjugate's ordinary
state vector. Opaque provider-owned state should not be introduced until its
checkpoint payload, versioning, integrity and restore behavior are implemented
at the same time. A provider that cannot restore its internal state cannot
support deterministic continuation, branching or migration between workers.

The proposed node declaration is intentionally distinct from an edge:

```json
{
    "implementation": {
        "kind": "plugin",
        "pluginId": "example.controlModels",
        "pluginVersion": "1.0.0",
        "providerId": "pidController",
        "providerKind": "computationalNode",
        "providerApiVersion": 1,
        "inputs": [
            { "key": "setpoint", "stateId": 12 },
            { "key": "measurement", "stateId": 13 }
        ],
        "outputs": [
            { "key": "command", "stateId": 14 }
        ]
    }
}
```

The provider protocol will need capability negotiation and checkpoint/restore
messages before this declaration can execute. Serial and thread-pool execution
should be supported first; partition migration should follow only after
provider ownership and concurrency guarantees are explicit.

### Connectors

Connectors should bridge timestamped observations from MQTT, WebSocket, CAN,
serial, databases or organization-specific services. They should not be
embedded in the numerical integration loop as arbitrary network calls.

A connector needs explicit policies for:

- timestamps and clock domains;
- buffering and interpolation;
- stale or missing observations;
- units and signal mapping;
- reconnect and timeout behavior;
- read-only versus command authority;
- recording raw observations for reproducibility.

The first connector milestone should be offline CSV import and measured-versus-
simulated comparison. Live acquisition should use the same observation mapping
contract after the offline workflow is reliable.

### Domain validators

Domain validators should supplement, never replace, the native C++ validator.
They may report findings about conservation, unit conventions, operating ranges,
or organization-specific modeling rules, but they must not silently mutate a
project or override a blocking native error.

Validator output should identify the stable entity ID, severity, explanation,
source plugin and optional corrective action. A validator should be executable
in a restricted, deterministic mode during CI without requiring the desktop UI.

### Capability and trust boundaries

Every future contribution must declare its capability rather than receiving a
general-purpose plugin API. In particular:

- relationship providers receive bound values and return declared derivatives;
- computational nodes receive bound values and own declared lifecycle state;
- connectors receive explicitly approved data endpoints;
- validators receive a read-only model and return findings;
- visualization add-ons receive read-only result context through the add-on bridge.

Installing one capability must not grant the authority of another. Native code,
network access, device access and project mutation require separate trust and
permission decisions.
