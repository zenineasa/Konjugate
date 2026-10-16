---
type: Guide
title: Konjugate packages
description: Package format, directory layouts, and installation mechanisms for .kja add-ons and .kjp plugins.
tags: [packages, kja, kjp, distribution]
status: stable
---

# Konjugate packages

Konjugate packages are portable files that users can install without finding an application-specific directory:

- `.kja` installs an application add-on.
- `.kjp` installs a numerical or integration plugin.

The files are standard ZIP archives internally, with a Konjugate package manifest and a type-specific contribution manifest. The custom extension makes the package type clear to the operating system and to Konjugate.

## User installation

Use **Install add-on or plugin** in the project window, choose a `.kja` or `.kjp` file, review the package identity and permissions, then approve the installation. The application stores installed versions under its platform-appropriate Electron user-data directory:

```text
<userData>/packages/addons/<packageId>/<version>/
<userData>/packages/plugins/<packageId>/<version>/
```

Users should not need to create or browse these directories. The location is owned by Konjugate and is different on macOS, Windows and Linux.

Bundled development add-ons under the repository's `addons/` directory remain supported. They are useful for contributors; they are not the intended end-user installation workflow.

## Package layout

A `.kja` archive contains:

```text
package.json
addon.json
index.html
viewer.mjs
styles.css
assets/
```

A `.kjp` archive contains the same shared package envelope and a `plugin.json` contribution manifest. Native or external-process artifacts should be placed in platform-specific directories and declared by hash in the plugin manifest. Plugin installation registers the package; execution occurs only when a model explicitly references the versioned provider. Trust review remains a separate decision, especially for native artifacts.

The shared `package.json` must contain:

- `format`: `konjugate-package`;
- `formatVersion`: `1`;
- `packageType`: `addon` or `plugin`;
- `packageId`: a stable dotted identifier;
- `name` and semantic-like `version`;
- `contents.manifest`: `addon.json` or `plugin.json`.

It may also contain `minimumKonjugateVersion`: the lowest Konjugate this package has been tested on, as exactly three numbers (`"1.2.0"`). See Compatibility below.

The package ID must match the ID in the contribution manifest. For add-ons, `addon.json` is also checked by the existing version 1 add-on validator before anything is installed.

## Compatibility

A package declares what it needs from Konjugate in two places. The `apiVersion` in `addon.json` or `plugin.json` (and in each plugin contribution) is the add-on or plugin interface the package was written against, and this Konjugate supports version 1. `minimumKonjugateVersion` in `package.json` is the lowest Konjugate release the package has been tested on. Use it whenever the package depends on something added after Konjugate 1.0: a project-document feature (for example `setsValue` source terms or subsystems), an engine capability, or a field added to the add-on bridge within an existing `apiVersion`. Additive changes land inside an existing `apiVersion`, so only the minimum version tells an older Konjugate that it cannot run the package. Set it to the lowest version you actually tested, not the version you happen to build on. The first-party package repositories keep it in their own `package.json`, beside the `version` that is already the single source for release tags, and their build scripts copy it into the package's envelope and refuse to build without it, so it cannot be left out by accident. A package without it states no requirement. There is no maximum version: a package that works on a newer Konjugate should be left to, and a breaking change is signalled by a new `apiVersion`, not by an upper bound.

What Konjugate does with it:

- **Installing** a package that needs a newer Konjugate, or a newer `apiVersion`, is refused before anything is written, with a message naming both versions: "Example 1.5.0 needs Konjugate 1.2.0 or later; this is Konjugate 1.1.9." This applies to installing from a file and from the registry.
- **Installing from the registry** picks the newest release of the package that the running Konjugate can use, not simply the latest. See [Registry](registry.md).
- **An installed package that needs a newer Konjugate than the one running**, for example after Konjugate was downgraded, is not loaded. Its add-on does not appear, its plugin's components, examples and providers are unavailable (a model that references its provider is told why), and Extensions lists it as incompatible with an "Install compatible version" action.

A malformed `minimumKonjugateVersion` (anything but three numbers, such as `"1.2"` or `"latest"`) makes the package invalid.

## Safety checks

Before extraction, Konjugate checks:

- file extension and declared package type;
- archive size, expanded size, file count and per-file size;
- malformed ZIP data;
- absolute paths, backslash paths and `..` traversal;
- required and valid JSON manifests;
- package/contribution identity consistency;
- add-on permissions and API compatibility.

Extraction occurs in a temporary directory and is moved into the versioned installation path only after every file has been written. A failed installation removes the temporary directory and does not leave a partially installed version. Existing versions are not replaced unless an explicit update path requests overwrite behavior.

Package installation itself does not execute package code — that stays true. Add-ons run later in their existing sandboxed visualizer window. Plugins are not executed by the installer either, but a plugin runtime now exists and does execute plugin code afterward, when a project actually references an installed plugin (`src/pluginResolver.mjs`, wired into `resolveInstalledPlugins` in `src/engineAdapter.mjs`) — it already checks project-reference pinning (`pluginId`/`pluginVersion`) and manifest-identity/API-version compatibility, and rejects a disabled plugin. What it does not yet add is artifact-hash verification or platform-specific package selection.

## Signing

Unsigned packages install and run exactly as signed ones do — publisher signing (see [docs/registry.md](registry.md)) is a trust signal, never an install-time gate, so nothing here shows an unsigned package differently by default. `signPackageArchive`/`verifyPackageArchive` in [src/packageArchive.mjs](../src/packageArchive.mjs) cover the canonical manifest, every normalized file path and every file hash, per a namespace prefix reserved in [`registry/`](../registry/) — matching what this section used to describe as a future direction. Platform application signing (notarization, code-signing certificates — see [docs/packageManagerDistribution.md](packageManagerDistribution.md)) and this package-content publisher signing are still separate trust layers: Konjugate itself ships unsigned at the OS level today, independent of whether an individual `.kja`/`.kjp` a user installs is publisher-signed.

## Build a package

The package archive core is implemented in [src/packageArchive.mjs](../src/packageArchive.mjs). [Konjugate-HelloWorld](https://github.com/zenineasa/Konjugate-HelloWorld) is the smallest real example of a packaged add-on to start from -- its own `scripts/build.mjs` already does steps 3-4 below:

1. Clone [Konjugate-HelloWorld](https://github.com/zenineasa/Konjugate-HelloWorld).
2. Give it a new globally unique add-on ID.
3. Add a shared `package.json` with `packageType: "addon"`.
4. Include the contribution files in the archive.
5. Validate the archive with the package archive tests before distribution.

The package format is intentionally independent of the `.kjt` project format. `.kjt` remains a compressed project container; `.kja` and `.kjp` are installable multi-file contribution archives.
