---
type: Proposal
title: Package compatibility
description: RFC for declaring the minimum Konjugate version a package needs, and for installing and updating the newest release of a package that the running app can actually use.
tags: [proposals, packages, registry, updates]
status: draft
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Package compatibility

**Status: built (October 2026), with the differences listed under Implementation notes.** It changed `src/packageArchive.mjs`, `src/registryClient.mjs`, `src/versionCompare.mjs`, `src/pluginResolver.mjs`, `packageCheckUpdates` and the package install and discovery paths in `src/main.mjs`, and the Extensions explorer's Installed view. User-facing behavior is described in [Packages](../packageDevelopment.md), [Registry](../registry.md) and [Extensions explorer](../extensionsExplorer.md).

## Problem

A package (`.kja` add-on or `.kjp` plugin) can depend on things the running Konjugate may not have: a project-document feature such as `setsValue` source terms or subsystems, an engine capability, or a field added to the add-on bridge within an existing `apiVersion`. Today a package can only declare `apiVersion`, an integer in its `addon.json` or `plugin.json` that the host either supports or rejects. That covers the interface contract and nothing else, because additive changes land inside an existing `apiVersion`. A package that uses one works on the app that introduced it and fails, often with an unhelpful error, on an older app that still reports the same `apiVersion`.

The registry and update check make this worse. A registry entry deliberately carries no version of its own (see [Registry](../registry.md)), and its `downloadUrl` is of the form `releases/latest/download/<file>`. Update checking asks GitHub for the single latest release (`fetchLatestReleaseVersion`). So there is exactly one candidate: if the newest release needs a newer Konjugate than the user has, Konjugate will either install something that cannot work or offer nothing, even when the previous release would have worked. The reverse direction matters just as much: an older release of a package may support the app that is running, and the app should find it.

## Decisions this proposal assumes

1. **Releases happen only in each package's own repository.** A package's version history is its GitHub Releases. The registry stays versionless, and packages are not published through any other channel (a package with a command-line or library part, for example, ships it as a release asset and does not publish it to npm or PyPI).
2. **The change is for packages, not for Konjugate itself.** Konjugate's own release process is unchanged.
3. **No maximum version.** A hard upper bound locks users out of packages that still work. Breaking changes are what `apiVersion` is for, and Konjugate owes old `apiVersion` values continued support, or has to say it is dropping one.

Items 1 and 2 are the author's reading of the instruction "from now on, we will only have releases being made in the repo" and should be confirmed.

## Design

### The field

The shared `package.json` envelope inside every `.kja` and `.kjp` (see [Packages](../packageDevelopment.md)) gains one optional field:

```json
{
    "format": "konjugate-package",
    "formatVersion": 1,
    "packageType": "addon",
    "packageId": "konjugate.exampleToolbox",
    "name": "Example Toolbox",
    "version": "0.3.0",
    "minimumKonjugateVersion": "1.1.15",
    "contents": { "manifest": "addon.json" }
}
```

`minimumKonjugateVersion` is a three-part version string (`major.minor.patch`). It is validated in `validatePackageManifest`: present but malformed rejects the package with `INVALID_MANIFEST`; absent means no requirement, so every existing package keeps working unchanged. It deliberately lives in the envelope and not in a new file, because the envelope is already the package's identity and is verified with the rest of the archive. `apiVersion` stays in the contribution manifest.

It is an author's claim, not a guarantee: the lowest Konjugate the author tested the package against. Tooling cannot infer it.

### Compatibility check

One function decides, given an inspected archive and the running app:

```text
checkPackageCompatibility(inspected, { appVersion }) -> { compatible: true }
                                                      | { compatible: false, reason: 'app-version', required: '1.2.0', running: '1.1.15' }
                                                      | { compatible: false, reason: 'api-version', required: 2 }
```

