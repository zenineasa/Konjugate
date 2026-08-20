# Plugin development

Konjugate plugins are installable `.kjp` packages that provide numerical
behavior to a model. The first executable plugin slice supports versioned
Python and C++ relationship-provider artifacts. It reuses the existing
provider protocol and engine runtime; it does not introduce a second provider
ABI.

## Minimal plugin manifest

A plugin package contains `package.json`, `plugin.json` and its provider
artifacts:

```text
helloProvider.kjp
├── package.json
├── plugin.json
└── helloWorld.py
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

## Example

The source implementation is [examples/providers/helloWorld.py](../examples/providers/helloWorld.py), and its contribution metadata is
[examples/providers/helloWorld.plugin.json](../examples/providers/helloWorld.plugin.json).
The provider follows the author-facing contract documented in
[Interaction providers](interactionProviders.md).

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
