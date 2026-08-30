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

The package ID must match the ID in the contribution manifest. For add-ons, `addon.json` is also checked by the existing version 1 add-on validator before anything is installed.

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

## Signing direction

Unsigned packages may be used during alpha development, but the installer must show that they are unsigned. A future package signature should cover the canonical manifest, every normalized file path and every file hash. Platform application signing and Konjugate package publisher signing are separate trust layers.

## Build a package

The package archive core is implemented in [src/packageArchive.mjs](../src/packageArchive.mjs). The repository's Hello World add-on is the smallest source contribution to package next:

1. Copy [addons/helloWorld](../addons/helloWorld/).
2. Give it a new globally unique add-on ID.
3. Add a shared `package.json` with `packageType: "addon"`.
4. Include the contribution files in the archive.
5. Validate the archive with the package archive tests before distribution.

The package format is intentionally independent of the `.kjt` project format. `.kjt` remains a compressed project container; `.kja` and `.kjp` are installable multi-file contribution archives.
