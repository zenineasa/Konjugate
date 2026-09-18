<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Launcher add-ons and plugin-contributed examples

**Status: proposal, not built.** Nothing here exists yet. It has been revised once after thinking through how an institutional user (an analyst, a model validator, the IT and security team that must approve the software) would meet a domain package, and the revision changed its priorities. It marks where it is still unsure.

## Problem

Konjugate is powerful and, for a first-time user of a domain package, blank. A user who installs a domain package gets new components in the Library sidebar, but nothing that says what to build, what to try, or how to bring their own data. Today the only guided entry points are the bundled Examples dialog, which knows only about examples shipped inside Konjugate itself, and the welcome window. A package that extends Konjugate cannot offer its own starting points, and an add-on cannot help at all, because the add-on API is read-only and available only while results are showing.

The audience that matters most is not a hobbyist exploring a demo. It is someone at an institution with their own data and their own obligations: they need to start from that data, reproduce a result exactly, explain every number to a validator, and get the software past a security review that will approve one named product at one version. That shapes what a starting point has to be. The goal is for an installed package to be able to ship a simple, focused starting point: a small window that lists ready-made models, suggests what to try with each, links to documentation, and accepts a CSV to start something useful, without asking the user to learn the whole application first.

## What exists today, and what it cannot do

- **Add-ons** (`docs/addonDevelopment.md`, `src/addonHost.mjs`) support exactly one kind, `resultVisualizer`. The manifest validator rejects any other `kind`, requires exactly one toolstrip contribution, and requires that contribution to appear only while results are active (`when: "resultsActive"`, context `resultSession`). The add-on runs in a sandboxed window with a permission-gated bridge (`window.konjugateVisualizer`) that can read results and the timeline and export a CSV. The documentation states the design principle plainly: no ability to edit the active model.
- **Examples** are enumerated from Konjugate's own `examples/` directory (`projectListExamples`, `projectLoadExample` in `src/main.mjs`), each a `.kjt` with an optional `.md` guide, a `.png` thumbnail and a domain list from `examples/manifest.json`. A plugin or add-on cannot add to them.
- **Plugins** can already contribute component templates through `contributes` entries of `kind: "component"`, discovered at each Library open (`discoverComponentLibrary`). That is the pattern this proposal extends.
- **Loading a model** in the renderer goes through `loadExample`, which confirms discarding unsaved work (`confirmDiscard`), decodes the project, loads it, and opens the example's guide.
- **Tuning** already accepts a CSV (`loadParameterTuningCsv`) and matches columns to states, including, since shared parameters became tunable, the `Node — State (unit)` headings that Konjugate's own CSV export writes.
- **The web edition** has no add-on support (`window.addons.listToolstripContributions()` returns an empty list there), so everything below is desktop-only, as add-ons already are.

## Proposal in five parts

**Part 1: plugins contribute examples.** A plugin declares example models in its `contributes` list, and they appear in Konjugate's existing Examples dialog alongside the bundled ones. This needs no new add-on capability, stands on its own, and lets a package ship ready-made models without any separate distribution step.

**Part 2: a new add-on kind, `launcher`.** A launcher add-on opens a small window from an always-visible toolstrip button. It renders its own guided interface, and it can ask the host to perform a short list of named actions. It never edits the model itself: it requests, and the host acts, on a user click, through the same code paths and confirmations the rest of the application already uses.

The two parts share one descriptor, so a model is described once and can be both listed in the Examples dialog and offered by the launcher.

**Part 3: package suites.** A package may contain both a plugin half and an add-on half, installed, versioned, enabled and approved as one.

**Part 4: importers.** A package can ship a deterministic importer that turns a documented data file into a model, so a user starts from their own data instead of from a demo.

**Part 5: scenarios and provenance.** A package can declare named scenarios as data, and every run can record exactly which package versions, model and inputs produced it.

## Part 1: plugin-contributed examples

