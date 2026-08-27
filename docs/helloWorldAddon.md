# Hello World add-on

This example is the smallest bundled Konjugate add-on. It opens a read-only
result visualizer and reads the active project name, run name and signal count
through the version 1 visualizer bridge.

The source lives in [addons/helloWorld](../addons/helloWorld/).

## What it demonstrates

- a version 1 `resultVisualizer` manifest;
- a manifest-contributed toolstrip command;
- a separate sandboxed Electron window;
- a narrow `results.read` permission;
- reading public result context without accessing private result storage;
- a self-contained HTML, CSS and JavaScript entry point.

It intentionally does not edit the model, access Node.js APIs, import host
renderer modules or depend on private Konjugate implementation details.

## Run it from source

From the repository root:

```bash
npm ci
npm run setup
npm run dev
```

Open any bundled example and run it. While the result session is active, the
main window shows the `Hello` add-on command. Activate it to open the example
window.

The add-on is discovered because it is under the repository's bundled
`addons/` directory. Restart the application after changing its manifest;
version 1 does not hot-reload add-ons.

## Change the example

1. Copy `addons/helloWorld` to a new directory.
2. Change `addonId`, `name`, `commandId` and the visible behavior.
3. Keep the new ID globally unique.
4. Declare only the permissions the add-on needs.
5. Run the manifest validator and unit tests.

A copied add-on should use a new identifier, for example
`example.resultSummary`, rather than reusing `example.helloWorld`.

## Validate the manifest

The following command uses the same validator as the application:

```bash
node --input-type=module -e "import { readFile } from 'node:fs/promises'; import { validateVisualizerManifest } from './src/addonHost.mjs'; const manifest = JSON.parse(await readFile('addons/helloWorld/addon.json', 'utf8')); validateVisualizerManifest(manifest); console.log('Manifest is valid');"
```

Then run the JavaScript test suite:

```bash
npm test
```

## Permission boundary

The example requests only `results.read`. This permits it to call
`getContext()` and `listSignals()`, but does not allow it to seek the timeline,
control simulation pacing, receive live updates or edit the active model.

If the add-on needs another capability, add the corresponding permission to
`addon.json` and use the API documented in [Add-on development](addonDevelopment.md).
Avoid requesting permissions speculatively. A smaller permission set makes the
add-on easier to review and safer to install.

## Next examples

The next ecosystem examples should build on this one without expanding its
authority:

- a visualization add-on that synchronizes a selected signal with a chart — **shipped**: `addons/resultPlotViewer` ("Results Analysis"), Plotly time-series with signal search, legend, and timeline sync;
- a component-library entry that inserts a reusable model template — **shipped**: `examples/providers/helloComponent.json`, documented in [Plugin development](pluginDevelopment.md);
- a numerical provider example using the documented C++ or Python provider SDK — **partially shipped**: `examples/providers/helloWorld.py` exists; no standalone C++ provider example exists yet.
