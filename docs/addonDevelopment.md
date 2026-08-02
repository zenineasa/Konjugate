<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Add-on development

## Status

Konjugate add-on API version 1 is experimental. It currently supports one add-on kind: a read-only result visualizer launched from a manifest-contributed toolstrip button. The API will evolve from experience gained with the bundled Results Analysis add-on.

An add-on is self-contained. Konjugate discovers its manifest, creates its toolstrip contribution, opens its entry page in a separate sandboxed window, and supplies a permission-controlled bridge. Adding another compatible visualizer does not require modifying Konjugate's main process, preload, renderer, or HTML files.

## Installation and discovery

An add-on is a directory containing `addon.json` and every file it needs at runtime:

```text
myResultViewer/
├── addon.json
├── index.html
├── viewer.mjs
├── styles.css
└── vendor/
```

Konjugate scans two locations when its main renderer starts:

- the application's bundled `addons` directory;
- `addons` inside Electron's user-data directory for Konjugate.

The user-data location follows the operating system. It is normally beneath `~/Library/Application Support` on macOS, `%APPDATA%` on Windows, and `$XDG_CONFIG_HOME` or `~/.config` on Linux. The final application-directory name is determined by the installed Konjugate build. Restart Konjugate after adding or removing an add-on; version 1 does not hot-reload manifests.

During source development, placing the directory under the repository's `addons/` directory installs it as a bundled add-on.

Invalid manifests are skipped. A diagnostic is written to the main-process console. Add-on IDs must be globally unique across bundled and user-installed add-ons; a duplicate is skipped.

## Manifest

`addon.json` must be valid JSON. Version 1 result visualizers declare exactly one toolstrip command:

```json
{
    "addonId": "example.vehicleTrajectoryViewer",
    "name": "Vehicle Trajectory Viewer",
    "version": "0.1.0",
    "apiVersion": 1,
    "kind": "resultVisualizer",
    "entry": "index.html",
    "copyright": "Copyright © 2026 Example Author",
    "permissions": [
        "results.read",
        "results.live.read",
        "timeline.read",
        "timeline.seek",
        "selection.read",
        "simulation.status.read",
        "simulation.pacing.read",
        "simulation.pacing.control"
    ],
    "contributes": {
        "toolstrip": [{
            "commandId": "openViewer",
            "label": "Trajectory",
            "tooltip": "Open vehicle trajectory viewer",
            "symbol": "◇",
            "when": "resultsActive",
            "contexts": ["resultSession"]
        }]
    }
}
```

### Identity and entry fields

- `addonId` is a dotted, globally unique identifier. Each segment begins with a lower-case letter and continues in lower camel case, for example `example.vehicleTrajectoryViewer`.
- `name` is the user-facing add-on name.
- `version` is the add-on's own version string.
- `apiVersion` must currently be `1`.
- `kind` must currently be `resultVisualizer`.
- `entry` is an HTML file inside the add-on directory. Absolute paths and `..` traversal are rejected.
- `copyright` records attribution. It is recommended for every manifest.

### Toolstrip contribution

The host creates the button; add-on code does not manipulate the main application's DOM.

- `commandId` is a lower-camel-case identifier unique within the add-on.
- `label` appears beside the button symbol.
- `tooltip` becomes both hover text and the accessible label.
- `symbol` is a short textual glyph. Version 1 does not accept executable markup or an external icon path.
- `when` must be `resultsActive`.
- `contexts` must contain `resultSession`.

The button and its add-on separator appear only while results are active. Invoking it opens or focuses the add-on's modeless window. Version 1 supports one active result-visualizer window at a time.

Konjugate supplies the add-on window's titlebar, branding and operating-system-aware minimize, maximize or full-screen and close controls. Add-ons should not create their own window chrome or reserve space for it; the host inserts the titlebar and adjusts the document automatically.

## Permissions

Permissions are declared explicitly. Unknown permissions cause the manifest to be rejected.