A plugin's `plugin.json` gains a contribution:

```json
{
    "kind": "example",
    "exampleId": "buildingHeatLoss",
    "apiVersion": 1,
    "entry": "examples/buildingHeatLoss.kjt",
    "guide": "examples/buildingHeatLoss.md",
    "thumbnail": "examples/buildingHeatLoss.png",
    "name": "Building heat loss",
    "domains": ["thermal"],
    "description": "A heated room losing heat through its walls; fork it to compare a thicker wall with a colder day."
}
```

- `entry` is required and must be a `.kjt` inside the plugin's own directory; `guide` and `thumbnail` are optional. Absolute paths and `..` are rejected, as for a component template's entry.
- `exampleId` must be unique across bundled and plugin examples, and the package's own `pluginId` is recorded as the source so the Examples dialog can show where an example came from.
- Discovery runs where component discovery already runs (each list request), merging plugin examples after the bundled ones, skipping a disabled plugin's, and skipping (with a console warning, not a failure) any that fail validation.
- `projectLoadExample` and `projectOpenExampleGuide` resolve an id against the merged set. Loading is unchanged: it stays a copy opened unsaved, behind the same `confirmDiscard`.
- Domains reuse the Examples dialog's existing domain chips, so a plugin adding a new domain adds a chip.

The web edition bakes bundled examples at build time and has no installed plugins, so it is unaffected.

## Part 2: the launcher add-on kind

### Manifest

```json
{
    "addonId": "example.thermal.start",
    "name": "Thermal Start",
    "version": "0.1.0",
    "apiVersion": 1,
    "kind": "launcher",
    "entry": "index.html",
    "permissions": ["model.open", "run.prepare", "csv.import", "links.open"],
    "contributes": {
        "toolstrip": [{ "commandId": "openStart", "label": "Thermal", "tooltip": "Open the Thermal start window", "symbol": "◆", "when": "always", "contexts": [] }],
        "models": [{
            "modelId": "buildingHeatLoss", "name": "Building heat loss", "file": "models/buildingHeatLoss.kjt",
            "description": "…", "suggestedTargetTime": 3600,
            "tryThis": ["Run it and open the Parameters table.", "Fork at the one-hour mark and raise the wall conductance.", "Fork again and lower the outside temperature."]
        }],
        "links": [{ "linkId": "concepts", "label": "Modelling thermal networks", "url": "https://…" }],
        "pages": [{ "pageId": "gettingStarted", "label": "Getting started", "entry": "help/gettingStarted.html" }]
    }
}
```

- `kind` becomes an accepted value beside `resultVisualizer`, and the validator dispatches on it. A `launcher` may contribute one toolstrip command with `when: "always"` (already an allowed condition) and no result context, so its button is present without results.
- `models`, `links` and `pages` are static declarations. **The add-on's code cannot name an arbitrary path or URL; it can only refer to an id the manifest declared.** That is what keeps the action list below safe.
- The window is created the way `openResultsVisualizer` creates its own: a modeless, sandboxed window with a host-supplied titlebar and its own preload, exposing `window.konjugateLauncher`. One launcher window is open at a time.

### Host actions

Each action needs its permission in the manifest, is validated in the main process, and can only reference declared ids. None of them gives the add-on model data.

