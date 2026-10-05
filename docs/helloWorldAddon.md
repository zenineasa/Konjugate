---
type: Guide
title: Hello World add-on
description: Minimal add-on example demonstrating the version 1 visualizer bridge and metadata reading.
tags: [addons, examples, tutorial]
status: stable
---

# Hello World add-on

This example is the smallest Konjugate add-on. It opens a read-only result visualizer and reads the active project name, run name and signal count through the version 1 visualizer bridge.

It no longer ships bundled with Konjugate core -- its source lives in its own repository, [Konjugate-HelloWorld](https://github.com/zenineasa/Konjugate-HelloWorld), and installs like any other add-on through the Extensions dialog's Discover tab (see [docs/extensionsExplorer.md](extensionsExplorer.md)).

## What it demonstrates

- a version 1 `resultVisualizer` manifest;
- a manifest-contributed toolstrip command;
- a separate sandboxed Electron window;
- a narrow `results.read` permission;
- reading public result context without accessing private result storage;
- a self-contained HTML, CSS and JavaScript entry point.

It intentionally does not edit the model, access Node.js APIs, import host renderer modules or depend on private Konjugate implementation details.

## Run it from source

Clone both repositories as siblings, then build and install it into your local Konjugate's userData:

```bash
git clone https://github.com/zenineasa/Konjugate
git clone https://github.com/zenineasa/Konjugate-HelloWorld
cd Konjugate-HelloWorld
npm run install:dev
```

Restart Konjugate, then enable it from the Extensions dialog's Installed tab (it installs disabled by default the same way any freshly installed add-on does). While a result session is active, the main window shows the `Hello` add-on command. Activate it to open the example window. Restart the application after changing its manifest; version 1 does not hot-reload add-ons.

## Change the example

1. Clone [Konjugate-HelloWorld](https://github.com/zenineasa/Konjugate-HelloWorld) as your starting point (or copy its `package/` directory into a new repository of your own).
2. Change `addonId`, `name`, `commandId` and the visible behavior.
3. Keep the new ID globally unique -- see [docs/registry.md](registry.md) if you intend to publish and sign it under your own namespace prefix.
4. Declare only the permissions the add-on needs.
5. Run the manifest validator and unit tests.

A copied add-on should use a new identifier, for example `example.resultSummary`, rather than reusing `konjugate.helloWorld`.

## Validate the manifest

The following command uses the same validator as the application (run from within a Konjugate-HelloWorld checkout, with Konjugate core checked out as a sibling directory):

```bash
node --input-type=module -e "import { readFile } from 'node:fs/promises'; import { validateVisualizerManifest } from '../konjugate/src/addonHost.mjs'; const manifest = JSON.parse(await readFile('package/addon.json', 'utf8')); validateVisualizerManifest(manifest); console.log('Manifest is valid');"
```

## Permission boundary

The example requests only `results.read`. This permits it to call `getContext()` and `listSignals()`, but does not allow it to seek the timeline, control simulation pacing, receive live updates or edit the active model.

If the add-on needs another capability, add the corresponding permission to `addon.json` and use the API documented in [Add-on development](addonDevelopment.md). Avoid requesting permissions speculatively. A smaller permission set makes the add-on easier to review and safer to install.

## Next examples

The next ecosystem examples should build on this one without expanding its authority:

- a visualization add-on that synchronizes a selected signal with a chart — **shipped**: [Konjugate-ResultPlotViewer](https://github.com/zenineasa/Konjugate-ResultPlotViewer) ("Results Analysis"), Plotly time-series with signal search, legend, and timeline sync;
- a component-library entry that inserts a reusable model template — **shipped**: `examples/providers/helloComponent.json`, documented in [Plugin development](pluginDevelopment.md);
- a numerical provider example using the documented C++ or Python provider SDK — **partially shipped**: `examples/providers/helloWorld.py` exists; no standalone C++ provider example exists yet.