| Permission | Capability |
| --- | --- |
| `results.read` | Read run context, discover signals, and request signal samples. |
| `timeline.read` | Receive timeline-position changes from the main result player. |
| `timeline.seek` | Request that the main result player seek to a time. |
| `selection.read` | Receive selected-node changes from the main canvas. |
| `results.live.read` | Receive notifications when additional live samples are available. |
| `simulation.status.read` | Receive live run lifecycle and progress metadata. |
| `simulation.pacing.read` | Receive the active simulation pacing mode and ratio. |
| `simulation.pacing.control` | Request a pacing change for the active engine job. |

Only request capabilities the visualizer uses. The bundled preload may expose a method whose corresponding permission was not granted, but the host will not provide the protected data or event.

## Runtime environment

The entry page runs in a separate Electron renderer with:

- Chromium's renderer sandbox enabled;
- context isolation enabled;
- Node.js integration disabled;
- no direct access to Konjugate's main renderer or model objects;
- no ability to edit the active model through API version 1.

`window.require`, Node.js built-ins, Electron APIs, and the main application's DOM are unavailable. Package browser-ready dependencies inside the add-on. Do not depend on Konjugate's internal `node_modules` layout; the bundled viewer does this only because it ships with the application.

The add-on controls its own Content Security Policy. A conservative starting point is:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:">
```

Konjugate injects one frozen bridge into the isolated page:

```js
window.konjugateVisualizer
```

## Visualizer API version 1

### `getContext()`

Returns a promise for the active result context:

```js
const context = await window.konjugateVisualizer.getContext();
```

```text
context
├── apiVersion
├── sessionId
├── projectName
├── selectedNodeId
├── time
└── run
    ├── name
    ├── targetTime
    ├── outputInterval
    ├── sampleCount
    ├── lifecycle              `running`, `paused`, `stopped`, or `completed`
    ├── simulationTime
    ├── availableResultTime
    └── pacing
        ├── mode               `fastest`, `realTime`, or `limitedRatio`
        └── simulationSecondsPerWallSecond
```

The context contains metadata, not the full model or result sample storage. It returns `null` after the result session is no longer available.

### `listSignals()`

Returns a promise for the signal catalogue. It requires `results.read`.

```js
const signals = await window.konjugateVisualizer.listSignals();
```

Each signal contains:

```text
signal
├── signalUuid     state UUID used for API references
├── entityUuid     owning node UUID
├── entityName     current display name of the node
├── name           display name of the state
├── symbol         model symbol of the state
└── unit           unit string, possibly empty
```

Names and symbols are presentation metadata. Store and request signals by `signalUuid`.

### `readSeries(signalUuids, options)`

Returns samples for the requested signals. It requires `results.read`.

```js
const series = await window.konjugateVisualizer.readSeries(
    selectedSignalUuids,
    {
        startTime: 0,
        endTime: context.run.targetTime,
        maxPoints: 5000
    }
);
```

All options are optional. The defaults are the entire run and at most 4,000 requested points. The host may downsample before crossing the process boundary. The first and last retained samples in the requested range are preserved when possible.

Each returned series repeats its signal metadata and adds:

```text
samples: [{ time: Number, value: Number }, ...]
```

An add-on should request only the signals and resolution it can display. Do not assume all runs fit comfortably in renderer memory.

During a live run, `readSeries()` returns the complete samples currently published by the engine. Re-request only the visible series after `onSamplesAvailable`; the event intentionally does not push the potentially large sample payload across the bridge.

### `seek(time)`

Requests a new time from the main result player. It requires `timeline.seek`.

```js
window.konjugateVisualizer.seek(4.2);
```

The host clamps the request to the latest available result time. The main player selects its nearest available output sample and subsequently publishes the accepted time through `onTimelineChange` when `timeline.read` is granted.

### `onTimelineChange(callback)`

Subscribes to accepted timeline changes. It requires `timeline.read`.

```js
window.konjugateVisualizer.onTimelineChange((time) => {
    movePlotCursor(time);
});
```

The callback may run frequently during playback. Update cursors or layout incrementally instead of rebuilding complete plots.

### `onSelectionChange(callback)`

Subscribes to selected-node UUID changes. It requires `selection.read`. The value is `null` when no node is selected or when another entity type is selected.

```js
window.konjugateVisualizer.onSelectionChange((nodeUuid) => {
    highlightEntity(nodeUuid);
});
```

Selection notification does not require the add-on to replace its chosen signals.

### `onSessionChange(callback)`

Notifies an already-open visualizer that its result session was replaced by a new command invocation. Re-read the context, catalogue, and required series inside the callback.

```js
window.konjugateVisualizer.onSessionChange(async () => {
    await loadActiveSession();
});
```

When the user explicitly closes results in Konjugate, the visualizer window is closed and its session is invalidated.

### Live run events and pacing

`onSamplesAvailable(callback)` requires `results.live.read` and reports `{ sampleCount, availableResultTime }` whenever a new atomic result snapshot is available. `onRunStatusChange(callback)` requires `simulation.status.read` and publishes the current `run` metadata. `onPacingChange(callback)` requires `simulation.pacing.read`.

```js
window.konjugateVisualizer.onSamplesAvailable(async () => {
    const series = await window.konjugateVisualizer.readSeries(selectedSignalUuids);
    updatePlot(series);
});
window.konjugateVisualizer.onRunStatusChange((run) => updateStatus(run.lifecycle));
```

An add-on with `simulation.pacing.control` may request a live pacing change:

```js
await window.konjugateVisualizer.requestPacing({
    mode: 'limitedRatio',
    simulationSecondsPerWallSecond: 2
});
```

`realTime` always means one simulation second per wall second. `fastest` removes the wall-clock limit. A limited ratio is a cap, not a guarantee: computationally expensive models may advance more slowly. Simulation pacing controls engine execution; it is separate from the completed-result playback rate and must not be presented as playback speed.

## Minimal visualizer

`index.html`:

```html
<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'self'; script-src 'self'; style-src 'self'">
    <title>My result viewer</title>
    <script type="module" src="viewer.mjs"></script>