| Action | Permission | What the host does | Guardrails |
| --- | --- | --- | --- |
| `listModels()` / `listLinks()` / `listPages()` | none (own manifest) | Returns the declared descriptors | Read-only view of the add-on's own manifest |
| `openModel(modelId)` | `model.open` | Reads the declared `.kjt` from the add-on's own directory and loads it into the project window that opened the launcher, through the same path as `loadExample`: unsaved-work confirmation, opened as an unsaved copy | Only a declared `modelId`; the file must resolve inside the add-on directory; no-op while a run is in progress |
| `prepareRun(modelId?)` | `run.prepare` | Opens the ordinary run-launch dialog in the project window, pre-filled with the model's `suggestedTargetTime`, and stops there | The user still presses Start; the add-on cannot start a run, choose pacing, or run anything unattended |
| `importCsv()` | `csv.import` | Shows the native file picker, reads and parses the file in the host, and returns only `{ fileName, rowCount, columns, matched }`: the column headings and which of them match states of the current model. On the user's confirmation, hands the file to the Tuning panel (`loadParameterTuningCsv`) | The add-on never receives the path or the contents; the host describes the match, and the user confirms before anything opens |
| `importData(importerId)` | `data.import` | Shows the native file picker, runs the declared importer on the file in the host (Part 4), validates the resulting model with the engine's validator, reports what was read and any problems, and on confirmation opens the model as a new unsaved model | Only a declared importer; the add-on never receives the path or the contents, only the host's report; a model that fails validation is not opened |
| `runScenario(scenarioId)` | `scenario.run` | Applies a declared scenario (Part 5) in the project window: opens the run dialog pre-filled, and after the baseline completes, opens the fork panel pre-filled with the scenario's interventions | Only a declared scenario, which is data and not code; the user confirms each dialog by default |
| `openLink(linkId)` | `links.open` | Opens a declared `https` link in the default browser | Only declared ids; `https` only |
| `openPage(pageId)` | none | Opens a declared bundled HTML page in a separate sandboxed help window (as example guides open today) | Only a declared page inside the add-on directory |

Two capabilities are deliberately absent. There is no unattended `startRun`: every action that leads to compute stops at a dialog the user confirms, and a scenario is declared data, not code the add-on runs. (A setting to skip those confirmations for a package the user has chosen to trust is a plausible later addition, and is listed as an open question.) There is no model-editing action of any kind: a model changes only when the host opens one the package declared, or one an importer built and the user confirmed.

### An example launcher

A domain package would ship one, `example.thermal.start` here, as an add-on package beside its plugin (the two are separate `.kja` and `.kjp` packages that install independently, as the existing package split already works). Its window would have three sections.

- **Models.** A card for each ready-made model with its description, a button to open it, a button to prepare a run, and the "try this" steps.
- **Bring your data.** A pick control for each importer the package ships. The window explains the file format it expects, shows what the host found and any problems in the data, then opens the resulting model for the user to inspect. A second flow hands a time-series CSV to the Tuning panel for calibration, which already works end to end.
- **Scenarios.** Named scenarios with a one-line description each, a button to apply one, and a note of what it changes, so a comparison is one click and a description and not a manual sequence of parameter edits.
- **Learn.** Short bundled pages (component bundles, shared parameters, forking, calibration), written around the tasks a user has rather than the features the tool has. Everything needed to use the product is bundled, so it works with no network; declared external links are a supplement, never the only path.

## Part 3: package suites

Today a package is exactly one type. The package manifest's `packageType` is `addon` or `plugin`, `contents.manifest` names one file, and each type installs into its own directory with its own registry. A domain package that wants both native components and a guided window therefore ships as two packages.

For an institutional user that is the wrong shape. Two packages are two approval items in a change-control process, two enable switches and two version numbers, and it permits version skew: a window at one version driving a plugin at another. The proposal adds a third package type, `suite`:

```json
{
    "format": "konjugate-package", "formatVersion": 1, "packageType": "suite",
    "packageId": "example.thermal", "name": "Example Thermal", "version": "0.1.0",
    "contents": { "plugin": "plugin.json", "addon": "addon.json" }
}
```

- Installing one archive extracts the plugin half under `packages/plugins/` and the add-on half under `packages/addons/`. The package list shows one entry with one enable toggle and one uninstall, and licensing, when it exists, has one entitlement to check.
- **Lockstep pinning.** The add-on half declares the exact version of the plugin half it was built and validated with, and the host refuses to run a launcher against any other. A suite is released, hashed and approved as a unit.
- **Separate authority is preserved.** A suite unifies distribution only. The two halves keep separate registries, permissions and API versions, and the add-on cannot call into the plugin. The consent screen names both halves ("this package adds native code and a window") so the friendlier add-on does not hide the plugin's authority.
- A plugin or add-on can still be published alone; a suite is an option, not a replacement.