The `api-version` branch reuses the checks `inspectPackageArchive` already makes (the plugin's `apiVersion !== 1`, the add-on validator), reported as incompatibility instead of invalidity. Versions are compared with `src/versionCompare.mjs`. The comparison that used to be in `registryClient.mjs` (`isNewerVersion`) turned a pre-release segment such as `3-beta` into `NaN`, so the two became one shared module.

The check runs in three places: when installing from a registry entry or a local file (refuse, with both versions in the message), when discovering installed packages at startup (an installed package that needs a newer app than the one now running is left unloaded and shown as incompatible, which happens after an app downgrade), and when selecting a release (below).

### Selecting a release

For a registry entry whose `downloadUrl` points at GitHub Releases, the client picks the newest release the running app can use:

1. List the repository's releases with one call to `GET /repos/{owner}/{repo}/releases`, the same cost as today's `/releases/latest`. Ignore drafts and pre-releases unless the user opted in to pre-releases.
2. Take the release tags, sort by version descending, and for each candidate in turn find the asset with the same file name as the entry's `downloadUrl` (the registry already uses a stable, versionless file name, such as `konjugate.helloWorld.kja`), download it and run `checkPackageCompatibility`. Stop at the first compatible one.
3. Give up after a small number of candidates (five) and report that no recent release is compatible, naming the newest one's requirement.

Downloading the archive, and not a copy of its metadata, is deliberate: archives are small, the install path needs the bytes anyway, the check then covers both `minimumKonjugateVersion` and `apiVersion`, and there is no second file to forget or to drift. If archives grow large, packaging could also attach a copy of the envelope as a release asset to be used as a hint only, with the archive remaining authoritative. This is a possible optimization, not part of the first version.

For a multi-package download (a zip container holding several archives, installed as one unit), the entry's requirement is the strictest of its packages.

**Cached facts, not verdicts.** A release's `minimumKonjugateVersion` and `apiVersion` do not change, so they are cached per repository and tag (in memory, and optionally on disk next to the registry cache). Whether they suit the running app is recomputed each time. The existing in-memory one-hour update cache needs no new key: it dies with the process, and the app version only changes across a restart.

### Behavior in the Extensions explorer

- **Discover and Install** install the newest compatible release. If the newest release overall is newer, the detail pane says so ("Installing 1.4.2. The latest, 1.5.0, needs Konjugate 1.2.0.").
- **Updates.** An update counts, and appears in the badge and in Update all, only if a newer compatible release exists. If the newest release needs a newer app, the item shows a quiet note ("1.5.0 needs Konjugate 1.2.0") and no badge, since the user cannot act on it. When Konjugate updates, the held-back updates appear on the next check.
- **Rollback.** For an installed package that is incompatible with the running app, offer "Install compatible version", which installs the newest compatible release over it (`installFromRegistryEntry` already replaces other installed versions). It is also available for choosing a specific older release.
- **Local file install** refuses an incompatible package with the same message and no override.

### Obligations on Konjugate

Older packages must keep running on newer apps, which means keeping support for old `apiVersion` values or announcing their removal in advance with a deprecation period. Because there is no maximum version, an older package with a still-supported `apiVersion` is assumed to work. Konjugate's own first-party packages (`scripts/packageExamples.mjs` and the registry's first-party entries) should set `minimumKonjugateVersion`, to the app version they were built and tested with.

## Alternatives considered