</head>
<body>
    <select id="signals" multiple></select>
    <pre id="output"></pre>
</body>
</html>
```

`viewer.mjs`:

```js
const signalSelect = document.querySelector('#signals');
const output = document.querySelector('#output');

async function loadSession() {
    const context = await window.konjugateVisualizer.getContext();
    const signals = await window.konjugateVisualizer.listSignals();

    signalSelect.replaceChildren(...signals.map((signal) => {
        const option = document.createElement('option');
        option.value = signal.signalUuid;
        option.textContent = `${signal.entityName} · ${signal.name} (${signal.unit || 'unitless'})`;
        return option;
    }));

    output.textContent = `${context.projectName} · ${context.run.name}`;
}

signalSelect.addEventListener('change', async () => {
    const signalUuids = [...signalSelect.selectedOptions].map((option) => option.value);
    const series = await window.konjugateVisualizer.readSeries(signalUuids, { maxPoints: 1000 });
    output.textContent = JSON.stringify(series, null, 2);
});

window.konjugateVisualizer.onSessionChange(loadSession);
loadSession();
```

This example intentionally uses no framework. Canvas, WebGL, SVG, and locally packaged plotting libraries are all possible inside the add-on window.

## Domain-specific visualizers

The version 1 catalogue supplies state identity, name, symbol, unit, and owning node. It does not yet prescribe semantic roles such as longitude, X position, heading, quaternion component, or coordinate frame.

A domain-specific add-on should therefore let the user map signals to its required roles. For example, a vehicle viewer might request mappings for X, Y, Z, and heading, then store that configuration within its own storage when such storage is supported. Do not infer durable meaning solely from a mutable display name.

Semantic quantity and coordinate-frame metadata are candidates for a later API version. They should remain domain-agnostic and optional.

## Versioning and forward compatibility

- Reject an unavailable `apiVersion`; do not guess compatible behavior.
- Treat unknown fields returned by the host as additive and ignore them safely.
- Use UUID fields for identity and display fields only for presentation.
- Expect result datasets to become larger than can be copied into one renderer.
- Keep add-on state separate from the Konjugate model unless a future namespaced persistence API is explicitly provided.
- Avoid depending on the bundled Results Analysis add-on or other Konjugate implementation files.

Future API versions may add richer semantic metadata, streaming and live-run subscriptions, namespaced persistence, additional contribution points, and installation or trust management. None of those capabilities are part of version 1.