## Part 4: importers

An add-on cannot edit a model, and nobody is going to wire a real institution's network by clicking. A package therefore needs a way to build a model from data, and the least powerful way to do that is a deterministic function.

A plugin (or suite) declares an importer in `contributes`:

```json
{
    "kind": "importer",
    "importerId": "sitePlan",
    "apiVersion": 1,
    "entry": "importers/sitePlan.mjs",
    "name": "Site plan",
    "accepts": [{ "extension": "csv", "description": "One row per building; columns are documented in the guide" }],
    "guide": "importers/sitePlan.md"
}
```

- The entry is a JavaScript module inside the package with one export: a function from the file's text to `{ document, report }`, where `document` is a project document and `report` is what was read (row counts, and warnings and errors keyed to rows). It has no other inputs and no side effects. The host runs it in a worker with no file or network access and a time and memory limit, and the same input must give the same output, which is what makes an import reproducible.
- **The trust honestly stated.** A worker is not a hardening boundary against hostile code; the protection is that packages are installed deliberately, hash-pinned, and part of what the security review approves, the same install-time trust plugins already have. The worker limits accidents, not attackers.
- The host validates `document` with the engine's validator before opening it, opens it as a new unsaved model, and shows the report first so the user sees what was read and what was rejected. Errors block the import and say which row and why; a balance sheet that does not balance is a message, not a silent fix.
- The file format is documented and versioned by the package. This is deliberately not a generic "CSV to model" feature: an importer targets a defined format that its authors have specified and tested.

## Part 5: scenarios and provenance

**Scenarios.** A package declares a scenario as data: a name, a description, and a list of interventions (a parameter identified by its symbol, a value or a step, ramp or pulse, and a time), which is exactly what the fork panel already accepts. Applying one opens the run dialog and, once the baseline exists, the fork panel pre-filled with those interventions, and the user confirms each. A comparison the user would otherwise assemble by hand from a description becomes a repeatable, named thing, and a scenario library is reviewable data rather than code.

**Provenance.** A model risk process is mostly about being able to reproduce and explain a result. Every run records, and every result export carries as a sidecar, a run manifest: the Konjugate version, each package and version that contributed (plugins, and the importer if one built the model), the model's content hash, the hash of any input file an importer read, the run configuration, and the interventions applied to each branch. The manifest is plain JSON, so it can be attached to a committee pack and diffed between quarters. Every guided result also has an open-in-canvas path, because a validator must be able to inspect the equations behind a number the window showed them.

## Why the host performs the actions

The existing add-on model is "no ambient authority" and the plugin model is "declared inputs and outputs only", and the proposal keeps both. The alternative, giving a launcher add-on a model-editing API, would be a much larger commitment: it would need a versioned schema for edits, undo integration, conflict handling with the user's own edits, and a trust story for arbitrary packaged code changing a user's model. Requesting named, low-blast-radius actions gets nearly the same user experience for a small fraction of that surface.

## Security and trust

- **What a launcher can reach:** its own manifest, its own package files (models and pages), and the actions above, each gated by a declared permission. No file paths, no CSV contents, no model data, no arbitrary URLs.
- **What a launcher can do to a user:** replace the open model (after the normal unsaved-work prompt), open a pre-filled run or fork dialog, open a file picker, open a declared link. The worst case is an unwanted model replacing an empty or saved canvas after a confirmation; it cannot destroy unsaved work without the prompt, and it cannot run or edit anything unattended.
- **What leaves the machine:** nothing. Import, scenarios and provenance are local; there is no telemetry and no remote fetch, so the product can run air-gapped. Declared external links open in the user's own browser only when clicked.
- **A limit worth stating:** the main process cannot cryptographically prove that a click in the launcher window was a real user gesture. The mitigation is not gesture checking but the small blast radius of every action and the confirmation prompts that already exist. If this turns out to be too weak for institutional users, a per-action host confirmation can be added without changing the API.
- **Provenance:** a launcher that opens files from its own package is exactly what a security-conscious buyer will want to review. It reinforces the case for the package licensing and entitlement work that is separately tracked and not built.