- **A sidecar `compatibility.json` release asset.** Lets the client read compatibility without downloading the archive, but duplicates the envelope, cannot carry `apiVersion` unless it copies the contribution manifest too, and can be forgotten at release time. Kept only as a possible optimization (above).
- **Version lists in the registry.** Gives the explorer everything without touching GitHub, but turns every package release into a registry pull request. The registry deliberately carries no version.
- **Feature flags (required capabilities, using the engine's `capabilities` command).** More precise than version numbers, and the better answer if forks or release channels ever make a version number ambiguous, but more to specify and to keep honest. Versions first.
- **A maximum version.** Rejected above.

## Implementation outline

1. `packageArchive.mjs`: validate `minimumKonjugateVersion`; add `checkPackageCompatibility`; classify `apiVersion` failures as incompatibility.
2. `versionCompare.mjs`: become the single comparison, including a defined order for pre-release suffixes; `registryClient.mjs` uses it.
3. `registryClient.mjs`: `listReleases`, `selectCompatibleRelease`, a `release` option on `installFromRegistryEntry`, and a per-tag facts cache.
4. `main.mjs`: `checkPackageUpdates` uses the selection and reports `{ latestCompatible, newerButIncompatible }`; startup discovery marks incompatible packages.
5. `renderer.mjs` and the explorer: the notes, the badge rule, and the rollback action.
6. Docs: `packageDevelopment.md` (the field), `registry.md` (selection rule), `extensionsExplorer.md` (behavior).

## Test plan

Hand-built archives and a fake `fetch` are enough, with no network: a malformed field is rejected; an absent field installs; `minimumKonjugateVersion` above the running version refuses install and load; `apiVersion` 2 reports `api-version`; selection skips an incompatible newest release and installs the previous one; it ignores drafts and pre-releases; it gives up after five candidates; an update counts only when a compatible newer release exists; a pre-release version compares correctly; a bundle takes the strictest requirement; a release with no field is treated as compatible.

## Open questions

- Whether pre-releases should be offered at all, and if so behind which setting.
- How a maintainer withdraws a bad release: deleting it, or marking it a draft, are the two options GitHub gives, and the client skips both.
- Whether to show "tested up to" information anywhere. Without a maximum it would only be informational, and the proposal leaves it out.
- Whether the web edition installs packages at all, and so needs any of this.

## Implementation notes

What was built follows the design above, with these differences and additions.

- **A held-back release is reported after an install, not before.** Discover's detail pane does not preview which release will be installed, because that needs the candidates downloaded. The install notice says "The newest release, 1.5.0 needs Konjugate 1.2.0, so an earlier release was installed." The Installed view does show held-back notes, from the update check.
- **Pre-releases are never offered.** The release selection supports opting in (`includePrereleases`), but there is no setting for it yet.
- **One comparison, two strictnesses.** `src/versionCompare.mjs` now orders versions by semantic-versioning precedence, including pre-releases. The application's own comparison (`isNewerVersion`, used by the app update check, the Welcome window and compatibility) still requires exactly three numbers, as before, and packages use the tolerant `isNewerPackageVersion`, which accepts `0.1` as equal to `0.1.0`. The old comparison in `registryClient.mjs` is gone.
- **UNSUPPORTED_API_VERSION is always checked.** A package whose manifest or contribution declares an `apiVersion` above the one supported is reported as incompatible, with or without the app version. The app-version check needs the app version, which tests and bundled packages leave out.
- **Incompatible installed packages** are excluded where disabled ones are (add-on discovery, the component library, plugin examples and plugin provider resolution), and appear in the package list with an `incompatible` field. Plugin resolution reports `PLUGIN_INCOMPATIBLE` with the reason. They are never enabled, whatever their toggle says.
- **Facts are cached on disk** in `releaseFacts.json` next to the installed packages, and in memory per process.
- **Rolling back to a specific release** is supported by `installFromRegistryEntry` (a `release` option) and the `packageInstallFromRegistry` message, but the interface offers only "Install compatible version", which takes the newest compatible release. Choosing a particular release has no control yet.
- **First-party packages** live in their own repositories (Hello World, Pose Visualizer, Results Analysis, Fintech, Logistics). Each declares `minimumKonjugateVersion` (1.1.15) in its repository's `package.json`, next to the `version` that is already the single source for release tags, and its `scripts/build.mjs` copies it into the package envelope and fails the build if it is missing, since a forgotten field would silently claim to run on any Konjugate. It reaches users with each repository's next release. The only package built in this repository is the example plugin (`scripts/packageExamples.mjs`), which declares the Konjugate version it is built with. That script had stopped working when the Hello World add-on moved out; it now builds only the plugin.