## Testing

- Unit tests for the manifest validator: an accepted launcher, and rejection of an undeclared permission, a `models` entry whose `file` escapes the add-on directory, a link that is not `https`, and a launcher with a result-only toolstrip condition.
- A plugin-contributed example appears in the Examples dialog, loads as an unsaved copy behind the unsaved-work prompt, and is skipped when its plugin is disabled.
- Interaction tests in Konjugate against a small fixture launcher add-on: the toolstrip button is present without results, `openModel` loads the declared model, `prepareRun` opens the run dialog pre-filled and does not start a run, `importCsv` reports matches without exposing contents, and an undeclared id is rejected.
- Suites: a suite installs both halves from one archive, appears once in the package list, toggles and uninstalls as one, and a launcher refuses to run against a plugin half of a different version.
- Importers: a fixture importer runs in the worker, is deterministic, is cut off at its time limit, and cannot read files or reach the network; an invalid document or a report with errors blocks the import.
- Provenance: a run manifest lists the expected packages and hashes, and changes when any input changes.
- For a real package, an external Playwright harness can install the built packages, open the launcher, open a model from it and confirm it is the model the package shipped.

## Phasing

1. **Plugin-contributed examples.** Small, useful alone, and the descriptor shape it fixes is reused below.
2. **Suite packages with lockstep pinning and one consent screen.**
3. **The `launcher` kind** with `openModel`, `prepareRun`, `openPage` and `openLink`, and the Models and Learn sections of the example launcher.
4. **Importers** (`importData`) and one or two documented formats in a real package, since the value of this whole direction rests on starting from a user's own data.
5. **Scenarios** (`runScenario`) and **provenance** (the run manifest and its export).
6. **Calibration hand-off** (`importCsv` to the Tuning panel), and richer inputs only when there is something to do with them.

## Open questions

- **One launcher or several?** The proposal allows one window at a time. Whether two installed launchers (say, thermal and robotics) each get a toolstrip button, or share one menu, is a UI decision to make once there are two.
- **How many confirmations are right?** Every compute action stops at a dialog by default. A per-package "trust this package to skip the confirmations" setting would make repeated analysis smoother, at some cost in caution. Worth deciding with real users.
- **How is a suite signed and approved?** The proposal assumes one hash and one version per suite. How that interacts with the licensing and entitlement work, which is separately tracked and not built, is open.
- **Importer language and runtime.** JavaScript in a worker is what the host can run today without new dependencies. Institutions may want importers in Python. That is a larger commitment and is not proposed here.
- **Where do guided steps live for a model opened outside the launcher?** `tryThis` is manifest text today. The Examples dialog could show the same steps in the example guide, so the guidance follows the model rather than the window.
- **Versioning.** The add-on API is explicitly experimental. Adding a second kind under `apiVersion: 1` is consistent with that, but it should be called out in the API documentation as new surface that may still change.
- **Uninstall and update behavior for contributed examples** (an open project loaded from a since-removed plugin) follows what happens today when a plugin used by a model is removed, and should be checked rather than assumed.

## Non-goals

A general add-on API for editing models, adding nodes or edges from add-on code, or starting runs unattended. A generic importer that builds a model from arbitrary data: importers target formats a package defines and documents. A launcher on the web edition. A marketplace or remote package discovery. Formatted reports (spreadsheet, slide or PDF export) are worth doing but are a separate proposal.
