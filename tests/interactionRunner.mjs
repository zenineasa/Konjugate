/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mulberry32, gaussianFrom, buildThermalSystemCsv } from './fixtures/thermalSystemCsv.mjs';
import { unzipSync } from 'fflate';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { decodeProjectFile, encodeProjectFile } from '../src/projectFile.mjs';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { spawnSync } from 'node:child_process';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { readDataLog } from '../src/dataLog.mjs';
import { createPackageArchive } from '../src/packageArchive.mjs';
import { startRigServer } from './fixtures/opcuaRigServer.mjs';
import { groupTutorials } from '../src/tutorials/index.mjs';
import { startFakeOllama } from './fixtures/fakeOllama.mjs';

// What a scenario checks: what it is about, by ids, data attributes and state (a row's count, a control's value, a
// [data-state]), and words only where the words are the point (a message's facts, a name the person typed, the cost a
// setting states). A label or an empty list's sentence can be reworded without breaking a scenario.
//
// These 10 primitives, and every scenario below, operate on a "handle" -- a driver-produced
// object wrapping either a live Electron BrowserWindow (tests/drivers/electronWindowDriver.mjs)
// or a Playwright Page (tests/drivers/playwrightWebDriver.mjs) -- rather than a raw BrowserWindow
// directly, so the exact same scenario definitions run against both the desktop app and the web
// edition in a real browser. A handle exposes: evaluate(expression), mouseMove/mouseDown/mouseUp
// (point, opts?), click/rightClick(point, opts?), keyDown/keyUp(keyCode), onConsoleMessage
// (listener) -> unsubscribe, title(), close(), isDestroyed(), parent(). The driver itself (not a
// per-handle concern) additionally exposes: kind, mainHandle, allHandles(), waitForNewHandle(...),
// captureExport(trigger, opts?), simulateOsFileOpen(path), capabilities (a set of booleans a
// scenario checks to decide whether to skip itself -- see run()'s own skip option below), and
// dispose(). See either driver file's header comment for the full contract and why each method
// is shaped the way it is.

async function evaluate(window, expression) {
    return window.evaluate(expression);
}

// A renderer-side exception thrown synchronously inside a DOM event listener (e.g. from a
// synthetic element.click()) never rejects executeJavaScript's promise -- the browser's event
// dispatch loop swallows it and only reports it to the console as "Uncaught ...". Any assertion
// checking DOM/JS state after such a call can't distinguish "ran correctly" from "the handler
// crashed before reaching that state" (a value it never got to update just looks unchanged).
// This captures renderer console output around a task so callers can assert nothing was logged.
async function captureConsoleMessages(window, task) {
    const messages = [];
    const unsubscribe = window.onConsoleMessage((message) => messages.push(message));
    try {
        await task();
    } finally {
        unsubscribe();
    }
    return messages;
}

// Checks the rendered computed style rather than the `hidden` IDL property: a `hidden`
// element can still render if some other CSS rule sets `display` with equal or higher
// specificity than the UA stylesheet's `[hidden] { display: none }`, which the property
// alone would never reveal.
async function isRenderedVisible(window, selector) {
    return evaluate(window, `getComputedStyle(document.querySelector('${selector}')).display !== 'none'`);
}

async function waitFor(window, expression, message, timeout = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await evaluate(window, expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const visibleError = await evaluate(window, `document.querySelector('#assistantError:not([hidden])')?.textContent ?? ''`);
    // The status bar's own line (Validating…, Model valid), and the assistant's progress only while its proposal is showing: hidden,
    // it still holds its first words, which say nothing about the window.
    const assistantStatus = await evaluate(window, `[document.querySelector('#statusText')?.textContent, document.querySelector('#assistantProposalStatus')?.checkVisibility?.() ? document.querySelector('#assistantProposalStatus').textContent : ''].filter(Boolean).join(' · ')`);
    // Where a run had got to, when one is showing: one far short of its end was slowed (a runner throttling the app's
    // timers), one stuck at a value had stopped.
    const run = await evaluate(window, `(() => { const mode = document.querySelector('.resultMode small')?.textContent; const progress = document.querySelector('#simulationProgress'); return mode && !document.querySelector('#resultTransport')?.hidden ? \`\${mode}\${progress && getComputedStyle(progress).display !== 'none' ? ', at ' + progress.value : ''}; window \${document.hidden ? 'hidden' : 'visible'}, \${document.hasFocus() ? 'focused' : 'not focused'}\` : ''; })()`).catch(() => '');
    throw new Error(`${message}${visibleError ? ` ${visibleError}` : ''}${assistantStatus ? ` Status: ${assistantStatus}` : ''}${run ? ` Run: ${run}` : ''}`);
}

// Run opens the Run dialog, and is disabled while the model is being (re)validated, as it is after any edit.
// Clicking a disabled button does nothing, so wait for it first, then for the dialog itself: a test that
// goes on to fill and submit the dialog would otherwise be working on one that never opened.
async function openRunDialog(window) {
    await settle(window, 'validation', 'Validation before opening the Run dialog');
    await waitFor(window, `!document.querySelector('#runButton').disabled`, 'Run was not available to open the Run dialog.', 15000);
    await evaluate(window, `document.querySelector('#runButton').click()`);
    await waitFor(window, `document.querySelector('#runLaunchDialog').open`, 'The Run dialog did not open.');
}

// Closing a window mid-validation cancels its engine process; let validation settle first.
async function closeWhenValidated(window) {
    await settle(window, 'validation', 'Model validation before closing the window');
    await window.close();
}

// A single requestAnimationFrame apart is not a reliable "stopped moving" signal here: the main
// render loop (renderer.mjs's render(), which repositions every CSS2D label and applies
// OrbitControls damping) is throttled to 30fps, so two rAF ticks can both land inside the same
// un-rendered ~33ms window and report "unchanged" even while a real position update -- e.g.
// OrbitControls damping (dampingFactor 0.07) still easing off a preceding pan/zoom/rotate test --
// is genuinely pending on the next actual render tick. Requiring several consecutive matches,
// each spaced further apart (50ms) than the render throttle, actually observes real render ticks
// instead of possibly sampling twice inside a gap between them.
async function waitForStableRect(window, expression, message, timeout = 3000) {
    const startedAt = Date.now();
    let previous = null;
    let stableStreak = 0;
    while (Date.now() - startedAt < timeout) {
        const current = await evaluate(window, expression);
        if (current && current === previous) {
            stableStreak += 1;
            if (stableStreak >= 3) return;
        } else {
            stableStreak = 0;
        }
        previous = current;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(message);
}

// Waits for the window to finish a piece of its own work, by awaiting the promise it hands out for it (window.__debugSettle in
// renderer.mjs: validation, frame, camera, labels), rather than watching the page until a time limit runs out. A slow machine
// then only takes longer; it does not fail. The limit left is a guard against a window that never settles at all, set far
// beyond any machine's slowness, so reaching it means something is wrong, not that the machine was slow.
const settleHangGuardMs = 120000;
async function settle(window, kind, what = 'The window') {
    let guard;
    const hung = new Promise((_resolve, reject) => {
        guard = setTimeout(() => reject(new Error(`${what} had still not settled (${kind}) after ${settleHangGuardMs / 1000} s.`)), settleHangGuardMs);
    });
    try {
        // A window that is not a project window (a guide, the Welcome window, an add-on's) has none of this work to finish.
        await Promise.race([evaluate(window, `window.__debugSettle ? window.__debugSettle.${kind}().then(() => true) : true`), hung]);
    } finally {
        clearTimeout(guard);
    }
}

// The canvas moves under a fixed screen point in two ways: sliding over when an editor card opens or closes (`.webglContainer`
// and `.css2dContainer` animate their `right` edge), and the camera easing after a view change or a drag (its snap animation, or
// OrbitControls' damping). A screen point read during either is where the thing was, not where it will be when the click lands,
// so anything aiming at the canvas waits for both to end: the slides' own `finished` promises (`getAnimations()` flushes style,
// so a slide a click just started is counted), then the window's word that its camera is still and a frame drawn with it, which
// is also the frame that places every label.
async function waitForCanvasAtRest(window, what = 'The canvas') {
    await evaluate(window, `Promise.all(document.getAnimations().filter((animation) => ['webglContainer', 'css2dContainer'].includes(animation.effect?.target?.id)).map((animation) => animation.finished.catch(() => {}))).then(() => true)`);
    await settle(window, 'camera', what);
}

// A test hook's screen point (window.__relationshipScreenPoint and the like), read once the canvas is at rest.
async function canvasPoint(window, expression) {
    await waitForCanvasAtRest(window);
    return evaluate(window, expression);
}

// The element's centre, once a click there would reach it: inside the window, and not under something else (an
// editor card in a small window, a toast, another label) when the element takes clicks itself. A real mouse event goes to whatever is on top, so a
// click on a covered element would quietly land on the cover instead, and the test would fail later, somewhere
// unrelated. This fails at the click instead, naming what is in the way.
async function clickablePoint(window, expression, timeout = 2000) {
    const probe = `(() => {
        const element = ${expression};
        if (!element) return 'it is not in the page';
        const bounds = element.getBoundingClientRect();
        const x = Math.round(bounds.left + bounds.width / 2), y = Math.round(bounds.top + bounds.height / 2);
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return \`its centre (\${x}, \${y}) is outside the \${innerWidth}x\${innerHeight} window\`;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === element || element.contains(hit))) return { x, y };
        // A label the mouse passes through (pointer-events: none, as the canvas labels are) is clicked by way of what is
        // under it, the canvas, which finds the label itself; only a target that takes the click can be covered.
        if (getComputedStyle(element).pointerEvents === 'none') return { x, y };
        const describe = (node) => node ? node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + [...node.classList].map((name) => '.' + name).join('') : 'nothing';
        const cover = hit?.closest('[id]');
        return \`at (\${x}, \${y}) it is covered by \${describe(hit)}\${cover && cover !== hit ? ' inside ' + describe(cover) : ''} (the window is \${innerWidth}x\${innerHeight})\`;
    })()`;
    const startedAt = Date.now();
    let result;
    while (Date.now() - startedAt < timeout) {
        result = await evaluate(window, probe);
        if (typeof result === 'object') return result;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`The element to click cannot be clicked: ${result}. (${expression})`);
}

async function clickElement(window, expression, modifiers = []) {
    // At rest is also the frame drawn after the camera stopped, which places a label made a moment ago (an undo or redo
    // rebuilds every label) where it will be when the click lands.
    await waitForCanvasAtRest(window);
    const point = await clickablePoint(window, expression);
    await window.mouseMove(point, { modifiers });
    await window.mouseDown(point, { button: 'left', clickCount: 1, modifiers });
    await window.mouseUp(point, { button: 'left', clickCount: 1, modifiers });
}

// A node's own part on a state, written as a person writes it (docs/proposals/unifiedEntityEditors.md): in the state's own field
// on the open node's Equations tab, its folded line opened first, and then left, which makes it one undoable step.
async function writeOwnPart(window, symbol, latex) {
    await evaluate(window, `document.querySelector('#nodeEditor [data-editor-tab="equations"]').click()`);
    const field = `document.querySelector('#nodeEditorStates .stateCard[data-symbol="${symbol}"] .ownPart')`;
    if (!await evaluate(window, `Boolean(${field})`)) await evaluate(window, `document.querySelector('#nodeEditorStates .stateFold[data-symbols~="${symbol}"] .stateSummary')?.click()`);
    await waitFor(window, `Boolean(${field})`, `The ${symbol} state has no own field.`);
    await evaluate(window, `(() => { const field = ${field}; field.focus(); field.setValue(${JSON.stringify(latex)}); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}

// A state's fields, opened from its line as a person opens them (its folded line first, when nothing changes it).
async function openStateFields(window, symbol) {
    if (!await evaluate(window, `Boolean(document.querySelector('#nodeEditorStates .stateCard[data-symbol="${symbol}"]'))`)) {
        await evaluate(window, `document.querySelector('#nodeEditorStates .stateFold[data-symbols~="${symbol}"] .stateSummary')?.click()`);
    }
    await evaluate(window, `(() => { const line = document.querySelector('#nodeEditorStates .stateCard[data-symbol="${symbol}"] .stateSummary'); if (line?.getAttribute('aria-expanded') === 'false') line.click(); })()`);
    await waitFor(window, `Boolean(document.querySelector('#nodeEditorStates .stateCard[data-symbol="${symbol}"] .editorStateRow:not([hidden])'))`, `The ${symbol} state's fields did not open.`);
}

// The own part's parameters on a state, on the open node's Parameters tab.
const ownParameterGroup = (symbol) => `document.querySelector('#nodeEditorParameters .ownParameterGroup[data-symbol="${symbol}"]')`;
const ownParameterRow = (symbol) => `${ownParameterGroup(symbol)}.querySelector('.editorParameterRow')`;

// A parameter added to the own part on a state, with these fields (name, symbol, value...), as the Parameters tab adds one.
async function addOwnParameter(window, symbol, fields) {
    await evaluate(window, `document.querySelector('#nodeEditor [data-editor-tab="parameters"]').click()`);
    await waitFor(window, `Boolean(${ownParameterGroup(symbol)})`, `The ${symbol} state has no own part to add a parameter to.`);
    const before = await evaluate(window, `${ownParameterGroup(symbol)}.querySelectorAll('.editorParameterRow').length`);
    await evaluate(window, `${ownParameterGroup(symbol)}.querySelector('.addOwnParameter').click()`);
    await waitFor(window, `${ownParameterGroup(symbol)}.querySelectorAll('.editorParameterRow').length > ${before}`, 'The parameter was not added.');
    await evaluate(window, `(() => { const row = [...${ownParameterGroup(symbol)}.querySelectorAll('.editorParameterRow')].at(-1); for (const [field, value] of Object.entries(${JSON.stringify(fields)})) row.querySelector('[data-field="' + field + '"]').value = value; row.querySelector('[data-field="symbol"]').dispatchEvent(new Event('change', { bubbles: true })); })()`);
}

// What the own field on a state says of what is written in it, and the references it offers.
const ownPartDiagnostics = (symbol) => `document.querySelector('#nodeEditorStates .stateCard[data-symbol="${symbol}"] .ownPartDiagnostics')`;
const ownPartReferences = (symbol) => `[...document.querySelectorAll('#nodeEditorStates .stateCard[data-symbol="${symbol}"] .ownPartReferences button')]`;

// Re-resolves the element's screen position on every call rather than caching one set of
// coordinates -- a CSS2D label can shift by a pixel or two as selection/disabled styling changes
// its box (border, badge text), and a stale cached point can miss the element entirely on a
// later right-click in the same test.
async function rightClickElement(window, expression) {
    await waitForCanvasAtRest(window);
    const point = await clickablePoint(window, expression);
    await window.mouseMove(point);
    await window.mouseDown(point, { button: 'right', clickCount: 1 });
    await window.mouseUp(point, { button: 'right', clickCount: 1 });
}

// A CSS2D overlay (a node/edge label) always wins DOM hit-testing over the WebGL canvas
// beneath it regardless of 3D depth, so a point that's a valid 3D raycast target can still be
// undeliverable to the canvas as a real click if a label happens to cover it there -- and
// exactly where that is can shift with accumulated camera state this deep into the suite, even
// when nothing occludes it on a fresh load. Spiral outward until landing on a pixel the canvas
// itself owns, rather than assume the originally-computed point is still clear.
async function findCanvasPoint(window, point, maxRadius = 40) {
    if (!point) return null;
    await waitForCanvasAtRest(window);
    for (let radius = 0; radius <= maxRadius; radius += 4) {
        const offsets = radius === 0 ? [[0, 0]] : [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius, radius], [-radius, -radius], [radius, -radius], [-radius, radius]];
        for (const [dx, dy] of offsets) {
            const candidate = { x: point.x + dx, y: point.y + dy };
            const isCanvas = await evaluate(window, `document.elementFromPoint(${candidate.x}, ${candidate.y})?.classList.contains('webglSurface') ?? false`);
            if (isCanvas) return candidate;
        }
    }
    return point;
}

// Generalizes the same spiral-until-clear idea to an arbitrary CSS2D label, rather than the
// WebGL canvas specifically. Two overlapping CSS2D overlays (e.g. a relationship bundle label
// whose midpoint happens to land near one of its own endpoint nodes' labels) can leave a point
// that's inside one element's bounding rect but actually owned by the *other* one for
// hit-testing purposes -- confirmed via document.elementFromPoint() returning the node's own
// objectLabel instead of the intended bundle label at the naive center point. Searches only
// within the target element's own bounding rect (not an unbounded radius), since wandering
// outside it would just find some other element's clear space, not a still-valid point on this
// one.
async function findUnoccludedPoint(window, elementExpression, maxRadius = 30) {
    await waitForCanvasAtRest(window);
    const rect = await evaluate(window, `(() => {
        const el = ${elementExpression};
        const r = el?.getBoundingClientRect();
        return r && { x: r.left + r.width / 2, y: r.top + r.height / 2, halfWidth: r.width / 2, halfHeight: r.height / 2 };
    })()`);
    if (!rect) return null;
    for (let radius = 0; radius <= maxRadius; radius += 3) {
        const offsets = radius === 0 ? [[0, 0]] : [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius, radius], [-radius, -radius], [radius, -radius], [-radius, radius]];
        for (const [dx, dy] of offsets) {
            if (Math.abs(dx) > rect.halfWidth || Math.abs(dy) > rect.halfHeight) continue;
            const candidate = { x: Math.round(rect.x + dx), y: Math.round(rect.y + dy) };
            const owned = await evaluate(window, `(() => {
                const el = ${elementExpression};
                const hit = document.elementFromPoint(${candidate.x}, ${candidate.y});
                return Boolean(el && hit && el.contains(hit));
            })()`);
            if (owned) return candidate;
        }
    }
    return { x: Math.round(rect.x), y: Math.round(rect.y) };
}

// A handful of raw, pixel-coordinate pointer gestures (as opposed to clicking a known DOM
// element) are retried a few times rather than treated as a hard failure: a press-and-hold or a
// drag can still be cut short by a stray pointer event. (Most of their old flakiness was a point
// read while the canvas was still sliding after a card closed; see waitForCanvasAtRest.) `perform` re-runs from scratch each attempt (re-reading any screen
// points fresh) since a prior attempt may have nudged state slightly.
async function retryGesture(window, perform, checkExpression, times = 5, settleMs = 200) {
    for (let attempt = 0; attempt < times; attempt += 1) {
        await perform();
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        if (await evaluate(window, checkExpression)) return true;
    }
    return false;
}

// Two edges (and, optionally, one source term) whose "gain" parameters all link to one shared
// parameter -- the fixture for the shared-parameter and parameters-table scenarios below.
function sharedParameterTestProject({ withSourceTerm = false } = {}) {
    const parameter = (id, name = 'Gain', symbol = 'gain') => ({ id, name, symbol, value: 5, mode: 'constant', sharedParameterId: 100 });
    const node = (id, name, stateId, position, sourceTerms = []) => ({
        id, name, position, sourceTerms, appearance: { type: 'primitive', shape: 'box', color: '#888888' },
        states: [{ id: stateId, name: 'Level', symbol: 'level', initialValue: 0 }]
    });
    const edge = (id, name, targetNodeId, targetStateId, parameterId) => ({
        id, name, source: { nodeId: 1, stateId: 2 }, target: { nodeId: targetNodeId, stateId: targetStateId }, directionality: 'directed',
        equation: '\\mathrm{gain}',
        equationModel: {
            latex: '\\mathrm{gain}', output: { role: 'target', stateId: targetStateId },
            bindings: [{ kind: 'parameter', parameterId, symbol: 'gain' }], mathJson: 'gain'
        },
        parameters: [parameter(parameterId)], appearance: { color: '#888888', offset: 0 }
    });
    const sourceTerm = {
        id: 13, state: 'level', expression: '\\mathrm{gain}',
        expressionModel: { latex: '\\mathrm{gain}', output: { stateId: 4 }, bindings: [{ kind: 'parameter', parameterId: 14, symbol: 'gain' }], mathJson: 'gain' },
        parameters: [parameter(14, 'Source gain')]
    };
    return {
        format: 'konjugate', version: 1, metadata: { units: 'SI' },
        sharedParameters: [{ id: 100, name: 'Shared gain', symbol: 'gain', value: 2, unit: 'x', mode: 'constant' }],
        nodes: [node(1, 'Source', 2, [-4, 0, 0]), node(3, 'Target X', 4, [4, 3, 0], withSourceTerm ? [sourceTerm] : []), node(5, 'Target Y', 6, [4, -3, 0])],
        edges: [edge(7, 'Feed X', 3, 4, 8), edge(9, 'Feed Y', 5, 6, 10)]
    };
}

export async function runInteractionTests(driver) {
    await driver.prepare?.();
    const window = driver.mainHandle;
    // Add-ons that live in their own repositories are installed per run by the runner scripts (see
    // scripts/interactionAddons.mjs); a test needing one that wasn't found is skipped, not failed.
    const installedAddons = new Set((process.env.KONJUGATE_INTERACTION_INSTALLED_ADDONS ?? '').split(',').filter(Boolean));
    const addonMissing = (addonId, repository) => !installedAddons.has(addonId) && `needs the ${addonId} add-on -- build ../${repository} (npm run build) or set KONJUGATE_INTERACTION_ADDONS`;
    let passedCount = 0;
    let skippedCount = 0;
    // Every scenario runs, and the failures are listed together at the end, so one run finds them all. Set
    // KONJUGATE_INTERACTION_STOP_ON_FAILURE=1 to stop at the first instead, as when the failure itself is being looked at.
    const failures = [];
    const stopOnFailure = process.env.KONJUGATE_INTERACTION_STOP_ON_FAILURE === '1';
    // The assistant's model in these tests: a fake Ollama server (tests/fixtures/fakeOllama.mjs) answering by fixed rules, through
    // the app's own Ollama provider. It starts with no model, so the scenario that sets the assistant up downloads one.
    const fakeOllama = driver.capabilities.aiAssistant ? await startFakeOllama({ models: [], pullSteps: 6, pullDelayMilliseconds: 60 }) : null;
    // One substring of a test's name, or several separated by "||" to run those tests in the order they appear.
    const only = process.env.KONJUGATE_INTERACTION_ONLY?.split('||').filter(Boolean);
    // How long each scenario takes, said on its line and the slowest listed at the end: the suite is kept quick by seeing where its time goes.
    const durations = [];
    // Each scenario reached and how it went, in order: written to KONJUGATE_INTERACTION_RESULTS (a JSON file) when that is set,
    // for a script that retries the failures (scripts/runPackagedInteractionTests.mjs).
    const outcomes = [];
    // Scenarios that carry on from the one before them, so they only make sense together, in this order: a set-up made
    // in one (the assistant's model, a finished run, a saved copy, an add-on's window) is what the next works on. Every
    // other scenario sets itself up (freshExample(), clean(), or a project of its own), and runs the same alone. A
    // scenario that fails is run again with the members of its group before it (scripts/interactionRetry.mjs).
    const scenarioGroups = {
        'the example guide': ['examples explorer loads a project copy', 'example selection opens its companion guide'],
        'the assistant': [
            'with no model set up the assistant offers Settings, which finds Ollama, downloads the suggested model and uses it',
            'local assistant prepares, validates and applies one undoable transaction',
            'local assistant can disable and enable a node and a relationship',
            'local assistant asks a clarifying question for an ambiguous request and resolves it from a suggestion',
            'dismissing a clarification and starting a new conversation both clear it without submitting'
        ],
        'a subsystem from the selection': [
            'rectangle tool selects visible nodes without opening an inspector',
            'selected nodes become a navigable undoable subsystem'
        ],
        'a parameter\'s mode': [
            'live parameters expose labelled live-range bounds with validation',
            'a live-mode parameter cannot also be marked tunable, and switching to live clears any existing tuning bounds'
        ],
        'a copy with its own ownership': [
            'saving a new project offers its ownership details for that copy alone',
            'a project saved as a copy with other ownership details keeps writing that copy, and keeps its own details'
        ],
        'a run and its results': [
            'Run invokes the C++ simulation and displays state results',
            'Results Analysis add-on inspects and exports a completed run',
            'closing results clears the main window and any add-on it opened'
        ],
        'the provider editor': [
            'relationship editor authors an inline C++ provider implementation',
            'provider editor window syntax-highlights, validates and applies C++ source'
        ],
        'the Pose Visualizer': [
            'Pose Visualizer add-on auto-detects and renders a 6-DOF free body node',
            'Pose Visualizer add-on inspects a completed run with two free bodies',
            'Pose Visualizer add-on keeps body mappings with the project and naming conventions for the user',
            'closing results and removing the free-body nodes cleans up the pose scenario'
        ]
    };
    const groupOf = new Map(Object.entries(scenarioGroups).flatMap(([group, names]) => names.map((name) => [name, group])));
    const scenariosSeen = new Set();
    let startedAt = 0;
    const scenarioMinutes = Number(process.env.KONJUGATE_INTERACTION_SCENARIO_MINUTES) || 15;
    const run = async (name, task, { skip } = {}) => {
        scenariosSeen.add(name);
        if (only?.length && !only.some((fragment) => name.includes(fragment))) return;
        const took = () => {
            const seconds = (performance.now() - startedAt) / 1000;
            durations.push({ name, seconds });
            return `${seconds.toFixed(1)} s`;
        };
        if (skip) {
            console.log(`○ ${name} (skipped: ${skip})`);
            skippedCount += 1;
            outcomes.push({ name, status: 'skipped', ...(groupOf.has(name) ? { group: groupOf.get(name) } : {}) });
            return;
        }
        try {
            // Each test starts with the project window in front and drawing: a window an earlier test opened may cover
            // it, and a covered window can report itself hidden, which stops the canvas drawing, so labels a test clicks
            // or measures stay where they were. A window the test opens itself still opens on top.
            if (!await window.isDestroyed()) {
                await window.focus();
                await waitFor(window, `!document.hidden`, 'The project window stayed hidden.');
            }
            startedAt = performance.now();
            // A scenario stuck for good (an evaluate whose promise never settles: every wait has its own limit) fails
            // here with its name, rather than holding the run until a CI job's own limit ends it with nothing said. The
            // slowest, skipping through every tutorial, takes about 6.5 minutes on a slow runner.
            let timer;
            try {
                await Promise.race([task(), new Promise((resolve, reject) => {
                    timer = setTimeout(() => reject(new Error(`still running after ${scenarioMinutes} minutes, so it was given up`)), scenarioMinutes * 60_000);
                })]);
            } finally {
                clearTimeout(timer);
            }
            passedCount += 1;
            outcomes.push({ name, status: 'passed', ...(groupOf.has(name) ? { group: groupOf.get(name) } : {}) });
            console.log(`✓ ${name} · ${took()}`);
            // A native dialog the test did not expect was answered for it, not left on the screen: said, so it can be looked at.
            for (const asked of driver.takeNativeDialogs?.() ?? []) console.log(`  (a native ${asked.kind} dialog, "${asked.title}", was answered as cancelled)`);
        } catch (error) {
            // Some errors (Electron's own "Script failed to execute") ignore a changed message, which
            // would leave the failure unnamed: wrap those instead, keeping the original as the cause.
            const named = `${name}: ${error?.message ?? error}`;
            try { error.message = named; } catch { /* read-only */ }
            const failure = error?.message === named ? error : new Error(named, { cause: error });
            outcomes.push({ name, status: 'failed', ...(groupOf.has(name) ? { group: groupOf.get(name) } : {}) });
            if (stopOnFailure) throw failure;
            failures.push({ name, error: failure });
            console.log(`✗ ${name} · ${took()}`);
            console.error(failure);
            await putAwayLeftovers();
        }
        // Coverage, when it is on, is taken a scenario at a time where the driver needs it (the web edition's).
        await driver.afterScenario?.(name);
    };
    // What a scenario may have left behind, put away so the next one starts as the others do: windows it opened, dialogs
    // and Settings left open, a simulation result left showing. Best effort: whatever cannot be put away is left. Done
    // after a failure, and by freshExample() before a scenario that starts from an example.
    const putAwayLeftovers = async () => {
        for (const handle of driver.allHandles?.() ?? []) {
            if (handle === window || handle._raw === window._raw) continue;
            try { if (!await handle.isDestroyed()) await handle.close(); } catch { /* already gone */ }
        }
        try {
            await evaluate(window, `(() => {
                window.confirm = () => true;
                for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
                document.querySelector('#closeAssistantPanel')?.click();
                document.querySelector('#closeResults')?.click();
            })()`);
            // Closing a result asks first: answered here.
            await new Promise((resolve) => setTimeout(resolve, 250));
            await evaluate(window, `document.querySelector('#closeResultsDialog[open] #confirmCloseResults')?.click()`);
        } catch { /* the window may be gone */ }
        driver.takeNativeDialogs?.();
    };

    // An example as it is when loaded, for a scenario that works on it: the scenario then runs the same alone (a retry,
    // KONJUGATE_INTERACTION_ONLY) as after the ones before it, rather than on whatever they left. It is loaded into the
    // open window, which takes a fraction of a second; nothing is restarted.
    const freshExample = async (name = 'thermalManagement') => {
        await putAwayLeftovers();
        const content = await decodeProjectFile(await readFile(join(process.cwd(), 'examples', `${name}.kjt`)));
        const nodes = JSON.parse(content).nodes.filter((node) => node.subsystemId == null).length;
        await evaluate(window, `(async () => {
            if (window.__debugTour?.active()) window.__debugTour.stop();
            document.querySelectorAll('.contextCard').forEach((card) => card.classList.add('hidden'));
            await window.__debugProject.load(${content}, ${JSON.stringify(`${name}.kjt`)});
        })()`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === ${nodes} && document.querySelector('.documentTitle')?.textContent === ${JSON.stringify(name)} && !window.__debugTour.blockers().dirty`, `The ${name} example did not load.`);
    };
    // The thermal example, fresh, with its Battery module relationship's editor open, as a left-click on its label leaves it.
    const freshRelationshipEditor = async () => {
        await freshExample();
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`, 'The relationship editor did not open.');
    };

    await run('examples explorer loads a project copy', async () => {
        await evaluate(window, `document.querySelector('#exampleButton').click()`);
        await waitFor(window, `document.querySelector('#examplesExplorerDialog').open`, 'Examples explorer did not open.');
        // Seen once in a full run and not since (2026-11-16): the explorer open, but without this example. What it showed is said.
        await waitFor(window, `Boolean([...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.querySelector('b').textContent === 'Thermal Management'))`, 'Examples explorer did not populate.').catch(async (error) => {
            const shown = await evaluate(window, `({ examples: [...document.querySelectorAll('.examplesExplorerItem b')].map((title) => title.textContent), search: document.querySelector('#examplesExplorerSearch').value, domain: document.querySelector('#examplesExplorerDomains .active')?.textContent ?? null })`);
            throw new Error(`${error.message} It showed ${JSON.stringify(shown)}.`);
        });
        await evaluate(window, `[...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.querySelector('b').textContent === 'Thermal Management').click()`);
        await waitFor(window, `document.querySelector('#examplesExplorerDetailTitle').textContent === 'Thermal Management'`, 'Selecting the example did not populate the detail preview.');
        assert.equal(await evaluate(window, `document.querySelector('#examplesExplorerDetailContent').hidden`), false);
        assert.match(await evaluate(window, `document.querySelector('#examplesExplorerDetailDescription').textContent`), /enclosed-air volume/i);
        await evaluate(window, `document.querySelector('#examplesExplorerLoad').click()`);
        // loadExample()'s click handler isn't awaited by the caller, and closing the dialog
        // happens in its `finally` block after the (also awaited-inside-loadExample) guide
        // window IPC round trip -- so the dialog can still be open for a moment after the model
        // itself has already finished loading. Wait for the actual close rather than the model
        // load alone, to avoid a race against that same handler's own tail end.
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 3`, 'Thermal example did not load.');
        assert.equal(await evaluate(window, `document.querySelector('.documentTitle').textContent`), 'thermalManagement');
        await waitFor(window, `!document.querySelector('#examplesExplorerDialog').open`, 'Examples explorer did not close after loading the example.');

        // The example says whose work it is and on what terms; it names an owner other than the person's defaults, so a save would keep it.
        await evaluate(window, `document.querySelector('#ownershipButton').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open`, 'Project properties did not open for the example.');
        const shown = await evaluate(window, `Object.fromEntries([...document.querySelectorAll('#ownershipFieldsHost [name]')].filter((control) => control.type !== 'checkbox').map((control) => [control.name, control.value]))`);
        assert.equal(shown.title, 'Battery Thermal Management');
        assert.equal(shown.owner, 'Zenin Easa Panthakkalakath');
        assert.equal(shown.license, '0BSD');
        assert.equal(shown.contact, 'info@konjugate.com');
        assert.match(shown.copyright, /^Copyright © 2026 Zenin Easa Panthakkalakath$/);
        assert.equal(await isRenderedVisible(window, '#ownershipSomeoneElses'), true);
        assert.match(await evaluate(window, `document.querySelector('#ownershipSaveTimes').textContent`), /First saved .*last saved .*with Konjugate/);
        await evaluate(window, `document.querySelector('#ownershipCancel').click()`);
        await waitFor(window, `!document.querySelector('#ownershipDialog').open`, 'Project properties did not close.');
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('.windowTitle i')).visibility`), 'visible', 'An example opens as an unsaved copy, and reading its details must not change that.');
    });

    await run('example selection opens its companion guide', async () => {
        // No "before" snapshot here, deliberately: loadExample()'s own click handler (the
        // previous scenario) may already have opened the guide window as a side effect before
        // this scenario even starts, so this must find ANY window matching the title, not one
        // that's merely new relative to a snapshot taken at this scenario's own start.
        const guideWindow = await driver.waitForNewHandle([], { titleIncludes: 'Example Guide' });
        await waitFor(guideWindow, `document.querySelector('#guideTitle').textContent.includes('Thermal Management')`, 'Example guide content did not render.');
        assert.match(await evaluate(guideWindow, `document.querySelector('#content').textContent`), /enclosed-air volume/i);
        assert.doesNotMatch(await evaluate(guideWindow, `document.querySelector('#content').textContent`), /Copyright/);
        await waitFor(guideWindow, `document.querySelectorAll('.equation .ML__latex').length > 0`, 'Example equations did not render with MathLive.');
        assert.equal(await evaluate(guideWindow, `document.querySelectorAll('math-field').length`), 0);
        assert.equal(await evaluate(guideWindow, `[...document.querySelectorAll('.equation [style]')].every((element) => element.style.length > 0)`), true);
        assert.equal(await evaluate(guideWindow, `document.querySelector('.equation').scrollWidth <= document.querySelector('.equation').clientWidth`), true);
        assert.equal(await evaluate(window, `document.querySelector('#exampleGuideButton').hidden`), false);
        await closeWhenValidated(guideWindow);
        await waitFor(window, `!document.querySelector('#exampleGuideButton').hidden`, 'Example guide reopen control disappeared.');
        const beforeReopen = driver.allHandles();
        await evaluate(window, `document.querySelector('#exampleGuideButton').click()`);
        await driver.waitForNewHandle(beforeReopen, { titleIncludes: 'Example Guide' });
    }, {
        // A real, previously-unknown web-edition gap, not a driver/test issue -- confirmed by
        // reading src/renderer/webShims/projectFiles.mjs's openExampleGuide(), not assumed:
        // it does `window.open(rawMarkdownFileUrl, '_blank')`, opening the unrendered .md file
        // directly rather than a guide page with the #guideTitle/#content/MathLive-rendered-
        // equations structure this scenario (and the desktop guide window) actually has. The
        // window.open() mechanism itself is real and portable (confirmed separately -- this
        // scenario's own waitForNewHandle call reliably finds the opened tab), so this is gated
        // on a missing renderer, not a missing capability category.
        skip: !driver.capabilities.renderedExampleGuide && "the web edition's Example Guide opens the raw .md file directly, not a rendered guide page (see docs/proposals/webEdition.md)"
    });

    await run('export simulation code writes a standalone C++ or Python program', async () => {
        for (const [language, parallelism, extension, expectedFragment] of [
            ['cpp', 'serial', 'cpp', 'int main('],
            ['cpp', 'openmp', 'cpp', '#pragma omp parallel for'],
            ['python', 'serial', 'py', 'def run('],
            ['python', 'mpi', 'py', 'from mpi4py import MPI']
        ]) {
            assert.equal(await evaluate(window, `document.querySelector('#exportCodeDialog').open`), false);
            await evaluate(window, `document.querySelector('#exportCodeButton').click()`);
            await waitFor(window, `document.querySelector('#exportCodeDialog').open`, 'Export code dialog did not open.');
            await evaluate(window, `document.querySelector('#exportCodeLanguage').value = '${language}'`);
            await evaluate(window, `document.querySelector('#exportCodeLanguage').dispatchEvent(new Event('change'))`);
            assert.equal(await evaluate(window, `document.querySelector('#exportCodeParallelismOpenmp').disabled`), language === 'python',
                'OpenMP/std::thread options should only be disabled for a Python export.');
            await evaluate(window, `document.querySelector('#exportCodeParallelism').value = '${parallelism}'`);
            const { bytes } = await driver.captureExport(async () => {
                await evaluate(window, `document.querySelector('#exportCodeSubmit').click()`);
                // The dialog closes once the file is fully written; reading earlier can see a partial file.
                await waitFor(window, `!document.querySelector('#exportCodeDialog').open`, 'Export dialog should close after a successful export.', 15000);
            }, { extension });
            const exportedSource = bytes.toString('utf8');
            assert.ok(exportedSource, `Export (${language}/${parallelism}) did not write a file.`);
            assert.match(exportedSource, /time \(s\)/);
            assert.ok(exportedSource.includes(expectedFragment), `Exported (${language}/${parallelism}) source is missing an expected "${expectedFragment}" fragment.`);
        }
    });

    await run('export simulation code as an FMU produces a real, valid FMI 2.0 Co-Simulation package', async () => {
        await evaluate(window, `document.querySelector('#exportCodeButton').click()`);
        await waitFor(window, `document.querySelector('#exportCodeDialog').open`, 'Export code dialog did not open.');
        await evaluate(window, `document.querySelector('#exportCodeFormat').value = 'fmu'`);
        await evaluate(window, `document.querySelector('#exportCodeFormat').dispatchEvent(new Event('change'))`);
        assert.equal(await evaluate(window, `document.querySelector('#exportCodeLanguagePython').disabled`), true,
            'Python should be unavailable once FMU format is selected.');
        assert.equal(await evaluate(window, `document.querySelector('#exportCodeParallelism').closest('label').hidden`), true,
            'The Execution row has no meaning for an FMU export and should be hidden.');
        const { bytes: exportedBuffer } = await driver.captureExport(async () => {
            await evaluate(window, `document.querySelector('#exportCodeSubmit').click()`);
            await waitFor(window, `!document.querySelector('#exportCodeDialog').open`, 'Export dialog should close after the FMU is written.', 60000);
        }, { extension: 'fmu', maxAttempts: 400 });
        assert.ok(exportedBuffer, 'FMU export did not write a file.');
        const entries = unzipSync(exportedBuffer);
        assert.ok(entries['modelDescription.xml'], 'The .fmu is missing modelDescription.xml.');
        const xml = Buffer.from(entries['modelDescription.xml']).toString('utf8');
        assert.match(xml, /fmiVersion="2\.0"/);
        assert.match(xml, /<CoSimulation /);
        const binaryEntry = Object.keys(entries).find((name) => name.startsWith('binaries/') && name !== 'binaries/');
        assert.ok(binaryEntry, 'The .fmu is missing a compiled binaries/<platform>/ shared library.');
        assert.equal(await evaluate(window, `document.querySelector('#exportCodeDialog').open`), false, 'Export dialog should close after a successful export.');
    }, { skip: !driver.capabilities.fmuExport && 'FMU export is not available in the web edition' });

    await run('a second project window opens independently and does not affect the first', async () => {
        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('#newWindowButton').click()`);
        const second = await driver.waitForNewHandle(before);
        await waitFor(second, `document.querySelector('.documentTitle')`, 'Second window did not finish loading.');

        // Independence: the new window starts blank regardless of what's loaded in the first
        // (the first window has an example loaded by this point in the suite).
        assert.equal(await evaluate(second, `document.querySelectorAll('.node-label-container').length`), 0);

        // Each project window gets its own auxiliary (Welcome) window. Auxiliary windows are not
        // parented to their project window (so either can be brought to the front without
        // minimizing the other), so each one is identified as the window that became a Welcome
        // window after its own openWelcome() call -- a project window reuses its guide window, so
        // that may be an existing window (e.g. an example guide opened earlier), not a new one.
        const welcomeHandles = async () => {
            const handles = [];
            for (const handle of driver.allHandles()) {
                if (!(await handle.isDestroyed()) && (await handle.title()).includes('Welcome')) handles.push(handle);
            }
            return handles;
        };
        const openWelcomeFrom = async (projectWindow) => {
            const existing = await welcomeHandles();
            await evaluate(projectWindow, `window.applicationInfo.openWelcome()`);
            const startedAt = Date.now();
            while (Date.now() - startedAt < 10000) {
                const opened = (await welcomeHandles()).find((handle) => !existing.includes(handle));
                if (opened) {
                    assert.equal(await opened.parent(), null, 'Auxiliary windows must not be parented to their project window.');
                    return opened;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error('openWelcome() did not open a Welcome window for its project window.');
        };
        const welcomeFromFirst = await openWelcomeFrom(window);
        const welcomeFromSecond = await openWelcomeFrom(second);
        assert.notEqual(welcomeFromFirst, welcomeFromSecond, 'Each project window should get its own Welcome window.');
        await closeWhenValidated(welcomeFromFirst);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.ok(!(await welcomeFromSecond.isDestroyed()), "Closing window A's Welcome window must not affect window B's.");
        await closeWhenValidated(welcomeFromSecond);

        // Closing a project window must not quit the app or affect the other window.
        await closeWhenValidated(second);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.ok(!(await window.isDestroyed()), 'Closing the second window destroyed the first.');
        assert.equal(await evaluate(window, `1 + 1`), 2, 'The first window is no longer responsive after the second closed.');
    }, { skip: !driver.capabilities.multiWindow && 'multi-window and per-window Welcome-window scoping have no web-edition equivalent' });

    await run('the Welcome page suggests tutorials not yet done and starts one, opens the whole list, and has nothing to dismiss', async () => {
        // An empty, saved project, so starting a tutorial asks nothing (as tutorialHelpers().clean() does further on).
        const clean = async () => {
            await putAwayLeftovers();
            if (await evaluate(window, `window.__debugTour.active()`)) await evaluate(window, `window.__debugTour.stop()`);
            const emptyDocument = { format: 'konjugate', version: 1, metadata: { units: 'SI' }, runConfigurations: [], sharedParameters: [], nodes: [], edges: [], subsystems: [], edgeGroups: [] };
            await evaluate(window, `window.__debugProject.load(${JSON.stringify(emptyDocument)}, 'welcome.kjt')`);
            await waitFor(window, `document.querySelector('.modelStatus')?.textContent.includes('0 nodes') && !window.__debugTour.blockers().dirty`, 'The empty project did not load.');
        };
        await clean();
        const openWelcome = async () => {
            const before = driver.allHandles();
            await evaluate(window, `window.applicationInfo.openWelcome()`);
            const welcomeWindow = await driver.waitForNewHandle(before, { titleIncludes: 'Welcome' });
            await waitFor(welcomeWindow, `Boolean(document.querySelector('[data-open-tutorials]'))`, 'The Welcome page did not show Learn by doing.');
            return welcomeWindow;
        };
        let welcomeWindow = await openWelcome();
        const page = await evaluate(welcomeWindow, `({
            headings: [...document.querySelectorAll('#content h2')].map((heading) => heading.textContent),
            suggested: [...document.querySelectorAll('[data-start-tutorial]')].map((button) => button.dataset.startTutorial),
            dismiss: document.querySelectorAll('[data-featured-dismiss], .featuredDismiss').length,
            tour: document.querySelectorAll('[data-start-tour]').length,
            onRampCard: [...document.querySelectorAll('.cardTitle')].some((title) => /^Konjugate On-Ramp: the \\d+-episode video series$/.test(title.textContent))
        })`);
        assert.ok(page.headings.includes('Learn by doing') && page.headings.includes('Watch'), `The sections are there: ${page.headings.join(', ')}.`);
        assert.ok(!page.headings.some((heading) => /On-Ramp/.test(heading)), 'The On-Ramp is no longer a section of its own.');
        assert.equal(page.onRampCard, true, 'The On-Ramp is one card under Watch.');
        assert.equal(page.dismiss, 0, 'Nothing on the page can be dismissed.');
        assert.equal(page.tour, 0, 'The tour is the first tutorial, not a card of its own.');
        const completed = await evaluate(window, `window.tutorials.completed()`);
        assert.ok(page.suggested.length <= 3, `At most three tutorials are suggested: ${page.suggested.join(', ')}.`);
        assert.ok(page.suggested.every((id) => !completed.includes(id)), `Only tutorials not yet done are suggested (done: ${completed.join(', ')}).`);
        // Run alone, or early in the suite, nothing is done yet; after the tutorial scenarios, everything may be.
        if (!page.suggested.length) assert.match(await evaluate(welcomeWindow, `document.querySelector('#content').textContent`), /You have done every tutorial/, 'With nothing left, the page says so.');

        // A video on the page can be remembered as opened; anything else is refused.
        assert.equal(await evaluate(welcomeWindow, `window.exampleGuide.markEpisodeOpened('eDHksSqKhFs')`), true);
        assert.equal(await evaluate(welcomeWindow, `window.exampleGuide.markEpisodeOpened('notAVideoId')`), false);

        // Start: the Welcome window gives way to the tutorial, in the project window.
        if (page.suggested.length) {
            await evaluate(welcomeWindow, `setTimeout(() => document.querySelector('[data-start-tutorial]').click(), 0)`);
            await waitFor(window, `window.__debugTour.tutorial() === ${JSON.stringify(page.suggested[0])}`, 'Start did not start the suggested tutorial.');
            assert.equal(await welcomeWindow.isDestroyed(), true, 'The Welcome window closed for the tutorial.');
            await evaluate(window, `window.__debugTour.stop()`);
            await clean();
            welcomeWindow = await openWelcome();
        }

        // See all: the whole Tutorials list, in the project window.
        await evaluate(welcomeWindow, `setTimeout(() => document.querySelector('[data-open-tutorials]').click(), 0)`);
        await waitFor(window, `document.querySelector('#tutorialsDialog').open`, 'See all tutorials did not open the Tutorials list.');
        assert.equal(await welcomeWindow.isDestroyed(), true, 'The Welcome window closed for the list.');
        await evaluate(window, `document.querySelector('#tutorialsClose').click()`);
        // Left as the scenarios around it expect it: the example the first scenario loaded.
        await freshExample();
    }, { skip: !driver.capabilities.multiWindow && 'the Welcome page is a window of its own on the desktop only' });

    await run('an OS-initiated file open reuses an already-open window on the same file, otherwise opens a new one', async () => {
        // Simulates exactly what a real double-click (or a relaunch's second-instance argv, on
        // Windows/Linux) drives main.mjs's own app.on('open-file', ...) listener to do -- no OS
        // automation needed, since main.mjs never distinguishes a real 'open-file' from this one.
        const examplePath = join(process.cwd(), 'examples', 'pumpSuctionHydraulics.kjt');

        const beforeFirstOpen = driver.allHandles();
        await driver.simulateOsFileOpen(examplePath);
        const opened = await driver.waitForNewHandle(beforeFirstOpen);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length > 0`, 'The OS-opened file did not load into the new window.');
        assert.equal(await evaluate(opened, `document.querySelector('.documentTitle').textContent`), 'pumpSuctionHydraulics');
        // Give the new window's pathChanged push time to reach main before re-opening the same path.
        await new Promise((resolve) => setTimeout(resolve, 300));

        const beforeSecondOpen = driver.allHandles();
        await driver.simulateOsFileOpen(examplePath);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(driver.allHandles(), beforeSecondOpen, 'Opening the same file again should focus the existing window, not open a duplicate.');
        await closeWhenValidated(opened);

        const beforeBadOpen = driver.allHandles();
        await driver.simulateOsFileOpen(join(process.cwd(), 'examples', 'doesNotExist.kjt'));
        const failedWindow = await driver.waitForNewHandle(beforeBadOpen);
        assert.ok(failedWindow, 'An OS-initiated open of a missing file did not open a window at all.');
        await waitFor(failedWindow, `document.querySelector('#statusText').textContent.startsWith('Load failed')`, 'A missing file did not surface a load-failed status instead of crashing.');
        await closeWhenValidated(failedWindow);
    }, { skip: !driver.capabilities.osFileOpen && 'OS-initiated file open has no web-edition equivalent' });

    await run('validation summary reports and displays a valid model', async () => {
        await settle(window, 'validation');
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`, 'C++ validation report did not reach the UI.');
        assert.equal(await evaluate(window, `document.querySelector('#validationSummary').classList.contains('error')`), false);
        await evaluate(window, `document.querySelector('#validationSummary').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#validationPanel').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#validationPanelTitle').textContent`), 'No issues');
        await evaluate(window, `document.querySelector('#closeValidationPanel').click()`);
    });

    await run('a newer model validation cancels the one it supersedes', async () => {
        const content = await decodeProjectFile(await readFile(join(process.cwd(), 'examples', 'heatedWaterTank.kjt')));
        const outcomes = await evaluate(window, `(async () => {
            const content = ${JSON.stringify(content)};
            const first = window.engine.validate(content, { supersede: 'interactionTest' });
            const second = window.engine.validate(content, { supersede: 'interactionTest' });
            return Promise.all([first, second]);
        })()`);
        assert.deepEqual(outcomes[0], { cancelled: true }, 'The superseded validation should report cancellation instead of a result.');
        assert.equal(outcomes[1].available, true);
        assert.equal(typeof outcomes[1].report.valid, 'boolean');
    }, { skip: !driver.capabilities.cancellableValidation && 'The web engine cannot cancel a validation in progress' });

    await run('with no model set up the assistant offers Settings, which finds Ollama, downloads the suggested model and uses it', async () => {
        await evaluate(window, `document.querySelector('#assistantButton').click()`);
        await waitFor(window, `document.querySelector('#assistantPanel').classList.contains('needsModel')`, 'The assistant did not say no model is set up.');
        assert.equal(await isRenderedVisible(window, '#assistantSetup'), true);
        assert.equal(await isRenderedVisible(window, '#assistantEmpty'), false);
        assert.equal(await evaluate(window, `document.querySelector('#assistantPrompt').disabled && document.querySelector('#generateAssistantProposal').disabled`), true, 'Nothing can be asked with no model.');
        assert.equal(await evaluate(window, `document.querySelector('#assistantConfiguration').disabled && document.querySelector('#assistantConfiguration').value === ''`), true, 'There is no model to choose.');

        // Ollama is asked where an Ollama configuration says it listens; here first somewhere nothing answers.
        const closedPort = await new Promise((resolve) => {
            const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
        });
        const elsewhere = await evaluate(window, `window.aiProviders.saveConfiguration({ name: 'Elsewhere', provider: 'ollama', endpoint: 'http://127.0.0.1:${closedPort}', model: 'none', timeoutSeconds: 60 })`);
        await evaluate(window, `document.querySelector('#assistantSetUpModel').click()`);
        await waitFor(window, `document.querySelector('#settingsDialog').open && !document.querySelector('[data-settings-page="assistant"]').hidden`, '"Set up a model…" did not open Settings › Model assistant.');
        await waitFor(window, `!document.querySelector('#localModelsMissing').hidden`, 'The page did not say Ollama is not running.');
        assert.equal(await evaluate(window, `document.querySelector('#localModelsState').dataset.state`), 'stopped');
        assert.equal(await isRenderedVisible(window, '#openOllamaPage'), true, 'The way to Ollama\'s website is offered.');
        assert.equal(await evaluate(window, `document.querySelector('#localModelsCards').hidden && document.querySelector('#huggingFaceBrowser').hidden`), true);
        assert.equal(await evaluate(window, `window.localModels.openPage('https://example.com/installer.pkg')`), false, 'Only Ollama\'s download page and a model\'s page are opened.');

        // Ollama starts (its configuration is pointed at the fake one), and Check again finds it.
        await evaluate(window, `window.aiProviders.saveConfiguration({ ...${JSON.stringify(elsewhere)}, endpoint: ${JSON.stringify(fakeOllama?.endpoint)} })`);
        await evaluate(window, `window.confirm = () => true; document.querySelector('#settingsClose').click()`);
        await waitFor(window, `!document.querySelector('#settingsDialog').open`, 'Settings did not close.');
        await evaluate(window, `document.querySelector('#manageAssistantConfigurations').click()`);
        await waitFor(window, `!document.querySelector('#localModelsCards').hidden`, 'The suggested models were not shown once Ollama was running.');
        assert.equal(await evaluate(window, `document.querySelector('#localModelsState').dataset.state`), 'running');
        assert.match(await evaluate(window, `document.querySelector('#localModelsState').textContent`), /0\.12\.0/, 'The version Ollama reports is shown.');
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.localModelCard')].map((card) => [card.dataset.localModel, card.querySelector('.localModelBadge').textContent, card.querySelector('.localModelAction button').textContent])`), [
            ['qwen3.5:4b', 'Recommended', 'Download'], ['qwen3.5:2b', 'For slower computers', 'Download']
        ]);

        // Download shows Ollama's progress, then Use it; Use it makes a configuration for it with reasoning off, in use.
        await evaluate(window, `document.querySelector('[data-local-model-download="qwen3.5:4b"]').click()`);
        await waitFor(window, `Boolean(document.querySelector('[data-local-model="qwen3.5:4b"] progress'))`, 'The download did not show its progress.');
        assert.ok(await evaluate(window, `Boolean(document.querySelector('[data-local-model-stop="qwen3.5:4b"]'))`), 'A download can be stopped.');
        await waitFor(window, `Boolean(document.querySelector('[data-local-model-use="qwen3.5:4b"]'))`, 'The downloaded model was not offered for use.', 10000);
        assert.equal(fakeOllama.requests.filter((request) => request.path === '/api/pull').at(-1).body.model, 'qwen3.5:4b', 'Ollama was asked to pull it.');
        await evaluate(window, `document.querySelector('[data-local-model-use="qwen3.5:4b"]').click()`);
        await waitFor(window, `document.querySelector('[data-local-model="qwen3.5:4b"] .localModelAction button')?.textContent === 'In use'`, 'Use it did not put the model in use.');
        const configurations = await evaluate(window, `window.aiProviders.listConfigurations()`);
        const qwen = configurations.configurations.find((configuration) => configuration.model === 'qwen3.5:4b');
        assert.deepEqual({ name: qwen.name, provider: qwen.provider, endpoint: qwen.endpoint, think: qwen.think }, { name: 'Qwen3.5 4B', provider: 'ollama', endpoint: fakeOllama.endpoint, think: false });
        assert.equal(configurations.activeConfigurationUuid, qwen.uuid);

        // The configurations are a list, the one in use marked; a row opens its configuration on a page of its own.
        assert.match(await evaluate(window, `document.querySelector('[data-configuration-uuid="${qwen.uuid}"]').textContent`), /Qwen3\.5 4B.*Ollama · qwen3\.5:4b.*In use/);
        assert.equal(await evaluate(window, `document.querySelector('#assistantConfigurationForm').hidden`), true, 'The list is shown, not a form.');
        await evaluate(window, `document.querySelector('[data-configuration-uuid="${qwen.uuid}"]').click()`);
        await waitFor(window, `!document.querySelector('#assistantConfigurationForm').hidden && document.querySelector('#assistantConfigurationName').value === 'Qwen3.5 4B'`, 'The configuration did not open.');
        // The reasoning setting, with what it was measured to cost.
        assert.equal(await isRenderedVisible(window, '#assistantThinkField'), true, 'Ollama can be told whether to reason.');
        assert.equal(await evaluate(window, `document.querySelector('#assistantConfigurationThink').value`), 'off');
        assert.equal(await evaluate(window, `document.querySelector('#assistantThinkNote').hidden`), true);
        await evaluate(window, `(() => { const select = document.querySelector('#assistantConfigurationThink'); select.value = 'on'; select.dispatchEvent(new Event('change')); })()`);
        assert.match(await evaluate(window, `document.querySelector('#assistantThinkNote').textContent`), /3½ to 10 minutes an answer with reasoning on, against about 20 seconds/);
        assert.equal(await evaluate(window, `document.querySelector('#assistantThinkNote').hidden`), false);
        await evaluate(window, `(() => { const select = document.querySelector('#assistantConfigurationThink'); select.value = 'off'; select.dispatchEvent(new Event('change')); })()`);
        // Discovering the models fills in the form, which is not a change: going back asks nothing.
        await new Promise((resolve) => setTimeout(resolve, 600));
        await evaluate(window, `window.__asked = 0; window.confirm = () => { window.__asked += 1; return false; }; document.querySelector('#assistantConfigurationBack').click()`);
        assert.equal(await evaluate(window, `window.__asked`), 0, 'Leaving a configuration nobody changed asked to discard changes.');
        assert.equal(await evaluate(window, `document.querySelector('#assistantConfigurationForm').hidden`), true, 'Back did not return to the list.');

        await evaluate(window, `window.aiProviders.removeConfiguration(${JSON.stringify(elsewhere.uuid)})`);
        await evaluate(window, `document.querySelector('#settingsClose').click()`);
        await waitFor(window, `!document.querySelector('#settingsDialog').open`, 'Settings did not close.');
        await evaluate(window, `document.querySelector('#closeAssistantPanel').click(); document.querySelector('#assistantButton').click()`);
        await waitFor(window, `!document.querySelector('#assistantPanel').classList.contains('needsModel') && document.querySelector('#assistantConfiguration').options.length === 1`, 'The assistant did not take the model set up.');
        assert.equal(await evaluate(window, `document.querySelector('#assistantPrompt').disabled`), false);
        await evaluate(window, `document.querySelector('#closeAssistantPanel').click()`);
    }, { skip: !driver.capabilities.aiAssistant && 'AI-assisted authoring has no web-edition equivalent yet' });

    await run('local assistant prepares, validates and applies one undoable transaction', async () => {
        await freshExample(); // the assistant's model is kept from the scenario before; the battery it edits is the example's
        await evaluate(window, `window.dispatchEvent(new Event('resize')); document.querySelector('#assistantButton').click(); (() => {
            const prompt = document.querySelector('#assistantPrompt');
            prompt.value = 'Add an ambient boundary at 298 K and connect it to the battery with a conductance of 15 W/K.';
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantButton').parentElement.classList.contains('windowControls')`), true);
        assert.ok(await evaluate(window, `Math.abs(document.querySelector('#assistantPanel').getBoundingClientRect().top - document.querySelector('#canvas').getBoundingClientRect().top - 10)`) < 2);
        assert.ok(await evaluate(window, `Math.abs(document.querySelector('#assistantPanel').getBoundingClientRect().right - (window.innerWidth - 10))`) < 2);
        await waitFor(window, `!document.querySelector('#applyAssistantProposal').disabled`, 'The local assistant proposal was not ready to apply.');
        await waitFor(window, `document.querySelector('#assistantConfiguration').options.length === 1`, 'Assistant configurations did not load through the main process.');
        assert.match(await evaluate(window, `document.querySelector('#assistantConfiguration').selectedOptions[0].textContent`), /Qwen3\.5 4B · Local/);
        assert.equal(await evaluate(window, `typeof window.aiProviders.getCredential`), 'undefined');
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container').length`), 3);
        assert.equal(await evaluate(window, `!document.querySelector('#assistantPanel').hidden && !document.querySelector('#applyAssistantProposal').disabled`), true);
        assert.match(await evaluate(window, `document.querySelector('#assistantProposalStatus').textContent`), /Native validation passed/);
        assert.match(await evaluate(window, `document.querySelector('#assistantProposalSummary').textContent`), /Battery module/);
        assert.equal(await evaluate(window, `document.querySelector('#generateAssistantProposal').textContent`), 'Revise proposal');
        await evaluate(window, `document.querySelector('#collapseAssistantPanel').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantPanel').classList.contains('collapsed')`), true);
        assert.match(await evaluate(window, `document.querySelector('#assistantCollapsedStatus').textContent`), /Proposal ready/);
        await evaluate(window, `document.querySelector('#collapseAssistantPanel').click()`);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#assistantPanel').hidden && !document.querySelector('#nodeEditor').classList.contains('hidden')`), true);
        await waitFor(window, `document.querySelector('#assistantPanel').getBoundingClientRect().right <= document.querySelector('#nodeEditor').getBoundingClientRect().left`, 'Assistant did not move beside the model inspector.');
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);
        assert.equal(await evaluate(window, `window.konjugateAssistant.applyProposal()`), true);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((label) => label.textContent.includes('Ambient boundary'))`, 'Applied assistant node did not appear on the canvas.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 3`, 'Undo did not restore the original canvas.');
        await evaluate(window, `document.querySelector('#redoButton').click()`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 4`, 'Redo did not restore the assistant proposal.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 3`, 'Undo did not restore the model before testing an assistant update.');
        await evaluate(window, `document.querySelector('#assistantButton').click(); (() => {
            document.querySelector('#assistantPrompt').value = 'Set the battery initial temperature to 325 K.';
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        await waitFor(window, `!document.querySelector('#applyAssistantProposal').disabled`, 'The assistant update proposal was not ready.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.assistantChange.update').length`), 1);
        assert.match(await evaluate(window, `document.querySelector('.assistantChange dd').textContent`), /353\.2 → 325/);
        await evaluate(window, `document.querySelector('.assistantChange button').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#nodeEditor').classList.contains('hidden') && !document.querySelector('#assistantPanel').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeName').value`), 'Battery module');
        await evaluate(window, `document.querySelector('#discardAssistantProposal').click(); document.querySelector('#nodeEditor [data-close-card]').click(); document.querySelector('#closeAssistantPanel').click()`);
    }, { skip: !driver.capabilities.aiAssistant && 'AI-assisted authoring has no web-edition equivalent yet' });

    await run('local assistant can disable and enable a node and a relationship', async () => {
        const nodeLabel = `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module') && !label.textContent.includes('copy'))`;
        await evaluate(window, `document.querySelector('#assistantButton').click(); (() => {
            document.querySelector('#assistantPrompt').value = 'Disable the battery module.';
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        await waitFor(window, `!document.querySelector('#applyAssistantProposal').disabled`, 'The disable-node proposal was not ready.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.assistantChange.update').length`), 1);
        assert.match(await evaluate(window, `document.querySelector('.assistantChange dd').textContent`), /true → false/);
        assert.equal(await evaluate(window, `window.konjugateAssistant.applyProposal()`), true);
        // `?.` throughout: a plain top-level thrown exception during a polled evaluate() (not one
        // swallowed inside a click listener) surfaces from Electron as an opaque "Script failed to
        // execute" IPC error with no message, so a transient re-render leaving .find() briefly
        // unmatched would otherwise crash the whole test run rather than just failing one waitFor.
        await waitFor(window, `${nodeLabel}?.closest('.node-label-container').classList.contains('disabled')`, 'The assistant-applied node disable did not render.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await waitFor(window, `${nodeLabel}?.closest('.node-label-container').classList.contains('disabled') === false`, 'Undo did not restore the assistant-applied node disable.');

        await evaluate(window, `document.querySelector('#assistantButton').click(); (() => {
            document.querySelector('#assistantPrompt').value = 'Disable the Heat source relationship.';
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        await waitFor(window, `!document.querySelector('#applyAssistantProposal').disabled`, 'The disable-edge proposal was not ready.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.assistantChange.update').length`), 1);
        assert.match(await evaluate(window, `document.querySelector('.assistantChange dd').textContent`), /true → false/);
        assert.equal(await evaluate(window, `window.konjugateAssistant.applyProposal()`), true);
        await waitFor(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Electrical losses'))?.textContent.includes('Disabled')`, 'The assistant-applied edge disable did not render.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await waitFor(window, `![...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Electrical losses'))?.textContent.includes('Disabled')`, 'Undo did not restore the assistant-applied edge disable.');
        await evaluate(window, `document.querySelector('#closeAssistantPanel').click()`);
    }, { skip: !driver.capabilities.aiAssistant && 'AI-assisted authoring has no web-edition equivalent yet' });

    await run('local assistant asks a clarifying question for an ambiguous request and resolves it from a suggestion', async () => {
        await evaluate(window, `document.querySelector('#assistantButton').click()`);
        // Reset first: earlier assistant tests in this suite already left turns in the bounded
        // conversation history (it deliberately survives an apply/discard/panel close, only an
        // explicit reset clears it), and this test wants a known, empty starting transcript.
        await evaluate(window, `window.konjugateAssistant.resetConversation()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantTranscript').hidden`), true);

        const temperatureNodeNames = await evaluate(window, `window.konjugateAssistant.getModelSummary().nodes
            .filter((node) => node.states.some((state) => state.symbol === 'temperature' || state.name.toLowerCase().includes('temperature')))
            .map((node) => node.name)`);
        assert.ok(temperatureNodeNames.length >= 2, `Expected at least two temperature-bearing nodes, found: ${temperatureNodeNames.join(', ')}`);

        await evaluate(window, `(() => {
            document.querySelector('#assistantPrompt').value = 'Set the temperature to 310 K.';
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        await waitFor(window, `!document.querySelector('#assistantClarification').hidden`, 'The assistant did not ask a clarifying question for an ambiguous request.');
        assert.equal(await evaluate(window, `document.querySelector('#assistantPrompt').value`), '', 'The prompt should be cleared once a response has arrived.');
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#assistantEmpty')).display`), 'none', "The empty-state placeholder must not render behind the clarification (regression: .assistantEmpty's own display:grid was overriding [hidden]).");
        assert.equal(await evaluate(window, `document.querySelector('#generateAssistantProposal').textContent`), 'Answer');
        assert.match(await evaluate(window, `document.querySelector('#assistantClarificationQuestion').textContent`), /which node/i);
        const suggestionTexts = await evaluate(window, `[...document.querySelectorAll('.assistantClarificationOption')].map((button) => button.textContent)`);
        assert.deepEqual([...suggestionTexts].sort(), [...temperatureNodeNames].sort());
        assert.equal(await evaluate(window, `document.querySelectorAll('.assistantTranscriptTurn').length`), 1);
        assert.match(await evaluate(window, `document.querySelector('.assistantTranscriptOutcome').textContent`), /Asked:/);

        // Clicking a suggestion must only prefill the prompt, never submit it on its own.
        const firstSuggestion = await evaluate(window, `document.querySelector('.assistantClarificationOption').textContent`);
        await evaluate(window, `document.querySelector('.assistantClarificationOption').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantPrompt').value`), firstSuggestion);
        assert.equal(await evaluate(window, `document.querySelector('#assistantClarification').hidden`), false);

        await evaluate(window, `(() => {
            document.querySelector('#assistantPrompt').value = ${JSON.stringify(`${firstSuggestion}, 310 K`)};
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        await waitFor(window, `!document.querySelector('#applyAssistantProposal').disabled`, 'The clarification reply did not resolve into an appliable proposal.');
        assert.match(await evaluate(window, `document.querySelector('#assistantProposalSummary').textContent`), new RegExp(firstSuggestion));
        assert.equal(await evaluate(window, `document.querySelectorAll('.assistantTranscriptTurn').length`), 2);
        assert.match(await evaluate(window, `document.querySelectorAll('.assistantTranscriptOutcome')[1].textContent`), /Proposed:/);

        assert.equal(await evaluate(window, `window.konjugateAssistant.applyProposal()`), true);
        await waitFor(window, `document.querySelectorAll('.assistantTranscriptOutcome')[1]?.textContent.includes('Applied:')`, 'Applying did not update the transcript turn in place.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.assistantTranscriptTurn').length`), 2, 'Applying should update the existing turn, not add a new one.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#closeAssistantPanel').click()`);
    }, { skip: !driver.capabilities.aiAssistant && 'AI-assisted authoring has no web-edition equivalent yet' });

    await run('dismissing a clarification and starting a new conversation both clear it without submitting', async () => {
        await evaluate(window, `document.querySelector('#assistantButton').click()`);
        await evaluate(window, `window.konjugateAssistant.resetConversation()`);
        const temperatureNodeNames = await evaluate(window, `window.konjugateAssistant.getModelSummary().nodes
            .filter((node) => node.states.some((state) => state.symbol === 'temperature' || state.name.toLowerCase().includes('temperature')))
            .map((node) => node.name)`);
        assert.ok(temperatureNodeNames.length >= 2, `Expected at least two temperature-bearing nodes, found: ${temperatureNodeNames.join(', ')}`);

        await evaluate(window, `(() => {
            document.querySelector('#assistantPrompt').value = 'Set the temperature to 310 K.';
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        await waitFor(window, `!document.querySelector('#assistantClarification').hidden`, 'The assistant did not ask a clarifying question.');
        assert.equal(await evaluate(window, `document.querySelector('#assistantPrompt').value`), '', 'The prompt should be cleared once a response (a clarifying question) has arrived.');
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#assistantEmpty')).display`), 'none', "The empty-state placeholder must not render behind the clarification (regression: .assistantEmpty's own display:grid was overriding [hidden]).");
        assert.equal(await evaluate(window, `document.querySelector('#generateAssistantProposal').textContent`), 'Answer');
        await evaluate(window, `document.querySelector('#dismissAssistantClarification').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantClarification').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#assistantEmpty').hidden`), false);
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#assistantEmpty')).display`), 'grid');
        assert.equal(await evaluate(window, `document.querySelector('#generateAssistantProposal').textContent`), 'Generate proposal');
        assert.match(await evaluate(window, `document.querySelector('.assistantTranscriptOutcome').textContent`), /did not answer/i);
        assert.equal(await evaluate(window, `window.konjugateAssistant.getTurnHistory().length`), 1);

        // There's a turn in history to lose, so this must ask for confirmation first.
        await evaluate(window, `window.confirm = () => true; document.querySelector('#newAssistantConversation').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantTranscript').hidden`), true);
        assert.equal(await evaluate(window, `window.konjugateAssistant.getTurnHistory().length`), 0);

        // Nothing left to lose now -- clicking it again must not block on a confirmation dialog
        // (this call deliberately does not stub window.confirm, so it would hang/timeout if the
        // implementation asked for confirmation here).
        await evaluate(window, `document.querySelector('#newAssistantConversation').click()`);
        await evaluate(window, `document.querySelector('#closeAssistantPanel').click()`);
    }, { skip: !driver.capabilities.aiAssistant && 'AI-assisted authoring has no web-edition equivalent yet' });

    await run('model configurations expose all provider adapters without renderer credential access', async () => {
        await evaluate(window, `document.querySelector('#assistantButton').click(); document.querySelector('#manageAssistantConfigurations').click()`);
        await waitFor(window, `document.querySelector('#settingsDialog').open && !document.querySelector('[data-settings-page="assistant"]').hidden`, 'The assistant\'s ⚙ did not open Settings › Model assistant.');
        assert.equal(await evaluate(window, `document.querySelector('#settingsPageTitle').textContent`), 'Model assistant');
        assert.deepEqual(await evaluate(window, `[...document.querySelector('#assistantConfigurationProvider').options].map((option) => option.value)`), [
            'ollama', 'openAi', 'nvidia', 'huggingFace', 'gemini'
        ]);
        await evaluate(window, `document.querySelector('#newAssistantConfiguration').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantCredentialField').hidden`), true);
        await evaluate(window, `(() => {
            document.querySelector('#assistantConfigurationName').value = 'Interaction Ollama';
            document.querySelector('#assistantConfigurationModel').value = '__custom__';
            document.querySelector('#assistantCustomModel').value = 'test-model';
            document.querySelector('#assistantConfigurationForm').requestSubmit();
        })()`);
        await waitFor(window, `[...document.querySelectorAll('#assistantConfiguration option')].some((option) => option.textContent.includes('Interaction Ollama'))`, 'Saved Ollama configuration did not appear.');
        assert.equal(await evaluate(window, `document.querySelector('#settingsDialog').open`), true, 'Saving a configuration closed Settings.');
        assert.equal(await evaluate(window, `[...document.querySelectorAll('#assistantConfigurationList button')].some((button) => button.textContent.includes('Interaction Ollama'))`), true);
        assert.equal(await evaluate(window, `document.querySelector('#assistantConfigurationUuid').value.length > 0`), true);
        await evaluate(window, `window.confirm = () => true; document.querySelector('#deleteAssistantConfiguration').click()`);
        await waitFor(window, `document.querySelectorAll('#assistantConfiguration option').length === 1`, 'Deleted configuration remained available.');
        await evaluate(window, `document.querySelector('#settingsClose').click()`);
        await waitFor(window, `!document.querySelector('#settingsDialog').open`, 'Settings did not close.');
        await evaluate(window, `document.querySelector('#closeAssistantPanel').click()`);
    }, { skip: !driver.capabilities.aiProviderCredentials && 'the credential-vault/provider-adapter architecture (window.aiProviders) has no web-edition equivalent' });

    await run('run configuration and node substeps are editable', async () => {
        await freshExample();
        // The numerics and execution settings live in the Run dialog; "Save settings" stores them with the
        // model without starting a run.
        await waitFor(window, `!document.querySelector('#runButton').disabled`, 'Run was not available to open the run settings.', 10000);
        await openRunDialog(window);
        assert.equal(await evaluate(window, `document.querySelector('#runExecutionBackend').value`), 'automatic');
        assert.equal(await evaluate(window, `document.querySelector('#runExecutionAdvanced').open`), false);
        await evaluate(window, `(() => {
            document.querySelector('#runGlobalTimeStep').value = '0.02';
            document.querySelector('#runOutputInterval').value = '0.1';
            document.querySelector('#runWorkerThreads').value = '2';
            document.querySelector('#runPartitionAlgorithm').value = 'automatic';
            document.querySelector('#runPartitionCount').value = '2';
            document.querySelector('#runPartitionCommunicationBias').value = '4';
            document.querySelector('#saveRunConfiguration').click();
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#runLaunchDialog').open`), false);
        assert.equal(await evaluate(window, `document.querySelectorAll('#runPartitionAlgorithm option').length`), 3);
        // Applying the run configuration revalidates the model, which can rebuild the canvas labels: wait for
        // the node's label, then for its editor, rather than assuming both are there at once.
        const batteryLabel = `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module'))`;
        await waitFor(window, `Boolean(${batteryLabel})`, 'The Battery module label was not on the canvas.');
        await evaluate(window, `${batteryLabel}.click()`);
        await waitFor(window, `Boolean(document.querySelector('[data-editor-tab="numerics"]')) && !document.querySelector('#nodeEditor').classList.contains('hidden')`, 'The node editor did not open.');
        await evaluate(window, `document.querySelector('[data-editor-tab="numerics"]').click()`);
        await waitFor(window, `document.querySelector('#editNodeSubsteps').offsetParent !== null`, 'The numerics tab did not open.');
        await evaluate(window, `(() => { const input = document.querySelector('#editNodeSubsteps'); input.value = '2'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeSubsteps').value`), '2');
        assert.match(await evaluate(window, `document.querySelector('#nodeEffectiveTimeStep').textContent`), /0\.01/);
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);
        await settle(window, 'validation');
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`, 'Updated numerical settings were not validated.');
    });

    await run('Settings is a sheet of pages: opened with ⌘, or Ctrl+,, searched, General\'s interface size, and the Extensions Explorer on a titlebar button of its own', async () => {
        const visiblePage = () => evaluate(window, `[...document.querySelectorAll('[data-settings-page]')].filter((page) => !page.hidden).map((page) => page.dataset.settingsPage)`);
        const sidebar = () => evaluate(window, `[...document.querySelectorAll('#settingsSidebarList .settingsSidebarItem')].map((item) => item.textContent.trim())`);
        // The shortcut every application's settings have; metaKey and ctrlKey together answer on any platform.
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }))`);
        await waitFor(window, `document.querySelector('#settingsDialog').open`, 'The shortcut did not open Settings.');
        // Push service only where the app can listen on a port: the desktop, not a web page.
        const pages = ['General', 'Model assistant', 'Providers', 'Controllers', ...(driver.kind === 'electron' ? ['Push service'] : []), 'New projects'];
        assert.deepEqual(await sidebar(), pages);
        assert.equal(await evaluate(window, `document.querySelectorAll('#settingsSidebarList .settingsSidebarIcon svg path').length`), pages.length, 'Each page has a drawn icon.');
        // It opens where it was last (General the first time); General is chosen here, as a click in the sidebar chooses a page.
        await evaluate(window, `document.querySelector('[data-settings-target="general"]').click()`);
        assert.deepEqual(await visiblePage(), ['general']);
        assert.equal(await evaluate(window, `document.querySelector('[data-settings-target="general"]').getAttribute('aria-selected')`), 'true');
        await waitFor(window, `/^\\d+\\.\\d+\\.\\d+/.test(document.querySelector('#settingsVersion').textContent)`, 'General did not show the version.');

        // The interface size, as A− and A+ set it in the titlebar: both follow one another.
        const zoom = async () => Number.parseInt(await evaluate(window, `document.querySelector('#settingsZoomValue').textContent`), 10);
        await evaluate(window, `document.querySelector('#settingsZoomReset').click()`);
        assert.equal(await zoom(), 100);
        assert.equal(await evaluate(window, `document.querySelector('#settingsZoomReset').disabled`), true, 'Actual size is offered at actual size.');
        await evaluate(window, `document.querySelector('#settingsZoomIn').click()`);
        assert.equal(await zoom(), 110);
        assert.equal(await evaluate(window, `document.querySelector('#zoomInButton').dataset.tooltip`), 'Zoom interface in · 110%', 'The titlebar does not follow Settings.');
        await evaluate(window, `document.querySelector('#zoomOutButton').click()`);
        assert.equal(await zoom(), 100, 'Settings does not follow the titlebar.');

        // A search narrows the pages, by what a page is about as well as its title; Enter opens the first.
        const search = (text) => evaluate(window, `(() => { const field = document.querySelector('#settingsSearch'); field.value = ${JSON.stringify(text)}; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await search('midi');
        assert.deepEqual(await sidebar(), ['Controllers']);
        await evaluate(window, `document.querySelector('#settingsSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
        await waitFor(window, `!document.querySelector('[data-settings-page="controllers"]').hidden && document.querySelector('#settingsPageTitle').textContent === 'Controllers'`, 'Enter did not open the page found.');
        await search('nothing like this');
        assert.equal(await isRenderedVisible(window, '#settingsSearchEmpty'), true);
        await search('');
        assert.equal((await sidebar()).length, pages.length);

        // Closed and opened again, it opens where it was.
        await evaluate(window, `document.querySelector('#settingsClose').click()`);
        await waitFor(window, `!document.querySelector('#settingsDialog').open`, 'Settings did not close.');
        await evaluate(window, `document.querySelector('#settingsButton').click()`);
        await waitFor(window, `document.querySelector('#settingsDialog').open`, 'Settings did not open again.');
        assert.deepEqual(await visiblePage(), ['controllers'], 'Settings did not open on the page it was last on.');

        // Escape closes it, as a dialog closes.
        await evaluate(window, `document.querySelector('#settingsDialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
        await waitFor(window, `!document.querySelector('#settingsDialog').open`, 'Escape did not close Settings.');

        // The Extensions Explorer is its own dialog, with a button of its own in the titlebar beside Settings, as well as the rail's.
        assert.equal(await isRenderedVisible(window, '#extensionsTitleButton'), true);
        await evaluate(window, `document.querySelector('#extensionsTitleButton').click()`);
        await waitFor(window, `document.querySelector('#extensionsDialog').open && !document.querySelector('#settingsDialog').open`, 'The titlebar\'s Extensions button did not open the Explorer.');
        await evaluate(window, `document.querySelector('#extensionsDialog').close()`);
    });

    await run('an update to an installed extension is shown on both Extensions buttons, the rail\'s and the titlebar\'s, and goes when there is none', async () => {
        // The registry's answer, replaced for this test: one installed package with a newer release. Opening the Explorer asks again.
        const answer = (updates) => evaluate(window, `(() => { window.__realCheckUpdates ??= window.extensions.checkUpdates; window.extensions.checkUpdates = async () => (${JSON.stringify(updates)}); })()`);
        const badges = () => evaluate(window, `({
            rail: document.querySelector('#extensionsUpdateBadge').hidden ? null : document.querySelector('#extensionsUpdateBadge').textContent,
            title: document.querySelector('#extensionsTitleBadge').hidden ? null : document.querySelector('#extensionsTitleBadge').textContent,
            railLabel: document.querySelector('#extensionsButton').getAttribute('aria-label'),
            titleLabel: document.querySelector('#extensionsTitleButton').getAttribute('aria-label'),
            titleTooltip: document.querySelector('#extensionsTitleButton').dataset.tooltip
        })`);
        const openAndClose = async () => {
            await evaluate(window, `document.querySelector('#extensionsTitleButton').click()`);
            await waitFor(window, `document.querySelector('#extensionsDialog').open`, 'The Explorer did not open.');
            await evaluate(window, `document.querySelector('#extensionsDialog').close()`);
        };
        await answer([{ prefix: 'interaction.example', outdated: [{ packageId: 'interaction.example.one', installed: '1.0.0', latest: '1.1.0' }, { packageId: 'interaction.example.two', installed: '2.0.0', latest: '2.1.0' }] }]);
        await openAndClose();
        await waitFor(window, `!document.querySelector('#extensionsTitleBadge').hidden`, 'The titlebar\'s Extensions button did not show the updates.');
        assert.deepEqual(await badges(), {
            rail: '2', title: '2', railLabel: 'Manage extensions (2 updates available)',
            titleLabel: 'Extensions (2 updates available)', titleTooltip: 'Extensions · 2 updates available'
        });
        // Nothing to update: both badges go.
        await answer([]);
        await openAndClose();
        await waitFor(window, `document.querySelector('#extensionsTitleBadge').hidden && document.querySelector('#extensionsUpdateBadge').hidden`, 'The badges stayed with no update.');
        assert.equal((await badges()).titleTooltip, 'Extensions');
        await evaluate(window, `window.extensions.checkUpdates = window.__realCheckUpdates; delete window.__realCheckUpdates;`);
    }, { skip: driver.kind !== 'playwright' && 'the desktop\'s window.extensions is the preload\'s, which a test cannot replace; the web edition\'s runs the same badge code' });

    await run('Extensions: Discover lists the registry by domain, shows an entry and installs it; installed packages are updated one at a time or all together', async () => {
        // The registry is this site's own copy, read for real. What is installed, what has an update and what installing does are
        // stood in for (the web edition's window.extensions can be replaced; the desktop's is the preload's): the packages themselves
        // are not on a local build's copy, and an update needs a release newer than what is installed.
        const registry = JSON.parse(await readFile(join(process.cwd(), 'out', 'webShellThreads', 'registry', 'index.json'), 'utf8'));
        const listed = Object.entries(registry.prefixes).filter(([, entry]) => entry.packages?.length && entry.downloadUrl);
        const installedPackage = (packageId, name, version) => ({ packageType: 'addon', packageId, name, version, source: 'installed', permissions: [], manifest: {}, installPath: null, enabled: true });
        await evaluate(window, `(() => {
            window.__realExtensions = { list: window.extensions.list, checkUpdates: window.extensions.checkUpdates, installFromRegistry: window.extensions.installFromRegistry };
            window.__fakeInstalled = ${JSON.stringify([
                installedPackage('konjugate.helloWorld', 'Hello World', '1.0.0'),
                installedPackage('konjugate.resultPlotViewer', 'Results Analysis', '1.0.0'),
                { ...installedPackage('konjugate.fintech.engine', 'Fintech Engine', '1.0.0'), packageType: 'plugin' }
            ])};
            window.__updates = [];
            window.__installCalls = [];
            window.__installAnswer = () => [];
            window.extensions.list = async () => [...await window.__realExtensions.list(), ...window.__fakeInstalled];
            window.extensions.checkUpdates = async () => structuredClone(window.__updates);
            window.extensions.installFromRegistry = async (entry) => { window.__installCalls.push(entry.prefix); return window.__installAnswer(entry); };
        })()`);
        const notice = () => evaluate(window, `document.querySelector('#extensionsRestartNotice').textContent`);
        const openExplorer = async (mode) => {
            if (await evaluate(window, `document.querySelector('#extensionsDialog').open`)) await evaluate(window, `document.querySelector('#extensionsDialog').close()`);
            await evaluate(window, `document.querySelector('#extensionsTitleButton').click()`);
            await waitFor(window, `document.querySelector('#extensionsDialog').open`, 'The Explorer did not open.');
            await evaluate(window, `document.querySelector('.extensionsTab[data-extensions-mode="${mode}"]').click()`);
        };
        try {
            // Discover: every entry that offers something to install, and its domains as filters.
            await openExplorer('discover');
            await waitFor(window, `document.querySelectorAll('#extensionsResults .discoverItem').length === ${listed.length}`, 'Discover did not list the registry.', 10000);
            const domains = [...new Set(listed.map(([, entry]) => entry.domain).filter(Boolean))];
            assert.equal(await evaluate(window, `document.querySelectorAll('#extensionsDomains button').length`), domains.length + 1, 'All, then one filter per domain.');
            const robotics = listed.filter(([, entry]) => entry.domain === 'robotics').map(([prefix]) => prefix).sort();
            await evaluate(window, `document.querySelectorAll('#extensionsDomains button')[${domains.indexOf('robotics') + 1}].click()`);
            assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('#extensionsResults .discoverItem')].map((item) => item.dataset.discoverPrefix).sort()`), robotics);
            await evaluate(window, `document.querySelectorAll('#extensionsDomains button')[0].click()`);
            assert.equal(await evaluate(window, `document.querySelectorAll('#extensionsResults .discoverItem').length`), listed.length);

            // An entry's detail: what it is, its packages, its screenshot, and whether it is installed.
            const select = (prefix) => evaluate(window, `document.querySelector('#extensionsResults .discoverItem[data-discover-prefix="${prefix}"]').click()`);
            const pose = registry.prefixes['konjugate.poseVisualizer'];
            await select('konjugate.poseVisualizer');
            await waitFor(window, `!document.querySelector('#extensionsDiscoverDetailContent').hidden`, 'The entry\'s detail did not open.');
            assert.equal(await evaluate(window, `document.querySelector('#extensionsDiscoverDetailTitle').textContent`), pose.title);
            assert.equal(await evaluate(window, `document.querySelectorAll('#extensionsDiscoverDetailPackages li').length`), pose.packages.length);
            assert.equal(await evaluate(window, `document.querySelector('#extensionsDiscoverInstall').disabled`), false);
            await waitFor(window, `[...document.querySelectorAll('#extensionsDiscoverScreenshots figure')].some((figure) => !figure.hidden && figure.querySelector('img').src.startsWith('data:'))`, 'The entry\'s screenshot was not shown.', 10000);
            await select('konjugate.helloWorld');
            await waitFor(window, `document.querySelector('#extensionsDiscoverInstall').disabled && !document.querySelector('#extensionsDiscoverDetailStatus').hidden`, 'An installed entry was offered to install again.');
            await select('konjugate.fintech');
            await waitFor(window, `/1 of 2/.test(document.querySelector('#extensionsDiscoverDetailStatus').textContent) && !document.querySelector('#extensionsDiscoverInstall').disabled`, 'A bundle with one of its two packages installed was not shown as partly installed.');

            // Installed from the registry, with what the publisher check found; and a failed install said, with the button back.
            await select('konjugate.poseVisualizer');
            await evaluate(window, `window.__installAnswer = () => [{ packageType: 'addon', packageId: 'konjugate.poseVisualizer', version: '1.0.6', verification: { status: 'verified' } }]`);
            await evaluate(window, `document.querySelector('#extensionsDiscoverInstall').click()`);
            await waitFor(window, `/^Installed konjugate\\.poseVisualizer 1\\.0\\.6 \\(verified\\)/.test(document.querySelector('#extensionsRestartNotice').textContent)`, 'Installing from Discover was not reported.');
            assert.deepEqual(await evaluate(window, `window.__installCalls`), ['konjugate.poseVisualizer'], 'The selected entry, and only it, is installed.');
            await evaluate(window, `window.__installAnswer = () => { throw new Error('The download did not match the size the registry recorded.'); }`);
            await evaluate(window, `document.querySelector('#extensionsDiscoverInstall').click()`);
            await waitFor(window, `/^Installation failed: The download did not match/.test(document.querySelector('#extensionsRestartNotice').textContent)`, 'A failed install was not reported.');
            assert.equal(await evaluate(window, `document.querySelector('#extensionsDiscoverInstall').disabled`), false, 'The button is usable again after a failure.');

            // Two installed packages with newer releases: listed under Updates.
            const updatesFor = (...prefixes) => evaluate(window, `window.__updates = ${JSON.stringify([
                { prefix: 'konjugate.helloWorld', latestVersion: '1.1.0', outdated: [{ packageId: 'konjugate.helloWorld', installedVersion: '1.0.0' }] },
                { prefix: 'konjugate.resultPlotViewer', latestVersion: '2.0.0', outdated: [{ packageId: 'konjugate.resultPlotViewer', installedVersion: '1.0.0' }] }
            ])}.filter((update) => ${JSON.stringify(prefixes)}.includes(update.prefix))`);
            // An install of an entry moves its stand-in package to `version`, and the update it answered goes.
            const installAs = (versions) => evaluate(window, `window.__installAnswer = (entry) => {
                const answer = ${JSON.stringify(versions)}[entry.prefix];
                if (answer instanceof Object && answer.error) throw new Error(answer.error);
                const packageId = entry.packages[0].packageId;
                window.__fakeInstalled.find((item) => item.packageId === packageId).version = answer;
                window.__updates = window.__updates.filter((update) => update.prefix !== entry.prefix || answer !== update.latestVersion);
                return [{ packageType: 'addon', packageId, version: answer, verification: { status: 'verified' } }];
            }`);
            await updatesFor('konjugate.helloWorld', 'konjugate.resultPlotViewer');
            await openExplorer('installed');
            await waitFor(window, `!document.querySelector('#extensionsUpdatesShow').hidden`, 'The Explorer did not offer the updates.');
            await evaluate(window, `document.querySelector('#extensionsUpdatesShow').click()`);
            await waitFor(window, `document.querySelectorAll('#extensionsResults [data-package-key]').length === 2`, 'Updates did not list the two outdated packages.');

            // One updated from its detail: kept selected at its new version.
            await evaluate(window, `window.__installCalls = []`);
            await installAs({ 'konjugate.helloWorld': '1.1.0' });
            await evaluate(window, `document.querySelector('#extensionsResults [data-package-key="addon:konjugate.helloWorld:1.0.0"]').click()`);
            await waitFor(window, `!document.querySelector('#extensionsUpdate').hidden && !document.querySelector('#extensionsUpdate').disabled`, 'Update was not offered for the outdated package.');
            await evaluate(window, `document.querySelector('#extensionsUpdate').click()`);
            await waitFor(window, `/^Updated konjugate\\.helloWorld 1\\.1\\.0/.test(document.querySelector('#extensionsRestartNotice').textContent)`, 'The update was not reported.');
            assert.deepEqual(await evaluate(window, `window.__installCalls`), ['konjugate.helloWorld']);
            assert.equal(await evaluate(window, `document.querySelector('#extensionsDetailVersion').textContent`), '1.1.0', 'The package stays selected, at its new version.');

            // A release tagged newer whose package is still the old version: said plainly, not claimed as an update.
            await installAs({ 'konjugate.resultPlotViewer': '1.0.0' });
            await evaluate(window, `document.querySelector('#extensionsResults [data-package-key="addon:konjugate.resultPlotViewer:1.0.0"]')?.click()`);
            await waitFor(window, `!document.querySelector('#extensionsUpdate').hidden && !document.querySelector('#extensionsUpdate').disabled`, 'Update was not offered for the second package.');
            await evaluate(window, `document.querySelector('#extensionsUpdate').click()`);
            await waitFor(window, `/nothing was actually updated/.test(document.querySelector('#extensionsRestartNotice').textContent)`, 'A release that did not change the version was reported as an update.');

            // Update all: each entry in turn, one failure said and the others still done.
            for (const item of ['konjugate.helloWorld', 'konjugate.resultPlotViewer']) await evaluate(window, `window.__fakeInstalled.find((entry) => entry.packageId === ${JSON.stringify(item)}).version = '1.0.0'`);
            await updatesFor('konjugate.helloWorld', 'konjugate.resultPlotViewer');
            await evaluate(window, `window.__installCalls = []`);
            await installAs({ 'konjugate.helloWorld': '1.1.0', 'konjugate.resultPlotViewer': { error: 'The release has no package for this platform.' } });
            await openExplorer('installed');
            await waitFor(window, `!document.querySelector('#extensionsUpdateAll').hidden && !document.querySelector('#extensionsUpdateAll').disabled`, 'Update all was not offered.');
            await evaluate(window, `document.querySelector('#extensionsUpdateAll').click()`);
            await waitFor(window, `/Could not update konjugate\\.resultPlotViewer/.test(document.querySelector('#extensionsRestartNotice').textContent)`, 'Update all did not report its outcome.', 10000);
            const told = await notice();
            assert.match(told, /^Updated konjugate\.helloWorld 1\.1\.0\./, 'The one that worked is said to be updated.');
            assert.match(told, /Could not update konjugate\.resultPlotViewer: The release has no package for this platform\./);
            assert.deepEqual((await evaluate(window, `window.__installCalls`)).sort(), ['konjugate.helloWorld', 'konjugate.resultPlotViewer']);
            assert.equal(await evaluate(window, `document.querySelector('#extensionsUpdateAll').textContent`), 'Update all', 'The button is itself again once done.');
        } finally {
            await evaluate(window, `(() => {
                if (window.__realExtensions) Object.assign(window.extensions, window.__realExtensions);
                for (const name of ['__realExtensions', '__fakeInstalled', '__updates', '__installCalls', '__installAnswer']) delete window[name];
                if (document.querySelector('#extensionsDialog').open) document.querySelector('#extensionsDialog').close();
            })()`);
        }
    }, { skip: driver.kind !== 'playwright' && 'the desktop\'s window.extensions is the preload\'s, which a test cannot replace; the web edition\'s runs the same Discover and update code' });

    await run('advanced provider execution mode selector persists a choice and warns for in-process', async () => {
        // Settings keeps a change as it is made, through a real IPC round trip, so each step waits for what it changes to show.
        const openProviders = async () => {
            await evaluate(window, `document.querySelector('#settingsButton').click()`);
            await waitFor(window, `document.querySelector('#settingsDialog').open`, 'Settings did not open.');
            await evaluate(window, `document.querySelector('[data-settings-target="providers"]').click()`);
            await waitFor(window, `!document.querySelector('[data-settings-page="providers"]').hidden && document.querySelector('#toolchainCppDetected').textContent !== ''`, 'Settings › Providers did not open.');
        };
        const choose = (value) => evaluate(window, `(() => {
            const select = document.querySelector('#providerExecutionMode');
            select.value = ${JSON.stringify(value)};
            select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        const close = async () => {
            await evaluate(window, `document.querySelector('#settingsClose').click()`);
            await waitFor(window, `!document.querySelector('#settingsDialog').open`, 'Settings did not close.');
        };
        await openProviders();
        assert.equal(await evaluate(window, `document.querySelector('#providerExecutionMode').value`), '');
        assert.equal(await isRenderedVisible(window, '#providerExecutionModeWarning'), false);
        await choose('inProcess');
        assert.equal(await isRenderedVisible(window, '#providerExecutionModeWarning'), true);
        await choose('sharedMemoryWorker');
        assert.equal(await isRenderedVisible(window, '#providerExecutionModeWarning'), false);
        assert.equal(await evaluate(window, `document.querySelector('#settingsSave')`), null, 'Settings has no Save: a change is kept as it is made.');
        await waitFor(window, `window.providerToolchains.executionMode.get().then(({ executionMode }) => executionMode === 'sharedMemoryWorker')`, 'The execution mode was not kept.');
        await close();

        await openProviders();
        assert.equal(await evaluate(window, `document.querySelector('#providerExecutionMode').value`), 'sharedMemoryWorker');
        // Back to Automatic, so this preference of the machine's (not the project's) does not reach later tests in this run.
        await choose('');
        await waitFor(window, `window.providerToolchains.executionMode.get().then(({ executionMode }) => executionMode === '')`, 'The execution mode was not reset.');
        await close();
    }, { skip: !driver.capabilities.providerExecutionModeSelector && 'sharedMemoryWorker/inProcess execution-mode selection has no web-edition equivalent' });

    await run('Settings lists the controller bindings, binds a key before a run, makes two keys one control, and keeps the threshold', async () => {
        const project = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [],
            nodes: [{
                id: 1, name: 'Integrator', position: [0, 0, 0], appearance: { type: 'primitive', shape: 'box', color: '#888888' },
                states: [{ id: 2, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
                sourceTerms: [{
                    id: 3, state: 'x', expression: 'k',
                    parameters: [{ id: 4, name: 'Drive', symbol: 'k', value: 0, unit: '', mode: 'live', control: { minimum: -10, maximum: 10, step: 0.1 } }],
                    expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId: 4, symbol: 'k' }], output: { stateId: 2 }, mathJson: 'k' }
                }]
            }],
            edges: []
        };
        const key = (type, code) => evaluate(window, `window.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, { code: ${JSON.stringify(code)}, bubbles: true, cancelable: true }))`);
        const rows = (within = '#controllerParameters') => evaluate(window, `[...document.querySelectorAll('${within} .controllerBindingRow')].map((row) => row.textContent.replace(/\\s+/g, ' ').trim())`);
        const drive = '#controllerParameters .controllerParameter[data-symbol="k"]';
        // The model the scenarios after this one carry on with, put back at the end.
        const previous = await evaluate(window, `({ document: window.__debugProject.serialize(), name: document.querySelector('.documentTitle').textContent })`);
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(project)}, 'Keys.kjt')`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 1`, 'The integrator did not load.');
        await evaluate(window, `window.__debugSteering.steering.save({ bindings: [] })`);

        await evaluate(window, `document.querySelector('#settingsButton').click()`);
        await waitFor(window, `document.querySelector('#settingsDialog').open`, 'Settings did not open.');
        await evaluate(window, `document.querySelector('[data-settings-target="controllers"]').click()`);
        await waitFor(window, `!document.querySelector('[data-settings-page="controllers"]').hidden`, 'Settings › Controllers did not open.');
        // The model's one live parameter is listed, not bound yet, with Bind beside it; nothing else is.
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('#controllerParameters .controllerParameter')].map((row) => row.querySelector('.settingsItemLabel').textContent)`), ['Drive']);
        assert.match(await evaluate(window, `document.querySelector('${drive} .settingsItemHint').textContent`), /^k · live from −10 to 10 · not bound$/);
        assert.equal(await evaluate(window, `document.querySelector('${drive} [data-bind-symbol]').textContent`), 'Bind');
        assert.equal(await evaluate(window, `document.querySelector('#controllerOtherBindings').hidden`), true, 'With no other bindings, their section is hidden.');
        assert.equal(await evaluate(window, `document.querySelector('#controllerThreshold').value`), '1', 'The threshold is 1% of the live range unless changed.');

        // A gamepad laid out as the standard one is drawn as a gamepad, its buttons, triggers and sticks following it.
        const gamepad = 'Test gamepad (simulated)';
        const pad = (code) => evaluate(window, `(() => { const devices = window.__debugSteering.devices; ${code}; devices.poll(); })()`);
        await pad(`devices.connectGamepad(${JSON.stringify(gamepad)})`);
        await waitFor(window, `Boolean(document.querySelector('#controllerDevices [data-device-id="Test gamepad (simulated)"] .controllerOutline.gamepad'))`, 'The gamepad was not drawn.');
        assert.equal(await evaluate(window, `document.querySelector('#controllerHelp').open`), false, 'The steps for connecting a controller stayed open with one seen.');
        assert.equal(await evaluate(window, `document.querySelectorAll('#controllerDevices .controllerOutline.gamepad .controllerKnob').length`), 2);
        await pad(`devices.setButton(${JSON.stringify(gamepad)}, 0, 1); devices.setButton(${JSON.stringify(gamepad)}, 7, 0.5); devices.moveAxis(${JSON.stringify(gamepad)}, 2, -1)`);
        await waitFor(window, `document.querySelector('.controllerOutline.gamepad [data-button="0"]').classList.contains('active') && Number(document.querySelector('.controllerOutline.gamepad [data-trigger="7"]').getAttribute('width')) > 10 && document.querySelector('.controllerOutline.gamepad [data-stick="2,3"]').classList.contains('moved')`, 'The drawn gamepad did not follow its button, trigger and stick.');
        await pad(`devices.disconnectGamepad(${JSON.stringify(gamepad)})`);
        await waitFor(window, `!document.querySelector('#controllerDevices .controllerOutline')`, 'The gamepad was still drawn once disconnected.');

        // Bound before any run: the next key pressed drives Drive, and the key does nothing else meanwhile.
        await evaluate(window, `document.querySelector('${drive} [data-bind-symbol]').click()`);
        await waitFor(window, `document.querySelector('${drive}').classList.contains('listening')`, 'Bind did not wait for a control.');
        assert.match(await evaluate(window, `document.querySelector('${drive} .settingsItemHint').textContent`), /^Listening for Drive/);
        assert.equal(await evaluate(window, `document.querySelector('${drive} [data-bind-symbol]').textContent`), 'Stop listening');
        await key('keydown', 'KeyW');
        await key('keyup', 'KeyW');
        await waitFor(window, `document.querySelectorAll('${drive} .controllerBindingRow').length === 1`, 'The key was not bound.');
        assert.deepEqual(await rows(), ['⌨ WKeyboardRebindOptions…Remove']);
        // Saying what was bound (the only live parameter, so nothing is listened for next), and the row marked as the one just made.
        await waitFor(window, `/^Bound ⌨ W to Drive\\. Move it/.test(document.querySelector('#controllerBindStatus').textContent)`, 'The page did not say what was bound.');
        assert.equal(await evaluate(window, `document.querySelector('${drive}').classList.contains('listening')`), false);
        assert.equal(await evaluate(window, `document.querySelector('${drive} .controllerBindingRow').classList.contains('justBound')`), true);
        assert.equal(await evaluate(window, `document.querySelector('${drive} [data-bind-symbol]').textContent`), 'Add another', 'A bound parameter offers another control.');
        assert.equal(await evaluate(window, `document.querySelector('#settingsDialog').open`), true, 'Pressing a key to bind it closed Settings.');

        // Its settings: a second key makes the two one control, ramping the value up and down.
        await evaluate(window, `document.querySelector('${drive} [data-change]').click()`);
        await waitFor(window, `document.querySelector('.inputBindingDialog')?.open`, 'The binding\'s settings did not open.');
        await evaluate(window, `[...document.querySelectorAll('.inputBindingDialog footer button')].find((button) => button.textContent.startsWith('Add a key')).click()`);
        await key('keydown', 'KeyS');
        await key('keyup', 'KeyS');
        await waitFor(window, `document.querySelector('.inputBindingDialog strong')?.textContent === '⌨ W / S'`, 'The second key was not added.');
        assert.equal(await evaluate(window, `document.querySelector('.inputBindingDialog [name=kind]').value`), 'ramp');
        await evaluate(window, `(() => { const dialog = document.querySelector('.inputBindingDialog'); dialog.querySelector('[name=rate]').value = '4'; dialog.querySelector('[name=label]').value = 'Throttle'; dialog.querySelector('[name=model]').checked = true; dialog.querySelector('button[type=submit]').click(); })()`);
        await waitFor(window, `!document.querySelector('.inputBindingDialog')`, 'The binding\'s settings did not close.');
        const [kept] = (await evaluate(window, `window.__debugSteering.steering.document`)).bindings;
        assert.deepEqual([kept.label, kept.control, kept.mapping, kept.model], ['Throttle', { type: 'keys', up: 'KeyW', down: 'KeyS' }, { kind: 'ramp', rate: 4 }, 'Keys']);
        await waitFor(window, `document.querySelector('${drive} .controllerBindingRow strong')?.textContent === 'Throttle'`, 'The list did not follow the change.');

        // Rebind gives it another control in place: the same binding, its name and model kept, its mapping the new control's own.
        await evaluate(window, `document.querySelector('${drive} [data-rebind]').click()`);
        await waitFor(window, `document.querySelector('${drive} .controllerBindingRow').classList.contains('listening')`, 'Rebind did not wait for a control.');
        assert.equal(await evaluate(window, `document.querySelector('${drive} [data-rebind]').textContent`), 'Stop');
        await key('keydown', 'KeyQ');
        await key('keyup', 'KeyQ');
        await waitFor(window, `window.__debugSteering.steering.document.bindings[0]?.control.code === 'KeyQ'`, 'Rebind did not take the new key.');
        const rebound = (await evaluate(window, `window.__debugSteering.steering.document`)).bindings;
        assert.deepEqual([rebound.length, rebound[0].id, rebound[0].label, rebound[0].model, rebound[0].mapping.kind], [1, kept.id, 'Throttle', 'Keys', 'momentary']);
        await waitFor(window, `/now drives Drive, with the rest of the binding as it was/.test(document.querySelector('#controllerBindStatus').textContent)`, 'The page did not say what the binding was changed to.');

        // A stick bound as another control for Drive maps across its range, and Invert, in its row, turns it round at once.
        const stick = 'Stick pad (simulated)';
        await pad(`devices.connectGamepad(${JSON.stringify(stick)})`);
        await evaluate(window, `document.querySelector('${drive} [data-bind-symbol]').click()`);
        await waitFor(window, `document.querySelector('${drive}').classList.contains('listening')`, 'Add another did not wait for a control.');
        await pad(`devices.moveAxis(${JSON.stringify(stick)}, 0, 0.9)`);
        await waitFor(window, `document.querySelectorAll('${drive} .controllerBindingRow').length === 2`, 'The stick was not bound.');
        await pad(`devices.moveAxis(${JSON.stringify(stick)}, 0, 0)`);
        const stickRow = `${drive} .controllerBindingRow:nth-child(2)`;
        assert.equal(await evaluate(window, `document.querySelector('${stickRow} [data-invert]').getAttribute('aria-pressed')`), 'false');
        await evaluate(window, `document.querySelector('${stickRow} [data-invert]').click()`);
        await waitFor(window, `window.__debugSteering.steering.document.bindings[1]?.mapping.invert === true`, 'Invert was not kept.');
        await waitFor(window, `document.querySelector('${stickRow} [data-invert]')?.textContent === 'Inverted' && document.querySelector('${stickRow} .controllerAxisMeter').dataset.inverted === 'true'`, 'The row did not show the binding inverted.');
        await evaluate(window, `document.querySelector('${stickRow} [data-remove]').click()`);
        await waitFor(window, `window.__debugSteering.steering.document.bindings.length === 1`, 'The stick binding was not removed.');
        await pad(`devices.disconnectGamepad(${JSON.stringify(stick)})`);

        // A binding for a parameter this model does not have waits, and says so; the threshold is kept as a fraction.
        await evaluate(window, `window.__debugSteering.steering.save({ ...window.__debugSteering.steering.document, bindings: [...window.__debugSteering.steering.document.bindings, { id: 'elsewhere', device: { kind: 'keyboard' }, control: { type: 'key', code: 'KeyH' }, parameter: { symbol: 'heaterPower', name: 'Heater power' } }] })`);
        await waitFor(window, `document.querySelectorAll('#controllerBindingList .controllerBindingRow').length === 1`, 'The binding for another model was not listed apart.');
        assert.equal(await evaluate(window, `!document.querySelector('#controllerOtherBindings').hidden && document.querySelector('#controllerOtherBindingsTitle').textContent`), 'Bindings for other models (1)');
        assert.match((await rows('#controllerBindingList'))[0], /→ Heater power.*heaterPower · not in this model/);
        await evaluate(window, `(() => { const input = document.querySelector('#controllerThreshold'); input.value = '0.5'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(window, `window.__debugSteering.steering.document.threshold === 0.005`, 'The threshold was not kept.');

        // Removed, they are gone; and Settings closes.
        await evaluate(window, `[...document.querySelectorAll('[data-settings-page="controllers"] [data-remove]')].forEach((button) => button.click())`);
        await waitFor(window, `window.__debugSteering.steering.document.bindings.length === 0`, 'The bindings were not removed.');
        await evaluate(window, `window.__debugSteering.steering.save({ bindings: [] })`);
        await evaluate(window, `document.querySelector('#settingsClose').click()`);
        await waitFor(window, `!document.querySelector('#settingsDialog').open`, 'Settings did not close.');
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(previous.document)}, ${JSON.stringify(`${previous.name}.kjt`)})`);
        await waitFor(window, `document.querySelector('.documentTitle').textContent === ${JSON.stringify(previous.name)}`, 'The model from before was not put back.');
    });

    await run('project properties edit the ownership details, and the defaults for new projects are kept', async () => {
        const setField = (host, name, value) => evaluate(window, `(() => {
            const control = document.querySelector('${host} [name="${name}"]');
            control.value = ${JSON.stringify(value)};
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#ownershipButton') !== null`), true);

        // Defaults first, since a project that is already open keeps whatever it started with.
        await evaluate(window, `document.querySelector('#ownershipButton').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open`, 'Project properties did not open.');
        await evaluate(window, `document.querySelector('#ownershipDefaultsOpen').click()`);
        await waitFor(window, `document.querySelector('#settingsDialog').open && !document.querySelector('[data-settings-page="newProjects"]').hidden && !document.querySelector('#ownershipDialog').open`, 'Settings › New projects did not replace Project properties.', 15000);
        await waitFor(window, `document.querySelectorAll('#ownershipDefaultsFieldsHost [name]').length === 7`, 'The defaults\' fields were not shown.', 15000);
        assert.equal(await evaluate(window, `document.querySelector('#ownershipDefaultsFieldsHost [name="title"]') === null`), true);
        await setField('#ownershipDefaultsFieldsHost', 'owner', 'Acme Thermal Ltd');
        await setField('#ownershipDefaultsFieldsHost', 'license', 'custom');
        assert.equal(await isRenderedVisible(window, '#ownershipDefaultsFieldsHost label[data-license="custom"]'), true);
        await setField('#ownershipDefaultsFieldsHost', 'licenseText', 'Internal use only');
        await setField('#ownershipDefaultsFieldsHost', 'license', 'MIT');
        assert.equal(await isRenderedVisible(window, '#ownershipDefaultsFieldsHost label[data-license="custom"]'), false);
        // Kept as they are typed; closing Settings returns to Project properties, showing this project's own, still-empty, details.
        await evaluate(window, `document.querySelector('#settingsClose').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open && !document.querySelector('#settingsDialog').open`, 'Project properties did not come back after Settings closed.', 15000);
        await evaluate(window, `document.querySelector('#ownershipCancel').click()`);
        await waitFor(window, `!document.querySelector('#ownershipDialog').open`, 'Project properties did not close.');

        // The details of this project: edited, kept, and counted as unsaved work.
        const unsavedShown = `getComputedStyle(document.querySelector('.windowTitle i')).visibility === 'visible'`;
        await evaluate(window, `document.querySelector('#ownershipButton').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open`, 'Project properties did not reopen.');
        await setField('#ownershipFieldsHost', 'owner', 'Example Owner');
        await setField('#ownershipFieldsHost', 'copyright', 'Copyright © {year} Example Owner');
        await setField('#ownershipFieldsHost', 'license', 'CC-BY-4.0');
        await setField('#ownershipFieldsHost', 'contact', 'models@example.com');
        await setField('#ownershipFieldsHost', 'revision', '2.1');
        await evaluate(window, `document.querySelector('#ownershipSave').click()`);
        await waitFor(window, `!document.querySelector('#ownershipDialog').open`, 'Project properties did not close after Done.');
        assert.equal(await evaluate(window, unsavedShown), true);
        await evaluate(window, `document.querySelector('#ownershipButton').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open`, 'Project properties did not reopen after Done.');
        const kept = await evaluate(window, `Object.fromEntries([...document.querySelectorAll('#ownershipFieldsHost [name]')].filter((control) => control.type !== 'checkbox').map((control) => [control.name, control.value]))`);
        assert.equal(kept.owner, 'Example Owner');
        assert.equal(kept.copyright, 'Copyright © {year} Example Owner');
        assert.equal(kept.license, 'CC-BY-4.0');
        assert.equal(kept.contact, 'models@example.com');
        assert.equal(kept.revision, '2.1');
        // This project names a different owner from the defaults, so the dialog says a save keeps it and offers to take it over.
        assert.equal(await isRenderedVisible(window, '#ownershipSomeoneElses'), true);
        assert.equal(await isRenderedVisible(window, '#ownershipMakeMine'), true);
        await evaluate(window, `document.querySelector('#ownershipMakeMine').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open && document.querySelector('#ownershipFieldsHost [name="owner"]').value === 'Acme Thermal Ltd'`, 'Make this my own did not apply the defaults.');
        assert.match(await evaluate(window, `document.querySelector('#ownershipFieldsHost [name="derivedFrom"]').value`), /by Example Owner, license CC-BY-4\.0/);
        assert.equal(await evaluate(window, `document.querySelector('#ownershipFieldsHost [name="license"]').value`), 'MIT');
        await evaluate(window, `document.querySelector('#ownershipCancel').click()`);
        await waitFor(window, `!document.querySelector('#ownershipDialog').open`, 'Project properties did not close at the end.');

        // Leave nothing behind for later tests: the defaults are kept in the user's data, shared by every window.
        await evaluate(window, `document.querySelector('#ownershipButton').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open`, 'Project properties did not open to clear the defaults.');
        await evaluate(window, `document.querySelector('#ownershipDefaultsOpen').click()`);
        await waitFor(window, `document.querySelector('#settingsDialog').open && !document.querySelector('[data-settings-page="newProjects"]').hidden`, 'Settings › New projects did not open to clear the defaults.', 15000);
        await waitFor(window, `document.querySelector('#ownershipDefaultsFieldsHost [name="owner"]')?.value === 'Acme Thermal Ltd'`, 'The defaults kept before were not shown.');
        await setField('#ownershipDefaultsFieldsHost', 'owner', '');
        await setField('#ownershipDefaultsFieldsHost', 'license', '');
        await evaluate(window, `document.querySelector('#settingsClose').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open`, 'Project properties did not come back after clearing the defaults.');
        await evaluate(window, `document.querySelector('#ownershipCancel').click()`);
        await waitFor(window, `!document.querySelector('#ownershipDialog').open`, 'Project properties did not close after clearing the defaults.');
    });

    await run('saving a new project offers its ownership details for that copy alone', async () => {
        const setField = (host, name, value) => evaluate(window, `(() => {
            const control = document.querySelector('${host} [name="${name}"]');
            control.value = ${JSON.stringify(value)};
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await evaluate(window, `document.querySelector('#ownershipButton').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open`, 'Project properties did not open.');
        await setField('#ownershipFieldsHost', 'owner', 'Save Test Owner');
        await setField('#ownershipFieldsHost', 'license', 'all-rights-reserved');
        await evaluate(window, `document.querySelector('#ownershipSave').click()`);
        await waitFor(window, `!document.querySelector('#ownershipDialog').open`, 'Project properties did not close.');

        // A first save of a project that names an owner asks about this copy before the file is chosen. Cancelling saves nothing.
        await evaluate(window, `document.querySelector('#saveButton').click()`);
        await waitFor(window, `document.querySelector('#saveOwnershipDialog').open`, 'The save dialog did not offer the ownership details.');
        assert.equal(await evaluate(window, `document.querySelector('#saveOwnershipFieldsHost [name="owner"]').value`), 'Save Test Owner');
        assert.equal(await evaluate(window, `document.querySelector('#saveOwnershipFieldsHost [name="title"]') === null`), true);
        // All rights reserved and not encrypted: it says that only encrypting keeps the file private.
        assert.equal(await isRenderedVisible(window, '#saveOwnershipEncryptionNote'), true);
        await evaluate(window, `(() => { const strip = document.querySelector('#saveOwnershipStrip'); strip.checked = true; strip.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await isRenderedVisible(window, '#saveOwnershipFieldsHost'), false);
        assert.equal(await isRenderedVisible(window, '#saveOwnershipEncryptionNote'), false);
        await evaluate(window, `document.querySelector('#saveOwnershipCancel').click()`);
        await waitFor(window, `!document.querySelector('#saveOwnershipDialog').open`, 'The save dialog did not close on Cancel.');

        // What was typed for the copy never reaches the project: its own details are as they were, and it is still unsaved.
        await evaluate(window, `document.querySelector('#ownershipButton').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open`, 'Project properties did not reopen.');
        assert.equal(await evaluate(window, `document.querySelector('#ownershipFieldsHost [name="owner"]').value`), 'Save Test Owner');
        assert.equal(await evaluate(window, `document.querySelector('#ownershipFieldsHost [name="license"]').value`), 'all-rights-reserved');
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('.windowTitle i')).visibility`), 'visible');
        await evaluate(window, `document.querySelector('#ownershipCancel').click()`);
        await waitFor(window, `!document.querySelector('#ownershipDialog').open`, 'Project properties did not close at the end.');
    });

    await run('a project saved as a copy with other ownership details keeps writing that copy, and keeps its own details', async () => {
        const readSaved = async (path) => JSON.parse(await decodeProjectFile(await readFile(path)));
        const pressSave = (shift) => evaluate(window, `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, ctrlKey: true, shiftKey: ${shift}, bubbles: true, cancelable: true }))`);
        const waitForSavedChange = async (path, before) => {
            for (let attempt = 0; attempt < 100; attempt += 1) {
                const saved = await readSaved(path).catch(() => null);
                if (saved && JSON.stringify(saved.ownership ?? null) !== JSON.stringify(before ?? null)) return saved;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error('The saved file did not change.');
        };
        const setField = (host, name, value) => evaluate(window, `(() => {
            const control = document.querySelector('${host} [name="${name}"]');
            control.value = ${JSON.stringify(value)};
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);

        // The project's own details, then a first save of a copy that changes the owner.
        await evaluate(window, `document.querySelector('#ownershipButton').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open`, 'Project properties did not open.');
        await setField('#ownershipFieldsHost', 'owner', 'Project Owner');
        await setField('#ownershipFieldsHost', 'copyright', 'Copyright © {year} Project Owner');
        await setField('#ownershipFieldsHost', 'license', 'MIT');
        await evaluate(window, `document.querySelector('#ownershipSave').click()`);
        await waitFor(window, `!document.querySelector('#ownershipDialog').open`, 'Project properties did not close.');
        const { path, bytes } = await driver.captureExport(async () => {
            await evaluate(window, `document.querySelector('#saveButton').click()`);
            await waitFor(window, `document.querySelector('#saveOwnershipDialog').open`, 'The save dialog did not offer the ownership details.');
            await setField('#saveOwnershipFieldsHost', 'owner', 'Copy Owner');
            await evaluate(window, `document.querySelector('#saveOwnershipContinue').click()`);
        }, { extension: 'kjt' });
        const first = JSON.parse(await decodeProjectFile(bytes));
        assert.equal(first.ownership.owner, 'Copy Owner');
        assert.equal(first.ownership.license.id, 'MIT');
        assert.equal(first.ownership.copyright, `Copyright © ${new Date().getUTCFullYear()} Project Owner`);
        assert.match(first.ownership.firstSavedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
        assert.ok(first.ownership.lastSavedAt >= first.ownership.firstSavedAt);
        assert.ok(first.ownership.savedWith);
        assert.equal(first.copyright, undefined, 'the application must no longer write its own copyright notice into a project');

        // The project itself still has its own owner.
        await evaluate(window, `document.querySelector('#ownershipButton').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open`, 'Project properties did not reopen.');
        assert.equal(await evaluate(window, `document.querySelector('#ownershipFieldsHost [name="owner"]').value`), 'Project Owner');
        await evaluate(window, `document.querySelector('#ownershipCancel').click()`);
        await waitFor(window, `!document.querySelector('#ownershipDialog').open`, 'Project properties did not close.');

        // A plain Save to that file writes the same copy, not the project's own owner, and keeps the first save time.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await pressSave(false);
        const second = await waitForSavedChange(path, first.ownership);
        assert.equal(second.ownership.owner, 'Copy Owner');
        assert.equal(second.ownership.firstSavedAt, first.ownership.firstSavedAt);
        assert.notEqual(second.ownership.lastSavedAt, first.ownership.lastSavedAt);

        // Save As, stripped: the file has no ownership block, and a plain Save to it still has none.
        const { path: strippedPath, bytes: strippedBytes } = await driver.captureExport(async () => {
            await pressSave(true);
            await waitFor(window, `document.querySelector('#saveOwnershipDialog').open`, 'Save As did not offer the ownership details.');
            await evaluate(window, `(() => { const strip = document.querySelector('#saveOwnershipStrip'); strip.checked = true; strip.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            await evaluate(window, `document.querySelector('#saveOwnershipContinue').click()`);
        }, { extension: 'kjt' });
        assert.equal(JSON.parse(await decodeProjectFile(strippedBytes)).ownership, undefined);
        const strippedBefore = await readFile(strippedPath);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await pressSave(false);
        for (let attempt = 0; attempt < 100 && (await readFile(strippedPath)).equals(strippedBefore); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal((await readSaved(strippedPath)).ownership, undefined);

        // Editing the project's own details means they go into the file it is saved to from then on.
        await evaluate(window, `document.querySelector('#ownershipButton').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open`, 'Project properties did not open to edit.');
        await setField('#ownershipFieldsHost', 'owner', 'Edited Owner');
        await evaluate(window, `document.querySelector('#ownershipSave').click()`);
        await waitFor(window, `!document.querySelector('#ownershipDialog').open`, 'Project properties did not close after the edit.');
        await pressSave(false);
        const edited = await waitForSavedChange(strippedPath, null);
        assert.equal(edited.ownership.owner, 'Edited Owner');

        // Renaming the file from the title bar is not a copy: it keeps the file's details and asks nothing.
        const { bytes: renamedBytes } = await driver.captureExport(async () => {
            await evaluate(window, `(() => { document.querySelector('.documentTitle').click(); const input = document.querySelector('.documentTitleInput'); input.value = 'Renamed Ownership Project'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        }, { extension: 'kjt' });
        assert.equal(await evaluate(window, `document.querySelector('#saveOwnershipDialog').open`), false, 'Renaming must not ask for the details of a copy.');
        assert.equal(JSON.parse(await decodeProjectFile(renamedBytes)).ownership.owner, 'Edited Owner');
    }, { skip: !driver.capabilities.osFileOpen && 'the native save dialog is a desktop-only way to choose where a project goes' });

    await run('exports carry the project\'s owner, copyright and license into the generated code and the FMU description', async () => {
        const setField = (host, name, value) => evaluate(window, `(() => {
            const control = document.querySelector('${host} [name="${name}"]');
            control.value = ${JSON.stringify(value)};
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await evaluate(window, `document.querySelector('#ownershipButton').click()`);
        await waitFor(window, `document.querySelector('#ownershipDialog').open`, 'Project properties did not open.');
        await setField('#ownershipFieldsHost', 'owner', 'Export Owner');
        await setField('#ownershipFieldsHost', 'copyright', 'Copyright © {year} Export Owner');
        await setField('#ownershipFieldsHost', 'license', 'Apache-2.0');
        await evaluate(window, `document.querySelector('#ownershipSave').click()`);
        await waitFor(window, `!document.querySelector('#ownershipDialog').open`, 'Project properties did not close.');
        const year = new Date().getUTCFullYear();

        const exportWith = async (format, extension, maxAttempts) => {
            await evaluate(window, `document.querySelector('#exportCodeButton').click()`);
            await waitFor(window, `document.querySelector('#exportCodeDialog').open`, 'Export code dialog did not open.');
            await evaluate(window, `(() => { const format = document.querySelector('#exportCodeFormat'); format.value = '${format}'; format.dispatchEvent(new Event('change')); })()`);
            const { bytes } = await driver.captureExport(async () => {
                await evaluate(window, `document.querySelector('#exportCodeSubmit').click()`);
                await waitFor(window, `!document.querySelector('#exportCodeDialog').open`, 'Export dialog should close after the export is written.', 60000);
            }, { extension, maxAttempts });
            return bytes;
        };

        const source = (await exportWith('source', 'cpp', 100)).toString('utf8');
        assert.match(source, new RegExp(`^// Generated by Konjugate[^\\n]*\\n// Copyright © ${year} Export Owner\\n// License: Apache-2\\.0\\n`));

        const entries = unzipSync(await exportWith('fmu', 'fmu', 400));
        const xml = Buffer.from(entries['modelDescription.xml']).toString('utf8');
        assert.match(xml, new RegExp(`author="Export Owner" copyright="Copyright © ${year} Export Owner" license="Apache-2\\.0" generationTool="Konjugate"`));
    }, { skip: !driver.capabilities.fmuExport && 'FMU export is not available in the web edition' });

    // Shared across the three run() calls the "Run..."/"Results Analysis..."/"closing results..."
    // scenarios below split into (see docs/proposals/webEdition.md and this file's own driver
    // header comment): the Results Analysis add-on window has no web-edition equivalent, but the
    // main window must always end each of these three scenarios in the same state regardless of
    // whether the add-on portion actually ran, so scenario #16 (multi-selection...) always starts
    // clean. analysisHandle stays null when the add-on scenario is skipped.
    let analysisHandle = null;

    await run('Run invokes the C++ simulation and displays state results', async () => {
        await freshExample();
        // Run is off while the model is validated again after an edit (the scenario before edits it), so it is waited for.
        await waitFor(window, `!document.querySelector('#runButton').disabled`, 'Run was not available.', 15000);
        const before = await evaluate(window, `document.querySelector('.node-label-container dd').textContent`);
        await openRunDialog(window);
        await evaluate(window, `(() => { document.querySelector('#runTargetTime').value = '1.5'; document.querySelector('#runOnlineMode').checked = true; document.querySelector('#runOnlineMode').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#runPacingMode').value = 'realTime'; document.querySelector('#startRun').click(); })()`);
        await waitFor(window, `!document.querySelector('#resultTransport').hidden && document.querySelector('.resultMode small').textContent === 'Running · model locked'`, 'C++ simulation did not enter its running state.', 10000);
        assert.equal(await evaluate(window, `!document.querySelector('#simulationPacing').hidden && document.querySelector('#resultPlaybackRate').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#resultPlaybackControls').hidden && !document.querySelector('#simulationExecutionControls').hidden`), true);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.reviewControl')].every((control) => control.hidden) && document.querySelector('#continueRun').hidden`), true);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.reviewControl, #continueRun')].every((control) => getComputedStyle(control).display === 'none')`), true);
        assert.equal(await evaluate(window, `document.querySelector('.resultMode b').textContent`), 'Simulation');
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#simulationProgress')).display !== 'none' && document.querySelector('#simulationProgress').value.includes('/')`), true);
        assert.equal(await evaluate(window, `document.querySelector('.resultMode small').textContent`), 'Running · model locked');
        await evaluate(window, `document.querySelector('#simulationPauseResume').click()`);
        await waitFor(window, `document.querySelector('.resultMode small').textContent === 'Paused · model locked'`, 'Simulation did not pause at a synchronization boundary.', 3000);
        assert.equal(await evaluate(window, `document.querySelector('#closeResults').hidden`), true);
        await evaluate(window, `document.querySelector('#simulationPauseResume').click()`);
        // A 1.5 s real-time run, but a slow runner (GitHub's Intel Macs) takes well over 5 s from resume to the end.
        await waitFor(window, `document.querySelector('.resultMode small').textContent === 'Model locked'`, 'Live simulation did not complete.', 15000);
        assert.equal(await evaluate(window, `document.querySelector('#simulationPacing').hidden && !document.querySelector('#resultPlaybackRate').hidden`), true);
        assert.equal(await evaluate(window, `!document.querySelector('#resultPlaybackControls').hidden && document.querySelector('#simulationExecutionControls').hidden`), true);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.reviewControl')].every((control) => !control.hidden) && !document.querySelector('#continueRun').hidden`), true);
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#continueRun')).display !== 'none' && document.querySelector('#continueRun').textContent === 'Extend simulation' && getComputedStyle(document.querySelector('#resultTimeline')).display !== 'none'`), true);
        assert.equal(await evaluate(window, `document.querySelector('.resultMode b').textContent`), 'Results');
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#simulationProgress')).display === 'none'`), true);
        assert.equal(await evaluate(window, `document.querySelector('#executionSummaryButton').hidden`), false);
        assert.equal(await evaluate(window, `!document.querySelector('#saveButton').disabled`), true);
        assert.equal(await evaluate(window, `!document.querySelector('#branchesButton').hidden && document.querySelector('#branchesPanel').hidden`), true);
        await evaluate(window, `document.querySelector('#branchesButton').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#branchesPanel').hidden && !document.querySelector('#forkHereButton').hidden && document.querySelector('#forkHereLabel').textContent.startsWith('Fork at ')`), true);
        await evaluate(window, `document.querySelector('#branchesButton').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#branchesPanel').hidden`), true);
        await evaluate(window, `document.querySelector('#executionSummaryButton').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#executionSummaryCard').classList.contains('hidden')`), true);
        assert.match(await evaluate(window, `document.querySelector('#executionSummaryTitle').textContent`), /(Serial|Thread pool|Partitioned) · \d+ workers?/);
        assert.ok(await evaluate(window, `document.querySelectorAll('#executionSummaryMetrics dt').length`) >= 8);
        assert.match(await evaluate(window, `document.querySelector('#executionSummaryMetrics').textContent`), /Partitioner.*Communication cut/);
        await evaluate(window, `document.querySelector('#closeExecutionSummary').click()`);
        assert.equal(await evaluate(window, `document.querySelector('[data-detail="nodes"]').classList.contains('active')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#canvas').classList.contains('showNodesDetails')`), true);
        const finalValue = await evaluate(window, `document.querySelector('.node-label-container dd').textContent`);
        assert.notEqual(finalValue, before);
        assert.ok(Number(await evaluate(window, `document.querySelector('#resultTimeline').max`)) > 0);
        assert.equal(await evaluate(window, `Number(document.querySelector('#resultTimeline').value)`), 1.5);
        assert.equal(await evaluate(window, `Number(document.querySelector('#resultTimeline').max)`), 1.5);
        assert.equal(await evaluate(window, `document.querySelector('#resultPlaybackRate').value`), '1');
        await evaluate(window, `(() => { const timeline = document.querySelector('#resultTimeline'); timeline.value = '0'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        assert.equal(await evaluate(window, `document.querySelector('#resultCurrentTime').value`), '0 s');
        assert.notEqual(await evaluate(window, `document.querySelector('.node-label-container dd').textContent`), finalValue);
        await evaluate(window, `document.querySelector('#resultPlayPause').click()`);
        await waitFor(window, `Number(document.querySelector('#resultTimeline').value) > 0`, 'Result playback did not advance the timeline.', 3000);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        await waitFor(window, `document.querySelector('.nodeResultsPanel').classList.contains('hasResults')`, 'Selected-node result plot did not render.', 5000);
        assert.equal(await evaluate(window, `document.querySelector('[data-editor-tab="results"]').classList.contains('active')`), true);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('#nodeModelActions button')].every((button) => button.disabled)`), true, 'The node\'s actions are not off while results are open.');
        assert.equal(await evaluate(window, `document.querySelector('#canvas').classList.contains('resultModeLocked')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#addButton').disabled && document.querySelector('[data-tool="move"]').disabled && document.querySelector('[data-action="delete"]').disabled`), true);
        assert.equal(await evaluate(window, `!document.querySelector('#nodeEditor [data-result-readonly]').hidden`), true);
        assert.ok(await evaluate(window, `document.querySelector('#nodeResultPlot').data.length`) > 0);
        assert.ok(await evaluate(window, `document.querySelector('#nodeResultPlot').layout.shapes.length`) > 0);
        assert.equal(await evaluate(window, `document.querySelector('#openResultsAnalysis')`), null);
    });

    await run('Results Analysis add-on inspects and exports a completed run', async () => {
        // The toolstrip command itself, not just the ability to click it, is desktop-only: the web
        // shim's window.addons.listToolstripContributions() always returns [] (confirmed by
        // reading src/renderer/webShims/misc.mjs directly), so no add-on toolstrip button ever
        // renders on the web edition regardless of which add-ons a real desktop install has.
        await waitFor(window, `Boolean(document.querySelector('.addonTool[data-addon-id="konjugate.resultPlotViewer"][data-command-id="openAnalysis"]:not([hidden])'))`, 'Manifest-declared add-on toolstrip command did not appear.');
        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('.addonTool[data-addon-id="konjugate.resultPlotViewer"][data-command-id="openAnalysis"]').click()`);
        analysisHandle = await driver.waitForNewHandle(before);
        const analysisWindow = analysisHandle;
        await waitFor(analysisWindow, `Boolean(document.querySelector('.konjugateAddonTitlebar'))`, 'Host titlebar was not added to the add-on window.');
        assert.equal(await evaluate(analysisWindow, `document.querySelector('.konjugateAddonIdentity b').textContent`), 'Results Analysis');
        // Every add-on window carries Konjugate's own logo in its host titlebar, not a stand-in letter.
        await waitFor(analysisWindow, `Boolean(document.querySelector('.konjugateAddonIdentity > img'))`, 'The add-on titlebar did not get Konjugate\'s logo.');
        assert.match(await evaluate(analysisWindow, `document.querySelector('.konjugateAddonIdentity > img').src`), /^data:image\/svg\+xml;base64,/);
        assert.equal(await evaluate(analysisWindow, `document.querySelectorAll('.konjugateAddonWindowControls button').length`), 3);
        await waitFor(analysisWindow, `getComputedStyle(document.querySelector('.konjugateAddonTitlebar')).position === 'fixed'`, 'Host titlebar styles did not load.');
        await waitFor(analysisWindow, `document.querySelectorAll('.signalOption').length > 0 && document.querySelector('.plotWorkspace').classList.contains('hasSignals')`, 'Results Analysis did not load signals.', 5000);
        assert.equal(await evaluate(analysisWindow, `document.querySelector('.readOnlyBadge').textContent`), 'Completed');
        assert.equal(await evaluate(analysisWindow, `typeof require === 'undefined'`), true);
        assert.ok(await evaluate(analysisWindow, `document.querySelector('#analysisPlot').data.length`) > 0);

        await evaluate(analysisWindow, `(() => {
            const options = (id) => [...document.querySelector(id).options].map((option) => option.value);
            const xOptions = options('#scatterX');
            const yOptions = options('#scatterY').filter((value) => value !== xOptions[0]);
            document.querySelector('#scatterX').value = xOptions[0];
            document.querySelector('#scatterY').value = yOptions[0] ?? xOptions[0];
            document.querySelector('#scatterColor').value = options('#scatterColor').filter(Boolean)[0] ?? '';
            document.querySelector('#chartMode').value = 'scatter';
            document.querySelector('#chartMode').dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitFor(analysisWindow, `document.querySelector('#analysisPlot').data[0]?.type === 'scatter' && document.querySelector('#analysisPlot').data[0]?.mode === 'markers'`, 'Scatter mode did not render a markers trace.', 3000);
        assert.equal(await evaluate(analysisWindow, `document.querySelector('#scatterPickers').hidden`), false);
        assert.equal(await evaluate(analysisWindow, `document.querySelector('#signalGroups').hidden`), true);
        assert.equal(await evaluate(analysisWindow, `document.querySelector('#resetTrail').hidden`), false);
        assert.equal(await evaluate(analysisWindow, `Array.isArray(document.querySelector('#analysisPlot').data[0].marker.color)`), true);

        // Scatter/distribution reveal samples progressively up to the timeline's current position
        // (a phase-space trail) -- seeking to 0 should empty it, seeking forward should refill it,
        // and axis ranges (fixed from the full run) should stay put across that Plotly.restyle-only
        // update rather than being reasserted from whatever's currently revealed.
        const rangeBeforeTrailScrub = await evaluate(analysisWindow, `document.querySelector('#analysisPlot').layout.xaxis.range`);
        await evaluate(analysisWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = '0'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitFor(analysisWindow, `document.querySelector('#analysisPlot').data[0].x.length <= 1`, 'Scatter trail did not empty when seeking to time 0.', 3000);
        assert.deepEqual(await evaluate(analysisWindow, `document.querySelector('#analysisPlot').layout.xaxis.range`), rangeBeforeTrailScrub);
        await evaluate(analysisWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = timeline.max; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitFor(analysisWindow, `document.querySelector('#analysisPlot').data[0].x.length > 1`, 'Scatter trail did not refill when seeking forward.', 3000);
        await evaluate(analysisWindow, `document.querySelector('#resetTrail').click()`);
        await waitFor(analysisWindow, `document.querySelector('#timeline').value === '0' && document.querySelector('#analysisPlot').data[0].x.length <= 1`, 'Reset trail button did not empty the trail.', 3000);
        await evaluate(analysisWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = timeline.max; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitFor(analysisWindow, `document.querySelector('#analysisPlot').data[0].x.length > 1`, 'Scatter trail did not refill after reset.', 3000);

        await evaluate(analysisWindow, `(() => {
            document.querySelector('#chartMode').value = 'distribution';
            document.querySelector('#chartMode').dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitFor(analysisWindow, `document.querySelector('#analysisPlot').data.length > 0 && document.querySelector('#analysisPlot').data.every((trace) => trace.type === 'histogram')`, 'Distribution mode did not render histogram traces.', 3000);
        assert.equal(await evaluate(analysisWindow, `document.querySelector('#scatterPickers').hidden`), true);
        assert.equal(await evaluate(analysisWindow, `document.querySelector('#signalGroups').hidden`), false);
        assert.equal(await evaluate(analysisWindow, `document.querySelector('#resetTrail').hidden`), false);
        const distributionRangeBeforeScrub = await evaluate(analysisWindow, `document.querySelector('#analysisPlot').layout.yaxis.range`);
        await evaluate(analysisWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = '0'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitFor(analysisWindow, `document.querySelector('#analysisPlot').data[0].x.length <= 1`, 'Distribution trail did not empty when seeking to time 0.', 3000);
        assert.deepEqual(await evaluate(analysisWindow, `document.querySelector('#analysisPlot').layout.yaxis.range`), distributionRangeBeforeScrub);

        await evaluate(analysisWindow, `(() => {
            document.querySelector('#chartMode').value = 'timeSeries';
            document.querySelector('#chartMode').dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitFor(analysisWindow, `document.querySelector('#analysisPlot').data.every((trace) => trace.type === 'scatter' && trace.mode === 'lines')`, 'Time series mode did not restore line traces after switching chart types.', 3000);
        assert.ok(await evaluate(analysisWindow, `document.querySelector('#analysisPlot').layout.shapes.length`) > 0);
        assert.equal(await evaluate(analysisWindow, `document.querySelector('#resetTrail').hidden`), true);

        // The cursor line itself, not just its presence -- seeking must actually move it.
        const cursorXBefore = await evaluate(analysisWindow, `document.querySelector('#analysisPlot').layout.shapes[0].x0`);
        await evaluate(analysisWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = String(Number(timeline.max) / 2); timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitFor(analysisWindow, `document.querySelector('#analysisPlot').layout.shapes[0].x0 !== ${JSON.stringify(cursorXBefore)}`,
            'Time series cursor line did not move when seeking on a completed run.', 3000);

        assert.equal(await evaluate(analysisWindow, `document.querySelector('#exportCsv').disabled`), false);
        const { bytes } = await driver.captureExport(async () => {
            await evaluate(analysisWindow, `document.querySelector('#exportCsv').click()`);
        }, { extension: 'csv' });
        const exportedCsv = bytes.toString('utf8');
        assert.ok(exportedCsv, 'Export data (CSV) did not write a file.');
        assert.match(exportedCsv, /^time \(s\)/);

        await evaluate(analysisWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = '0'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitFor(window, `document.querySelector('#resultCurrentTime').value === '0 s'`, 'Visualizer seek did not synchronize to the project window.');
    }, { skip: (!driver.capabilities.addons && 'the Results Analysis add-on has no web-edition equivalent') || addonMissing('konjugate.resultPlotViewer', 'konjugate-resultplotviewer') });

    await run('closing results clears the main window and any add-on it opened', async () => {
        await evaluate(window, `document.querySelector('[data-editor-tab="details"]').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeName').disabled`), true);
        await evaluate(window, `(() => { const input = document.querySelector('#editNodeName'); input.value = 'Changed during results'; input.dispatchEvent(new Event('change', { bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); })()`);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.objectLabel')].some((label) => label.textContent.includes('Battery module'))`), true);
        await evaluate(window, `document.querySelector('#closeResults').click()`);
        await waitFor(window, `document.querySelector('#closeResultsDialog').open`, 'Closing results did not request confirmation.');
        assert.match(await evaluate(window, `document.querySelector('#closeResultsMessage').textContent`), /save the project with simulation results.*removed from this session/i);
        await evaluate(window, `document.querySelector('#confirmCloseResults').click()`);
        if (analysisHandle) {
            for (let attempt = 0; attempt < 100 && !(await analysisHandle.isDestroyed()); attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            assert.equal(await analysisHandle.isDestroyed(), true);
        }
        await waitFor(window, `document.querySelector('#resultTransport').hidden`, 'Confirming did not close the results.');
        assert.equal(await evaluate(window, `document.querySelector('[data-detail="nodes"]').classList.contains('active')`), false);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeName').disabled || [...document.querySelectorAll('#nodeModelActions button')].some((button) => button.disabled)`), false);
        assert.equal(await evaluate(window, `document.querySelector('#canvas').classList.contains('resultModeLocked')`), false);
        assert.equal(await evaluate(window, `document.querySelector('.addonTool:not([hidden])') === null`), true);
    });

    await run('multi-selection copies, pastes and deletes a connected graph fragment transactionally', async () => {
        await freshExample();
        const before = await evaluate(window, `({
            nodes: [...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length,
            relationships: document.querySelectorAll('.modelStatus span')[1].textContent
        })`);
        await clickElement(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module'))`);
        await settle(window, 'frame');
        await clickElement(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Enclosed air'))`, ['shift']);
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 2`, 'Real Shift-click did not add the second node.');
        // clickElement waits for a frame drawn on a still camera, which places the bundle label after the selection change,
        // however long a software-rendered frame takes.
        await clickElement(window, `document.querySelector('.bundleLabel')`, ['shift']);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), 2);
        const emptyPoint = await evaluate(window, `(() => { const bounds = document.querySelector('#webglContainer').getBoundingClientRect(); return { x: Math.round(bounds.left + 20), y: Math.round(bounds.top + 20) }; })()`);
        await window.mouseDown(emptyPoint, { button: 'left', clickCount: 1, modifiers: ['shift'] });
        await window.mouseUp(emptyPoint, { button: 'left', clickCount: 1, modifiers: ['shift'] });
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), 2);
        assert.equal(await evaluate(window, `document.querySelector('#copySelection').disabled`), false);
        await evaluate(window, `document.querySelector('#copySelection').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#pasteSelection').disabled`), false);
        await evaluate(window, `document.querySelector('#pasteSelection').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((label) => label.textContent.includes('Battery module copy')) && [...document.querySelectorAll('.objectLabel')].some((label) => label.textContent.includes('Enclosed air copy'))`, 'The copied graph fragment was not pasted.');
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length`), before.nodes + 2);
        assert.notEqual(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), before.relationships);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
        await waitFor(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length === ${before.nodes}`, 'Deleting the pasted multi-selection did not hide every copied node.');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length === ${before.nodes + 2}`, 'Undo did not restore the pasted multi-selection.');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length === ${before.nodes}`, 'Undoing paste did not remove the copied graph fragment.');
    });

    await run('Cmd/Ctrl+V pastes a single copied node', async () => {
        await freshExample();
        // Regression test: same root cause as the multi-selection test above (modelClipboard.read()
        // in src/preload.mjs used to decode the clipboard buffer with a bare `bytes.toString('utf8')`,
        // but `bytes` crosses the IPC boundary as a plain Uint8Array rather than a Node Buffer, so
        // the 'utf8' argument was silently ignored and JSON.parse always threw), isolated to the
        // keyboard-shortcut path (Cmd/Ctrl+C / Cmd/Ctrl+V) and a single node rather than a group.
        // Fixed by wrapping the read in Buffer.from(bytes) before .toString('utf8').
        const visibleNodeCount = () => `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length`;
        const before = await evaluate(window, visibleNodeCount());
        // Excludes "... copy" labels: a soft-deleted "Battery module copy" from an earlier test
        // can still be present (hidden) in the DOM, and a plain .includes('Battery module')
        // would match it too.
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module') && !label.textContent.includes('copy')).click()`);
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 1`, 'Node selection did not register before the copy shortcut.');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, ctrlKey: true, bubbles: true }))`);
        // Wait on the actual visible count rather than the "... copy" label text existing: a
        // stale, soft-deleted (hidden) copy from an earlier test would satisfy a text-only wait
        // immediately, before this test's own paste has actually landed.
        await waitFor(window, `${visibleNodeCount()} === ${before} + 1`, 'The Cmd/Ctrl+V shortcut did not paste the copied node.');
        assert.equal(await evaluate(window, visibleNodeCount()), before + 1);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `${visibleNodeCount()} === ${before}`, 'Undo did not remove the pasted node.');
    });

    await run('rectangle tool selects visible nodes without opening an inspector', async () => {
        await freshExample();
        await evaluate(window, `document.querySelector('[data-tool="rectangleSelect"]').click()`);
        // The preceding paste/undo tests leave the CSS2DRenderer mid-reposition (same cause as the
        // bundle-label wait in the multi-selection test above); under SwiftShader software rendering
        // this can still be settling when we read the label rects below, silently skewing the
        // computed drag rectangle. Wait for it to actually settle, like that test does.
        const labelRectsSelector = `[...document.querySelectorAll('.node-label-container')]
            .filter((label) => (label.textContent.includes('Battery module') || label.textContent.includes('Enclosed air')) && !label.textContent.includes('copy'))
            .map((label) => label.getBoundingClientRect())`;
        await waitForCanvasAtRest(window, 'The node labels');
        const bounds = await evaluate(window, `(() => {
            // Excludes "... copy" labels: a soft-deleted "Battery module copy" from the preceding
            // paste-undo test can still be present (hidden) in the DOM, and getBoundingClientRect()
            // on a display:none element returns all zeros, which would wreck these bounds.
            const labels = [...document.querySelectorAll('.node-label-container')];
            const battery = labels.find((label) => label.textContent.includes('Battery module') && !label.textContent.includes('copy')).getBoundingClientRect();
            const air = labels.find((label) => label.textContent.includes('Enclosed air') && !label.textContent.includes('copy')).getBoundingClientRect();
            return {
                start: { x: Math.round(Math.min(battery.left, air.left) - 220), y: Math.round(Math.min(battery.top, air.top) - 100) },
                end: { x: Math.round(Math.max(battery.right, air.right) + 20), y: Math.round(Math.max(battery.bottom, air.bottom) + 100) }
            };
        })()`);
        await window.mouseMove(bounds.start);
        await window.mouseDown(bounds.start, { button: 'left', clickCount: 1 });
        await window.mouseMove(bounds.end);
        await window.mouseUp(bounds.end, { button: 'left', clickCount: 1 });
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 2`, 'Rectangle selection did not select the two enclosed nodes.');
        const selected = await evaluate(window, `[...document.querySelectorAll('.node-label-container.selected')].map((label) => label.textContent)`);
        assert.ok(selected.some((label) => label.includes('Battery module')));
        assert.ok(selected.some((label) => label.includes('Enclosed air')));
        assert.equal(await evaluate(window, `document.querySelector('#nodeEditor').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('[data-tool="rectangleSelect"]').classList.contains('active')`), true);
        await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);
    });

    await run('selected nodes become a navigable undoable subsystem', async () => {
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), 2);
        assert.equal(await evaluate(window, `document.querySelector('#createSubsystem').disabled`), false);
        await evaluate(window, `document.querySelector('#createSubsystem').click()`);
        await waitFor(window, `document.querySelector('#subsystemDialog').open`, 'Subsystem dialog did not open.');
        await evaluate(window, `(() => { document.querySelector('#subsystemName').value = 'Thermal enclosure'; document.querySelector('#subsystemCreate').click(); })()`);
        await waitFor(window, `[...document.querySelectorAll('.subsystemLabel')].some((label) => label.textContent.includes('Thermal enclosure'))`, 'Subsystem proxy did not appear.');
        await waitFor(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => /Battery module|Enclosed air/.test(label.textContent) && !label.textContent.includes('copy')).every((label) => getComputedStyle(label).display === 'none')`, 'Wrapped nodes remained visible outside the subsystem.');
        // A click on the box selects it and opens its card; its Open button steps inside.
        await clickElement(window, `[...document.querySelectorAll('.subsystemLabel')].find((label) => label.textContent.includes('Thermal enclosure')).querySelector('strong')`);
        await waitFor(window, `!document.querySelector('#subsystemEditor').classList.contains('hidden') && document.querySelector('#subsystemEditorHeading').textContent === 'Thermal enclosure'`, 'Clicking the subsystem did not open its card.');
        assert.equal(await evaluate(window, `document.querySelector('#subsystemBreadcrumb').hidden`), true, 'A single click stepped inside.');
        await clickElement(window, `[...document.querySelectorAll('.subsystemLabel')].find((label) => label.textContent.includes('Thermal enclosure')).querySelector('.subsystemOpen')`);
        await waitFor(window, `!document.querySelector('#subsystemBreadcrumb').hidden`, 'Subsystem navigation did not enter the subsystem.');
        await waitFor(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => /Battery module|Enclosed air/.test(label.textContent) && !label.textContent.includes('copy')).every((label) => getComputedStyle(label).display !== 'none')`, 'Subsystem members did not appear after entering.');
        await evaluate(window, `document.querySelector('[data-subsystem-parent]').click()`);
        await waitFor(window, `document.querySelector('#subsystemBreadcrumb').hidden`, 'Subsystem navigation did not return to the model.');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length === 3`, 'Undo did not unwrap the subsystem.');
    });

    await run('icon-only toolstrip controls expose custom accessible tooltips', async () => {
        const controls = await evaluate(window, `[...document.querySelectorAll('.toolstrip .squareTool')].map((button) => ({
            label: button.getAttribute('aria-label'),
            tooltip: button.dataset.tooltip,
            nativeTitle: button.getAttribute('title')
        }))`);
        assert.ok(controls.length >= 5);
        assert.ok(controls.every((control) => control.label && control.tooltip && control.nativeTitle === null));
        // In the order a model is worked on, and what works on the whole model at the other end, by Run.
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.toolstrip .toolGroup')].map((group) => group.getAttribute('aria-label'))`), [
            'Build', 'Build from data', 'History', 'Select', 'Transform', 'Edit', 'Organise', 'Model and data'
        ]);
        assert.equal(await evaluate(window, `document.querySelector('#parametersButton').closest('.toolGroup').getAttribute('aria-label')`), 'Model and data', 'The parameters table is a model tool, not a titlebar one.');
        assert.equal(await evaluate(window, `document.querySelector('#titleBar #parametersButton')`), null);
    });

    await run('canvas help reflects left-click inspection and right-click action controls', async () => {
        const help = await evaluate(window, `document.querySelector('.canvasHelp').textContent.replace(/\\s+/g, ' ').trim()`);
        assert.match(help, /Left click inspect/);
        assert.match(help, /Right click actions/);
        assert.match(help, /Drag move or orbit/);
        assert.match(help, /Shift-drag pan/);
        assert.match(help, /Scroll or −\/\+ zoom/);
    });

    await run('left-click opens node and relationship inspectors', async () => {
        await freshExample();
        // The label shown, by its exact name (an undone paste leaves a hidden "Battery module copy" in the page).
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.getClientRects().length && label.querySelector('strong')?.textContent === 'Battery module').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#nodeEditorTitle').textContent`), 'Battery module');
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#edgeEditor .doneButton') === null`), true);
    });

    await run('live parameters expose labelled live-range bounds with validation', async () => {
        await freshRelationshipEditor();
        const labels = await evaluate(window, `[...document.querySelectorAll('.editorParameterRow:first-child .parameterField > span')].map((label) => label.textContent)`);
        assert.deepEqual(labels.slice(0, 5), ['Name', 'Symbol', 'Initial value', 'Unit', 'Mode']);
        await evaluate(window, `(() => {
            const mode = document.querySelector('.editorParameterRow:first-child [data-field="mode"]');
            mode.value = 'live';
            mode.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `!document.querySelector('.editorParameterRow:first-child .parameterControlFields').hidden`), true);
        const controlLabels = await evaluate(window, `[...document.querySelectorAll('.editorParameterRow:first-child .parameterControlFields .parameterField > span')].map((label) => label.textContent)`);
        assert.deepEqual(controlLabels, ['Live minimum', 'Live maximum', 'Live step']);
        await evaluate(window, `(() => {
            const minimum = document.querySelector('.editorParameterRow:first-child [data-control-field="minimum"]');
            minimum.value = '30';
            minimum.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        assert.match(await evaluate(window, `document.querySelector('.editorParameterRow:first-child .parameterControlError').textContent`), /Minimum must be less than maximum/);
    });

    await run('a live-mode parameter cannot also be marked tunable, and switching to live clears any existing tuning bounds', async () => {
        // Continues from the previous test, which already left this row's Mode at "live" --
        // fitting a parameter against measured data (Tuning) and interactively adjusting it
        // during a run (Live) are different phases of use, but a value that's live-adjustable at
        // run time has no fixed "fitted" baseline worth calibrating beforehand, so the two are
        // mutually exclusive here.
        assert.equal(await evaluate(window, `document.querySelector('.editorParameterRow:first-child [data-field="mode"]').value`), 'live');
        assert.equal(await evaluate(window, `document.querySelector('.editorParameterRow:first-child [data-field="tunable"]').disabled`), true);
        assert.equal(await evaluate(window, `document.querySelector('.editorParameterRow:first-child [data-field="tunable"]').checked`), false);

        // Switch back to constant: the checkbox re-enables, and checking it commits tuning bounds.
        await evaluate(window, `(() => {
            const mode = document.querySelector('.editorParameterRow:first-child [data-field="mode"]');
            mode.value = 'constant';
            mode.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('.editorParameterRow:first-child [data-field="tunable"]').disabled`), false);
        await evaluate(window, `(() => {
            const checkbox = document.querySelector('.editorParameterRow:first-child [data-field="tunable"]');
            checkbox.checked = true;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitFor(window, `!document.querySelector('.editorParameterRow:first-child .parameterTuningFields').hidden`,
            'Checking Tunable in constant mode did not reveal the fitting-bounds fields.');
        const editedEdgeName = await evaluate(window, `document.querySelector('#editEdgeName').value`);
        const firstParameterOf = (document_) => document_.edges.find((edge) => edge.name === editedEdgeName).parameters[0];
        let document_ = await evaluate(window, `window.__debugCausalInference.document()`);
        assert.ok(firstParameterOf(document_).tuning, 'Expected the committed document to carry tuning bounds after checking Tunable.');

        // Switching back to live must clear that tuning data, not just hide it behind a disabled checkbox.
        await evaluate(window, `(() => {
            const mode = document.querySelector('.editorParameterRow:first-child [data-field="mode"]');
            mode.value = 'live';
            mode.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('.editorParameterRow:first-child [data-field="tunable"]').checked`), false);
        assert.equal(await evaluate(window, `document.querySelector('.editorParameterRow:first-child [data-field="tunable"]').disabled`), true);
        document_ = await evaluate(window, `window.__debugCausalInference.document()`);
        assert.equal(firstParameterOf(document_).tuning, undefined, 'Switching Mode to Live should clear any existing tuning bounds, not just hide them.');
    });

    await run('equation editor switches between visual and LaTeX modes', async () => {
        await evaluate(window, `document.querySelector('[data-equation-mode="latex"]').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#editEdgeMathField').hidden && document.querySelector('#editEdgeEquation').hidden`), false);
        await evaluate(window, `document.querySelector('[data-equation-mode="visual"]').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#editEdgeMathField').hidden && document.querySelector('#editEdgeEquation').hidden`), true);
    });

    await run('relationship editor authors an inline C++ provider implementation', async () => {
        await freshRelationshipEditor();
        const kindSelect = `document.querySelector('#editEdgeImplementationKind')`;
        await evaluate(window, `(() => {
            const select = ${kindSelect};
            select.value = 'cpp';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await isRenderedVisible(window, '#editEdgeProviderSection'), true);
        assert.equal(await isRenderedVisible(window, '#editEdgeEquationHeading'), false);
        assert.equal(await isRenderedVisible(window, '#editEdgeMathField'), false);
        assert.match(await evaluate(window, `document.querySelector('#editEdgeProviderSource').value`), /#include <konjugate\/relationshipProvider\.hpp>/);

        const source = 'int main() {}';
        await evaluate(window, `(() => {
            const textarea = document.querySelector('#editEdgeProviderSource');
            textarea.value = ${JSON.stringify(source)};
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeProviderSource').value`), source);

        const bindingCountBefore = await evaluate(window, `document.querySelectorAll('.providerBindingRow').length`);
        await evaluate(window, `document.querySelector('#editAddProviderBinding').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.providerBindingRow').length`), bindingCountBefore + 1);

        await evaluate(window, `(() => {
            const key = document.querySelector('.providerBindingRow:last-child [data-field="key"]');
            key.value = 'delta';
            key.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('.providerBindingRow:last-child [data-field="key"]').value`), 'delta');

        await evaluate(window, `(() => {
            const outputKey = document.querySelector('#editProviderOutputKey');
            outputKey.value = 'gradient';
            outputKey.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#editProviderOutputKey').value`), 'gradient');

        await evaluate(window, `(() => {
            window.confirm = () => true;
            document.querySelector('#editInsertProviderTemplate').click();
        })()`);
        const regeneratedSource = await evaluate(window, `document.querySelector('#editEdgeProviderSource').value`);
        assert.match(regeneratedSource, /ScalarPort\{"delta", "delta", ""\}/);
        assert.match(regeneratedSource, /ScalarPort\{"gradient", "gradient", ""\}/);

        // Switch back to Equation so the following equation-editor tests see their expected state.
        await evaluate(window, `(() => {
            const select = ${kindSelect};
            select.value = 'equation';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await isRenderedVisible(window, '#editEdgeEquationHeading'), true);
        assert.equal(await isRenderedVisible(window, '#editEdgeMathField'), true);
        assert.equal(await isRenderedVisible(window, '#editEdgeProviderSection'), false);
    });

    await run('provider editor window syntax-highlights, validates and applies C++ source', async () => {
        const kindSelect = `document.querySelector('#editEdgeImplementationKind')`;
        await evaluate(window, `(() => {
            const select = ${kindSelect};
            select.value = 'cpp';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        const validCpp = await evaluate(window, `document.querySelector('#editEdgeProviderSource').value`);
        const beforeEditorOpen = driver.allHandles();
        await evaluate(window, `document.querySelector('#editOpenProviderEditor').click()`);

        const editorWindow = await driver.waitForNewHandle(beforeEditorOpen, { titleIncludes: 'Provider source' });
        await waitFor(editorWindow, `document.querySelector('.cm-editor') !== null`, 'CodeMirror did not mount in the provider editor window.');
        assert.equal(await evaluate(editorWindow, `document.querySelector('#editorKindLabel').textContent`), 'C++');

        // body { user-select: none } now covers this window's chrome (see styles.css) -- confirm
        // that didn't drag CodeMirror's own editable content down with it. A real double-click
        // (word selection), not a scripted Selection API call, since user-select specifically
        // governs drag/click-driven selection, not programmatic Range/Selection calls.
        const codeWordPoint = await evaluate(editorWindow, `(() => {
            const line = document.querySelector('.cm-line');
            const r = line.getBoundingClientRect();
            return { x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) };
        })()`);
        await editorWindow.mouseMove(codeWordPoint);
        await editorWindow.mouseDown(codeWordPoint, { button: 'left', clickCount: 1 });
        await editorWindow.mouseUp(codeWordPoint, { button: 'left', clickCount: 1 });
        await editorWindow.mouseDown(codeWordPoint, { button: 'left', clickCount: 2 });
        await editorWindow.mouseUp(codeWordPoint, { button: 'left', clickCount: 2 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.ok(await evaluate(editorWindow, `window.getSelection().toString().length`) > 0,
            'Double-clicking CodeMirror content did not select a word -- user-select: none on the window body may have leaked into the editor.');

        // These checks wait on a real clang invocation (plus the linter's own debounce),
        // which is far more variable than a DOM/JS operation, so give it real headroom
        // rather than the default timeout tuned for in-process checks.
        const compileCheckTimeout = 20000;
        await waitFor(editorWindow, `document.querySelector('#editorStatus').classList.contains('valid')`,
            'The starter template was not reported valid by the C++ syntax check.', compileCheckTimeout);

        await evaluate(editorWindow, `(() => {
            const view = window.__providerEditorView;
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'this is not valid c plus plus' } });
        })()`);
        await waitFor(editorWindow, `document.querySelector('#editorStatus').classList.contains('invalid')`,
            'Invalid C++ source was not flagged by the syntax check.', compileCheckTimeout);

        await evaluate(editorWindow, `(() => {
            const view = window.__providerEditorView;
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(validCpp)} } });
        })()`);
        await waitFor(editorWindow, `document.querySelector('#editorStatus').classList.contains('valid')`,
            'Restoring valid C++ source did not clear the invalid status.', compileCheckTimeout);

        await evaluate(editorWindow, `document.querySelector('#applyButton').click()`);
        await waitFor(window, `document.querySelector('#editEdgeProviderSource').value === ${JSON.stringify(validCpp)}`,
            'Applying from the provider editor window did not update the relationship editor.');

        await evaluate(editorWindow, `document.querySelector('#close').click()`);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.ok(!driver.allHandles().includes(editorWindow), 'The provider editor window did not close.');
    }, { skip: !driver.capabilities.addons && 'the provider source editor window has no web-edition equivalent' });

    await run('relationship editor returns to equation mode after a provider-editor session', async () => {
        // Switch back to Equation so the following equation-editor tests see their expected state,
        // whether or not the provider-editor scenario above actually ran (see its own skip reason).
        await evaluate(window, `(() => {
            const select = document.querySelector('#editEdgeImplementationKind');
            select.value = 'equation';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await isRenderedVisible(window, '#editEdgeEquationHeading'), true);
        assert.equal(await isRenderedVisible(window, '#editEdgeMathField'), true);
        assert.equal(await isRenderedVisible(window, '#editEdgeProviderSection'), false);
    });

    await run('C++ validation rejects unknown equation symbols while typing', async () => {
        await freshRelationshipEditor();
        const originalEquation = await evaluate(window, `document.querySelector('#editEdgeMathField').value`);
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue('randomCharacters');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await settle(window, 'validation');
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && document.querySelector('#validationSummary').classList.contains('error')`, 'Unknown equation symbols were not rejected by the C++ validator.');
        assert.match(await evaluate(window, `document.querySelector('#validationIssues').textContent`), /randomCharacters/);
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue(${JSON.stringify(originalEquation)});
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await settle(window, 'validation');
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && !document.querySelector('#validationSummary').classList.contains('error')`, 'Restoring the valid equation did not clear its validation error.');
    });

    await run('C++ validation accepts \\operatorname{} LaTeX for named functions like Max', async () => {
        await freshRelationshipEditor();
        // Regression test: an AI-generated equation once used \operatorname{Max}(...) --
        // standard LaTeX for an unfamiliar function name, and a reasonable thing for a model to
        // write even after being steered toward the shorter \max(...) form -- which the engine's
        // validator rejected as both an unsupported command and (since only the backslash+word
        // token was stripped, leaving "{Max}" behind) an unknown symbol.
        const originalEquation = await evaluate(window, `document.querySelector('#editEdgeMathField').value`);
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue(${JSON.stringify('\\operatorname{Max}(1, 2)')});
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await settle(window, 'validation');
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`, 'Engine validation did not run.');
        assert.equal(await evaluate(window, `document.querySelector('#validationSummary').classList.contains('error')`), false, '\\operatorname{Max}(...) should be accepted the same as \\max(...).');

        // A name \operatorname{} doesn't recognize must still be rejected clearly, so this isn't
        // just papering over the shape of the LaTeX regardless of what it actually names.
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue(${JSON.stringify('\\operatorname{Bogus}(1, 2)')});
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await settle(window, 'validation');
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && document.querySelector('#validationSummary').classList.contains('error')`, 'An unrecognized \\operatorname{} name was not rejected.');
        assert.match(await evaluate(window, `document.querySelector('#validationIssues').textContent`), /Bogus/);

        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue(${JSON.stringify(originalEquation)});
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await settle(window, 'validation');
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && !document.querySelector('#validationSummary').classList.contains('error')`, 'Restoring the valid equation did not clear its validation error.');
    });

    await run('Backspace edits MathLive without deleting the relationship', async () => {
        await freshRelationshipEditor();
        const equationBefore = await evaluate(window, `document.querySelector('#editEdgeMathField').value`);
        // A real pointer click (rather than a bare .focus() call) reliably restores keyboard
        // routing into MathLive's custom element, matching how an actual user would interact
        // with it after switching this relationship away from and back to Equation mode. The field can be below the
        // card's fold, as a person would find it, so it is scrolled to first.
        await evaluate(window, `document.querySelector('#editEdgeMathField').scrollIntoView({ block: 'center' })`);
        await clickElement(window, `document.querySelector('#editEdgeMathField')`);
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.focus();
            field.executeCommand('selectAll');
        })()`);
        await window.keyDown('Backspace');
        await window.keyUp('Backspace');
        await waitFor(window, `document.querySelector('#editEdgeMathField').value !== ${JSON.stringify(equationBefore)}`, 'Backspace did not edit the equation.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue(${JSON.stringify(equationBefore)});
            field.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#edgeEditor [data-close-card]').click();
        })()`);
    });

    await run('a node\'s own part a file holds as a C++ program opens from its chip, and is still written there', async () => {
        await freshExample();
        const document_ = JSON.parse(await decodeProjectFile(await readFile(join(process.cwd(), 'examples', 'thermalManagement.kjt'))));
        const air = document_.nodes.find((node) => node.name === 'Enclosed air');
        air.sourceTerms.push({
            id: 9001, state: air.states[0].symbol, expression: '',
            parameters: [{ id: 9002, name: 'Source gain', symbol: 'sourceGain', value: 2, mode: 'constant' }],
            implementation: { kind: 'cpp', providerApiVersion: 1, source: '', bindings: [], output: { key: '', stateId: air.states[0].id } }
        });
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(document_)})`);
        await waitFor(window, `Boolean([...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Enclosed air')))`, 'The model did not load.');
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Enclosed air')).click()`);
        await waitFor(window, `Boolean(document.querySelector('#nodeEditorStates .partChip.own.program'))`, 'The own program has no chip in its state\'s equation.');
        await evaluate(window, `document.querySelector('#nodeEditorStates .partChip.own.program').click()`);
        assert.equal(await isRenderedVisible(window, '#sourceTermEditor'), true);
        assert.equal(await evaluate(window, `document.querySelector('#termImplementationKind').value`), 'cpp');
        assert.equal(await evaluate(window, `document.querySelector('#termImplementationKind option[value="python"]').hidden`), true, 'A part per state can be made a Python program.');
        assert.equal(await isRenderedVisible(window, '#termProviderSection'), true);
        assert.equal(await isRenderedVisible(window, '#termEquationHeading'), false);

        await evaluate(window, `(() => {
            document.querySelector('#termAddProviderBinding').click();
        })()`);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('#termProviderBindings option')].some((option) => option.textContent === 'sourceGain')`), true, 'The program\'s own parameter is not offered to its bindings.');
        await evaluate(window, `(() => {
            const key = document.querySelector('#termProviderBindings .providerBindingRow [data-field="key"]');
            key.value = 'temperature';
            key.dispatchEvent(new Event('change', { bubbles: true }));
            const outputKey = document.querySelector('#termProviderOutputKey');
            outputKey.value = 'heatRate';
            outputKey.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);

        await evaluate(window, `(() => {
            window.confirm = () => true;
            document.querySelector('#termInsertProviderTemplate').click();
        })()`);
        const regenerated = await evaluate(window, `document.querySelector('#termProviderSource').value`);
        assert.match(regenerated, /ScalarPort\{"temperature", "temperature", ""\}/);
        assert.match(regenerated, /ScalarPort\{"heatRate", "heatRate", ""\}/);

        await settle(window, 'validation');
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`,
            'The programmable source term did not reach native validation.');
        assert.doesNotMatch(await evaluate(window, `document.querySelector('#validationIssues')?.textContent ?? ''`), /provider|programmable/i);

        // Clean up: remove the source term so later tests see the original model state.
        await evaluate(window, `document.querySelector('[data-delete-source-term]').click()`);
        assert.equal(await isRenderedVisible(window, '#sourceTermEditor'), false);
        assert.equal(await isRenderedVisible(window, '#nodeEditor'), true);
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);
    });

    await run('node appearance changes and participates in undo', async () => {
        await freshExample();
        const reopenAppearanceTab = `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click(); document.querySelector('[data-editor-tab="appearance"]').click()`;
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#nodeModelActions').hidden`), false);
        await evaluate(window, `document.querySelector('[data-editor-tab="appearance"]').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#nodeModelActions').hidden`), false, 'The node\'s actions are on every tab.');
        const originalColor = await evaluate(window, `document.querySelector('#editNodeColor').value`);

        const consoleMessages = await captureConsoleMessages(window, async () => {
            await evaluate(window, `(() => { const field = document.querySelector('#editNodeShape'); field.value = 'sphere'; field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), 'sphere');
            await evaluate(window, reopenAppearanceTab);
            assert.equal(await evaluate(window, `document.querySelector('#editNodeColor').value`), originalColor);
            await evaluate(window, `document.querySelector('#editBrowseShapeLibrary').click()`);
            await waitFor(window, `document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not open.');
            await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/spurGear"]').click()`);
            await waitFor(window, `!document.querySelector('#shapeLibraryDetailContent').hidden && document.querySelector('#shapeLibraryDetailTitle').textContent === 'Spur Gear'`, 'The shape preview did not populate.');
            await evaluate(window, `document.querySelector('#shapeLibraryApply').click()`);
            await waitFor(window, `!document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not close after applying a shape.');
            await evaluate(window, reopenAppearanceTab);
            assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), '');
            assert.equal(await evaluate(window, `document.querySelector('#editNodeColor').value`), originalColor);
        });
        // Regression: switching the primitive shape (or applying a file/library shape) used to
        // build its appearance patch without a colour field, which wiped definition.color to
        // undefined outright (no fallback to the existing value). That failure doesn't reject
        // any of the assertions above -- it throws later, inside the click handler that reopens
        // the editor and reads definition.color.toString(16), and a synthetic element.click()
        // swallows an exception thrown inside its own listener rather than propagating it, so
        // only the console (captured here) actually catches it.
        assert.deepEqual(consoleMessages.filter((message) => /color|toString/i.test(message)), []);

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, reopenAppearanceTab);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), 'box');
        assert.equal(await evaluate(window, `document.querySelector('#editNodeColor').value`), originalColor);
    });

    // A node made as a person makes one: Add, then Node, then named and its one state filled in, in the card that opens.
    const makeNode = async (win, name, state) => {
        await evaluate(win, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="node"]').click()`);
        await waitFor(win, `!document.querySelector('#nodeEditor').classList.contains('hidden') && document.querySelector('#editNodeName').value === 'New node'`, 'New node did not open its card.');
        await evaluate(win, `(() => {
            const set = (selector, value) => { const input = document.querySelector(selector); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
            set('#editNodeName', ${JSON.stringify(name)});
            for (const [field, value] of Object.entries(${JSON.stringify(state)})) set('#nodeEditorStates .editorStateRow [data-field="' + field + '"]', value);
        })()`);
        await waitFor(win, `document.querySelector('#editNodeName').value === ${JSON.stringify(name)} && Boolean(document.querySelector('#nodeEditorStates .stateCard[data-symbol=${JSON.stringify(state.symbol)}]'))`, `${name} was not made as asked.`);
    };
    const savedProject = async () => JSON.parse(await evaluate(window, `JSON.stringify(window.__debugProject.serialize())`));
    const typeInto = (selector, value, event = 'change') => evaluate(window, `(() => { const input = ${selector}; input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
    const undoRedo = async (which) => {
        await evaluate(window, `document.activeElement?.blur()`);
        const before = await evaluate(window, `JSON.stringify(window.__debugProject.serialize())`);
        await clickElement(window, `document.querySelector('#${which}Button')`);
        await waitFor(window, `JSON.stringify(window.__debugProject.serialize()) !== ${JSON.stringify(before)}`, `${which === 'undo' ? 'Undo' : 'Redo'} changed nothing.`);
    };

    await run('shape library searches, filters by domain and previews and applies a shape', async () => {
        await freshExample();
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click(); document.querySelector('[data-editor-tab="appearance"]').click()`);
        const statusBeforeSelect = await evaluate(window, `document.querySelector('#editGeometryStatus').textContent`);
        await evaluate(window, `document.querySelector('#editBrowseShapeLibrary').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not open.');
        const shapeCount = await evaluate(window, `document.querySelectorAll('.shapeLibraryItem').length`);
        assert.ok(shapeCount > 0, 'Shape library did not list any shapes.');
        // Domain chip order follows first-appearance order in assets/shapes/manifest.json, not
        // alphabetical order -- "Robotics" was added between the structural and electrical
        // shapes when the robotics shape set was bundled, which is why it lands here rather than
        // at the end.
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('#shapeLibraryDomains button')].map((button) => button.textContent)`),
            ['All', 'Mechanical', 'Structural', 'Robotics', 'Electrical', 'Fluid']);
        assert.equal(await evaluate(window, `document.querySelector('#shapeLibraryDetailEmpty').hidden`), false, 'The detail pane should start with nothing selected.');
        assert.equal(await evaluate(window, `document.querySelector('#shapeLibraryDetailContent').hidden`), true);

        // Cards get a static thumbnail passively -- without clicking anything -- generated by a
        // single reused offscreen renderer and cached, distinct from the live rotating preview.
        await waitFor(window,
            `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/spurGear"] img.examplesExplorerThumb')?.getAttribute('src')`,
            'The Spur Gear card did not get a thumbnail.');
        assert.ok((await evaluate(window,
            `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/spurGear"] img.examplesExplorerThumb').src`)).startsWith('data:image/png'),
            'The thumbnail src was not a PNG data URL.');

        const searchMessages = await captureConsoleMessages(window, async () => {
            await evaluate(window, `(() => { const input = document.querySelector('#shapeLibrarySearch'); input.value = 'gear'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.shapeLibraryItem b')].map((element) => element.textContent)`), ['Spur Gear']);
            assert.equal(await evaluate(window, `document.querySelector('#shapeLibraryEmpty').hidden`), true);

            await evaluate(window, `(() => { const input = document.querySelector('#shapeLibrarySearch'); input.value = 'no such shape'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            assert.equal(await evaluate(window, `document.querySelectorAll('.shapeLibraryItem').length`), 0);
            assert.equal(await evaluate(window, `document.querySelector('#shapeLibraryEmpty').hidden`), false);

            await evaluate(window, `(() => { const input = document.querySelector('#shapeLibrarySearch'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await evaluate(window, `[...document.querySelectorAll('#shapeLibraryDomains button')].find((button) => button.textContent === 'Fluid').click()`);
        });
        // Regression: a thumbnail queued for a shape that then got filtered/searched away must
        // not throw trying to write into its now-detached card -- only the console (captured
        // here) would catch that, since it happens asynchronously well after these calls return.
        assert.deepEqual(searchMessages.filter((message) => /error|uncaught|exception/i.test(message)), []);
        // A shape's id path prefix reflects where its file lives, not every domain it's tagged
        // under -- a multi-domain shape like robotics/propellerRotor (tagged both "robotics" and
        // "fluid", since a propeller genuinely is an aerodynamic part) correctly appears here
        // despite its "robotics/" id. Check the rendered domain text instead of the id prefix.
        const fluidShapes = await evaluate(window,
            `[...document.querySelectorAll('.shapeLibraryItem')].map((item) => item.querySelector('small').textContent)`);
        assert.ok(fluidShapes.length > 0 && fluidShapes.every((domainText) => domainText.includes('Fluid')));

        // Switching back to "All" must show the Spur Gear thumbnail immediately from cache,
        // rather than a blank tile that gets refilled -- proving it wasn't regenerated.
        await evaluate(window, `[...document.querySelectorAll('#shapeLibraryDomains button')].find((button) => button.textContent === 'All').click()`);
        assert.ok((await evaluate(window,
            `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/spurGear"] img.examplesExplorerThumb')?.src`) ?? '').startsWith('data:image/png'),
            'The cached thumbnail was not shown immediately after re-filtering.');

        // Selecting a shape (a STEP file, exercising the occt-import-js path) previews it as a
        // live rotating 3D render rather than applying it immediately -- nothing on the node
        // should change until Apply is clicked explicitly.
        await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/lBracket"]').click()`);
        assert.equal(await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/lBracket"]').classList.contains('selected')`), true);
        await waitFor(window, `!document.querySelector('#shapeLibraryDetailContent').hidden && document.querySelector('#shapeLibraryDetailTitle').textContent === 'L-Bracket'`, 'The shape preview did not populate.');
        assert.equal(await evaluate(window, `document.querySelector('#editGeometryStatus').textContent`), statusBeforeSelect, 'Selecting a shape must not apply it yet.');

        // Switching the selection before the previous preview finishes loading (both requests
        // are in flight together here) must not leave a stale mesh/title from the shape that's
        // no longer selected -- this is the revision-guard in selectShapeLibraryPreview.
        await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="fluid/valveBody"]').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDetailTitle').textContent === 'Valve Body'`, 'Switching the selected shape did not update the preview.');

        // Apply a STEP-format shape (mechanical/lBracket) via the editor path.
        await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/lBracket"]').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDetailTitle').textContent === 'L-Bracket'`, 'The shape preview did not populate.');
        await evaluate(window, `document.querySelector('#shapeLibraryApply').click()`);
        await waitFor(window, `!document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not close after applying a shape.');
        assert.equal(await evaluate(window, `document.querySelector('#editGeometryStatus').textContent`), 'L-Bracket applied');
        assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), '');

        // Apply an STL-format shape to a node just made, from its card, as to any node.
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="node"]').click()`);
        await evaluate(window, `document.querySelector('#nodeEditor [data-editor-tab="appearance"]').click()`);
        await evaluate(window, `document.querySelector('#editBrowseShapeLibrary').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not open from a new node\'s card.');
        await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="fluid/valveBody"]').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDetailTitle').textContent === 'Valve Body'`, 'The shape preview did not populate.');
        await evaluate(window, `document.querySelector('#shapeLibraryApply').click()`);
        await waitFor(window, `!document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not close after applying a shape.');
        assert.equal(await evaluate(window, `document.querySelector('#editGeometryStatus').textContent`), 'Valve Body applied');
        assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), '');
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
    });

    await run('disabling a node greys it out, cascades to its edges, and is undoable', async () => {
        await freshExample();
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleNodeEnabled').textContent`), 'Disable node');
        assert.equal(await evaluate(window, `document.querySelector('.node-label-container.disabled') === null`), true);

        await evaluate(window, `document.querySelector('#toggleNodeEnabled').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleNodeEnabled').textContent`), 'Enable node');
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).closest('.node-label-container').classList.contains('disabled')`), true);

        // The edge cascades (renders as disabled) even though its own `enabled` field never
        // changed -- only the node's did. Its own toggle button must still read "Disable relationship".
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleEdgeEnabled').textContent`), 'Disable relationship');
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);

        // Undo restores the node (and, since nothing about the edge's own state changed, its
        // cascaded edges too) in one step.
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleNodeEnabled').textContent`), 'Disable node');
        assert.equal(await evaluate(window, `document.querySelector('.node-label-container.disabled') === null`), true);
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);
    });

    await run('disabling an edge directly is independent of its endpoint nodes and is undoable', async () => {
        await freshExample();
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleEdgeEnabled').textContent`), 'Disable relationship');

        await evaluate(window, `document.querySelector('#toggleEdgeEnabled').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleEdgeEnabled').textContent`), 'Enable relationship');
        // Its endpoint nodes are untouched -- only the edge itself is disabled.
        assert.equal(await evaluate(window, `document.querySelector('.node-label-container.disabled') === null`), true);
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleEdgeEnabled').textContent`), 'Disable relationship');
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
    });

    await run('Connect to chooses a canvas endpoint and makes the relationship, opening its card on its new part', async () => {
        await freshExample();
        const relationshipCountBefore = await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Electrical losses')).click()`);
        await evaluate(window, `document.querySelector('#connectFromNode').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#endpointPickBanner').hidden`), true);
        assert.match(await evaluate(window, `document.querySelector('#endpointPickTitle').textContent`), /target/, 'Connect to did not start with the source chosen.');
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#endpointPickBanner').hidden`), true);
        // Made at once, its card open on Equations with its part's field, and no parameters: one is made from what is typed.
        assert.equal(await evaluate(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#edgeEditor [data-editor-tab].active').dataset.editorTab`), 'equations');
        assert.notEqual(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipCountBefore);
        const made = (await savedProject()).edges.find((edge) => edge.name === 'New relationship');
        const nodes = (await savedProject()).nodes;
        assert.equal(nodes.find((node) => node.id === made.source.nodeId).name, 'Electrical losses');
        assert.equal(nodes.find((node) => node.id === made.target.nodeId).name, 'Battery module');
        assert.deepEqual(made.parameters, [], 'A new relationship came with a parameter nobody asked for.');
        assert.equal(made.equationModel.output.role, 'target');
        // One undo takes it away.
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipCountBefore);
    });

    // Excludes "... copy" matches: a soft-deleted "... copy" node from an earlier paste test can
    // still be present (hidden) in the DOM, and a plain .includes() would match it too, since
    // e.g. "Enclosed air copy" contains "Enclosed air" as a substring.
    const electricalLossesLabel = `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Electrical losses') && !label.textContent.includes('copy'))`;
    const batteryModuleLabel = `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module') && !label.textContent.includes('copy'))`;
    const enclosedAirLabel = `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Enclosed air') && !label.textContent.includes('copy'))`;
    const batteryBundleLabel = `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module') && !label.textContent.includes('copy'))`;

    await run('right-clicking a node opens a context menu with connect, disable and delete', async () => {
        await freshExample();
        await rightClickElement(window, electricalLossesLabel);
        await waitFor(window, `!document.querySelector('#nodeContextMenu').classList.contains('hidden')`, 'Right-clicking a node did not open its context menu.');
        assert.equal(await evaluate(window, `${electricalLossesLabel}.closest('.node-label-container').classList.contains('selected')`), true);
        assert.equal(await isRenderedVisible(window, '#nodeContextConnect'), true);
        assert.equal(await isRenderedVisible(window, '#nodeContextToggle'), true);
        assert.equal(await isRenderedVisible(window, '#nodeContextDisableAll'), false);
        assert.equal(await evaluate(window, `document.querySelector('#nodeContextToggleLabel').textContent`), 'Disable node');

        // "Connect from here" reuses the editor's own endpoint-pick flow.
        await evaluate(window, `document.querySelector('#nodeContextConnect').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#nodeContextMenu').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `!document.querySelector('#endpointPickBanner').hidden`), true);
        assert.match(await evaluate(window, `document.querySelector('#endpointPickTitle').textContent`), /target/, 'Connect from here did not take this node as the source.');
        await evaluate(window, `${batteryModuleLabel}.click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`), true);
        await evaluate(window, `document.querySelector('#undoButton').click()`);

        // Disable via the context menu toggle, then delete via the context menu, both undoable.
        await rightClickElement(window, electricalLossesLabel);
        await waitFor(window, `!document.querySelector('#nodeContextMenu').classList.contains('hidden')`, 'The node context menu did not reopen.');
        await evaluate(window, `document.querySelector('#nodeContextToggle').click()`);
        assert.equal(await evaluate(window, `${electricalLossesLabel}.closest('.node-label-container').classList.contains('disabled')`), true);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `${electricalLossesLabel}.closest('.node-label-container').classList.contains('disabled')`), false);

        const before = await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`);
        await rightClickElement(window, electricalLossesLabel);
        await waitFor(window, `!document.querySelector('#nodeContextMenu').classList.contains('hidden')`, 'The node context menu did not reopen for delete.');
        await evaluate(window, `document.querySelector('#nodeContextDelete').click()`);
        await waitFor(window, `document.querySelectorAll('.modelStatus span')[0].textContent !== '${before}'`, 'The context menu delete action did not remove the node.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await waitFor(window, `document.querySelectorAll('.modelStatus span')[0].textContent === '${before}'`, 'Undo did not restore the deleted node.');
    });

    await run('right-clicking a multi-selected node offers bulk disable/enable all', async () => {
        await freshExample();
        // Shift-clicks both nodes rather than a plain click + shift-click: a plain click also
        // opens the node editor, and this deep into the suite the editor panel can overlap
        // where the second label renders, making a real mouse click land on the panel instead.
        await clickElement(window, batteryModuleLabel, ['shift']);
        await settle(window, 'frame');
        await clickElement(window, enclosedAirLabel, ['shift']);
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 2`, 'Shift-click did not build a two-node selection.');

        await rightClickElement(window, enclosedAirLabel);
        await waitFor(window, `!document.querySelector('#nodeContextMenu').classList.contains('hidden')`, 'Right-clicking a selected node did not open the context menu.');
        // Right-clicking a member of an existing multi-selection must not collapse it to one node.
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), 2);
        assert.equal(await isRenderedVisible(window, '#nodeContextConnect'), false);
        assert.equal(await isRenderedVisible(window, '#nodeContextToggle'), false);
        assert.equal(await isRenderedVisible(window, '#nodeContextDisableAll'), true);
        assert.equal(await isRenderedVisible(window, '#nodeContextEnableAll'), true);
        assert.equal(await evaluate(window, `document.querySelector('#nodeContextDeleteLabel').textContent`), 'Delete 2 nodes');

        await evaluate(window, `document.querySelector('#nodeContextDisableAll').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.disabled').length`), 2);

        // Chains straight into "enable all" while the selection is still intact -- undo/redo
        // deliberately clear the selection (see undo()/redo() in renderer.mjs), so exercising
        // that separately below rebuilds the selection first rather than assuming it survives.
        await rightClickElement(window, enclosedAirLabel);
        await waitFor(window, `!document.querySelector('#nodeContextMenu').classList.contains('hidden')`, 'The node context menu did not reopen for enable-all.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), 2);
        await evaluate(window, `document.querySelector('#nodeContextEnableAll').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.disabled').length`), 0);

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.disabled').length`), 2);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.disabled').length`), 0);
        await evaluate(window, `document.querySelector('#redoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.disabled').length`), 2);
        await evaluate(window, `document.querySelector('#redoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.disabled').length`), 0);
    });

    await run('right-clicking an edge label opens a context menu with disable and delete', async () => {
        await freshExample();
        await waitFor(window, `Boolean(${batteryBundleLabel})`, 'Battery module bundle label was not available.');
        await rightClickElement(window, batteryBundleLabel);
        await waitFor(window, `!document.querySelector('#edgeContextMenu').classList.contains('hidden')`, 'Right-clicking an edge did not open its context menu.');
        assert.equal(await evaluate(window, `document.querySelector('#edgeContextToggleLabel').textContent`), 'Disable relationship');

        await evaluate(window, `document.querySelector('#edgeContextToggle').click()`);
        assert.equal(await evaluate(window, `document.querySelector('.node-label-container.disabled') === null`), true);
        assert.match(await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).textContent`), /Disabled/);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.doesNotMatch(await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).textContent`), /Disabled/);
    });

    await run('select all via Ctrl/Cmd+A and via the canvas context menu', async () => {
        const totalNodes = await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === ${totalNodes.match(/\d+/)[0]}`, 'Ctrl/Cmd+A did not select every node.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), Number(totalNodes.match(/\d+/)[0]));

        const emptyPoint = await evaluate(window, `(() => { const bounds = document.querySelector('#webglContainer').getBoundingClientRect(); return { x: Math.round(bounds.left + 20), y: Math.round(bounds.top + 20) }; })()`);
        await window.mouseMove(emptyPoint);
        await window.mouseDown(emptyPoint, { button: 'left', clickCount: 1 });
        await window.mouseUp(emptyPoint, { button: 'left', clickCount: 1 });
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 0`, 'Clicking blank canvas did not clear the select-all selection.');

        await window.mouseMove(emptyPoint);
        await window.mouseDown(emptyPoint, { button: 'right', clickCount: 1 });
        await window.mouseUp(emptyPoint, { button: 'right', clickCount: 1 });
        await waitFor(window, `!document.querySelector('#addPalette').classList.contains('hidden')`, 'Right-clicking blank canvas did not open the add palette.');
        await evaluate(window, `document.querySelector('[data-action="select-all"]').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#addPalette').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), Number(totalNodes.match(/\d+/)[0]));
        await window.mouseMove(emptyPoint);
        await window.mouseDown(emptyPoint, { button: 'left', clickCount: 1 });
        await window.mouseUp(emptyPoint, { button: 'left', clickCount: 1 });
    });

    await run('right-click-drag pans without opening a context menu, but a stationary right-click still does', async () => {
        const start = await evaluate(window, `(() => { const bounds = document.querySelector('#webglContainer').getBoundingClientRect(); return { x: Math.round(bounds.left + bounds.width * 0.7), y: Math.round(bounds.top + 40) }; })()`);
        const end = { x: start.x + 60, y: start.y + 40 };

        await window.mouseMove(start);
        await window.mouseDown(start, { button: 'right', clickCount: 1 });
        await window.mouseMove(end);
        await window.mouseUp(end, { button: 'right', clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(await evaluate(window, `document.querySelector('#addPalette').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#nodeContextMenu').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#edgeContextMenu').classList.contains('hidden')`), true);

        await window.mouseMove(start);
        await window.mouseDown(start, { button: 'right', clickCount: 1 });
        await window.mouseUp(start, { button: 'right', clickCount: 1 });
        await waitFor(window, `!document.querySelector('#addPalette').classList.contains('hidden')`, 'A stationary right-click did not open the add palette.');
        await window.mouseMove(start);
        await window.mouseDown(start, { button: 'left', clickCount: 1 });
        await window.mouseUp(start, { button: 'left', clickCount: 1 });
    });

    // A relationship made as a person makes one with ends the canvas may not show: Add, then Edge, then each end chosen from
    // the pick's list by name. Its card opens on it.
    const newRelationship = async (from, to) => {
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="edge"]').click()`);
        for (const name of [from, to]) {
            await evaluate(window, `(() => {
                const list = document.querySelector('#endpointPickList');
                const option = [...list.querySelectorAll('option')].find((candidate) => candidate.textContent === ${JSON.stringify(name)});
                list.value = option.value;
                list.dispatchEvent(new Event('change', { bubbles: true }));
            })()`);
        }
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`, 'The new relationship\'s card did not open.');
    };
    const typeRelationshipPart = (latex) => evaluate(window, `(() => {
        const field = document.querySelector('#editEdgeMathField');
        field.focus();
        field.setValue(${JSON.stringify(latex)});
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const relationshipCount = () => evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`);
    // Made between Electrical losses and Enclosed air, then named on its card's Details tab (two undoable steps), its card closed.
    const newNamedRelationship = async (name) => {
        await newRelationship('Electrical losses', 'Enclosed air');
        await evaluate(window, `document.querySelector('#edgeEditor [data-editor-tab="details"]').click()`);
        await typeInto(`document.querySelector('#editEdgeName')`, name);
        await waitFor(window, `window.__debugProject.serialize().edges.some((edge) => edge.name === ${JSON.stringify(name)})`, `The new relationship was not named ${name}.`);
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
    };
    const nodeCount = () => evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`);

    await run('New node makes a node with one state, its card open on that state\'s line, and one undo takes it away', async () => {
        await freshExample();
        assert.equal(await nodeCount(), '3 nodes');
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="node"]').click()`);
        assert.equal(await nodeCount(), '4 nodes');
        assert.equal(await evaluate(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#nodeEditor [data-editor-tab].active').dataset.editorTab`), 'equations');
        assert.equal(await evaluate(window, `document.querySelector('#nodeEditorTitle').textContent`), 'New node');
        // Its one state's line is open, its name the field a person types in first.
        assert.equal(await evaluate(window, `document.querySelectorAll('#nodeEditorStates .editorStateRow:not([hidden])').length`), 1);
        assert.equal(await evaluate(window, `document.activeElement?.matches('#nodeEditorStates .editorStateRow [data-field="name"]')`), true, 'The new state\'s name is not the field focused.');
        const made = (await savedProject()).nodes.find((node) => node.name === 'New node');
        assert.deepEqual(made.states.map((state) => [state.symbol, state.initialValue]), [['x', 0]]);
        // Named on Details, as any node is.
        await evaluate(window, `document.querySelector('#nodeEditor [data-editor-tab="details"]').click()`);
        await typeInto(`document.querySelector('#editNodeName')`, 'Interaction node');
        assert.ok((await savedProject()).nodes.some((node) => node.name === 'Interaction node'));
        await undoRedo('undo');
        await undoRedo('undo');
        assert.equal(await nodeCount(), '3 nodes', 'Undo did not take the new node away.');
        await undoRedo('redo');
        assert.equal(await nodeCount(), '4 nodes');
        await undoRedo('undo');
        assert.equal(await nodeCount(), '3 nodes');
    });

    await run('an invalid state symbol in a node\'s line shows a visible error and keeps the symbol it had', async () => {
        await freshExample();
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="node"]').click()`);
        const symbol = async () => (await savedProject()).nodes.find((node) => node.name === 'New node').states[0].symbol;
        await typeInto(`document.querySelector('#nodeEditorStates .editorStateRow [data-field="symbol"]')`, 'T');
        assert.match(await evaluate(window, `document.querySelector('#editNodeError').textContent`), /lowercase/);
        assert.equal(await symbol(), 'x');
        await typeInto(`document.querySelector('#nodeEditorStates .editorStateRow [data-field="symbol"]')`, 'temperature');
        assert.equal(await symbol(), 'temperature');
        await undoRedo('undo');
        await undoRedo('undo');
        assert.equal(await nodeCount(), '3 nodes');
    });

    await run('New relationship picks its ends on the canvas or from a list, opens its card on its new part, and Esc makes nothing', async () => {
        await freshExample();
        assert.equal(await relationshipCount(), '3 relationships');
        // Esc during the pick: nothing made.
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="edge"]').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#endpointPickBanner').hidden`), true);
        assert.match(await evaluate(window, `document.querySelector('#endpointPickTitle').textContent`), /source/);
        assert.ok((await evaluate(window, `[...document.querySelectorAll('#endpointPickList option')].map((option) => option.textContent)`)).includes('Enclosed air'));
        await evaluate(window, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await waitFor(window, `document.querySelector('#endpointPickBanner').hidden`, 'Esc did not end the pick.');
        assert.equal(await relationshipCount(), '3 relationships');

        // From the list: made at once, directed, landing on its target, with no parameters; its card open on Equations.
        await newRelationship('Electrical losses', 'Enclosed air');
        assert.equal(await relationshipCount(), '4 relationships');
        assert.equal(await evaluate(window, `document.querySelector('#edgeEditor [data-editor-tab].active').dataset.editorTab`), 'equations');
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeDirectionality').value`), 'directed');
        // The other end is not offered as its own target.
        const made = async () => (await savedProject()).edges.find((edge) => edge.name === 'New relationship');
        assert.equal((await made()).equationModel.output.role, 'target');
        // Its part 0 until written: valid, nothing red, the model still valid; the field empty to type in, a hint under it.
        assert.equal((await made()).equation, '0');
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeMathField').value`), '');
        assert.deepEqual(await evaluate(window, `[...document.querySelector('#equationDiagnostics').classList]`), ['equationDiagnostics', 'valid', 'hint'], 'A new relationship\'s part is flagged before anything is typed.');
        assert.match(await evaluate(window, `document.querySelector('#equationDiagnostics').textContent`), /Write this relationship's equation/);
        await settle(window, 'validation');
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`, 'The new relationship did not reach native validation.');
        assert.match(await evaluate(window, `document.querySelector('#validationSummary').textContent`), /Model valid/, 'A new relationship made the model invalid.');
        // One undo takes it away.
        await undoRedo('undo');
        assert.equal(await relationshipCount(), '3 relationships', 'One undo did not take the new relationship away.');

        // Its part written with a reference button, in the names the card reads it by, and stored in its own.
        await newRelationship('Electrical losses', 'Enclosed air');
        await evaluate(window, `(() => { const field = document.querySelector('#editEdgeMathField'); field.focus(); field.setValue(''); })()`);
        await evaluate(window, `[...document.querySelectorAll('#editStateReferenceChips button')].find((button) => /_EL$/.test(button.textContent)).click()`);
        await waitFor(window, `document.querySelector('#editEdgeMathField').value.trim() !== ''`, 'The reference button wrote nothing.');
        await evaluate(window, `document.querySelector('#editEdgeMathField').dispatchEvent(new Event('change', { bubbles: true }))`);
        await waitFor(window, `/^\\\\mathrm\\{source/.test(window.__debugProject.serialize().edges.find((edge) => edge.name === 'New relationship').equationModel.latex)`, 'The part typed with a reference was not stored in the relationship\'s own names.');
        // A constant zero is a part too.
        await typeRelationshipPart('0');
        await waitFor(window, `window.__debugProject.serialize().edges.find((edge) => edge.name === 'New relationship').equationModel.latex === '0'`, 'A constant zero was not kept.');
        // A symbol nothing defines is said once, on the line under the field, with the action that makes it a parameter: named
        // from its symbol, set to 1, in one undoable step, and the line is clear again.
        await typeRelationshipPart('k');
        const addK = `document.querySelector('#equationDiagnostics .addParameterAction[data-symbol="k"]')`;
        await waitFor(window, `Boolean(${addK})`, 'An unknown symbol is not offered as a parameter.');
        assert.match(await evaluate(window, `document.querySelector('#equationDiagnostics').firstChild.textContent`), /^Unknown symbol: k\.$/);
        assert.equal(await evaluate(window, `${addK}.textContent`), 'Add k as a parameter');
        await evaluate(window, `${addK}.click()`);
        await waitFor(window, `document.querySelector('#equationDiagnostics').classList.contains('valid') && !${addK}`, 'The equation was not valid once k was a parameter.');
        assert.deepEqual((await made()).parameters.map((parameter) => [parameter.name, parameter.symbol, parameter.value]), [['Parameter k', 'k', 1]]);
        assert.equal((await made()).equationModel.latex, 'k');
        await undoRedo('undo');
        assert.deepEqual((await made()).parameters, [], 'Undo did not take the parameter away in one step.');
        assert.equal((await made()).equationModel.latex, 'k', 'Undoing the parameter undid the typing too.');
        await undoRedo('redo');
        assert.deepEqual((await made()).parameters.map((parameter) => parameter.symbol), ['k']);
        // Back through the edits to its part (one edit session, while its field was being typed in) to its making.
        for (let step = 0; step < 8 && await relationshipCount() !== '3 relationships'; step += 1) await undoRedo('undo');
        assert.equal(await relationshipCount(), '3 relationships');
    });

    await run('a point read once the canvas stops sliding is where a click lands', async () => {
        await freshExample();
        // Opening and closing an editor card slides the canvas; every scenario that clicks the canvas waits for the slide
        // to finish (waitForCanvasAtRest). Checked here so a change to the slide (its timing, or how it is done) cannot
        // quietly turn those clicks back into misses.
        const label = `[...document.querySelectorAll('.objectLabel')].find((element) => element.textContent.includes('Enclosed air'))`;
        await evaluate(window, `${label}.click()`);
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'Clicking the node did not open its editor.');
        await waitForCanvasAtRest(window);
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);
        assert.equal(await evaluate(window, `document.getAnimations().some((animation) => animation.effect?.target?.id === 'webglContainer' && animation.playState !== 'finished')`), true,
            'Closing the card did not start the canvas slide this scenario guards against.');
        await waitForCanvasAtRest(window);
        const settled = await canvasPoint(window, `window.__relationshipScreenPoint('Heat source')`);
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.deepEqual(await evaluate(window, `window.__relationshipScreenPoint('Heat source')`), settled, 'The relationship still moved after the canvas came to rest.');
    });

    await run('clicking a relationship after replacing a deleted one selects the new edge', async () => {
        await freshExample();
        // Regression test: deleting a relationship only soft-deletes it (definition.deleted =
        // true, line/marker hidden via .visible = false) -- its mesh is never removed from
        // relationshipPickTargets, which is only ever cleared on a full project reload. A new
        // relationship created between the same two nodes renders at the same curve (same node
        // pair, default zero offset), so without a .visible filter, firstIntersection() could
        // resolve the tie to the invisible, deleted original instead of the new one. Fixed by
        // having firstIntersection() skip non-visible hits (Three.js's Raycaster does not check
        // .visible itself -- confirmed in node_modules/three/src/core/Raycaster.js).
        const createEdge = (name) => newNamedRelationship(name);

        await createEdge('First relationship');
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '4 relationships');
        await evaluate(window, `document.querySelector('[data-action="delete"]').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');

        await createEdge('Second relationship');
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '4 relationships');

        if (await evaluate(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`)) {
            await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
        }

        // Click a point on the new relationship that no other relationship (or its label) covers. It shares
        // its source node with "Heat source", so its midpoint can lie on or beside that one's line or label,
        // depending on the window's size and the screen's scale.
        await waitForCanvasAtRest(window);
        const point = await evaluate(window, `(() => {
            const others = ['Heat source', 'Air convection gain', 'Battery convection loss'];
            const otherPoints = others.flatMap((title) => Array.from({ length: 41 }, (_, index) => window.__relationshipScreenPoint(title, index / 40)).filter(Boolean));
            let best = null;
            for (let index = 6; index <= 34; index += 1) {
                const candidate = window.__relationshipScreenPoint('Second relationship', index / 40);
                if (!candidate) continue;
                const onCanvas = document.elementFromPoint(candidate.x, candidate.y)?.tagName === 'CANVAS';
                const clearance = Math.min(...otherPoints.map((other) => Math.hypot(other.x - candidate.x, other.y - candidate.y)));
                if (onCanvas && (!best || clearance > best.clearance)) best = { ...candidate, clearance };
            }
            return best;
        })()`);
        assert.ok(point, 'Could not find a point on the new relationship that nothing else covers.');
        await window.mouseMove(point);
        await window.mouseDown(point, { button: 'left', clickCount: 1 });
        await window.mouseUp(point, { button: 'left', clickCount: 1 });
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`, 'Clicking the relationship did not open the edge editor.');
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeName').value`), 'Second relationship');

        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
        // Each was made, then named: two steps apiece, and the delete between them.
        for (let step = 0; step < 5; step += 1) await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');
    });

    // Waypoint-handle dragging goes through the same dragControls instance as node dragging,
    // which is only enabled while currentTool === 'select' -- ensure that's actually the
    // active tool rather than assume it, since an earlier test in the suite may have left a
    // different tool (rotate/scale/rectangleSelect) selected. Shared by both waypoint tests
    // below since either could run with a leftover tool from whichever ran just before it.
    const selectWaypointTestTool = () => evaluate(window, `document.querySelector('[data-tool="select"]').click()`);

    const createWaypointTestEdge = async (name) => {
        await newNamedRelationship(name);
        assert.deepEqual(await evaluate(window, `window.__relationshipWaypoints(${JSON.stringify(name)})`), []);
    };

    // Right-clicks the edge's line itself, until its menu offers to add a waypoint there. Its label (at the middle) and its direction
    // cone (at 0.64 of the way) sit on the line too, and a right-click on either opens the same menu but with nothing to add, since
    // no point of the line was picked; how much of the line they cover changes with the camera earlier tests leave. So points clear
    // of both are tried in turn, and a menu that opened without the action does not count as the click landing.
    const rightClickEdgeLine = (name) => {
        let attempt = 0;
        return retryGesture(window, async () => {
            const t = [0.75, 0.85, 0.3, 0.2, 0.9][attempt++ % 5];
            const linePoint = await canvasPoint(window, `window.__relationshipScreenPoint(${JSON.stringify(name)}, ${t})`);
            await window.mouseMove(linePoint);
            await window.mouseDown(linePoint, { button: 'right', clickCount: 1 });
            await new Promise((resolve) => setTimeout(resolve, 60));
            await window.mouseUp(linePoint, { button: 'right', clickCount: 1 });
        }, `!document.querySelector('#edgeContextMenu').classList.contains('hidden') && !document.querySelector('#edgeContextAddWaypoint').hidden`);
    };

    // Held on the window's own clock (window.__debugClock, interfaceClock.mjs), stopped for the gesture: the press, then the
    // window's word that it took it (its hold timer waiting), then the clock moved past the hold, then the release. A machine
    // that hands the window its input late cannot turn the hold into a quick click, as a release sent 600 ms of the test's
    // own time after the press could. A press that missed the line arms no timer; it is released, and the caller tries again.
    const pressAndHold = async (point) => {
        await evaluate(window, `window.__debugClock.stop()`);
        try {
            await window.mouseMove(point);
            await window.mouseDown(point, { button: 'left', clickCount: 1 });
            const startedAt = Date.now();
            while (!await evaluate(window, `window.__debugClock.pending() > 0`) && Date.now() - startedAt < 10000) await new Promise((resolve) => setTimeout(resolve, 20));
            await evaluate(window, `window.__debugClock.advance(1000)`);
            await window.mouseUp(point, { button: 'left', clickCount: 1 });
        } finally {
            await evaluate(window, `window.__debugClock.resume()`);
        }
    };

    const deleteWaypointTestEdge = async (name) => {
        const cleanedUp = await retryGesture(window, async () => {
            const cleanupPoint = await canvasPoint(window, `window.__relationshipScreenPoint(${JSON.stringify(name)})`);
            await window.mouseMove(cleanupPoint);
            await window.mouseDown(cleanupPoint, { button: 'left', clickCount: 1 });
            await new Promise((resolve) => setTimeout(resolve, 60));
            await window.mouseUp(cleanupPoint, { button: 'left', clickCount: 1 });
        }, `!document.querySelector('#edgeEditor').classList.contains('hidden')`);
        assert.ok(cleanedUp, 'Clicking the edge did not reopen the edge editor for cleanup after 5 attempts.');
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeName').value`), name);
        await evaluate(window, `document.querySelector('[data-action="delete"]').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');
    };

    await run('pressing and holding an edge enters waypoint mode, and dragging a waypoint reroutes it with undo/redo', async () => {
        await freshExample();
        await selectWaypointTestTool();
        await createWaypointTestEdge('Waypoint drag test edge');

        // Pressing and holding (rather than a quick click) selects the edge -- which is what
        // already makes its waypoint handles visible -- without popping its editor card open
        // over the canvas. A quick click still opens the editor, unaffected (checked in the
        // sibling add/remove test below, which relies on quick clicks throughout).
        // t=0.75, not the curve's default 0.5 -- the relationship's own CSS2D bundle label
        // anchors at getPoint(0.5) (every edge gets one, even an unbundled "bundle of one"), so
        // a click there can land on the label's DOM element instead of the canvas beneath it.
        const held = await retryGesture(window, async () => {
            // A genuine real mouse movement during the artificial 600ms hold window (this test
            // runs in a real, visible window, not headless -- incidental cursor movement from
            // whoever's at the machine can inject a real pointermove that cancels the hold
            // timer, same as a real drag would) can leave a stray "quick click" open the editor
            // on a failed attempt. Close it defensively before each attempt so that residue
            // from a prior failed attempt can't cause the eventual successful one to be judged
            // against stale editor-visibility state.
            if (!await evaluate(window, `document.querySelector('#edgeEditor').classList.contains('hidden')`)) {
                await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
            }
            const holdPoint = await canvasPoint(window, `window.__relationshipScreenPoint('Waypoint drag test edge', 0.75)`);
            await pressAndHold(holdPoint);
        }, `document.querySelector('#statusText').textContent === 'Editing waypoints · Waypoint drag test edge' && document.querySelector('#edgeEditor').classList.contains('hidden')`);
        assert.ok(held, 'Press-and-hold did not report entering waypoint mode without opening the edge editor after 5 attempts.');

        const added = await rightClickEdgeLine('Waypoint drag test edge');
        assert.ok(added, 'Right-clicking the edge line did not open its context menu offering to add a waypoint after 5 attempts.');
        await evaluate(window, `document.querySelector('#edgeContextAddWaypoint').click()`);

        const initialWaypoints = await evaluate(window, `window.__relationshipWaypoints('Waypoint drag test edge')`);
        assert.equal(initialWaypoints.length, 1, 'Right-clicking the edge line did not add a waypoint.');
        const initialWaypointJson = JSON.stringify(initialWaypoints[0]);
        // Adding the waypoint also hides this edge's bundle label (it would otherwise sit right
        // on top of the new handle, re-anchored to the curve's new midpoint) -- a frame drawn
        // since applies that display:none before the drag is aimed.
        await settle(window, 'frame');

        // Drag the handle and confirm the underlying model's waypoint position actually moved
        // (not just the handle mesh) -- this is the same live-mutate-during-gesture idiom node
        // dragging already uses, so the model and the handle should never be out of sync mid-drag.
        // A short pause between each synthetic pointer event (rather than firing all four back
        // to back) matters: DragControls needs its own 'pointerdown' handler to actually run
        // (setting its internal _selected) before a 'pointermove' arrives, and a zero-delay
        // burst of sendInputEvent calls can reach Chromium's input queue faster than that JS
        // callback gets a turn to run. A short, fixed offset (not toward wherever's convenient)
        // keeps the dragged position clear of the endpoint nodes' own pick geometry -- landing
        // on or near a node would route later clicks to the node's context menu instead of the
        // waypoint's, since the contextmenu handler checks for a node hit first.
        const dragged = await retryGesture(window, async () => {
            const currentHandlePoint = await findCanvasPoint(window, await canvasPoint(window, `window.__waypointScreenPoint('Waypoint drag test edge', 0)`));
            if (!currentHandlePoint) return;
            const dragTo = { x: currentHandlePoint.x + 15, y: currentHandlePoint.y - 12 };
            const midDrag = { x: Math.round((currentHandlePoint.x + dragTo.x) / 2), y: Math.round((currentHandlePoint.y + dragTo.y) / 2) };
            await window.mouseMove(currentHandlePoint);
            await window.mouseDown(currentHandlePoint, { button: 'left', clickCount: 1 });
            await new Promise((resolve) => setTimeout(resolve, 60));
            await window.mouseMove(midDrag);
            await new Promise((resolve) => setTimeout(resolve, 60));
            await window.mouseMove(dragTo);
            await new Promise((resolve) => setTimeout(resolve, 60));
            await window.mouseUp(dragTo, { button: 'left', clickCount: 1 });
        }, `JSON.stringify(window.__relationshipWaypoints('Waypoint drag test edge')[0]) !== ${JSON.stringify(initialWaypointJson)}`);
        assert.ok(dragged, 'Dragging the waypoint handle did not move it after 5 attempts.');
        const draggedWaypoint = (await evaluate(window, `window.__relationshipWaypoints('Waypoint drag test edge')`))[0];

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await waitFor(window, `JSON.stringify(window.__relationshipWaypoints('Waypoint drag test edge')[0]) === ${JSON.stringify(JSON.stringify(initialWaypoints[0]))}`, 'Undo did not revert the dragged waypoint.');
        await evaluate(window, `document.querySelector('#redoButton').click()`);
        await waitFor(window, `JSON.stringify(window.__relationshipWaypoints('Waypoint drag test edge')[0]) === ${JSON.stringify(JSON.stringify(draggedWaypoint))}`, 'Redo did not restore the dragged waypoint.');

        await deleteWaypointTestEdge('Waypoint drag test edge');
    });

    await run('right-click adds and removes an edge waypoint via its own context menus', async () => {
        await freshExample();
        await selectWaypointTestTool();
        await createWaypointTestEdge('Waypoint add-remove test edge');

        const added = await rightClickEdgeLine('Waypoint add-remove test edge');
        assert.ok(added, 'Right-clicking the edge line did not open its context menu offering to add a waypoint after 5 attempts.');
        await evaluate(window, `document.querySelector('#edgeContextAddWaypoint').click()`);
        await waitFor(window, `window.__relationshipWaypoints('Waypoint add-remove test edge').length === 1`, 'Right-clicking the edge line did not add a waypoint.');
        // See the drag test above: the label hiding that keeps a fresh handle clickable is applied by the next frame.
        await settle(window, 'frame');

        const removed = await retryGesture(window, async () => {
            const handlePoint = await findCanvasPoint(window, await canvasPoint(window, `window.__waypointScreenPoint('Waypoint add-remove test edge', 0)`));
            if (!handlePoint) return;
            await window.mouseMove(handlePoint);
            await window.mouseDown(handlePoint, { button: 'right', clickCount: 1 });
            await new Promise((resolve) => setTimeout(resolve, 60));
            await window.mouseUp(handlePoint, { button: 'right', clickCount: 1 });
        }, `!document.querySelector('#waypointContextMenu').classList.contains('hidden')`);
        assert.ok(removed, 'Right-clicking the waypoint handle did not open its context menu after 5 attempts.');
        await evaluate(window, `document.querySelector('#waypointContextRemove').click()`);
        await waitFor(window, `window.__relationshipWaypoints('Waypoint add-remove test edge').length === 0`, 'Removing the waypoint did not clear it.');
        assert.equal(await canvasPoint(window, `window.__waypointScreenPoint('Waypoint add-remove test edge', 0)`), null, 'The waypoint handle was not removed from the scene once its waypoint was deleted.');

        await deleteWaypointTestEdge('Waypoint add-remove test edge');
    });

    await run('deleting a node hides connected relationships and undo restores them', async () => {
        await freshExample();
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Electrical losses')).click(); document.querySelector('[data-action="delete"]').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), '2 nodes');
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '2 relationships');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), '3 nodes');
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');
    });

    await run('view cube changes the camera to a named view', async () => {
        await evaluate(window, `document.querySelector('[data-nav-view="top"]').click()`);
        await waitFor(window, `document.querySelector('[data-nav-view="top"]').classList.contains('active')`, 'Top camera view did not become active.', 2000);
    });

    await run('camera controls provide wheel-free zoom and model fitting', async () => {
        assert.equal(await evaluate(window, `document.querySelector('[data-nav-action="zoomIn"]').ariaLabel`), 'Zoom camera in');
        // A camera move left animating by an earlier test would overwrite the zoom when it ends: the camera still, first.
        await waitForCanvasAtRest(window, 'The camera, before zooming,');
        const before = Number(await evaluate(window, `document.querySelector('#viewCube').dataset.cameraDistance`));
        await evaluate(window, `document.querySelector('[data-nav-action="zoomIn"]').click()`);
        await waitFor(window, `Number(document.querySelector('#viewCube').dataset.cameraDistance) < ${before}`, 'Camera zoom-in control did not reduce its target distance.');
        await evaluate(window, `document.querySelector('[data-nav-action="fit"]').click()`);
        assert.ok(Number(await evaluate(window, `document.querySelector('#viewCube').dataset.cameraDistance`)) > 0);
    });

    await run('camera controls provide button and keyboard panning', async () => {
        const before = await evaluate(window, `document.querySelector('#viewCube').dataset.cameraTarget`);
        await evaluate(window, `document.querySelector('[data-nav-pan="left"]').click()`);
        await waitFor(window, `document.querySelector('#viewCube').dataset.cameraTarget !== ${JSON.stringify(before)}`, 'Pan control did not move the camera target.');
        assert.equal(await evaluate(window, `document.querySelectorAll('[data-nav-pan]').length`), 4);
        assert.equal(await evaluate(window, `document.querySelector('.webglSurface').getAttribute('aria-label')`), '3D model canvas');
    });

    await run('the 2D lock toggle turns left-drag into pan and disables isometric corners', async () => {
        const point = await evaluate(window, `(() => { const bounds = document.querySelector('#webglContainer').getBoundingClientRect(); return { x: Math.round(bounds.left + 20), y: Math.round(bounds.top + 20) }; })()`);
        const dragTo = { x: point.x + 50, y: point.y + 30 };
        const cameraTargetExpression = `document.querySelector('#viewCube').dataset.cameraTarget`;
        const drag = async () => {
            await window.mouseMove(point);
            await window.mouseDown(point, { button: 'left', clickCount: 1 });
            await window.mouseMove(dragTo);
            await window.mouseUp(dragTo, { button: 'left', clickCount: 1 });
        };
        const readTarget = async () => (await evaluate(window, cameraTargetExpression)).split(',').map(Number);
        // OrbitControls' damping (dampingFactor 0.07) eases a pan's momentum into the target a
        // fraction per rendered frame, not per second: a fixed wait is many frames on an idle
        // machine and few on a busy one, where the pan was still easing when the unlocked drag
        // began and its tail read as that drag moving the target. So each drag is followed until
        // the target, as the view cube gives it (to four places), holds still over several render
        // ticks; what is left of the momentum by then is far under the "close enough" below.
        const targetAtRest = (message) => waitForCanvasAtRest(window, message);
        const targetsClose = (a, b, epsilon = 0.02) => a.every((value, index) => Math.abs(value - b[index]) < epsilon);

        assert.equal(await evaluate(window, `document.querySelector('#lock2DButton').ariaPressed`), 'false');
        await evaluate(window, `document.querySelector('#lock2DButton').click()`);
        await waitFor(window, `document.querySelector('#lock2DButton').ariaPressed === 'true'`, '2D lock button did not report itself pressed.');
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.cubeCorner')].every((corner) => corner.disabled)`), true, 'Isometric corner buttons should be disabled while locked.');
        // Engaging the lock snaps to the nearest orthogonal view via the existing 650ms animated
        // camera transition, which sets orbitControls.target once and then lerps camera.position,
        // with the controls off until it ends: a drag begun while it runs is not taken. So the whole
        // camera is waited on (distance and turn as well as target), not the target alone, which
        // holds still from the snap's first frame.
        await waitForCanvasAtRest(window);

        const targetBeforeLockedDrag = await readTarget();
        await drag();
        await waitFor(window, `${cameraTargetExpression} !== ${JSON.stringify(targetBeforeLockedDrag.map((v) => v.toFixed(4)).join(','))}`, 'A left-drag while 2D-locked did not pan the camera.');
        await targetAtRest('The locked drag\'s pan did not come to rest.');
        assert.ok(!targetsClose(targetBeforeLockedDrag, await readTarget()), 'A left-drag while 2D-locked did not pan the camera by a meaningful amount.');

        await evaluate(window, `document.querySelector('#lock2DButton').click()`);
        await waitFor(window, `document.querySelector('#lock2DButton').ariaPressed === 'false'`, '2D lock button did not report itself unpressed.');
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.cubeCorner')].every((corner) => !corner.disabled)`), true, 'Isometric corner buttons should re-enable once unlocked.');

        await waitForCanvasAtRest(window);
        const targetBeforeUnlockedDrag = await readTarget();
        await drag();
        await targetAtRest('The unlocked drag\'s turn did not come to rest.');
        assert.ok(targetsClose(targetBeforeUnlockedDrag, await readTarget()), 'An unlocked left-drag should rotate around a fixed target, not pan it.');
    });

    await run('encrypted-save password feedback updates continuously', async () => {
        await evaluate(window, `document.querySelector('#saveEncryptedButton').click()`);
        await waitFor(window, `document.querySelector('#passwordDialog').open`, 'Password dialog did not open.');
        await evaluate(window, `(() => {
            const password = document.querySelector('#projectPassword');
            password.value = 'short'; password.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#passwordSubmit').disabled`), true);
        await evaluate(window, `(() => {
            const password = document.querySelector('#projectPassword');
            const confirmation = document.querySelector('#confirmProjectPassword');
            password.value = 'longEnoughPassword'; confirmation.value = 'longEnoughPassword';
            password.dispatchEvent(new Event('input', { bubbles: true })); confirmation.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#passwordSubmit').disabled`), false);
        await evaluate(window, `document.querySelector('#passwordCancel').click()`);
    });

    await run('a project is saved encrypted, its password changed (asking for the current one first) and its encryption removed', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-password-'));
        const projectPath = join(directory, 'plain.kjt');
        await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'thermalEquilibrium.kjt')));
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        try {
            await waitFor(opened, `document.querySelectorAll('.node-label-container').length > 0`, 'The project did not load.');
            const answerPassword = async (password, { confirm = false } = {}) => {
                await waitFor(opened, `document.querySelector('#passwordDialog').open`, 'The password dialog did not open.');
                assert.equal(await evaluate(opened, `!document.querySelector('#confirmPasswordField').hidden`), confirm, confirm ? 'A new password is asked for twice.' : 'The current password is asked for once.');
                await evaluate(opened, `(() => {
                    for (const selector of ['#projectPassword', ${confirm ? `'#confirmProjectPassword'` : ''}].filter(Boolean)) {
                        const field = document.querySelector(selector);
                        field.value = ${JSON.stringify(password)};
                        field.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    document.querySelector('#passwordDialog form').requestSubmit();
                })()`);
            };
            const readsWith = async (path, password) => decodeProjectFile(await readFile(path), { password }).then(() => true, () => false);

            // Saved encrypted, as a new file: the password twice, then where to save it (and, for a project with owner details, what
            // this copy says about them).
            const encrypted = await driver.captureExport(async () => {
                await evaluate(opened, `document.querySelector('#saveEncryptedButton').click()`);
                await answerPassword('firstPassword1', { confirm: true });
                for (let attempt = 0; attempt < 20; attempt += 1) {
                    if (await evaluate(opened, `document.querySelector('#saveOwnershipDialog').open`)) {
                        await evaluate(opened, `document.querySelector('#saveOwnershipDialog form').requestSubmit()`);
                        break;
                    }
                    if (/^Encrypted project saved/.test(await evaluate(opened, `document.querySelector('#statusText').textContent`))) break;
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }, { fileName: 'locked.kjt' });
            await waitFor(opened, `/^Encrypted project saved/.test(document.querySelector('#statusText').textContent)`, 'The encrypted save was not reported.');
            assert.equal(await readsWith(encrypted.path, null), false, 'The saved file must not open without its password.');
            assert.equal(await readsWith(encrypted.path, 'firstPassword1'), true);

            // Each step below is waited on by what it reports, so the report of the step before is cleared first.
            const clearStatus = () => evaluate(opened, `document.querySelector('#statusText').textContent = ''`);
            // Changed: the current password first, asked again when wrong, then the new one twice.
            await clearStatus();
            await evaluate(opened, `document.querySelector('#saveEncryptedButton').click()`);
            await waitFor(opened, `!document.querySelector('#encryptionMenu').classList.contains('hidden')`, 'An encrypted project\'s lock did not offer its menu.');
            await evaluate(opened, `document.querySelector('#changePasswordButton').click()`);
            await answerPassword('notThePassword');
            await waitFor(opened, `document.querySelector('#passwordDialog').open && document.querySelector('#passwordError').textContent !== ''`, 'A wrong current password was not refused.');
            await answerPassword('firstPassword1');
            await answerPassword('secondPassword2', { confirm: true });
            await waitFor(opened, `/^Encrypted project saved/.test(document.querySelector('#statusText').textContent) && !document.querySelector('#passwordDialog').open`, 'The new password was not saved.');
            assert.equal(await readsWith(encrypted.path, 'firstPassword1'), false, 'The old password must no longer open it.');
            assert.equal(await readsWith(encrypted.path, 'secondPassword2'), true);

            // Cancelled at the current password, nothing changes.
            await evaluate(opened, `document.querySelector('#saveEncryptedButton').click()`);
            await evaluate(opened, `document.querySelector('#removeEncryptionButton').click()`);
            await waitFor(opened, `document.querySelector('#passwordDialog').open`, 'Removing encryption did not ask for the password.');
            await evaluate(opened, `document.querySelector('#passwordCancel').click()`);
            assert.equal(await readsWith(encrypted.path, 'secondPassword2'), true);
            assert.equal(await readsWith(encrypted.path, null), false);

            // Removed: the current password, and the same file is saved without one.
            await clearStatus();
            await evaluate(opened, `document.querySelector('#saveEncryptedButton').click()`);
            await evaluate(opened, `document.querySelector('#removeEncryptionButton').click()`);
            await answerPassword('secondPassword2');
            await waitFor(opened, `/^Project saved/.test(document.querySelector('#statusText').textContent)`, 'Removing the encryption did not save the project.');
            assert.equal(await readsWith(encrypted.path, null), true, 'With its encryption removed, the file opens without a password.');
        } finally {
            if (!await opened.isDestroyed()) await closeWhenValidated(opened).catch(() => opened.close());
            await rm(directory, { recursive: true, force: true });
        }
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    await run('project title editing applies camel case filenames', async () => {
        const rename = () => evaluate(window, `(() => { document.querySelector('.documentTitle').click(); const input = document.querySelector('.documentTitleInput'); input.value = 'My Test Model'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        // An earlier test saved this project, so renaming it saves it under the new name: the save dialog is answered with a file
        // of the test's own, rather than left open on the screen. A project never saved is only renamed.
        if (driver.captureExport) {
            const written = await driver.captureExport(rename, { fileName: 'myTestModel.kjt' }).catch((error) => {
                if (/did not write a file/.test(error.message)) return null;
                throw error;
            });
            if (written) assert.ok(written.bytes.length > 0, 'The renamed project was written.');
        } else {
            await rename();
        }
        assert.equal(await evaluate(window, `document.querySelector('.documentTitle').textContent`), 'myTestModel');
    });

    await run('interface zoom controls increase and reset application scale', async () => {
        const before = await evaluate(window, `window.uiZoom.get()`);
        await evaluate(window, `document.querySelector('#zoomInButton').click()`);
        assert.ok(await evaluate(window, `window.uiZoom.get()`) > before);
        await evaluate(window, `window.uiZoom.reset()`);
        assert.equal(Math.round((await evaluate(window, `window.uiZoom.get()`)) * 10) / 10, 1);
    });

    await run('a node description can be written, saved, cleared and undone', async () => {
        const describe = async (selector, text) => evaluate(window, `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        const savedNode = () => evaluate(window, `window.__debugProject.serialize().nodes.find((node) => node.name === 'Described node')`);

        await makeNode(window, 'Described node', { name: 'Pressure', symbol: 'pressure', value: '101325', unit: 'Pa' });
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden') && document.querySelector('#editNodeName').value === 'Described node'`, 'The new node did not open its editor.');
        assert.equal(await evaluate(window, `document.querySelector('#editNodeDescription').value`), '');
        assert.equal((await savedNode()).description, undefined, 'An empty description was saved instead of omitted.');

        await describe('#editNodeDescription', '  Gas pressure inside the vessel.  ');
        assert.equal((await savedNode()).description, 'Gas pressure inside the vessel.', 'The description was not trimmed and saved.');

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal((await savedNode()).description, undefined, 'Undo did not remove the description.');
        await evaluate(window, `document.querySelector('#redoButton').click()`);
        assert.equal((await savedNode()).description, 'Gas pressure inside the vessel.');
        // Undo and redo close the editor; opening the node again shows the restored text.
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((label) => label.textContent.includes('Described node'))`, 'The Described node label did not render after redo.');
        await waitForCanvasAtRest(window);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Described node'))?.click()`);
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden') && document.querySelector('#editNodeName').value === 'Described node'`, 'Clicking the node did not reopen its editor.');
        assert.equal(await evaluate(window, `document.querySelector('#editNodeDescription').value`), 'Gas pressure inside the vessel.');
        await describe('#editNodeDescription', '');
        assert.equal((await savedNode()).description, undefined, 'Clearing the description did not omit it from the saved document.');

        // Back through the description, the node's name and its state's fields, to its making.
        for (let step = 0; step < 12 && await savedNode() !== undefined; step += 1) await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await savedNode(), undefined, 'Undoing back through the creation did not remove the node.');
    });

    await run('component library places node templates and connects them with an auto-bound edge template', async () => {
        await evaluate(window, `document.querySelector('#componentLibraryButton').click()`);
        await waitFor(window, `!document.querySelector('#componentLibraryPanel').hidden`, 'Component library panel did not open.');
        await waitFor(window, `document.querySelectorAll('.componentLibraryItem').length > 0`, 'Component library did not load any templates.');
        assert.ok(await evaluate(window, `[...document.querySelectorAll('.componentLibrarySection h3')].some((h) => h.textContent === 'Thermal')`), 'Templates were not sectioned by domain when idle.');

        // Multi-select domain chips: filtering to "Mechanical" alone should hide the thermal-only
        // edge template but keep a mechanical one, and collapse from sectioned to a flat filtered list.
        await evaluate(window, `[...document.querySelectorAll('#componentLibraryDomainChips button')].find((b) => b.textContent === 'Mechanical').click()`);
        assert.equal(await evaluate(window, `document.querySelector('[data-template-id="conduction"]')`), null);
        assert.notEqual(await evaluate(window, `document.querySelector('[data-template-id="rotationalDrive"]')`), null);
        await evaluate(window, `[...document.querySelectorAll('#componentLibraryDomainChips button')].find((b) => b.textContent === 'Mechanical').click()`);

        const nodesBefore = await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`);
        const relationshipsBefore = await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`);

        // Two instances of the same node template, so the edge template below has a guaranteed
        // exact-symbol match on both ends without depending on the bundled example's own state names.
        await evaluate(window, `document.querySelector('[data-template-id="thermalMass"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Thermal mass')).length === 1`, 'The first thermal mass node template was not placed.');
        await evaluate(window, `document.querySelector('[data-template-id="thermalMass"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Thermal mass')).length === 2`, 'The second thermal mass node template was not placed.');
        assert.notEqual(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), nodesBefore);
        assert.equal(await evaluate(window, `!document.querySelector('#componentLibraryPanel').hidden`), true, 'The library panel closed itself after placing a node.');
        // The template's own description travels with the node it places, so the library's explanation survives onto the canvas.
        const templateDescription = (id) => evaluate(window, `window.componentLibrary.list().then((templates) => templates.find((template) => template.id === ${JSON.stringify(id)}).description)`);
        const thermalMassDescription = await templateDescription('thermalMass');
        assert.ok(thermalMassDescription.length > 60, 'The Thermal mass template has no real description to carry.');
        assert.deepEqual(await evaluate(window, `window.__debugProject.serialize().nodes.filter((node) => node.name === 'Thermal mass').map((node) => node.description)`), [thermalMassDescription, thermalMassDescription]);

        await evaluate(window, `document.querySelector('[data-template-id="conduction"]').click()`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'Applying the edge template did not arm endpoint picking.');
        assert.match(await evaluate(window, `document.querySelector('#componentLibraryHint').textContent`), /Conduction/);
        assert.equal(await evaluate(window, `document.querySelector('#edgeEditor').classList.contains('hidden')`), true, 'No relationship card should open before both ends are picked.');
        // Where a relationship made from a template lands, read from the document: "target.temperature".
        const landsOn = (name) => evaluate(window, `(() => {
            const project = window.__debugProject.serialize();
            const edge = project.edges.filter((item) => item.name === ${JSON.stringify(name)}).at(-1);
            const { role, stateId } = edge.equationModel.output;
            return role + '.' + project.nodes.find((node) => node.id === edge[role].nodeId).states.find((state) => state.id === stateId).symbol;
        })()`);
        const templateMade = (name, message) => waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden') && document.querySelector('#editEdgeName').value === ${JSON.stringify(name)}`, message);
        const equationValid = () => evaluate(window, `document.querySelector('#equationDiagnostics').classList.contains('valid')`);

        // Endpoint picking is wired to the CSS2D label's own click listener (not 3D raycasting),
        // so a plain .click() reaches it directly -- the same approach every other test in this
        // file already uses for .objectLabel, and it sidesteps CSS2DRenderer position/timing
        // entirely rather than needing real screen coordinates.
        const clickThermalMass = async (index) => {
            await evaluate(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Thermal mass'))[${index}]?.click()`);
        };

        await clickThermalMass(0);
        await waitFor(window, `document.querySelector('#endpointPickTitle').textContent.includes('target')`, 'Picking did not chain from the source to the target endpoint after the first click.');
        await clickThermalMass(1);
        // Made once both ends are picked, its card open on it.
        await templateMade('Conduction', 'The Conduction relationship was not made and opened once both endpoints were picked.');
        assert.equal(await evaluate(window, `document.querySelector('#componentLibraryHint').hidden`), true);
        assert.ok((await evaluate(window, `window.__debugProject.serialize().edges.find((edge) => edge.name === 'Conduction').parameters.map((parameter) => parameter.symbol)`)).includes('conductance'), 'The template\'s parameters did not come with it.');
        assert.equal(await equationValid(), true, 'The name-matched ports did not auto-bind to a valid equation.');
        // Each bundled template names the state it lands on; this one lands on target.temperature, not a source-side state.
        assert.equal(await landsOn('Conduction'), 'target.temperature');
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
        assert.notEqual(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);
        // Conduction is bidirectional -- confirms the post-creation setRelationshipDirectionality
        // hook actually ran, not just that some edge got created. Opens the edge editor (same
        // bundle-label click precedent other tests in this file use) to read it back the same
        // way a real user would see it, rather than reaching into renderer module state. The
        // bundle label's header shows the connected node names ("Thermal mass ↔ Thermal mass"),
        // not the edge's own title -- clicking anywhere on a single-relationship bundle (not just
        // a specific row) opens that one relationship directly.
        await waitFor(window, `[...document.querySelectorAll('.bundleLabel')].some((l) => l.textContent.includes('Thermal mass'))`, 'The relationship bundle label for the new Conduction edge did not appear.');
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((l) => l.textContent.includes('Thermal mass'))?.click()`);
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`, 'Clicking the new Conduction relationship did not open the edge editor.');
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeDirectionality').value`), 'bidirectional', 'Conduction was not created as a bidirectional edge.');
        // Likewise the edge template's description reaches the edge editor and the saved document.
        const conductionDescription = await templateDescription('conduction');
        assert.ok(conductionDescription.length > 60, 'The Conduction template has no real description to carry.');
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeDescription').value`), conductionDescription);
        assert.equal(await evaluate(window, `window.__debugProject.serialize().edges.find((edge) => edge.name === 'Conduction')?.description`), conductionDescription);
        // And a description typed into the edge editor is saved, trimmed, as its own undoable step.
        await evaluate(window, `(() => { const input = document.querySelector('#editEdgeDescription'); input.value = '  Edited note.  '; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.ok(await evaluate(window, `window.__debugProject.serialize().edges.some((edge) => edge.name === 'Conduction' && edge.description === 'Edited note.')`), 'An edge description typed into the editor was not saved.');
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);

        // Undo the description edit, the edge and both placed nodes so this scenario leaves the baseline model unchanged
        // before the next one starts.
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), nodesBefore);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);

        // Second scenario: a node template with a self-referencing source term (Rotational link),
        // and an edge template with an explicit non-default output (Rotational drive updates
        // angularVelocity, not the target's declared-first state, angle) -- covers the two schema
        // additions the thermal scenario above doesn't exercise.
        await evaluate(window, `document.querySelector('[data-template-id="motor"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((l) => l.textContent.includes('Motor'))`, 'The motor node template was not placed.');
        await evaluate(window, `document.querySelector('[data-template-id="rotationalLink"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((l) => l.textContent.includes('Rotational link'))`, 'The rotational link node template was not placed.');
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((l) => l.textContent.includes('Rotational link'))?.click()`);
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'The placed rotational link node did not open its editor.');
        assert.notEqual(await evaluate(window, `document.querySelector('#nodeEditorStates .stateCard[data-symbol="angle"] .ownPart')?.value ?? ''`), '', "The template's self-referencing own part was not applied to the placed node.");
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);

        const clickLabelContaining = async (text) => {
            await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((l) => l.textContent.includes(${JSON.stringify(text)}))?.click()`);
        };

        await evaluate(window, `document.querySelector('[data-template-id="rotationalDrive"]').click()`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'Applying the rotational drive edge template did not arm endpoint picking.');
        await clickLabelContaining('Motor');
        await waitFor(window, `document.querySelector('#endpointPickTitle').textContent.includes('target')`, 'Picking did not chain to the target endpoint for rotational drive.');
        await clickLabelContaining('Rotational link');
        await templateMade('Rotational drive', 'The rotational drive relationship was not made once both endpoints were picked.');
        assert.equal(await landsOn('Rotational drive'), 'target.angularVelocity', "The template's own output did not land on angularVelocity over the target's first state, angle.");
        assert.equal(await equationValid(), true);
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
        assert.notEqual(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);

        // Undo the edge and both placed nodes so this scenario leaves the baseline model unchanged
        // before the next one starts.
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), nodesBefore);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);

        // Third scenario: a cross-domain node (Motor, tagged both electrical and mechanical) and
        // two edge templates whose ports declare more than one expected symbol on the same side
        // (target: current AND angularVelocity) -- covers the array-valued ports the scenarios
        // above only exercise with a single symbol per role.
        //
        // "Motor" was also used (and undone) in the second scenario -- a soft-deleted node's label
        // stays in the DOM, just hidden, so counting/selecting by text alone here could pick up
        // that stale one. visibleLabelsWith() filters on the CSS2DObject's own root element
        // (.node-label-container, what CSS2DRenderer actually toggles display:none on), matching
        // the same distinction the multi-selection and Cmd/Ctrl+V paste tests above are careful
        // about for the same reason.
        const visibleLabelsWith = (text) => `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes(${JSON.stringify(text)}) && getComputedStyle(l.closest('.node-label-container')).display !== 'none')`;
        await evaluate(window, `document.querySelector('[data-template-id="motor"]').click()`);
        await waitFor(window, `${visibleLabelsWith('Motor')}.length === 1`, 'The motor node template was not placed.');
        await evaluate(window, `document.querySelector('[data-template-id="voltageSource"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((l) => l.textContent.includes('Voltage source'))`, 'The voltage source node template was not placed.');
        await evaluate(window, `document.querySelector('[data-template-id="torqueLoad"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((l) => l.textContent.includes('Torque load'))`, 'The torque load node template was not placed.');
        assert.equal(await evaluate(window, `Number.parseInt(document.querySelectorAll('.modelStatus span')[0].textContent, 10)`),
            Number.parseInt(nodesBefore, 10) + 3, 'Placing the three node templates did not add exactly three nodes.');

        await evaluate(window, `document.querySelector('[data-template-id="armatureDynamics"]').click()`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'Applying the armature dynamics edge template did not arm endpoint picking.');
        assert.match(await evaluate(window, `document.querySelector('#componentLibraryHint').textContent`),
            /"current"\/"angularVelocity"/, 'The hint did not list both target port symbols for a multi-symbol port.');
        await clickLabelContaining('Voltage source');
        await waitFor(window, `document.querySelector('#endpointPickTitle').textContent.includes('target')`, 'Picking did not chain to the target endpoint for armature dynamics.');
        await evaluate(window, `${visibleLabelsWith('Motor')}[0]?.click()`);
        await templateMade('Armature dynamics', 'The armature dynamics relationship was not made once both endpoints were picked.');
        assert.equal(await equationValid(), true, 'A latex expression referencing two states on the same side did not auto-bind to a valid equation.');
        assert.equal(await landsOn('Armature dynamics'), 'target.current');
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
        assert.equal(await evaluate(window, `Number.parseInt(document.querySelectorAll('.modelStatus span')[0].textContent, 10)`),
            Number.parseInt(nodesBefore, 10) + 3, 'Creating the armature dynamics edge unexpectedly changed the node count.');

        await evaluate(window, `document.querySelector('[data-template-id="shaftDynamics"]').click()`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'Applying the shaft dynamics edge template did not arm endpoint picking.');
        await clickLabelContaining('Torque load');
        await waitFor(window, `document.querySelector('#endpointPickTitle').textContent.includes('target')`, 'Picking did not chain to the target endpoint for shaft dynamics.');
        await evaluate(window, `${visibleLabelsWith('Motor')}[0]?.click()`);
        await templateMade('Shaft dynamics', 'The shaft dynamics relationship was not made once both endpoints were picked.');
        assert.equal(await equationValid(), true);
        assert.equal(await landsOn('Shaft dynamics'), 'target.angularVelocity', 'Shaft dynamics did not land on angularVelocity.');
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);

        await evaluate(window, `document.querySelector('#closeComponentLibraryPanel').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#componentLibraryPanel').hidden`), true);

        for (let undo = 0; undo < 5; undo += 1) await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), nodesBefore);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);
    });

    await run('component library places an assembly: a node with its own C++ program and the live shared parameters it reads', async () => {
        const saved = () => evaluate(window, `window.__debugProject.serialize()`);
        // The document leaves the list out altogether while there are no shared parameters.
        const sharedOf = (project) => project.sharedParameters ?? [];
        const controllers = (document_) => document_.nodes.filter((node) => node.name === 'PID controller (parallel)');
        const nodesBefore = await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`);
        const sharedBefore = sharedOf(await saved()).length;

        if (await evaluate(window, `document.querySelector('#componentLibraryPanel').hidden`)) await evaluate(window, `document.querySelector('#componentLibraryButton').click()`);
        await waitFor(window, `!document.querySelector('#componentLibraryPanel').hidden`, 'Component library panel did not open.');
        await waitFor(window, `Boolean(document.querySelector('[data-template-id="pidParallel"]'))`, 'The parallel PID assembly is not in the library.');
        assert.ok(await evaluate(window, `[...document.querySelectorAll('#componentLibraryTypeChips button')].some((chip) => chip.textContent === 'Assemblies')`), 'The library has no Assemblies filter.');
        assert.match(await evaluate(window, `document.querySelector('[data-template-id="pidParallel"] small').textContent`), /Assembly · 1 node/);
        assert.notEqual(await evaluate(window, `document.querySelector('[data-template-id="pidIsa"]')`), null, 'The ISA PID assembly is not in the library.');

        await evaluate(window, `document.querySelector('[data-template-id="pidParallel"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((label) => label.textContent.includes('PID controller (parallel)'))`, 'The assembly was not placed.');
        assert.equal(await evaluate(window, `!document.querySelector('#componentLibraryPanel').hidden`), true, 'The library panel closed itself after placing an assembly.');
        let document_ = await saved();
        const [first] = controllers(document_);
        assert.equal(controllers(document_).length, 1);
        assert.equal(first.implementation.kind, 'cpp');
        assert.match(first.implementation.source, /class PidParallel/);
        assert.match(first.description, /parallel \(independent\) form/);
        assert.deepEqual(first.states.map((state) => state.name), ['Measurement', 'Control output', 'Error']);
        // Every link reaches a shared parameter the placement made, with the slider range it was authored with.
        const byId = new Map(sharedOf(document_).map((shared) => [shared.id, shared]));
        const linked = first.implementation.bindings.filter((binding) => binding.kind === 'parameter').map((binding) => byId.get(binding.sharedParameterId));
        assert.ok(linked.every(Boolean), 'A binding of the placed program links to a shared parameter that does not exist.');
        assert.deepEqual(linked.map((shared) => shared.symbol), ['setpoint', 'kp', 'ki', 'kd', 'filterTime', 'outputMin', 'outputMax']);
        assert.deepEqual(linked.filter((shared) => shared.mode === 'live').map((shared) => shared.symbol), ['setpoint', 'kp', 'ki', 'kd']);
        assert.deepEqual(byId.get(first.implementation.bindings.find((binding) => binding.key === 'kp').sharedParameterId).control, { minimum: 0, maximum: 100, step: 0.01 });
        assert.equal(sharedOf(document_).length, sharedBefore + 7);

        // A second placement makes its own parameters under symbols not yet taken, and links to those, not the first's.
        await evaluate(window, `document.querySelector('[data-template-id="pidParallel"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].filter((label) => label.textContent.includes('PID controller (parallel)')).length === 2`, 'The second assembly was not placed.');
        document_ = await saved();
        const [, second] = controllers(document_);
        const symbolsOf = (node) => node.implementation.bindings.filter((binding) => binding.kind === 'parameter')
            .map((binding) => sharedOf(document_).find((shared) => shared.id === binding.sharedParameterId).symbol);
        assert.deepEqual(symbolsOf(second), ['setpoint2', 'kp2', 'ki2', 'kd2', 'filterTime2', 'outputMin2', 'outputMax2']);
        assert.deepEqual(symbolsOf(first), ['setpoint', 'kp', 'ki', 'kd', 'filterTime', 'outputMin', 'outputMax']);
        assert.notEqual(second.id, first.id);

        // One undo takes a placement and its parameters away together.
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(controllers(await saved()).length, 1);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        document_ = await saved();
        assert.equal(controllers(document_).length, 0);
        assert.equal(sharedOf(document_).length, sharedBefore, 'Undoing the placements left their shared parameters behind.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), nodesBefore);
        await evaluate(window, `document.querySelector('#closeComponentLibraryPanel').click()`);
    }, { skip: !driver.capabilities.cppProviders && 'places the bundled PID assemblies, which carry a C++ program the web edition cannot compile, so its library leaves them out' });

    // Shared with the two run() calls below (see the analogous analysisHandle comment above scenario
    // #15's split for why): the Pose Visualizer add-on has no web-edition equivalent, but the
    // simulation run it inspects, and the cleanup afterward, are both main-window/portable and must
    // always happen so the next scenario starts from a clean canvas either way.
    let firstBodyId = null;

    await run('Pose Visualizer add-on auto-detects and renders a 6-DOF free body node', async () => {
        const idsBeforeBodies = new Set(await evaluate(window, `window.__debugTransform.allNodeIds()`));
        await evaluate(window, `document.querySelector('#componentLibraryButton').click()`);
        await waitFor(window, `!document.querySelector('#componentLibraryPanel').hidden`, 'Component library panel did not open.');
        await waitFor(window, `document.querySelectorAll('.componentLibraryItem').length > 0`, 'Component library did not load any templates.');
        await evaluate(window, `document.querySelector('[data-template-id="freeBody"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Free body')).length === 1`, 'The first free body node template was not placed.');
        await evaluate(window, `document.querySelector('[data-template-id="freeBody"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Free body')).length === 2`, 'The second free body node template was not placed.');
        await evaluate(window, `document.querySelector('#closeComponentLibraryPanel').click()`);

        // Give the first free body a known editor rotation/scale (must happen before the run
        // below locks the transform tools in result mode) so the add-on's "Editor shapes,
        // colors & transforms" toggle has a real, non-identity transform to verify downstream.
        const bodyIds = (await evaluate(window, `window.__debugTransform.allNodeIds()`)).filter((id) => !idsBeforeBodies.has(id));
        assert.equal(bodyIds.length, 2, 'Expected exactly two new free body nodes.');
        [firstBodyId] = bodyIds;
        const selectFirstBody = `document.querySelector('.node-label-container[data-node="${firstBodyId}"] .objectLabel').click()`;
        await evaluate(window, selectFirstBody);
        await evaluate(window, `document.querySelector('[data-tool="rotate"]').click()`);
        await evaluate(window, `window.__debugTransform.simulateDragTo(0.4, 0, 0)`);
        await evaluate(window, selectFirstBody);
        await evaluate(window, `document.querySelector('[data-tool="scale"]').click()`);
        await evaluate(window, `window.__debugTransform.simulateDragTo(2, 1, 1)`);
        await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);

        // A manual edge between the two free bodies (rather than a component-library template,
        // none of which connect two freeBody nodes) so the add-on's edge-line/label feature has
        // a real connection to render -- the equation's content is irrelevant here, only that
        // sourceNodeId/targetNodeId land on two detected 6-DOF bodies.
        await newRelationship('Free body', 'Free body');
        await typeRelationshipPart('0');
        await waitFor(window, `document.querySelector('#equationDiagnostics').classList.contains('valid')`, 'The Pose link part did not become valid.');
        await evaluate(window, `document.querySelector('#edgeEditor [data-editor-tab="details"]').click()`);
        await typeInto(`document.querySelector('#editEdgeName')`, 'Pose link');
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);

        await openRunDialog(window);
        await evaluate(window, `(() => { document.querySelector('#runTargetTime').value = '1'; document.querySelector('#startRun').click(); })()`);
        // The label already reads "Results" before the run starts, so wait for the completed run's Extend button instead.
        await waitFor(window, `!document.querySelector('#continueRun').hidden && document.querySelector('#continueRun').textContent === 'Extend simulation'`, 'Offline run did not complete.', 30000);
    });

    await run('Pose Visualizer add-on inspects a completed run with two free bodies', async () => {
        // The toolstrip command itself, not just the ability to click it, is desktop-only -- see
        // the identical note on the Results Analysis add-on's own split above.
        await waitFor(window, `Boolean(document.querySelector('.addonTool[data-addon-id="konjugate.poseVisualizer"][data-command-id="openPoseVisualizer"]:not([hidden])'))`, 'Pose Visualizer toolstrip command did not appear.');
        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('.addonTool[data-addon-id="konjugate.poseVisualizer"][data-command-id="openPoseVisualizer"]').click()`);
        const poseWindow = await driver.waitForNewHandle(before);

        const consoleMessages = await captureConsoleMessages(poseWindow, async () => {
            await waitFor(poseWindow, `Boolean(document.querySelector('.konjugateAddonTitlebar'))`, 'Host titlebar was not added to the Pose Visualizer window.');
            assert.equal(await evaluate(poseWindow, `document.querySelector('.konjugateAddonIdentity b').textContent`), 'Pose Visualizer');
            await waitFor(poseWindow, `getComputedStyle(document.querySelector('.konjugateAddonTitlebar')).position === 'fixed'`, 'Host titlebar styles did not load.');
            await waitFor(poseWindow, `document.querySelectorAll('.bodyOption').length === 2`, 'Pose Visualizer did not detect both free body nodes.');
            assert.match(await evaluate(poseWindow, `document.querySelector('.bodyOption b').textContent`), /Free body/);
            assert.equal(await evaluate(poseWindow, `document.querySelector('.sceneWorkspace').classList.contains('hasBodies')`), true);
            assert.ok(await evaluate(poseWindow, `document.querySelector('#scene').clientWidth`) > 0);
            assert.equal(await evaluate(poseWindow, `typeof require === 'undefined'`), true);

            assert.equal(await evaluate(poseWindow, `document.querySelector('#edgeLabels').children.length`), 0);
            await evaluate(poseWindow, `document.querySelector('#showConnections').click()`);
            await waitFor(poseWindow, `document.querySelector('#edgeLabels').children.length === 1`, 'Enabling connections did not draw the edge line/label.');
            assert.equal(await evaluate(poseWindow, `document.querySelector('.edgeLabel').textContent`), 'Pose link');
            await evaluate(poseWindow, `document.querySelector('#showConnections').click()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#edgeLabels').children.length`), 0);

            await evaluate(poseWindow, `document.querySelector('#useEditorShapes').click()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#useEditorShapes').checked`), true);
            const editorShapeTransform = await evaluate(poseWindow, `window.__debugPoseVisualizer.shapeTransform(${firstBodyId})`);
            assert.ok(editorShapeTransform, 'Pose Visualizer did not build a shape sub-group for the rotated/scaled body.');
            assert.deepEqual(editorShapeTransform.rotation.map((v) => Math.round(v * 100) / 100), [0.4, 0, 0]);
            assert.deepEqual(editorShapeTransform.scale, [2, 1, 1]);
            await evaluate(poseWindow, `document.querySelector('#useEditorShapes').click()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#useEditorShapes').checked`), false);
            const defaultShapeTransform = await evaluate(poseWindow, `window.__debugPoseVisualizer.shapeTransform(${firstBodyId})`);
            assert.deepEqual(defaultShapeTransform, { rotation: [0, 0, 0], scale: [1, 1, 1] });

            await evaluate(poseWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = String(Number(timeline.max) / 2); timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await waitFor(window, `document.querySelector('#resultCurrentTime').value !== '0 s'`, 'Visualizer seek did not synchronize to the project window.');

            await evaluate(poseWindow, `document.querySelector('.bodyOption input').click()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('.bodyOption input').checked`), false);

            await waitFor(poseWindow, `document.querySelector('#runLifecycle').textContent === 'Completed'`, 'Pose Visualizer did not report the run as completed.');
            assert.equal(await evaluate(poseWindow, `document.querySelector('#playPause').disabled`), false);
            await evaluate(poseWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = '0'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await waitFor(window, `document.querySelector('#resultCurrentTime').value === '0 s'`, 'Resetting the add-on timeline to zero did not synchronize.');
            await evaluate(poseWindow, `document.querySelector('#playPause').click()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#playPause').textContent`), '❚❚');
            await waitFor(poseWindow, `document.querySelector('#playPause').textContent === '▶'`, 'Add-on-driven playback did not reach the end and stop.', 5000);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#timeline').value`), await evaluate(poseWindow, `document.querySelector('#timeline').max`));
            await waitFor(window, `document.querySelector('#resultCurrentTime').value === '1 s'`, 'Main window did not sync to the end of add-on-driven playback.');

            await evaluate(poseWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = '0'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await evaluate(poseWindow, `document.querySelector('#playPause').click()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#playPause').textContent`), '❚❚');
            await evaluate(poseWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = '0.5'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#playPause').textContent`), '▶', 'Manually scrubbing the timeline did not stop playback.');
        });
        assert.deepEqual(consoleMessages.filter((message) => /error|uncaught|exception/i.test(message)), []);

        // Extended with the add-on open, the run going on is followed live in it, to its new end, as the run was.
        await evaluate(window, `document.querySelector('#continueRun').click()`);
        await waitFor(window, `document.querySelector('#runLaunchDialog').open`, 'Extend simulation did not open the Run dialog.');
        await evaluate(window, `(() => {
            const online = document.querySelector('#runOnlineMode');
            if (!online.checked) { online.checked = true; online.dispatchEvent(new Event('change', { bubbles: true })); }
            const pacing = document.querySelector('#runPacingMode');
            pacing.value = 'realTime';
            pacing.dispatchEvent(new Event('change', { bubbles: true }));
            document.querySelector('#runTargetTime').value = '3';
            document.querySelector('#startRun').click();
        })()`);
        await waitFor(poseWindow, `/^Live/.test(document.querySelector('#runLifecycle').textContent)`, 'The add-on did not follow the extended run live.', 15000);
        assert.equal(await evaluate(poseWindow, `document.querySelector('#timeline').max`), '3', 'The add-on did not take the extended run\'s new end.');
        await waitFor(poseWindow, `document.querySelector('#runLifecycle').textContent === 'Completed'`, 'The add-on did not see the extended run complete.', 15000);
        await evaluate(window, `(() => { const online = document.querySelector('#runOnlineMode'); online.checked = false; online.dispatchEvent(new Event('change', { bubbles: true })); })()`);

        await closeWhenValidated(poseWindow);
        for (let attempt = 0; attempt < 100 && !(await poseWindow.isDestroyed()); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(await poseWindow.isDestroyed(), true);
    }, { skip: (!driver.capabilities.addons && 'the Pose Visualizer add-on has no web-edition equivalent') || addonMissing('konjugate.poseVisualizer', 'konjugate-posevisualizer') });

    await run('Pose Visualizer add-on keeps body mappings with the project and naming conventions for the user', async () => {
        const toolstripCommand = `document.querySelector('.addonTool[data-addon-id="konjugate.poseVisualizer"][data-command-id="openPoseVisualizer"]')`;
        const openPoseWindow = async () => {
            const before = driver.allHandles();
            await evaluate(window, `${toolstripCommand}.click()`);
            const handle = await driver.waitForNewHandle(before);
            await waitFor(handle, `Boolean(document.querySelector('.konjugateAddonTitlebar'))`, 'The Pose Visualizer window did not open.');
            return handle;
        };
        const closePoseWindow = async (handle) => {
            await closeWhenValidated(handle);
            for (let attempt = 0; attempt < 100 && !(await handle.isDestroyed()); attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        };
        const row = (entityId) => `document.querySelector('.bodyRow:has(.bodyOption[data-entity-id="${entityId}"])')`;
        const hints = `[...document.querySelectorAll('.bodyOption small')].map((hint) => hint.textContent)`;
        const bodyIds = (await evaluate(window, `window.__debugTransform.allNodeIds()`)).filter((id) => id !== firstBodyId);

        let poseWindow = await openPoseWindow();
        const consoleMessages = await captureConsoleMessages(poseWindow, async () => {
            await waitFor(poseWindow, `document.querySelectorAll('.bodyOption').length === 2`, 'Pose Visualizer did not detect both free body nodes.');
            const secondBodyId = await evaluate(poseWindow, `Number([...document.querySelectorAll('.bodyOption')].map((option) => option.dataset.entityId).find((id) => Number(id) !== ${firstBodyId}))`);
            assert.ok(bodyIds.includes(secondBodyId));

            // Without Konjugate's own names, neither node is a body ...
            await evaluate(poseWindow, `document.querySelector('#conventions .conventionRow input').click()`);
            await waitFor(poseWindow, `document.querySelectorAll('.bodyOption').length === 0`, 'Turning off the default convention did not remove its bodies.');
            assert.equal(await evaluate(poseWindow, `document.querySelector('.sceneWorkspace').classList.contains('hasBodies')`), false);
            // ... until a convention of the user's own finds a 2-DOF body in each.
            await evaluate(poseWindow, `document.querySelector('#newConvention').click()`);
            await evaluate(poseWindow, `(() => {
                const form = document.querySelector('#conventionForm');
                form.elements.name.value = 'Planar';
                form.elements.x.value = 'x';
                form.elements.y.value = 'y';
                form.requestSubmit();
            })()`);
            await waitFor(poseWindow, `document.querySelectorAll('.bodyOption').length === 2`, 'A new convention did not find its bodies.');
            assert.deepEqual(await evaluate(poseWindow, hints), ['x, y', 'x, y']);

            // A role mapped by hand for one node: the first free body also turns about z.
            await evaluate(poseWindow, `${row(firstBodyId)}.querySelector('.iconButton').click()`);
            await evaluate(poseWindow, `(() => {
                const select = ${row(firstBodyId)}.querySelector('select[aria-label^="Yaw"]');
                select.value = [...select.options].find((option) => option.textContent.startsWith('yaw')).value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            })()`);
            await waitFor(poseWindow, `${row(firstBodyId)}?.querySelector('small').textContent === 'x, y, yaw'`, 'Mapping yaw by hand did not reach the body.');
            // And the other node is no body at all, but can be added back.
            await evaluate(poseWindow, `${row(secondBodyId)}.querySelector('.iconButton').click()`);
            await evaluate(poseWindow, `[...${row(secondBodyId)}.querySelectorAll('.editorActions button')].find((button) => button.textContent === 'Remove body').click()`);
            await waitFor(poseWindow, `document.querySelectorAll('.bodyOption').length === 1`, 'Removing a body did not take it out of the scene.');
            assert.equal(await evaluate(poseWindow, `[...document.querySelector('#addBody').options].some((option) => option.value === '${secondBodyId}')`), true);
        });
        assert.deepEqual(consoleMessages.filter((message) => /error|uncaught|exception/i.test(message)), []);
        await closePoseWindow(poseWindow);

        // Reopened, the window has both back: the convention from the user's settings, the mapping and the removal from the project.
        poseWindow = await openPoseWindow();
        await waitFor(poseWindow, `document.querySelectorAll('.bodyOption').length === 1`, 'The project did not keep the removed body out.');
        assert.deepEqual(await evaluate(poseWindow, hints), ['x, y, yaw']);
        assert.deepEqual(await evaluate(poseWindow, `[...document.querySelectorAll('#conventions .conventionRow')].map((entry) => [entry.querySelector('b').textContent, entry.querySelector('input').checked])`), [['Konjugate', false], ['Planar', true]]);

        // Put the user's settings back as they were for the rest of the suite.
        await evaluate(poseWindow, `document.querySelector('#conventions .conventionRow input').click()`);
        await evaluate(poseWindow, `document.querySelector('#conventions .conventionRow:nth-child(2) button[aria-label^="Delete"]').click()`);
        await waitFor(poseWindow, `document.querySelectorAll('#conventions .conventionRow').length === 1`, 'Deleting the convention did not remove it.');
        await closePoseWindow(poseWindow);
    }, { skip: (!driver.capabilities.addons && 'the Pose Visualizer add-on has no web-edition equivalent') || addonMissing('konjugate.poseVisualizer', 'konjugate-posevisualizer') });

    await run('closing results and removing the free-body nodes cleans up the pose scenario', async () => {
        // The run may still be finishing, and closing is refused until it has, so keep asking until the confirmation appears.
        await waitFor(window, `document.querySelector('#closeResultsDialog').open || (document.querySelector('#closeResults').click(), document.querySelector('#closeResultsDialog').open)`, 'Closing results did not request confirmation.', 30000);
        await evaluate(window, `document.querySelector('#confirmCloseResults').click()`);
        await waitFor(window, `document.querySelector('#addButton') && !document.querySelector('#addButton').disabled`, 'Model editing did not re-enable after closing results.');
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((l) => l.textContent.includes('Free body'))?.click()`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((l) => l.textContent.includes('Free body'))?.click()`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
    });

    await run('importing a node shape file also saves it into the user shape library', async () => {
        await freshExample();
        // Deliberately operates on whatever node is already on the canvas at this point in the
        // suite, rather than loading a fresh example -- by now the document is dirty from many
        // earlier tests, and loading a new example would raise a native "Discard changes?"
        // dialog that executeJavaScript can't click. The specific project content is irrelevant
        // to what's under test here (the upload-to-library wiring), so any node will do.
        await waitFor(window, `document.querySelectorAll('.objectLabel').length > 0`, 'No node available to select for the upload test.');
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'Node editor did not open.');
        await evaluate(window, `document.querySelector('[data-editor-tab="appearance"]').click()`);
        await waitFor(window, `!document.querySelector('[data-editor-panel="appearance"]').hidden`, 'Appearance tab did not open.');

        const stlContent = 'solid uploadTest\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid uploadTest\n';
        await evaluate(window, `(() => {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(new File([${JSON.stringify(stlContent)}], 'uploadTest.stl', { type: 'model/stl' }));
            const input = document.querySelector('#editNodeGeometryFile');
            input.files = dataTransfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitFor(window, `document.querySelector('#editGeometryStatus').textContent.includes('saved to shape library')`, 'Upload did not report being saved to the shape library.');

        const shapes = await evaluate(window, `window.shapeLibrary.list()`);
        const uploaded = shapes.find((shape) => shape.domain === 'userUploaded' && shape.name === 'uploadTest');
        assert.ok(uploaded, `Expected an uploaded shape library entry, got: ${JSON.stringify(shapes.map((s) => s.id))}`);

        await evaluate(window, `document.querySelector('#editBrowseShapeLibrary').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDialog').open`, 'Shape library dialog did not open.');
        assert.ok(await evaluate(window, `[...document.querySelectorAll('#shapeLibraryDomains button')].some((b) => b.textContent === 'User uploaded')`), 'No "User uploaded" domain chip appeared.');
        assert.ok(await evaluate(window, `[...document.querySelectorAll('.shapeLibraryItem b')].some((b) => b.textContent === 'uploadTest')`), 'Uploaded shape did not appear in the library grid.');
        await evaluate(window, `document.querySelector('#shapeLibraryCancel').click()`);
    });

    await run('rotate and scale tools transform a node with undo/redo and persist through copy/paste', async () => {
        await freshExample();
        await waitFor(window, `document.querySelectorAll('.objectLabel').length > 0`, 'No node available to select.');
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        const nodeId = await evaluate(window, `window.__debugTransform.selectedId()`);
        assert.ok(nodeId, 'No node was selected.');

        // --- Rotate ---
        await evaluate(window, `document.querySelector('[data-tool="rotate"]').click()`);
        assert.equal(await evaluate(window, `window.__debugTransform.mode()`), 'rotate');
        assert.equal(await evaluate(window, `window.__debugTransform.attachedId()`), nodeId);
        await evaluate(window, `window.__debugTransform.simulateDragTo(0.3, 0.5, 0.7)`);
        let rotation = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'rotation')`);
        assert.deepEqual(rotation.map((v) => Math.round(v * 100) / 100), [0.3, 0.5, 0.7]);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        rotation = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'rotation')`);
        assert.deepEqual(rotation, [0, 0, 0]);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true }))`);
        rotation = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'rotation')`);
        assert.deepEqual(rotation.map((v) => Math.round(v * 100) / 100), [0.3, 0.5, 0.7]);

        // --- Scale ---
        // undo()/redo() unconditionally clearSelection() before replaying (renderer.mjs) -- an
        // existing, intentional app behavior, not specific to rotate/scale -- so the node needs
        // reselecting here regardless of which tool is active.
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        await evaluate(window, `document.querySelector('[data-tool="scale"]').click()`);
        assert.equal(await evaluate(window, `window.__debugTransform.mode()`), 'scale');
        assert.equal(await evaluate(window, `window.__debugTransform.attachedId()`), nodeId);
        await evaluate(window, `window.__debugTransform.simulateDragTo(2, 1.5, 3)`);
        let scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, [2, 1.5, 3]);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, [1, 1, 1]);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true }))`);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, [2, 1.5, 3]);

        // --- Appearance tab: precise rotation/scale number inputs ---
        // The scale redo just above clears selection/closes the editor (same undo()/redo()
        // clearSelection() behavior noted earlier), so the node needs reselecting before its
        // Appearance tab fields can be read or edited.
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        await evaluate(window, `document.querySelector('[data-editor-tab="appearance"]').click()`);
        let rotationDegrees = await evaluate(window, `[document.querySelector('#editNodeRotationX').value, document.querySelector('#editNodeRotationY').value, document.querySelector('#editNodeRotationZ').value].map(Number)`);
        assert.deepEqual(rotationDegrees.map((v) => Math.round(v)), [17, 29, 40]);
        let scaleFields = await evaluate(window, `[document.querySelector('#editNodeScaleX').value, document.querySelector('#editNodeScaleY').value, document.querySelector('#editNodeScaleZ').value].map(Number)`);
        assert.deepEqual(scaleFields, [2, 1.5, 3]);

        // Typing a precise value commits it, going through the same node-object mutation and
        // undo history as a gizmo drag.
        await evaluate(window, `(() => { const input = document.querySelector('#editNodeRotationX'); input.value = '90'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        rotation = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'rotation')`);
        assert.deepEqual(rotation.map((v) => Math.round(v * 100) / 100), [1.57, 0.5, 0.7]);

        // Live gizmo drags refresh the open Appearance tab fields too, not just typed edits.
        await evaluate(window, `document.querySelector('[data-tool="scale"]').click()`);
        await evaluate(window, `window.__debugTransform.simulateDragTo(4, 1.5, 3)`);
        scaleFields = await evaluate(window, `[document.querySelector('#editNodeScaleX').value, document.querySelector('#editNodeScaleY').value, document.querySelector('#editNodeScaleZ').value].map(Number)`);
        assert.deepEqual(scaleFields, [4, 1.5, 3]);

        // Zero/negative scale is rejected (would collapse or invert the geometry) and the field
        // snaps back to the last valid value instead of committing.
        await evaluate(window, `(() => { const input = document.querySelector('#editNodeScaleY'); input.value = '0'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        scaleFields = await evaluate(window, `[document.querySelector('#editNodeScaleX').value, document.querySelector('#editNodeScaleY').value, document.querySelector('#editNodeScaleZ').value].map(Number)`);
        assert.deepEqual(scaleFields, [4, 1.5, 3]);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, [4, 1.5, 3]);

        // Undo back through the gizmo scale-drag and the typed rotation edit (the rejected
        // scale never recorded history) to restore what the earlier gizmo section left behind,
        // so the copy/paste assertions below still see [0.3, 0.5, 0.7] / [2, 1.5, 3].
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        rotation = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'rotation')`);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(rotation.map((v) => Math.round(v * 100) / 100), [0.3, 0.5, 0.7]);
        assert.deepEqual(scale, [2, 1.5, 3]);

        // --- Persistence through copy/paste, which round-trips via the same
        // serializeProjectDocument -> hydrateProjectDocument path a real save/reload would. ---
        await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        const nodeCountBefore = await evaluate(window, `document.querySelectorAll('.node-label-container').length`);
        // Diffing the node-ID set (rather than matching on a " copy" title suffix) avoids
        // mistaking this for some unrelated leftover "X copy" node other tests earlier in the
        // full suite may have already created and left on the canvas.
        const idsBefore = new Set(await evaluate(window, `window.__debugTransform.allNodeIds()`));
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === ${nodeCountBefore + 1}`, 'Paste did not create a new node.');
        const idsAfter = await evaluate(window, `window.__debugTransform.allNodeIds()`);
        const pastedId = idsAfter.find((id) => !idsBefore.has(id));
        assert.ok(pastedId, 'Could not find the pasted node.');
        const pastedRotation = await evaluate(window, `window.__debugTransform.nodeTransform(${pastedId}, 'rotation')`);
        const pastedScale = await evaluate(window, `window.__debugTransform.nodeTransform(${pastedId}, 'scale')`);
        assert.deepEqual(pastedRotation.map((v) => Math.round(v * 100) / 100), [0.3, 0.5, 0.7]);
        assert.deepEqual(pastedScale, [2, 1.5, 3]);

        // Cleanup: undo the paste and the scale/rotate changes so this test doesn't leave the
        // canvas mutated for whatever runs after it.
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
    });

    await run('shift held during a scale drag forces uniform scaling, even mid-drag', async () => {
        await freshExample();
        // window.__debugTransform.scaleDrag drives the real objectChange handler's Shift-uniform
        // override step by step (mouseDown / move / mouseUp), letting a test toggle Shift
        // between movement steps the same way a real drag would -- rather than real screen
        // coordinates raycast against the gizmo's 3D handle geometry, `move` sets the object's
        // scale directly to stand in for whatever a real per-axis drag would have produced, and
        // sets TransformControls' own pointStart/pointEnd (all uniformScaleFactorForDrag reads)
        // for the Shift-held steps.
        await waitFor(window, `document.querySelectorAll('.objectLabel').length > 0`, 'No node available to select.');
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        const nodeId = await evaluate(window, `window.__debugTransform.selectedId()`);
        assert.ok(nodeId, 'No node was selected.');
        await evaluate(window, `document.querySelector('[data-tool="scale"]').click()`);
        assert.equal(await evaluate(window, `window.__debugTransform.mode()`), 'scale');
        const startScale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);

        await evaluate(window, `window.__debugTransform.scaleDrag.mouseDown()`);

        // Without Shift, a normal (non-uniform) per-axis drag is left untouched.
        let scale = await evaluate(window, `window.__debugTransform.scaleDrag.move({ manualScale: [2, 1, 1], shiftHeld: false })`);
        assert.deepEqual(scale, [2, 1, 1]);

        // Pressing Shift mid-drag immediately snaps to uniform scaling, computed from the drag's
        // *original* start scale (captured at mouseDown, not the intermediate value above) and
        // the pointStart/pointEnd distance ratio TransformControls' own centre-handle math uses
        // -- this is the actual scenario that was reported broken (Shift pressed mid-drag).
        scale = await evaluate(window, `window.__debugTransform.scaleDrag.move({ pointStart: [1, 0, 0], pointEnd: [2, 0, 0], shiftHeld: true })`);
        assert.deepEqual(scale, startScale.map((value) => value * 2));

        // Releasing Shift mid-drag resumes normal per-axis behaviour.
        scale = await evaluate(window, `window.__debugTransform.scaleDrag.move({ manualScale: [3, 1, 1], shiftHeld: false })`);
        assert.deepEqual(scale, [3, 1, 1]);

        await evaluate(window, `window.__debugTransform.scaleDrag.mouseUp()`);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, [3, 1, 1]);

        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, startScale);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true }))`);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, [3, 1, 1]);

        // Cleanup: undo back to the starting scale so this test doesn't leave the canvas
        // mutated for whatever runs after it.
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);
    });

    await run('rotate tool revolves a multi-node selection around the pivot as a rigid group', async () => {
        // Fresh nodes, not nodes already on the canvas, so both start at a guaranteed identity
        // rotation -- letting the revolve math below be checked with plain 2D rotation
        // trigonometry instead of needing to account for whatever pre-existing orientation an
        // example project's nodes might carry.
        const idsBefore = new Set(await evaluate(window, `window.__debugTransform.allNodeIds()`));
        await evaluate(window, `document.querySelector('#componentLibraryButton').click()`);
        await waitFor(window, `!document.querySelector('#componentLibraryPanel').hidden`, 'Component library panel did not open.');
        await waitFor(window, `document.querySelectorAll('.componentLibraryItem').length > 0`, 'Component library did not load any templates.');
        await evaluate(window, `document.querySelector('[data-template-id="freeBody"]').click()`);
        await evaluate(window, `document.querySelector('[data-template-id="freeBody"]').click()`);
        await evaluate(window, `document.querySelector('#closeComponentLibraryPanel').click()`);
        const newIds = (await evaluate(window, `window.__debugTransform.allNodeIds()`)).filter((id) => !idsBefore.has(id));
        assert.equal(newIds.length, 2, 'Expected exactly two new free body nodes.');
        const [pivotId, otherId] = newIds;
        const selectPivot = `document.querySelector('.node-label-container[data-node="${pivotId}"] .objectLabel').click()`;
        const selectOther = `document.querySelector('.node-label-container[data-node="${otherId}"] .objectLabel').click()`;

        // CSS2D labels for freshly-created nodes aren't inserted into the DOM synchronously --
        // CSS2DRenderer only appends them on the next throttled render tick (~30fps), the same
        // reasoning documented on addNode() in the edge-groups test below. Both nodes were
        // created back to back with little work between them, so without this wait, the clicks
        // further down can intermittently fire before one or both labels have actually rendered.
        await waitFor(window,
            `Boolean(document.querySelector('.node-label-container[data-node="${pivotId}"] .objectLabel')) `
            + `&& Boolean(document.querySelector('.node-label-container[data-node="${otherId}"] .objectLabel'))`,
            'The free body nodes\' labels did not render.');

        // Earlier tests in the suite pan and zoom the camera and never reset it, so by this
        // point it can be framed anywhere -- fit it to the model first so both freshly-placed
        // nodes are reliably on screen and clickable for the real mouse clicks below, rather
        // than landing wherever a prior test happened to leave the view.
        await evaluate(window, `document.querySelector('[data-nav-action="fit"]').click()`);

        assert.deepEqual(await evaluate(window, `window.__debugTransform.nodeTransform(${pivotId}, 'rotation')`), [0, 0, 0]);
        assert.deepEqual(await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'rotation')`), [0, 0, 0]);
        const pivotPosition = await evaluate(window, `window.__debugTransform.nodeTransform(${pivotId}, 'position')`);

        // Give the second node a known, meaningful offset from the pivot first, so the revolve
        // assertions below check real, non-trivial movement rather than however the component
        // library happened to place these two nodes relative to each other.
        await evaluate(window, selectOther);
        await evaluate(window, `document.querySelector('[data-tool="move"]').click()`);
        await evaluate(window, `window.__debugTransform.simulateDragTo(${pivotPosition[0] + 2}, ${pivotPosition[1]}, ${pivotPosition[2]})`);
        const otherStartPosition = await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'position')`);
        assert.deepEqual(otherStartPosition, [pivotPosition[0] + 2, pivotPosition[1], pivotPosition[2]]);

        // Select the pivot and switch to the rotate tool first, so the gizmo attaches to it --
        // then add the other node to the selection via window.__debugTransform.selectAdditive
        // (selectNode's own additive path, the same one a real Shift-click drives) rather than a
        // real screen-coordinate Shift-click. Whether a Shift-click lands on the right on-screen
        // label is a real-mouse/CSS2D-layout concern the existing multi-selection copy/paste
        // test already covers; what this test needs a multi-selection *for* is the group-rotate
        // math below, so establishing it directly keeps the test focused on that and avoids
        // depending on wherever this point in the full suite happens to leave the camera framed.
        // selectNode() reassigns the "primary" selectedNode to whichever node was added last
        // (needed so the node editor tracks it), but only reattaches the gizmo when the
        // currently-attached node has fallen out of the selection -- since the pivot stays
        // selected throughout, the gizmo (and this drag's pivot) stays on it rather than jumping
        // to the other node.
        await evaluate(window, selectPivot);
        await evaluate(window, `document.querySelector('[data-tool="rotate"]').click()`);
        assert.equal(await evaluate(window, `window.__debugTransform.attachedId()`), pivotId);
        await evaluate(window, `window.__debugTransform.selectAdditive(${otherId})`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), 2);
        assert.equal(await evaluate(window, `window.__debugTransform.attachedId()`), pivotId, 'The gizmo should stay on the originally-selected node.');

        // A pure 90 degree rotation around Z, so the other node's expected revolved position can
        // be checked with plain 2D rotation trigonometry.
        await evaluate(window, `window.__debugTransform.simulateDragTo(0, 0, Math.PI / 2)`);

        // The `|| 0` normalizes -0 to 0 -- quaternion-to-Euler conversion can legitimately land
        // on -0 for a component that's mathematically exactly zero (e.g. via an internal
        // atan2(-0, 1)), which is numerically harmless but would otherwise fail a strict
        // deepEqual against a literal 0 below.
        const round2 = (values) => values.map((v) => Math.round(v * 100) / 100 || 0);
        const round3 = (values) => values.map((v) => Math.round(v * 1000) / 1000 || 0);

        const pivotEndPosition = await evaluate(window, `window.__debugTransform.nodeTransform(${pivotId}, 'position')`);
        assert.deepEqual(pivotEndPosition, pivotPosition, "The pivot node's own position must not move during a rotate drag.");
        const pivotEndRotation = round2(await evaluate(window, `window.__debugTransform.nodeTransform(${pivotId}, 'rotation')`));
        assert.deepEqual(pivotEndRotation, [0, 0, 1.57]);
        const otherEndRotation = round2(await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'rotation')`));
        assert.deepEqual(otherEndRotation, pivotEndRotation, "Every selected node's own orientation should spin by the same amount.");

        // Rotating (1, 0, 0) by 90 degrees around Z gives (0, 1, 0): the other node, 2 units
        // along X from the pivot, should end up 2 units along Y from the pivot instead of
        // staying put and just spinning in place around its own centre.
        const expectedOtherPosition = round3([pivotPosition[0], pivotPosition[1] + 2, pivotPosition[2]]);
        const otherEndPosition = round3(await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'position')`));
        assert.deepEqual(otherEndPosition, expectedOtherPosition, 'The other selected node should revolve around the pivot, not spin in place.');

        // Undo restores both nodes' position and rotation together in one step; redo re-applies
        // the whole group rotation again.
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        assert.deepEqual(await evaluate(window, `window.__debugTransform.nodeTransform(${pivotId}, 'rotation')`), [0, 0, 0]);
        assert.deepEqual(await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'rotation')`), [0, 0, 0]);
        assert.deepEqual(await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'position')`), otherStartPosition);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true }))`);
        const otherRedoPosition = round3(await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'position')`));
        assert.deepEqual(otherRedoPosition, expectedOtherPosition);

        // Cleanup: delete both newly-created nodes so this test doesn't leave the canvas
        // mutated for whatever runs after it.
        await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);
        await evaluate(window, selectPivot);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
        await evaluate(window, selectOther);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
    });

    await run('edge group meshes a selection, edits its shared definition (parameters, a program, bindings), and supports detach, add, delete and undo', async () => {
        const nodeLabel = (name) => `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes(${JSON.stringify(name)}) && !label.textContent.includes('copy'))`;
        const nodeIdFor = (name) => `Number(${nodeLabel(name)}.closest('.node-label-container').dataset.node)`;
        // The move tool is active so New node's own "attach the gizmo to whatever was just
        // created" behavior lets simulateDragTo spread each node to a distinct position --
        // a new node always spawns at the same [0, -0.7, 0], and three nodes left coincident
        // would leave every one of their CSS2D labels (and, in turn, every mesh edge's midpoint
        // bundle label) stacked at the same screen point, making click targeting ambiguous.
        await evaluate(window, `document.querySelector('[data-tool="move"]').click()`);
        const addNode = async (name, x) => {
            await makeNode(window, name, { name: 'Temperature', symbol: 'temperature', value: '300', unit: 'K' });
            // A newly created node's CSS2D label isn't inserted into the DOM synchronously with
            // model.nodes.push() -- CSS2DRenderer only appends it on the next throttled render
            // tick (~30fps). Three nodes created back to back with little work between them can
            // otherwise all fire before that tick ever lands.
            await waitFor(window, `Boolean(${nodeLabel(name)})`, `The label for "${name}" did not render.`);
            await evaluate(window, `window.__debugTransform.simulateDragTo(${x}, 0, 0)`);
        };
        const bundleLabel = (name) => `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes(${JSON.stringify(name)}))`;
        const relationshipCount = async () => Number((await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`)).match(/\d+/)[0]);
        // Real Shift-click's own screen-coordinate targeting is already covered by the
        // multi-selection copy/paste and bulk-disable tests above; this test's own subject is
        // edge-group behavior, so the selection is set in one step by the debug hook, exactly
        // these nodes and nothing else. (It was built from a real click on the first node, then
        // additive selects: the click's handling could land after them and make the first node
        // the only selection again, losing the second, and the count never reached three.)
        const selectAll = async (...names) => {
            await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);
            const ids = [];
            for (const name of names) ids.push(await evaluate(window, nodeIdFor(name)));
            await evaluate(window, `window.__debugTransform.selectExactly(${JSON.stringify(ids)})`);
            await waitFor(window, `(() => {
                const selected = [...document.querySelectorAll('.node-label-container.selected')].map((label) => Number(label.dataset.node));
                return selected.length === ${ids.length} && ${JSON.stringify(ids)}.every((id) => selected.includes(id));
            })()`, `The selection is not exactly ${names.join(', ')}.`);
        };

        await addNode('Group test A', 0);
        await addNode('Group test B', 3);
        await addNode('Group test C', 6);
        const before = await relationshipCount();

        await selectAll('Group test A', 'Group test B', 'Group test C');
        assert.equal(await evaluate(window, `document.querySelector('#createEdgeGroup').disabled`), false);

        const consoleMessages = await captureConsoleMessages(window, async () => {
            await evaluate(window, `document.querySelector('#createEdgeGroup').click()`);
            await waitFor(window, `!document.querySelector('#edgeGroupEditor').classList.contains('hidden')`, 'The edge group editor did not open.');
            // 3 members -> N(N-1) = 6 mesh edges: one directed edge each way per pair (see
            // docs/edgeDirectionality.md for why groups use directed pairs, not one bidirectional
            // edge per pair).
            await waitFor(window, `document.querySelectorAll('.modelStatus span')[1].textContent === '${before + 6} relationships'`, 'The mesh did not create 6 edges.');

            await evaluate(window, `(() => {
                const output = document.querySelector('#groupEquationOutput');
                output.value = 'temperature';
                output.dispatchEvent(new Event('change', { bubbles: true }));
                const field = document.querySelector('#groupMathField');
                field.setValue('\\\\mathrm{sourceTemperature}-\\\\mathrm{targetTemperature}');
                field.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await waitFor(window, `document.querySelector('#groupEquationDiagnostics').classList.contains('valid')`, 'The group equation did not validate.');
            // Autosaves live, like the node/edge editors -- the "change" event (matching a real
            // blur) is what finishes the equation-typing session and commits its undo step,
            // there is no separate Save action to click anymore.
            await evaluate(window, `document.querySelector('#groupMathField').dispatchEvent(new Event('change', { bubbles: true }))`);
        });
        assert.deepEqual(consoleMessages, [], 'Saving the edge group logged unexpected console messages.');
        assert.equal(await evaluate(window, `document.querySelector('#groupEquationDiagnostics').classList.contains('valid')`), true);

        await waitFor(window, `Boolean(${bundleLabel('Group test A')})`, 'A mesh edge bundle label was not available.');
        // The camera framing the new group comes to rest before the label is read.
        await waitForCanvasAtRest(window, 'The mesh edge bundle label');
        // The bundle label's naive center point can be occluded by one of its own endpoint
        // nodes' labels at this camera framing (confirmed: document.elementFromPoint() there
        // resolves to the node's objectLabel, not the bundle label) -- find a point within the
        // bundle label's own rect that it actually owns for hit-testing before clicking it.
        const openedGroupMenu = await retryGesture(window,
            async () => {
                const point = await findUnoccludedPoint(window, bundleLabel('Group test A'));
                await window.mouseMove(point);
                await window.mouseDown(point, { button: 'right', clickCount: 1 });
                await window.mouseUp(point, { button: 'right', clickCount: 1 });
            },
            `!document.querySelector('#edgeContextMenu').classList.contains('hidden')`);
        assert.ok(openedGroupMenu, 'Right-clicking a mesh edge did not open its context menu after 5 attempts.');
        assert.equal(await evaluate(window, `document.querySelector('#edgeContextOpenGroup').hidden`), false);
        assert.equal(await evaluate(window, `document.querySelector('#edgeContextDelete').hidden`), true);
        await evaluate(window, `document.querySelector('#edgeContextOpenGroup').click()`);
        await waitFor(window, `!document.querySelector('#edgeGroupEditor').classList.contains('hidden')`, 'Opening the edge group from its context menu failed.');
        assert.equal(await evaluate(window, `document.querySelectorAll('#groupMembersList .groupMemberRow').length`), 3);

        // The group's one definition, edited in its card, reaches every edge of the mesh: a shared parameter, a program in place of
        // the equation, its bindings and output, and back to the equation it had.
        const groupName = await evaluate(window, `document.querySelector('#groupName').value`);
        const savedGroup = () => evaluate(window, `(() => {
            const document_ = window.__debugProject.serialize();
            const group = document_.edgeGroups.find((candidate) => candidate.name === ${JSON.stringify(groupName)} && !candidate.deleted);
            return { group, members: document_.edges.filter((edge) => edge.groupId === group.id) };
        })()`);
        const setField = (selector, value) => evaluate(window, `(() => {
            const field = document.querySelector(${JSON.stringify(selector)});
            field.value = ${JSON.stringify(value)};
            field.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        const parameterField = (field) => `#groupParameterRows .parameterRow [data-field="${field}"]`;
        const isHidden = (selector) => evaluate(window, `document.querySelector(${JSON.stringify(selector)}).hidden`);
        assert.equal((await savedGroup()).members.length, 6);

        await evaluate(window, `document.querySelector('#groupAddParameter').click()`);
        await waitFor(window, `document.querySelectorAll('#groupParameterRows .parameterRow').length === 1`, 'Adding a shared parameter did not add its row.');
        await setField(parameterField('symbol'), 'gain');
        await setField(parameterField('value'), '2.5');
        let saved = await savedGroup();
        assert.deepEqual(saved.group.definition.parameters.map(({ symbol, value }) => ({ symbol, value })), [{ symbol: 'gain', value: 2.5 }]);
        assert.ok(saved.members.every((edge) => edge.parameters.some((parameter) => parameter.symbol === 'gain' && parameter.value === 2.5)),
            'Every edge of the group should carry its shared parameter.');
        // A symbol the model cannot use is refused, with the reason, and the one it had is kept.
        await setField(parameterField('symbol'), 'Gain');
        assert.notEqual(await evaluate(window, `document.querySelector('#editGroupError').textContent`), '', 'A symbol that is not valid should be refused with a reason.');
        assert.equal(await evaluate(window, `document.querySelector(${JSON.stringify(parameterField('symbol'))}).value`), 'gain');
        assert.equal((await savedGroup()).group.definition.parameters[0].symbol, 'gain');
        // Live: its range fields show, and it is kept with a range.
        await setField(parameterField('mode'), 'live');
        assert.equal(await isHidden('#groupParameterRows .parameterControlFields'), false);
        saved = await savedGroup();
        assert.equal(saved.group.definition.parameters[0].mode, 'live');
        assert.equal(typeof saved.group.definition.parameters[0].control, 'object');
        assert.equal(await evaluate(window, `document.querySelector('#editGroupError').textContent`), '', 'An accepted change clears the refusal.');

        // A program in place of the equation: the equation's fields go, the program's come, and every edge runs the program.
        await setField('#groupImplementationKind', 'python');
        await waitFor(window, `!document.querySelector('#groupProviderSection').hidden`, 'Choosing a program did not show its section.');
        assert.equal(await isHidden('#groupEquationHeading'), true);
        assert.equal(await isHidden('#groupReferenceHint'), true);
        saved = await savedGroup();
        assert.equal(saved.group.definition.implementation.kind, 'python');
        assert.ok(saved.group.definition.implementation.source.trim(), 'A program starts from a template, not empty.');
        assert.ok(saved.members.every((edge) => edge.implementation?.kind === 'python'), 'Every edge of the group should run its program.');
        assert.equal(await evaluate(window, `document.querySelectorAll('#groupProviderBindingRows .providerBindingRow').length`), 0);
        assert.ok(await evaluate(window, `Boolean(document.querySelector('#groupProviderBindingRows .emptyEditorState'))`));

        // A binding: added with a key of its own, renamed, pointed at the shared parameter, then removed.
        await evaluate(window, `document.querySelector('#groupAddProviderBinding').click()`);
        await waitFor(window, `document.querySelectorAll('#groupProviderBindingRows .providerBindingRow').length === 1`, 'Adding a binding did not add its row.');
        assert.equal((await savedGroup()).group.definition.implementation.bindings.length, 1);
        await setField('#groupProviderBindingRows .providerBindingRow [data-field="key"]', 'boost');
        assert.equal((await savedGroup()).group.definition.implementation.bindings[0].key, 'boost');
        const parameterReference = await evaluate(window, `[...document.querySelectorAll('#groupProviderBindingRows [data-field="reference"] option')].find((option) => option.value.startsWith('parameter:'))?.value ?? null`);
        assert.ok(parameterReference, 'The shared parameter should be offered as a reference.');
        await setField('#groupProviderBindingRows .providerBindingRow [data-field="reference"]', parameterReference);
        saved = await savedGroup();
        assert.deepEqual(saved.group.definition.implementation.bindings.map(({ key, kind }) => ({ key, kind })), [{ key: 'boost', kind: 'parameter' }]);
        assert.equal(await evaluate(window, `document.querySelector('#groupProviderBindingRows [data-field="reference"]').value`), parameterReference, 'The binding row shows what it is bound to.');
        await setField('#groupProviderOutputKey', 'heatFlow');
        assert.equal((await savedGroup()).group.definition.implementation.output.key, 'heatFlow');
        await evaluate(window, `document.querySelector('#groupProviderBindingRows .providerBindingRow .removeBuilderRow').click()`);
        await waitFor(window, `document.querySelectorAll('#groupProviderBindingRows .providerBindingRow').length === 0`, 'Removing the binding did not remove its row.');
        assert.equal((await savedGroup()).group.definition.implementation.bindings.length, 0);

        // Back to the equation: the program goes from the group and from every edge, and the equation it had is still there.
        await setField('#groupImplementationKind', 'equation');
        await waitFor(window, `document.querySelector('#groupProviderSection').hidden`, 'Choosing an equation did not hide the program.');
        assert.equal(await isHidden('#groupEquationHeading'), false);
        saved = await savedGroup();
        assert.equal(saved.group.definition.implementation, null);
        assert.match(saved.group.definition.equation, /sourceTemperature/);
        assert.ok(saved.members.every((edge) => !edge.implementation), 'No edge of the group should still run the program.');
        await evaluate(window, `document.querySelector('#groupParameterRows .parameterRow .removeBuilderRow').click()`);
        await waitFor(window, `document.querySelectorAll('#groupParameterRows .parameterRow').length === 0`, 'Removing the shared parameter did not remove its row.');
        assert.equal((await savedGroup()).group.definition.parameters.length, 0);

        await evaluate(window, `[...document.querySelectorAll('#groupMembersList .groupMemberRow')].find((row) => row.textContent.includes('Group test C')).querySelector('.removeBuilderRow').click()`);
        await waitFor(window, `document.querySelectorAll('#groupMembersList .groupMemberRow').length === 2`, 'Detach did not remove the member row.');
        // Detaching C from the 3-member mesh un-groups its 4 edges (both directions to A and to
        // B) as ordinary edges -- nothing is deleted, so the total is still all 6 mesh edges.
        assert.equal(await relationshipCount(), before + 6, 'Detaching a member should leave its edges behind as ordinary edges, not delete them.');

        // Adding it back, with it the only node selected: two new edges to each member, beside the ordinary ones it left behind;
        // and undone, as one step.
        assert.equal(await evaluate(window, `document.querySelector('#groupAddMember').disabled`), true, 'With no single non-member selected, there is nothing to add.');
        const memberC = await evaluate(window, nodeIdFor('Group test C'));
        await evaluate(window, `window.__debugTransform.selectExactly([${memberC}])`);
        assert.equal(await evaluate(window, `document.querySelector('#edgeGroupEditor').classList.contains('hidden')`), false, 'Selecting one node should leave the group open.');
        // The card reads the selection when it is drawn again, which any change to the group does.
        const colourBefore = (await savedGroup()).group.color;
        await setField('#groupColor', '#3366cc');
        assert.notEqual((await savedGroup()).group.color, colourBefore);
        await waitFor(window, `!document.querySelector('#groupAddMember').disabled`, 'Add member was not offered for the one selected node.');
        await evaluate(window, `document.querySelector('#groupAddMember').click()`);
        await waitFor(window, `document.querySelectorAll('#groupMembersList .groupMemberRow').length === 3`, 'Add member did not add the node.');
        assert.equal(await relationshipCount(), before + 10);
        assert.equal((await savedGroup()).members.length, 6);
        // And detached again: its 4 new edges, too, are left behind as ordinary edges.
        await evaluate(window, `[...document.querySelectorAll('#groupMembersList .groupMemberRow')].find((row) => row.textContent.includes('Group test C')).querySelector('.removeBuilderRow').click()`);
        await waitFor(window, `document.querySelectorAll('#groupMembersList .groupMemberRow').length === 2`, 'Detaching it again did not remove the member row.');
        assert.equal(await relationshipCount(), before + 10);

        await evaluate(window, `document.querySelector('[data-delete-edge-group]').click()`);
        await waitFor(window, `document.querySelector('#edgeGroupEditor').classList.contains('hidden')`, 'Deleting the group did not close its editor.');
        // Only the group's own remaining mesh (A<->B, the sole pair with both endpoints still
        // members: 2 directed edges) is removed; C's 8 now-ordinary edges are untouched.
        assert.equal(await relationshipCount(), before + 8, 'Deleting the group should remove only its remaining mesh edges, leaving the 8 detached ones.');

        // Each step undone in turn (undo closes the card, so the group is read from the document).
        const memberCount = async () => (await savedGroup()).group.memberNodeIds.length;
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await relationshipCount(), before + 10, 'Undoing the group deletion did not restore its edges.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await memberCount(), 3, 'Undoing the second detach did not restore membership.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await relationshipCount(), before + 6, 'Undoing Add member did not take away the edges it made.');
        assert.equal(await memberCount(), 2, 'Undoing Add member did not take the node out again.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal((await savedGroup()).group.color, colourBefore, 'Undoing the colour did not put the group\'s own back.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await relationshipCount(), before + 6, 'Undoing the detach did not restore membership.');
        assert.equal(await memberCount(), 3);

        // Cleanup: delete the three throwaway nodes (and, with them, every mesh/detached edge)
        // so this test doesn't leave the canvas mutated for whatever runs after it.
        await selectAll('Group test A', 'Group test B', 'Group test C');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
        assert.equal(await relationshipCount(), before);
    });

    await run('causal inference proposes a lagged edge and materializes it as one undoable step', async () => {
        // columnA follows a genuine AR(1) process, and columnB[t] = 3*columnA[t-1] + noise, with
        // columnA independent of columnB -- the same one-directional generative shape validated
        // in engine/tests/causalInferenceTests.cpp's inferGraphFindsAOneDirectionalLaggedEdge.
        function buildLaggedPairCsv(rowCount = 60) {
            const random = mulberry32(2002);
            const a = [0.2];
            for (let t = 1; t < rowCount; t += 1) a.push(0.5 * a[t - 1] + 0.3 * gaussianFrom(random));
            const lines = ['time,columnA,columnB'];
            for (let t = 0; t < rowCount; t += 1) {
                const previousA = t > 0 ? a[t - 1] : a[0];
                lines.push(`${t},${a[t]},${3.0 * previousA + 0.05 * gaussianFrom(random)}`);
            }
            return `${lines.join('\n')}\n`;
        }

        const nodeLabel = (name) => `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes(${JSON.stringify(name)}) && !label.textContent.includes('copy'))`;
        const nodeCount = async () => Number((await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`)).match(/\d+/)[0]);
        const relationshipCount = async () => Number((await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`)).match(/\d+/)[0]);

        // An existing node whose state symbol exactly matches the CSV's "columnA" header --
        // exercising the "match an existing state, don't create a new node" mapping path.
        // "columnB" has no existing match, exercising "create a new node" instead.
        await evaluate(window, `document.querySelector('[data-tool="move"]').click()`);
        await makeNode(window, 'Import test A', { name: 'Column A', symbol: 'columnA', value: '0', unit: '' });
        await waitFor(window, `Boolean(${nodeLabel('Import test A')})`, 'The label for "Import test A" did not render.');
        await evaluate(window, `window.__debugTransform.simulateDragTo(0, 0, 0)`);

        const nodesBefore = await nodeCount();
        const edgesBefore = await relationshipCount();

        await evaluate(window, `document.querySelector('#causalInferenceButton').click()`);
        await waitFor(window, `!document.querySelector('#causalInference').classList.contains('hidden')`, 'The causal inference card did not open.');

        // A real OS file-picker dialog can't be driven by this harness (no Playwright
        // setInputFiles/CDP bridge) -- window.__debugCausalInference.loadCsv exercises the exact
        // same code path the real file input's change handler calls.
        await evaluate(window, `window.__debugCausalInference.loadCsv(${JSON.stringify(buildLaggedPairCsv())})`);
        await waitFor(window, `!document.querySelector('#causalInferenceMappingSection').hidden`, 'The column mapping section did not appear.');
        assert.equal(await evaluate(window, `document.querySelectorAll('#causalInferenceMappingRows .causalInferenceMappingRow').length`), 2);
        const mappingSelectValue = (index) => evaluate(window, `document.querySelectorAll('#causalInferenceMappingRows select')[${index}].value`);
        assert.notEqual(await mappingSelectValue(0), 'create', 'columnA should auto-match the existing node/state, not default to creating one.');
        assert.equal(await mappingSelectValue(1), 'create', 'columnB has no existing match and should default to creating a new node.');

        await evaluate(window, `document.querySelector('#runCausalInference').click()`);
        await waitFor(window, `!document.querySelector('#causalInferenceCandidatesSection').hidden`, 'The candidate list did not appear.', 15000);
        assert.equal(await evaluate(window, `
            [...document.querySelectorAll('#causalInferenceCandidateRows .causalInferenceCandidateMain')].some((span) => span.textContent.includes('columnA → columnB'))
        `), true, 'Expected a columnA -> columnB candidate.');
        assert.equal(await evaluate(window, `
            [...document.querySelectorAll('#causalInferenceCandidateRows .causalInferenceCandidateMain')].some((span) => span.textContent.includes('columnB → columnA'))
        `), false, 'Did not expect a spurious columnB -> columnA candidate.');
        assert.equal(await evaluate(window, `document.querySelector('#causalInferenceCandidateRows .causalInferenceCandidateTag.continuousLagged') !== null`), true,
            'Expected the accepted candidate to be tagged continuousLagged.');

        const consoleMessages = await captureConsoleMessages(window, async () => {
            await evaluate(window, `document.querySelector('#commitCausalInference').click()`);
            await waitFor(window, `document.querySelector('#causalInference').classList.contains('hidden')`, 'The causal inference card did not close after commit.', 15000);
        });
        assert.deepEqual(consoleMessages.filter((message) => /error|uncaught|exception/i.test(message)), []);

        assert.equal(await nodeCount(), nodesBefore + 1, 'Committing should have created exactly one new node for columnB.');
        assert.equal(await relationshipCount(), edgesBefore + 1, 'Committing should have created exactly one new edge.');

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await nodeCount(), nodesBefore, 'Undo should remove the created node.');
        assert.equal(await relationshipCount(), edgesBefore, 'Undo should remove the created edge.');

        await evaluate(window, `document.querySelector('#redoButton').click()`);
        assert.equal(await nodeCount(), nodesBefore + 1, 'Redo should restore the created node.');
        assert.equal(await relationshipCount(), edgesBefore + 1, 'Redo should restore the created edge.');

        // Cleanup: undo the import again, then delete the throwaway "Import test A" node so this
        // test doesn't leave the canvas mutated for whatever runs after it. replaceModelContents
        // (which every undo/redo above runs through) rebuilds every CSS2D label from scratch,
        // and that render is throttled to ~30fps -- after three rapid-fire history operations,
        // clickElement's own getBoundingClientRect() needs the label to have actually reappeared
        // in the DOM first.
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await nodeCount(), nodesBefore);
        await waitFor(window, `Boolean(${nodeLabel('Import test A')})`, 'The label for "Import test A" did not re-render after undo.');
        await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);
        // Its label clicked directly, as openNode does: this is about what inference made, not about aiming at the screen.
        await evaluate(window, `${nodeLabel('Import test A')}.click()`);
        await waitFor(window, `document.querySelector('#editNodeName').value === 'Import test A'`, 'Clicking "Import test A" did not open its node editor.');
        // The key goes to the canvas, as a person presses it with no field in use: the editor may have put the focus in its name field by
        // now, where Delete edits the text instead (which, depending on when the focus moved, once made this fail now and then).
        await evaluate(window, `(() => { document.activeElement?.blur?.(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); })()`);
        await waitFor(window, `document.querySelector('#nodeEditor').classList.contains('hidden')`, 'Deleting a node should close the editor that was open on it.');
    });

    await run('causal inference with curvature allowed recovers a quadratic edge equation', async () => {
        // Same deterministic-noise reasoning and AR(1)-driven columnP as the lagged-pair test
        // above, but columnQ[t] = 2*columnP[t-1] + 0.5*columnP[t-1]^2 + noise -- an exact
        // quadratic relationship, matching engine/tests/causalInferenceTests.cpp's
        // makeQuadraticPairSeries. That C++ test found 300 rows necessary for a robust fit at
        // this construction (fewer let a spurious reverse edge slip through finite-sample
        // overfitting on the richer degree-2 feature set); this test uses the same row count.
        function buildQuadraticPairCsv(rowCount = 300) {
            const random = mulberry32(5005);
            const p = [0.2];
            for (let t = 1; t < rowCount; t += 1) p.push(0.5 * p[t - 1] + 0.3 * gaussianFrom(random));
            const lines = ['time,columnP,columnQ'];
            for (let t = 0; t < rowCount; t += 1) {
                const previousP = t > 0 ? p[t - 1] : p[0];
                lines.push(`${t},${p[t]},${2.0 * previousP + 0.5 * previousP * previousP + 0.05 * gaussianFrom(random)}`);
            }
            return `${lines.join('\n')}\n`;
        }

        await evaluate(window, `document.querySelector('#causalInferenceButton').click()`);
        await waitFor(window, `!document.querySelector('#causalInference').classList.contains('hidden')`, 'The causal inference card did not open.');

        await evaluate(window, `window.__debugCausalInference.loadCsv(${JSON.stringify(buildQuadraticPairCsv())})`);
        await waitFor(window, `!document.querySelector('#causalInferenceMappingSection').hidden`, 'The column mapping section did not appear.');

        // Checks actual rendered visibility (getComputedStyle), not just the hidden DOM property --
        // .editorField's own `display: grid` is an author-stylesheet rule and so overrides the
        // browser's default `[hidden] { display: none }` regardless of selector specificity
        // (author rules beat user-agent rules at equal specificity); asserting only the property
        // previously let a real "field stays visible under Linear" bug pass silently.
        assert.equal(await isRenderedVisible(window, '#causalInferenceDegreeValueField'), false,
            '"Linear only" (the default) should not show the degree input.');

        await evaluate(window, `(() => {
            const select = document.querySelector('#causalInferenceDegreeMode');
            select.value = 'fixed';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            document.querySelector('#causalInferenceDegreeValue').value = '2';
        })()`);
        assert.equal(await isRenderedVisible(window, '#causalInferenceDegreeValueField'), true,
            'Selecting "Allow curvature up to degree..." should reveal the degree input.');

        await evaluate(window, `document.querySelector('#runCausalInference').click()`);
        await waitFor(window, `!document.querySelector('#causalInferenceCandidatesSection').hidden`, 'The candidate list did not appear.', 15000);
        assert.equal(await evaluate(window, `
            [...document.querySelectorAll('#causalInferenceCandidateRows .causalInferenceCandidateMain')].some((span) => span.textContent.includes('columnP → columnQ'))
        `), true, 'Expected a columnP -> columnQ candidate.');
        assert.equal(await evaluate(window, `
            [...document.querySelectorAll('#causalInferenceCandidateRows .causalInferenceCandidateMain')].some((span) => span.textContent.includes('columnQ → columnP'))
        `), false, 'Did not expect a spurious columnQ -> columnP candidate.');

        // The candidate list UI has no dedicated display for fitted polynomial terms (only
        // source/target/lag/score/provenance), so this reads the raw candidate data the "Allow
        // curvature" config actually produced -- the real thing this test needs to prove, since
        // committing and reopening the resulting edge only re-renders the same terms through
        // latexForFittedEdge, not an independent check.
        const candidates = await evaluate(window, `window.__debugCausalInference.candidates()`);
        const aToB = candidates.find((candidate) => candidate.sourceColumn === 'columnP' && candidate.targetColumn === 'columnQ');
        assert.ok(aToB, 'Expected a columnP -> columnQ candidate in the raw candidate data.');
        assert.ok(aToB.terms.some((term) => term.degree === 2),
            `Expected a degree-2 term with "Allow curvature up to degree 2" selected, got terms: ${JSON.stringify(aToB.terms)}`);

        const consoleMessages = await captureConsoleMessages(window, async () => {
            await evaluate(window, `document.querySelector('#commitCausalInference').click()`);
            await waitFor(window, `document.querySelector('#causalInference').classList.contains('hidden')`, 'The causal inference card did not close after commit.', 15000);
        });
        assert.deepEqual(consoleMessages.filter((message) => /error|uncaught|exception/i.test(message)), []);

        // A node created by causal inference should default to a sphere (commitCausalInference's
        // addNode operations), not the generic assistant/manual default of a box.
        const nodeLabel = (name) => `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes(${JSON.stringify(name)}) && !label.textContent.includes('copy'))`;
        await waitFor(window, `Boolean(${nodeLabel('columnP')})`, 'The label for the newly-created "columnP" node did not render.');
        // Its label clicked directly, as openNode does: this is about what inference made, not about aiming at the screen.
        await evaluate(window, `${nodeLabel('columnP')}.click()`);
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden') && document.querySelector('#editNodeName').value === 'columnP'`, 'Clicking the new columnP node did not open its node editor.');
        assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), 'sphere',
            'A node created by causal inference should default to a sphere shape.');
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);

        // Cleanup: undo the commit (removes both new nodes and the edge in one step, mirroring
        // how commitCausalInference records a single history entry), leaving the canvas as found.
        const nodesBefore = await evaluate(window, `Number(document.querySelectorAll('.modelStatus span')[0].textContent.match(/\\d+/)[0])`);
        const edgesBefore = await evaluate(window, `Number(document.querySelectorAll('.modelStatus span')[1].textContent.match(/\\d+/)[0])`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `Number(document.querySelectorAll('.modelStatus span')[0].textContent.match(/\\d+/)[0])`), nodesBefore - 2,
            'Undo should remove both nodes created for columnP and columnQ.');
        assert.equal(await evaluate(window, `Number(document.querySelectorAll('.modelStatus span')[1].textContent.match(/\\d+/)[0])`), edgesBefore - 1,
            'Undo should remove the created edge.');
    });

    await run('causal inference recovers most of a realistic 8-node, 12-edge system', async () => {
        // An 8-node electronics-enclosure thermal/vibration system: 3 independent AR(1) roots
        // (ambientTemperature, motorLoad, solarIrradiance), 5 downstream nodes, 12 true lagged
        // edges (one quadratic: componentTemperature -> thermalStress). Originally built to
        // generate real end-to-end assets for a blog post about this feature, running it for real
        // surfaced a genuine engine bug: the stage-1 skeleton screened pairs using CONTEMPORANEOUS
        // (same-timestep) partial correlation, which is a poor proxy for a lagged relationship once
        // a graph has more than a couple of variables -- confirmed empirically (a true edge showed
        // near-zero contemporaneous partial correlation while an unrelated pair showed a misleading
        // one purely from shared AR-driven persistence). Fixed in causalInference.cpp by screening
        // with LAG-1 partial correlation instead (see its own comment there and
        // docs/causalInference.md). This test is the regression guard for that fix, and for two
        // remaining, *structural* (not fixable by more data or a bigger coefficient) collinearity
        // limitations found during the same investigation, both intentionally left unasserted
        // below: ambientTemperature and motorLoad each have a direct edge to a target that is ALSO
        // reachable through a near-single-parent mediator (componentTemperature's chain into
        // thermalStress; motorLoad's own near-deterministic proxy vibrationAmplitude into
        // fatigueAccumulation) -- ridge consistently attributes the shared effect to the mediator,
        // at any sample size. 10 of the 12 true edges are recovered; this test asserts exactly
        // those 10, plus that no *other* spurious candidate reaches a high (>= 0.5) score. Also
        // doubles as the regression guard for the continuous-time rate transform (every fitted
        // coefficient here is unit-compatible with Konjugate's dx/dt, not a raw discrete-step
        // multiplier -- see docs/proposals/continuousTimeConversion.md) and for self-terms
        // committing correctly as addSourceTerm operations, not edges.
        // [source, target, degree, trueCoefficient] terms for exactly the 10 unique edges this
        // construction recovers (11 entries: componentTemperature -> thermalStress carries both a
        // degree-1 and a degree-2 term on the same edge) -- see the comment above for the 2
        // structurally-unrecoverable exceptions.
        const expectedEdges = [
            ['ambientTemperature', 'enclosureTemperature', 1, 2.0],
            ['solarIrradiance', 'enclosureTemperature', 1, 1.5],
            ['motorLoad', 'vibrationAmplitude', 1, 3.0],
            ['ambientTemperature', 'componentTemperature', 1, 1.0],
            ['motorLoad', 'componentTemperature', 1, 1.0],
            ['enclosureTemperature', 'componentTemperature', 1, 2.5],
            ['componentTemperature', 'thermalStress', 1, 3.5],
            ['componentTemperature', 'thermalStress', 2, 0.8],
            ['vibrationAmplitude', 'fatigueAccumulation', 1, 1.2],
            ['componentTemperature', 'fatigueAccumulation', 1, 1.0],
            ['thermalStress', 'fatigueAccumulation', 1, 1.5]
        ];

        await evaluate(window, `document.querySelector('#causalInferenceButton').click()`);
        await waitFor(window, `!document.querySelector('#causalInference').classList.contains('hidden')`, 'The causal inference card did not open.');
        await evaluate(window, `window.__debugCausalInference.loadCsv(${JSON.stringify(buildThermalSystemCsv())})`);
        await waitFor(window, `!document.querySelector('#causalInferenceMappingSection').hidden`, 'The column mapping section did not appear.');
        assert.equal(await evaluate(window, `document.querySelectorAll('#causalInferenceMappingRows .causalInferenceMappingRow').length`), 8,
            'Expected one mapping row per CSV column.');

        await evaluate(window, `(() => {
            const select = document.querySelector('#causalInferenceDegreeMode');
            select.value = 'auto';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            document.querySelector('#causalInferenceDegreeValue').value = '2';
        })()`);
        await evaluate(window, `document.querySelector('#runCausalInference').click()`);
        await waitFor(window, `!document.querySelector('#causalInferenceCandidatesSection').hidden`, 'The candidate list did not appear.', 20000);

        const candidates = await evaluate(window, `window.__debugCausalInference.candidates()`);
        for (const [source, target, degree, trueCoefficient] of expectedEdges) {
            const candidate = candidates.find((c) => c.sourceColumn === source && c.targetColumn === target);
            assert.ok(candidate, `Expected a ${source} -> ${target} candidate.`);
            const term = candidate.terms.find((t) => t.degree === degree);
            assert.ok(term, `Expected a degree-${degree} term on ${source} -> ${target}, got: ${JSON.stringify(candidate.terms)}`);
            const relativeError = Math.abs((term.coefficient - trueCoefficient) / trueCoefficient);
            assert.ok(relativeError < 0.25,
                `${source} -> ${target} degree ${degree}: expected ~${trueCoefficient}, got ${term.coefficient} (${(relativeError * 100).toFixed(1)}% off).`);
        }
        const expectedPairs = new Set(expectedEdges.map(([s, t]) => `${s}->${t}`));
        const otherCandidates = candidates.filter((c) => !expectedPairs.has(`${c.sourceColumn}->${c.targetColumn}`));
        for (const candidate of otherCandidates) {
            assert.ok(candidate.score < 0.5,
                `Unexpected candidate ${candidate.sourceColumn} -> ${candidate.targetColumn} has a high score (${candidate.score}), not a low-confidence residual.`);
        }

        // Every fitted coefficient here (and every target's own self-lag, otherwise discarded) is
        // a continuous-time rate, not a raw discrete-step multiplier -- see
        // docs/proposals/continuousTimeConversion.md. This CSV's own time column is 0,1,2,...
        // (timeStep == 1), so the exact-Euler-match transform (rate = coefficient/timeStep) leaves
        // cross-term coefficients numerically unchanged, which is why the direct trueCoefficient
        // comparison above still holds; what's new here is provenance and the self-terms.
        for (const candidate of candidates) {
            assert.notEqual(candidate.provenance, 'lagged',
                `A lagged candidate should be tagged continuousLagged, never the pre-consolidation discrete "lagged" `
                + `tag (${candidate.sourceColumn} -> ${candidate.targetColumn} was tagged ${candidate.provenance}).`);
        }
        const selfTerms = await evaluate(window, `window.__debugCausalInference.selfTerms()`);
        const laggedTargets = new Set(candidates.filter((c) => c.provenance === 'continuousLagged').map((c) => c.targetColumn));
        const selfTermTargets = new Set(selfTerms.map((t) => t.targetColumn));
        for (const target of laggedTargets) {
            assert.ok(selfTermTargets.has(target), `Expected a self-term for ${target}, which has an accepted continuous-time edge.`);
        }
        for (const term of selfTerms) {
            assert.ok(Number.isFinite(term.rate), `Self-term rate for ${term.targetColumn} should be a finite number, got ${term.rate}.`);
        }

        // Deselect any low-confidence residual candidate before committing, exactly as a real
        // reviewer would -- this also exercises the checkbox accept/reject path, which neither
        // existing causal-inference test does (both accept every candidate by default).
        for (const candidate of otherCandidates) {
            await evaluate(window, `(() => {
                const row = [...document.querySelectorAll('#causalInferenceCandidateRows .causalInferenceCandidateRow')]
                    .find((r) => r.querySelector('.causalInferenceCandidateMain').textContent.includes(${JSON.stringify(`${candidate.sourceColumn} → ${candidate.targetColumn}`)}));
                row.querySelector('input[type="checkbox"]').click();
            })()`);
        }

        const nodesBefore = await evaluate(window, `Number(document.querySelectorAll('.modelStatus span')[0].textContent.match(/\\d+/)[0])`);
        const edgesBefore = await evaluate(window, `Number(document.querySelectorAll('.modelStatus span')[1].textContent.match(/\\d+/)[0])`);
        const consoleMessages = await captureConsoleMessages(window, async () => {
            await evaluate(window, `document.querySelector('#commitCausalInference').click()`);
            await waitFor(window, `document.querySelector('#causalInference').classList.contains('hidden')`, 'The causal inference card did not close after commit.', 15000);
        });
        assert.deepEqual(consoleMessages.filter((message) => /error|uncaught|exception/i.test(message)), []);
        assert.equal(await evaluate(window, `Number(document.querySelectorAll('.modelStatus span')[0].textContent.match(/\\d+/)[0])`), nodesBefore + 8,
            'Committing should have created one new node per CSV column (8).');
        assert.equal(await evaluate(window, `Number(document.querySelectorAll('.modelStatus span')[1].textContent.match(/\\d+/)[0])`), edgesBefore + expectedPairs.size,
            `Committing should have created exactly the ${expectedPairs.size} accepted edges (componentTemperature -> thermalStress is one edge with two terms).`);

        // Candidates have no dedicated node/edge-style count to check self-terms landed correctly
        // against (a source term is local to a node, not a separate relationship on the canvas) --
        // read the committed document directly. Every self-term target should have exactly one
        // sourceTerm whose expression references that node's own state symbol (not a
        // source/target-prefixed edge symbol).
        const committedDocument = await evaluate(window, `window.__debugCausalInference.document()`);
        for (const target of laggedTargets) {
            const node = committedDocument.nodes.find((candidateNode) => candidateNode.name === target);
            assert.ok(node, `Expected a committed node named ${target}.`);
            assert.equal(node.sourceTerms.length, 1, `Expected exactly one source term on ${target}, got ${node.sourceTerms.length}.`);
            const symbol = node.states[0].symbol;
            assert.ok(node.sourceTerms[0].expression.includes(symbol),
                `${target}'s source term should reference its own state symbol "${symbol}", got: ${node.sourceTerms[0].expression}`);
        }

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `Number(document.querySelectorAll('.modelStatus span')[0].textContent.match(/\\d+/)[0])`), nodesBefore,
            'Undo should remove all 8 created nodes, and with them every source term that lived on them.');
        assert.equal(await evaluate(window, `Number(document.querySelectorAll('.modelStatus span')[1].textContent.match(/\\d+/)[0])`), edgesBefore,
            'Undo should remove all created edges.');
    });

    await run('digital-twin tuning fits source-term and edge parameters together from CSV and applies them atomically', async () => {
        await freshExample();
        // Add an independently-owned source-term parameter to Enclosed air. Its constant
        // derivative contribution and the edge's transfer coefficient affect the measured
        // target trajectory differently, so the optimizer can identify both in one fit.
        await waitFor(window, `Boolean([...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Enclosed air')))`,
            'The "Enclosed air" label did not settle back into the DOM after the previous test\'s undo.');
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Enclosed air')).click()`);
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'Enclosed air node editor did not open.');
        await writeOwnPart(window, 'temperature', '0');
        await addOwnParameter(window, 'temperature', { name: 'Source bias', symbol: 'sourceBias', value: '0.5' });
        await writeOwnPart(window, 'temperature', '\\mathrm{sourceBias}');
        await waitFor(window, `${ownPartDiagnostics('temperature')}.classList.contains('valid')`, 'The source-bias equation did not become valid.');
        await evaluate(window, `document.querySelector('#nodeEditor [data-editor-tab="parameters"]').click()`);
        await evaluate(window, `(() => {
            const row = ${ownParameterRow('temperature')};
            const checkbox = row.querySelector('[data-field="tunable"]');
            checkbox.checked = true;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await evaluate(window, `(() => {
            const row = ${ownParameterRow('temperature')};
            row.querySelector('[data-tuning-field="minimum"]').value = '-5';
            row.querySelector('[data-tuning-field="maximum"]').value = '5';
            row.querySelector('[data-tuning-field="minimum"]').dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);

        // Reuses the same edge the "live parameters" test above already opens -- Thermal
        // Management's Battery module -> Enclosed air relationship, whose one parameter is
        // "heatTransferCoefficient".
        await waitFor(window, `Boolean([...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')))`,
            'The "Battery module" label did not settle back into the DOM after the previous test\'s undo.');
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        await waitFor(window, `Boolean([...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')))`,
            'The "Battery module" relationship bundle label did not appear.');
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`, 'Edge editor did not open.');
        await waitFor(window, `document.querySelector('#edgeEditorParameters .editorParameterRow') !== null`, 'No parameter row rendered for this edge.');

        const beforeValue = await evaluate(window, `Number(document.querySelector('#edgeEditorParameters .editorParameterRow:first-child [data-field="value"]').value)`);
        assert.equal(await evaluate(window, `document.querySelector('#edgeEditorParameters .editorParameterRow:first-child .parameterTuningFields').hidden`), true);

        await evaluate(window, `(() => {
            const row = document.querySelector('#edgeEditorParameters .editorParameterRow:first-child');
            const checkbox = row.querySelector('[data-field="tunable"]');
            checkbox.checked = true;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#edgeEditorParameters .editorParameterRow:first-child .parameterTuningFields').hidden`), false,
            'Checking "Tunable" should reveal the fitting-bounds fields.');
        await evaluate(window, `(() => {
            const row = document.querySelector('#edgeEditorParameters .editorParameterRow:first-child');
            row.querySelector('[data-tuning-field="minimum"]').value = '0';
            row.querySelector('[data-tuning-field="maximum"]').value = '50';
            row.querySelector('[data-tuning-field="minimum"]').dispatchEvent(new Event('change', { bubbles: true }));
            row.querySelector('[data-tuning-field="maximum"]').dispatchEvent(new Event('change', { bubbles: true }));
        })()`);

        const document_ = await evaluate(window, `window.__debugCausalInference.document()`);
        const tunableEdge = document_.edges.find((edge) => (edge.parameters ?? []).some((parameter) => parameter.tuning));
        assert.ok(tunableEdge, 'Expected an edge with a tunable parameter in the committed document.');
        const tunableParameter = tunableEdge.parameters.find((parameter) => parameter.tuning);
        assert.deepEqual(tunableParameter.tuning, { minimum: 0, maximum: 50 });
        const tunableSourceTerm = document_.nodes.flatMap((node) => (node.sourceTerms ?? []).map((term) => ({ node, term })))
            .find(({ term }) => (term.parameters ?? []).some((parameter) => parameter.tuning));
        assert.ok(tunableSourceTerm, 'Expected a source term with a tunable parameter in the committed document.');
        const tunableSourceParameter = tunableSourceTerm.term.parameters.find((parameter) => parameter.tuning);
        assert.equal(tunableSourceParameter.symbol, 'sourceBias');
        assert.deepEqual(tunableSourceParameter.tuning, { minimum: -5, maximum: 5 });
        const sourceBeforeValue = tunableSourceParameter.value;
        const targetStateId = tunableEdge.equationModel?.output?.stateId ?? tunableEdge.target.stateId;
        const targetNode = document_.nodes.find((node) => (node.states ?? []).some((state) => state.id === targetStateId));
        const targetState = targetNode.states.find((state) => state.id === targetStateId);

        // A small, arbitrary measured series -- numerical recovery against real physics is
        // already proven at the C++ level (engine/tests/parameterFittingTests.cpp); this exercises
        // the UI's full mapping/run/review/apply path against the real engine end to end.
        const csvLines = [`time,${targetState.symbol}`];
        for (let row = 0; row < 10; row += 1) csvLines.push(`${row},${(targetState.initialValue ?? 290) + row}`);

        await evaluate(window, `document.querySelector('#parameterTuningButton').click()`);
        await waitFor(window, `!document.querySelector('#parameterTuning').classList.contains('hidden')`, 'Tuning panel did not open.');
        // The backend dropdown is populated from the real engine binary's own `capabilities`
        // report (window.engine.capabilities()), not a hardcoded list -- assert it actually
        // matches what that binary reports, not just that something got populated.
        await waitFor(window, `document.querySelector('#parameterTuningBackend').options.length > 0`,
            'The optimizer backend dropdown was not populated from the engine\'s capabilities report.');
        const reportedBackendIds = (await evaluate(window, `window.engine.capabilities()`)).capabilities.optimizerBackendIds;
        const renderedBackendIds = await evaluate(window, `[...document.querySelectorAll('#parameterTuningBackend option')].map((option) => option.value)`);
        assert.deepEqual(renderedBackendIds, reportedBackendIds,
            'The backend dropdown should list exactly the ids the engine binary itself reports supporting.');
        await evaluate(window, `window.__debugParameterTuning.loadCsv(${JSON.stringify(csvLines.join('\n'))})`);
        await waitFor(window, `!document.querySelector('#parameterTuningParametersSection').hidden`, 'Tunable parameters section did not appear.', 5000);
        assert.equal(await evaluate(window, `document.querySelectorAll('#parameterTuningParameterRows input[data-field="tune"]:checked').length`), 2);

        // A long fit can be stopped part way and still be used: the slow global search below would run for ages on its own.
        await evaluate(window, `(() => { const backend = document.querySelector('#parameterTuningBackend'); backend.value = 'nlopt-isres'; backend.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#parameterTuningMaxSimulations').value = '100000'; })()`);
        await evaluate(window, `document.querySelector('#runParameterTuning').click()`);
        await waitFor(window, `window.__debugParameterTuning.simulations() >= 8`, 'The fit reported no progress.', 60000);
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningStats').hidden`), false, 'The numbers beside the plot should be showing.');
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningEstimate').textContent`), /^One simulation takes .+ up to 100000 simulations/);
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningChip').hidden`), false, 'The toolbar chip should show while a fit runs.');
        assert.equal(await evaluate(window, `document.querySelector('#cancelParameterTuning').textContent`), 'Discard');
        await waitFor(window, `document.querySelector('#parameterTuningConvergencePlot').data?.length === 2`, 'The convergence plot was not drawn.', 15000);
        await evaluate(window, `document.querySelector('#stopParameterTuning').click()`);
        await waitFor(window, `!document.querySelector('#parameterTuningReviewSection').hidden`, 'Stopping the fit did not lead to the review.', 60000);
        const stoppedReport = await evaluate(window, `window.__debugParameterTuning.report()`);
        assert.equal(stoppedReport.stopped, true);
        assert.equal(stoppedReport.terminationReason, 'stoppedByUser');
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningProgress').textContent`), /^Stopped: using the best found/);
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningChip').hidden`), true, 'The chip should go when the fit has ended.');
        assert.equal(await evaluate(window, `document.querySelector('#cancelParameterTuning').textContent`), 'Cancel');
        await evaluate(window, `(() => { const backend = document.querySelector('#parameterTuningBackend'); backend.value = 'nlopt-bobyqa'; document.querySelector('#parameterTuningMaxSimulations').value = '200'; })()`);
        await waitFor(window, `!document.querySelector('#runParameterTuning').disabled`, 'The fit could not be run again.', 30000);

        await evaluate(window, `document.querySelector('#runParameterTuning').click()`);
        await waitFor(window, `!document.querySelector('#parameterTuningReviewSection').hidden && window.__debugParameterTuning.report()?.stopped === false`, 'Review section did not appear after running the fit.', 60000);
        const report = await evaluate(window, `window.__debugParameterTuning.report()`);
        assert.equal(report.finalParameters.length, 2);
        assert.deepEqual(new Set(report.finalParameters.map((entry) => entry.parameterId)), new Set([tunableParameter.id, tunableSourceParameter.id]));
        assert.equal(await evaluate(window, `document.querySelectorAll('#parameterTuningReviewRows label').length`), 2);

        // renderParameterTuningComparison() runs one more simulation with the fitted values
        // applied and plots it against the measured CSV; it catches its own errors into a status
        // message rather than throwing, so this checks the plot actually rendered rather than
        // just that nothing threw.
        await waitFor(window,
            `!document.querySelector('#parameterTuningComparisonStatus').textContent.includes('Running the fitted model')`,
            'The measured-vs-simulated comparison never finished.', 30000);
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningComparisonStatus').textContent`), '',
            'Expected the measured-vs-simulated comparison to succeed with no error status.');
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningComparisonPlot').hidden`), false);
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningComparisonPlot').data?.length`), 3,
            'Expected one measured, one simulated and one residual trace for the single mapped signal.');

        await evaluate(window, `document.querySelector('#commitParameterTuning').click()`);
        await waitFor(window, `document.querySelector('#parameterTuning').classList.contains('hidden') || document.querySelector('#parameterTuningReviewStatus').textContent.length > 0`, 'Tuning apply did not complete.', 5000);
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningReviewStatus').textContent`), '', 'Applying both fitted parameter types should not report an error.');
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuning').classList.contains('hidden')`), true, 'Tuning panel did not close after apply.');
        const after = await evaluate(window, `window.__debugCausalInference.document()`);
        const appliedParameter = after.edges.flatMap((edge) => edge.parameters ?? []).find((parameter) => parameter.id === tunableParameter.id);
        const appliedSourceParameter = after.nodes.flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => term.parameters ?? []))
            .find((parameter) => parameter.id === tunableSourceParameter.id);
        assert.equal(appliedParameter.value, report.finalParameters.find((entry) => entry.parameterId === tunableParameter.id).value,
            'The committed edge should carry its fitted value once applied.');
        assert.equal(appliedSourceParameter.value, report.finalParameters.find((entry) => entry.parameterId === tunableSourceParameter.id).value,
            'The committed source term should carry its fitted value once applied.');

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        const afterUndo = await evaluate(window, `window.__debugCausalInference.document()`);
        const undoneParameter = afterUndo.edges.flatMap((edge) => edge.parameters ?? []).find((parameter) => parameter.id === tunableParameter.id);
        const undoneSourceParameter = afterUndo.nodes.flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => term.parameters ?? []))
            .find((parameter) => parameter.id === tunableSourceParameter.id);
        assert.equal(undoneParameter.value, beforeValue, 'Undo should restore the pre-fit parameter value in one step.');
        assert.equal(undoneSourceParameter.value, sourceBeforeValue, 'The same undo should restore the source-term parameter value.');
        await evaluate(window, `document.querySelector('#redoButton').click()`);

        // The other goal: an objective written as an expression, tuned with the same card, progress and review.
        await evaluate(window, `document.querySelector('#parameterTuningButton').click()`);
        await waitFor(window, `!document.querySelector('#parameterTuning').classList.contains('hidden')`, 'Tuning panel did not reopen.');
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningObjectiveSection').hidden`), true, 'The objective editor belongs to the objective goal only.');
        // Measured data chosen first is still there after the goal changes, and the other way round.
        await evaluate(window, `window.__debugParameterTuning.loadCsv(${JSON.stringify(csvLines.join('\n'))})`);
        await waitFor(window, `!document.querySelector('#parameterTuningMappingSection').hidden`, 'The measured data did not map to a state.', 5000);
        await evaluate(window, `document.querySelector('#parameterTuningGoalObjective').click()`);
        await waitFor(window, `!document.querySelector('#parameterTuningMeasuredPicker').hidden`, 'The measured data chosen before the goal changed was dropped.', 5000);
        assert.ok((await evaluate(window, `window.__debugParameterTuning.vocabulary().measured.length`)) >= 1, 'Its columns should be names the objective can use.');
        await evaluate(window, `document.querySelector('#parameterTuningGoalData').click()`);
        await waitFor(window, `!document.querySelector('#parameterTuningMappingSection').hidden`, 'The measured data was dropped on the way back to fitting it.', 5000);
        // Matching the data, written as an objective to change: the mean squared difference between the state and its column.
        await waitFor(window, `!document.querySelector('#parameterTuningEditAsObjective').hidden`, 'Matching measured data was not offered as an objective.', 5000);
        await evaluate(window, `document.querySelector('#parameterTuningEditAsObjective').click()`);
        await waitFor(window, `document.querySelector('#parameterTuningGoalObjective').getAttribute('aria-pressed') === 'true' && document.querySelector('#parameterTuningObjectiveDiagnostics').textContent.startsWith('Valid objective: ')`, 'The fit was not written as an objective.', 10000);
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningObjectiveDiagnostics').textContent`), new RegExp(`^Valid objective: the average of the squared difference between .*${targetState.name} and measured ${targetState.symbol} over the run$`));
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningDirection').value`), 'minimise');
        await evaluate(window, `document.querySelector('#cancelParameterTuning').click()`);
        await evaluate(window, `document.querySelector('#parameterTuningButton').click()`);
        await waitFor(window, `!document.querySelector('#parameterTuning').classList.contains('hidden')`, 'Tuning panel did not reopen.');
        await evaluate(window, `document.querySelector('#parameterTuningGoalObjective').click()`);
        await waitFor(window, `!document.querySelector('#parameterTuningObjectiveSection').hidden && !document.querySelector('#runParameterTuning').hidden`, 'Choosing the objective goal did not show its editor.', 5000);
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningGoalObjective').getAttribute('aria-pressed')`), 'true');
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningMappingSection').hidden`), true, 'There is no column mapping without measured data.');
        assert.equal(await evaluate(window, `document.querySelectorAll('#parameterTuningParameterRows input[data-field="tune"]:checked').length`), 2);
        // The card edits what is tunable itself: untick both and there is nothing to run; tick one back, with its bounds, and there is.
        const tuneBox = (index) => `document.querySelectorAll('#parameterTuningParameterRows input[data-field="tune"]:checked')[${index}]`;
        await evaluate(window, `(() => { const box = ${tuneBox(0)}; box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await evaluate(window, `(() => { const box = ${tuneBox(0)}; box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(window, `document.querySelector('#runParameterTuning').disabled`), true, 'With nothing ticked there is nothing to run.');
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningTuneHint').textContent`), /Tick Tune/);
        assert.equal((await evaluate(window, `window.__debugCausalInference.document()`)).edges.flatMap((edge) => edge.parameters ?? []).some((parameter) => parameter.tuning), false, 'Unticking edits the model\'s own tuning field.');
        for (let ticked = 0; ticked < 2; ticked += 1) {
            await evaluate(window, `(() => { const box = [...document.querySelectorAll('#parameterTuningParameterRows input[data-field="tune"]')].find((candidate) => !candidate.checked && !candidate.disabled); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        }
        assert.equal(await evaluate(window, `document.querySelectorAll('#parameterTuningParameterRows input[data-field="tune"]:checked').length`), 2);
        // Something to tune is not enough for an objective: Run waits for one that reads.
        assert.equal(await evaluate(window, `document.querySelector('#runParameterTuning').disabled`), true);
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningTuneHint').textContent`), /Write an objective/);
        // The objective is written in the equation editor an edge uses: a summary button opens an empty summary, a state button fills it.
        const stateName = await evaluate(window, `window.__debugParameterTuning.vocabulary().states.find((state) => state.label.includes(${JSON.stringify(targetState.name)})).name`);
        const setLatex = (selector, latex) => evaluate(window, `(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(latex)}; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await evaluate(window, `[...document.querySelectorAll('#parameterTuningSummaryButtons button')].find((button) => button.textContent === 'final').click()`);
        await evaluate(window, `[...document.querySelectorAll('#parameterTuningStateChips button')].find((button) => button.textContent.includes(${JSON.stringify(targetState.name)})).click()`);
        const objectiveLatex = await evaluate(window, `document.querySelector('#parameterTuningMathField').value`);
        assert.ok(objectiveLatex.includes('lim') && objectiveLatex.includes(stateName), `The buttons should have written a final value of the state: ${objectiveLatex}`);
        await waitFor(window, `document.querySelector('#parameterTuningObjectiveDiagnostics').textContent.startsWith('Valid objective: ')`, 'A final value of a state should read as a valid objective.', 10000);
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningObjectiveDiagnostics').textContent`), new RegExp(`^Valid objective: .*${targetState.name}.* at the end of the run$`), 'The line says what the objective computes, with the state called as its chip is.');

        // A name that stands for something that changes over the run is refused as it is written, with the engine's reason, and Run stays
        // off until the objective reads: it cannot be started on something the engine would refuse.
        await setLatex('#parameterTuningMathField', `\\mathrm{${stateName}}`);
        await waitFor(window, `document.querySelector('#parameterTuningObjectiveDiagnostics').textContent.includes('needs a summary')`, 'A bare state should be explained as it is written.', 15000);
        assert.equal(await evaluate(window, `document.querySelector('#runParameterTuning').disabled`), true, 'Run must stay off for an objective the engine refuses.');
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningTuneHint').textContent`), /cannot be run yet/);
        // The same for a name the model does not have, which used to leave Run on and wait for a fit that never started.
        await setLatex('#parameterTuningMathField', `\\mathrm{noSuchName}`);
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningObjectiveDiagnostics').textContent`), /Unknown symbol/);
        assert.equal(await evaluate(window, `document.querySelector('#runParameterTuning').disabled`), true, 'Run must stay off for a name the model does not have.');
        await evaluate(window, `document.querySelector('#parameterTuningMathField').value = ''; document.querySelector('#parameterTuningMathField').dispatchEvent(new Event('input', { bubbles: true }))`);
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningTuneHint').textContent`), /Write an objective/);
        await setLatex('#parameterTuningMathField', objectiveLatex);
        assert.equal(await evaluate(window, `document.querySelector('#runParameterTuning').disabled`), false, 'A good objective turns Run back on.');
        await evaluate(window, `(() => { document.querySelector('#parameterTuningRunTime').value = '10'; document.querySelector('#parameterTuningTimeStep').value = '1'; })()`);

        // A limit is the same editor: half-filled is explained, filled in is kept to (a huge bound here, so that it holds).
        await evaluate(window, `document.querySelector('#addParameterTuningConstraint').click()`);
        await setLatex('#parameterTuningConstraintRows math-field', `\\max\\left(\\mathrm{${stateName}}\\right)`);
        await setLatex('#parameterTuningMathField', objectiveLatex);
        await evaluate(window, `document.querySelector('#runParameterTuning').click()`);
        await waitFor(window, `document.querySelector('#parameterTuningObjectiveStatus').textContent.includes('Limit 1 needs a number')`, 'A limit without a number should be explained.', 5000);
        await evaluate(window, `document.querySelector('#parameterTuningConstraintRows [data-field="limit"]').value = '1000000000'`);
        await evaluate(window, `(() => {
            document.querySelector('#parameterTuningDirection').value = 'maximise';
            document.querySelector('#parameterTuningMaxSimulations').value = '30';
            document.querySelector('#runParameterTuning').click();
        })()`);
        await waitFor(window, `!document.querySelector('#parameterTuningReviewSection').hidden`, 'The objective tuning did not reach its review.', 60000);
        const objectiveReport = await evaluate(window, `window.__debugParameterTuning.report()`);
        assert.equal(objectiveReport.finalParameters.length, 2);
        assert.ok(Number.isFinite(objectiveReport.finalLoss), 'The objective ends on a number.');
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningProgress').textContent`), /objective/);
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningComparisonStatus').textContent`), /^Maximised objective: .*All limits hold\./);
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningStatImprovement').previousElementSibling.textContent`), 'Higher by');
        await waitFor(window, `document.querySelector('#parameterTuningComparisonPlot').data?.length === 2`, 'The before-and-after plot was not drawn for the state the objective names.', 60000);
        assert.deepEqual(await evaluate(window, `document.querySelector('#parameterTuningComparisonPlot').data.map((trace) => trace.name)`), ['Before tuning', 'After tuning']);
        await evaluate(window, `document.querySelector('#cancelParameterTuning').click()`);

        // The setup of that run was kept with the project: opening the card again finds the objective as it was written.
        assert.equal((await evaluate(window, `window.__debugParameterTuning.setup()`)).objective.expression, `final(${stateName})`);
        await evaluate(window, `document.querySelector('#parameterTuningButton').click()`);
        await waitFor(window, `document.querySelector('#parameterTuningMathField').value === ${JSON.stringify(objectiveLatex)}`, 'The card did not restore the last objective.', 5000);
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningDirection').value`), 'maximise');
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningMaxSimulations').value`), '30');
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningConstraintRows [data-field="limit"]').value`), '1000000000', 'The limit comes back with the objective.');
        await evaluate(window, `document.querySelector('#cancelParameterTuning').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#parameterTuningObjectiveSection').hidden`), true, 'Closing the card puts it back to the measured-data goal.');
    }, { skip: !driver.capabilities.fitProgress && 'the web engine reports a fit only when it ends, so there is no progress to wait for or stop' });

    await run('Results Analysis timeline seek only redraws the scatter trail once the run is completed, not while running or paused', async () => {
        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('#newWindowButton').click()`);
        const diagnosticWindow = await driver.waitForNewHandle(before);
        await waitFor(diagnosticWindow, `document.querySelector('.documentTitle')`, 'Diagnostic window did not finish loading.');

        await evaluate(diagnosticWindow, `document.querySelector('#exampleButton').click()`);
        await waitFor(diagnosticWindow, `document.querySelector('#examplesExplorerDialog').open`, 'Examples explorer did not open in the diagnostic window.');
        await waitFor(diagnosticWindow, `Boolean([...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.querySelector('b').textContent === 'Thermal Management'))`, 'Examples explorer did not populate in the diagnostic window.');
        await evaluate(diagnosticWindow, `[...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.querySelector('b').textContent === 'Thermal Management').click()`);
        await evaluate(diagnosticWindow, `document.querySelector('#examplesExplorerLoad').click()`);
        await waitFor(diagnosticWindow, `document.querySelectorAll('.node-label-container').length === 3`, 'Thermal example did not load in the diagnostic window.');

        // #runButton stays disabled until the C++ engine's async post-load model validation
        // finishes (renderValidationPending/-Status in renderer.mjs) -- clicking a disabled
        // button never dispatches 'click' at all, so a run started before this settles is a
        // silent no-op, not a visible failure.
        await waitFor(diagnosticWindow, `!document.querySelector('#runButton').disabled`, 'Model validation did not complete before Run could be started.', 10000);

        // A real ~10 wall-clock-second run under realTime pacing, matching the reported repro
        // exactly, rather than the near-instantaneous runs the rest of this suite uses.
        await openRunDialog(diagnosticWindow);
        await evaluate(diagnosticWindow, `(() => { document.querySelector('#runTargetTime').value = '10'; document.querySelector('#runOnlineMode').checked = true; document.querySelector('#runOnlineMode').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#runPacingMode').value = 'realTime'; document.querySelector('#startRun').click(); })()`);
        await waitFor(diagnosticWindow, `document.querySelector('.resultMode small').textContent === 'Running · model locked'`, 'C++ simulation did not enter its running state in the diagnostic window.', 10000);

        // Pause rather than staying live: while running, the Analysis window's own timeline
        // value keeps auto-advancing on its own (a separate visualizerHostTimelineChange
        // broadcast tracking the live playhead, src/main.mjs), which would make a seek attempt's
        // effect indistinguishable from just the natural clock ticking during this test's own
        // waits. Paused, the timeline is static, so any redraw can only be the seek itself.
        await evaluate(diagnosticWindow, `document.querySelector('#simulationPauseResume').click()`);
        await waitFor(diagnosticWindow, `document.querySelector('.resultMode small').textContent === 'Paused · model locked'`, 'Simulation did not pause.', 5000);

        await waitFor(diagnosticWindow, `Boolean(document.querySelector('.addonTool[data-addon-id="konjugate.resultPlotViewer"][data-command-id="openAnalysis"]:not([hidden])'))`, 'Analysis toolstrip command did not appear during a live run.');
        await evaluate(diagnosticWindow, `document.querySelector('.addonTool[data-addon-id="konjugate.resultPlotViewer"][data-command-id="openAnalysis"]').click()`);
        // By its title: the example's own guide opens in a window of its own too, and may appear first.
        const analysisWindow = await driver.waitForNewHandle([...before, diagnosticWindow], { titleIncludes: 'Results Analysis' });
        await waitFor(analysisWindow, `document.querySelectorAll('.signalOption').length > 0`, 'Results Analysis did not load signals during a live run.', 5000);
        await evaluate(analysisWindow, `(() => {
            const options = (id) => [...document.querySelector(id).options].map((option) => option.value);
            const xOptions = options('#scatterX');
            const yOptions = options('#scatterY').filter((value) => value !== xOptions[0]);
            document.querySelector('#scatterX').value = xOptions[0];
            document.querySelector('#scatterY').value = yOptions[0] ?? xOptions[0];
            document.querySelector('#chartMode').value = 'scatter';
            document.querySelector('#chartMode').dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitFor(analysisWindow, `document.querySelector('#analysisPlot').data[0]?.type === 'scatter'`, 'Scatter mode did not render during a live run.', 3000);

        // A genuine mouse drag on the native range input, not a scripted .value= + dispatchEvent
        // -- Chromium moves a native <input type=range>'s own displayed value on a real click
        // regardless of any JS listener's outcome, so this is the one gesture that can actually
        // distinguish "the seek request was accepted" from "the slider just looks like it moved."
        const dragTimeline = async (fraction) => {
            const rect = await evaluate(analysisWindow, `(() => { const r = document.querySelector('#timeline').getBoundingClientRect(); return { left: r.left, top: r.top + r.height / 2, width: r.width }; })()`);
            const start = { x: Math.round(rect.left + 4), y: Math.round(rect.top) };
            const end = { x: Math.round(rect.left + rect.width * fraction), y: Math.round(rect.top) };
            await analysisWindow.mouseMove(start);
            await analysisWindow.mouseDown(start, { button: 'left', clickCount: 1 });
            await analysisWindow.mouseMove(end);
            await analysisWindow.mouseUp(end, { button: 'left', clickCount: 1 });
            await new Promise((resolve) => setTimeout(resolve, 400));
        };

        // While paused, src/main.mjs's visualizerSeek handler silently no-ops
        // (['running','paused'].includes(lifecycle)) -- the native input still visibly jumps to
        // the dragged position, but the chart must NOT redraw, since the session's real time
        // never moved. This is the reported bug's actual mechanism: the slider looks connected:
        // dragging it, the chart doesn't change.
        const pausedTraceLengthBefore = await evaluate(analysisWindow, `document.querySelector('#analysisPlot').data[0].x.length`);
        await dragTimeline(0.5);
        const pausedTraceLengthAfter = await evaluate(analysisWindow, `document.querySelector('#analysisPlot').data[0].x.length`);
        assert.equal(pausedTraceLengthAfter, pausedTraceLengthBefore,
            'Expected the scatter trail to stay unchanged while paused/running, since src/main.mjs visualizerSeek blocks seeking then -- if this now redraws, the seek gate has changed and this assertion needs updating.');

        await evaluate(diagnosticWindow, `document.querySelector('#simulationPauseResume').click()`);
        // Up to 9 more seconds of real-time run after the pause, with room to spare on a busy machine.
        await waitFor(diagnosticWindow, `document.querySelector('.resultMode small').textContent === 'Model locked'`, 'Live simulation did not complete in the diagnostic window.', 30000);
        await waitFor(analysisWindow, `document.querySelector('.readOnlyBadge').textContent === 'Completed'`, 'Analysis window did not observe run completion.', 5000);

        // Compare two deliberately-targeted positions rather than "before vs. after one drag":
        // where context.time happens to sit right as the run completes is itself a race (the
        // Analysis window's own catch-up broadcast vs. the main window's completion badge), so
        // an assertion anchored to an unknown starting point would be flaky. Two known targets
        // isn't.
        await dragTimeline(0.02);
        const earlyTraceLength = await evaluate(analysisWindow, `document.querySelector('#analysisPlot').data[0].x.length`);
        await dragTimeline(0.95);
        const lateTraceLength = await evaluate(analysisWindow, `document.querySelector('#analysisPlot').data[0].x.length`);
        assert.ok(lateTraceLength > earlyTraceLength,
            `Expected the revealed scatter trail to grow as the Analysis timeline is dragged forward once the run has completed (near t=0: ${earlyTraceLength} points, near the end: ${lateTraceLength} points).`);

        await closeWhenValidated(diagnosticWindow);
        for (let attempt = 0; attempt < 100 && !(await diagnosticWindow.isDestroyed()); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }, { skip: (!driver.capabilities.multiWindow && 'duplicates coverage #5/#15 already provide on the web driver; the addon-specific redraw-gating behavior itself has no web-edition equivalent') || addonMissing('konjugate.resultPlotViewer', 'konjugate-resultplotviewer') });

    await run('a node\'s own part reads its own parameters, added on its Parameters tab and picked from its references', async () => {
        await freshExample();
        await waitFor(window, `Boolean([...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Enclosed air')))`, 'The "Enclosed air" label was not in the DOM.');
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Enclosed air')).click()`);
        await writeOwnPart(window, 'temperature', '0');
        await addOwnParameter(window, 'temperature', { name: 'Source gain', symbol: 'sourceGain', value: '2' });
        await evaluate(window, `document.querySelector('#nodeEditor [data-editor-tab="equations"]').click()`);
        assert.equal(await evaluate(window, `${ownPartReferences('temperature')}.some((button) => button.textContent === 'sourceGain')`), true, 'The own part does not offer its parameter.');
        await writeOwnPart(window, 'temperature', '2\\cdot\\mathrm{sourceGain}');
        await waitFor(window, `${ownPartDiagnostics('temperature')}.classList.contains('valid')`, 'The own parameter was not accepted by the equation.');
    });

    await run('numerical stability findings surface as a bottom-bar indicator, a findings panel, and a per-node badge', async () => {
        // A fresh window, not the shared one: this test authors its own tiny, deliberately
        // unstable model from scratch, which would otherwise disturb every later test that
        // assumes the shared document's existing content (see "Results Analysis timeline seek"
        // above for the same isolation reasoning).
        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('#newWindowButton').click()`);
        const diagnosticWindow = await driver.waitForNewHandle(before);
        await waitFor(diagnosticWindow, `document.querySelector('.documentTitle')`, 'Diagnostic window did not finish loading.');

        // One node, one state ("level"), one self-referencing growth term: d(level)/dt = level.
        // Explicit Euler's own stability condition is |1 + stepSize·λ| <= 1 -- for λ = +1 and any
        // stepSize > 0, that's |1 + stepSize| > 1 always, so this is unstable at every possible
        // timestep, not just a finely-tuned one. Unlike the engine-level fixtures
        // (tests/engine/duringRunStabilityMonitoring.mjs and friends), which deliberately sit just
        // past a specific boundary to test the boundary itself, this test only needs "definitely,
        // robustly unstable" -- so it doesn't need to match a particular rate against a particular
        // run-configuration timestep at all. The state is named "level", not the shorter "x": a
        // single-letter symbol wrapped in \mathrm{} (how insertSourceTermBinding() -- and every
        // "click a reference chip" flow in this editor -- represents ANY inserted symbol) trips a
        // MathLive/ComputeEngine parsing quirk specific to single-letter symbols ("Unknown symbol:
        // x_upright", confirmed by hand while writing this test) that a multi-character symbol
        // like "level" (or the existing suite's own "sourceBias"/"sourceGain") does not.
        await makeNode(diagnosticWindow, 'Growth', { name: 'Level', symbol: 'level', value: '1', unit: '' });
        await waitFor(diagnosticWindow, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'Growth node editor did not open after creation.');

        // Written by its reference button, as a person picks it: the growth rate is the level itself.
        await writeOwnPart(diagnosticWindow, 'level', '');
        await evaluate(diagnosticWindow, `${ownPartReferences('level')}.find((button) => button.textContent === 'level').click()`);
        await waitFor(diagnosticWindow, `document.querySelector('#nodeEditorStates .stateCard[data-symbol="level"] .ownPart').value.includes('level')`, 'The level reference was not put in the field.');
        await evaluate(diagnosticWindow, `document.querySelector('#nodeEditorStates .stateCard[data-symbol="level"] .ownPart').dispatchEvent(new Event('change', { bubbles: true }))`);
        await waitFor(diagnosticWindow, `${ownPartDiagnostics('level')}.classList.contains('valid')`, 'The self-referencing growth equation did not become valid.');
        await evaluate(diagnosticWindow, `document.querySelector('#nodeEditor [data-close-card]').click()`);

        // A known, explicit run configuration -- not load-bearing for instability itself (see
        // above), just kept deterministic rather than depending on whatever default the app
        // happens to launch new projects with.
        await waitFor(diagnosticWindow, `!document.querySelector('#runButton').disabled`, 'Model validation did not complete before the run settings could be opened.', 10000);
        await openRunDialog(diagnosticWindow);
        await waitFor(diagnosticWindow, `document.querySelector('#runLaunchDialog').open`, 'Run dialog did not open.');
        await evaluate(diagnosticWindow, `(() => {
            document.querySelector('#runGlobalTimeStep').value = '0.1';
            document.querySelector('#runOutputInterval').value = '0.1';
            document.querySelector('#saveRunConfiguration').click();
        })()`);
        await waitFor(diagnosticWindow, `!document.querySelector('#runLaunchDialog').open`, 'Run dialog did not close.');

        await waitFor(diagnosticWindow, `!document.querySelector('#runButton').disabled`, 'Model validation did not complete before Run could be started.', 10000);
        await openRunDialog(diagnosticWindow);
        await evaluate(diagnosticWindow, `(() => { document.querySelector('#runTargetTime').value = '1'; document.querySelector('#startRun').click(); })()`);
        // Not just .resultMode b's textContent: that field's own default HTML already reads
        // "Results" before any run has ever happened, so checking it alone can pass instantly
        // without actually waiting for anything -- #resultTransport itself starts `hidden` and
        // is only unhidden once a real result exists, which is the genuine signal.
        await waitFor(diagnosticWindow, `!document.querySelector('#resultTransport').hidden && document.querySelector('.resultMode b').textContent === 'Results'`,
            'Offline run did not complete.', 15000);

        // Bottom-bar indicator: present, colored, and counting at least one finding -- during-run
        // monitoring covers every node by default for an interactive run (engineAdapter.mjs's
        // startEngineRun), and the post-run fingerprint check runs automatically once the result
        // reaches "completed" (renderStabilityFindings(), src/renderer/renderer.mjs).
        assert.equal(await evaluate(diagnosticWindow, `document.querySelector('#stabilitySummaryButton').hidden`), false);
        assert.equal(await evaluate(diagnosticWindow, `document.querySelector('#stabilitySummaryButton').classList.contains('hasFindings')`), true);
        const findingsCount = Number(await evaluate(diagnosticWindow, `document.querySelector('#stabilityFindingsCount').textContent`));
        assert.ok(findingsCount > 0, `Expected at least one stability finding, got ${findingsCount}.`);

        // Per-node badge: the "Growth" node's own label should be flagged.
        assert.equal(await evaluate(diagnosticWindow, `document.querySelector('.node-label-container').classList.contains('hasStabilityFinding')`), true);

        // Findings panel: opens on click, lists real, name-resolved entries -- not raw ids or an
        // unresolved "undefined" (the exact bug this test would have caught: node display names
        // live on nodeObjects.get(id)?.userData?.definition?.title, not model.nodes[].name).
        await evaluate(diagnosticWindow, `document.querySelector('#stabilitySummaryButton').click()`);
        await waitFor(diagnosticWindow, `!document.querySelector('#stabilityFindingsCard').classList.contains('hidden')`, 'Stability findings card did not open.');
        const listText = await evaluate(diagnosticWindow, `document.querySelector('#stabilityFindingsList').textContent`);
        assert.match(listText, /Growth/, 'The findings list should show the node\'s real name.');
        assert.doesNotMatch(listText, /undefined|NaN/, 'The findings list should never leak an unresolved value.');

        // Clicking a finding selects the node and opens its editor -- the reciprocal of
        // navigateToValidationIssue's own click-an-issue-to-jump-to-its-entity behavior.
        await evaluate(diagnosticWindow, `document.querySelector('.stabilityFinding').click()`);
        await waitFor(diagnosticWindow, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'Clicking a stability finding did not open the node editor.');
        assert.equal(await evaluate(diagnosticWindow, `document.querySelector('#editNodeName').value`), 'Growth');

        // "Check convergence" -- explicit, not automatic (engineAdapter.mjs's checkSubstepConvergenceWithEngine
        // is only ever invoked by this button): re-runs the model at doubled substep counts and
        // reports whether it actually converged, not just stayed finite.
        await evaluate(diagnosticWindow, `document.querySelector('#stabilitySummaryButton').click()`);
        await waitFor(diagnosticWindow, `!document.querySelector('#stabilityFindingsCard').classList.contains('hidden')`, 'Stability findings card did not reopen.');
        await evaluate(diagnosticWindow, `document.querySelector('.stabilityCheckConvergence').click()`);
        await waitFor(diagnosticWindow, `document.querySelector('.stabilityConvergenceResult')`, 'The convergence check never produced a result.', 30000);
        const convergenceResultText = await evaluate(diagnosticWindow, `document.querySelector('.stabilityConvergenceResult').textContent`);
        assert.doesNotMatch(convergenceResultText, /undefined|NaN/, 'The convergence result should never leak an unresolved value.');

        await closeWhenValidated(diagnosticWindow);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own isolated diagnostic window; no web-edition equivalent' });

    await run('clicking an attributed instability warning jumps straight to the offending parameter', async () => {
        // Fresh window: authors its own tiny, deliberately unstable model tuned to
        // decayRate*stepSize = 2.1, the same hand-verified shape as
        // engine/tests/stabilityAnalysisTests.cpp's decayProject fixture -- unlike the "Growth"
        // (dx/dt = level) fixture used elsewhere in this suite, this one has an actual parameter to
        // attribute the instability to, so the pre-run validator's numericsPotentiallyUnstable
        // warning is guaranteed to carry a resolved attributedParameter.
        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('#newWindowButton').click()`);
        const diagnosticWindow = await driver.waitForNewHandle(before);
        await waitFor(diagnosticWindow, `document.querySelector('.documentTitle')`, 'Diagnostic window did not finish loading.');

        await makeNode(diagnosticWindow, 'Decay', { name: 'Level', symbol: 'level', value: '1', unit: '' });
        await waitFor(diagnosticWindow, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'Decay node editor did not open after creation.');

        await writeOwnPart(diagnosticWindow, 'level', '0');
        await addOwnParameter(diagnosticWindow, 'level', { name: 'Decay rate', symbol: 'decayRate', value: '21' });
        // dx/dt = -decayRate * level, matching decayProject(21, 1)'s own hand-verified math.
        await writeOwnPart(diagnosticWindow, 'level', '-\\mathrm{decayRate}\\cdot\\mathrm{level}');
        await waitFor(diagnosticWindow, `${ownPartDiagnostics('level')}.classList.contains('valid')`, 'The decay equation did not become valid.');
        await evaluate(diagnosticWindow, `document.querySelector('#nodeEditor [data-close-card]').click()`);

        await settle(diagnosticWindow, 'validation');
        await waitFor(diagnosticWindow, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && !document.querySelector('#runButton').disabled`, 'Model validation did not settle before the run settings could be opened.', 10000);
        await openRunDialog(diagnosticWindow);
        await waitFor(diagnosticWindow, `document.querySelector('#runLaunchDialog').open`, 'Run dialog did not open.');
        await evaluate(diagnosticWindow, `(() => {
            document.querySelector('#runGlobalTimeStep').value = '0.1';
            document.querySelector('#runOutputInterval').value = '0.1';
            document.querySelector('#saveRunConfiguration').click();
        })()`);
        await waitFor(diagnosticWindow, `!document.querySelector('#runLaunchDialog').open`, 'Run dialog did not close.');

        await settle(diagnosticWindow, 'validation');
        await waitFor(diagnosticWindow, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`, 'Model validation did not settle.', 10000);
        await evaluate(diagnosticWindow, `document.querySelector('#validationSummary').click()`);
        await waitFor(diagnosticWindow, `!document.querySelector('#validationPanel').hidden`, 'Validation panel did not open.');
        await waitFor(diagnosticWindow, `document.querySelector('#validationIssues').textContent.includes('Decay rate')`,
            'The unstable-node warning did not name the Decay rate parameter.', 10000);

        const issueText = await evaluate(diagnosticWindow, `document.querySelector('.validationIssue').textContent`);
        assert.match(issueText, /driven mainly by this node's own 'Decay rate' source-term parameter/,
            'The warning should name the specific parameter, not just the node.');
        assert.match(issueText, /raising this node's numerics\.substepsPerGlobalStep to at least 2/,
            'The warning should include a concrete requiredSubsteps recommendation.');

        await evaluate(diagnosticWindow, `document.querySelector('.validationIssue').click()`);
        await waitFor(diagnosticWindow, `!document.querySelector('#nodeEditor').classList.contains('hidden') && document.querySelector('#nodeEditor [data-editor-tab].active').dataset.editorTab === 'parameters'`,
            'Clicking the attributed warning did not open its node\'s Parameters tab.');
        await waitFor(diagnosticWindow, `document.activeElement?.dataset.field === 'value' && document.activeElement?.closest('#nodeEditorParameters')`,
            "Clicking the attributed warning did not focus the specific parameter's value input.");
        assert.equal(
            await evaluate(diagnosticWindow, `document.activeElement.closest('.editorParameterRow').querySelector('[data-field="symbol"]').value`),
            'decayRate', "The focused row should be decayRate's own row, not some other parameter.");

        await closeWhenValidated(diagnosticWindow);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own isolated diagnostic window; no web-edition equivalent' });

    await run('each validation issue takes you to where it is: a relationship\'s equation, a node\'s states, the run settings', async () => {
        // The thermal example with one mistake of each kind: an unknown symbol in the relationship's equation, a state's tuning range
        // its initial value is outside, and an output interval that is not a whole number of time steps.
        const document_ = JSON.parse(await decodeProjectFile(await readFile(join(process.cwd(), 'examples', 'thermalEquilibrium.kjt'))));
        document_.edges[0].equation = String.raw`\mathrm{noSuchState}`;
        delete document_.edges[0].equationModel;
        document_.nodes[1].states[0].tuning = { minimum: 1000, maximum: 2000 };
        document_.runConfigurations = [{ id: 9001, name: 'Default', globalTimeStep: 0.1, outputInterval: 0.15 }];
        document_.activeRunConfigurationId = 9001;
        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('#newWindowButton').click()`);
        const opened = await driver.waitForNewHandle(before);
        try {
            await waitFor(opened, `document.querySelector('.documentTitle')`, 'The new window did not finish loading.');
            await evaluate(opened, `window.__debugProject.load(${JSON.stringify(document_)}, 'issues.kjt')`);
            await settle(opened, 'validation');
            await waitFor(opened, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && document.querySelectorAll('#validationIssues .validationIssue').length === 3`, 'The three issues were not listed.', 15000);
            const issue = (kind) => `[...document.querySelectorAll('#validationIssues .validationIssue')].find((item) => item.querySelector('small').textContent.startsWith(${JSON.stringify(kind)}))`;
            const follow = async (kind) => {
                if (await evaluate(opened, `document.querySelector('#validationPanel').hidden`)) await evaluate(opened, `document.querySelector('#validationSummary').click()`);
                await waitFor(opened, `!document.querySelector('#validationPanel').hidden && Boolean(${issue(kind)})`, `The ${kind} issue was not listed.`);
                await evaluate(opened, `${issue(kind)}.click()`);
                assert.equal(await evaluate(opened, `document.querySelector('#validationPanel').hidden`), true, 'Following an issue closes the list.');
            };

            // The relationship's equation: its editor, with the equation focused.
            await follow('edge');
            await waitFor(opened, `!document.querySelector('#edgeEditor').classList.contains('hidden') && document.activeElement?.id === 'editEdgeMathField'`, 'The equation issue did not open the relationship with its equation focused.');
            assert.equal(await evaluate(opened, `document.querySelector('#editEdgeName').value`), 'Conduction');

            // The node's states: its editor, with a state focused.
            await follow('node');
            await waitFor(opened, `!document.querySelector('#nodeEditor').classList.contains('hidden') && Boolean(document.activeElement?.closest('#nodeEditorStates'))`, 'The state issue did not open the node with its states focused.');
            assert.equal(await evaluate(opened, `document.querySelector('#editNodeName').value`), 'Cold body', 'The node with the mistake is the one opened.');

            // The run settings: the Run dialog, where the interval is set.
            await follow('runConfiguration');
            await waitFor(opened, `document.querySelector('#runLaunchDialog').open`, 'The run settings issue did not open the Run dialog.');
            assert.equal(Number(await evaluate(opened, `document.querySelector('#runOutputInterval').value`)), 0.15);
            await evaluate(opened, `document.querySelector('#runLaunchDialog').close()`);
        } finally {
            await evaluate(opened, `window.confirm = () => true`).catch(() => {});
            await opened.close();
        }
    }, { skip: !driver.capabilities.multiWindow && 'opens its own window; no web-edition equivalent' });

    await run('the stability-monitoring toggle suppresses during-run findings without disabling the post-run check', async () => {
        // Fresh window + the same "Growth" (dx/dt = level) fixture as the stability-findings test
        // above -- deliberately reused since it is independently caught by BOTH systems (during-run
        // monitoring's own Jacobian re-check, and the post-run fingerprint's growth detection over
        // the completed trajectory): during-run findings always carry a real globalTime and their
        // own C++-authored message text (duringRunStabilityMonitor.cpp); post-run findings always
        // have globalTime: null and entirely different message text (resolvedStabilityFindings() in
        // renderer.mjs). A model both systems would flag is exactly what proves the toggle
        // suppresses the first without touching the second.
        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('#newWindowButton').click()`);
        const diagnosticWindow = await driver.waitForNewHandle(before);
        await waitFor(diagnosticWindow, `document.querySelector('.documentTitle')`, 'Diagnostic window did not finish loading.');

        await makeNode(diagnosticWindow, 'Growth', { name: 'Level', symbol: 'level', value: '1', unit: '' });
        await waitFor(diagnosticWindow, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'Growth node editor did not open after creation.');

        // Written by its reference button, as a person picks it: the growth rate is the level itself.
        await writeOwnPart(diagnosticWindow, 'level', '');
        await evaluate(diagnosticWindow, `${ownPartReferences('level')}.find((button) => button.textContent === 'level').click()`);
        await waitFor(diagnosticWindow, `document.querySelector('#nodeEditorStates .stateCard[data-symbol="level"] .ownPart').value.includes('level')`, 'The level reference was not put in the field.');
        await evaluate(diagnosticWindow, `document.querySelector('#nodeEditorStates .stateCard[data-symbol="level"] .ownPart').dispatchEvent(new Event('change', { bubbles: true }))`);
        await waitFor(diagnosticWindow, `${ownPartDiagnostics('level')}.classList.contains('valid')`, 'The self-referencing growth equation did not become valid.');
        await evaluate(diagnosticWindow, `document.querySelector('#nodeEditor [data-close-card]').click()`);

        await settle(diagnosticWindow, 'validation');
        await waitFor(diagnosticWindow, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && !document.querySelector('#runButton').disabled`, 'Model validation did not settle before the run settings could be opened.', 10000);
        await openRunDialog(diagnosticWindow);
        await waitFor(diagnosticWindow, `document.querySelector('#runLaunchDialog').open`, 'Run dialog did not open.');
        await evaluate(diagnosticWindow, `(() => {
            document.querySelector('#runGlobalTimeStep').value = '0.1';
            document.querySelector('#runOutputInterval').value = '0.1';
            document.querySelector('#saveRunConfiguration').click();
        })()`);
        await waitFor(diagnosticWindow, `!document.querySelector('#runLaunchDialog').open`, 'Run dialog did not close.');

        await waitFor(diagnosticWindow, `!document.querySelector('#runButton').disabled`, 'Model validation did not complete before Run could be started.', 10000);
        await openRunDialog(diagnosticWindow);
        await evaluate(diagnosticWindow, `(() => {
            document.querySelector('#runTargetTime').value = '1';
            document.querySelector('#runStabilityMonitoring').checked = false;
            document.querySelector('#startRun').click();
        })()`);
        await waitFor(diagnosticWindow, `!document.querySelector('#resultTransport').hidden && document.querySelector('.resultMode b').textContent === 'Results'`,
            'Offline run did not complete.', 15000);

        // Findings panel still opens (the post-run fingerprint check is unconditional and
        // independent of this toggle) -- but its content must carry none of during-run monitoring's
        // own wording.
        await evaluate(diagnosticWindow, `document.querySelector('#stabilitySummaryButton').click()`);
        await waitFor(diagnosticWindow, `!document.querySelector('#stabilityFindingsCard').classList.contains('hidden')`, 'Stability findings card did not open.');
        const listText = await evaluate(diagnosticWindow, `document.querySelector('#stabilityFindingsList').textContent`);
        assert.doesNotMatch(listText, /re-check of its current dynamics|has grown for \d+ consecutive/,
            'Unchecking stability monitoring should suppress during-run findings.');
        assert.match(listText, /grew substantially across the completed run|classic Explicit Euler instability signature/,
            'The post-run fingerprint check should still independently catch the same instability.');

        await closeWhenValidated(diagnosticWindow);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own isolated diagnostic window; no web-edition equivalent' });

    await run('equations use simulation time t and piecewise cases, from the editors through a run', async () => {
        // Heater: energy' = 2 while 0.95 <= t < 2.95, else 0 (a source term written with t).
        // Room: fed by the Warm room edge, which this test rewrites to 1 once t >= 1.95.
        // At dt = 0.1 over 5 s that gives energy = 2 * 2 = 4 and heat = 1 * 3 = 3.
        const time = { kind: 'time', symbol: 't' };
        const heaterLatex = String.raw`\begin{cases} 2 & 0.95 \le t < 2.95 \\ 0 & \text{otherwise} \end{cases}`;
        const project = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' },
            runConfigurations: [{ id: 50, name: 'Default', globalTimeStep: 0.1, outputInterval: 0.1 }], activeRunConfigurationId: 50,
            nodes: [
                {
                    id: 1, name: 'Heater', position: [-4, 0, 0], appearance: { type: 'primitive', shape: 'box', color: '#888888' },
                    states: [{ id: 2, name: 'Energy', symbol: 'energy', initialValue: 0 }],
                    sourceTerms: [{
                        id: 3, state: 'energy', expression: heaterLatex,
                        expressionModel: {
                            latex: heaterLatex, output: { stateId: 2 },
                            bindings: [{ kind: 'state', nodeId: 1, stateId: 2, symbol: 'energy' }, time],
                            mathJson: ['Which', ['And', ['LessEqual', 0.95, 't'], ['Less', 't', 2.95]], 2, 'True', 0]
                        }
                    }]
                },
                {
                    id: 4, name: 'Room', position: [4, 0, 0], appearance: { type: 'primitive', shape: 'box', color: '#888888' },
                    states: [{ id: 5, name: 'Heat', symbol: 'heat', initialValue: 0 }], sourceTerms: []
                }
            ],
            edges: [{
                id: 6, name: 'Warm room', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 4, stateId: 5 }, directionality: 'directed',
                equation: '0',
                equationModel: {
                    latex: '0', output: { role: 'target', stateId: 5 },
                    bindings: [
                        { kind: 'state', role: 'source', nodeId: 1, stateId: 2, symbol: 'sourceEnergy' },
                        { kind: 'state', role: 'target', nodeId: 4, stateId: 5, symbol: 'targetHeat' },
                        time
                    ],
                    mathJson: 0
                },
                parameters: [], appearance: { color: '#888888', offset: 0 }
            }]
        };
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-time-'));
        const projectPath = join(directory, 'timeAndCases.kjt');
        await writeFile(projectPath, await encodeProjectFile(JSON.stringify(project)));
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 2`, 'The time project did not load.');

        const setEdgeEquation = (latex) => evaluate(opened, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue(${JSON.stringify(latex)});
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        const diagnostics = () => evaluate(opened, `document.querySelector('#equationDiagnostics').textContent`);

        const point = await canvasPoint(opened, `window.__relationshipScreenPoint('Warm room')`);
        assert.ok(point, 'Could not locate the Warm room edge on screen.');
        await opened.mouseMove(point);
        await opened.mouseDown(point, { button: 'left', clickCount: 1 });
        await opened.mouseUp(point, { button: 'left', clickCount: 1 });
        await waitFor(opened, `document.querySelector('#editEdgeName').value === 'Warm room'`, 'The edge editor did not open.');

        // The time chip is offered alongside the state chips and inserts t.
        const timeChip = `[...document.querySelectorAll('#editStateReferenceChips button')].find((button) => button.textContent === 't (time)')`;
        assert.ok(await evaluate(opened, `Boolean(${timeChip})`), 'The edge editor must offer a t (time) chip.');
        assert.equal(await evaluate(opened, `${timeChip}.title`), 'Insert simulation time (seconds)');
        await setEdgeEquation('');
        await evaluate(opened, `${timeChip}.click()`);
        await waitFor(opened, `document.querySelector('#editEdgeMathField').value.trim() === 't'`, 'Clicking the time chip did not insert t.');

        // Editor-side checks for cases and comparisons.
        await setEdgeEquation(String.raw`\begin{cases} 1 & t \ge 1.95 \end{cases}`);
        assert.match(await diagnostics(), /otherwise/, 'A cases expression without an otherwise branch must be rejected.');
        await setEdgeEquation('t > 1');
        assert.match(await diagnostics(), /condition of a cases expression/, 'A bare comparison must be rejected.');
        await setEdgeEquation(String.raw`\begin{cases} 1 & t \ge 1.95 \\ 0 & \text{otherwise} \end{cases}`);
        assert.equal(await diagnostics(), 'Valid expression · MathJSON ready');
        await settle(opened, 'validation');
        await waitFor(opened, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && !document.querySelector('#validationSummary').classList.contains('error')`,
            'The engine must accept a cases expression using t.');

        // Providers get time from their evaluation context, so t is not offered as a provider binding.
        await evaluate(opened, `(() => { const select = document.querySelector('#editEdgeImplementationKind'); select.value = 'cpp'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await evaluate(opened, `document.querySelector('#editAddProviderBinding').click()`);
        const referenceOptions = await evaluate(opened, `[...document.querySelectorAll('#edgeEditor .providerBindingRow [data-field="reference"] option')].map((option) => option.textContent)`);
        assert.ok(referenceOptions.length > 0, 'The provider binding row must list references.');
        assert.ok(!referenceOptions.some((label) => label.includes('time')), `Provider bindings must not offer t (got ${referenceOptions.join(', ')}).`);
        await evaluate(opened, `(() => { const select = document.querySelector('#editEdgeImplementationKind'); select.value = 'equation'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(opened, `!document.querySelector('#editEdgeMathField').hidden || !document.querySelector('#editEdgeEquation').hidden`, 'The edge editor did not return to equation mode.');
        await setEdgeEquation(String.raw`\begin{cases} 1 & t \ge 1.95 \\ 0 & \text{otherwise} \end{cases}`);
        assert.equal(await diagnostics(), 'Valid expression · MathJSON ready');
        await evaluate(opened, `document.querySelector('#edgeEditor [data-close-card]').click()`);

        // The node's own part offers the same reference, and the loaded cases-on-t part is valid.
        await evaluate(opened, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Heater')).click()`);
        await waitFor(opened, `[...document.querySelectorAll('#nodeEditorStates .ownPartReferences button')].some((button) => button.textContent === 't (time)')`, 'A node\'s own part must offer a t (time) reference.');
        assert.equal(await evaluate(opened, `[...document.querySelectorAll('#nodeEditorStates .ownPartDiagnostics')].find((element) => element.textContent)?.textContent`), 'Valid expression · MathJSON ready');

        // Run and check both time-dependent rates switched where they should.
        await openRunDialog(opened);
        await evaluate(opened, `(() => { document.querySelector('#runTargetTime').value = '5'; document.querySelector('#startRun').click(); })()`);
        await waitFor(opened, `document.querySelector('.resultMode b').textContent === 'Results'`, 'The run did not complete.', 15000);
        await waitFor(opened, `Number(document.querySelector('#resultTimeline').max) === 5 && Number(document.querySelector('#resultTimeline').value) === 5`, 'The results did not load to the end of the run.', 15000);
        const finalValue = (nodeId) => evaluate(opened, `Number.parseFloat(document.querySelector('.node-label-container[data-node="${nodeId}"] dd').textContent)`);
        assert.ok(Math.abs(await finalValue(1) - 4) < 1e-6, `Heater energy should be 4 (got ${await finalValue(1)}).`);
        assert.ok(Math.abs(await finalValue(4) - 3) < 1e-6, `Room heat should be 3 (got ${await finalValue(4)}).`);
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    await run('a data log is replayed through the model in the tuning card, and judged against a tolerance', async () => {
        // Two hours of the simulated rig (examples/dataSources/simulatedTankRig.py), written here without noise: the heater on for an
        // hour, then off, and the tank's exact temperature every minute, with one reading the logger marked bad.
        const capacitance = 209000, heatLoss = 20, ambient = 293.15;
        const rows = [];
        let temperature = ambient;
        for (let time = 0; time <= 7200; time += 60) {
            const power = time < 3600 ? 1000 : 0;
            if (time > 0) {
                const previousPower = time - 60 < 3600 ? 1000 : 0;
                const settled = ambient + previousPower / heatLoss;
                temperature = settled + (temperature - settled) * Math.exp(-heatLoss * 60 / capacitance);
            }
            const heater = time === 0 || time === 3600 ? String(power) : '';
            rows.push(time === 1800 ? `${time},${heater},${(temperature + 20).toFixed(3)},bad` : `${time},${heater},${temperature.toFixed(3)},`);
        }
        const log = [
            '# konjugate data log: 1', '# source: Interaction test', '# time: seconds since 2026-11-06T09:00:00Z',
            '# inputs: heaterPower', '# outputs: tankTemperature', 'time,heaterPower [W],tankTemperature [K],tankTemperature quality', ...rows
        ].join('\n') + '\n';

        const before = driver.allHandles();
        await driver.simulateOsFileOpen(join(process.cwd(), 'examples', 'dataSources', 'simulatedTankRig.kjt'));
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 3`, 'The rig model did not load.');
        await evaluate(opened, `document.querySelector('#parameterTuningButton').click()`);
        await waitFor(opened, `!document.querySelector('#parameterTuning').classList.contains('hidden')`, 'The tuning card did not open.');

        // Chosen while the card is set to fit data, a data log moves the card to replaying it, and its signals are matched by name.
        await evaluate(opened, `window.__debugParameterTuning.loadCsv(${JSON.stringify(log)}, 'tankRun.csv')`);
        await waitFor(opened, `!document.querySelector('#parameterTuningReplaySection').hidden`, 'The replay section did not appear for a data log.');
        assert.equal(await evaluate(opened, `document.querySelector('#parameterTuningGoalReplay').getAttribute('aria-pressed')`), 'true');
        assert.equal(await evaluate(opened, `document.querySelector('#parameterTuningParametersSection').hidden`), true, 'Replaying tunes nothing.');
        assert.equal(await evaluate(opened, `document.querySelector('#runParameterTuning').hidden`), true);
        assert.match(await evaluate(opened, `document.querySelector('#parameterTuningStatus').textContent`), /^This is a data log, so it is replayed.*2 signals, 123 readings over 2 h 00 min, from Interaction test\. Matched 2 of 2 by name/);
        const target = (signal) => `document.querySelector('.parameterTuningReplayRow[data-signal="${signal}"] select').value`;
        assert.equal(await evaluate(opened, target('heaterPower')), '40', 'The heater power drives the shared Heater power.');
        assert.equal(await evaluate(opened, target('tankTemperature')), '2', 'The thermometer is compared with the water temperature.');
        assert.equal(await evaluate(opened, `document.querySelector('#parameterTuningReplayTimeStep').value`), '60');

        const tolerance = `document.querySelector('.parameterTuningReplayRow[data-signal="tankTemperature"] input[data-field="tolerance"]')`;
        // A tolerance has to be more than nothing: one that is not is put back as it was.
        const suggestedTolerance = await evaluate(opened, `${tolerance}.value`);
        await evaluate(opened, `(() => { const input = ${tolerance}; input.value = '-1'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(opened, `${tolerance}.value`), suggestedTolerance, 'A tolerance that is not positive should be put back.');
        await evaluate(opened, `(() => { const input = ${tolerance}; input.value = '0.2'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await evaluate(opened, `document.querySelector('#runParameterTuningReplay').click()`);
        await waitFor(opened, `window.__debugParameterTuning.replay() !== null`, 'The replay did not finish.', 30000);
        const [inStep] = await evaluate(opened, `window.__debugParameterTuning.replay()`);
        assert.deepEqual(inStep.stretches, [], `The model the log was made with should stay in step: ${inStep.sentence}`);
        assert.ok(inStep.rms < 0.1, `It should miss by little more than the rounding: ${inStep.sentence}`);
        assert.match(inStep.sentence, /^Water tank · Water temperature stayed within 0\.2 K for the whole 2 h 00 min\..* 1 bad reading was left out\.$/);
        await waitFor(opened, `document.querySelector('#parameterTuningReplayPlot').data?.length === 5`, 'The plot of measured against replayed, with the tolerance band, was not drawn.');

        // A tighter tolerance judges the same run again, without running it.
        await evaluate(opened, `(() => { const input = ${tolerance}; input.value = '0.000001'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(opened, `window.__debugParameterTuning.replay()[0].stretches.length > 0`, 'A tighter tolerance was not applied to the last run.');

        // A stretch the recording does not reach is refused before anything runs, and says why.
        const setReplayField = (selector, value) => evaluate(opened, `(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await setReplayField('#parameterTuningReplayFrom', '5');
        await setReplayField('#parameterTuningReplayTo', '6');
        await evaluate(opened, `document.querySelector('#runParameterTuningReplay').click()`);
        await waitFor(opened, `/no readings in that stretch/.test(document.querySelector('#parameterTuningReplayStatus').textContent)`, 'A stretch past the end of the recording was not refused.');
        assert.equal(await evaluate(opened, `window.__debugParameterTuning.replay()`), null, 'Nothing should have been replayed.');
        assert.equal(await evaluate(opened, `document.querySelector('#runParameterTuningReplay').disabled`), false, 'A refused stretch leaves the replay ready to run again.');
        await setReplayField('#parameterTuningReplayFrom', '');
        await setReplayField('#parameterTuningReplayTo', '');

        // Comparing nothing cannot be replayed; and the model itself was never changed.
        await evaluate(opened, `(() => { const select = document.querySelector('.parameterTuningReplayRow[data-signal="tankTemperature"] select'); select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(opened, `document.querySelector('#runParameterTuningReplay').disabled`), true);
        assert.equal(await evaluate(opened, `window.__debugParameterTuning.replay()`), null, 'Changing the mapping clears the last outcome.');
        const document_ = await evaluate(opened, `window.__debugProject.serialize()`);
        assert.equal(document_.sharedParameters.find((parameter) => parameter.id === 40).schedule, undefined, 'Replaying must not leave a schedule in the model.');
        assert.equal(document_.nodes.find((node) => node.id === 1).states[0].initialValue, 293.15, 'Replaying must not move the model\'s initial state.');
        assert.equal(await evaluate(opened, `document.querySelector('#undoButton').disabled`), true, 'Replaying is not an edit.');
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    // The twin's own window, opened from a project window's Live twin button.
    const openTwinWindow = async (opened, button = '#liveTwinButton') => {
        const beforeTwin = driver.allHandles();
        await evaluate(opened, `document.querySelector('${button}').click()`);
        const twin = await driver.waitForNewHandle(beforeTwin, { titleIncludes: 'Live twin' }, 15000);
        await waitFor(twin, `document.querySelector('#modelSummary').textContent.length > 0`, 'The twin window did not show the model.');
        await twinWindowSettled(twin);
        return twin;
    };
    // A twin window opens and is then maximized, which on macOS is animated: it is resized for a moment after its content shows, and
    // a menu opened then is closed by the resize (a menu is placed where its button was). Used once its size holds still.
    const twinWindowSettled = (twin) => waitForStableRect(twin, `innerWidth + 'x' + innerHeight`, 'The twin window did not settle at its size.', 5000);
    const twinEvents = (twin) => evaluate(twin, `[...document.querySelectorAll('#eventsList li')].map((item) => item.className + ': ' + item.innerText.replace(/\\s+/g, ' '))`);
    const setField = (handle, selector, value, kind = 'change') => evaluate(handle, `(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('${kind}', { bubbles: true })); })()`);

    await run('a data log runs as a live twin in its window: moves, forecasts, jumps, watched, estimated with its band, a sandbox and a draft scenario, and a refit', async () => {
        // Six hours of the rig with no noise: the heater on for two hours, off for one, on for two, then off; a reading a minute.
        const capacitance = 209000, heatLoss = 20, ambient = 293.15;
        const heaterAt = (time) => (time < 7200 || (time >= 10800 && time < 18000) ? 1000 : 0);
        const rows = [];
        let temperature = ambient;
        for (let time = 0; time <= 21600; time += 60) {
            if (time > 0) {
                const settled = ambient + heaterAt(time - 60) / heatLoss;
                temperature = settled + (temperature - settled) * Math.exp(-heatLoss * 60 / capacitance);
            }
            const changed = time === 0 || heaterAt(time) !== heaterAt(time - 60);
            rows.push(`${time},${changed ? heaterAt(time) : ''},${temperature.toFixed(3)},`);
        }
        const log = [
            '# konjugate data log: 1', '# source: Interaction test', '# time: seconds since 2026-11-06T09:00:00Z',
            '# inputs: heaterPower', '# outputs: tankTemperature', 'time,heaterPower [W],tankTemperature [K],tankTemperature quality', ...rows
        ].join('\n') + '\n';

        const before = driver.allHandles();
        await driver.simulateOsFileOpen(join(process.cwd(), 'examples', 'dataSources', 'simulatedTankRig.kjt'));
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 3`, 'The rig model did not load.');
        // The room's temperature, which no reading reaches, is marked in its node's editor as an initial value to fit.
        const roomLabel = `[...document.querySelectorAll('.objectLabel')].find((item) => item.textContent.includes('Ambient air'))`;
        await waitFor(opened, `Boolean(${roomLabel})`, 'The Ambient air label was not on the canvas.');
        await evaluate(opened, `${roomLabel}.click()`);
        await waitFor(opened, `!document.querySelector('#nodeEditor').classList.contains('hidden') && document.querySelector('#editNodeName').value === 'Ambient air'`, 'The Ambient air editor did not open.');
        // Its state's fields are opened from its line, as a person opens them.
        await openStateFields(opened, await evaluate(opened, `window.__debugProject.serialize().nodes.find((node) => node.name === 'Ambient air').states[0].symbol`));
        await evaluate(opened, `document.querySelector('#nodeEditorStates .editorStateRow:not([hidden]) .tuneState').click()`);
        await waitFor(opened, `Boolean(document.querySelector('#nodeEditorStates .editorStateTuning'))`, 'The bounds of a fitted initial value were not offered.');
        assert.deepEqual(await evaluate(opened, `window.__debugProject.serialize().nodes.find((node) => node.name === 'Ambient air').states[0].tuning`), { minimum: 0, maximum: 586.3 }, 'The bounds start as the value give or take its own size.');
        await evaluate(opened, `document.querySelector('#nodeEditor [data-close-card]').click()`);

        const twin = await openTwinWindow(opened);
        await evaluate(twin, `window.__debugTwinWindow.offerLog(${JSON.stringify(log)}, 'tankRun.csv')`);
        await waitFor(twin, `document.querySelectorAll('#mappingRows .mappingRow.confident').length === 2`, 'The log\'s signals were not matched by name.');
        const summary = () => evaluate(twin, `window.__debugTwinWindow.summary()`);
        const playedThrough = (message, timeout = 120000) => waitFor(twin, `window.__debugTwinWindow.summary()?.ended === 'played'`, message, timeout);
        // Started again with the engineer's settings: a new twin, played through.
        const restartAndPlay = async (message, timeout = 120000) => {
            const { startedAt } = await summary();
            await evaluate(twin, `document.querySelector('#restartTwin').click()`);
            await waitFor(twin, `window.__debugTwinWindow.summary()?.startedAt !== ${JSON.stringify(startedAt)} && window.__debugTwinWindow.summary()?.ended === 'played'`, message, timeout);
        };

        // As fast as it can go: every move of the window, then the end.
        await evaluate(twin, `window.__debugTwinWindow.setSpeed('Infinity')`);
        await evaluate(twin, `document.querySelector('#openRoom').click()`);
        await playedThrough('The live twin did not play the whole log.');
        const played = await summary();
        assert.equal(played.moves, 31, 'A one-hour window moving every ten minutes over six hours makes 31 moves.');
        assert.equal(played.last.now, 21600);
        assert.ok(Math.abs(played.last.jumps.tankTemperature.jump) < 0.2, `The true model jumps by little: ${played.last.jumps.tankTemperature.jump}.`);
        assert.deepEqual(await evaluate(twin, `document.querySelector('#tiles .tile .plot').data.map((trace) => trace.name)`), ['Measured', 'Model, as each move ran it', 'Model', 'Forecast']);
        // The model's past, as each move ran it, is kept: with everything shown, it runs from the start of the log to the latest window,
        // so the model is seen staying in step for the whole six hours, and not only over its last hour.
        await setField(twin, '#timeSpan', 'all');
        const modelSpan = await evaluate(twin, `(() => { const plot = document.querySelector('#tiles .tile .plot'); const xs = (name) => plot.data.find((trace) => trace.name === name).x.filter((x) => x !== null); return { earlier: [Math.min(...xs('Model, as each move ran it')), Math.max(...xs('Model, as each move ran it'))], latest: Math.min(...xs('Model')) }; })()`);
        assert.ok(modelSpan.earlier[0] < 0.2 && Math.abs(modelSpan.earlier[1] - modelSpan.latest) < 0.2, `The model's past runs from the start to the latest window (got ${JSON.stringify(modelSpan)}).`);
        await setField(twin, '#timeSpan', 'recent');
        assert.match(await evaluate(twin, `document.querySelector('#healthTwin').textContent`), /^The whole log has been played: 31 moves/);
        // Played to its end, the twin is not running: Try something is not offered, and says why.
        assert.equal(await evaluate(twin, `document.querySelector('#trySomething').disabled`), true);
        assert.match(await evaluate(twin, `document.querySelector('#trySomething').title`), /^The twin has stopped/);
        assert.equal(await evaluate(twin, `document.querySelector('#healthDrift').textContent`), 'In step');
        assert.match(await evaluate(twin, `document.querySelector('#inferredRows').innerText`), /Ambient air · Temperature\s+carried by the model/, 'The room says what the readings do not reach.');

        // Watched only: after the first move the model runs on unaided, and the choice is kept with the project.
        await evaluate(twin, `document.querySelector('#engineerToggle').click()`);
        await setField(twin, '#correctionRows select', 'watch');
        await restartAndPlay('The watched live twin did not play the whole log.');
        assert.equal((await summary()).last.corrections.tankTemperature.reason, 'watched only');
        await waitFor(opened, `window.__debugTwin.setup()?.live?.corrections?.tankTemperature?.gain === 0`, 'Watching was not kept with the project.');
        await setField(twin, '#correctionRows select', 'nudge');
        assert.equal(await evaluate(twin, `document.querySelector('#correctionRows input:not([data-noise])').hidden`), false, 'A nudge asks how far.');
        // Timing the twin cannot run with is said as it is typed, in the engineer's terms, and the twin is not stopped for it.
        const [windowWas, strideWas] = await evaluate(twin, `[document.querySelector('#timingWindow').value, document.querySelector('#timingStride').value]`);
        await setField(twin, '#timingWindow', '20');
        await setField(twin, '#timingStride', '30');
        assert.equal(await evaluate(twin, `document.querySelector('#restartTwin').disabled`), true, 'Start again is not offered with timing that cannot run.');
        assert.match(await evaluate(twin, `document.querySelector('#restartNote').textContent`), /^The twin moves at least once a window: with a 20 min window, move every 20 min or less \(now every 30 min\)\.$/);
        await setField(twin, '#timingWindow', windowWas);
        await setField(twin, '#timingStride', strideWas);
        assert.equal(await evaluate(twin, `document.querySelector('#restartTwin').disabled`), false);

        // Estimated: the readings weighed against the model by an ensemble of twelve, the states and the tracked heat loss with their
        // spreads, the forecast with its band, the honesty of the band said, and the choice kept with the project.
        await setField(twin, '#correctionRows select', 'estimate');
        assert.equal(await evaluate(twin, `document.querySelector('#correctionRows input[data-noise]').hidden`), false, 'An estimate offers the readings\' noise.');
        assert.equal(await evaluate(twin, `document.querySelector('#trackBlock').hidden`), false, 'An estimate offers the ensemble and what to track.');
        await setField(twin, '#members', '12');
        await restartAndPlay('The estimated live twin did not play the whole log.', 180000);
        const estimated = await summary();
        assert.equal(estimated.moves, 31);
        assert.equal(estimated.last.corrections.tankTemperature.estimate, true);
        assert.equal(estimated.last.estimate.members, 12);
        assert.deepEqual(estimated.last.estimate.parameters.map((parameter) => parameter.parameterId), [10], 'The rig\'s tunable heat loss is tracked unless unticked.');
        assert.equal(await evaluate(twin, `document.querySelector('#tiles .tile .plot').data.some((trace) => trace.fill === 'tonexty')`), true, 'The forecast is drawn with its band.');
        const inferred = await evaluate(twin, `document.querySelector('#inferredRows').innerText`);
        assert.match(inferred, /Heat loss coefficient\s+a parameter, tracked\s+[\d.]+ W\/K\s*±/);
        assert.match(inferred, /Ambient air · Temperature\s+estimated\s+[\d.]+ °C\s*±/);
        assert.match(await evaluate(twin, `document.querySelector('#tiles .tile .facts').textContent`), /band (honest|too narrow|too wide) · \d+% outside/);
        await waitFor(opened, `window.__debugTwin.setup()?.live?.corrections?.tankTemperature?.estimate === true && window.__debugTwin.setup().live.members === 12`, 'The estimate was not kept with the project.');
        await setField(twin, '#correctionRows select', 'reset');
        assert.equal(await evaluate(twin, `document.querySelector('#trackBlock').hidden`), true);
        await restartAndPlay('The reset live twin did not play the whole log.');

        // At an hour a second, a sandbox part way: the heater off, run ahead; back to live keeps what was tried as a draft.
        await evaluate(twin, `window.confirm = () => true; document.querySelector('#roomSetup').click()`);
        await waitFor(twin, `!document.querySelector('#setup').hidden`, 'The setup did not come back.');
        await evaluate(twin, `window.__debugTwinWindow.setSpeed(3600)`);
        await evaluate(twin, `document.querySelector('#openRoom').click()`);
        await waitFor(twin, `(window.__debugTwinWindow.summary()?.moves ?? 0) >= 3`, 'The live twin did not get going.', 30000);
        await evaluate(twin, `document.querySelector('#trySomething').click()`);
        await waitFor(twin, `!document.querySelector('#sandboxBar').hidden`, 'The sandbox did not open.', 15000);
        await setField(twin, '#sandboxInputs input[data-signal="heaterPower"]', '0');
        await setField(twin, '#sandboxMinutes', '90');
        await evaluate(twin, `document.querySelector('#sandboxRun').click()`);
        await waitFor(twin, `/^Ran ahead to .* with Heater power 0 W\./.test(document.querySelector('#sandboxStatus').textContent)`, 'The sandbox did not run ahead.', 15000);
        assert.equal(await evaluate(twin, `document.querySelector('#tiles .tile .plot').data.some((trace) => trace.name === 'Tried')`), true, 'What was tried is drawn beside the forecast.');
        await evaluate(twin, `document.querySelector('#sandboxBack').click()`);
        await waitFor(opened, `window.__debugParameterTuning.scenarios().length === 1`, 'Going back to live did not keep the scenario.', 15000);
        const scenarios = await evaluate(opened, `window.__debugParameterTuning.scenarios()`);
        assert.deepEqual(scenarios[0].tried.map(({ signal, value }) => [signal, value]), [['heaterPower', 0]]);
        assert.equal(scenarios[0].ranFor, 5400);
        assert.match((await twinEvents(twin))[0], /kept as a draft scenario/);
        await playedThrough('The live twin did not carry on to the end after the sandbox.', 60000);
        const afterSandbox = await summary();
        assert.equal(afterSandbox.moves, 31, 'The live twin made every move, sandbox or not.');
        assert.deepEqual(afterSandbox.last.jumps, played.last.jumps, 'Nothing tried in the sandbox reached the live twin.');

        // Ten minutes a second: the latest window refitted, the room's value at its anchor found with it, and applied to the twin.
        await evaluate(twin, `document.querySelector('#roomSetup').click()`);
        await evaluate(twin, `window.__debugTwinWindow.setSpeed(600)`);
        await evaluate(twin, `document.querySelector('#openRoom').click()`);
        await waitFor(twin, `(window.__debugTwinWindow.summary()?.moves ?? 0) >= 1 && !document.querySelector('#refitRun').disabled`, 'The live twin did not get going for a refit.', 30000);
        await evaluate(twin, `document.querySelector('#refitRun').click()`);
        await waitFor(twin, `!document.querySelector('#refitApply').hidden`, 'The refit did not finish.', 60000);
        const refitRow = await evaluate(twin, `document.querySelector('#refitRows').textContent`);
        const room = refitRow.match(/Ambient air · Temperature at [\d.]+ (?:s|min|h): 293\.15 → ([\d.]+)/);
        const refittedLoss = refitRow.match(/Heat loss coefficient: 20 → ([\d.]+) W\/K/);
        assert.ok(refittedLoss && Math.abs(Number(refittedLoss[1]) - 20) < 1, `The heat loss is refitted near the truth: ${refitRow}`);
        assert.ok(room && Math.abs(Number(room[1]) - 293.15) < 0.5, `The room is fitted at the window's anchor, and found again near the truth: ${refitRow}`);
        assert.equal(await evaluate(twin, `document.querySelector('#refitKeep').hidden`), false, 'With the heat loss refitted, it can be kept in the model too.');
        await evaluate(twin, `document.querySelector('#refitApply').click()`);
        await waitFor(twin, `/^Applied: the twin runs with the new values from /.test(document.querySelector('#refitStatus').textContent)`, 'The refit was not applied.', 15000);
        await waitFor(twin, `Boolean(window.__debugTwinWindow.summary()?.last?.refit)`, 'The next move did not say a refit was applied.', 30000);
        // Where the new values took effect is marked on the strip, so the drop that follows reads as the refit's doing.
        await waitFor(twin, `document.querySelector('#tiles .tile .plot').layout.annotations?.some((note) => note.text === 'new values')`, 'Where the refit took effect is not marked.', 15000);
        // A refit that finishes once the twin has stopped (a log played to its end while it ran) is not offered to apply, and says why;
        // what it found can still be kept in the model.
        await evaluate(twin, `document.querySelector('#refitRun').click()`);
        await waitFor(twin, `document.querySelector('#refitRows').children.length > 0`, 'The second refit did not finish.', 60000);
        await evaluate(twin, `document.querySelector('#roomStop').click()`);
        await waitFor(twin, `window.__debugTwinWindow.summary()?.running === false`, 'The live twin did not stop.', 15000);
        await waitFor(twin, `document.querySelector('#refitApply').hidden && /^The twin has stopped/.test(document.querySelector('#refitStatus').textContent)`, 'Apply was still offered with the twin stopped.');
        assert.equal(await evaluate(twin, `document.querySelector('#refitKeep').textContent`), 'Keep in the model');

        // The scenario renamed and deleted from the room's list.
        await waitFor(twin, `document.querySelector('#scenariosToggle').textContent === 'Scenarios (1)'`, 'The scenario was not listed.');
        await evaluate(twin, `document.querySelector('#scenariosToggle').click()`);
        await setField(twin, '#scenarioList .scenarioRow input', 'Heater off at the start');
        await waitFor(opened, `window.__debugParameterTuning.scenarios()[0]?.name === 'Heater off at the start'`, 'The scenario was not renamed.');
        await evaluate(twin, `document.querySelector('#scenarioList .scenarioRow button').click()`);
        await waitFor(opened, `window.__debugParameterTuning.scenarios().length === 0`, 'The scenario was not deleted.');
        await waitFor(twin, `document.querySelector('#scenariosToggle').hidden`, 'The list stayed with nothing in it.');
        await twin.close();
        await evaluate(opened, `window.confirm = () => true; undefined`);
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own windows; no web-edition equivalent' });

    await run('a tuning objective written as a Python program, from a template, finds the true values', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-program-'));
        const projectPath = join(directory, 'tank.kjt');
        await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'tankCalibration.kjt')));
        const measured = await readFile(join(process.cwd(), 'examples', 'tankCalibrationMeasured.csv'), 'utf8');
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 3`, 'The tank model did not load.');
        await evaluate(opened, `document.querySelector('#parameterTuningButton').click()`);
        await waitFor(opened, `!document.querySelector('#parameterTuning').classList.contains('hidden')`, 'The tuning card did not open.');
        await evaluate(opened, `document.querySelector('#parameterTuningGoalObjective').click()`);
        await evaluate(opened, `window.__debugParameterTuning.loadCsv(${JSON.stringify(measured)}, 'tankCalibrationMeasured.csv')`);
        await waitFor(opened, `/Added 1 measured column/.test(document.querySelector('#parameterTuningStatus').textContent)`, 'The measured data was not added.');

        // Written as a Python program: the expression gives way to the program, its keys and its templates.
        await evaluate(opened, `document.querySelector('#parameterTuningObjectiveKind [data-objective-kind="python"]').click()`);
        assert.equal(await evaluate(opened, `document.querySelector('#parameterTuningExpressionPart').hidden`), true);
        assert.equal(await evaluate(opened, `document.querySelector('#parameterTuningProgramPart').hidden`), false);
        assert.match(await evaluate(opened, `document.querySelector('#parameterTuningTuneHint').textContent`), /Write the objective program/);
        await evaluate(opened, `[...document.querySelectorAll('#parameterTuningProgramTemplates button')].find((button) => button.textContent === 'Squared error against measured data').click()`);
        assert.match(await evaluate(opened, `document.querySelector('#parameterTuningProgramSource').value`), /def objective\(run\):/);
        const keys = await evaluate(opened, `[...document.querySelectorAll('#parameterTuningProgramBindings .parameterTuningProgramBinding')].map((row) => [row.querySelector('input').value, row.querySelector('select').value])`);
        assert.deepEqual(keys, [['simulated', 'state:2'], ['measured', 'measured:tankTemperature']], 'Each key starts bound to the first thing of its kind.');
        assert.equal(await evaluate(opened, `document.querySelector('#runParameterTuning').disabled`), false, 'A program with every key bound can run.');

        // A limit on a number the program reports: the program is made to report the final temperature, held at most 400 K, which the
        // truth keeps to.
        await evaluate(opened, `(() => { const source = document.querySelector('#parameterTuningProgramSource'); source.value = source.value.replace('    return sum(', '    run.report("final", simulated[-1])\\n    return sum('); source.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await evaluate(opened, `document.querySelector('#addParameterTuningConstraint').click()`);
        const limitRow = `document.querySelector('#parameterTuningConstraintRows .parameterTuningConstraintRow')`;
        assert.equal(await evaluate(opened, `${limitRow}.querySelector('[data-field="limitKind"]').hidden`), false, 'With a program, a limit can be a reported number.');
        await evaluate(opened, `(() => { const kind = ${limitRow}.querySelector('[data-field="limitKind"]'); kind.value = 'report'; kind.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(opened, `${limitRow}.querySelector('math-field').classList.contains('limitFormulaHidden')`), true, 'A reported number has no formula.');
        assert.deepEqual(await evaluate(opened, `[...document.querySelectorAll('#parameterTuningReportNames option')].map((option) => option.value)`), ['final'], 'The names the program reports are offered.');
        await evaluate(opened, `(() => { const name = ${limitRow}.querySelector('[data-field="report"]'); name.value = 'final'; name.dispatchEvent(new Event('input', { bubbles: true })); ${limitRow}.querySelector('[data-field="limit"]').value = '400'; })()`);
        await evaluate(opened, `document.querySelector('#parameterTuningObjectiveKind [data-objective-kind="expression"]').click()`);
        assert.equal(await evaluate(opened, `${limitRow}.querySelector('[data-field="limitKind"]').hidden`), true, 'Without a program, a limit is a formula.');
        await evaluate(opened, `document.querySelector('#parameterTuningObjectiveKind [data-objective-kind="python"]').click()`);

        await evaluate(opened, `(() => { document.querySelector('#parameterTuningMaxSimulations').value = '150'; document.querySelector('#runParameterTuning').click(); })()`);
        await waitFor(opened, `!document.querySelector('#parameterTuningReviewSection').hidden`, 'The program objective did not reach its review.', 120000);
        const report = await evaluate(opened, `window.__debugParameterTuning.report()`);
        const value = (parameterId) => report.finalParameters.find((entry) => entry.parameterId === parameterId).value;
        assert.ok(Math.abs(value(20) / 209000 - 1) < 0.02, `The program objective finds the capacitance: ${value(20)}.`);
        assert.ok(Math.abs(value(10) / 20 - 1) < 0.02, `The program objective finds the heat loss: ${value(10)}.`);
        assert.equal(report.failedTrials, 0);
        const setup = await evaluate(opened, `window.__debugParameterTuning.setup()`);
        assert.equal(setup.objective.program.language, 'python', 'The program is kept with the project, to run again.');
        assert.deepEqual(setup.objective.program.bindings, [{ key: 'simulated', kind: 'state', id: 2 }, { key: 'measured', kind: 'measured', column: 'tankTemperature' }]);
        assert.deepEqual(setup.objective.constraints, [{ report: 'final', relation: '<=', limit: 400 }], 'The reported limit is kept with the project.');
        await evaluate(opened, `window.confirm = () => true; undefined`);
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    await run('the invented lab trial in the card: another logger\'s file read, calibrated on a stretch, checked on another, run live', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-lab-'));
        const logPath = join(directory, 'vessel.csv');
        const made = spawnSync('python3', [join(process.cwd(), 'examples', 'dataSources', 'labVessel.py'), logPath, '--speed', '1e9'], { encoding: 'utf8' });
        assert.equal(made.status, 0, made.stderr);
        const text = await readFile(logPath, 'utf8');
        const projectPath = join(directory, 'vessel.kjt');
        await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'dataSources', 'labVessel.kjt')));
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 4`, 'The vessel model did not load.');
        await evaluate(opened, `document.querySelector('#parameterTuningButton').click()`);
        await waitFor(opened, `!document.querySelector('#parameterTuning').classList.contains('hidden')`, 'The tuning card did not open.');
        await evaluate(opened, `document.querySelector('#parameterTuningGoalReplay').click()`);
        await evaluate(opened, `window.__debugParameterTuning.loadCsv(${JSON.stringify(text)}, 'vessel.csv')`);
        await waitFor(opened, `!document.querySelector('#parameterTuningLoggerSection').hidden`, 'Another logger\'s file was not offered to describe.');
        assert.match(await evaluate(opened, `document.querySelector('#parameterTuningStatus').textContent`), /not a Konjugate data log, but another logger's table/);
        assert.equal(await evaluate(opened, `document.querySelector('#loggerDelimiter').value`), ';');
        assert.equal(await evaluate(opened, `document.querySelector('#loggerDecimal').value`), ',');
        assert.equal(await evaluate(opened, `document.querySelector('#loggerTimeFormat').value`), 'DD.MM.YYYY HH:mm:ss');
        const column = (name) => `#loggerColumns .loggerColumn[data-column="${name}"]`;
        assert.equal(await evaluate(opened, `document.querySelector('${column('Datum')} select').value`), 'time', 'The date and time columns are guessed.');
        assert.equal(await evaluate(opened, `document.querySelector('${column('Uhrzeit')} select').value`), 'time');
        const set = (selector, value) => evaluate(opened, `(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await set('#loggerTimeZone', 'Europe/Berlin');
        const describe = async (name, use, fields) => {
            await set(`${column(name)} select`, use);
            for (const [field, value] of Object.entries(fields)) await set(`${column(name)} input[data-field="${field}"]`, value);
        };
        await describe('TC1 (°C)', 'output', { name: 'waterTemperature', unit: 'K', offset: '273.15' });
        await describe('Heizung (%)', 'input', { name: 'heaterPower', unit: 'W', scale: '30' });
        await describe('Ventil', 'input', { name: 'inflowRate', unit: 'kg/s', values: 'OPEN=0.015, CLOSED=0' });
        await describe('Raum (°C)', 'input', { name: 'roomTemperature', unit: 'K', offset: '273.15' });
        // Read with no column said to hold the time, the card asks for one, and reads nothing.
        await set(`${column('Datum')} select`, '');
        await set(`${column('Uhrzeit')} select`, '');
        await evaluate(opened, `document.querySelector('#loggerRead').click()`);
        assert.match(await evaluate(opened, `document.querySelector('#loggerStatus').textContent`), /hold the time/);
        assert.equal(await evaluate(opened, `document.querySelector('#parameterTuningReplaySection').hidden`), true, 'Nothing should have been read.');
        await set(`${column('Datum')} select`, 'time');
        await set(`${column('Uhrzeit')} select`, 'time');
        await evaluate(opened, `document.querySelector('#loggerRead').click()`);
        await waitFor(opened, `/^Read: /.test(document.querySelector('#loggerStatus').textContent)`, 'The logger\'s file was not read.');
        const told = await evaluate(opened, `document.querySelector('#loggerStatus').textContent`);
        assert.match(told, /failed readings? left out/);
        assert.match(told, /header written again once \(a restart\?\) skipped/);
        assert.match(told, /1 gap in the readings/);
        assert.match(told, /the clocks changed once and the times were kept in order/);
        const target = (signal) => `document.querySelector('.parameterTuningReplayRow[data-signal="${signal}"] select').value`;
        assert.equal(await evaluate(opened, target('waterTemperature')), '2');
        assert.equal(await evaluate(opened, target('heaterPower')), '40');

        // The first guesses, replayed on the first three and a half hours: out of step.
        await set('#parameterTuningReplayTimeStep', '5');
        await set('#parameterTuningReplayTo', '3.5');
        await evaluate(opened, `document.querySelector('#runParameterTuningReplay').click()`);
        await waitFor(opened, `window.__debugParameterTuning.replay() !== null`, 'The first guesses were not replayed.', 30000);
        assert.ok((await evaluate(opened, `window.__debugParameterTuning.replay()`))[0].stretches.length > 0, 'The first guesses go out of step.');

        // Calibrated on that stretch, and applied.
        await set('#replayCalibrateTo', '3.5');
        await evaluate(opened, `document.querySelector('#replayCalibrateRun').click()`);
        await waitFor(opened, `!document.querySelector('#replayCalibrateApply').hidden`, 'The calibration did not finish.', 120000);
        await evaluate(opened, `document.querySelector('#replayCalibrateApply').click()`);
        await waitFor(opened, `/Calibrated values applied/.test(document.querySelector('#replayCalibrateStatus').textContent)`, 'The calibrated values were not applied.', 30000);
        const shared = (await evaluate(opened, `window.__debugProject.serialize()`)).sharedParameters;
        const capacitance = shared.find((parameter) => parameter.id === 43).value;
        const heatLoss = shared.find((parameter) => parameter.id === 44).value;
        assert.ok(Math.abs(capacitance / 501600 - 1) < 0.03, `Calibrated capacitance ${capacitance}.`);
        assert.ok(Math.abs(heatLoss / 15 - 1) < 0.15, `Calibrated heat loss ${heatLoss}.`);
        assert.equal(await evaluate(opened, `document.querySelector('#undoButton').disabled`), false, 'Applying is one undoable step.');

        // Checked on the next stretch, which it was not calibrated on.
        await set('#parameterTuningReplayFrom', '3.5');
        await set('#parameterTuningReplayTo', '5');
        await evaluate(opened, `document.querySelector('#runParameterTuningReplay').click()`);
        await waitFor(opened, `(window.__debugParameterTuning.replay()?.[0]?.sentence ?? '').includes('for the whole')`, 'The calibrated model did not stay in step on the stretch it was not calibrated on.', 30000);

        // The whole log as a live twin, from the card in one click: the twin's window opens with the logger's file as the card read
        // it (its columns named, scaled and its words given values), and played as fast as it can go, the heater's scaling found by
        // the end.
        assert.equal((await evaluate(opened, `window.__debugParameterTuning.setup()`)).replay.logger.time.zone, 'Europe/Berlin', 'How the logger\'s file is read is kept with the project.');
        const twin = await openTwinWindow(opened, '#replayLiveTwin');
        await waitFor(twin, `/4 signals in vessel\.csv/.test(document.querySelector('#sourceStatus').textContent)`, 'The card\'s log did not come to the twin\'s window.');
        await waitFor(twin, `!document.querySelector('#openRoom').disabled`, 'The logger\'s signals were not matched.');
        assert.match(await evaluate(twin, `document.querySelector('#mappingCount').textContent`), /^4 of 4 signals mapped: 1 measured, 3 inputs\.$/);
        await evaluate(twin, `window.__debugTwinWindow.setSpeed('Infinity')`);
        await evaluate(twin, `document.querySelector('#openRoom').click()`);
        await waitFor(twin, `window.__debugTwinWindow.summary()?.ended === 'played'`, 'The live twin did not play the logger\'s file through.', 120000);
        // Its timing follows the readings, about five seconds apart: a move every two minutes on a twelve-minute window.
        assert.ok((await twinEvents(twin)).some((text) => /timing follows the readings.*a 12 min window, moving every 2 min/.test(text)), 'The twin did not say the timing it chose from the readings.');
        // The trial is judged at the timing it was designed for (as tests/engine/labTrial.mjs runs it): an hour's window moving every
        // ten minutes, set under Engineer, Timing, and played again.
        const { startedAt } = await evaluate(twin, `window.__debugTwinWindow.summary()`);
        await evaluate(twin, `document.querySelector('#engineerToggle').click()`);
        await setField(twin, '#timingUnit', '60');
        await setField(twin, '#timingWindow', '60');
        await setField(twin, '#timingStride', '10');
        await setField(twin, '#timingHorizon', '60');
        await waitFor(twin, `!document.querySelector('#restartTwin').disabled`, 'The trial\'s timing was not taken.');
        await evaluate(twin, `document.querySelector('#restartTwin').click()`);
        await waitFor(twin, `window.__debugTwinWindow.summary()?.startedAt !== ${JSON.stringify(startedAt)} && window.__debugTwinWindow.summary()?.ended === 'played'`, 'The live twin did not play the logger\'s file through at the trial\'s timing.', 120000);
        const live = await evaluate(twin, `window.__debugTwinWindow.summary()`);
        assert.equal(live.moves, 43);
        assert.equal(live.last.trend.direction, 'above', 'By the end the model runs warmer than the vessel: the heater has scaled up.');
        assert.ok((await twinEvents(twin)).some((text) => /leaning above the readings|drifting past the warning/.test(text)), 'The room says so.');
        await twin.close();
        await evaluate(opened, `window.confirm = () => true; undefined`);
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    await run('a live twin follows an OPC UA server: the server trusted when asked, its tags browsed with their units, and what arrives recorded', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-opcua-'));
        const server = await startRigServer({ pkiFolder: join(directory, 'serverPki') });
        // The PLC: a minute of the tank every 75 ms, each reading stamped with when it was measured.
        const epoch = Math.floor(Date.now() / 1000) * 1000;
        const capacitance = 209000, heatLoss = 20, ambient = 293.15;
        let minute = 0;
        let temperature = ambient;
        server.set('HeaterPower', 1000, new Date(epoch));
        server.set('TankTemperature', temperature, new Date(epoch));
        const reporting = setInterval(() => {
            minute += 1;
            const settled = ambient + 1000 / heatLoss;
            temperature = settled + (temperature - settled) * Math.exp(-heatLoss * 60 / capacitance);
            server.set('TankTemperature', temperature, new Date(epoch + minute * 60000));
        }, 75);
        try {
            const projectPath = join(directory, 'rig.kjt');
            await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'dataSources', 'simulatedTankRig.kjt')));
            const before = driver.allHandles();
            await driver.simulateOsFileOpen(projectPath);
            const opened = await driver.waitForNewHandle(before);
            await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 3`, 'The rig model did not load.');
            const twin = await openTwinWindow(opened);
            await evaluate(twin, `document.querySelector('[data-source="opcua"]').click()`);
            await setField(twin, '#opcuaUrl', server.url);
            await setField(twin, '#opcuaSecurity', 'signAndEncrypt');
            // Signed and encrypted: the server's certificate is new to this computer, so the person is asked, and says yes.
            await evaluate(twin, `(() => { window.__asked = []; window.confirm = (message) => { window.__asked.push(message); return true; }; })()`);
            await evaluate(twin, `document.querySelector('#opcuaBrowse').click()`);
            await waitFor(twin, `/^Found \\d+ tags/.test(document.querySelector('#sourceStatus').textContent)`, 'Browsing the server did not find its tags.', 30000);
            assert.match((await evaluate(twin, `window.__asked`))[0] ?? '', /does not trust yet/, 'The person was asked before the server was trusted.');
            const tag = (path) => `#mappingRows .mappingRow[data-signal="${server.nodeId(path)}"]`;
            assert.match(await evaluate(twin, `document.querySelector('${tag('TankTemperature')} .signal small').textContent`), / K, 250 to 400/, 'The unit and range the server gives are shown.');
            // The tags' names and units are matched to the rig's model by the suggestions.
            await waitFor(twin, `document.querySelector('${tag('TankTemperature')}').classList.contains('confident') && document.querySelector('${tag('HeaterPower')}').classList.contains('confident')`, 'The tags were not matched to the model.');
            await evaluate(twin, `document.querySelector('#openRoom').click()`);
            await waitFor(twin, `(window.__debugTwinWindow.summary()?.moves ?? 0) >= 3`, 'The live twin made no moves from the server.', 60000);
            // The twin counts time from its earliest reading, the heater's, set once at the start, while the subscription starts from
            // the temperature as the PLC has it by then: when browsing was slow (a loaded machine, an encrypted handshake) that is
            // already more than a window and two strides later, and the first moves come at once, from the first few readings. So the
            // test waits for twenty readings to have arrived, not for a number of moves.
            const measuredName = await evaluate(twin, `window.__debugTwinWindow.twin().tiles[0].signal`);
            await waitFor(twin, `(Object.values(window.__debugTwinWindow.summary()?.last?.window ?? {})[0]?.length ?? 0) >= 20`, 'Twenty readings did not arrive from the server.', 60000);
            await evaluate(twin, `document.querySelector('#roomStop').click()`);
            await waitFor(twin, `Boolean(window.__debugTwinWindow.summary()?.recordedTo)`, 'Stopping did not say where the readings were recorded.', 15000);
            const recordedTo = (await evaluate(twin, `window.__debugTwinWindow.summary()`)).recordedTo;
            assert.match(await evaluate(twin, `document.querySelector('#roomStatus').textContent`), /recorded in .*recordings/);
            const recorded = readDataLog(await readFile(recordedTo, 'utf8'));
            // The subscription starts with each tag's value as it is then (the PLC ran on while the tags were chosen), and from there
            // every reading is recorded: a minute apart, none missing.
            const times = recorded.observations.filter((observation) => observation.signal === measuredName).map((observation) => observation.time);
            assert.ok(times.length >= 20, `The recording holds what arrived: ${times.length} readings.`);
            assert.ok(times.every((time, index) => index === 0 || Math.abs(time - times[index - 1] - 60) < 1e-6), 'Every reading from the first to the last is recorded, a minute apart.');
            await twin.close();
            await evaluate(opened, `window.confirm = () => true; undefined`);
            await closeWhenValidated(opened);
        } finally {
            clearInterval(reporting);
            await server.shutdown();
        }
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    await run('the Live twin button opens the twin\'s window: with another model open, one click on the drifting rig opens its model and its control room, which warns of the drift', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-twin-'));
        const projectPath = join(directory, 'vessel.kjt');
        await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'dataSources', 'labVessel.kjt')));
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length > 0`, 'The project did not load.');

        assert.equal(await evaluate(opened, `document.querySelector('#liveTwinButton').hidden`), false, 'The toolbar offers the live twin.');
        const beforeTwin = driver.allHandles();
        await evaluate(opened, `document.querySelector('#liveTwinButton').click()`);
        const twin = await driver.waitForNewHandle(beforeTwin, { titleIncludes: 'Live twin' }, 15000);
        await waitFor(twin, `document.querySelector('#modelSummary').textContent.length > 0`, 'The twin window did not show the model.');
        await twinWindowSettled(twin);
        assert.equal(await evaluate(twin, `document.querySelectorAll('.sourceTiles [data-source]').length`), 4, 'Four places the readings can come from.');

        // The drifting rig's readings against the vessel's model match nothing: one click opens the rig's model in the project window,
        // matches the readings to it, and goes into the control room.
        // The demonstrations are in the title bar's More menu, out of the setup's way; the dialog says the project will be replaced.
        await evaluate(twin, `document.querySelector('#moreMenu').click()`);
        await waitFor(twin, `Boolean(document.querySelector('.tileMenu'))`, 'The More menu did not open.');
        const demonstrations = `[...document.querySelectorAll('.tileMenu button')].find((item) => item.textContent === 'Demonstrations…')`;
        assert.equal(await evaluate(twin, `${demonstrations}.disabled`), false);
        await evaluate(twin, `${demonstrations}.click()`);
        await waitFor(twin, `document.querySelector('#demosDialog').open`, 'The demonstrations did not open.');
        assert.match(await evaluate(twin, `document.querySelector('#demosDialog .hint').textContent`), /replacing the current project/);
        assert.equal(await evaluate(twin, `document.querySelectorAll('#demosDialog [data-demo]').length`), 5);
        // At 1200× rather than its own 600×: the drift comes about eight seconds in, with the log still playing, so the twin is live when
        // its warning, its red edge, its event and the project window's chip are looked at.
        await setField(twin, '#demoPace', '1200');
        await evaluate(twin, `document.querySelector('[data-demo="drifting"]').click()`);
        assert.equal(await evaluate(twin, `document.querySelector('#demosDialog').open`), false, 'Choosing one closes the dialog.');
        await waitFor(opened, `document.querySelector('.documentTitle').textContent === 'simulatedTankRig'`, 'The rig\'s model did not open in the project window.', 15000);
        await waitFor(twin, `!document.querySelector('#room').hidden`, 'The demonstration did not go into the control room.', 15000);
        assert.match(await evaluate(twin, `document.querySelector('#fileName').textContent`), /^simulatedTankRigDrifting\.csv \(a demonstration recording\)$/, 'The file field says what is playing.');

        // The control room warns once the drift passes the default warning, on the health strip and on the tile.
        await waitFor(twin, `document.querySelector('#healthDrift').textContent === 'Drifting past the warning'`, 'The control room did not warn of the drift.', 120000);
        // A legend and a unit on the tile; temperatures in °C, or in kelvin as the model keeps them. (How it keeps up, in words, is checked
        // on the motor, which is still running when it is looked at.)
        const plot = `document.querySelector('#tiles .tile .plot')`;
        // One legend for the column, naming what is drawn: no band (nothing is estimated) and nothing tried.
        assert.deepEqual(await evaluate(twin, `[...document.querySelectorAll('.trendLegend span:not([hidden])')].map((item) => item.textContent)`), ['Measured', 'Model', 'Forecast', 'Input']);
        assert.deepEqual(await evaluate(twin, `${plot}.data.filter((trace) => trace.showlegend !== false).map((trace) => trace.name)`), ['Measured', 'Model', 'Forecast']);
        assert.equal(await evaluate(twin, `${plot}.layout.yaxis.title.text`), '°C');
        assert.match(await evaluate(twin, `document.querySelector('#tiles .tile .value').textContent`), /^\d+(\.\d+)? °C$/);
        await evaluate(twin, `document.querySelector('#temperatureUnit').click()`);
        assert.match(await evaluate(twin, `document.querySelector('#tiles .tile .value').textContent`), /^3\d\d(\.\d+)? K$/, 'In kelvin, as the model keeps them.');
        await waitFor(opened, `window.__debugTwin.setup()?.layout?.temperature === 'K'`, 'The choice was not kept with the project.');
        await evaluate(twin, `document.querySelector('#temperatureUnit').click()`);
        // The heater's heat flow is the heater's power, set from it at every instant: the input strip shows it, and it is not listed
        // again among what no sensor measures.
        const inferredNames = await evaluate(twin, `[...document.querySelectorAll('#inferredRows .inferredRow strong')].map((name) => name.textContent)`);
        assert.ok(inferredNames.length > 0 && !inferredNames.some((name) => /Heat flow/.test(name)), `The heat flow is the heater's input, not inferred: ${inferredNames.join(', ')}.`);
        assert.equal(await evaluate(twin, `document.querySelector('#healthDrift').classList.contains('bad')`), true);
        assert.equal(await evaluate(twin, `document.querySelector('#tiles .tile').classList.contains('bad')`), true, 'The tile says so across the room.');
        // Under the tiles: the heater's power as it was set, what the twin infers of what no sensor measures, and the events.
        assert.match(await evaluate(twin, `document.querySelector('#inputRows .inputRow strong').textContent`), /^Heater power$/);
        assert.match(await evaluate(twin, `document.querySelector('#inputRows .inputRow .latest').textContent`), /^\d[\d.]* W$/);
        assert.equal(await evaluate(twin, `document.querySelector('#inputRows .inputRow .plot svg') !== null`), true, 'Drawn as a timeline.');
        const inferred = await evaluate(twin, `[...document.querySelectorAll('#inferredRows .inferredRow')].map((row) => row.innerText.replace(/\\s+/g, ' '))`);
        assert.ok(inferred.length > 0 && inferred.every((text) => /carried by the model/.test(text) && /(steady|rising|falling|dropped|rose|—)/.test(text)), 'Each unmeasured state with its value and trend (or the step it took).');
        const events = await evaluate(twin, `[...document.querySelectorAll('#eventsList li')].map((item) => item.className + ': ' + item.innerText.replace(/\\s+/g, ' '))`);
        assert.match(events.at(-1), /^info: .*The twin started/);
        assert.ok(events.some((text) => /^good: .*The twin is live/.test(text)));
        assert.match(events[0], /^bad: .*Water temperature is drifting past the warning/);
        // The project window's toolbar chip says so too, and brings the twin's window forward.
        await waitFor(opened, `!document.querySelector('#liveTwinChip').hidden && document.querySelector('#liveTwinChipText').textContent === 'Live twin: drifting'`, 'The toolbar chip did not show the drift.');
        await evaluate(twin, `document.querySelector('#roomStop').click()`);
        await waitFor(opened, `document.querySelector('#liveTwinChip').hidden`, 'The chip stayed after the twin stopped.');
        // Another take: the demonstration's model changed since (its heat loss kept in it, as Keep in the model after a refit leaves it),
        // and the demonstration picked again. It opens its model as it ships rather than going on with the changed one, so every take
        // starts from the same model; and since the change was the demonstration's, not the person's, without asking (a prompt the
        // project window raised sat behind the twin's, and the take stalled).
        const heatLossOf = () => evaluate(opened, `window.__debugProject.serialize().edges.flatMap((edge) => edge.parameters ?? []).find((parameter) => parameter.id === 10).value`);
        const shipped = await heatLossOf();
        driver.takeNativeDialogs?.();
        await evaluate(opened, `window.__debugParameterTuning.keepValues([{ parameterId: 10, value: ${shipped} * 1.2 }])`);
        await waitFor(opened, `window.__debugProject.serialize().edges.flatMap((edge) => edge.parameters ?? []).find((parameter) => parameter.id === 10).value !== ${shipped}`, 'The heat loss was not kept in the model.');
        await evaluate(twin, `document.querySelector('#moreMenu').click()`);
        await waitFor(twin, `Boolean(document.querySelector('.tileMenu'))`, 'The More menu did not open in the stopped room.');
        await evaluate(twin, `[...document.querySelectorAll('.tileMenu button')].find((item) => item.textContent === 'Demonstrations…').click()`);
        assert.equal(await evaluate(twin, `Boolean(document.querySelector('.tileMenu'))`), false, 'The menu closes as the demonstrations open.');
        await setField(twin, '#demoPace', 'Infinity');
        await evaluate(twin, `document.querySelector('[data-demo="drifting"]').click()`);
        await waitFor(opened, `window.__debugProject.serialize().edges.flatMap((edge) => edge.parameters ?? []).find((parameter) => parameter.id === 10).value === ${shipped}`, 'The second take did not start from the model as it ships.', 15000);
        if (driver.takeNativeDialogs) assert.equal(driver.takeNativeDialogs().length, 0, 'The demonstration\'s own change went without a prompt.');
        await waitFor(twin, `!document.querySelector('#room').hidden && (window.__debugTwinWindow.summary()?.moves ?? 0) >= 1`, 'The second take did not go into the room.', 30000);
        await waitFor(twin, `window.__debugTwinWindow.summary()?.running === false`, 'The second take did not play through.', 60000);
        await twin.close();
        await evaluate(opened, `window.confirm = () => true; undefined`);
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own windows; no web-edition equivalent' });

    await run('a house in one click: three rooms, five inputs and the floor slab in the room, and the bedroom with its window open drifting while the others stay in step', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-house-'));
        const projectPath = join(directory, 'rig.kjt');
        await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'dataSources', 'simulatedTankRig.kjt')));
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 3`, 'The rig model did not load.');
        const twin = await openTwinWindow(opened);
        // From the setup's own line under the sources.
        await evaluate(twin, `document.querySelector('#openDemos').click()`);
        await waitFor(twin, `document.querySelector('#demosDialog').open`, 'The demonstrations did not open from the setup.');
        // As fast as it can go: the bedroom drifting while the others stay in step is what is checked, not the minute it takes at 1200×.
        await setField(twin, '#demoPace', 'Infinity');
        await evaluate(twin, `document.querySelector('[data-demo="house"]').click()`);
        await waitFor(opened, `document.querySelector('.documentTitle').textContent === 'smartHouse'`, 'The house\'s model did not open in the project window.', 15000);
        await waitFor(twin, `!document.querySelector('#room').hidden`, 'The house did not go into the control room.', 15000);
        assert.match(await evaluate(twin, `document.querySelector('#healthSource').textContent`), /^smartHouse\.csv, played at full speed$/);
        assert.deepEqual(await evaluate(twin, `[...document.querySelectorAll('#tiles .tile strong')].map((name) => name.textContent)`), ['Living room · Air temperature', 'Bedroom · Air temperature', 'Kitchen · Air temperature']);
        assert.deepEqual(await evaluate(twin, `[...document.querySelectorAll('#inputRows .inputRow strong')].map((name) => name.textContent)`), ['Outdoor temperature', 'Solar gain', 'Living room heater', 'Bedroom heater', 'Kitchen heater']);
        await waitFor(twin, `/Floor slab · Temperature/.test(document.querySelector('#inferredRows').textContent)`, 'The floor slab was not among what the twin infers.', 30000);
        // The bedroom, its window open from 14:00, drifts past the warning; the living room and the kitchen do not.
        await waitFor(twin, `[...document.querySelectorAll('#eventsList li.bad')].some((item) => /Bedroom · Air temperature is drifting past the warning/.test(item.textContent))`, 'The bedroom did not drift past the warning.', 120000);
        // Each room judged on its own, seen at the move the bedroom first drifted (scrubbed back to; at full speed the day is over and its
        // window shut by the time it is looked at): the bedroom's strip red, the others' not.
        const drifted = await evaluate(twin, `(() => {
            const twin = window.__debugTwinWindow.twin();
            const bedroom = twin.tiles.find((tile) => tile.target?.label === 'Bedroom · Air temperature').signal;
            return twin.cycles.findIndex((cycle) => cycle.trends?.[bedroom]?.alarm);
        })()`);
        assert.ok(drifted >= 0, 'A move where the bedroom drifted past the warning.');
        await setField(twin, '#timeScrub', String(drifted), 'input');
        assert.equal(await evaluate(twin, `document.querySelector('#tiles').classList.contains('past')`), true);
        const tileState = (name) => evaluate(twin, `[...document.querySelectorAll('#tiles .tile')].find((tile) => tile.querySelector('strong').textContent === ${JSON.stringify(name)}).className`);
        assert.match(await tileState('Bedroom · Air temperature'), /\bbad\b/);
        assert.doesNotMatch(await tileState('Living room · Air temperature'), /\bbad\b/);
        assert.doesNotMatch(await tileState('Kitchen · Air temperature'), /\bbad\b/);
        assert.equal((await twinEvents(twin)).filter((text) => /^bad: .*drifting past the warning/.test(text)).length, 1, 'Only the bedroom.');
        // Each input in the forecast: held by default, each scored against what then arrived over the day; the outdoor temperature at
        // its average and the living room's heater on Automatic, taken when the twin starts again, kept with the project, drawn dotted
        // past now on their strips and said beside their names.
        await evaluate(twin, `document.querySelector('#engineerToggle').click()`);
        assert.deepEqual(await evaluate(twin, `[...document.querySelectorAll('#inputForecastRows .forecastChoice')].map((choice) => [choice.dataset.input, choice.value])`),
            [['outdoorTemperature', 'hold'], ['solarGain', 'hold'], ['livingRoomHeater', 'hold'], ['bedroomHeater', 'hold'], ['kitchenHeater', 'hold']]);
        const scoreOf = (name) => evaluate(twin, `[...document.querySelectorAll('#inputForecastRows .forecastRow')].find((row) => row.querySelector('.forecastChoice').dataset.input === ${JSON.stringify(name)}).querySelector('.forecastScore').textContent`);
        assert.match(await scoreOf('livingRoomHeater'), /^Over \d+ forecasts, (holding has been closest|.+ would have been [\d.]+× closer than holding)/);
        await setField(twin, '#inputForecastRows .forecastChoice[data-input="outdoorTemperature"]', 'mean');
        await setField(twin, '#inputForecastRows .forecastChoice[data-input="livingRoomHeater"]', 'automatic');
        assert.equal(await evaluate(twin, `document.querySelector('#inputForecastRows .forecastSpan[data-input="outdoorTemperature"][data-key="span"]').hidden`), false, 'An average asks over how long.');
        assert.equal(await evaluate(twin, `document.querySelector('#inputForecastRows .forecastSpan[data-input="outdoorTemperature"][data-key="period"]').hidden`), true);
        // From the model: the states it may follow are the model's, but not those the readings measure.
        await setField(twin, '#inputForecastRows .forecastChoice[data-input="kitchenHeater"]', 'model');
        const followable = await evaluate(twin, `[...document.querySelector('#inputForecastRows .forecastState[data-input="kitchenHeater"]').options].map((option) => option.textContent)`);
        assert.ok(followable.includes('Floor slab · Temperature') && !followable.some((label) => /Air temperature/.test(label)), `The states it may follow: ${followable.join(', ')}.`);
        await setField(twin, '#inputForecastRows .forecastChoice[data-input="kitchenHeater"]', 'hold');
        // From a plan: the sun by the clock (the house's recording is in UTC), written as times and values; one written wrongly is said,
        // and the twin is not started again with it.
        await setField(twin, '#inputForecastRows .forecastChoice[data-input="solarGain"]', 'plan');
        assert.equal(await evaluate(twin, `document.querySelector('#inputForecastRows .forecastPlan[data-input="solarGain"]').hidden`), false);
        await setField(twin, '#inputForecastRows .forecastZone[data-input="solarGain"]', 'UTC');
        await setField(twin, '#inputForecastRows .forecastPlan[data-input="solarGain"]', 'noon 1500');
        assert.match(await evaluate(twin, `document.querySelector('#restartNote').textContent`), /^Solar gain's plan: "noon 1500" is not a time and a value/);
        assert.equal(await evaluate(twin, `document.querySelector('#restartTwin').disabled`), true);
        await setField(twin, '#inputForecastRows .forecastPlan[data-input="solarGain"]', '07:30 0\n12:00 1500\n17:30 0');
        assert.equal(await evaluate(twin, `document.querySelector('#restartTwin').disabled`), false);
        await evaluate(twin, `document.querySelector('#restartTwin').click()`);
        await waitFor(twin, `[...document.querySelectorAll('#eventsList li')].some((item) => /started again with the engineer's settings/.test(item.textContent) && /ahead, Outdoor temperature hold the average, Solar gain from a plan, Living room heater automatic/.test(item.textContent))`, 'The twin was not started again with the inputs\' forecasts.', 30000);
        await waitFor(opened, `JSON.stringify(window.__debugTwin.setup()?.live?.inputs) === JSON.stringify({ outdoorTemperature: { forecast: 'mean' }, solarGain: { forecast: 'plan', plan: { repeat: 'daily', timeZone: 'UTC', points: [{ at: 27000, value: 0 }, { at: 43200, value: 1500 }, { at: 63000, value: 0 }] } }, livingRoomHeater: { forecast: 'automatic' } })`, 'The inputs\' forecasts were not kept with the project.');
        await waitFor(twin, `(window.__debugTwinWindow.summary()?.moves ?? 0) >= 12`, 'The twin did not move on after starting again.', 60000);
        const kindOf = (name) => evaluate(twin, `[...document.querySelectorAll('#inputRows .inputRow')].find((row) => row.querySelector('strong').textContent === ${JSON.stringify(name)}).querySelector('.inputKind').textContent`);
        assert.equal(await kindOf('Outdoor temperature'), 'input · ahead: hold the average');
        assert.match(await kindOf('Living room heater'), /^input · ahead: .+ \(automatic\)$/);
        assert.equal(await kindOf('Solar gain'), 'input · ahead: from a plan');
        assert.equal(await kindOf('Kitchen heater'), 'input');
        assert.ok(await evaluate(twin, `[...document.querySelectorAll('#inputRows .inputRow')].find((row) => row.querySelector('strong').textContent === 'Outdoor temperature').querySelector('.plot').data.some((trace) => trace.name === 'Assumed' && trace.line.dash === 'dot')`), 'What the forecast assumed is drawn dotted past now.');
        await evaluate(twin, `document.querySelector('#engineerToggle').click()`);
        await evaluate(twin, `document.querySelector('#roomStop').click()`);
        await twin.close();
        await evaluate(opened, `window.confirm = () => true; undefined`);
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own windows; no web-edition equivalent' });

    await run('a motor in real time: the demonstration made to be steered runs at a second a second, a move every second, read in seconds', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-motor-'));
        const projectPath = join(directory, 'rig.kjt');
        await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'dataSources', 'simulatedTankRig.kjt')));
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 3`, 'The rig model did not load.');
        const twin = await openTwinWindow(opened);
        await evaluate(twin, `document.querySelector('#openDemos').click()`);
        await waitFor(twin, `document.querySelector('#demosDialog').open`, 'The demonstrations did not open.');
        assert.equal(await evaluate(twin, `document.querySelector('#demoPace').value`), 'own', 'Each demonstration plays at its own pace unless asked otherwise.');
        const startedAt = Date.now();
        await evaluate(twin, `document.querySelector('[data-demo="motor"]').click()`);
        await waitFor(opened, `document.querySelector('.documentTitle').textContent === 'dcMotor'`, 'The motor\'s model did not open in the project window.', 15000);
        // Its twin is set up with the project: the recording's two signals mapped, and timing for a system that answers in a second.
        assert.deepEqual(await evaluate(opened, `(() => { const live = window.__debugTwin.setup().live; return [live.window, live.stride, live.horizon]; })()`), [5, 1, 5]);
        await waitFor(twin, `!document.querySelector('#room').hidden`, 'The motor did not go into the control room.', 15000);
        assert.equal(await evaluate(twin, `document.querySelector('#healthSource').textContent`), 'dcMotor.csv, played at 1×');
        // How it keeps up, in words (the engine's own speed, and the data's, in the tooltip).
        await waitFor(twin, `/^Live · \\d+ moves? · keeping up easily$/.test(document.querySelector('#healthTwin').textContent)`, 'The motor\'s twin did not say how it keeps up.', 20000);
        assert.match(await evaluate(twin, `document.querySelector('#healthTwin').title`), /times faster than real time, and the data arrives at 1×/);
        // While the twin runs, a demonstration is not offered: it starts from the setup.
        await evaluate(twin, `document.querySelector('#moreMenu').click()`);
        await waitFor(twin, `Boolean(document.querySelector('.tileMenu'))`, 'The More menu did not open in the room.');
        assert.equal(await evaluate(twin, `[...document.querySelectorAll('.tileMenu button')].find((item) => item.textContent === 'Demonstrations…').disabled`), true);
        await evaluate(twin, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        // A second a second: the first move once five seconds of readings are in, then one a second.
        await waitFor(twin, `(window.__debugTwinWindow.summary()?.moves ?? 0) >= 4`, 'The motor\'s twin made no moves.', 30000);
        const { last, moves } = await evaluate(twin, `window.__debugTwinWindow.summary()`);
        const elapsed = (Date.now() - startedAt) / 1000;
        assert.ok(last.now <= elapsed + 1, `The recording arrived no faster than real time (${last.now} s of data in ${elapsed.toFixed(1)} s).`);
        assert.equal(last.now - last.anchor, 5, 'A five-second window.');
        assert.ok(Math.abs(last.jumps.motorSpeed.jump) < 0.67, `In step with the motor before its bearing warms (jump ${last.jumps.motorSpeed.jump}).`);
        assert.ok(moves >= 4);
        // Read in seconds, the scale it runs at: the axis, the time followed, and when its first move came.
        assert.equal(await evaluate(twin, `document.querySelector('#timeAxis')._fullLayout.xaxis.title.text`), 'seconds');
        assert.match(await evaluate(twin, `document.querySelector('#timeLabel').textContent`), /^Following now · [\d.]+ s$/);
        assert.ok((await twinEvents(twin)).some((text) => /its first move is made.*at 5 s of data/.test(text)), 'The first move, at five seconds of data.');
        // The current, which nothing measures, inferred; the voltage the input to steer in a sandbox.
        await waitFor(twin, `/Motor · Current/.test(document.querySelector('#inferredRows').textContent)`, 'The motor\'s current was not inferred.');
        assert.deepEqual(await evaluate(twin, `[...document.querySelectorAll('#inputRows .inputRow strong')].map((name) => name.textContent)`), ['Voltage']);
        // A refit on its latest window: the speed read every 50 ms against the model's millisecond step is filled between, not
        // refused as a gap ("motorSpeed has no readings from 0 s to 0 s").
        await evaluate(twin, `document.querySelector('#refitRun').click()`);
        await waitFor(twin, `document.querySelector('#refitRows').children.length > 0 || /could not run/.test(document.querySelector('#refitStatus').textContent)`, 'The motor\'s refit did not finish.', 60000);
        assert.match(await evaluate(twin, `document.querySelector('#refitRows').textContent`), /Bearing friction: [\d.e-]+ → [\d.e-]+/, await evaluate(twin, `document.querySelector('#refitStatus').textContent`));
        await evaluate(twin, `document.querySelector('#trySomething').click()`);
        await waitFor(twin, `!document.querySelector('#sandboxBar').hidden && /Voltage/.test(document.querySelector('#sandboxInputs').textContent)`, 'The sandbox did not offer the voltage to steer.', 15000);
        // Run ahead starts at the twin's own horizon (a minute, for a motor whose forecast is five seconds), and even an hour of it, 3.6
        // million steps at a millisecond, comes back at once, drawn from about two thousand points: keeping and drawing every step froze
        // the app.
        assert.equal(await evaluate(twin, `document.querySelector('#sandboxMinutes').value`), '1');
        // Steered by hand, it follows the controls in real time, the pace its data arrives at.
        assert.equal(await evaluate(twin, `document.querySelector('#sandboxPace').value`), '1');
        assert.match(await evaluate(twin, `document.querySelector('#sandboxStatus').textContent`), /^From \d[^,]* of data\.$/);
        // A key bound to the voltage, then Follow pressed after the live twin has moved on, the voltage still ramping: the copy starts again
        // from the latest move with that move's voltage, and nothing is tried that nobody chose. (The field's old value, read earlier in
        // the ramp, was once carried over and applied.)
        await evaluate(twin, `window.__debugSteering.steering.save({ ...window.__debugSteering.steering.document, bindings: [{ id: 'motorKey', device: { kind: 'keyboard' }, control: { type: 'key', code: 'ArrowUp' }, parameter: { symbol: 'voltage', name: 'Voltage' } }] })`);
        await waitFor(twin, `!document.querySelector('#sandboxFollowControls').hidden`, 'Follow the controls was not offered once a key was bound.');
        const openedAt = await evaluate(twin, `window.__debugTwinWindow.twin().sandbox.startedAt`);
        await waitFor(twin, `window.__debugTwinWindow.twin().cycles.at(-1).now >= ${openedAt} + 2`, 'The motor\'s twin did not move on.', 15000);
        await evaluate(twin, `document.querySelector('#sandboxFollow').click()`);
        await waitFor(twin, `document.querySelector('#sandboxFollow').getAttribute('aria-pressed') === 'true' && window.__debugTwinWindow.twin().sandbox.startedAt > ${openedAt}`, 'Following did not start again from the latest move.');
        const restarted = await evaluate(twin, `(() => { const sandbox = window.__debugTwinWindow.twin().sandbox; return { field: document.querySelector('#sandboxInputs input[data-signal="motorVoltage"]').value, start: sandbox.startInputs.motorVoltage, tried: sandbox.tried.length }; })()`);
        await evaluate(twin, `document.querySelector('#sandboxFollow').click()`);
        await waitFor(twin, `document.querySelector('#sandboxFollow').getAttribute('aria-pressed') === 'false'`, 'Pause did not hold the sandbox.');
        assert.deepEqual(restarted, { field: String(restarted.start), start: restarted.start, tried: 0 }, 'The restarted copy has the latest move\'s voltage, and nothing tried.');
        assert.equal((await evaluate(twin, `window.__debugTwinWindow.twin().sandbox.tried`)).length, 0, 'Nothing tried that nobody chose.');
        await evaluate(twin, `window.__debugSteering.steering.save({ ...window.__debugSteering.steering.document, bindings: [] })`);
        await setField(twin, '#sandboxMinutes', '60', 'input');
        await setField(twin, '#sandboxInputs input[data-signal="motorVoltage"]', '0', 'input');
        const ranAt = Date.now();
        await evaluate(twin, `document.querySelector('#sandboxRun').click()`);
        await waitFor(twin, `/^Ran ahead to /.test(document.querySelector('#sandboxStatus').textContent)`, 'An hour of the motor did not come back.', 60000);
        const tried = await evaluate(twin, `(() => { const trace = document.querySelector('#tiles .tile .plot').data.find((item) => item.name === 'Tried'); return { points: trace.x.length, last: trace.x.at(-1) }; })()`);
        assert.ok(tried.points <= 2100, `What was tried is drawn from ${tried.points} points, not millions.`);
        assert.ok(Date.now() - ranAt < 30000, `An hour of the motor ran ahead in ${((Date.now() - ranAt) / 1000).toFixed(1)} s.`);
        // The voltage tried is on the Voltage strip, dotted, beside the voltage received: the cause of what the speed does.
        const triedVoltage = await evaluate(twin, `(() => { const trace = document.querySelector('#inputRows .inputRow .plot').data.find((item) => item.name === 'Tried'); return trace ? trace.y : null; })()`);
        assert.ok(triedVoltage && triedVoltage.at(-1) === 0, `The voltage tried is drawn on its strip: ${JSON.stringify(triedVoltage)}.`);
        await evaluate(twin, `document.querySelector('#sandboxBack').click()`);
        // Kept as a draft named in the motor's terms: its input's name and unit, and times in seconds.
        await waitFor(twin, `[...document.querySelectorAll('#eventsList li')].some((item) => /kept as a draft scenario/.test(item.textContent))`, 'What was tried was not kept.', 15000);
        const draftEvent = (await twinEvents(twin)).find((text) => /kept as a draft scenario/.test(text));
        assert.match(draftEvent, /"Tried from \d+(\.\d)? s: Voltage 0 V at \d+(\.\d)? s"/);
        // A demonstration's project is not the person's work: what its twin keeps in it as it runs leaves it saved, so another
        // demonstration follows it from the room's More menu with no question asked, and goes into its room.
        const unsaved = await evaluate(opened, `(({ dirty, addonDataUnsaved }) => ({ dirty, addonDataUnsaved }))(window.__debugTour.blockers())`);
        assert.deepEqual(unsaved, { dirty: false, addonDataUnsaved: false }, 'The motor\'s twin running left its demonstration project unchanged.');
        await evaluate(twin, `document.querySelector('#roomStop').click()`);
        driver.takeNativeDialogs?.();
        await evaluate(twin, `document.querySelector('#moreMenu').click()`);
        await waitFor(twin, `Boolean(document.querySelector('.tileMenu'))`, 'The More menu did not open in the stopped room.');
        await evaluate(twin, `[...document.querySelectorAll('.tileMenu button')].find((item) => item.textContent === 'Demonstrations…').click()`);
        await evaluate(twin, `document.querySelector('[data-demo="house"]').click()`);
        await waitFor(opened, `document.querySelector('.documentTitle').textContent === 'smartHouse'`, 'The house did not follow the motor.', 15000);
        assert.deepEqual(driver.takeNativeDialogs?.() ?? [], [], 'No question about unsaved work.');
        await waitFor(twin, `!document.querySelector('#room').hidden && /smartHouse\.csv/.test(document.querySelector('#healthSource').textContent)`, 'The house did not go into its room.', 20000);
        // With its own timing, not the motor's: a project's twin settings are its own, and the house keeps none, so it has the defaults (an
        // hour's window). Given the motor's five seconds and millisecond step, a day of the house at 1200× once fell hopelessly behind,
        // and its catch-ups filled the app's memory.
        await waitFor(twin, `(window.__debugTwinWindow.summary()?.moves ?? 0) >= 1`, 'The house\'s twin made no move.', 30000);
        const houseMove = (await evaluate(twin, `window.__debugTwinWindow.summary()`)).last;
        assert.equal(houseMove.now - houseMove.anchor, 3600, 'The house runs with an hour\'s window, not the motor\'s five seconds.');
        await evaluate(twin, `document.querySelector('#roomStop').click()`);
        await twin.close();
        await evaluate(opened, `window.confirm = () => true; undefined`);
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own windows; no web-edition equivalent' });

    await run('the twin\'s own window: a plant\'s names matched to the model with their units converted, and the control room running', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-twinwindow-'));
        const projectPath = join(directory, 'rig.kjt');
        await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'dataSources', 'simulatedTankRig.kjt')));
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 3`, 'The rig model did not load.');

        // The Live twin button opens the twin's own window, with the model summarised.
        const beforeTwin = driver.allHandles();
        await evaluate(opened, `document.querySelector('#liveTwinButton').click()`);
        const twin = await driver.waitForNewHandle(beforeTwin, { titleIncludes: 'Live twin' }, 15000);
        await waitFor(twin, `/Water temperature/.test(document.querySelector('#modelSummary').textContent)`, 'The twin window did not show the model.');
        assert.match(await evaluate(twin, `document.querySelector('#modelSummary').textContent`), /Heater power/, 'The shared parameter to drive is offered.');

        // A plant's names: the suggestions fill in the mapping, with the units converted.
        await evaluate(twin, `document.querySelector('#openDemos').click()`);
        await waitFor(twin, `document.querySelector('#demosDialog').open`, 'The demonstrations did not open from the setup.');
        // The pace chosen before it starts is the one it plays at.
        await setField(twin, '#demoPace', '1200');
        await evaluate(twin, `document.querySelector('[data-demo="plant"]').click()`);
        await waitFor(twin, `document.querySelector('#fileSpeed').value === '1200'`, 'The chosen pace was not taken for the recording (the plant\'s own is 600×).');
        await waitFor(twin, `document.querySelectorAll('#mappingRows .mappingRow').length === 2`, 'The plant\'s signals were not offered.');
        const row = (name) => `document.querySelector('#mappingRows .mappingRow[data-signal="${name}"]')`;
        assert.equal(await evaluate(twin, `${row('TK1_TT101_PV')}.querySelector('[data-field="role"]').value`), 'output');
        assert.match(await evaluate(twin, `${row('TK1_TT101_PV')}.querySelector('[data-field="target"]').selectedOptions[0].textContent`), /Water tank · Water temperature/);
        assert.match(await evaluate(twin, `${row('TK1_TT101_PV')}.querySelector('.conversion').textContent`), /°C → K/);
        assert.equal(await evaluate(twin, `${row('TK1_JI101_PV')}.querySelector('[data-field="role"]').value`), 'input');
        assert.match(await evaluate(twin, `${row('TK1_JI101_PV')}.querySelector('[data-field="target"]').selectedOptions[0].textContent`), /Heater power/);
        assert.match(await evaluate(twin, `${row('TK1_JI101_PV')}.querySelector('.why').textContent`), /kW converts to W/);
        assert.equal(await evaluate(twin, `document.querySelector('#openRoom').disabled`), false);

        // The control room: a tile for the measured signal, the twin moving, and the setup kept with the project.
        await evaluate(twin, `document.querySelector('#openRoom').click()`);
        await waitFor(twin, `!document.querySelector('#room').hidden && document.querySelectorAll('#tiles .tile').length === 1`, 'The control room did not open with a tile.');
        await waitFor(twin, `/^Live · \\d+ move/.test(document.querySelector('#healthTwin').textContent)`, 'The twin did not move.', 60000);
        await waitFor(twin, `Boolean(document.querySelector('#tiles .tile .plot .main-svg'))`, 'The tile was not drawn.', 15000);
        // The plant's °C readings reach the twin in kelvin, as the model keeps them, and are shown in °C again: the same reading.
        const celsius = Number((await evaluate(twin, `document.querySelector('#tiles .tile .value').textContent`)).replace(/ °C$/, ''));
        await evaluate(twin, `document.querySelector('#temperatureUnit').click()`);
        const kelvin = Number((await evaluate(twin, `document.querySelector('#tiles .tile .value').textContent`)).replace(/ K$/, ''));
        assert.ok(Number.isFinite(celsius) && Math.abs(kelvin - celsius - 273.15) < 0.05, `The same reading in both: ${celsius} °C and ${kelvin} K.`);
        await evaluate(twin, `document.querySelector('#temperatureUnit').click()`);
        const kept = await evaluate(opened, `window.__debugTwin.setup()`);
        assert.equal(kept.source.kind, 'file');
        assert.deepEqual(kept.mapping.find((entry) => entry.source === 'TK1_TT101_PV').conversion, { scale: 1, offset: 273.15 });
        assert.equal(await evaluate(opened, `document.querySelector('#saveButton')?.disabled ?? false`), false, 'The project has a change to save.');
        await evaluate(twin, `document.querySelector('#roomStop').click()`);
        await waitFor(twin, `/Stopped after|whole log/.test(document.querySelector('#healthTwin').textContent)`, 'The twin did not stop.', 15000);
        await twin.close();
        await evaluate(opened, `window.confirm = () => true; undefined`);
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own windows; no web-edition equivalent' });

    await run('the control room\'s engineer: a parameter set and kept, a refit, a model change applied, the warning, a sandbox, the layout, time scrubbed back, and the estimator tracking the heat loss', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-engineer-'));
        const projectPath = join(directory, 'rig.kjt');
        await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'dataSources', 'simulatedTankRig.kjt')));
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 3`, 'The rig model did not load.');
        const beforeTwin = driver.allHandles();
        await evaluate(opened, `document.querySelector('#liveTwinButton').click()`);
        const twin = await driver.waitForNewHandle(beforeTwin, { titleIncludes: 'Live twin' }, 15000);
        await waitFor(twin, `/Water temperature/.test(document.querySelector('#modelSummary').textContent)`, 'The twin window did not show the model.');
        // The drifting rig's recording, handed over as a file would be (the demonstration button goes into the room at 600× at once).
        const drifting = await readFile(join(process.cwd(), 'examples', 'dataSources', 'simulatedTankRigDrifting.csv'), 'utf8');
        await evaluate(twin, `window.__debugTwinWindow.offerLog(${JSON.stringify(drifting)}, 'simulatedTankRigDrifting.csv')`);
        await waitFor(twin, `document.querySelectorAll('#mappingRows .mappingRow.confident').length === 2`, 'The rig\'s readings were not matched.');
        // Slow enough to work in the room while the recording plays (six hours in 36 seconds), quick enough to make its first move in six.
        await evaluate(twin, `window.__debugTwinWindow.setSpeed(600)`);
        await evaluate(twin, `document.querySelector('#openRoom').click()`);
        await waitFor(twin, `window.__debugTwinWindow.twin()?.cycles.length >= 2`, 'The twin made no moves.', 60000);
        const heatLossOf = async () => evaluate(opened, `window.__debugProject.serialize().edges.flatMap((edge) => edge.parameters ?? []).find((parameter) => parameter.id === 10).value`);
        const events = () => evaluate(twin, `[...document.querySelectorAll('#eventsList li')].map((item) => item.className + ': ' + item.innerText.replace(/\\s+/g, ' '))`);

        // The engineer's view: the heat loss set, applied to the twin and kept in the model.
        assert.equal(await evaluate(twin, `document.querySelector('#engineer').hidden`), true, 'The operator\'s view by default.');
        await evaluate(twin, `document.querySelector('#engineerToggle').click()`);
        assert.match(await evaluate(twin, `document.querySelector('#tunableRows').textContent`), /Heat loss coefficient/);
        await evaluate(twin, `(() => { const field = document.querySelector('#tunableRows [data-parameter-id="10"] input[type="number"]'); field.value = '24'; field.dispatchEvent(new Event('change')); })()`);
        await waitFor(twin, `[...document.querySelectorAll('#eventsList li')].some((item) => /Heat loss coefficient set from 20 to 24/.test(item.textContent) && /kept in the model too/.test(item.textContent))`, 'The heat loss was not set and kept.');
        assert.equal(await heatLossOf(), 24, 'The model keeps it.');
        await new Promise((resolve) => setTimeout(resolve, 900));
        assert.equal(await evaluate(twin, `document.querySelector('#modelBanner').hidden`), true, 'A value kept from here is not offered back as a change.');

        // A refit on the latest window, applied and kept.
        await evaluate(twin, `document.querySelector('#refitRun').click()`);
        await waitFor(twin, `!document.querySelector('#refitKeep').hidden`, 'The refit did not finish.', 60000);
        assert.match(await evaluate(twin, `document.querySelector('#refitRows').textContent`), /Heat loss coefficient: 24 → /);
        await evaluate(twin, `document.querySelector('#refitKeep').click()`);
        await waitFor(twin, `[...document.querySelectorAll('#eventsList li')].some((item) => /A refit was applied to the twin/.test(item.textContent))`, 'The refit was not applied.');
        const refitted = await heatLossOf();
        assert.ok(refitted !== 24, `The refit's heat loss is kept in the model: ${refitted}.`);

        // A change made in the project window: offered, and applied from the latest move.
        await evaluate(opened, `(() => { const model = window.__debugProject.serialize(); model.edges.flatMap((edge) => edge.parameters ?? []).find((parameter) => parameter.id === 10).value = 30; return window.__debugProject.load(model, 'rig.kjt'); })()`);
        await waitFor(twin, `!document.querySelector('#modelBanner').hidden`, 'The model\'s change was not offered.');
        assert.match(await evaluate(twin, `document.querySelector('#modelBannerText').textContent`), /Heat loss coefficient .* → 30 W\/K/);
        await evaluate(twin, `document.querySelector('#modelApply').click()`);
        await waitFor(twin, `[...document.querySelectorAll('#eventsList li')].some((item) => /The model's change was applied to the twin/.test(item.textContent))`, 'The model\'s change was not applied.');
        assert.equal(await evaluate(twin, `document.querySelector('#modelBanner').hidden`), true);

        // The warning, taken at once.
        await evaluate(twin, `(() => { const field = document.querySelector('#alertAmount'); field.value = '0.05'; field.dispatchEvent(new Event('change')); })()`);
        await waitFor(twin, `[...document.querySelectorAll('#eventsList li')].some((item) => /The warning set to 0.05 °C a move/.test(item.textContent))`, 'The warning was not set.');

        // Trying something: the heater off for an hour, drawn dotted, and kept as a draft scenario.
        await evaluate(twin, `document.querySelector('#trySomething').click()`);
        await waitFor(twin, `!document.querySelector('#sandboxBar').hidden && document.querySelector('#sandboxInputs input') !== null`, 'The sandbox did not open.');
        await evaluate(twin, `(() => { const field = document.querySelector('#sandboxInputs input'); field.value = '0'; })()`);
        await evaluate(twin, `document.querySelector('#sandboxRun').click()`);
        await waitFor(twin, `/Ran ahead to .* with Heater power 0 W/.test(document.querySelector('#sandboxStatus').textContent)`, 'The sandbox did not run ahead.', 30000);
        assert.equal(await evaluate(twin, `document.querySelector('#tiles .tile .plot').data.some((trace) => trace.name === 'Tried')`), true, 'What was tried is drawn on the tile.');
        await evaluate(twin, `document.querySelector('#sandboxBack').click()`);
        await waitFor(twin, `[...document.querySelectorAll('#eventsList li')].some((item) => /kept as a draft scenario/.test(item.textContent)) && document.querySelector('#scenariosToggle').textContent === 'Scenarios (1)'`, 'What was tried was not kept.');

        // The layout, from a strip's options menu: the strip drawn taller, then pinned, kept with the project; the menu says what is on.
        const tileMenu = async () => {
            await evaluate(twin, `document.querySelector('#tiles .tile .tileMenuButton').click()`);
            await waitFor(twin, `Boolean(document.querySelector('.tileMenu')) && document.querySelector('#tiles .tile .tileMenuButton').getAttribute('aria-expanded') === 'true'`, 'The tile\'s options did not open.');
        };
        const choose = (label) => evaluate(twin, `[...document.querySelectorAll('.tileMenu button')].find((item) => item.textContent === ${JSON.stringify(label)}).click()`);
        const checked = (label) => evaluate(twin, `[...document.querySelectorAll('.tileMenu button')].find((item) => item.textContent === ${JSON.stringify(label)}).getAttribute('aria-checked')`);
        await tileMenu();
        assert.equal(await checked('Taller'), 'false');
        await choose('Taller');
        assert.equal(await evaluate(twin, `Boolean(document.querySelector('.tileMenu'))`), false, 'Choosing closes the menu.');
        assert.equal(await evaluate(twin, `document.querySelector('#tiles .tile').classList.contains('tall')`), true);
        await waitFor(opened, `JSON.stringify(window.__debugTwin.setup().layout?.tall) === '["tankTemperature"]'`, 'The layout was not kept with the project.');
        await tileMenu();
        assert.equal(await checked('Taller'), 'true');
        await choose('Pin to the top');
        assert.equal(await evaluate(twin, `Boolean(document.querySelector('#tiles .tile .pinMark'))`), true, 'A pinned tile is marked.');
        await waitFor(opened, `JSON.stringify(window.__debugTwin.setup().layout?.pinned) === '["tankTemperature"]'`, 'The pin was not kept with the project.');
        // Escape closes the menu without choosing.
        await tileMenu();
        await evaluate(twin, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        assert.equal(await evaluate(twin, `Boolean(document.querySelector('.tileMenu'))`), false);

        // The line through the column at the pointer: every strip and input says its value at that time, and the latest again after.
        const latest = await evaluate(twin, `document.querySelector('#tiles .tile .value').textContent`);
        await evaluate(twin, `(() => { const plot = document.querySelector('#tiles .tile .plot'); const box = plot.getBoundingClientRect(); plot.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.left + 64 + 4, clientY: box.top + box.height / 2 })); })()`);
        assert.equal(await evaluate(twin, `document.querySelector('#trendCursor').hidden`), false, 'Pointing at a time marks it through the column.');
        assert.match(await evaluate(twin, `document.querySelector('#trendCursorTime').textContent`), /^at [\d.]+ (?:s|min|h) of data$/);
        assert.notEqual(await evaluate(twin, `document.querySelector('#tiles .tile .value').textContent`), latest, 'The strip says its value at the time pointed at (the start of the span, cooler than now).');
        assert.match(await evaluate(twin, `document.querySelector('#inputRows .inputRow .latest').textContent`), /W$/);
        await evaluate(twin, `document.querySelector('#trendColumn').dispatchEvent(new PointerEvent('pointerleave'))`);
        assert.equal(await evaluate(twin, `document.querySelector('#trendCursor').hidden`), true);
        assert.equal(await evaluate(twin, `document.querySelector('#tiles .tile .value').textContent`), latest, 'The latest value comes back.');

        // How much of the past the plots show: by default four times the twin's window, not the whole log; a fixed span; everything.
        // The time is read on the column's own axis, at its foot, which every strip shares.
        const axis = () => evaluate(twin, `(() => { const plot = document.querySelector('#timeAxis'); return { range: plot._fullLayout.xaxis.range, title: plot._fullLayout.xaxis.title.text, strip: document.querySelector('#tiles .tile .plot')._fullLayout.xaxis.range }; })()`);
        const last = (await evaluate(twin, `window.__debugTwinWindow.summary()`)).last;
        const unitOf = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
        let shown = await axis();
        assert.deepEqual(shown.strip, shown.range, 'Each strip spans the time the axis shows.');
        assert.ok(Math.abs(shown.range[0] * unitOf[shown.title] - Math.max(0, last.now - 4 * (last.now - last.anchor))) < 1, `Recent starts four windows back (got ${JSON.stringify(shown)}).`);
        await setField(twin, '#timeSpan', '3600');
        shown = await axis();
        // In hours, as the room's words give a time past an hour of data ("Following now · 2.5 h", the events), so the two agree.
        assert.equal(shown.title, 'hours', 'An hour and its forecast, hours into the data, are read in hours.');
        assert.ok(Math.abs(shown.range[0] - (last.now - 3600) / 3600) < 0.001, `The last hour is shown (got ${JSON.stringify(shown)}).`);
        await waitFor(opened, `window.__debugTwin.setup().layout?.span === 3600`, 'The span was not kept with the project.');
        await setField(twin, '#timeSpan', 'all');
        shown = await axis();
        assert.ok(Math.abs(shown.range[0]) < 1e-9, 'Everything starts at the first reading.');
        await setField(twin, '#timeSpan', 'recent');
        await waitFor(opened, `window.__debugTwin.setup().layout?.span === undefined`, 'Recent, the default, is not kept as a choice.');

        // Time scrubbed back to the first move, and following again.
        await evaluate(twin, `(() => { const scrub = document.querySelector('#timeScrub'); scrub.value = '0'; scrub.dispatchEvent(new Event('input')); })()`);
        assert.match(await evaluate(twin, `document.querySelector('#timeLabel').textContent`), /^at 1 h of data · \d+ moves? ago$/);
        assert.equal(await evaluate(twin, `document.querySelector('#tiles').classList.contains('past')`), true);
        await evaluate(twin, `document.querySelector('#timeFollow').click()`);
        assert.match(await evaluate(twin, `document.querySelector('#timeLabel').textContent`), /^Following now/);

        // The estimator, tracking the heat loss: started again with the engineer's settings, and the heat loss found rising.
        await evaluate(twin, `(() => { const choice = document.querySelector('#correctionRows select'); choice.value = 'estimate'; choice.dispatchEvent(new Event('change')); })()`);
        assert.equal(await evaluate(twin, `document.querySelector('#trackBlock').hidden`), false, 'The tunable parameters are offered to track.');
        assert.equal(await evaluate(twin, `document.querySelector('#trackRows input[data-parameter-id="10"]').checked`), true);
        // Started again as fast as it can go: what the estimator finds is checked, not the minute the log takes at 300×.
        await evaluate(twin, `window.__debugTwinWindow.setSpeed('Infinity')`);
        await evaluate(twin, `document.querySelector('#restartTwin').click()`);
        await waitFor(twin, `[...document.querySelectorAll('#eventsList li')].some((item) => /started again with the engineer's settings/.test(item.textContent) && /estimating Water tank · Water temperature/.test(item.textContent))`, 'The twin was not started again.', 30000);
        await waitFor(twin, `/The whole log has been played/.test(document.querySelector('#healthTwin').textContent)`, 'The tracking twin did not play the recording.', 240000);
        const tracked = await evaluate(twin, `[...document.querySelectorAll('#inferredRows .inferredRow')].map((row) => row.innerText.replace(/\\s+/g, ' ')).find((text) => /Heat loss coefficient/.test(text))`);
        assert.match(tracked ?? '', /a parameter, tracked .*±.* rising/, `The heat loss is tracked, rising: ${tracked}`);
        assert.ok((await events()).length > 10, 'The events from before the restart stay.');
        await waitFor(opened, `(window.__debugTwin.setup().record?.events.length ?? 0) > 10 && window.__debugTwin.setup().live.corrections.tankTemperature.estimate === true`, 'The record and the settings were not kept with the project.');
        await twin.close();
        // Where the room was, kept with the project for the next time it opens (on a second screen, say).
        await waitFor(opened, `window.__debugTwin.setup().layout?.bounds?.width >= 900 && JSON.stringify(window.__debugTwin.setup().layout.tall) === '["tankTemperature"]'`, 'The room\'s place was not kept with the project.');
        await evaluate(opened, `window.confirm = () => true; undefined`);
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own windows; no web-edition equivalent' });

    await run('the twin\'s sandbox follows a MIDI fader bound to the heater, and what was tried is kept as a draft scenario', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-steered-twin-'));
        const projectPath = join(directory, 'rig.kjt');
        await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'dataSources', 'simulatedTankRig.kjt')));
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 3`, 'The rig model did not load.');
        const beforeTwin = driver.allHandles();
        await evaluate(opened, `document.querySelector('#liveTwinButton').click()`);
        const twin = await driver.waitForNewHandle(beforeTwin, { titleIncludes: 'Live twin' }, 15000);
        await waitFor(twin, `/Water temperature/.test(document.querySelector('#modelSummary').textContent)`, 'The twin window did not show the model.');
        await evaluate(twin, `window.__debugSteering.steering.save({ bindings: [] })`);
        const recording = await readFile(join(process.cwd(), 'examples', 'dataSources', 'simulatedTankRigDrifting.csv'), 'utf8');
        await evaluate(twin, `window.__debugTwinWindow.offerLog(${JSON.stringify(recording)}, 'simulatedTankRigDrifting.csv')`);
        await waitFor(twin, `document.querySelectorAll('#mappingRows .mappingRow.confident').length === 2`, 'The rig\'s readings were not matched.');
        await evaluate(twin, `window.__debugTwinWindow.setSpeed(1200)`);
        await evaluate(twin, `document.querySelector('#openRoom').click()`);
        await waitFor(twin, `window.__debugTwinWindow.twin()?.cycles.length >= 2`, 'The twin made no moves.', 60000);

        // The sandbox: the heater's input has a Bind… button; Follow the controls waits until something is bound.
        await evaluate(twin, `document.querySelector('#trySomething').click()`);
        await waitFor(twin, `!document.querySelector('#sandboxBar').hidden && Boolean(document.querySelector('#sandboxInputs [data-bind]'))`, 'The sandbox has no Bind… button.');
        assert.equal(await evaluate(twin, `document.querySelector('#sandboxFollowControls').hidden`), true, 'Follow the controls is offered with nothing bound.');

        // A fader on a MIDI controller, turned once to bind it.
        const fader = (value) => evaluate(twin, `window.__debugSteering.devices.midi('Faders', [0xB0, 7, ${value}])`);
        await evaluate(twin, `window.__debugSteering.devices.connectMidi('Faders')`);
        await evaluate(twin, `document.querySelector('#sandboxInputs [data-bind]').click()`);
        await fader(0);
        await fader(20);
        await waitFor(twin, `document.querySelector('#sandboxInputs .inputBindingChip')?.textContent === '🎛 Control 7'`, 'The fader was not bound.');
        await waitFor(twin, `!document.querySelector('#sandboxFollowControls').hidden`, 'Follow the controls was not offered once the fader was bound.');
        const [kept] = (await evaluate(twin, `window.__debugSteering.steering.document`)).bindings;
        assert.deepEqual([kept.device.kind, kept.control, kept.parameter.symbol], ['midi', { type: 'cc', channel: 1, number: 7 }, 'heaterPower']);
        // The same binding reaches the project window, which keeps it for every model with a heater power.
        await waitFor(opened, `window.__debugSteering.steering.document.bindings.length === 1`, 'The project window was not told of the binding.');

        // Followed: the fader moves the field, and the sandbox runs ahead on its own, trying what the fader says.
        await evaluate(twin, `document.querySelector('#sandboxPace').value = '3600'`);
        // The live twin has moved on since Try something was opened: following starts the copy again from its latest move, so what is
        // steered is drawn at the right-hand edge, not behind the live data.
        const openedFrom = await evaluate(twin, `window.__debugTwinWindow.twin().sandbox.startedAt`);
        await waitFor(twin, `window.__debugTwinWindow.twin().cycles.at(-1).now > ${openedFrom}`, 'The live twin did not move on.', 30000);
        const liveAt = await evaluate(twin, `window.__debugTwinWindow.twin().cycles.at(-1).now`);
        await evaluate(twin, `document.querySelector('#sandboxFollow').click()`);
        await waitFor(twin, `document.querySelector('#sandboxFollow').getAttribute('aria-pressed') === 'true' && document.querySelector('#sandboxRun').disabled`, 'Following did not start.');
        assert.ok(await evaluate(twin, `window.__debugTwinWindow.twin().sandbox.startedAt`) >= liveAt, 'Following started from the live twin\'s latest move.');
        for (const value of [0, 0, 64, 127]) {
            await fader(value);
            await new Promise((resolve) => setTimeout(resolve, 700));
        }
        assert.equal(await evaluate(twin, `document.querySelector('#sandboxInputs input[data-signal="heaterPower"]').value`), '2000', 'The field does not follow the fader.');
        await waitFor(twin, `/^Following the controls: .* changes? tried/.test(document.querySelector('#sandboxStatus').textContent)`, 'The sandbox did not run ahead following the fader.', 30000);
        await waitFor(twin, `document.querySelector('#tiles .tile .plot').data.some((trace) => trace.name === 'Tried')`, 'The sandbox\'s course was not drawn.', 15000);

        // Paused, then back to live: what was tried, as the fader set it, is kept as a draft scenario.
        await evaluate(twin, `document.querySelector('#sandboxFollow').click()`);
        await waitFor(twin, `document.querySelector('#sandboxFollow').getAttribute('aria-pressed') === 'false' && !document.querySelector('#sandboxRun').disabled`, 'Pause did not hold the sandbox.');
        await evaluate(twin, `document.querySelector('#sandboxBack').click()`);
        await waitFor(twin, `[...document.querySelectorAll('#eventsList li')].some((item) => /kept as a draft scenario/.test(item.textContent))`, 'What was tried was not kept.', 15000);
        const scenarios = await evaluate(opened, `window.__debugParameterTuning.scenarios()`);
        const tried = scenarios.at(-1)?.tried ?? [];
        assert.ok(tried.length >= 2 && tried.every((step) => step.signal === 'heaterPower'), `What was tried: ${JSON.stringify(tried)}.`);
        assert.equal(tried.at(-1).value, 2000, 'The last value tried is where the fader came to rest.');

        await evaluate(twin, `window.__debugSteering.steering.save({ bindings: [] })`);
        await twin.close();
        await evaluate(opened, `window.confirm = () => true; undefined`);
        await closeWhenValidated(opened);
        await rm(directory, { recursive: true, force: true });
    }, { skip: !driver.capabilities.multiWindow && 'opens its own windows; no web-edition equivalent' });

    await run('a live twin follows an MQTT broker: listening finds the topics, and what arrives is recorded', async () => {
        // A broker in this process, and a gateway publishing the tank's readings as a lab's would: one topic each, JSON with the
        // reading's own time, a minute of the tank every 20 ms, for as long as the test needs.
        const broker = await Aedes.createBroker();
        const server = createServer(broker.handle);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = `mqtt://127.0.0.1:${server.address().port}`;
        const gateway = await mqtt.connectAsync(url);
        const epoch = Date.parse('2026-11-06T09:00:00Z') / 1000;
        const capacitance = 209000, heatLoss = 20, ambient = 293.15;
        let minute = 0;
        let temperature = ambient;
        const publishing = setInterval(() => {
            const time = minute * 60;
            if (minute > 0) {
                const settled = ambient + 1000 / heatLoss;
                temperature = settled + (temperature - settled) * Math.exp(-heatLoss * 60 / capacitance);
            }
            if (minute % 30 === 0) gateway.publish('lab/rig/heater/power', JSON.stringify({ value: 1000, time: epoch + time }));
            gateway.publish('lab/rig/tank/temperature', JSON.stringify({ value: temperature, time: epoch + time }));
            minute += 1;
        }, 20);
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-mqtt-'));
        try {
            // The model copied somewhere of its own, so the recording beside it lands there.
            const projectPath = join(directory, 'rig.kjt');
            await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'dataSources', 'simulatedTankRig.kjt')));
            const before = driver.allHandles();
            await driver.simulateOsFileOpen(projectPath);
            const opened = await driver.waitForNewHandle(before);
            await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 3`, 'The rig model did not load.');
            await evaluate(opened, `document.querySelector('#parameterTuningButton').click()`);
            await waitFor(opened, `!document.querySelector('#parameterTuning').classList.contains('hidden')`, 'The tuning card did not open.');

            const twin = await openTwinWindow(opened);
            await evaluate(twin, `document.querySelector('[data-source="mqtt"]').click()`);
            await setField(twin, '#mqttUrl', url);
            await evaluate(twin, `document.querySelector('#mqttListen').click()`);
            await waitFor(twin, `/^Heard 2 topics/.test(document.querySelector('#sourceStatus').textContent)`, 'Listening did not find the two topics.', 15000);
            // The topics' words are matched to the rig's model: the heater's power to the shared parameter, the tank's temperature to its state.
            await evaluate(twin, `document.querySelector('#useAllSuggestions:not([hidden])')?.click()`);
            await waitFor(twin, `document.querySelector('#mappingCount').textContent === '2 of 2 signals mapped: 1 measured, 1 input.'`, 'The topics were not matched to the model.');
            assert.match(await evaluate(twin, `document.querySelector('#mappingRows .mappingRow[data-signal="lab/rig/tank/temperature"] select[data-field="target"]').selectedOptions[0].textContent`), /Water temperature/);
            await evaluate(twin, `document.querySelector('#openRoom').click()`);
            await waitFor(twin, `(window.__debugTwinWindow.summary()?.moves ?? 0) >= 3`, 'The live twin made no moves from the broker.', 30000);
            // A broker says nothing of how often its readings come: with no timing kept, the twin chose it from the first few readings.
            assert.ok((await twinEvents(twin)).some((text) => /timing follows the readings.*The readings come every/.test(text)), 'The twin did not say the timing it chose from the readings.');
            await evaluate(twin, `document.querySelector('#roomStop').click()`);
            await waitFor(twin, `Boolean(window.__debugTwinWindow.summary()?.recordedTo)`, 'Stopping did not say where the readings were recorded.', 15000);
            const recordedTo = (await evaluate(twin, `window.__debugTwinWindow.summary()`)).recordedTo;
            assert.ok(recordedTo.startsWith(join(directory, 'recordings')), `The recording is beside the project: ${recordedTo}.`);
            const recorded = readDataLog(await readFile(recordedTo, 'utf8'));
            assert.equal(recorded.header.signals.length, 2);
            assert.ok(recorded.observations.length >= 61, `The recording holds at least the hour of readings the first move needed: ${recorded.observations.length}.`);
            // The recording opens again in one click, as the twin's log, from MQTT's broker.
            await evaluate(twin, `[...document.querySelectorAll('#eventsList button')].find((button) => button.textContent === 'Replay this recording').click()`);
            await waitFor(twin, `!document.querySelector('#setup').hidden && /signals in .*\\.csv, \\d+ readings, from MQTT /.test(document.querySelector('#sourceStatus').textContent)`, 'The recording did not open as the twin\'s log.', 15000);
            await waitFor(twin, `!document.querySelector('#openRoom').disabled`, 'The recording\'s signals were not matched again.');
            await twin.close();
            await evaluate(opened, `window.confirm = () => true; undefined`);
            await closeWhenValidated(opened);
        } finally {
            clearInterval(publishing);
            await gateway.endAsync();
            await new Promise((resolve) => server.close(resolve));
            broker.close();
        }
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    await run('the push service: started in Settings, a key made, a live twin following what a script sends, and stopped with the twin attached', async () => {
        // A free port for the service (and the one after it for gRPC), found the way any program finds one.
        const port = await new Promise((resolve) => {
            const probe = createServer();
            probe.listen(0, '127.0.0.1', () => { const { port: found } = probe.address(); probe.close(() => resolve(found)); });
        });
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-push-'));
        let sending = null;
        try {
            const projectPath = join(directory, 'rig.kjt');
            await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'dataSources', 'simulatedTankRig.kjt')));
            const before = driver.allHandles();
            await driver.simulateOsFileOpen(projectPath);
            const opened = await driver.waitForNewHandle(before);
            await waitFor(opened, `document.querySelectorAll('.node-label-container').length === 3`, 'The rig model did not load.');
            const set = (selector, value) => evaluate(opened, `(() => { const field = document.querySelector('${selector}'); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); })()`);

            // Settings › Push service: started on the chosen port, gRPC on the next, the chip saying so.
            assert.equal(await evaluate(opened, `document.querySelector('#connectionsButton')`), null, 'The push service has no titlebar button of its own: it is a page of Settings.');
            await evaluate(opened, `document.querySelector('#settingsButton').click()`);
            await waitFor(opened, `document.querySelector('#settingsDialog').open`, 'Settings did not open.');
            await evaluate(opened, `document.querySelector('[data-settings-target="pushService"]').click()`);
            await waitFor(opened, `!document.querySelector('[data-settings-page="pushService"]').hidden && /^Not listening/.test(document.querySelector('#pushServiceState').textContent)`, 'Settings › Push service did not open.');
            assert.match(await evaluate(opened, `document.querySelector('#pushServiceState').textContent`), /^Not listening/);
            assert.match(await evaluate(opened, `document.querySelector('#pushExamples details[open] code').textContent`), /urllib\.request/, 'The first example is plain Python sending JSON.');
            await set('#pushServicePort', String(port));
            assert.equal(await evaluate(opened, `document.querySelector('#pushServiceGrpcPort').textContent`), `gRPC on ${port + 1}`);
            await evaluate(opened, `document.querySelector('#pushServiceToggle').click()`);
            await waitFor(opened, `document.querySelector('#pushServiceState').textContent.startsWith('Listening on 127.0.0.1:${port} ')`, 'The push service did not start.', 15000);
            await waitFor(opened, `!document.querySelector('#pushServiceChip').hidden`, 'The chip did not say the service is listening.');
            assert.equal(await evaluate(opened, `document.querySelector('#pushServiceChipText').textContent`), `Listening on 127.0.0.1:${port}, 0 clients`);

            // A key, shown once, which the examples then use.
            await set('#pushKeyName', 'simulated rig');
            await set('#pushKeySignals', 'heaterPower, tankTemperature');
            await evaluate(opened, `document.querySelector('#pushKeyAdd').click()`);
            await waitFor(opened, `!document.querySelector('#pushKeyMade').hidden`, 'The key was not shown.');
            const key = await evaluate(opened, `document.querySelector('#pushKeyMadeValue').textContent`);
            assert.match(key, /^kjp_/);
            assert.match(await evaluate(opened, `document.querySelector('#pushExamples details[open] code').textContent`), new RegExp(key));
            assert.equal(await evaluate(opened, `document.querySelector('#pushKeys .connectionsKey[data-key="simulated rig"] small').textContent`), 'heaterPower, tankTemperature');
            await evaluate(opened, `document.querySelector('#settingsClose').click()`);
            await waitFor(opened, `document.querySelector('#pushKeyMade').hidden && !document.querySelector('#settingsDialog').open`, 'Closing Settings did not put the key away.');

            // A script sending the tank's readings as JSON, a minute of the tank every 20 ms.
            const epoch = Date.parse('2026-11-06T09:00:00Z') / 1000;
            const capacitance = 209000, heatLoss = 20, ambient = 293.15;
            let minute = 0;
            let temperature = ambient;
            let refused = null;
            sending = setInterval(() => {
                const time = minute * 60;
                if (minute > 0) {
                    const settled = ambient + 1000 / heatLoss;
                    temperature = settled + (temperature - settled) * Math.exp(-heatLoss * 60 / capacitance);
                }
                const readings = [{ signal: 'tankTemperature', value: temperature, time: epoch + time }, ...(minute % 30 === 0 ? [{ signal: 'heaterPower', value: 1000, time: epoch + time }] : [])];
                minute += 1;
                fetch(`http://127.0.0.1:${port}/v1/readings`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ readings }) })
                    .then((response) => response.json()).then((answer) => { if (answer.status !== 202 && answer.status !== 503) refused ??= answer; }).catch(() => {});
            }, 20);

            // The twin's window: the signals the key may send, matched and followed.
            const twin = await openTwinWindow(opened);
            await evaluate(twin, `document.querySelector('[data-source="push"]').click()`);
            await waitFor(twin, `/^The push service is listening/.test(document.querySelector('#pushState').textContent)`, 'The twin window did not say the service is listening.');
            await evaluate(twin, `document.querySelector('#pushRefresh').click()`);
            await waitFor(twin, `document.querySelector('#mappingCount').textContent === '2 of 2 signals mapped: 1 measured, 1 input.'`, 'The signals the key may send were not matched.');
            await evaluate(twin, `document.querySelector('#openRoom').click()`);
            await waitFor(twin, `(window.__debugTwinWindow.summary()?.moves ?? 0) >= 3`, 'The live twin made no moves from the pushed readings.', 30000);
            assert.equal(refused, null, `A reading was refused: ${refused?.reason}`);
            await waitFor(opened, `/, 1 client/.test(document.querySelector('#pushServiceChipText').textContent)`, 'The chip did not count the script.', 5000);

            // The twin window's link to the push service opens its page of Settings, in the project window.
            await evaluate(twin, `document.querySelector('#pushConnections').click()`);
            await waitFor(opened, `document.querySelector('#settingsDialog').open && !document.querySelector('[data-settings-page="pushService"]').hidden`, 'The twin window did not open Settings › Push service.');
            await evaluate(opened, `document.querySelector('#settingsClose').click()`);
            await waitFor(opened, `!document.querySelector('#settingsDialog').open`, 'Settings did not close.');

            // Stopping with the twin attached asks first, and the twin says why it stopped and where the readings are.
            await evaluate(opened, `(() => { window.__confirmed = []; window.confirm = (message) => { window.__confirmed.push(message); return true; }; })()`);
            await evaluate(opened, `document.querySelector('#pushServiceChip').click()`);
            await waitFor(opened, `document.querySelector('#settingsDialog').open && !document.querySelector('[data-settings-page="pushService"]').hidden`, 'The chip did not open Settings › Push service.');
            await evaluate(opened, `document.querySelector('#pushServiceToggle').click()`);
            await waitFor(opened, `document.querySelector('#pushServiceState').textContent.startsWith('Not listening')`, 'The push service did not stop.', 15000);
            assert.match(await evaluate(opened, `window.__confirmed[0] ?? ''`), /^1 live twin is following/);
            await evaluate(opened, `document.querySelector('#settingsClose').click()`);
            await waitFor(twin, `Boolean(window.__debugTwinWindow.summary()?.recordedTo)`, 'The twin did not say where the readings are.', 15000);
            assert.ok((await twinEvents(twin)).some((text) => /^bad: .*The twin stopped .*The push service stopped: Konjugate stopped listening/.test(text)), 'The twin says why it stopped.');
            assert.equal(await evaluate(opened, `document.querySelector('#pushServiceChip').hidden`), true, 'Stopped on purpose, the chip goes.');
            const recordedTo = (await evaluate(twin, `window.__debugTwinWindow.summary()`)).recordedTo;
            assert.ok(recordedTo.startsWith(join(directory, 'recordings', 'pushed ')), `The recording is beside the project: ${recordedTo}.`);
            const recorded = readDataLog(await readFile(recordedTo, 'utf8'));
            assert.equal(recorded.header.source, 'Konjugate push service');
            assert.deepEqual(recorded.header.signals.map((entry) => entry.name), ['heaterPower', 'tankTemperature']);
            assert.ok(recorded.observations.length >= 61, `The recording holds at least the hour the first move needed: ${recorded.observations.length}.`);
            await twin.close();
            await evaluate(opened, `window.confirm = () => true; undefined`);
            await closeWhenValidated(opened);
        } finally {
            clearInterval(sending);
        }
    }, { skip: !driver.capabilities.multiWindow && 'the push service listens on a port, which a web page cannot; desktop only' });

    await run('the push service on the network: the choice warned of, encrypted with a certificate shown, and a script trusting it taken', async () => {
        const port = await new Promise((resolve) => {
            const probe = createServer();
            probe.listen(0, '127.0.0.1', () => { const { port: found } = probe.address(); probe.close(() => resolve(found)); });
        });
        const set = (selector, value) => evaluate(window, `(() => { const field = document.querySelector('${selector}'); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await evaluate(window, `document.querySelector('#settingsButton').click()`);
        await waitFor(window, `document.querySelector('#settingsDialog').open`, 'Settings did not open.');
        await evaluate(window, `document.querySelector('[data-settings-target="pushService"]').click()`);
        await waitFor(window, `!document.querySelector('[data-settings-page="pushService"]').hidden`, 'Settings › Push service did not open.');
        await set('#pushServicePort', String(port));
        await evaluate(window, `(() => { const box = document.querySelector('#pushServiceNetwork'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(window, `!document.querySelector('#pushCertificate').hidden`, 'Choosing the network did not show the certificate.', 15000);
        assert.match(await evaluate(window, `document.querySelector('#pushCertificateText').textContent`), /^Konjugate's own certificate, for .*SHA-256 fingerprint: ([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
        assert.equal(await evaluate(window, `document.querySelector('#pushServiceGrpcPort').textContent`), `HTTPS here, gRPC over TLS on ${port + 1}`);
        assert.match(await evaluate(window, `document.querySelector('#pushExamples details[data-example="rig"] code').textContent`), new RegExp(`pushTankRig\\.py https://[^ ]+:${port} \\\\\\n    --key YOUR_KEY \\\\\\n    --certificate konjugate-push\\.pem \\\\\\n    --speed 600`), 'The demonstration is given filled in, encrypted.');

        await set('#pushKeyName', 'remote rig');
        await set('#pushKeySignals', 'level');
        await evaluate(window, `document.querySelector('#pushKeyAdd').click()`);
        await waitFor(window, `!document.querySelector('#pushKeyMade').hidden`, 'The key was not shown.');
        const key = await evaluate(window, `document.querySelector('#pushKeyMadeValue').textContent`);
        await evaluate(window, `(() => { window.__confirmed = []; window.confirm = (message) => { window.__confirmed.push(message); return true; }; })()`);
        await evaluate(window, `document.querySelector('#pushServiceToggle').click()`);
        await waitFor(window, `document.querySelector('#pushServiceState').textContent.startsWith('Listening on the network, encrypted')`, 'The push service did not start on the network.', 15000);
        assert.match(await evaluate(window, `window.__confirmed[0] ?? ''`), /^Listen on the network\? Any computer that can reach this one/);
        assert.match(await evaluate(window, `document.querySelector('#pushServiceChipText').textContent`), new RegExp(`^Listening on the network at [^ ]+:${port}, 0 clients$`));

        // A script on the network trusting the certificate the app reports, sending to this computer's address.
        const state = await evaluate(window, `window.engine.pushService.state()`);
        const certificate = await evaluate(window, `window.engine.pushService.certificate().then((info) => info.certificate)`);
        const address = state.addresses.find((ip) => !ip.includes(':')) ?? '127.0.0.1';
        const answer = await new Promise((resolve, reject) => {
            const request = httpsRequest({ host: address, port, path: '/v1/readings', method: 'POST', ca: certificate, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } }, (response) => {
                let text = '';
                response.on('data', (chunk) => { text += chunk; });
                response.on('end', () => resolve(JSON.parse(text)));
            });
            request.on('error', reject);
            request.end(JSON.stringify({ readings: [{ signal: 'level', value: 1.25 }] }));
        });
        assert.equal(answer.status, 202, `A script at ${address} trusting the certificate was taken.`);
        await waitFor(window, `document.querySelector('#pushServiceState').textContent.includes('1 client')`, 'The panel did not count the script.', 5000);

        await evaluate(window, `document.querySelector('#pushServiceToggle').click()`);
        await waitFor(window, `document.querySelector('#pushServiceState').textContent.startsWith('Not listening')`, 'The push service did not stop.', 15000);
        assert.equal(await evaluate(window, `document.querySelector('#pushServiceNetwork').disabled`), false, 'Stopped, the choice can be changed again.');
        await evaluate(window, `(() => { const box = document.querySelector('#pushServiceNetwork'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); window.confirm = () => true; })()`);
        await evaluate(window, `document.querySelector('#settingsClose').click()`);
        await waitFor(window, `!document.querySelector('#settingsDialog').open`, 'Settings did not close.');
    }, { skip: !driver.capabilities.multiWindow && 'the push service listens on a port, which a web page cannot; desktop only' });

    await run('a parameter linked to a shared parameter edits and unlinks through the edge editor', async () => {
        // Two edges link one parameter to a project-level shared parameter: the linked row shows the
        // shared value (2), not its own stale one (5); editing it changes the shared definition, so
        // the sibling edge follows; and unlinking keeps the value in effect as the row's own.
        const project = sharedParameterTestProject();
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-shared-'));
        const projectPath = join(directory, 'sharedParameters.kjt');
        await writeFile(projectPath, await encodeProjectFile(JSON.stringify(project)));

        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length > 0`, 'The shared-parameter project did not load.');
        const openEdge = async (name) => {
            const point = await canvasPoint(opened, `window.__relationshipScreenPoint(${JSON.stringify(name)})`);
            assert.ok(point, `Could not locate ${name} on screen.`);
            await opened.mouseMove(point);
            await opened.mouseDown(point, { button: 'left', clickCount: 1 });
            await opened.mouseUp(point, { button: 'left', clickCount: 1 });
            await waitFor(opened, `document.querySelector('#editEdgeName').value === ${JSON.stringify(name)}`, `The ${name} edge editor did not open.`);
        };
        const row = `document.querySelector('#edgeEditorParameters .editorParameterRow')`;
        await openEdge('Feed X');
        assert.equal(await evaluate(opened, `${row}.querySelector('[data-shared-select]').value`), '100');
        assert.equal(await evaluate(opened, `${row}.querySelector('[data-field="value"]').value`), '2', 'A linked row must show the shared value.');

        await evaluate(opened, `(() => { const input = ${row}.querySelector('[data-field="value"]'); input.value = '3'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await evaluate(opened, `document.querySelector('#edgeEditor [data-close-card]').click()`);
        await openEdge('Feed Y');
        assert.equal(await evaluate(opened, `${row}.querySelector('[data-field="value"]').value`), '3', 'The sibling edge must follow the shared value.');

        await evaluate(opened, `(() => { const select = ${row}.querySelector('[data-shared-select]'); select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(opened, `${row}.querySelector('[data-shared-select]').value === ''`, 'Unlinking did not take effect.');
        assert.equal(await evaluate(opened, `${row}.querySelector('[data-field="value"]').value`), '3', 'Unlinking keeps the value in effect as the parameter\'s own.');
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    await run('a node provider survives the canvas, with its body parts, and its shared parameter is listed and kept as used', async () => {
        // A node has no parameters of its own; its computational-node provider reads a shared one. The canvas must keep
        // the provider as written until the user edits it (under Program in the node editor), and count its binding as
        // a use of the shared parameter, or the live controls, the parameters table and a save would leave it out.
        const implementation = {
            kind: 'python', providerApiVersion: 1, source: 'provider source',
            bindings: [{ key: 'payload', kind: 'parameter', sharedParameterId: 100 }],
            outputs: [{ key: 'angle', stateId: 2, setsValue: true }]
        };
        // A body's shape, in the frame of the body whose pose states start with its prefix.
        const parts = [{ prefix: 'link', mesh: { position: [0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], normal: [], index: [0, 1, 2] }, color: '#c0c0c0' }];
        const project = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' },
            sharedParameters: [{ id: 100, name: 'Payload', symbol: 'payload', value: 2, unit: 'kg', mode: 'live', control: { minimum: 0, maximum: 5, step: 0.5 } }],
            nodes: [{
                id: 1, name: 'Mechanism', position: [0, 0, 0], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#888888', parts },
                states: [{ id: 2, name: 'Angle', symbol: 'angle', initialValue: 0 }], implementation
            }],
            edges: [],
            runConfigurations: [{ id: 3, name: 'Default', globalTimeStep: 0.01, outputInterval: 0.01 }], activeRunConfigurationId: 3
        };
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-node-provider-'));
        const projectPath = join(directory, 'nodeProvider.kjt');
        await writeFile(projectPath, await encodeProjectFile(JSON.stringify(project)));

        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length > 0`, 'The node-provider project did not load.');
        const saved = await evaluate(opened, `window.__debugProject.serialize()`);
        assert.deepEqual(saved.nodes[0].implementation, implementation, 'The canvas must keep a node\'s provider as it was authored.');
        assert.deepEqual(saved.nodes[0].appearance.parts, parts, 'The canvas must keep a node\'s body parts.');
        assert.deepEqual(saved.sharedParameters?.map(({ id }) => id), [100], 'A shared parameter only a provider reads must still be saved.');

        await evaluate(opened, `document.querySelector('#parametersButton').click()`);
        await waitFor(opened, `!document.querySelector('#parametersPanel').hidden`, 'The parameters panel did not open.');
        assert.match(await evaluate(opened, `document.querySelector('#parametersBody tr.sharedRow').textContent`), /Shared.*1 use/,
            'The provider\'s binding must count as a use of the shared parameter.');
        await evaluate(opened, `document.querySelector('[data-toggle-shared]').click()`);
        assert.equal(await evaluate(opened, `document.querySelector('#parametersBody tr.sharedUserRow').lastElementChild.textContent`), 'Mechanism · provider');
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    await run('the parameters table lists shared and ordinary parameters, edits inline, and jumps to owners', async () => {
        const project = sharedParameterTestProject({ withSourceTerm: true });
        // One ordinary parameter alongside the shared ones, so both row kinds are covered.
        project.edges[1].parameters.push({ id: 15, name: 'Offset', symbol: 'offset', value: 1, unit: 'm', mode: 'constant' });
        project.edges[1].equationModel.bindings.push({ kind: 'parameter', parameterId: 15, symbol: 'offset' });
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-parameters-table-'));
        const projectPath = join(directory, 'parametersTable.kjt');
        await writeFile(projectPath, await encodeProjectFile(JSON.stringify(project)));

        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const opened = await driver.waitForNewHandle(before);
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length > 0`, 'The parameters-table project did not load.');
        await evaluate(opened, `document.querySelector('#parametersButton').click()`);
        await waitFor(opened, `!document.querySelector('#parametersPanel').hidden`, 'The parameters panel did not open.');

        assert.equal(await evaluate(opened, `document.querySelector('#parametersSummary').textContent`), '2 parameters · 1 shared',
            'One shared parameter (with its three linked uses folded under it) plus one ordinary parameter.');
        assert.equal(await evaluate(opened, `document.querySelectorAll('#parametersBody tr').length`), 2);
        assert.match(await evaluate(opened, `document.querySelector('#parametersBody tr.sharedRow').textContent`), /Shared.*3 uses/,
            'Both edges and the source term must count as uses of the shared parameter.');

        await evaluate(opened, `document.querySelector('[data-toggle-shared]').click()`);
        assert.equal(await evaluate(opened, `[...document.querySelectorAll('#parametersBody tr.sharedUserRow')].map((row) => row.lastElementChild.textContent).join('|')`),
            'Feed X (Source → Target X)|Feed Y (Source → Target Y)|Target X · own part', 'The expanded rows must name each owner.');

        // Inline edit of the shared value goes through the shared definition, undoably.
        const sharedValue = `document.querySelector('#parametersBody tr.sharedRow input[data-field="value"]')`;
        await evaluate(opened, `(() => { const input = ${sharedValue}; input.value = '7'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(opened, `${sharedValue}.value`), '7');
        await evaluate(opened, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(opened, `${sharedValue}.value`), '2', 'Undo must restore the shared value.');
        await evaluate(opened, `document.querySelector('#redoButton').click()`);

        // An out-of-range value for a live parameter is refused and marked, not applied.
        const modeSelect = `document.querySelector('#parametersBody tr:not(.sharedRow):not(.sharedUserRow) select[data-field="mode"]')`;
        await evaluate(opened, `(() => { const select = ${modeSelect}; select.value = 'live'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(opened, `${modeSelect}.value`), 'live', 'An in-range value can switch to live.');
        const ordinaryValue = `document.querySelector('#parametersBody tr:not(.sharedRow):not(.sharedUserRow) input[data-field="value"]')`;
        await evaluate(opened, `(() => { const input = ${ordinaryValue}; input.value = '1e9'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(opened, `${ordinaryValue}.classList.contains('invalid')`), true, 'A value outside the live range must be flagged.');

        // Filtering and search.
        await evaluate(opened, `(() => { const filter = document.querySelector('#parametersFilter'); filter.value = 'shared'; filter.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(opened, `document.querySelectorAll('#parametersBody tr:not(.sharedUserRow)').length`), 1);
        await evaluate(opened, `(() => { const filter = document.querySelector('#parametersFilter'); filter.value = 'all'; filter.dispatchEvent(new Event('change', { bubbles: true })); })()`);

        // Fit: marking the shared parameter tunable from the table makes it one fitting variable for the
        // tuning panel, and the Tunable filter finds it.
        const fitBox = `document.querySelector('#parametersBody tr.sharedRow input[data-field="tunable"]')`;
        await evaluate(opened, `(() => { const box = ${fitBox}; box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(opened, `document.querySelector('#parametersBody tr.sharedRow input[data-field="tuning-minimum"]').hidden`), false, 'Bounds must appear once tunable.');
        await evaluate(opened, `(() => { const filter = document.querySelector('#parametersFilter'); filter.value = 'tunable'; filter.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(opened, `document.querySelectorAll('#parametersBody tr:not(.sharedUserRow)').length`), 1, 'Only the tunable shared parameter should remain.');
        await evaluate(opened, `(() => { const filter = document.querySelector('#parametersFilter'); filter.value = 'all'; filter.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await evaluate(opened, `document.querySelector('#parameterTuningButton').click()`);
        await waitFor(opened, `!document.querySelector('#parameterTuning').classList.contains('hidden')`, 'The tuning panel did not open.');
        await evaluate(opened, `window.__debugParameterTuning.loadCsv('time,level\\n0,0\\n1,1\\n2,2\\n3,3\\n4,4\\n5,5\\n6,6\\n7,7\\n8,8\\n9,9\\n10,10\\n11,11\\n')`);
        await waitFor(opened, `document.querySelector('#parameterTuningParameterRows').textContent.includes('Shared')`, 'The tuning panel did not offer the shared parameter.');
        assert.equal(await evaluate(opened, `document.querySelectorAll('#parameterTuningParameterRows input[data-field="tune"]:checked').length`), 1, 'One shared parameter is one fitting variable however many parameters link to it.');
        await evaluate(opened, `document.querySelector('#parameterTuning [data-close-card]').click()`);

        // Clicking an owner opens its editor while the table stays open.
        await evaluate(opened, `document.querySelector('#parametersBody tr.sharedUserRow .ownerLink').click()`);
        await waitFor(opened, `!document.querySelector('#edgeEditor').classList.contains('hidden')`, 'Clicking an owner did not open its edge editor.');
        assert.equal(await evaluate(opened, `document.querySelector('#parametersPanel').hidden`), false, 'The table must stay open beside the editor.');
        assert.equal(await evaluate(opened, `document.querySelector('#edgeEditorParameters [data-shared-select]').value`), '100');

        // A source-term parameter links the same way: its row shows the shared value and can unlink.
        await evaluate(opened, `[...document.querySelectorAll('#parametersBody tr.sharedUserRow .ownerLink')].find((link) => link.textContent.includes('own part')).click()`);
        await waitFor(opened, `!document.querySelector('#nodeEditor').classList.contains('hidden') && document.querySelector('#nodeEditor [data-editor-tab].active').dataset.editorTab === 'parameters'`, 'Clicking the source-term owner did not open its node\'s Parameters tab.');
        const termRow = `document.querySelector('#nodeEditorParameters .editorParameterRow')`;
        assert.equal(await evaluate(opened, `${termRow}.querySelector('[data-shared-select]').value`), '100');
        assert.equal(await evaluate(opened, `${termRow}.querySelector('[data-field="value"]').value`), '7', 'The source-term row must show the shared value.');
        await evaluate(opened, `(() => { const select = ${termRow}.querySelector('[data-shared-select]'); select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(opened, `${termRow}.querySelector('[data-shared-select]').value === ''`, 'Unlinking the source-term parameter did not take effect.');
        assert.match(await evaluate(opened, `document.querySelector('#parametersSummary').textContent`), /· 1 shared/);
        assert.match(await evaluate(opened, `document.querySelector('#parametersBody tr.sharedRow').textContent`), /2 uses/, 'Unlinking must drop the source term from the shared parameter\'s uses.');
        await closeWhenValidated(opened);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    await run('a component bundle wires several edges among the selected nodes with a shared parameter, as one undoable step', async () => {
        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('#newWindowButton').click()`);
        const bundleWindow = await driver.waitForNewHandle(before);
        await waitFor(bundleWindow, `document.querySelector('.documentTitle')`, 'Bundle test window did not finish loading.');
        await evaluate(bundleWindow, `document.querySelector('#componentLibraryButton').click()`);
        await waitFor(bundleWindow, `document.querySelectorAll('.componentLibraryItem').length > 0`, 'Component library did not load any templates.');
        assert.match(await evaluate(bundleWindow, `document.querySelector('[data-template-id="batteryMotorDrive"] small').textContent`), /Bundle · 3 relationships/);
        const edgeCount = `Number(document.querySelectorAll('.modelStatus span')[1].textContent.match(/\\d+/)[0])`;

        // Too few nodes selected: the bundle explains what it needs and changes nothing.
        await evaluate(bundleWindow, `document.querySelector('[data-template-id="batteryMotorDrive"]').click()`);
        assert.match(await evaluate(bundleWindow, `document.querySelector('#componentLibraryHint').textContent`), /Select 3 nodes first \(Battery, Motor, Thermal mass\)/);
        assert.equal(await evaluate(bundleWindow, edgeCount), 0);

        // Place the three nodes, deliberately in an order that does not match the bundle's endpoints:
        // assignment is by state symbols, so it should not matter.
        for (const id of ['thermalMass', 'motor', 'battery']) {
            await evaluate(bundleWindow, `document.querySelector('[data-template-id="${id}"]').click()`);
        }
        await waitFor(bundleWindow, `document.querySelectorAll('.objectLabel').length >= 3`, 'The three node templates were not placed.');
        await evaluate(bundleWindow, `document.querySelector('[data-action="select-all"]').click()`);
        await evaluate(bundleWindow, `document.querySelector('[data-template-id="batteryMotorDrive"]').click()`);
        await waitFor(bundleWindow, `${edgeCount} === 3`, 'The bundle did not create its three edges.');
        // Each edge it creates carries the bundle's own explanation of what that edge is for.
        const bundleTemplate = await evaluate(bundleWindow, `window.componentLibrary.list().then((templates) => templates.find((template) => template.id === 'batteryMotorDrive'))`);
        const byName = (left, right) => left[0].localeCompare(right[0]);
        assert.ok(bundleTemplate.edges.every((edge) => edge.description?.length > 30));
        assert.deepEqual((await evaluate(bundleWindow, `window.__debugProject.serialize().edges.map((edge) => [edge.name, edge.description])`)).sort(byName),
            bundleTemplate.edges.map((edge) => [edge.name, edge.description]).sort(byName));

        await evaluate(bundleWindow, `document.querySelector('#parametersButton').click()`);
        await waitFor(bundleWindow, `!document.querySelector('#parametersPanel').hidden`, 'The parameters panel did not open.');
        assert.match(await evaluate(bundleWindow, `document.querySelector('#parametersSummary').textContent`), /· 1 shared/);
        const sharedRow = await evaluate(bundleWindow, `document.querySelector('#parametersBody tr.sharedRow').textContent`);
        assert.match(sharedRow, /Winding resistance/);
        assert.match(sharedRow, /2 uses/, 'The armature and heating edges must both link the one winding resistance.');

        // One undo removes every edge and the shared parameter with them; redo restores both.
        await evaluate(bundleWindow, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(bundleWindow, edgeCount), 0);
        assert.equal(await evaluate(bundleWindow, `document.querySelectorAll('#parametersBody tr.sharedRow').length`), 0);
        await evaluate(bundleWindow, `document.querySelector('#redoButton').click()`);
        assert.equal(await evaluate(bundleWindow, edgeCount), 3);
        assert.match(await evaluate(bundleWindow, `document.querySelector('#parametersBody tr.sharedRow').textContent`), /2 uses/);

        // Applying it again on nodes that cannot fit reports which endpoint has no match.
        await evaluate(bundleWindow, `document.querySelector('[data-template-id="thermalMass"]').click()`);
        await waitFor(bundleWindow, `document.querySelectorAll('.objectLabel').length >= 4`, 'The extra node was not placed.');
        await evaluate(bundleWindow, `document.querySelector('[data-action="select-all"]').click()`);
        await evaluate(bundleWindow, `document.querySelector('[data-template-id="batteryMotorDrive"]').click()`);
        assert.match(await evaluate(bundleWindow, `document.querySelector('#componentLibraryHint').textContent`), /Select 3 nodes first/);
        await closeWhenValidated(bundleWindow);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own isolated window; no web-edition equivalent' });

    await run('an installed package that needs a newer Konjugate is not loaded, is explained in Extensions, and does not count as an update', async () => {
        // docs/proposals/packageCompatibility.md: two packages that need a Konjugate far newer than any, and a compatible control.
        const packagesDirectory = join(process.env.KONJUGATE_INTERACTION_USER_DATA, 'packages');
        const plant = async (type, id, name, files, minimumKonjugateVersion) => {
            const directory = join(packagesDirectory, `${type}s`, id, '1.0.0');
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, 'package.json'), JSON.stringify({
                format: 'konjugate-package', formatVersion: 1, packageType: type, packageId: id, name, version: '1.0.0',
                ...(minimumKonjugateVersion ? { minimumKonjugateVersion } : {}), contents: { manifest: `${type}.json` }
            }));
            for (const [file, content] of Object.entries(files)) await writeFile(join(directory, file), typeof content === 'string' ? content : JSON.stringify(content));
        };
        const template = (id) => ({ id, kind: 'node', name: id, domains: ['showcase'], description: 'A test node.', states: [{ symbol: 'level', label: 'Level', initialValue: 1 }] });
        const pluginManifest = (id, componentId) => ({ pluginId: id, name: id, version: '1.0.0', apiVersion: 1, permissions: [], contributes: [{ kind: 'component', componentId, apiVersion: 1, entry: `${componentId}.json` }] });
        await plant('addon', 'example.futureTool', 'Future Tool', {
            'addon.json': {
                addonId: 'example.futureTool', name: 'Future Tool', version: '1.0.0', apiVersion: 1, kind: 'resultVisualizer', entry: 'index.html', permissions: ['results.read'],
                contributes: { toolstrip: [{ commandId: 'open', label: 'Open', tooltip: 'Open Future Tool', symbol: 'F', when: 'resultsActive', contexts: ['resultSession'] }] }
            },
            'index.html': '<!doctype html>'
        }, '999.0.0');
        await plant('plugin', 'example.futurePlugin', 'Future Plugin', { 'plugin.json': pluginManifest('example.futurePlugin', 'futureNode'), 'futureNode.json': template('futureNode') }, '999.0.0');
        await plant('plugin', 'example.currentPlugin', 'Current Plugin', { 'plugin.json': pluginManifest('example.currentPlugin', 'currentNode'), 'currentNode.json': template('currentNode') });

        // The main process reports the incompatible ones, with what they need, and never as enabled.
        const listed = await evaluate(window, `window.extensions.list().then((all) => all.filter((entry) => entry.packageId.startsWith('example.future') || entry.packageId === 'example.currentPlugin').map((entry) => ({ id: entry.packageId, enabled: entry.enabled, incompatible: entry.incompatible ?? null })))`);
        const byId = Object.fromEntries(listed.map((entry) => [entry.id, entry]));
        assert.equal(byId['example.futureTool'].enabled, false);
        assert.equal(byId['example.futureTool'].incompatible.required, '999.0.0');
        assert.match(byId['example.futureTool'].incompatible.running, /^\d+\.\d+\.\d+/);
        assert.equal(byId['example.futurePlugin'].enabled, false);
        assert.equal(byId['example.currentPlugin'].enabled, true);
        assert.equal(byId['example.currentPlugin'].incompatible, null);

        // The Extensions dialog explains it and offers the way out; it is not an update.
        await evaluate(window, `document.querySelector('#extensionsButton').click()`);
        await waitFor(window, `document.querySelector('#extensionsDialog').open`, 'The Extensions dialog did not open.');
        // The dialog remembers its last tab from earlier scenarios, so choose the one this scenario needs.
        await evaluate(window, `document.querySelector('[data-extensions-tab="addon"]').click()`);
        await waitFor(window, `Boolean(document.querySelector('[data-package-key="addon:example.futureTool:1.0.0"]'))`, 'The incompatible add-on was not listed.');
        const row = `document.querySelector('[data-package-key="addon:example.futureTool:1.0.0"]')`;
        assert.equal(await evaluate(window, `${row}.classList.contains('isIncompatible')`), true);
        assert.equal(await evaluate(window, `${row}.querySelector('.extensionsIncompatiblePill').textContent`), 'Incompatible');
        assert.match(await evaluate(window, `${row}.querySelector('.extensionsItemMeta').textContent`), /Needs Konjugate 999\.0\.0 or later; this is Konjugate \d+\.\d+\.\d+/);
        // Other installed add-ons may have updates of their own; what matters is that this package is not offered one.
        assert.equal(await evaluate(window, `Boolean(${row}.querySelector('.extensionsUpdatePill'))`), false, 'an incompatible package is not an update');
        assert.equal(await evaluate(window, `${row}.classList.contains('hasUpdate')`), false);
        assert.doesNotMatch(await evaluate(window, `${row}.querySelector('.extensionsItemMeta').textContent`), /Disabled/, 'it is incompatible, which is not something the user disabled');
        await evaluate(window, `${row}.click()`);
        await waitFor(window, `!document.querySelector('#extensionsDetailCompatibilityNote').hidden`, 'The compatibility note was not shown.');
        assert.match(await evaluate(window, `document.querySelector('#extensionsDetailCompatibilityNote').textContent`), /Needs Konjugate 999\.0\.0 or later.*It is not loaded\. Installing a compatible version replaces it\./);
        assert.equal(await evaluate(window, `document.querySelector('#extensionsInstallCompatible').hidden`), false);
        assert.equal(await evaluate(window, `document.querySelector('#extensionsToggleEnabled').hidden`), true, 'an incompatible package cannot be enabled');
        assert.equal(await evaluate(window, `document.querySelector('#extensionsUpdate').hidden`), true);

        // A package that is not in the registry has no other release to install, and says so plainly.
        await evaluate(window, `document.querySelector('#extensionsInstallCompatible').click()`);
        await waitFor(window, `/Could not install a compatible version/.test(document.querySelector('#extensionsRestartNotice').textContent)`, 'The failed install was not reported.');
        assert.match(await evaluate(window, `document.querySelector('#extensionsRestartNotice').textContent`), /not in the registry|registry/i);
        assert.equal(await evaluate(window, `document.querySelector('#extensionsInstallCompatible').disabled`), false, 'the button is usable again after a failure');

        // The compatible plugin is listed as usual, with nothing wrong with it.
        await evaluate(window, `document.querySelector('[data-extensions-tab="plugin"]').click()`);
        await waitFor(window, `Boolean(document.querySelector('[data-package-key="plugin:example.currentPlugin:1.0.0"]'))`, 'The compatible plugin was not listed.');
        assert.equal(await evaluate(window, `document.querySelector('[data-package-key="plugin:example.currentPlugin:1.0.0"]').classList.contains('isIncompatible')`), false);
        assert.equal(await evaluate(window, `document.querySelector('[data-package-key="plugin:example.futurePlugin:1.0.0"]').classList.contains('isIncompatible')`), true);
        await evaluate(window, `document.querySelector('#extensionsDialog').close()`);

        // And what a package contributes only loads if it is compatible.
        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('#newWindowButton').click()`);
        const libraryWindow = await driver.waitForNewHandle(before);
        await waitFor(libraryWindow, `document.querySelector('.documentTitle')`, 'The component library test window did not finish loading.');
        await evaluate(libraryWindow, `document.querySelector('#componentLibraryButton').click()`);
        await waitFor(libraryWindow, `document.querySelector('[data-template-id="currentNode"]')`, 'The compatible plugin\'s node template did not appear.');
        assert.equal(await evaluate(libraryWindow, `Boolean(document.querySelector('[data-template-id="futureNode"]'))`), false, 'the incompatible plugin\'s template must not load');
        await closeWhenValidated(libraryWindow);
    }, { skip: !driver.capabilities.multiWindow && 'packages are installed on disk by the desktop app; the web edition has none' });

    await run('a package is installed from a file (reviewed first, refused when this Konjugate cannot run it), then disabled, enabled and uninstalled', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-install-'));
        const packageId = 'interaction.installedNode';
        const pluginFile = async (name, extra = {}) => {
            const path = join(directory, name);
            await writeFile(path, createPackageArchive({
                packageManifest: { format: 'konjugate-package', formatVersion: 1, packageType: 'plugin', packageId, name: 'Installed Node', version: '1.0.0', contents: { manifest: 'plugin.json' }, ...extra },
                contributionManifest: { pluginId: packageId, name: 'Installed Node', version: '1.0.0', apiVersion: 1, permissions: [], contributes: [{ kind: 'component', componentId: 'installedNode', apiVersion: 1, entry: 'installedNode.json' }] },
                files: { 'installedNode.json': JSON.stringify({ id: 'installedNode', kind: 'node', name: 'Installed node', domains: ['showcase'], description: 'A test node.', states: [{ symbol: 'level', label: 'Level', initialValue: 1 }] }) }
            }));
            return path;
        };
        const installed = () => evaluate(window, `window.extensions.list().then((all) => all.filter((entry) => entry.packageId === ${JSON.stringify(packageId)}).map((entry) => entry.version))`);
        const notice = () => evaluate(window, `document.querySelector('#extensionsRestartNotice').textContent`);
        const plugin = await pluginFile('installedNode.kjp');
        try {
            await evaluate(window, `document.querySelector('#extensionsButton').click()`);
            await waitFor(window, `document.querySelector('#extensionsDialog').open`, 'The Extensions dialog did not open.');

            // Reviewed first: what it is and what it may do. Cancelled there, nothing is installed.
            let asked = await driver.answerDialogs({ open: plugin, button: 'Cancel' }, async () => {
                assert.equal(await evaluate(window, `window.extensions.install()`), null);
            });
            assert.deepEqual(asked.map((entry) => entry.kind), ['open', 'message']);
            assert.match(asked[1].message, /Install Installed Node\?/);
            assert.match(asked[1].detail, /Installed Node 1\.0\.0/);
            assert.match(asked[1].detail, /Permissions: none/);
            assert.deepEqual(await installed(), [], 'Cancelling the review must install nothing.');

            // Refused before the review, with the reason, when this Konjugate cannot run it; or when it is not a package at all.
            const future = await pluginFile('futureNode.kjp', { minimumKonjugateVersion: '999.0.0' });
            asked = await driver.answerDialogs({ open: future, button: 'Install' }, async () => {
                await evaluate(window, `document.querySelector('#extensionsInstall').click()`);
                await waitFor(window, `/^Installation failed/.test(document.querySelector('#extensionsRestartNotice').textContent)`, 'A package needing a newer Konjugate was not refused.');
            });
            assert.match(await notice(), /999\.0\.0/);
            assert.deepEqual(asked.map((entry) => entry.kind), ['open'], 'A package that cannot run is not offered for review.');
            const notAPackage = join(directory, 'notes.zip');
            await writeFile(notAPackage, 'not a package');
            await driver.answerDialogs({ open: notAPackage, button: 'Install' }, async () => {
                await evaluate(window, `document.querySelector('#extensionsInstall').click()`);
                await waitFor(window, `/Only \.kja add-ons/.test(document.querySelector('#extensionsRestartNotice').textContent)`, 'A file that is not a package was not refused.');
            });
            assert.deepEqual(await installed(), []);

            // Installed: written where packages live, listed and selected in its own tab, and a restart asked for.
            asked = await driver.answerDialogs({ open: plugin, button: 'Install' }, async () => {
                await evaluate(window, `document.querySelector('#extensionsInstall').click()`);
                await waitFor(window, `/^Installed interaction\.installedNode 1\.0\.0/.test(document.querySelector('#extensionsRestartNotice').textContent)`, 'The package was not installed.');
            });
            assert.deepEqual(asked.map((entry) => entry.kind), ['open', 'message']);
            assert.deepEqual(await installed(), ['1.0.0']);
            const onDisk = JSON.parse(await readFile(join(process.env.KONJUGATE_INTERACTION_USER_DATA, 'packages', 'plugins', packageId, '1.0.0', 'package.json'), 'utf8'));
            assert.equal(onDisk.packageId, packageId);
            await waitFor(window, `document.querySelector('[data-package-key="plugin:${packageId}:1.0.0"]')?.classList.contains('selected')`, 'The installed package was not shown, selected, in the list.');
            assert.equal(await evaluate(window, `document.querySelector('[data-extensions-tab="plugin"]').classList.contains('active')`), true);
            assert.equal(await evaluate(window, `window.extensions.restartPending()`), true);
            assert.equal(await evaluate(window, `document.querySelector('#extensionsRestartPendingNotice').hidden`), false, 'A plugin loads at the next start, which the dialog says.');

            // Disabled and enabled again from its detail, each at once; the state is the main process's, not only the dialog's.
            const enabled = () => evaluate(window, `window.extensions.list().then((all) => all.find((entry) => entry.packageId === ${JSON.stringify(packageId)})?.enabled)`);
            await evaluate(window, `document.querySelector('#extensionsToggleEnabled').click()`);
            await waitFor(window, `/^Disabled interaction\.installedNode 1\.0\.0/.test(document.querySelector('#extensionsRestartNotice').textContent)`, 'Disabling was not reported.');
            assert.equal(await enabled(), false);
            await evaluate(window, `document.querySelector('#extensionsToggleEnabled').click()`);
            await waitFor(window, `/^Enabled interaction\.installedNode 1\.0\.0/.test(document.querySelector('#extensionsRestartNotice').textContent)`, 'Enabling was not reported.');
            assert.equal(await enabled(), true);

            // Uninstalled, asked first: kept when the question is answered no, gone from the list and from disk when yes.
            await evaluate(window, `(() => { window.__askedToConfirm = []; window.__confirmAnswer = false; window.confirm = (question) => { window.__askedToConfirm.push(question); return window.__confirmAnswer; }; })()`);
            await evaluate(window, `document.querySelector('#extensionsUninstall').click()`);
            await waitFor(window, `window.__askedToConfirm.length === 1`, 'Uninstall did not ask first.');
            assert.match(await evaluate(window, `window.__askedToConfirm[0]`), /^Uninstall Installed Node 1\.0\.0\? This cannot be undone\./);
            assert.deepEqual(await installed(), ['1.0.0'], 'Answering no must keep it.');
            await evaluate(window, `window.__confirmAnswer = true; document.querySelector('#extensionsUninstall').click()`);
            await waitFor(window, `/^Uninstalled interaction\.installedNode 1\.0\.0/.test(document.querySelector('#extensionsRestartNotice').textContent)`, 'Uninstalling was not reported.');
            assert.deepEqual(await installed(), []);
            assert.equal(await evaluate(window, `Boolean(document.querySelector('[data-package-key="plugin:${packageId}:1.0.0"]'))`), false, 'It should be gone from the list.');
            await assert.rejects(readFile(join(process.env.KONJUGATE_INTERACTION_USER_DATA, 'packages', 'plugins', packageId, '1.0.0', 'package.json')), 'Its files should be gone.');
        } finally {
            await evaluate(window, `delete window.confirm; delete window.__askedToConfirm; delete window.__confirmAnswer`).catch(() => {});
            await evaluate(window, `window.extensions.uninstall('plugin', ${JSON.stringify(packageId)}, '1.0.0').catch(() => {})`);
            await evaluate(window, `document.querySelector('#extensionsDialog').open && document.querySelector('#extensionsDialog').close()`);
            await rm(directory, { recursive: true, force: true });
        }
    }, { skip: driver.kind !== 'electron' && 'installs through the desktop app\'s own file and review dialogs' });

    await run('a run is extended, exported as CSV, forked from an earlier time and compared, then saved with its results and opened again with every branch', async () => {
        // A copy of an example of its own: saving writes back to the file a project was opened from.
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-branches-'));
        const projectPath = join(directory, 'branches.kjt');
        await writeFile(projectPath, await readFile(join(process.cwd(), 'examples', 'thermalEquilibrium.kjt')));
        const openProject = async () => {
            const before = driver.allHandles();
            await driver.simulateOsFileOpen(projectPath);
            const opened = await driver.waitForNewHandle(before);
            await waitFor(opened, `document.querySelectorAll('.node-label-container').length > 0`, 'The project did not load.');
            return opened;
        };
        const timelineEnd = (handle) => evaluate(handle, `Number(document.querySelector('#resultTimeline').max)`);
        // Closing a result asks first, in the window: answered.
        const closeResultsIn = async (handle) => {
            await evaluate(handle, `document.querySelector('#closeResults').click()`);
            // Asked first when there is something to lose; else closed at once.
            await waitFor(handle, `document.querySelector('#closeResultsDialog').open || document.querySelector('#resultTransport').hidden`, 'Closing the results neither asked nor closed them.');
            await evaluate(handle, `document.querySelector('#confirmCloseResults')?.click()`);
            await waitFor(handle, `document.querySelector('#resultTransport').hidden`, 'The results did not close.');
        };
        // The value shown at `time`, in seconds, as the timeline reads it: the start of an extended run must still be there.
        const shownTimeAt = async (handle, time) => {
            await evaluate(handle, `(() => { const timeline = document.querySelector('#resultTimeline'); timeline.value = '${time}'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            return evaluate(handle, `document.querySelector('#resultCurrentTime').value`);
        };
        let opened = await openProject();
        try {
            await openRunDialog(opened);
            await evaluate(opened, `(() => { document.querySelector('#runTargetTime').value = '2'; document.querySelector('#startRun').click(); })()`);
            await waitFor(opened, `!document.querySelector('#continueRun').hidden && Number(document.querySelector('#resultTimeline').max) === 2`, 'The first run did not complete.', 30000);

            // Extended: the run goes on from where it ended, in the same result, not a new one.
            await evaluate(opened, `document.querySelector('#continueRun').click()`);
            await waitFor(opened, `document.querySelector('#runLaunchDialog').open`, 'Extend simulation did not open the Run dialog.');
            assert.match(await evaluate(opened, `document.querySelector('#runLaunchDescription').textContent`), /^Continue from 2/);
            await evaluate(opened, `(() => { document.querySelector('#runTargetTime').value = '4'; document.querySelector('#startRun').click(); })()`);
            await waitFor(opened, `!document.querySelector('#continueRun').hidden && Number(document.querySelector('#resultTimeline').max) === 4`, 'The extended run did not reach 4 s.', 30000);
            assert.equal(await evaluate(opened, `document.querySelector('#branchesButtonCount').textContent`), '', 'Extending is not a fork.');

            // Exported from the toolbar: every state, every sample, from the start to the end of the extended run.
            const exported = await driver.captureExport(() => evaluate(opened, `document.querySelector('#exportCsvButton').click()`), { extension: 'csv' });
            const [header, ...rows] = exported.bytes.toString('utf8').trim().split('\n');
            const stateCount = await evaluate(opened, `window.__debugProject.serialize().nodes.reduce((sum, node) => sum + node.states.length, 0)`);
            assert.equal(header.split(',').length, stateCount + 1, 'A time column, then one column per state.');
            const csvTimes = rows.map((row) => Number(row.split(',')[0]));
            assert.deepEqual([csvTimes[0], csvTimes.at(-1)], [0, 4], `The CSV should span the whole extended run (it spans ${csvTimes[0]} to ${csvTimes.at(-1)} s in ${rows.length} rows).`);

            // Forked at 1 s: a second branch, made the active one, running from there.
            await evaluate(opened, `(() => { const timeline = document.querySelector('#resultTimeline'); timeline.value = '1'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await evaluate(opened, `document.querySelector('#branchesButton').click()`);
            await waitFor(opened, `!document.querySelector('#branchesPanel').hidden && /^Fork at 1/.test(document.querySelector('#forkHereLabel').textContent)`, 'The branches panel did not offer a fork at 1 s.');
            await evaluate(opened, `document.querySelector('#forkHereButton').click()`);
            await waitFor(opened, `document.querySelector('#runLaunchDialog').open || !document.querySelector('#forkParameterPanel').hidden`, 'Fork here did not ask how to run the fork.');
            if (await evaluate(opened, `!document.querySelector('#forkParameterPanel').hidden`)) {
                await evaluate(opened, `document.querySelector('#confirmForkParameters').click()`);
                await waitFor(opened, `document.querySelector('#runLaunchDialog').open`, 'The fork\'s Run dialog did not open.');
            }
            assert.match(await evaluate(opened, `document.querySelector('#runLaunchDescription').textContent`), /^Fork from 1/);
            await evaluate(opened, `(() => { document.querySelector('#runTargetTime').value = '3'; document.querySelector('#startRun').click(); })()`);
            await waitFor(opened, `document.querySelector('#branchesButtonCount').textContent === '2' && !document.querySelector('#continueRun').hidden && Number(document.querySelector('#resultTimeline').max) === 3`, 'The fork did not run to 3 s.', 30000);
            assert.match(await evaluate(opened, `document.querySelector('#branchesButtonLabel').textContent`), /^Fork · 1/);

            // Compared: with a node selected, checking the baseline adds its series beside the fork's.
            await evaluate(opened, `document.querySelector('.objectLabel').click()`);
            await waitFor(opened, `document.querySelector('#nodeResultPlot').data?.length > 0`, 'The selected node\'s results were not plotted.', 10000);
            const tracesAlone = await evaluate(opened, `document.querySelector('#nodeResultPlot').data.length`);
            await evaluate(opened, `document.querySelector('#branchesButton').click()`);
            await waitFor(opened, `document.querySelectorAll('#branchTree .branchTreeItem').length === 2`, 'The branch tree did not list both branches.');
            assert.equal(await evaluate(opened, `document.querySelector('#branchTree .branchTreeButton.active').textContent`), await evaluate(opened, `[...document.querySelectorAll('#branchTree .branchTreeButton')][1].textContent`), 'The fork is the active branch.');
            await evaluate(opened, `(() => { const box = document.querySelector('#branchTree .branchCompareToggle:not(:disabled)'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            await waitFor(opened, `document.querySelector('#nodeResultPlot').data.length > ${tracesAlone}`, 'Comparing with the baseline did not add its series.', 10000);

            // Switched back to the baseline: its own, longer result.
            await evaluate(opened, `document.querySelector('#branchTree .branchTreeButton:not(.active)').click()`);
            await waitFor(opened, `Number(document.querySelector('#resultTimeline').max) === 4`, 'Switching to the baseline did not show its result.');
            assert.equal(await evaluate(opened, `document.querySelector('#branchesButtonLabel').textContent`), 'Baseline');

            // Saved with its results: asked what to keep, model and results chosen.
            await evaluate(opened, `document.querySelector('#saveButton').click()`);
            await waitFor(opened, `document.querySelector('#saveContentDialog').open`, 'Saving a project with results did not ask what to keep.');
            assert.equal(await evaluate(opened, `document.querySelector('#saveContentDialog input[value="modelAndResults"]').checked`), true, 'Model and results is offered first.');
            await evaluate(opened, `document.querySelector('#saveContentDialog form').requestSubmit()`);
            await waitFor(opened, `/saved with simulation results/.test(document.querySelector('#statusText').textContent)`, 'The project was not saved with its results.', 15000);
            await closeResultsIn(opened);
            await closeWhenValidated(opened);
            for (let attempt = 0; attempt < 50 && !await opened.isDestroyed(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(await opened.isDestroyed(), true, 'The saved project\'s window did not close.');
            opened = null;

            // Opened again: the results are there, both branches with them, the baseline active and the fork where it was made.
            opened = await openProject();
            await waitFor(opened, `document.querySelector('.resultMode b').textContent === 'Results' && document.querySelector('#branchesButtonCount').textContent === '2'`, 'The saved results and branches did not come back.', 15000);
            assert.equal(await timelineEnd(opened), 4, 'The baseline opens active, with its whole result.');
            assert.equal(await shownTimeAt(opened, 0.5), '0.5 s', 'The saved result keeps the run from its start, not only from where it was extended.');
            await evaluate(opened, `document.querySelector('#branchesButton').click()`);
            await waitFor(opened, `document.querySelectorAll('#branchTree .branchTreeItem').length === 2`, 'The reopened branch tree did not list both branches.');
            await evaluate(opened, `document.querySelector('#branchTree .branchTreeButton:not(.active)').click()`);
            await waitFor(opened, `Number(document.querySelector('#resultTimeline').max) === 3`, 'The reopened fork did not show its own result.');
            assert.match(await evaluate(opened, `document.querySelector('#branchesButtonLabel').textContent`), /^Fork · 1/);
        } finally {
            if (opened && !await opened.isDestroyed()) {
                await closeResultsIn(opened).catch(() => {});
                await closeWhenValidated(opened).catch(() => opened.close());
            }
            await rm(directory, { recursive: true, force: true });
        }
    }, { skip: (!driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent') || (!driver.capabilities.forks && 'the web engine keeps no checkpoints to fork from') });

    await run('a node template places source terms with their own and shared parameters, as one undoable step', async () => {
        const pluginDirectory = join(process.env.KONJUGATE_INTERACTION_USER_DATA, 'packages', 'plugins', 'example.stockpile', '0.1.0');
        await mkdir(pluginDirectory, { recursive: true });
        await writeFile(join(pluginDirectory, 'stockpile.json'), JSON.stringify({
            id: 'stockpile', kind: 'node', name: 'Stockpile', domains: ['showcase'], description: 'A draining stock with an order rule.',
            states: [{ symbol: 'stock', label: 'Stock', initialValue: 10 }, { symbol: 'orderRate', label: 'Order rate', initialValue: 0 }],
            sharedParameters: [
                { key: 'cover', name: 'Cover target', symbol: 'coverTarget', value: 3, scope: 'project' },
                { key: 'drain', name: 'Drain time', symbol: 'drainTime', value: 2 }
            ],
            sourceTerms: [
                { state: 'stock', expression: '-\\frac{\\mathrm{stock}}{\\mathrm{drainTime}}', parameters: [{ name: 'Drain time', symbol: 'drainTime', shared: 'drain' }] },
                {
                    state: 'orderRate', setsValue: true, expression: '\\mathrm{gain} \\cdot (\\mathrm{coverTarget} - \\mathrm{stock})',
                    parameters: [{ name: 'Gain', symbol: 'gain', value: 0.5 }, { name: 'Cover target', symbol: 'coverTarget', shared: 'cover' }]
                }
            ]
        }));
        await writeFile(join(pluginDirectory, 'plugin.json'), JSON.stringify({
            pluginId: 'example.stockpile', name: 'Stockpile', version: '0.1.0', apiVersion: 1, permissions: [],
            contributes: [{ kind: 'component', componentId: 'stockpile', apiVersion: 1, entry: 'stockpile.json' }]
        }));

        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('#newWindowButton').click()`);
        const stockWindow = await driver.waitForNewHandle(before);
        await waitFor(stockWindow, `document.querySelector('.documentTitle')`, 'Node template test window did not finish loading.');
        await evaluate(stockWindow, `document.querySelector('#componentLibraryButton').click()`);
        await waitFor(stockWindow, `document.querySelector('[data-template-id="stockpile"]')`, 'The plugin node template did not appear in the component library.');
        await evaluate(stockWindow, `document.querySelector('[data-template-id="stockpile"]').click()`);
        await evaluate(stockWindow, `document.querySelector('[data-template-id="stockpile"]').click()`);
        await waitFor(stockWindow, `document.querySelectorAll('.objectLabel').length === 2`, 'The two stockpiles were not placed.');

        const sharedRows = `[...document.querySelectorAll('#parametersBody tr.sharedRow')].map((row) => row.textContent)`;
        await evaluate(stockWindow, `document.querySelector('#parametersButton').click()`);
        await waitFor(stockWindow, `!document.querySelector('#parametersPanel').hidden`, 'The parameters panel did not open.');
        // The project-scoped cover target is shared by both nodes; each node gets its own drain time.
        const rows = await evaluate(stockWindow, sharedRows);
        assert.equal(rows.length, 3, `Expected one shared cover target and two drain times, got: ${rows.join(' | ')}`);
        assert.match(rows.find((row) => row.includes('Cover target')), /2 uses/);
        assert.equal(rows.filter((row) => row.includes('Drain time') && /1 use/.test(row)).length, 2);

        await settle(stockWindow, 'validation');
        await waitFor(stockWindow, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`, 'The placed stockpiles were not validated.', 10000);
        assert.equal(await evaluate(stockWindow, `document.querySelector('#validationSummary').classList.contains('error')`), false,
            'The engine should accept template source terms with parameters and an algebraic output.');

        // Undoing the second placement removes its own drain time but keeps the shared cover target.
        await evaluate(stockWindow, `document.querySelector('#undoButton').click()`);
        await waitFor(stockWindow, `${sharedRows}.length === 2`, 'Undo did not remove the second stockpile\'s own shared parameter.');
        assert.match((await evaluate(stockWindow, sharedRows)).find((row) => row.includes('Cover target')), /1 use/);
        await evaluate(stockWindow, `document.querySelector('#redoButton').click()`);
        await waitFor(stockWindow, `${sharedRows}.length === 3`, 'Redo did not restore the second stockpile\'s shared parameter.');
        await closeWhenValidated(stockWindow);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own isolated window; a plugin directory is written to the desktop userData' });

    await run('a plugin-contributed example appears in the Examples dialog and loads as an unsaved copy', async () => {
        // The suite runs with an isolated userData directory (KONJUGATE_INTERACTION_USER_DATA), which is
        // where installed packages live, so a plugin written there is discovered exactly like an installed one.
        const pluginDirectory = join(process.env.KONJUGATE_INTERACTION_USER_DATA, 'packages', 'plugins', 'example.exampleShowcase', '0.1.0');
        await mkdir(join(pluginDirectory, 'examples'), { recursive: true });
        const project = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' },
            nodes: [{ id: 1, name: 'Plugin tank', position: [0, 0, 0], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#888888' }, states: [{ id: 2, name: 'Level', symbol: 'level', initialValue: 1 }] }],
            edges: []
        };
        await writeFile(join(pluginDirectory, 'examples', 'pluginTank.kjt'), await encodeProjectFile(JSON.stringify(project)));
        await writeFile(join(pluginDirectory, 'examples', 'pluginTank.md'), '# Plugin tank\n\n## Overview\n\nA single tank shipped by a plugin.\n');
        await writeFile(join(pluginDirectory, 'plugin.json'), JSON.stringify({
            pluginId: 'example.exampleShowcase', name: 'Example Showcase', version: '0.1.0', apiVersion: 1, permissions: [],
            contributes: [
                { kind: 'example', apiVersion: 1, exampleId: 'pluginTank', name: 'Plugin tank', domains: ['showcase'], description: 'A single tank shipped by a plugin.', entry: 'examples/pluginTank.kjt', guide: 'examples/pluginTank.md' },
                { kind: 'example', apiVersion: 1, exampleId: 'escapes', name: 'Escapes its plugin', entry: '../escapes.kjt' },
                { kind: 'example', apiVersion: 1, exampleId: 'thermalManagement', name: 'Collides with a bundled example', entry: 'examples/pluginTank.kjt' }
            ]
        }));

        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('#newWindowButton').click()`);
        const exampleWindow = await driver.waitForNewHandle(before);
        await waitFor(exampleWindow, `document.querySelector('.documentTitle')`, 'The example window did not finish loading.');
        await evaluate(exampleWindow, `document.querySelector('#exampleButton').click()`);
        await waitFor(exampleWindow, `document.querySelector('#examplesExplorerDialog').open`, 'Examples explorer did not open.');
        const labels = `[...document.querySelectorAll('.examplesExplorerItem b')].map((item) => item.textContent)`;
        await waitFor(exampleWindow, `${labels}.includes('Plugin tank')`, 'The plugin example did not appear in the Examples dialog.');
        const listed = await evaluate(exampleWindow, labels);
        assert.ok(!listed.includes('Escapes its plugin'), 'An example whose file escapes its plugin directory must be skipped.');
        assert.equal(listed.filter((label) => label === 'Thermal Management').length, 1, 'An example colliding with a bundled id must be skipped.');

        await evaluate(exampleWindow, `[...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.querySelector('b').textContent === 'Plugin tank').click()`);
        await waitFor(exampleWindow, `document.querySelector('#examplesExplorerDetailTitle').textContent === 'Plugin tank'`, 'Selecting the plugin example did not populate the preview.');
        // The status line is the validation readout too: it says the example is an unsaved copy once its guide has
        // opened, and the model's validation may say its own a moment later. Every message it shows is recorded from
        // before the load, so the one saying so is seen however soon the next follows it.
        await evaluate(exampleWindow, `(() => {
            window.__statusMessages = [];
            const status = document.querySelector('#statusText');
            new MutationObserver(() => window.__statusMessages.push(status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
        })()`);
        await evaluate(exampleWindow, `document.querySelector('#examplesExplorerLoad').click()`);
        await waitFor(exampleWindow, `document.querySelector('.documentTitle').textContent === 'pluginTank'`, 'The plugin example did not load.');
        await waitFor(exampleWindow, `window.__statusMessages.some((message) => /unsaved copy/i.test(message))`, 'The plugin example was not said to be an unsaved copy.', 15000);
        // A label enters the page when the canvas next draws a frame, which is after the title is set.
        await waitFor(exampleWindow, `document.querySelectorAll('.node-label-container').length === 1`, 'The plugin example did not show its one node.');
        await closeWhenValidated(exampleWindow);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own isolated window; a plugin directory is written to the desktop userData' });

    await run('label detail cycles compact, expanded and hidden, keeping the selected label', async () => {
        // Sixteen nodes packed into a small area: far more labels than fit, the case that motivated the hidden state.
        const project = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, edges: [],
            nodes: Array.from({ length: 16 }, (_unused, index) => ({
                id: 1 + index * 2, name: `Crowded ${index + 1}`, position: [(index % 4) * 0.5, Math.floor(index / 4) * 0.5, 0], sourceTerms: [],
                appearance: { type: 'primitive', shape: 'box', color: '#888888' },
                states: [{ id: 2 + index * 2, name: 'Level', symbol: 'level', initialValue: index }]
            }))
        };
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-labels-'));
        const projectPath = join(directory, 'crowded.kjt');
        await writeFile(projectPath, await encodeProjectFile(JSON.stringify(project)));
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(projectPath);
        const crowded = await driver.waitForNewHandle(before);
        await waitFor(crowded, `document.querySelectorAll('.node-label-container').length === 16`, 'The crowded project did not load.');
        const visibleLabels = `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).visibility !== 'hidden').length`;

        // The Nodes button cycles compact -> expanded -> hidden -> compact, and says which it is.
        const nodesButton = `document.querySelector('[data-detail="nodes"]')`;
        assert.equal(await evaluate(crowded, `${nodesButton}.dataset.mode`), 'compact');
        await evaluate(crowded, `${nodesButton}.click()`);
        assert.equal(await evaluate(crowded, `${nodesButton}.dataset.mode`), 'expanded');
        assert.equal(await evaluate(crowded, `document.querySelector('#canvas').classList.contains('showNodesDetails')`), true);
        assert.match(await evaluate(crowded, `${nodesButton}.title`), /expanded · click for hidden/);
        await evaluate(crowded, `${nodesButton}.click()`);
        assert.equal(await evaluate(crowded, `${nodesButton}.dataset.mode`), 'hidden');
        assert.equal(await evaluate(crowded, `document.querySelector('#canvas').classList.contains('hideNodeLabels')`), true);
        assert.equal(await evaluate(crowded, `document.querySelector('#canvas').classList.contains('showNodesDetails')`), false);
        assert.equal(await evaluate(crowded, visibleLabels), 0, 'Hidden node labels are all gone when nothing is selected.');

        // A selected node keeps its label, so it is never hard to tell what you have picked.
        await evaluate(crowded, `document.querySelector('.node-label-container[data-node="1"]').click()`);
        await waitFor(crowded, `${visibleLabels} === 1`, 'The selected node did not keep its label while labels were hidden.');
        assert.equal(await evaluate(crowded, `getComputedStyle(document.querySelector('.node-label-container[data-node="1"]')).visibility`), 'visible');
        await evaluate(crowded, `${nodesButton}.click()`);
        assert.equal(await evaluate(crowded, `${nodesButton}.dataset.mode`), 'compact');
        assert.equal(await evaluate(crowded, visibleLabels), 16);
        await closeWhenValidated(crowded);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    await run('opening a model with hundreds of relationships starts with relationship labels hidden', async () => {
        const node = (id, name) => ({ id, name, position: [id, 0, 0], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#888888' }, states: [{ id: id + 1, name: 'Level', symbol: 'level', initialValue: 0 }] });
        const large = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, nodes: [node(1, 'Left'), node(3, 'Right')],
            edges: Array.from({ length: 160 }, (_unused, index) => ({
                id: 10 + index, name: `Link ${index}`, source: { nodeId: 1, stateId: 2 }, target: { nodeId: 3, stateId: 4 }, directionality: 'directed',
                equation: '', parameters: [], appearance: { color: '#888888', offset: 0 }
            }))
        };
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-large-'));
        const largePath = join(directory, 'large.kjt');
        await writeFile(largePath, await encodeProjectFile(JSON.stringify(large)));
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(largePath);
        const largeWindow = await driver.waitForNewHandle(before);
        await waitFor(largeWindow, `document.querySelectorAll('.node-label-container').length === 2`, 'The large project did not load.');
        assert.equal(await evaluate(largeWindow, `document.querySelector('[data-detail="edges"]').dataset.mode`), 'hidden');
        assert.equal(await evaluate(largeWindow, `document.querySelector('[data-detail="nodes"]').dataset.mode`), 'compact', 'Node labels are left alone.');
        // The user can bring them back with one more cycle.
        await evaluate(largeWindow, `document.querySelector('[data-detail="edges"]').click()`);
        assert.equal(await evaluate(largeWindow, `document.querySelector('[data-detail="edges"]').dataset.mode`), 'compact');
        await closeWhenValidated(largeWindow);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    await run('a model of many nodes leaves out the node labels that would overlap, and says how many', async () => {
        // Forty nodes a fifth of a unit apart: their labels, cards of a fixed size on screen, would lie over each other.
        const crowded = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, edges: [],
            nodes: Array.from({ length: 40 }, (_unused, index) => ({
                id: 1 + index * 2, name: `Site ${index + 1}`, position: [(index % 8) * 0.2, 0, Math.floor(index / 8) * 0.2], sourceTerms: [],
                appearance: { type: 'primitive', shape: 'box', color: '#888888' }, states: [{ id: 2 + index * 2, name: 'Level', symbol: 'level', initialValue: 0 }]
            }))
        };
        const directory = await mkdtemp(join(tmpdir(), 'konjugate-crowded-'));
        const crowdedPath = join(directory, 'crowded.kjt');
        await writeFile(crowdedPath, await encodeProjectFile(JSON.stringify(crowded)));
        const before = driver.allHandles();
        await driver.simulateOsFileOpen(crowdedPath);
        const crowdedWindow = await driver.waitForNewHandle(before);
        // Loaded: its forty nodes are in the window's model (a new window, opening a file, takes as long as the machine takes; the
        // limit only ends a hang). Then the window's word that the pass leaving labels out has run on a still camera, and a frame
        // been drawn after it: what is left out, and what is drawn, are final.
        await waitFor(crowdedWindow, `window.__debugProject?.serialize().nodes.length === 40`, 'The crowded project did not load.', settleHangGuardMs);
        await settle(crowdedWindow, 'labels', 'The crowded canvas');
        // Every label accounted for: drawn, or left out. Not "forty label elements exist": a label is added to the page the first
        // time it is drawn, so one left out before its first frame never gets an element at all.
        assert.equal(await evaluate(crowdedWindow, `[...document.querySelectorAll('.node-label-container')].filter((label) => label.style.display !== 'none').length
            + Number(document.querySelector('#canvas').dataset.labelsLeftOut ?? 0)`), 40, 'Some labels are neither drawn nor counted as left out.');
        const leftOut = Number(await evaluate(crowdedWindow, `document.querySelector('#canvas').dataset.labelsLeftOut`));
        assert.ok(leftOut >= 10 && leftOut < 40, `${leftOut} of 40 labels left out`);
        assert.equal(await evaluate(crowdedWindow, `[...document.querySelectorAll('.node-label-container')].filter((label) => label.style.display !== 'none').length`), 40 - leftOut, 'The labels left out are still drawn.');
        // Those written do not lie over each other.
        const overlapping = await evaluate(crowdedWindow, `(() => {
            const boxes = [...document.querySelectorAll('.node-label-container')].filter((label) => label.style.display !== 'none').map((label) => label.querySelector('.objectLabel').getBoundingClientRect());
            let count = 0;
            for (let a = 0; a < boxes.length; a += 1) for (let b = a + 1; b < boxes.length; b += 1) {
                if (boxes[a].left < boxes[b].right && boxes[b].left < boxes[a].right && boxes[a].top < boxes[b].bottom && boxes[b].top < boxes[a].bottom) count += 1;
            }
            return count;
        })()`);
        assert.equal(overlapping, 0, 'No two written labels overlap.');
        assert.match(await evaluate(crowdedWindow, `document.querySelector('[data-detail="nodes"]').title`), new RegExp(`${leftOut} left out where they would overlap`));
        await closeWhenValidated(crowdedWindow);
    }, { skip: !driver.capabilities.multiWindow && 'opens its own project window through an OS-style file open; no web-edition equivalent' });

    // ---- Everything a toolbox can write, a user can write in the canvas ------------------------------------------------
    // A small model of two nodes joined by one edge, loaded into this window, for the scenarios below.
    const loadAuthoringProject = async (overrides = {}) => {
        const state = (id, symbol, initialValue = 0) => ({ id, name: symbol, symbol, initialValue });
        const project = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [],
            nodes: [
                { id: 1, name: 'Mass', position: [-4, 0, 0], appearance: { type: 'primitive', shape: 'box', color: '#888888' },
                    states: [state(2, 'position', 1), state(3, 'speed')], sourceTerms: [] },
                { id: 4, name: 'Probe', position: [4, 0, 0], appearance: { type: 'primitive', shape: 'box', color: '#888888' },
                    states: [state(5, 'angle'), state(6, 'reading')], sourceTerms: [] }
            ],
            edges: [{
                id: 7, name: 'Sense', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 4, stateId: 5 }, directionality: 'directed',
                equation: '0', equationModel: { latex: '0', output: { role: 'target', stateId: 5 }, bindings: [], mathJson: 0 },
                parameters: [], appearance: { color: '#888888', offset: 0 }
            }],
            ...overrides
        };
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(project)})`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 2`, 'The authoring project did not load.');
    };
    const openNode = async (title) => {
        const label = `[...document.querySelectorAll('.objectLabel')].find((item) => item.textContent.includes(${JSON.stringify(title)}))`;
        await waitFor(window, `Boolean(${label})`, `The ${title} label was not on the canvas.`);
        await evaluate(window, `${label}.click()`);
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden') && document.querySelector('#editNodeName').value === ${JSON.stringify(title)}`, `The ${title} node editor did not open.`);
    };
    // Opened by its row on the label the canvas draws for it, clicked directly: the scenarios below are about the editor, not about
    // where on screen the line runs, which "clicking a relationship after replacing a deleted one" checks with a real click.
    const openRelationship = async (title) => {
        const row = `(() => { const edge = window.__debugProject.serialize().edges.find((item) => item.name === ${JSON.stringify(title)}); return edge ? document.querySelector('.relationshipRow[data-relationship="' + edge.id + '"]') : null; })()`;
        await waitFor(window, `Boolean(${row})`, `The ${title} relationship has no row on its label.`);
        await evaluate(window, `${row}.click()`);
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden') && document.querySelector('#editEdgeName').value === ${JSON.stringify(title)}`, `The ${title} edge editor did not open.`);
    };

    // A model of subsystems for the scenarios below, each loading it afresh, as the scenarios after them load models of their own. Model: Heater and Ambient at the top level; Plant holds Tank and the nested Pump (holding Pump motor); Controls,
    // beside Plant, holds Sensor. Ambient and Tank are an edge group, one member edge each way.
    const hierarchy = (() => {
        const state = (id, symbol) => ({ id, name: symbol, symbol, initialValue: 0 });
        const node = (id, name, position, stateId, symbol, subsystemId) => ({ id, name, position, appearance: { type: 'primitive', shape: 'box', color: '#888888' },
            states: [state(stateId, symbol)], sourceTerms: [], ...(subsystemId ? { subsystemId } : {}) });
        const edge = (id, name, [sourceNodeId, sourceStateId], [targetNodeId, targetStateId], extra = {}) => ({ id, name,
            source: { nodeId: sourceNodeId, stateId: sourceStateId }, target: { nodeId: targetNodeId, stateId: targetStateId }, directionality: 'directed',
            equation: '0', equationModel: { latex: '0', output: { role: 'target', stateId: targetStateId }, bindings: [], mathJson: 0 },
            parameters: [], appearance: { color: '#888888', offset: 0 }, ...extra });
        const tank = [1, 2]; const motor = [3, 4]; const heater = [5, 6]; const sensor = [7, 8]; const ambient = [9, 10];
        const project = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [],
            nodes: [
                node(1, 'Tank', [-3, 0, 0], 2, 'level', 20), node(3, 'Pump motor', [1.5, 0, 0], 4, 'speed', 21),
                node(5, 'Heater', [-7, 3, 0], 6, 'temperature'), node(7, 'Sensor', [7, 3, 0], 8, 'reading', 30),
                node(9, 'Ambient', [0, -4, 0], 10, 'temperature')
            ],
            edges: [
                edge(11, 'Heating', heater, tank), edge(12, 'Sense level', tank, sensor), edge(13, 'Drive', sensor, motor), edge(14, 'Fill', motor, tank, { parameters: [{ id: 60, name: 'Rate', symbol: 'rate', value: 2, unit: '', mode: 'constant' }] }),
                edge(15, 'Loss out', tank, ambient, { groupId: 40 }), edge(16, 'Loss in', ambient, tank, { groupId: 40 })
            ],
            edgeGroups: [{ id: 40, name: 'Losses', memberNodeIds: [1, 9], color: '#2fb8a4', definition: { parameters: [], output: { symbol: '' }, equation: '' } }],
            // Plant still carries ports stored by an earlier version, one naming an edge deleted since: it opens all the same.
            subsystems: [
                { id: 20, name: 'Plant', parentSubsystemId: null, position: [-1, 0, 0], ports: [{ id: 50, edgeId: 99, internalNodeId: 1, externalNodeId: 5, role: 'target' }] },
                { id: 21, name: 'Pump', parentSubsystemId: 20, position: [1.5, 0, 0] },
                { id: 30, name: 'Controls', parentSubsystemId: null, position: [7, 3, 0] }
            ]
        };
        // A box shown in the current view, by name (a hidden one keeps its label in the page, out of sight).
        const proxy = (name) => `[...document.querySelectorAll('.subsystemLabel')].find((label) => label.querySelector('strong').textContent === ${JSON.stringify(name)} && getComputedStyle(label.parentElement).display !== 'none')`;
        const open = (name) => `${proxy(name)}.querySelector('.subsystemOpen')`;
        const proxyText = (name) => evaluate(window, `${proxy(name)}.querySelector('small').textContent`);
        // A terminal's whole text, its detail line included, which compact labels show only when expanded.
        const terminals = () => evaluate(window, `[...document.querySelectorAll('.subsystemTerminal')].filter((terminal) => getComputedStyle(terminal.parentElement).display !== 'none')
            .map((terminal) => [Number(terminal.dataset.terminalEdge), [...terminal.querySelector('.subsystemTerminalEdge').children].map((part) => part.textContent.trim()).filter(Boolean).join(' ')]).sort((a, b) => a[0] - b[0])`);
        const terminal = (edgeId, part) => `document.querySelector('.subsystemTerminal[data-terminal-edge="${edgeId}"] .${part}')`;
        return { project, proxy, open, proxyText, terminals, terminal };
    })();
    const loadHierarchyProject = async () => {
        const { project, proxy } = hierarchy;
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(project)}, 'Hierarchy.kjt')`);
        await waitFor(window, `Boolean(${proxy('Plant')}) && Boolean(${proxy('Controls')})`, 'The hierarchy project did not load.');
        // A card an earlier scenario left open would sit over the boxes.
        await evaluate(window, `document.querySelectorAll('.contextCard').forEach((card) => card.classList.add('hidden'))`);
    };

    await run('inside a subsystem, relationships crossing its boundary end at terminals that follow the model', async () => {
        const { proxy, open, proxyText, terminals, terminal } = hierarchy;
        await loadHierarchyProject();

        // The proxies count what crosses them now, nested members counting as inside.
        assert.equal(await proxyText('Plant'), '5 boundary ports');
        assert.equal(await proxyText('Controls'), '2 boundary ports');
        assert.deepEqual(await terminals(), [], 'The top level has no boundary, so no terminals.');

        // Inside Plant: a terminal for each crossing, incoming or outgoing, naming the outside node, its state and where it is.
        await clickElement(window, open('Plant'));
        await waitFor(window, `!document.querySelector('#subsystemBreadcrumb').hidden`, 'Plant was not entered.');
        await waitFor(window, `document.querySelectorAll('.subsystemTerminal').length === 5`, 'Plant did not show a terminal for each crossing.');
        assert.deepEqual(await terminals(), [
            [11, '→ In Heater temperature · Model'],
            [12, 'Out → Sensor reading · Model / Controls'],
            [13, '→ In Sensor reading · Model / Controls'],
            [15, 'Out → Ambient temperature · Model · group Losses'],
            [16, '→ In Ambient temperature · Model · group Losses']
        ]);
        assert.equal(await evaluate(window, `document.querySelector('.subsystemTerminal[data-terminal-edge="11"]').classList.contains('left') && document.querySelector('.subsystemTerminal[data-terminal-edge="12"]').classList.contains('right')`), true, 'Incoming terminals stand on the left and outgoing ones on the right.');
        for (const title of ['Heating', 'Sense level', 'Drive', 'Fill', 'Loss out', 'Loss in']) {
            assert.equal(await evaluate(window, `window.__relationshipVisible(${JSON.stringify(title)})`), true, `${title} is drawn inside Plant.`);
        }

        // A terminal selects its relationship.
        await clickElement(window, terminal(12, 'subsystemTerminalEdge'));
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden') && document.querySelector('#editEdgeName').value === 'Sense level'`, 'Clicking the terminal did not open its relationship.');

        // Deleting it takes its terminal away and the count down; undoing brings both back.
        await evaluate(window, `(() => { document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); })()`);
        await waitFor(window, `!document.querySelector('.subsystemTerminal[data-terminal-edge="12"]') && document.querySelectorAll('.subsystemTerminal').length === 4`, 'The deleted relationship kept its terminal.');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `document.querySelectorAll('.subsystemTerminal').length === 5`, 'Undo did not bring the terminal back.');
        await evaluate(window, `(() => { document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); })()`);
        await waitFor(window, `document.querySelectorAll('.subsystemTerminal').length === 5`, 'Delete with nothing selected changed the boundary.');

        // Nested: inside Pump, the relationship from Sensor (in the sibling Controls) and the one to Tank (in the parent) are terminals.
        await clickElement(window, open('Pump'));
        await waitFor(window, `document.querySelector('#subsystemBreadcrumb').textContent.includes('Pump') && document.querySelectorAll('.subsystemTerminal').length === 2`, 'Pump did not show its two crossings.');
        assert.deepEqual(await terminals(), [[13, '→ In Sensor reading · Model / Controls'], [14, 'Out → Tank level · Model / Plant']]);

        // The ↗ beside a terminal goes to the view showing the outside node, and selects it.
        await clickElement(window, terminal(14, 'subsystemTerminalJump'));
        await waitFor(window, `document.querySelector('#subsystemBreadcrumb').textContent.includes('Plant') && [...document.querySelectorAll('.node-label-container.selected')].map((label) => label.textContent).some((text) => text.includes('Tank'))`, 'The jump did not land on Tank, selected.');

        // Back at the top level, deleting a relationship drawn to the proxy changes its count at once, and undo restores it.
        await evaluate(window, `document.querySelector('[data-subsystem-parent]').click()`);
        await waitFor(window, `document.querySelector('#subsystemBreadcrumb').hidden && document.querySelectorAll('.subsystemTerminal').length === 0`, 'Leaving Plant did not clear its terminals.');
        await waitForCanvasAtRest(window);
        const heating = await evaluate(window, `window.__relationshipScreenPoint('Heating', 0.5)`);
        await window.mouseMove(heating);
        await window.mouseDown(heating, { button: 'left', clickCount: 1 });
        await window.mouseUp(heating, { button: 'left', clickCount: 1 });
        await waitFor(window, `document.querySelector('#editEdgeName').value === 'Heating' && !document.querySelector('#edgeEditor').classList.contains('hidden')`, 'Heating was not selected.');
        await evaluate(window, `(() => { document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); })()`);
        await waitFor(window, `${proxy('Plant')}.querySelector('small').textContent === '4 boundary ports'`, 'The proxy kept a stale count after a delete.');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `${proxy('Plant')}.querySelector('small').textContent === '5 boundary ports'`, 'Undo did not restore the count.');
        const saved = await evaluate(window, `window.__debugProject.serialize()`);
        assert.equal(saved.subsystems.length, 3);
        assert.ok(saved.subsystems.every((subsystem) => !('ports' in subsystem)), 'Ports are not written: the boundary is derived.');

    });

    await run('a subsystem is selected by a click and renamed, dissolved and deleted from its card and menu, and nodes move in and out of it, each undoable', async () => {
        const { proxy, open, proxyText } = hierarchy;
        await loadHierarchyProject();
        const key = (init) => evaluate(window, `(() => { document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...${JSON.stringify(init)} })); })()`);
        const undo = () => key({ key: 'z', metaKey: true, ctrlKey: true });
        const redo = () => key({ key: 'z', shiftKey: true, metaKey: true, ctrlKey: true });
        const saved = () => evaluate(window, `window.__debugProject.serialize()`);
        const where = async (nodeId) => (await saved()).nodes.find((item) => item.id === nodeId).subsystemId ?? null;
        const names = async () => (await saved()).subsystems.map((subsystem) => subsystem.name).sort();
        const label = (title) => `[...document.querySelectorAll('.node-label-container')].find((container) => getComputedStyle(container).display !== 'none' && container.querySelector('.objectLabel strong, .objectLabel')?.textContent.includes(${JSON.stringify(title)}))?.querySelector('.objectLabel')`;
        const box = (name) => `${proxy(name)}.querySelector('strong')`;

        // A click on the box selects it and opens its card, without stepping inside.
        await clickElement(window, box('Plant'));
        await waitFor(window, `!document.querySelector('#subsystemEditor').classList.contains('hidden') && document.querySelector('#subsystemEditorHeading').textContent === 'Plant'`, 'Clicking the box did not open its card.');
        assert.equal(await evaluate(window, `document.querySelector('#subsystemBreadcrumb').hidden`), true, 'A single click stepped inside.');
        assert.equal(await evaluate(window, `${proxy('Plant')}.classList.contains('selected')`), true, 'The clicked subsystem is not shown selected.');
        assert.equal(await evaluate(window, `document.querySelector('#subsystemEditorSummary').textContent`), '1 node · 1 subsystem inside · 2 nodes in all · 5 boundary ports · in Model');
        assert.equal(await evaluate(window, `document.querySelectorAll('#subsystemEditorPorts li').length`), 5);

        // Renamed in its card; undo and redo.
        await typeInto(`document.querySelector('#subsystemEditorName')`, 'Tank farm');
        await waitFor(window, `Boolean(${proxy('Tank farm')})`, 'The box did not take the new name.');
        assert.deepEqual(await names(), ['Controls', 'Pump', 'Tank farm']);
        await undo();
        await waitFor(window, `Boolean(${proxy('Plant')})`, 'Undo did not restore the name.');
        await redo();
        await waitFor(window, `Boolean(${proxy('Tank farm')})`, 'Redo did not rename it again.');

        // Dissolved from its right-click menu: Sensor comes out to the top level; undo puts it back.
        await rightClickElement(window, box('Controls'));
        await waitFor(window, `!document.querySelector('#subsystemContextMenu').classList.contains('hidden')`, 'The subsystem menu did not open.');
        await evaluate(window, `document.querySelector('#subsystemContextDissolve').click()`);
        await waitFor(window, `!${proxy('Controls')}`, 'Controls was not dissolved.');
        assert.equal(await where(7), null);
        await waitFor(window, `Boolean(${label('Sensor')})`, 'The dissolved subsystem\'s node is not shown in its parent.');
        await undo();
        await waitFor(window, `Boolean(${proxy('Controls')})`, 'Undo did not bring Controls back.');
        assert.equal(await where(7), 30);

        // Moved in from the node menu: Heating no longer crosses, so the count follows; undo.
        await rightClickElement(window, label('Heater'));
        await waitFor(window, `Boolean(document.querySelector('#nodeContextMoveTargets [data-move-target="20"]'))`, 'The node menu offered no move into Tank farm.');
        assert.equal(await evaluate(window, `document.querySelector('#nodeContextMoveTargets [data-move-target="20"] strong').textContent`), 'Move into “Tank farm”');
        assert.equal(await evaluate(window, `Boolean(document.querySelector('#nodeContextMoveTargets [data-move-target="model"]'))`), false, 'At the top level there is no parent to move to.');
        await evaluate(window, `document.querySelector('#nodeContextMoveTargets [data-move-target="20"]').click()`);
        await waitFor(window, `${proxy('Tank farm')}.querySelector('small').textContent === '4 boundary ports'`, 'Moving Heater in did not change the count.');
        assert.equal(await where(5), 20);
        await waitFor(window, `!${label('Heater')}`, 'Heater is still shown at the top level.');
        await undo();
        await waitFor(window, `${proxy('Tank farm')}.querySelector('small').textContent === '5 boundary ports'`, 'Undo did not move Heater back out.');

        // The node editor's Subsystem field lists every place by path, nested ones too, and moves the node there.
        await evaluate(window, `${label('Ambient')}.click()`);
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden') && document.querySelector('#nodeEditorTitle').textContent === 'Ambient'`, 'Ambient\'s editor did not open.');
        assert.deepEqual(await evaluate(window, `[...document.querySelector('#editNodeSubsystem').options].map((option) => option.textContent)`), ['Model', 'Model / Controls', 'Model / Tank farm', 'Model / Tank farm / Pump']);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeSubsystem').value`), '');
        await evaluate(window, `(() => { const select = document.querySelector('#editNodeSubsystem'); select.value = '21'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(window, `document.querySelector('#statusText').textContent === 'Ambient moved to Model / Tank farm / Pump'`, 'The editor did not move Ambient into Pump.');
        assert.equal(await where(9), 21);
        await undo();
        await waitFor(window, `Boolean(${label('Ambient')})`, 'Undo did not bring Ambient back.');

        // Dragged onto the box, a node goes inside, as one undo step with the drag.
        await waitForCanvasAtRest(window);
        const from = await evaluate(window, `window.__nodeScreenPoint('Heater')`);
        const to = await evaluate(window, `window.__subsystemScreenPoint('Tank farm')`);
        await window.mouseMove(from);
        await window.mouseDown(from, { button: 'left', clickCount: 1 });
        for (let step = 1; step <= 8; step += 1) await window.mouseMove({ x: Math.round(from.x + (to.x - from.x) * step / 8), y: Math.round(from.y + (to.y - from.y) * step / 8) });
        await window.mouseUp(to, { button: 'left', clickCount: 1 });
        await waitFor(window, `document.querySelector('#statusText').textContent === 'Heater moved to Model / Tank farm'`, 'Dropping Heater onto the box did not move it in.');
        await undo();
        await waitFor(window, `Boolean(${label('Heater')})`, 'Undo did not take Heater back out.');
        assert.equal(await where(5), null);

        // Inside, the breadcrumb renames it, and the node menu moves a node out to the parent or into the nested subsystem.
        await clickElement(window, open('Tank farm'));
        await waitFor(window, `!document.querySelector('#subsystemBreadcrumb').hidden`, 'Tank farm was not entered.');
        await evaluate(window, `document.querySelector('[data-subsystem-rename]').click()`);
        await evaluate(window, `(() => { const input = document.querySelector('[data-subsystem-rename-input]'); input.value = 'Plant'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
        await waitFor(window, `document.querySelector('[data-subsystem-rename]')?.textContent === 'Plant'`, 'The breadcrumb did not rename the subsystem.');
        assert.deepEqual(await names(), ['Controls', 'Plant', 'Pump']);
        await rightClickElement(window, label('Tank'));
        await waitFor(window, `Boolean(document.querySelector('#nodeContextMoveTargets [data-move-target="model"]'))`, 'The node menu offered no move to the parent.');
        assert.equal(await evaluate(window, `Boolean(document.querySelector('#nodeContextMoveTargets [data-move-target="21"]'))`), true, 'The nested Pump is not offered.');
        await evaluate(window, `document.querySelector('#nodeContextMoveTargets [data-move-target="model"]').click()`);
        await waitFor(window, `document.querySelector('#statusText').textContent === 'Tank moved to Model'`, 'Tank was not moved to the parent.');
        await waitFor(window, `!${label('Tank')}`, 'Tank is still shown inside.');
        await undo();
        await waitFor(window, `Boolean(${label('Tank')})`, 'Undo did not bring Tank back in.');
        await evaluate(window, `document.querySelector('[data-subsystem-parent]').click()`);
        await waitFor(window, `document.querySelector('#subsystemBreadcrumb').hidden`, 'Did not return to the model.');

        // Deleted from its card, after a confirmation that counts what goes with it; undo brings everything back.
        await evaluate(window, `(() => { window.__confirmed = []; window.__realConfirm = window.confirm; window.confirm = (message) => { window.__confirmed.push(message); return true; }; })()`);
        try {
            await clickElement(window, box('Plant'));
            await waitFor(window, `!document.querySelector('#subsystemEditor').classList.contains('hidden')`, 'Plant\'s card did not open.');
            await evaluate(window, `document.querySelector('#subsystemEditorDelete').click()`);
            await waitFor(window, `!${proxy('Plant')}`, 'Plant was not deleted.');
            assert.deepEqual(await evaluate(window, `window.__confirmed`), ['Delete “Plant”? This also deletes 2 nodes, 1 nested subsystem, 1 relationship inside it, 5 relationships connecting it to the rest of the model. Undo brings them back.']);
            const after = await saved();
            assert.deepEqual([after.subsystems.map((subsystem) => subsystem.name), after.nodes.map((item) => item.name).sort(), after.edges.length], [['Controls'], ['Ambient', 'Heater', 'Sensor'], 0]);
            await undo();
            await waitFor(window, `Boolean(${proxy('Plant')}) && ${proxy('Plant')}.querySelector('small').textContent === '5 boundary ports'`, 'Undo did not restore Plant and its relationships.');
            assert.equal((await saved()).edges.length, 6);

            // The Delete key deletes a selected subsystem too, and asks first: refused, nothing goes.
            await evaluate(window, `(() => { window.confirm = (message) => { window.__confirmed.push(message); return false; }; })()`);
            await clickElement(window, box('Controls'));
            await waitFor(window, `${proxy('Controls')}.classList.contains('selected')`, 'Controls was not selected.');
            await key({ key: 'Delete' });
            await waitFor(window, `window.__confirmed.length === 2`, 'Delete did not ask about the selected subsystem.');
            assert.match(await evaluate(window, `window.__confirmed[1]`), /^Delete “Controls”\? This also deletes 1 node, 2 relationships connecting it/);
            assert.deepEqual(await names(), ['Controls', 'Plant', 'Pump']);
        } finally {
            await evaluate(window, `(() => { window.confirm = window.__realConfirm; })()`);
        }
    });

    await run('subsystem boxes and boundary terminals follow the Nodes label control and the declutter pass, and terminals are dragged and keep their place', async () => {
        const { proxy, open } = hierarchy;
        await loadHierarchyProject();
        const key = (init) => evaluate(window, `(() => { document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...${JSON.stringify(init)} })); })()`);
        const undo = () => key({ key: 'z', metaKey: true, ctrlKey: true });
        const redo = () => key({ key: 'z', shiftKey: true, metaKey: true, ctrlKey: true });
        const saved = () => evaluate(window, `window.__debugProject.serialize()`);
        const placed = async (name) => (await saved()).subsystems.find((subsystem) => subsystem.name === name).terminalPositions ?? [];
        const nodeLabels = (mode) => evaluate(window, `(() => { const button = document.querySelector('[data-detail="nodes"]'); for (let guard = 0; guard < 3 && button.dataset.mode !== ${JSON.stringify(mode)}; guard += 1) button.click(); return button.dataset.mode; })()`);
        // A box's or terminal's label, shown or not (a label left out keeps its element in the page, out of sight).
        const boxLabel = (name) => `[...document.querySelectorAll('.subsystemLabel')].find((label) => label.querySelector('strong').textContent === ${JSON.stringify(name)})`;
        const terminalLabel = (edgeId) => `document.querySelector('.subsystemTerminal[data-terminal-edge="${edgeId}"]')`;
        const onScreen = (element) => `(() => { const element = ${element}; return Boolean(element) && getComputedStyle(element.parentElement).display !== 'none' && getComputedStyle(element).visibility !== 'hidden'; })()`;
        const detailShown = (element) => evaluate(window, `getComputedStyle(${element}.querySelector('small')).display !== 'none'`);
        const near = (a, b) => a.every((value, index) => Math.abs(value - b[index]) < 1e-6);
        const drag = async (from, to) => {
            await window.mouseMove(from);
            await window.mouseDown(from, { button: 'left', clickCount: 1 });
            for (let step = 1; step <= 8; step += 1) await window.mouseMove({ x: Math.round(from.x + (to.x - from.x) * step / 8), y: Math.round(from.y + (to.y - from.y) * step / 8) });
            await window.mouseUp(to, { button: 'left', clickCount: 1 });
        };
        try {
            // Compact is the name alone; expanded adds the detail line; hidden leaves the label out unless selected.
            assert.equal(await nodeLabels('compact'), 'compact');
            assert.equal(await detailShown(boxLabel('Plant')), false, 'A compact box label shows its detail line.');
            assert.equal(await nodeLabels('expanded'), 'expanded');
            await waitFor(window, `getComputedStyle(${boxLabel('Plant')}.querySelector('small')).display !== 'none'`, 'An expanded box label hides its detail line.');
            assert.equal(await nodeLabels('hidden'), 'hidden');
            await waitFor(window, `!${onScreen(boxLabel('Plant'))} && !${onScreen(boxLabel('Controls'))}`, 'Hidden labels still show on the boxes.');
            await waitForCanvasAtRest(window);
            const plant = await evaluate(window, `window.__subsystemScreenPoint('Plant')`);
            await window.mouseMove(plant);
            await window.mouseDown(plant, { button: 'left', clickCount: 1 });
            await window.mouseUp(plant, { button: 'left', clickCount: 1 });
            await waitFor(window, `${onScreen(boxLabel('Plant'))} && !${onScreen(boxLabel('Controls'))}`, 'A selected box did not show its hidden label.');

            // Inside, terminals' labels are hidden too, but their diamonds stay: pointing at one shows its label, clicking it selects its relationship.
            await evaluate(window, `document.querySelector('#subsystemEditorOpen').click()`);
            // A label never shown has no element in the page yet, so the terminals are counted by their diamonds.
            await waitFor(window, `!document.querySelector('#subsystemBreadcrumb').hidden && [11, 12, 13, 15, 16].every((edgeId) => window.__terminalPosition(edgeId))`, 'Plant was not entered.');
            await waitFor(window, `!${onScreen(terminalLabel(11))}`, 'A hidden terminal label still shows.');
            await waitForCanvasAtRest(window);
            const heating = await evaluate(window, `window.__terminalScreenPoint(11)`);
            assert.ok(heating, 'The terminal has no diamond on the canvas.');
            // A pointer resting on the diamond moves a little, as a hand does, until the label shows.
            await window.mouseMove({ x: heating.x + 30, y: heating.y + 30 });
            for (let attempt = 0; attempt < 20 && !await evaluate(window, onScreen(terminalLabel(11))); attempt += 1) {
                await window.mouseMove({ x: heating.x + (attempt % 2), y: heating.y });
                await new Promise((resolve) => setTimeout(resolve, 150));
            }
            await waitFor(window, onScreen(terminalLabel(11)), 'Pointing at a terminal did not show its label.');
            await window.mouseDown(heating, { button: 'left', clickCount: 1 });
            await window.mouseUp(heating, { button: 'left', clickCount: 1 });
            await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden') && document.querySelector('#editEdgeName').value === 'Heating'`, 'Clicking a terminal\'s diamond did not select its relationship.');
            await window.mouseMove({ x: heating.x + 200, y: heating.y + 200 });
            await waitFor(window, onScreen(terminalLabel(11)), 'A selected terminal\'s label did not stay.');
            assert.equal(await nodeLabels('compact'), 'compact');
            await waitFor(window, `${onScreen(terminalLabel(12))} && getComputedStyle(${terminalLabel(12)}.querySelector('small')).display === 'none'`, 'A compact terminal label is not its name alone.');

            // Dragged, a terminal stays where it is put, in the subsystem's record; undo puts it back in the automatic layout.
            await evaluate(window, `(() => { document.querySelector('#edgeEditor').classList.add('hidden'); })()`);
            const before = await evaluate(window, `window.__terminalPosition(11)`);
            await waitForCanvasAtRest(window);
            const from = await evaluate(window, `window.__terminalScreenPoint(11)`);
            await drag(from, { x: from.x - 60, y: from.y - 90 });
            await waitFor(window, `document.querySelector('#statusText').textContent === 'Terminal moved'`, 'Dragging the terminal did not move it.');
            const moved = await evaluate(window, `window.__terminalPosition(11)`);
            assert.ok(!near(moved, before), 'The terminal did not move.');
            assert.deepEqual(await placed('Plant'), [{ edgeId: 11, position: moved }]);
            await undo();
            await waitFor(window, `JSON.stringify(window.__terminalPosition(11)) === ${JSON.stringify(JSON.stringify(before))}`, 'Undo did not put the terminal back.');
            assert.deepEqual(await placed('Plant'), []);
            await redo();
            await waitFor(window, `JSON.stringify(window.__terminalPosition(11)) === ${JSON.stringify(JSON.stringify(moved))}`, 'Redo did not move the terminal again.');

            // Leaving and coming back, and saving and opening, keep it there.
            await evaluate(window, `document.querySelector('[data-subsystem-parent]').click()`);
            await waitFor(window, `document.querySelector('#subsystemBreadcrumb').hidden`, 'Did not leave Plant.');
            await clickElement(window, open('Plant'));
            await waitFor(window, `JSON.stringify(window.__terminalPosition(11)) === ${JSON.stringify(JSON.stringify(moved))}`, 'The terminal did not keep its place on coming back.');
            const document_ = await saved();
            await evaluate(window, `window.__debugProject.load(${JSON.stringify(document_)}, 'Hierarchy.kjt')`);
            await waitFor(window, `Boolean(${proxy('Plant')})`, 'The saved project did not open.');
            await clickElement(window, open('Plant'));
            await waitFor(window, `JSON.stringify(window.__terminalPosition(11)) === ${JSON.stringify(JSON.stringify(moved))}`, 'The terminal did not keep its place through save and open.');

            // A terminal whose edge no longer crosses the boundary is not saved; undoing the delete brings it back.
            await waitForCanvasAtRest(window);
            const sense = await evaluate(window, `window.__terminalScreenPoint(12)`);
            await drag(sense, { x: sense.x + 20, y: sense.y - 150 });
            await waitFor(window, `window.__debugProject.serialize().subsystems.find((subsystem) => subsystem.name === 'Plant').terminalPositions?.length === 2`, 'The second terminal was not kept.');
            await waitForCanvasAtRest(window);
            const senseMoved = await evaluate(window, `window.__terminalScreenPoint(12)`);
            await window.mouseMove(senseMoved);
            await window.mouseDown(senseMoved, { button: 'left', clickCount: 1 });
            await window.mouseUp(senseMoved, { button: 'left', clickCount: 1 });
            await waitFor(window, `document.querySelector('#editEdgeName').value === 'Sense level'`, 'The moved terminal\'s diamond did not select its relationship.');
            await key({ key: 'Delete' });
            await waitFor(window, `!document.querySelector('.subsystemTerminal[data-terminal-edge="12"]')`, 'The relationship was not deleted.');
            assert.deepEqual((await placed('Plant')).map((entry) => entry.edgeId), [11]);
            await undo();
            await waitFor(window, `window.__debugProject.serialize().subsystems.find((subsystem) => subsystem.name === 'Plant').terminalPositions?.length === 2`, 'Undoing the delete did not keep the terminal\'s place.');
        } finally {
            await nodeLabels('compact');
        }

        // In a crowded view, box labels are left out where they would overlap, as node labels are, and a selected box keeps its own.
        const crowd = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], edges: [], nodes: [],
            subsystems: Array.from({ length: 31 }, (unused, index) => ({ id: 200 + index, name: `Crowd ${index + 1}`, parentSubsystemId: null, position: [0, 0, 0] }))
        };
        const boxesShown = `[...document.querySelectorAll('.subsystemLabel')].filter((label) => getComputedStyle(label.parentElement).display !== 'none' && getComputedStyle(label).visibility !== 'hidden')`;
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(crowd)}, 'Crowd.kjt')`);
        await waitFor(window, `Number(document.querySelector('#canvas').dataset.labelsLeftOut) >= 30 && ${boxesShown}.length === 1`, 'Overlapping box labels were not left out.', 10000);
        await waitForCanvasAtRest(window);
        const crowdBox = await evaluate(window, `window.__subsystemScreenPoint('Crowd 1')`);
        await window.mouseMove(crowdBox);
        await window.mouseDown(crowdBox, { button: 'left', clickCount: 1 });
        await window.mouseUp(crowdBox, { button: 'left', clickCount: 1 });
        await waitFor(window, `${boxesShown}.some((label) => label.classList.contains('selected'))`, 'A selected box did not keep its label.', 10000);
    });

    await run('inside a subsystem, a relationship can be drawn to a node outside it, and a terminal\'s relationship shows its real ends', async () => {
        const { open } = hierarchy;
        await loadHierarchyProject();
        await clickElement(window, open('Plant'));
        await waitFor(window, `!document.querySelector('#subsystemBreadcrumb').hidden && window.__terminalPosition(11)`, 'Plant was not entered.');

        // A new relationship's pick lists the nodes elsewhere too, by where they are.
        await evaluate(window, `document.querySelector('[data-add-kind="edge"]').click()`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'New relationship did not start its pick.');
        const choices = await evaluate(window, `[...document.querySelector('#endpointPickList').querySelectorAll('option, optgroup')].map((item) => item.tagName === 'OPTGROUP' ? '[' + item.label + ']' : item.textContent)`);
        assert.deepEqual(choices, ['Choose from the list…', 'Tank', '[Elsewhere in the model]', 'Pump motor · Model / Plant / Pump', 'Heater · Model', 'Sensor · Model / Controls', 'Ambient · Model']);
        await evaluate(window, `document.querySelector('#cancelEndpointPick').click()`);

        // The relationship of a terminal shows both its ends, the outside one included.
        await waitFor(window, `Boolean(document.querySelector('.subsystemTerminal[data-terminal-edge="11"] .subsystemTerminalEdge'))`, 'The terminal\'s label was not drawn.');
        await evaluate(window, `document.querySelector('.subsystemTerminal[data-terminal-edge="11"] .subsystemTerminalEdge').click()`);
        await waitFor(window, `document.querySelector('#editEdgeName').value === 'Heating'`, 'The terminal did not open its relationship.');
        assert.deepEqual(await evaluate(window, `[document.querySelector('#editEdgeSource').value, document.querySelector('#editEdgeSource').selectedOptions[0].textContent, document.querySelector('#editEdgeTarget').value]`), ['5', 'Heater · Model', '1']);

        // Pointed from inside at a node outside, a relationship crosses the boundary and gets a terminal; undo takes it back.
        // Fill runs from Pump motor, in the nested Pump, to Tank: inside Plant, it has no terminal there.
        assert.equal(await evaluate(window, `Boolean(window.__terminalPosition(14))`), false, 'Fill is inside Plant and has no terminal.');
        await evaluate(window, `(() => { document.querySelector('#edgeEditor').classList.add('hidden'); })()`);
        await clickElement(window, open('Pump'));
        await waitFor(window, `document.querySelector('#subsystemBreadcrumb').textContent.includes('Pump') && Boolean(document.querySelector('.subsystemTerminal[data-terminal-edge="14"] .subsystemTerminalEdge'))`, 'Pump was not entered.');
        await evaluate(window, `document.querySelector('.subsystemTerminal[data-terminal-edge="14"] .subsystemTerminalEdge').click()`);
        await waitFor(window, `document.querySelector('#editEdgeName').value === 'Fill'`, 'Fill did not open.');
        await evaluate(window, `(() => { const select = document.querySelector('#editEdgeTarget'); select.value = '5'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(window, `[...document.querySelectorAll('.subsystemTerminal')].some((terminal) => terminal.dataset.terminalEdge === '14' && terminal.textContent.includes('Heater'))`, 'The terminal did not follow the new end.');
        const fill = (await evaluate(window, `window.__debugProject.serialize()`)).edges.find((item) => item.name === 'Fill');
        assert.equal(fill.target.nodeId, 5, 'The new end is saved as a node id, a number.');
        await evaluate(window, `document.querySelector('[data-subsystem-parent]').click()`);
        await waitFor(window, `Boolean(window.__terminalPosition(14))`, 'Drawn out of Plant, the relationship got no terminal in Plant.');
        await evaluate(window, `(() => { document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true })); })()`);
        await waitFor(window, `!window.__terminalPosition(14)`, 'Undo did not take the relationship back inside.');
    });

    await run('a subsystem is saved as a component file, opens as a project, and is placed from a file as a copy or linked, or picked out of any project', async () => {
        const { proxy } = hierarchy;
        const desktop = driver.capabilities.osFileOpen;
        const folder = await mkdtemp(join(tmpdir(), 'konjugate-components-'));
        const saved = () => evaluate(window, `window.__debugProject.serialize()`);
        const box = (name) => `${proxy(name)}.querySelector('strong')`;
        const select = async (name) => {
            await evaluate(window, `document.querySelectorAll('.contextCard').forEach((card) => card.classList.add('hidden'))`);
            await waitFor(window, `Boolean(${proxy(name)})`, `${name}'s box is not shown.`);
            await clickElement(window, box(name));
            await waitFor(window, `!document.querySelector('#subsystemEditor').classList.contains('hidden') && document.querySelector('#subsystemEditorHeading').textContent === ${JSON.stringify(name)}`, `${name}'s card did not open.`);
        };
        // A file chosen in the picker: on the desktop the open dialog is answered with it; in the browser it is handed to the page.
        const choosing = async (path, content, trigger) => {
            if (desktop) return driver.answerDialogs({ open: path }, trigger);
            await evaluate(window, `window.__debugComponentFiles.provide(${JSON.stringify(content)}, ${JSON.stringify(path.split('/').at(-1))})`);
            return trigger();
        };

        // Saved: the file is an ordinary project with a component block, every port it has declared.
        await loadHierarchyProject();
        await select('Plant');
        let componentContent;
        let componentPath = join(folder, 'Plant.kjt');
        if (desktop) {
            const { path, bytes } = await driver.captureExport(() => evaluate(window, `document.querySelector('#subsystemSaveFile').click()`), { fileName: 'Plant.kjt' });
            componentPath = path;
            componentContent = await decodeProjectFile(bytes);
        } else {
            await evaluate(window, `(() => { window.__debugComponentFiles.capture = true; document.querySelector('#subsystemSaveFile').click(); })()`);
            await waitFor(window, `Boolean(window.__debugComponentFiles.lastSaved())`, 'The component was not saved.');
            componentContent = (await evaluate(window, `window.__debugComponentFiles.lastSaved()`)).content;
        }
        await waitFor(window, `document.querySelector('#statusText').textContent.startsWith('Plant saved as Plant.kjt')`, 'Saving did not say so.');
        const component = JSON.parse(componentContent);
        assert.equal(component.component.name, 'Plant');
        // A port is a state: the five relationships crossing Plant reach two (Tank's level and Pump motor's speed).
        assert.deepEqual(component.component.ports.map((port) => component.nodes.flatMap((item) => item.states).find((state) => state.id === port.stateId)?.symbol).sort(), ['level', 'speed'], 'Every port it has is declared in the file.');
        assert.deepEqual(component.nodes.map((item) => item.name).sort(), ['Pump motor', 'Tank']);
        if (desktop) {
            await waitFor(window, `window.__debugProject.serialize().subsystemDefinitions.some((definition) => definition.link?.fileName === 'Plant.kjt')`, 'Plant was not linked to the file it was saved as.');
        }

        // Opened as a project, a component file says what it is, and runs on its own.
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(component)}, 'Plant.kjt')`);
        await waitFor(window, `!document.querySelector('#componentProjectBar').hidden`, 'A component opened as a project does not say so.');
        assert.equal((await saved()).component.name, 'Plant', 'Saved again, it stays a component.');

        // Placed from a file into another model: reviewed first, then as a copy, then linked.
        await loadHierarchyProject();
        await choosing(componentPath, componentContent, () => evaluate(window, `document.querySelector('#addComponentFromFile').click()`));
        await waitFor(window, `document.querySelector('#componentPlaceDialog').open`, 'The review card did not open.');
        assert.equal(await evaluate(window, `document.querySelector('#componentPlaceName').textContent`), 'Plant');
        assert.equal(await evaluate(window, `document.querySelectorAll('#componentPlacePorts li').length`), 2, 'The review card lists the ports.');
        assert.match(await evaluate(window, `document.querySelector('#componentPlaceSource').textContent`), /^From Plant\.kjt/);
        await evaluate(window, `(() => { document.querySelector('#componentPlaceCopy').checked = true; document.querySelector('#componentPlaceConfirm').click(); })()`);
        await waitFor(window, `!document.querySelector('#componentPlaceDialog').open && window.__debugProject.serialize().subsystems.filter((item) => item.name === 'Plant').length === 2`, 'The copy was not placed.');
        let after = await saved();
        const copy = after.subsystems.filter((item) => item.name === 'Plant').at(-1);
        assert.equal(after.subsystemDefinitions.find((definition) => definition.id === copy.definitionId).link, undefined, 'Placed as a copy, it is not linked.');
        assert.deepEqual(after.nodes.filter((item) => item.subsystemId === copy.id).map((item) => item.name), ['Tank']);
        await choosing(componentPath, componentContent, () => evaluate(window, `document.querySelector('#componentLibraryPlaceFile').click()`));
        await waitFor(window, `document.querySelector('#componentPlaceDialog').open`, 'The review card did not open from the library panel.');
        await evaluate(window, `(() => { document.querySelector('#componentPlaceCopy').checked = false; document.querySelector('#componentPlaceConfirm').click(); })()`);
        await waitFor(window, `window.__debugProject.serialize().subsystems.filter((item) => item.name === 'Plant').length === 3`, 'The linked instance was not placed.');
        after = await saved();
        const linked = after.subsystems.filter((item) => item.name === 'Plant').at(-1);
        assert.equal(after.subsystemDefinitions.find((definition) => definition.id === linked.definitionId).link.fileName, 'Plant.kjt', 'Placed linked, it names its file.');
        if (!desktop) await waitFor(window, `(document.querySelector('#componentLinkBarText')?.textContent ?? '').includes('the browser cannot check it for changes')`, 'The browser does not say it cannot follow the file.');

        // A project that is not a component offers its subsystems: one is placed, as a copy.
        const projectPath = join(folder, 'Hierarchy.kjt');
        const projectContent = JSON.stringify(hierarchy.project);
        if (desktop) await writeFile(projectPath, await encodeProjectFile(projectContent));
        await choosing(projectPath, projectContent, () => evaluate(window, `document.querySelector('#addComponentFromFile').click()`));
        await waitFor(window, `document.querySelector('#componentPlaceDialog').open && !document.querySelector('#componentPlaceSubsystemField').hidden`, 'The project\'s subsystems were not offered.');
        assert.deepEqual(await evaluate(window, `[...document.querySelector('#componentPlaceSubsystem').options].map((option) => option.textContent)`), ['Plant', 'Controls']);
        assert.equal(await evaluate(window, `document.querySelector('#componentPlaceCopyField').hidden`), true, 'A subsystem out of a project is always a copy.');
        await evaluate(window, `(() => { const select = document.querySelector('#componentPlaceSubsystem'); select.value = [...select.options].find((option) => option.textContent === 'Controls').value; select.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#componentPlaceConfirm').click(); })()`);
        await waitFor(window, `window.__debugProject.serialize().subsystems.filter((item) => item.name === 'Controls').length === 2`, 'The chosen subsystem was not placed.');
        after = await saved();
        const placed = after.subsystems.filter((item) => item.name === 'Controls').at(-1);
        assert.deepEqual(after.nodes.filter((item) => item.subsystemId === placed.id).map((item) => item.name), ['Sensor']);
        await rm(folder, { recursive: true, force: true });
    });

    await run('a linked component follows its file and its library entry: compatible changes are taken in, conflicts ask, a missing file is located, edits are made where it lives', async () => {
        const { proxy } = hierarchy;
        const desktop = driver.capabilities.osFileOpen;
        const saved = () => evaluate(window, `window.__debugProject.serialize()`);
        const focus = () => evaluate(window, `window.dispatchEvent(new Event('focus'))`);
        const barText = () => evaluate(window, `document.querySelector('#componentLinkBar').hidden ? '' : document.querySelector('#componentLinkBarText').textContent`);
        const shownButtons = () => evaluate(window, `[...document.querySelectorAll('#componentLinkBar .componentBarButtons button')].filter((button) => !button.hidden).map((button) => button.textContent)`);
        const linkedPlant = async () => {
            const document_ = await saved();
            const definition = document_.subsystemDefinitions.find((item) => item.link);
            const instance = document_.subsystems.find((item) => item.definitionId === definition?.id);
            return { document_, definition, instance };
        };
        const tankOf = async () => {
            const { document_, instance } = await linkedPlant();
            return document_.nodes.find((item) => item.subsystemId === instance.id && item.name.startsWith('Tank'));
        };
        await loadHierarchyProject();

        if (desktop) {
            // A file: Plant saved as a component, then placed linked into the model.
            const folder = await mkdtemp(join(tmpdir(), 'konjugate-links-'));
            const component = JSON.parse(JSON.stringify(await evaluate(window, `(() => { const project = window.__debugProject.serialize(); return project; })()`)));
            await evaluate(window, `document.querySelectorAll('.contextCard').forEach((card) => card.classList.add('hidden'))`);
            await clickElement(window, `${proxy('Plant')}.querySelector('strong')`);
            await waitFor(window, `!document.querySelector('#subsystemEditor').classList.contains('hidden')`, 'Plant\'s card did not open.');
            const { path: filePath, bytes } = await driver.captureExport(() => evaluate(window, `document.querySelector('#subsystemSaveFile').click()`), { fileName: 'Plant.kjt' });
            const fileDocument = JSON.parse(await decodeProjectFile(bytes));
            assert.ok(component.nodes.length);
            await loadHierarchyProject();
            await driver.answerDialogs({ open: filePath }, () => evaluate(window, `document.querySelector('#addComponentFromFile').click()`));
            await waitFor(window, `document.querySelector('#componentPlaceDialog').open`, 'The review card did not open.');
            await evaluate(window, `(() => { document.querySelector('#componentPlaceCopy').checked = false; document.querySelector('#componentPlaceConfirm').click(); })()`);
            await waitFor(window, `window.__debugProject.serialize().subsystemDefinitions.some((definition) => definition.link?.path === ${JSON.stringify(filePath)})`, 'The component was not placed linked.');

            // Changed compatibly in its file, it is taken in when the window comes back to the front.
            const changed = structuredClone(fileDocument);
            changed.nodes.find((item) => item.name === 'Tank').states[0].initialValue = 42;
            await writeFile(filePath, await encodeProjectFile(JSON.stringify(changed)));
            await focus();
            await waitFor(window, `document.querySelector('#statusText').textContent.startsWith('Plant updated from Plant.kjt')`, 'The changed file was not taken in.');
            assert.equal((await tankOf()).states[0].initialValue, 42);

            // An edit inside a linked instance is put back: it is changed in its file.
            const linked = await linkedPlant();
            await evaluate(window, `(() => { const document_ = window.__debugProject.serialize(); document_.nodes.find((item) => item.id === ${(await tankOf()).id}).name = 'Tank edited'; window.__debugEdit = document_; })()`);
            await evaluate(window, `window.__debugProject.load(window.__debugEdit, 'Hierarchy.kjt')`);
            await waitFor(window, `window.__debugProject.serialize().nodes.some((item) => item.subsystemId === ${linked.instance.id} && item.name === 'Tank')`, 'An edit inside the linked instance was kept.');

            // A relationship from outside to its level port, then a version without that port: a conflict that asks.
            const withEdge = await saved();
            const tank = withEdge.nodes.find((item) => item.subsystemId === linked.instance.id && item.name === 'Tank');
            const template = withEdge.edges.find((item) => item.name === 'Heating');
            withEdge.edges.push({ ...structuredClone(template), id: 970, name: 'Feed', target: { nodeId: tank.id, stateId: tank.states[0].id }, equationModel: { ...template.equationModel, output: { role: 'target', stateId: tank.states[0].id } }, parameters: [] });
            await evaluate(window, `window.__debugProject.load(${JSON.stringify(withEdge)}, 'Hierarchy.kjt')`);
            await waitFor(window, `window.__debugProject.serialize().edges.some((item) => item.name === 'Feed')`, 'The relationship to the port was not loaded.');
            const portless = structuredClone(changed);
            portless.component.ports = portless.component.ports.filter((port) => portless.nodes.flatMap((item) => item.states).find((state) => state.id === port.stateId)?.symbol !== 'level');
            await writeFile(filePath, await encodeProjectFile(JSON.stringify(portless)));
            await focus();
            await waitFor(window, `(document.querySelector('#componentLinkBarText')?.textContent ?? '').includes('has changed what it offers')`, 'The conflict was not shown.');
            assert.deepEqual(await shownButtons(), ['Update and remove', 'Keep the old version', 'Detach']);
            // Laid out cleanly: every button on one line, inside the bar.
            assert.equal(await evaluate(window, `(() => { const bar = document.querySelector('#componentLinkBar').getBoundingClientRect(); return [...document.querySelectorAll('#componentLinkBar .componentBarButtons button')].filter((button) => !button.hidden).every((button) => { const box = button.getBoundingClientRect(); return box.height < 32 && box.right <= bar.right && box.left >= bar.left; }); })()`), true, 'The bar\'s buttons wrap or overflow it.');
            await evaluate(window, `document.querySelector('#componentLinkOld').click()`);
            await waitFor(window, `window.__debugProject.serialize().subsystemDefinitions.some((definition) => definition.link?.behind)`, 'Keeping the old version did not mark it behind its file.');
            assert.ok((await saved()).edges.some((item) => item.name === 'Feed'), 'Keeping the old version kept what was connected.');
            const portlessAgain = structuredClone(portless);
            portlessAgain.nodes.find((item) => item.name === 'Tank').states[0].initialValue = 43;
            await writeFile(filePath, await encodeProjectFile(JSON.stringify(portlessAgain)));
            await focus();
            await waitFor(window, `(document.querySelector('#componentLinkBarText')?.textContent ?? '').includes('has changed what it offers')`, 'The second conflict was not shown.');
            await evaluate(window, `document.querySelector('#componentLinkRemove').click()`);
            await waitFor(window, `!window.__debugProject.serialize().edges.some((item) => item.name === 'Feed')`, 'Update and remove did not remove the relationship to the removed port.');
            assert.equal((await tankOf()).states[0].initialValue, 43);

            // Moved away, the file is missing: the project runs on its saved copy until it is located.
            const movedPath = join(folder, 'Moved Plant.kjt');
            await writeFile(movedPath, await readFile(filePath));
            await rm(filePath);
            await focus();
            await waitFor(window, `(document.querySelector('#componentLinkBarText')?.textContent ?? '').includes('cannot be found')`, 'The missing file was not reported.');
            assert.deepEqual(await shownButtons(), ['Locate…', 'Keep using the saved copy', 'Detach']);
            await driver.answerDialogs({ open: movedPath }, () => evaluate(window, `document.querySelector('#componentLinkLocate').click()`));
            await waitFor(window, `window.__debugProject.serialize().subsystemDefinitions.some((definition) => definition.link?.path === ${JSON.stringify(movedPath)})`, 'Locate did not follow the file.');

            // Edit component opens the file in a window of its own.
            await evaluate(window, `document.querySelectorAll('.contextCard').forEach((card) => card.classList.add('hidden'))`);
            const plantInstance = (await linkedPlant()).instance;
            await evaluate(window, `document.querySelector('[data-subsystem-parent]')?.click()`);
            await clickElement(window, `[...document.querySelectorAll('.subsystemLabel')].filter((label) => getComputedStyle(label.parentElement).display !== 'none').find((label) => label.querySelector('strong').textContent === ${JSON.stringify(plantInstance.name)} && label === [...document.querySelectorAll('.subsystemLabel')].filter((other) => other.querySelector('strong').textContent === ${JSON.stringify(plantInstance.name)}).at(-1)).querySelector('.subsystemOpen')`);
            await waitFor(window, `!document.querySelector('#componentLinkBar').hidden && document.querySelector('#componentLinkBarText').textContent.includes('linked')`, 'Inside the linked instance, the bar does not say it is linked.');
            const before = driver.allHandles();
            await evaluate(window, `document.querySelector('#componentLinkEdit').click()`);
            const editor = await driver.waitForNewHandle(before, {}, 15000);
            await waitFor(editor, `document.querySelector('.documentTitle')?.textContent.includes('Moved Plant')`, 'The component did not open in its own window.', 20000);
            await closeWhenValidated(editor, 20000);
            await rm(folder, { recursive: true, force: true });
        }

        // My library, in both editions: a component placed from it follows the entry, and is edited in place and saved back.
        await loadHierarchyProject();
        await evaluate(window, `document.querySelectorAll('.contextCard').forEach((card) => card.classList.add('hidden'))`);
        await clickElement(window, `${proxy('Controls')}.querySelector('strong')`);
        await waitFor(window, `!document.querySelector('#subsystemEditor').classList.contains('hidden')`, 'Controls\' card did not open.');
        await evaluate(window, `document.querySelector('#saveTemplateButton').click()`);
        await waitFor(window, `document.querySelector('#templateDialog').open`, 'Save to my library did not open.');
        await evaluate(window, `(() => { document.querySelector('#templateName').value = 'Sensing'; document.querySelector('#templateSubmit').click(); })()`);
        await waitFor(window, `window.componentLibrary.list().then((templates) => templates.some((template) => template.name === 'Sensing' && template.kind === 'component'))`, 'The component was not saved to the library.');
        const entry = (await evaluate(window, `window.componentLibrary.list()`)).find((template) => template.name === 'Sensing');
        try {
            await evaluate(window, `(async () => { const template = (await window.componentLibrary.list()).find((item) => item.name === 'Sensing'); document.querySelector('#templateDialog').close(); window.__debugPlaceLibrary = template; })()`);
            await evaluate(window, `document.querySelector('#componentLibraryButton').click()`);
            await waitFor(window, `Boolean(document.querySelector('[data-template-id=${JSON.stringify(entry.id)}]'))`, 'The component is not in the library panel.');
            await evaluate(window, `document.querySelector('[data-template-id=${JSON.stringify(entry.id)}]').click()`);
            await waitFor(window, `document.querySelector('#componentPlaceDialog').open && document.querySelector('#componentPlaceSource').textContent.startsWith('From my library')`, 'Placing from the library did not review it first.');
            await evaluate(window, `(() => { document.querySelector('#componentPlaceCopy').checked = false; document.querySelector('#componentPlaceConfirm').click(); })()`);
            await waitFor(window, `window.__debugProject.serialize().subsystemDefinitions.some((definition) => definition.link?.kind === 'library')`, 'The component was not placed linked to the library.');
            await focus();
            await waitFor(window, `window.__debugProject.serialize().subsystemDefinitions.some((definition) => definition.link?.kind === 'library' && definition.link.sha256)`, 'The library link was not checked.');

            // The entry changed (as another window saving it would): the instance follows.
            const changedDocument = structuredClone(entry.document);
            changedDocument.nodes[0].states[0].initialValue = 7;
            await evaluate(window, `window.componentLibrary.updateUser(${JSON.stringify(entry.id)}, { document: ${JSON.stringify(changedDocument)} })`);
            await focus();
            await waitFor(window, `(() => { const document_ = window.__debugProject.serialize(); const definition = document_.subsystemDefinitions.find((item) => item.link?.kind === 'library'); const instance = document_.subsystems.find((item) => item.definitionId === definition.id); return document_.nodes.some((item) => item.subsystemId === instance.id && item.states[0].initialValue === 7); })()`, 'The instance did not follow its library entry.');

            // Edited in place and saved back: the entry is changed.
            const { definition, instance } = await (async () => {
                const document_ = await saved();
                const found = document_.subsystemDefinitions.find((item) => item.link?.kind === 'library');
                return { definition: found, instance: document_.subsystems.find((item) => item.definitionId === found.id) };
            })();
            await evaluate(window, `document.querySelectorAll('.contextCard, #componentLibraryPanel').forEach((card) => { if (card.classList.contains('contextCard')) card.classList.add('hidden'); })`);
            await evaluate(window, `(() => { document.querySelector('#closeComponentLibraryPanel')?.click(); })()`);
            const openPoint = `[...document.querySelectorAll('.subsystemLabel')].filter((label) => getComputedStyle(label.parentElement).display !== 'none' && label.querySelector('strong').textContent === ${JSON.stringify(instance.name)}).at(-1).querySelector('.subsystemOpen')`;
            await waitFor(window, `Boolean(${openPoint})`, 'The library instance\'s box is not shown.');
            await clickElement(window, openPoint);
            await waitFor(window, `!document.querySelector('#componentLinkBar').hidden && document.querySelector('#componentLinkBarText').textContent.includes('in my library')`, 'Inside the library instance, the bar does not name the library.');
            await evaluate(window, `document.querySelector('#componentLinkEdit').click()`);
            await waitFor(window, `document.querySelector('#componentLinkBarText').textContent.startsWith('Editing')`, 'Edit did not start editing in place.');
            // Its node changed in its editor, then saved back to the library: the entry has the change.
            await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((label) => label.getClientRects().length && label.textContent.includes('Sensor'))`, 'The library instance\'s node is not shown.');
            await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.getClientRects().length && label.textContent.includes('Sensor')).click()`);
            await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'The node editor did not open.');
            await openStateFields(window, await evaluate(window, `window.__debugProject.serialize().nodes.find((item) => item.subsystemId === ${instance.id}).states[0].symbol`));
            await evaluate(window, `(() => { const input = document.querySelector('#nodeEditorStates .editorStateRow:not([hidden]) input[data-field="value"]'); input.value = '9'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); input.blur(); })()`);
            await waitFor(window, `window.__debugProject.serialize().nodes.some((item) => item.subsystemId === ${instance.id} && item.states[0].initialValue === 9)`, 'The value was not changed.');
            await evaluate(window, `document.querySelector('#componentLinkSave').click()`);
            await waitFor(window, `window.componentLibrary.list().then((templates) => templates.find((template) => template.id === ${JSON.stringify(entry.id)})?.document.nodes[0].states[0].initialValue === 9)`, 'Saving did not change the library entry.');
            await waitFor(window, `!document.querySelector('#componentLinkBarText').textContent.startsWith('Editing')`, 'Saving did not end editing.');
            // The library is listed by the panel and the link checks at once: no listing reports another's templates as duplicates.
            assert.equal(await evaluate(window, `window.diagnostics.list().then((entries) => entries.filter((entry) => entry.message.includes('Duplicate template ID')).length)`), 0, 'Overlapping library listings reported duplicate templates.');
            assert.ok(definition);
        } finally {
            await evaluate(window, `window.componentLibrary.list().then((templates) => Promise.all(templates.filter((template) => template.source === 'user' && template.name === 'Sensing').map((template) => window.componentLibrary.removeUser(template.id))))`);
        }
    });

    await run('a result records the version of every component it ran with, and keeps it when saved with the project', async () => {
        await loadHierarchyProject();
        await openRunDialog(window);
        await evaluate(window, `(() => { document.querySelector('#runTargetTime').value = '0.5'; document.querySelector('#startRun').click(); })()`);
        await waitFor(window, `(() => { const facts = window.__debugTour.blockers(); return facts.hasResult && !facts.simulationRunning; })()`, 'The run did not finish.', 60000);
        const recorded = await evaluate(window, `window.__debugResultComponents()`);
        assert.equal(recorded.length, 1);
        assert.deepEqual(recorded[0].components.map((item) => [item.name, item.instances, item.sha256.length]).sort(), [['Controls', 1, 64], ['Plant', 1, 64]], 'The run records each component and its version.');
        if (driver.capabilities.osFileOpen) {
            await evaluate(window, `document.querySelector('#saveButton').click()`);
            await waitFor(window, `document.querySelector('#saveContentDialog').open`, 'Saving with results did not ask what to keep.');
            const { path, bytes } = await driver.captureExport(() => evaluate(window, `document.querySelector('#saveContentDialog form').requestSubmit()`), { fileName: 'Ran.kjt' });
            const document_ = JSON.parse(await decodeProjectFile(bytes));
            assert.deepEqual(document_.resultComponents.map((entry) => entry.components.map((item) => item.sha256)), [recorded[0].components.map((item) => item.sha256)], 'The saved project keeps them with its result.');
            await rm(path, { force: true });
        }
        await evaluate(window, `document.querySelector('#closeResults').click()`);
        // Asked first when there is something to lose; else closed at once.
        await waitFor(window, `document.querySelector('#closeResultsDialog').open || document.querySelector('#resultTransport').hidden`, 'Closing the results neither asked nor closed them.');
        await evaluate(window, `document.querySelector('#confirmCloseResults')?.click()`);
        await waitFor(window, `document.querySelector('#resultTransport').hidden`, 'The results did not close.');
    });

    await run('a copied subsystem keeps the moved terminals of the subsystems inside it and its own parameter values when pasted', async () => {
        const { proxy, open } = hierarchy;
        await loadHierarchyProject();
        const saved = () => evaluate(window, `window.__debugProject.serialize()`);
        // Inside the nested Pump, Fill's terminal moved.
        await clickElement(window, open('Plant'));
        await waitFor(window, `Boolean(${proxy('Pump')})`, 'Plant was not entered.');
        await clickElement(window, open('Pump'));
        await waitFor(window, `Boolean(window.__terminalPosition(14))`, 'Pump was not entered.');
        await waitForCanvasAtRest(window);
        const from = await evaluate(window, `window.__terminalScreenPoint(14)`);
        await window.mouseMove(from);
        await window.mouseDown(from, { button: 'left', clickCount: 1 });
        for (let step = 1; step <= 8; step += 1) await window.mouseMove({ x: Math.round(from.x + 10 * step), y: Math.round(from.y - 12 * step) });
        await window.mouseUp({ x: from.x + 80, y: from.y - 96 }, { button: 'left', clickCount: 1 });
        await waitFor(window, `document.querySelector('#statusText').textContent === 'Terminal moved'`, 'The terminal was not moved.');
        const moved = await evaluate(window, `window.__terminalPosition(14)`);
        await evaluate(window, `document.querySelector('[data-subsystem-parent]').click()`);
        await evaluate(window, `document.querySelector('[data-subsystem-parent]')?.click()`);
        await waitFor(window, `document.querySelector('#subsystemBreadcrumb').hidden`, 'Did not return to the model.');

        // Plant's Rate exposed and given a value of its own.
        await evaluate(window, `document.querySelectorAll('.contextCard').forEach((card) => card.classList.add('hidden'))`);
        await clickElement(window, `${proxy('Plant')}.querySelector('strong')`);
        await waitFor(window, `document.querySelector('#subsystemEditorHeading').textContent === 'Plant' && !document.querySelector('#subsystemEditor').classList.contains('hidden')`, 'Plant\'s card did not open.');
        await evaluate(window, `(() => { const select = document.querySelector('#subsystemExposeParameter'); select.value = [...select.options].find((option) => option.textContent.startsWith('Rate (rate)')).value; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(window, `Boolean(document.querySelector('#subsystemEditorParameterList [data-parameter-value]'))`, 'Rate was not exposed.');
        await evaluate(window, `(() => { const input = document.querySelector('#subsystemEditorParameterList [data-parameter-value]'); input.value = '5'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(window, `window.__debugProject.serialize().subsystems.find((item) => item.name === 'Plant').parameterValues?.some((value) => value.value === 5)`, 'Plant\'s value was not set.');

        // Copied and pasted: the copy's nested Pump has Fill's terminal where it was moved, under the copied Fill's new id, and the copy has Rate 5.
        await evaluate(window, `document.querySelector('#copySelection').click()`);
        await waitFor(window, `!document.querySelector('#pasteSelection').disabled`, 'Paste was not offered.');
        await evaluate(window, `document.querySelector('#pasteSelection').click()`);
        await waitFor(window, `Boolean(${proxy('Plant copy')})`, 'The copy was not pasted.');
        const after = await saved();
        const copy = after.subsystems.find((item) => item.name === 'Plant copy');
        const pump = after.subsystems.find((item) => item.parentSubsystemId === copy.id && item.name === 'Pump');
        const copiedFill = after.edges.find((item) => item.name === 'Fill' && after.nodes.find((entry) => entry.id === item.source.nodeId)?.subsystemId === pump.id);
        assert.ok(copiedFill && copiedFill.id !== 14, 'The copy has a Fill of its own.');
        assert.deepEqual(pump.terminalPositions, [{ edgeId: copiedFill.id, position: moved }], 'The moved terminal follows the copied Fill.');
        assert.deepEqual(copy.parameterValues?.map((value) => value.value), [5], 'The copy keeps the instance\'s own value.');
        await clickElement(window, open('Plant copy'));
        await waitFor(window, `[...document.querySelectorAll('.subsystemLabel')].some((label) => label.querySelector('strong').textContent === 'Pump' && getComputedStyle(label.parentElement).display !== 'none')`, 'The copy was not entered.');
        await clickElement(window, open('Pump'));
        await waitFor(window, `JSON.stringify(window.__terminalPosition(${copiedFill.id})) === ${JSON.stringify(JSON.stringify(moved))}`, 'Inside the copy, the terminal is not where it was moved.');
    });

    await run('a subsystem is a component: another instance follows edits, ports are named, parameters exposed per instance, and copies are separate', async () => {
        const { proxy, open } = hierarchy;
        await loadHierarchyProject();
        const key = (init) => evaluate(window, `(() => { document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...${JSON.stringify(init)} })); })()`);
        const undo = () => key({ key: 'z', metaKey: true, ctrlKey: true });
        const saved = () => evaluate(window, `window.__debugProject.serialize()`);
        const instancesOf = async (name) => (await saved()).subsystems.filter((subsystem) => subsystem.name === name);
        const box = (name) => `${proxy(name)}.querySelector('strong')`;
        const select = async (name) => {
            // A card left open may sit over the box.
            await evaluate(window, `document.querySelectorAll('.contextCard').forEach((card) => card.classList.add('hidden'))`);
            await waitFor(window, `Boolean(${proxy(name)})`, `${name}'s box is not shown.`);
            await clickElement(window, box(name));
            await waitFor(window, `!document.querySelector('#subsystemEditor').classList.contains('hidden') && document.querySelector('#subsystemEditorHeading').textContent === ${JSON.stringify(name)}`, `${name}'s card did not open.`);
        };
        const typeIn = (selector, value) => evaluate(window, `(() => { const input = ${selector}; input.value = ${JSON.stringify(String(value))}; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); input.blur(); })()`);

        // Every subsystem opens as an instance of a component of its own.
        const first = await saved();
        assert.equal(first.subsystemDefinitions.length, 2, 'Plant and Controls each have a definition.');
        assert.ok(first.subsystems.find((subsystem) => subsystem.name === 'Plant').definitionId);
        await select('Plant');
        assert.equal(await evaluate(window, `document.querySelector('#subsystemEditorComponent').hidden`), false);
        assert.match(await evaluate(window, `document.querySelector('#subsystemEditorUsage').textContent`), /^Used once in this model/);

        // Another instance, renamed so the two can be told apart.
        await evaluate(window, `document.querySelector('#subsystemPlaceAnother').click()`);
        await waitFor(window, `[...document.querySelectorAll('.subsystemLabel strong')].filter((name) => name.textContent === 'Plant' && getComputedStyle(name.closest('.subsystem-label')).display !== 'none').length === 2`, 'No second instance appeared.');
        assert.match(await evaluate(window, `document.querySelector('#subsystemEditorUsage').textContent`), /^Used 2 times/);
        await typeIn(`document.querySelector('#subsystemEditorName')`, 'Plant 2');
        await waitFor(window, `Boolean(${proxy('Plant 2')})`, 'The new instance was not renamed.');
        const tanks = async () => (await saved()).nodes.filter((item) => item.name.startsWith('Tank') && item.subsystemId != null).map((item) => item.name).sort();
        assert.deepEqual(await tanks(), ['Tank', 'Tank']);

        // A change inside one reaches the other when the edit is left; undo takes it back from both. Plant 2's
        // editor card is still open from the rename, and in a small window it covers Plant 2's own open button.
        await evaluate(window, `document.querySelectorAll('.contextCard').forEach((card) => card.classList.add('hidden'))`);
        await clickElement(window, open('Plant 2'));
        await waitFor(window, `document.querySelector('[data-subsystem-rename]')?.textContent === 'Plant 2' && Boolean(document.querySelector('[data-subsystem-uses]'))`, 'Plant 2 was not entered, or does not say it is used twice.');
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((label) => label.getClientRects().length && label.textContent.includes('Tank'))`, 'Plant 2\'s Tank is not shown.');
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.getClientRects().length && label.textContent.includes('Tank')).click()`);
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'Tank\'s editor did not open.');
        await typeIn(`document.querySelector('#editNodeName')`, 'Tank B');
        await evaluate(window, `document.querySelector('[data-subsystem-parent]').click()`);
        await waitFor(window, `window.__debugProject.serialize().nodes.filter((item) => item.name === 'Tank B').length === 2`, 'The other instance did not follow the edit.');
        await undo();
        await waitFor(window, `window.__debugProject.serialize().nodes.filter((item) => item.name === 'Tank').length === 2`, 'Undo did not take the edit back from both.', 8000);

        // A port named in the card is declared, and shown on the box.
        await select('Plant');
        await waitFor(window, `document.querySelectorAll('#subsystemEditorPortList .subsystemRow').length > 0`, 'The card lists no ports.');
        const portStates = await evaluate(window, `[...document.querySelectorAll('#subsystemEditorPortList .subsystemRow')].map((row) => row.querySelector('small').textContent)`);
        assert.ok(portStates.every((text) => text.includes('connected')), 'Ports found from what is connected are listed.');
        await typeIn(`document.querySelector('#subsystemEditorPortList .subsystemRow [data-port-name]')`, 'Inlet');
        await waitFor(window, `${proxy('Plant')}.querySelector('small').textContent.includes('ports: Inlet')`, 'The named port is not on the box.');
        assert.equal((await saved()).subsystemDefinitions.find((definition) => definition.document.component.ports?.some((port) => port.name === 'Inlet')) !== undefined, true);

        // An exposed parameter takes a value per instance.
        await select('Plant');
        const exposable = await evaluate(window, `[...document.querySelector('#subsystemExposeParameter').options].map((option) => option.textContent)`);
        assert.ok(exposable.some((label) => label.startsWith('Rate (rate)')), `Rate cannot be exposed: ${exposable.join(' | ')}`);
        await evaluate(window, `(() => { const select = document.querySelector('#subsystemExposeParameter'); select.value = [...select.options].find((option) => option.textContent.startsWith('Rate (rate)')).value; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(window, `document.querySelectorAll('#subsystemEditorParameterList .subsystemRow').length === 1`, 'The exposed parameter is not listed.');
        await select('Plant 2');
        await waitFor(window, `document.querySelectorAll('#subsystemEditorParameterList .subsystemRow').length === 1`, 'The other instance does not list the exposed parameter.');
        await typeIn(`document.querySelector('#subsystemEditorParameterList [data-parameter-value]')`, 5);
        await waitFor(window, `(() => { const document_ = window.__debugProject.serialize(); const plant2 = document_.subsystems.find((item) => item.name === 'Plant 2'); return document_.sharedParameters.some((shared) => shared.subsystemId === plant2.id && shared.value === 5); })()`, 'The value was not set for Plant 2.');
        const values = (await saved()).sharedParameters.filter((shared) => shared.symbol.startsWith('rate')).map((shared) => shared.value).sort();
        assert.deepEqual(values, [2, 5], 'Each instance has its own value.');

        // Made separate, an instance no longer shares the component.
        await select('Plant 2');
        await evaluate(window, `document.querySelector('#subsystemMakeSeparate').click()`);
        await waitFor(window, `document.querySelector('#subsystemEditorUsage').textContent.startsWith('Used once')`, 'Plant 2 was not made separate.');
        assert.equal(new Set((await saved()).subsystems.filter((item) => item.name.startsWith('Plant')).map((item) => item.definitionId)).size, 2);

        // Copied and pasted, a subsystem is a copy of its own.
        await select('Plant');
        await evaluate(window, `document.querySelector('#copySelection').click()`);
        await waitFor(window, `!document.querySelector('#pasteSelection').disabled`, 'Paste was not offered.');
        await evaluate(window, `document.querySelector('#pasteSelection').click()`);
        await waitFor(window, `Boolean(${proxy('Plant copy')})`, 'The copy was not pasted.');
        const afterPaste = await saved();
        const copy = afterPaste.subsystems.find((item) => item.name === 'Plant copy');
        assert.ok(copy.definitionId && afterPaste.subsystems.filter((item) => item.definitionId === copy.definitionId).length === 1, 'The copy has a component of its own.');
        assert.equal(afterPaste.nodes.filter((item) => item.subsystemId === copy.id).length, 1, 'The copy holds Tank (Pump motor is in its nested Pump).');

        // Saved and opened, the components are kept.
        await evaluate(window, `window.__debugProject.load(${JSON.stringify('__SAVED__')}, 'Hierarchy.kjt')`.replace(JSON.stringify('__SAVED__'), JSON.stringify(afterPaste)));
        await waitFor(window, `Boolean(${proxy('Plant copy')})`, 'The saved project did not open.');
        const reopened = await saved();
        assert.deepEqual(reopened.subsystemDefinitions.map((definition) => definition.id).sort(), afterPaste.subsystemDefinitions.map((definition) => definition.id).sort());
        assert.deepEqual(reopened.nodes.map((item) => item.id).sort(), afterPaste.nodes.map((item) => item.id).sort(), 'Opening keeps every id.');
    });

    await run('atan2 is typed as most people write it, and the equation help lists every function', async () => {
        await loadAuthoringProject();
        await openRelationship('Sense');
        await evaluate(window, `document.querySelector('[data-equation-mode="latex"]').click()`);
        await typeInto(`document.querySelector('#editEdgeEquation')`, String.raw`\operatorname{atan2}(\mathrm{sourceSpeed},\mathrm{sourcePosition})`);
        await waitFor(window, `document.querySelector('#equationDiagnostics').classList.contains('valid')`, 'atan2 was not accepted.');
        assert.match(await evaluate(window, `document.querySelector('#edgeFunctions').textContent`), /atan2\(y, x\)/);
        assert.deepEqual((await savedProject()).edges[0].equationModel.mathJson, ['Arctan2', 'sourceSpeed', 'sourcePosition']);
        await evaluate(window, `document.querySelector('[data-equation-mode="visual"]').click()`);
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
    });

    await run('node and edge descriptions survive being saved and opened again', async () => {
        await loadAuthoringProject();
        await openNode('Mass');
        await typeInto(`document.querySelector('#editNodeDescription')`, 'A point mass on a spring.');
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);
        await openRelationship('Sense');
        await typeInto(`document.querySelector('#editEdgeDescription')`, 'Reads the mass angle.');
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);

        // Through the file's own JSON text and back in, as saving and reopening does.
        const saved = await savedProject();
        assert.equal(saved.nodes.find((node) => node.name === 'Mass').description, 'A point mass on a spring.');
        assert.equal(saved.nodes.find((node) => node.name === 'Probe').description, undefined, 'A node never described gained a description.');
        assert.equal(saved.edges[0].description, 'Reads the mass angle.');
        await loadAuthoringProject({ nodes: saved.nodes, edges: saved.edges });

        await openNode('Mass');
        assert.equal(await evaluate(window, `document.querySelector('#editNodeDescription').value`), 'A point mass on a spring.', 'The node description did not come back after reopening.');
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);
        await openRelationship('Sense');
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeDescription').value`), 'Reads the mass angle.', 'The edge description did not come back after reopening.');
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
        const reopened = await savedProject();
        assert.equal(reopened.nodes.find((node) => node.name === 'Mass').description, 'A point mass on a spring.', 'The description was lost on the second save.');
        assert.equal(reopened.edges[0].description, 'Reads the mass angle.');
    });

    await run('a selection is saved to my library, filed in sections, placed again, edited, moved and deleted', async () => {
        const userTemplates = () => evaluate(window, `window.componentLibrary.list().then((templates) => templates.filter((template) => template.source === 'user'))`);
        const nodeCount = () => evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`);
        const fillAndSubmit = async (fields) => {
            await evaluate(window, `(() => {
                const fields = ${JSON.stringify(fields)};
                for (const [id, value] of Object.entries(fields)) { const input = document.querySelector('#' + id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
                document.querySelector('#templateSubmit').click();
            })()`);
        };
        const action = (label) => `document.querySelector('.componentLibraryRowAction[aria-label=${JSON.stringify(label)}]').click()`;

        await loadAuthoringProject();
        assert.equal(await evaluate(window, `document.querySelector('#saveTemplateButton').disabled`), true, 'Saving is offered with nothing selected.');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 2`, 'Select all did not select both nodes.');
        assert.equal(await evaluate(window, `document.querySelector('#saveTemplateButton').disabled`), false);
        const nodesBefore = await nodeCount();

        // Saving: the dialog asks for a name, a description and a section, and refuses a section it cannot use.
        await evaluate(window, `document.querySelector('#saveTemplateButton').click()`);
        await waitFor(window, `document.querySelector('#templateDialog').open`, 'The save dialog did not open.');
        assert.equal(await evaluate(window, `document.querySelector('#templateName').value`), 'My component');
        await fillAndSubmit({ templateName: 'Spring pair', templateDescription: 'Two nodes and a link.', templateSection: 'Mechanics / a/b/c/d/e' });
        await waitFor(window, `document.querySelector('#templateDialogError').textContent !== ''`, 'A section nested too deep was accepted.');
        assert.match(await evaluate(window, `document.querySelector('#templateDialogError').textContent`), /at most 4 deep/);
        assert.equal(await evaluate(window, `document.querySelector('#templateDialog').open`), true);
        await fillAndSubmit({ templateSection: 'Mechanics / Springs' });
        await waitFor(window, `!document.querySelector('#templateDialog').open`, 'The save dialog did not close.');
        await waitFor(window, `!document.querySelector('#componentLibraryPanel').hidden && Boolean(document.querySelector('[data-template-id="user_spring_pair"]'))`, 'The saved template did not appear in the library.');

        // It is listed under the sections it was filed in, and kept as it was selected.
        assert.equal(await evaluate(window, `Boolean(document.querySelector('[data-my-library] [data-section-path="Mechanics"] [data-section-path="Mechanics / Springs"] [data-template-id="user_spring_pair"]'))`), true, 'The template is not under its sections.');
        let [saved] = await userTemplates();
        assert.deepEqual([saved.name, saved.description, saved.section, saved.kind], ['Spring pair', 'Two nodes and a link.', ['Mechanics', 'Springs'], 'fragment']);
        assert.deepEqual([saved.fragment.nodes.length, saved.fragment.edges.length], [2, 1]);

        // Placing it adds its nodes under their own names, in one undoable step, and leaves the saved one alone.
        await evaluate(window, `document.querySelector('[data-template-id="user_spring_pair"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].filter((label) => label.textContent.includes('Mass')).length === 2`, 'The saved template was not placed.');
        assert.equal(await nodeCount(), `${Number.parseInt(nodesBefore, 10) + 2} nodes`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await nodeCount(), nodesBefore);

        // Editing renames, re-describes and moves it; the section it left disappears with its last template.
        await evaluate(window, action('Edit Spring pair'));
        await waitFor(window, `document.querySelector('#templateDialog').open && document.querySelector('#templateName').value === 'Spring pair'`, 'The edit dialog did not open on the template.');
        await fillAndSubmit({ templateName: 'Spring pair v2', templateDescription: '', templateSection: 'Mechanics' });
        await waitFor(window, `!document.querySelector('#templateDialog').open`, 'The edit dialog did not close.');
        [saved] = await userTemplates();
        assert.deepEqual([saved.id, saved.name, saved.description, saved.section], ['user_spring_pair', 'Spring pair v2', undefined, ['Mechanics']]);
        assert.equal(await evaluate(window, `Boolean(document.querySelector('[data-section-path="Mechanics / Springs"]'))`), false, 'An emptied section is still listed.');

        // Renaming a section files everything in it under the new name.
        await evaluate(window, action('Rename section Mechanics'));
        await waitFor(window, `document.querySelector('#templateDialog').open && document.querySelector('#templateSection').value === 'Mechanics'`, 'The rename dialog did not open on the section.');
        assert.equal(await evaluate(window, `document.querySelector('[data-template-field="name"]').hidden`), true);
        await fillAndSubmit({ templateSection: 'Machines / Mechanics' });
        await waitFor(window, `!document.querySelector('#templateDialog').open`, 'The rename dialog did not close.');
        [saved] = await userTemplates();
        assert.deepEqual(saved.section, ['Machines', 'Mechanics']);

        // Deleting asks first, then removes it from the library and the panel.
        await evaluate(window, `(() => { window.confirm = () => false; })()`);
        await evaluate(window, action('Delete Spring pair v2'));
        assert.equal((await userTemplates()).length, 1, 'A declined delete removed the template.');
        await evaluate(window, `(() => { window.confirm = () => true; })()`);
        await evaluate(window, action('Delete Spring pair v2'));
        await waitFor(window, `!document.querySelector('[data-template-id="user_spring_pair"]')`, 'The deleted template is still listed.');
        assert.equal((await userTemplates()).length, 0);
        assert.match(await evaluate(window, `document.querySelector('#componentLibraryEmpty').textContent`), /Nothing saved yet/);
        await evaluate(window, `document.querySelector('#closeComponentLibraryPanel').click()`);
    });

    await run('a selection that reads a node it does not include is refused with what to select, and saves once that node is selected too', async () => {
        const userTemplates = () => evaluate(window, `window.componentLibrary.list().then((templates) => templates.filter((template) => template.source === 'user'))`);
        const box = { type: 'primitive', shape: 'box', color: '#888888' };
        // Mass runs a C++ program that reads the angle state of Probe.
        await loadAuthoringProject({
            nodes: [
                {
                    id: 1, name: 'Mass', position: [-4, 0, 0], appearance: box,
                    states: [{ id: 2, name: 'position', symbol: 'position', initialValue: 1 }, { id: 3, name: 'speed', symbol: 'speed', initialValue: 0 }], sourceTerms: [],
                    implementation: { kind: 'cpp', providerApiVersion: 1, source: 'int unused;', bindings: [{ key: 'angle', kind: 'state', nodeId: 4, stateId: 5 }], outputs: [{ key: 'out', stateId: 3 }] }
                },
                {
                    id: 4, name: 'Probe', position: [4, 0, 0], appearance: box,
                    states: [{ id: 5, name: 'angle', symbol: 'angle', initialValue: 0 }, { id: 6, name: 'reading', symbol: 'reading', initialValue: 0 }], sourceTerms: []
                }
            ]
        });
        const saveSelection = async (name) => {
            await evaluate(window, `document.querySelector('#saveTemplateButton').click()`);
            await waitFor(window, `document.querySelector('#templateDialog').open`, 'The save dialog did not open.');
            await evaluate(window, `(() => { const input = document.querySelector('#templateName'); input.value = ${JSON.stringify(name)}; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#templateSubmit').click(); })()`);
        };

        // Only Mass selected: refused, and the dialog stays open saying what is missing and whose it is.
        await openNode('Mass');
        await saveSelection('Reads a probe');
        await waitFor(window, `document.querySelector('#templateDialogError').textContent !== ''`, 'A selection that reads an unselected node was accepted.');
        const reason = await evaluate(window, `document.querySelector('#templateDialogError').textContent`);
        assert.match(reason, /Node "Mass" refers to the node "Probe"/);
        assert.match(reason, /the state "angle" of the node "Probe"/);
        assert.equal(await evaluate(window, `document.querySelector('#templateDialog').open`), true);
        assert.equal((await userTemplates()).length, 0, 'A refused selection was saved anyway.');
        await evaluate(window, `document.querySelector('#templateCancel').click()`);

        // Both selected: the same program now reads something that is in the template, and it saves.
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 2`, 'Select all did not select both nodes.');
        await saveSelection('Reads a probe');
        await waitFor(window, `!document.querySelector('#templateDialog').open`, 'The save dialog did not close once both nodes were selected.');
        const [saved] = await userTemplates();
        assert.equal(saved.name, 'Reads a probe');
        const mass = saved.fragment.nodes.find((node) => node.name === 'Mass');
        const probe = saved.fragment.nodes.find((node) => node.name === 'Probe');
        assert.deepEqual([mass.implementation.bindings[0].nodeId, mass.implementation.bindings[0].stateId], [probe.id, probe.states[0].id], 'The saved program does not read the saved probe.');

        await evaluate(window, `(async () => { await window.componentLibrary.removeUser(${JSON.stringify(saved.id)}); })()`);
        await evaluate(window, `document.querySelector('#closeComponentLibraryPanel').click()`);
    });

    await run('a live parameter is steered with a gamepad, recorded by the size of each change, and the run repeated from its record to the bit', async () => {
        const box = { type: 'primitive', shape: 'box', color: '#888888' };
        // dx/dt = k, with k a live parameter from −10 to 10 in steps of 0.1: x is the area under how k was steered.
        const project = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [],
            nodes: [{
                id: 1, name: 'Integrator', position: [0, 0, 0], appearance: box,
                states: [{ id: 2, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
                sourceTerms: [{
                    id: 3, state: 'x', expression: 'k',
                    parameters: [{ id: 4, name: 'Drive', symbol: 'k', value: 0, unit: '', mode: 'live', control: { minimum: -10, maximum: 10, step: 0.1 } }],
                    expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId: 4, symbol: 'k' }], output: { stateId: 2 }, mathJson: 'k' }
                }]
            }],
            edges: []
        };
        const pad = 'Test pad (STANDARD GAMEPAD Vendor: 0000 Product: 0000)';
        const stick = (value) => evaluate(window, `(() => { const devices = window.__debugSteering.devices; devices.moveAxis(${JSON.stringify(pad)}, 1, ${value}); devices.poll(); })()`);
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(project)}, 'Steered.kjt')`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 1`, 'The integrator did not load.');
        await evaluate(window, `window.__debugSteering.steering.save({ bindings: [] })`);
        // The pad is seen once before it is moved: a pad that turns up reads as where it is, not as a move.
        await evaluate(window, `(() => { const devices = window.__debugSteering.devices; devices.connectGamepad(${JSON.stringify(pad)}); devices.poll(); })()`);

        // Started paused, and moved on by its own time (window.__debugRun.advanceTo) between the stick's moves: the run is going
        // throughout, and each reading reaches it before the step it is meant for, however slowly this machine sends them. A run
        // left to the clock was over before the sixty-three readings were in on a slow runner.
        await openRunDialog(window);
        await evaluate(window, `(() => { document.querySelector('#runTargetTime').value = '8'; document.querySelector('#runOnlineMode').checked = true; document.querySelector('#runOnlineMode').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#runPacingMode').value = 'realTime'; document.querySelector('#startRunPaused').click(); })()`);
        // A run started paused opens its live controls by itself.
        await waitFor(window, `!document.querySelector('#liveParameterPanel').hidden && Boolean(document.querySelector('#liveParameterRows [data-bind]'))`, 'The live control has no Bind… button.', 10000);

        // Bind…, then the stick pushed down: the stick now drives Drive, and says so on its chip.
        await evaluate(window, `document.querySelector('#liveParameterRows [data-bind]').click()`);
        await waitFor(window, `document.querySelector('#liveParameterRows [data-bind]').textContent.startsWith('Move a control')`, 'Bind… did not wait for a control.');
        await stick(-1);
        await waitFor(window, `document.querySelector('#liveParameterRows .inputBindingChip')?.textContent === '🎮 Left stick ↕'`, 'The stick was not bound.');
        const [kept] = (await evaluate(window, `window.__debugSteering.steering.document`)).bindings;
        assert.deepEqual([kept.device.kind, kept.control, kept.parameter, kept.model], ['gamepad', { type: 'axis', index: 1 }, { symbol: 'k', name: 'Drive' }, null]);

        // Steered: sixty-two readings as the stick goes from the centre to most of the way up. The slider follows every one.
        // The readings come 16 ms apart on the window's own clock (window.__debugClock), stopped meanwhile, so which of them are
        // sent, by the size of the change and once the stick has rested, does not depend on how long this machine takes per reading.
        const readings = 62;
        await evaluate(window, `window.__debugClock.stop()`);
        try {
            for (let index = 0; index <= readings; index += 1) {
                await stick(Number((index * 0.01).toFixed(2)));
                await evaluate(window, `window.__debugClock.advance(16)`);
                await evaluate(window, `window.__debugRun.advanceTo(${((index + 1) * 0.1).toFixed(1)})`);
            }
            // Then at rest, long enough for where it came to rest to be sent.
            await evaluate(window, `window.__debugClock.advance(2000)`);
            await waitFor(window, `window.__debugSteering.steering.settled`, 'The stick at rest was not sent.');
        } finally {
            await evaluate(window, `window.__debugClock.resume()`);
        }
        await waitFor(window, `document.querySelector('#liveParameterRows input[type=range]').value === '5.9'`, 'The slider did not follow the stick.');
        // Moved by hand, the slider takes over until the stick moves again.
        await evaluate(window, `(() => { const slider = document.querySelector('#liveParameterRows input[type=range]'); slider.value = '5'; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitFor(window, `/the slider took over/.test(document.querySelector('#liveParameterRows .inputBindingChip').textContent)`, 'The chip did not say the slider took over.');
        await stick(0.7);
        await waitFor(window, `!/the slider took over/.test(document.querySelector('#liveParameterRows .inputBindingChip').textContent)`, 'Moving the stick again did not take the parameter back.');
        // Let go to its end.
        await evaluate(window, `document.querySelector('#simulationPauseResume').click()`);
        await waitFor(window, `document.querySelector('.resultMode small').textContent === 'Model locked'`, 'The steered run did not finish.', 30000);

        // Recorded by the size of each change, and once where the stick came to rest.
        const steered = await evaluate(window, `window.__debugSteering.result()`);
        const values = steered.interventions.map((change) => change.value);
        assert.ok(steered.interventions.every((change) => change.kind === 'value' && change.parameterId === 4), 'Only values for Drive were recorded.');
        // By the size of each change: as the stick went up, each value sent is at least a hundredth of the range (0.2) past the one
        // before, so about every other reading, and then where it came to rest (5.9, a step past the last one sent).
        const steeredValues = values.slice(0, values.indexOf(5.9) + 1);
        const gaps = steeredValues.slice(1).map((value, index) => Math.round((value - steeredValues[index]) * 10) / 10);
        assert.ok(steeredValues.length > 4 && steeredValues.length < readings / 2 + 2, `${steeredValues.length} values were recorded for ${readings} readings: ${values.join(', ')}.`);
        assert.ok(gaps.slice(0, -1).every((gap) => gap >= 0.2), `A change smaller than a hundredth of the range was sent as the stick moved: ${values.join(', ')}.`);
        assert.equal(values.at(-1), 6.7, 'Where the stick came to rest is the last value recorded.');
        assert.ok(values.every((value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-9), `Values off the live steps: ${values.join(', ')}.`);

        // Repeated from the record, with no stick: the changes at the same steps, and the same result to the bit. A repeat is a fork from
        // the run's start, which the web edition, keeping no checkpoints to read back, does not offer.
        if (!driver.capabilities.forks) {
            assert.equal(await evaluate(window, `document.querySelector('#repeatFromRecord').hidden`), true, 'Repeat from the record is offered where a run cannot be forked.');
        } else {
            if (await evaluate(window, `document.querySelector('#controlHistoryPanel').hidden`)) await evaluate(window, `document.querySelector('#controlHistoryButton').click()`);
            await waitFor(window, `!document.querySelector('#repeatFromRecord').hidden`, 'Repeat from the record was not offered for a finished run.');
            await evaluate(window, `window.__debugSteering.devices.disconnectGamepad(${JSON.stringify(pad)}); window.__debugSteering.devices.poll()`);
            await evaluate(window, `document.querySelector('#repeatFromRecord').click()`);
            await waitFor(window, `document.querySelector('#runLaunchDialog').open`, 'Repeating did not open the Run dialog.');
            assert.match(await evaluate(window, `document.querySelector('#runLaunchDescription').textContent`), new RegExp(`^Repeat the run from its start with its record: ${values.length} changes`));
            await evaluate(window, `(() => { document.querySelector('#runOnlineMode').checked = false; document.querySelector('#runOnlineMode').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#startRun').click(); })()`);
            await waitFor(window, `(() => { const result = window.__debugSteering.result(); return result && result.jobId !== ${JSON.stringify(steered.jobId)} && result.lifecycle === 'completed'; })()`, 'The repeat did not finish.', 15000);
            await waitFor(window, `document.querySelector('.resultMode small').textContent === 'Model locked'`, 'The window did not leave the repeat\'s run.', 15000);
            const repeated = await evaluate(window, `window.__debugSteering.result()`);
            assert.deepEqual(repeated.interventions, steered.interventions, 'The repeat did not make the same changes at the same steps.');
            assert.equal(repeated.samples.length, steered.samples.length);
            assert.deepEqual(repeated.samples, steered.samples, 'The repeat differs from the run steered by hand.');
        }

        await evaluate(window, `window.__debugSteering.steering.save({ bindings: [] })`);
        // The window shows the run as over a moment before it lets go of it; results close only once it has.
        await waitFor(window, `window.__debugSteering.result()?.running === false`, 'The window did not let go of the run.', 15000);
        await evaluate(window, `document.querySelector('#closeResults').click()`);
        await waitFor(window, `document.querySelector('#closeResultsDialog').open`, 'Closing results did not request confirmation.');
        await evaluate(window, `document.querySelector('#confirmCloseResults').click()`);
        await waitFor(window, `!document.querySelector('#closeResultsDialog').open && !document.querySelector('#addButton').disabled`, 'Model editing did not re-enable after closing results.');
    }, { skip: !driver.capabilities.heldCommands && 'needs a web engine that holds a command until a time; the engine in the web shell predates it (npm run build:web:threads, then build:webShell:threads)' });

    await run('a live parameter is given a waveform while a run is going', async () => {
        const box = { type: 'primitive', shape: 'box', color: '#888888' };
        // One state that integrates a live parameter k (dx/dt = k): where it ends is the area under k.
        const project = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [],
            nodes: [{
                id: 1, name: 'Integrator', position: [0, 0, 0], appearance: box,
                states: [{ id: 2, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
                sourceTerms: [{
                    id: 3, state: 'x', expression: 'k',
                    parameters: [{ id: 4, name: 'k', symbol: 'k', value: 0, unit: '', mode: 'live', control: { minimum: -10, maximum: 10, step: 0.1 } }],
                    expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId: 4, symbol: 'k' }], output: { stateId: 2 }, mathJson: 'k' }
                }]
            }],
            edges: []
        };
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(project)})`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 1`, 'The integrator did not load.');
        const field = (name) => `document.querySelector('#liveParameterRows [data-wave="${name}"]')`;
        const choose = (mode) => evaluate(window, `(() => { const select = document.querySelector('#liveParameterRows [data-schedule-mode]'); select.value = ${JSON.stringify(mode)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        const set = (name, value) => evaluate(window, `(() => { const input = ${field(name)}; input.value = ${JSON.stringify(String(value))}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);

        // Started paused: the controls below are used on a run that is going but held at its start, so none of them races the run
        // to its end; it is moved on by its own time (window.__debugRun.advanceTo) once the waveform is started.
        await openRunDialog(window);
        await evaluate(window, `(() => { document.querySelector('#runTargetTime').value = '4'; document.querySelector('#runOnlineMode').checked = true; document.querySelector('#runOnlineMode').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#runPacingMode').value = 'realTime'; document.querySelector('#startRunPaused').click(); })()`);
        // A run started paused opens its live controls by itself.
        await waitFor(window, `!document.querySelector('#liveParameterPanel').hidden && Boolean(document.querySelector('#liveParameterRows [data-schedule-mode]'))`, 'The live parameter has no transition controls.', 10000);

        // The menu offers the waveforms, each with the fields that shape it and no others.
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('#liveParameterRows [data-schedule-mode] optgroup[label="Waveform"] option')].map((option) => option.value)`),
            ['waveform:sine', 'waveform:square', 'waveform:triangle', 'waveform:sawtooth', 'waveform:noise']);
        const visible = (names) => evaluate(window, `${JSON.stringify(names)}.map((name) => document.querySelector('#liveParameterRows [data-wave="' + name + '"]').getBoundingClientRect().width > 0)`);
        const labelsShown = () => evaluate(window, `[...document.querySelectorAll('#liveParameterRows .scheduleField > span')].filter((label) => label.getBoundingClientRect().width > 0).map((label) => label.textContent)`);
        assert.equal(await evaluate(window, `document.querySelector('#liveParameterRows .parameterWaveformFields').hidden`), true, 'Waveform fields are shown before a waveform is chosen.');
        await choose('waveform:sine');
        assert.deepEqual(await visible(['amplitude', 'frequency', 'phaseDegrees', 'dutyCycle', 'seed']), [true, true, true, false, false]);
        // Every number in the row says what it is, in words that stay when it holds a value.
        assert.deepEqual(await labelsShown(), ['Duration (s)', 'Amplitude', 'Frequency (Hz)', 'Phase (°)']);
        await choose('waveform:square');
        assert.deepEqual(await visible(['amplitude', 'frequency', 'phaseDegrees', 'dutyCycle', 'seed']), [true, true, true, true, false]);
        assert.deepEqual(await labelsShown(), ['Duration (s)', 'Amplitude', 'Frequency (Hz)', 'Phase (°)', 'Duty cycle']);
        await choose('waveform:noise');
        assert.deepEqual(await visible(['amplitude', 'frequency', 'phaseDegrees', 'dutyCycle', 'seed']), [true, true, false, false, true]);
        assert.deepEqual(await labelsShown(), ['Duration (s)', 'Amplitude', 'Frequency (Hz)', 'Seed']);
        await choose('step');
        assert.equal(await evaluate(window, `document.querySelector('#liveParameterRows .parameterWaveformFields').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#liveParameterRows input[type=range]').hidden`), false, 'The slider is gone with no waveform chosen.');

        // The live range (-10 to 10) is a limit: a value typed outside it is held to it, and the row says so.
        const centre = `document.querySelector('#liveParameterRows input[type="number"]:not([data-wave]):not([data-schedule-duration])')`;
        const type = (value) => evaluate(window, `(() => { const input = ${centre}; input.value = ${JSON.stringify(String(value))}; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await type(100);
        assert.equal(await evaluate(window, `${centre}.value`), '10');
        assert.match(await evaluate(window, `document.querySelector('#statusText').textContent`), /limited to its live range, -10 to 10/);
        await type(0);
        assert.equal(await evaluate(window, `${centre}.value`), '0');

        // A waveform is drawn before it is started: its line, and a caption saying what it swings between and whether that
        // leaves the live range (-10 to 10 here), updated as the fields change.
        const plot = (expression) => evaluate(window, `(() => { const plot = document.querySelector('#liveParameterRows .waveformPreview'); const caption = document.querySelector('#liveParameterRows .waveformCaption'); return ${expression}; })()`);
        await choose('waveform:sine');
        await set('amplitude', 2);
        await set('frequency', 0.5);
        assert.equal(await plot('plot.querySelector(".waveformLine").getAttribute("points").split(" ").length'), 240);
        // It is really on screen, in the slider's place, and the slider is out of the way while it is.
        assert.ok(await plot('plot.getBoundingClientRect().height > 30 && plot.getBoundingClientRect().width > 100'), 'The plot has no size on screen.');
        assert.equal(await plot('document.querySelector("#liveParameterRows input[type=range]").hidden'), true);
        assert.equal(await plot('plot.previousElementSibling === document.querySelector("#liveParameterRows input[type=range]")'), true, 'The plot is not where the slider is.');
        assert.equal(await plot('caption.textContent'), 'Around 0: -2 to 2, 4 s shown');
        await set('amplitude', 15);
        assert.match(await plot('caption.textContent'), /-15 to 15, 4 s shown · goes beyond the live range/);
        await set('amplitude', -1);
        assert.equal(await plot('plot.getBoundingClientRect().height'), 0, 'A waveform that cannot be started is still drawn.');
        assert.equal(await plot('document.querySelector("#liveParameterRows input[type=range]").hidden'), false, 'With nothing to draw, the slider should be back.');
        assert.match(await plot('caption.textContent'), /amplitude/);
        await choose('waveform:square');
        await set('amplitude', 1);
        assert.ok(await plot('plot.getBoundingClientRect().height > 30'), 'A square wave is not drawn.');

        // A waveform that cannot be is refused with a reason, and nothing starts.
        await choose('waveform:noise');
        await set('amplitude', -1);
        await evaluate(window, `document.querySelector('#liveParameterRows [data-schedule-start]').click()`);
        assert.match(await evaluate(window, `document.querySelector('#statusText').textContent`), /amplitude/);

        // Seeded noise around 0 now: the area under it is a random walk, which moves X away from 0.
        await set('amplitude', 5);
        await set('frequency', 5);
        await set('seed', 3);
        await evaluate(window, `document.querySelector('#liveParameterRows [data-schedule-start]').click()`);
        // While it runs, a marker follows the simulation time along the preview, with the value it has right now: seen at one
        // second, then again at two.
        await evaluate(window, `window.__debugRun.advanceTo(1)`);
        await waitFor(window, `Boolean(document.querySelector('#liveParameterRows .waveformNow')) && document.querySelector('#liveParameterRows .waveformDot').getBoundingClientRect().width > 0`, 'No marker followed the running waveform.');
        const markerAt = async () => evaluate(window, `Number(document.querySelector('#liveParameterRows .waveformDot').getAttribute('cx'))`);
        const firstMarker = await markerAt();
        await evaluate(window, `window.__debugRun.advanceTo(2)`);
        await waitFor(window, `Number(document.querySelector('#liveParameterRows .waveformDot').getAttribute('cx')) !== ${firstMarker}`, 'The marker did not move as the simulation advanced.');
        assert.match(await plot('caption.querySelector(".waveformNow").textContent'), /^ · now -?\d/);
        await evaluate(window, `document.querySelector('#simulationPauseResume').click()`);
        await waitFor(window, `document.querySelector('.resultMode small').textContent === 'Model locked'`, 'The run did not complete.', 15000);
        const finalValue = Number((await evaluate(window, `document.querySelector('.node-label-container dd').textContent`)).replace(/[^0-9eE+.-]/g, ''));
        assert.ok(Number.isFinite(finalValue) && finalValue !== 0, `The noise did not move X: it ended at ${finalValue}.`);
        assert.ok(Math.abs(finalValue) <= 5 * 4, `X ended further than the noise could take it: ${finalValue}.`);
        // Closing the results asks first; leave nothing open for the next scenario.
        await evaluate(window, `document.querySelector('#closeResults').click()`);
        await waitFor(window, `document.querySelector('#closeResultsDialog').open`, 'Closing results did not request confirmation.');
        await evaluate(window, `document.querySelector('#confirmCloseResults').click()`);
        await waitFor(window, `!document.querySelector('#closeResultsDialog').open && !document.querySelector('#addButton').disabled`, 'Model editing did not re-enable after closing results.');
    }, { skip: !(driver.capabilities.parameterWaveforms && driver.capabilities.heldCommands) && 'needs a web engine built with waveform schedules and held commands; the engine in the web shell predates them (npm run build:web:threads, then build:webShell:threads)' });

    await run('a thermal link joins two bodies with two directed edges sharing one conductance, and one-way conduction leaves a boundary alone', async () => {
        const box = { type: 'primitive', shape: 'box', color: '#888888' };
        const thermal = (id, name, x, temperature) => ({ id, name, position: [x, 0, 0], appearance: box, states: [{ id: id + 1, name: 'Temperature', symbol: 'temperature', initialValue: temperature, unit: 'K' }], sourceTerms: [] });
        const project = (nodes) => ({ format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], nodes, edges: [] });
        const saved = () => evaluate(window, `window.__debugProject.serialize()`);
        const load = async (nodes) => {
            await evaluate(window, `window.__debugProject.load(${JSON.stringify(project(nodes))})`);
            await waitFor(window, `document.querySelectorAll('.node-label-container').length === ${nodes.length}`, 'The thermal bodies did not load.');
        };
        const openLibrary = async () => {
            if (await evaluate(window, `document.querySelector('#componentLibraryPanel').hidden`)) await evaluate(window, `document.querySelector('#componentLibraryButton').click()`);
            await waitFor(window, `Boolean(document.querySelector('[data-template-id="thermalLink"]')) && Boolean(document.querySelector('[data-template-id="oneWayConduction"]'))`, 'The thermal templates are not in the library.');
        };
        const selectBoth = async () => {
            await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, ctrlKey: true, bubbles: true }))`);
            await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 2`, 'Select all did not select both bodies.');
        };

        // The bundle: two directed edges, one each way, sharing one conductance, each explaining itself.
        await load([thermal(1, 'Pack', -2, 350), thermal(10, 'Housing', 2, 300)]);
        await openLibrary();
        await selectBoth();
        await evaluate(window, `document.querySelector('[data-template-id="thermalLink"]').click()`);
        await waitFor(window, `window.__debugProject.serialize().edges.length === 2`, 'The Thermal link did not create its two edges.');
        let document_ = await saved();
        assert.deepEqual(document_.edges.map((edge) => edge.directionality), ['directed', 'directed']);
        assert.deepEqual(document_.edges.map((edge) => edge.name).sort(), ['Heat into first body', 'Heat into second body']);
        // They run in opposite directions between the same two bodies.
        const [first, second] = document_.edges;
        assert.deepEqual([first.source.nodeId, first.target.nodeId], [second.target.nodeId, second.source.nodeId]);
        assert.ok(document_.edges.every((edge) => edge.description?.length > 30), 'An edge of the link carries no explanation.');
        // One shared Conductance, linked from both, and a thermal capacitance of each edge's own.
        assert.deepEqual(document_.sharedParameters.map((shared) => shared.name), ['Conductance']);
        assert.deepEqual(document_.edges.map((edge) => edge.parameters.find((parameter) => parameter.symbol === 'conductance').sharedParameterId), [document_.sharedParameters[0].id, document_.sharedParameters[0].id]);
        assert.deepEqual(document_.edges.map((edge) => edge.parameters.find((parameter) => parameter.symbol === 'thermalCapacitance').name).sort(), ["First body's thermal capacitance", "Second body's thermal capacitance"]);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        document_ = await saved();
        assert.equal(document_.edges.length, 0, 'Undo left a thermal link edge behind.');
        assert.equal((document_.sharedParameters ?? []).length, 0, 'Undo left the shared conductance behind.');

        // One-way conduction: picked from the boundary to the mass, directed, so nothing is done to the boundary.
        await load([thermal(1, 'Boundary', -2, 350), thermal(10, 'Mass', 2, 300)]);
        await openLibrary();
        await evaluate(window, `document.querySelector('[data-template-id="oneWayConduction"]').click()`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'Applying the edge template did not arm endpoint picking.');
        const pick = (name) => evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes(${JSON.stringify(name)}))?.click()`);
        await pick('Boundary');
        await waitFor(window, `document.querySelector('#endpointPickTitle').textContent.includes('target')`, 'Picking did not move on to the target.');
        await pick('Mass');
        await waitFor(window, `window.__debugProject.serialize().edges.length === 1`, 'One-way conduction was not made once both bodies were picked.');
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`, 'One-way conduction did not open its card.');
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeDirectionality').value`), 'directed');
        const [edge] = (await saved()).edges;
        assert.equal(edge.directionality, 'directed');
        assert.deepEqual([edge.source.nodeId, edge.target.nodeId], [1, 10], 'The heat does not flow from the boundary to the mass.');
        assert.ok(edge.description.length > 30);
        await evaluate(window, `document.querySelector('#closeComponentLibraryPanel').click()`);
    });

    await run('a run started paused opens the live controls before anything moves, and a value set there applies from the first step', async () => {
        const box = { type: 'primitive', shape: 'box', color: '#888888' };
        // One state that integrates a live parameter k (dx/dt = k): where it ends is the area under k.
        const project = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [],
            nodes: [{
                id: 1, name: 'Integrator', position: [0, 0, 0], appearance: box,
                states: [{ id: 2, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
                sourceTerms: [{
                    id: 3, state: 'x', expression: 'k',
                    parameters: [{ id: 4, name: 'k', symbol: 'k', value: 0, unit: '', mode: 'live', control: { minimum: -10, maximum: 10, step: 0.1 } }],
                    expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId: 4, symbol: 'k' }], output: { stateId: 2 }, mathJson: 'k' }
                }]
            }],
            edges: []
        };
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(project)})`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 1`, 'The integrator did not load.');
        const shownValue = async () => Number((await evaluate(window, `document.querySelector('.node-label-container dd').textContent`)).replace(/[^0-9eE+.-]/g, ''));

        // The button appears with the online switch, which is what the live controls need, and not before.
        await openRunDialog(window);
        await evaluate(window, `(() => { const online = document.querySelector('#runOnlineMode'); online.checked = false; online.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(window, `document.querySelector('#startRunPaused').getBoundingClientRect().width`), 0, 'Start paused is shown for an offline run, which has no live controls.');
        await evaluate(window, `(() => { document.querySelector('#runTargetTime').value = '1.5'; const online = document.querySelector('#runOnlineMode'); online.checked = true; online.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#runPacingMode').value = 'realTime'; })()`);
        assert.ok(await evaluate(window, `document.querySelector('#startRunPaused').getBoundingClientRect().width > 0`), 'Start paused did not appear once online simulation was on.');
        await evaluate(window, `document.querySelector('#startRunPaused').click()`);

        // Held before the first step, with the controls already open.
        await waitFor(window, `document.querySelector('.resultMode small').textContent === 'Paused · model locked'`, 'The run was not paused.', 10000);
        await waitFor(window, `!document.querySelector('#liveParameterPanel').hidden && Boolean(document.querySelector('#liveParameterRows input[type="number"]'))`, 'The live controls did not open by themselves.');
        await new Promise((resolve) => setTimeout(resolve, 800));
        assert.equal(await evaluate(window, `document.querySelector('#resultCurrentTime').value`), '0 s', 'The run moved while it was meant to be held.');
        assert.match(await evaluate(window, `document.querySelector('#simulationProgress').value`), /^0 s \/ 1\.5 s$/);
        assert.equal(await shownValue(), 0);

        // A value set while held, then resume: it applied from step zero, so the area is exactly 5 x 1.5.
        await evaluate(window, `(() => { const input = document.querySelector('#liveParameterRows input[type="number"]:not([data-wave]):not([data-schedule-duration])'); input.value = '5'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await evaluate(window, `document.querySelector('#simulationPauseResume').click()`);
        await waitFor(window, `document.querySelector('.resultMode small').textContent === 'Model locked'`, 'The run did not complete after it was resumed.', 15000);
        assert.ok(Math.abs(await shownValue() - 7.5) < 1e-6, `Expected 5 x 1.5 = 7.5, got ${await shownValue()}.`);

        await evaluate(window, `document.querySelector('#closeResults').click()`);
        await waitFor(window, `document.querySelector('#closeResultsDialog').open`, 'Closing results did not request confirmation.');
        await evaluate(window, `document.querySelector('#confirmCloseResults').click()`);
        await waitFor(window, `!document.querySelector('#closeResultsDialog').open && !document.querySelector('#addButton').disabled`, 'Model editing did not re-enable after closing results.');
    }, { skip: !driver.capabilities.startPausedRuns && 'needs a web engine built with the startPaused run setting; the engine in the web shell predates it (npm run build:web:threads, then build:webShell:threads)' });

    await run('the changes made to the controls during a run are plotted for each parameter in a panel at the left', async () => {
        const box = { type: 'primitive', shape: 'box', color: '#888888' };
        const project = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [],
            nodes: [{
                id: 1, name: 'Integrator', position: [0, 0, 0], appearance: box,
                states: [{ id: 2, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
                sourceTerms: [{
                    id: 3, state: 'x', expression: 'k',
                    parameters: [{ id: 4, name: 'Drive', symbol: 'k', value: 1, unit: 'm/s', mode: 'live', control: { minimum: -10, maximum: 10, step: 0.1 } }],
                    expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId: 4, symbol: 'k' }], output: { stateId: 2 }, mathJson: 'k' }
                }]
            }],
            edges: []
        };
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(project)})`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 1`, 'The integrator did not load.');
        const centre = `document.querySelector('#liveParameterRows input[type="number"]:not([data-wave]):not([data-schedule-duration])')`;
        const type = (value) => evaluate(window, `(() => { const input = ${centre}; input.value = ${JSON.stringify(String(value))}; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        const visible = (selector) => evaluate(window, `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().width > 0`);

        // Entering live mode opens the panel at once, with nothing in it yet, and says so.
        await openRunDialog(window);
        await evaluate(window, `(() => { document.querySelector('#runTargetTime').value = '2.5'; const online = document.querySelector('#runOnlineMode'); online.checked = true; online.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#runPacingMode').value = 'realTime'; })()`);
        await evaluate(window, `document.querySelector('#startRunPaused').click()`);
        await waitFor(window, `!document.querySelector('#liveParameterPanel').hidden && Boolean(document.querySelector('#liveParameterRows input[type="number"]'))`, 'The live controls did not open.');
        await waitFor(window, `document.querySelector('#controlHistoryPanel').getBoundingClientRect().width > 0`, 'The changes panel did not open by default in live mode.');
        assert.equal(await visible('#controlHistoryButton'), true, 'The changes button is not offered in live mode.');
        assert.equal(await evaluate(window, `document.querySelectorAll('#controlHistoryList .controlHistoryCard').length`), 0);
        assert.match(await evaluate(window, `document.querySelector('#controlHistoryEmpty').textContent`), /No control has been changed yet/);
        assert.ok(await visible('#controlHistoryEmpty'));

        // One change while held: its plot appears by itself, in the panel that is already open.
        await type(5);
        await waitFor(window, `document.querySelectorAll('#controlHistoryList .controlHistoryCard').length === 1`, 'The change was not plotted in the panel that was open.', 10000);
        assert.equal(await visible('#controlHistoryEmpty'), false);
        assert.equal(await evaluate(window, `document.querySelector('#controlHistoryCount').textContent`), '1');

        // Closing the panel is respected: it does not open itself again when the run goes on and the controls are used again.
        await evaluate(window, `document.querySelector('#closeControlHistoryPanel').click()`);
        assert.equal(await visible('#controlHistoryPanel'), false);
        // Moved on by its own time to one second (window.__debugRun.advanceTo), where it is held for the second change, so the change
        // lands there however slowly it is sent; then let go to its end.
        await evaluate(window, `window.__debugRun.advanceTo(1)`);
        await type(2);
        assert.equal(await visible('#controlHistoryPanel'), false, 'The panel opened itself again after it was closed.');
        await evaluate(window, `document.querySelector('#simulationPauseResume').click()`);
        await waitFor(window, `document.querySelector('.resultMode small').textContent === 'Model locked'`, 'The run did not complete.', 20000);
        assert.equal(await evaluate(window, `document.querySelector('#controlHistoryCount').textContent`), '1', 'One parameter was changed.');

        // Opened again, the panel has one card for the one parameter, a plot with a size, and a marker for each change saying what it was.
        await evaluate(window, `document.querySelector('#controlHistoryButton').click()`);
        await waitFor(window, `document.querySelector('#controlHistoryPanel').getBoundingClientRect().width > 0`, 'The changes panel did not open.');
        assert.equal(await evaluate(window, `document.querySelectorAll('#controlHistoryList .controlHistoryCard').length`), 1);
        assert.equal(await evaluate(window, `document.querySelector('#controlHistoryList .controlHistoryCard header strong').textContent`), 'Drive');
        assert.ok(await evaluate(window, `document.querySelector('.controlHistoryPlot').getBoundingClientRect().height > 40`), 'The plot has no size on screen.');
        assert.ok(await evaluate(window, `document.querySelector('.controlHistoryLine').getAttribute('points').split(' ').length > 100`));
        const marks = await evaluate(window, `[...document.querySelectorAll('.controlHistoryMark title')].map((title) => title.textContent)`);
        assert.equal(marks.length, 2);
        assert.equal(marks[0], '0 s · Set to 5 m/s');
        assert.match(marks[1], /^[0-9.]+ s · Set to 2 m\/s$/);
        assert.ok(Number(marks[1].split(' s')[0]) > 0.4, `The second change was recorded at ${marks[1]}.`);
        assert.match(await evaluate(window, `document.querySelector('.controlHistoryCaption').textContent`), /2 changes · from 2 to 5 m\/s/);
        assert.equal((await evaluate(window, `document.querySelectorAll('.controlHistoryChanges li').length`)), 2);

        // It starts from the model's own value (1) and ends at 2: the line is drawn from the left edge to the right.
        const slope = await evaluate(window, `(() => { const points = document.querySelector('.controlHistoryLine').getAttribute('points').split(' ').map((point) => point.split(',').map(Number)); return { first: points[0], last: points.at(-1) }; })()`);
        assert.ok(slope.first[0] < 35 && slope.last[0] > 290, 'The line does not run the width of the plot.');

        // The cursor follows the playback position.
        await evaluate(window, `(() => { const timeline = document.querySelector('#resultTimeline'); timeline.value = '0'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        const cursorAt = () => evaluate(window, `Number(document.querySelector('.controlHistoryCursor').getAttribute('x1'))`);
        const atStart = await cursorAt();
        await evaluate(window, `(() => { const timeline = document.querySelector('#resultTimeline'); timeline.value = timeline.max; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        assert.ok(await cursorAt() > atStart + 200, 'The cursor did not move along the plot with the playback position.');

        // Add-ons are given the same series.
        // Closing the results takes the panel and the button away.
        await evaluate(window, `document.querySelector('#closeResults').click()`);
        await waitFor(window, `document.querySelector('#closeResultsDialog').open`, 'Closing results did not request confirmation.');
        await evaluate(window, `document.querySelector('#confirmCloseResults').click()`);
        await waitFor(window, `!document.querySelector('#closeResultsDialog').open && !document.querySelector('#addButton').disabled`, 'Model editing did not re-enable after closing results.');
        assert.equal(await visible('#controlHistoryPanel'), false);
        assert.equal(await visible('#controlHistoryButton'), false);
    }, { skip: !(driver.capabilities.startPausedRuns && driver.capabilities.heldCommands) && 'needs a web engine that records the changes it applies and holds commands; the engine in the web shell predates it (npm run build:web:threads, then build:webShell:threads)' });

    // ---- Making nodes, states, terms and relationships, each undone and redone ----------------------------------------
    // Each through the button a person presses, with a real click: the scenarios further on use these as steps. A real click
    // lands a moment after it is sent, so each step waits for what it does.
    const nodeLabel = (title) => `[...document.querySelectorAll('.objectLabel')].find((item) => item.textContent.includes(${JSON.stringify(title)}))`;
    // Found as a person finds one in a long list, by searching for its name; the search is cleared once it is placed (`placed`,
    // an expression), not before the click lands, which would redraw the list under it.
    const placeFromLibrary = async (id, name, placed) => {
        if (await evaluate(window, `document.querySelector('#componentLibraryPanel').hidden`)) await clickElement(window, `document.querySelector('#componentLibraryButton')`);
        const search = (text) => evaluate(window, `(() => { const input = document.querySelector('#componentLibrarySearch'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitFor(window, `!document.querySelector('#componentLibraryPanel').hidden`, 'The library did not open.');
        await search(name);
        await waitFor(window, `Boolean(document.querySelector('[data-template-id="${id}"]'))`, `Searching the library for ${name} did not find it.`);
        await clickElement(window, `document.querySelector('[data-template-id="${id}"]')`);
        await waitFor(window, placed, `${name} was not placed.`);
        await search('');
    };

    await run('every editor card has one order of tabs, one width, its actions on every tab, the tab last chosen for its kind, and nothing to change while results are open', async () => {
        await freshExample();
        const openNode = async (title) => {
            await clickElement(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes(${JSON.stringify(title)}) && !label.textContent.includes('copy'))`);
            await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden') && document.querySelector('#editNodeName').value === ${JSON.stringify(title)}`, `${title} did not open.`);
        };
        const openRelationship = async (title) => {
            await evaluate(window, `(() => { const edge = window.__debugProject.serialize().edges.find((item) => item.name === ${JSON.stringify(title)}); document.querySelector('.relationshipRow[data-relationship="' + edge.id + '"]').click(); })()`);
            await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden') && document.querySelector('#editEdgeName').value === ${JSON.stringify(title)}`, `${title} did not open.`);
        };
        const tabs = (card) => evaluate(window, `[...document.querySelectorAll('#${card} [data-editor-tab]')].map((tab) => tab.dataset.editorTab)`);
        const activeTab = (card) => evaluate(window, `document.querySelector('#${card} [data-editor-tab].active').dataset.editorTab`);
        const width = (card) => evaluate(window, `Math.round(document.querySelector('#${card}').getBoundingClientRect().width)`);
        const edges = (await evaluate(window, `window.__debugProject.serialize().edges.map((edge) => edge.name)`)).filter((name, index, all) => all.indexOf(name) === index);

        // One order of tabs, each kind leaving out what it has nothing for, and one width.
        await openNode('Battery module');
        assert.deepEqual(await tabs('nodeEditor'), ['equations', 'parameters', 'details', 'results', 'numerics', 'appearance']);
        assert.equal(await activeTab('nodeEditor'), 'equations', 'A node first opens on Equations.');
        const cardWidth = await width('nodeEditor');
        await openRelationship(edges[0]);
        assert.deepEqual(await tabs('edgeEditor'), ['equations', 'parameters', 'details', 'results', 'appearance']);
        assert.equal(await width('edgeEditor'), cardWidth, 'A relationship\'s card is not as wide as a node\'s.');

        // The tab a person chose is the one the kind opens on next, on another node or relationship too; the footer stays.
        await openNode('Battery module');
        await clickElement(window, `document.querySelector('#nodeEditor [data-editor-tab="appearance"]')`);
        await waitFor(window, `!document.querySelector('#nodeEditor [data-editor-panel="appearance"]').hidden`, 'Appearance did not open.');
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#nodeModelActions')).display !== 'none'`), true, 'The node\'s actions are not on its Appearance tab.');
        await openNode('Enclosed air');
        assert.equal(await activeTab('nodeEditor'), 'appearance', 'Another node did not open on the tab last chosen.');
        await openRelationship(edges[0]);
        await clickElement(window, `document.querySelector('#edgeEditor [data-editor-tab="parameters"]')`);
        await openRelationship(edges[1]);
        assert.equal(await activeTab('edgeEditor'), 'parameters', 'Another relationship did not open on the tab last chosen.');

        // A relationship group's card is a relationship's, tab for tab, but Results: each of its members has its own.
        await evaluate(window, `(() => { window.confirm = () => true; window.__debugTransform.selectExactly(window.__debugTransform.allNodeIds().slice(0, 2)); document.querySelector('#createEdgeGroup').click(); })()`);
        await waitFor(window, `!document.querySelector('#edgeGroupEditor').classList.contains('hidden')`, 'The relationship group did not open.');
        assert.deepEqual(await tabs('edgeGroupEditor'), (await tabs('edgeEditor')).filter((tab) => tab !== 'results'));
        assert.equal(await width('edgeGroupEditor'), cardWidth);
        await evaluate(window, `(() => { document.activeElement?.blur(); document.querySelector('#undoButton').click(); })()`);

        // Opening a project starts every kind on its first tab again.
        await freshExample();
        await openNode('Battery module');
        assert.equal(await activeTab('nodeEditor'), 'equations', 'A new project kept the tab chosen in the one before.');

        // A source term, then a run: while its results are open, every card's inputs are off, the source term's included, but
        // what only goes somewhere (a term on a state's card) still goes there.
        await writeOwnPart(window, 'temperature', '0');
        await openRunDialog(window);
        await evaluate(window, `(() => { document.querySelector('#runTargetTime').value = '0.5'; document.querySelector('#startRun').click(); })()`);
        // The line under Results keeps its words after results close, so the transport showing says these are this run's.
        await waitFor(window, `!document.querySelector('#resultTransport').hidden && document.querySelector('.resultMode small')?.textContent === 'Model locked'`, 'The run did not finish.', 30000);
        await openNode('Battery module');
        assert.equal(await activeTab('nodeEditor'), 'results', 'A node does not open on Results while results are open.');
        assert.equal(await evaluate(window, `document.querySelector('#editNodeName').disabled && [...document.querySelectorAll('#nodeModelActions button')].every((button) => button.disabled)`), true);
        await clickElement(window, `document.querySelector('#nodeEditor [data-editor-tab="equations"]')`);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('#nodeEditorStates .ownPart')].every((field) => field.readOnly)`), true, 'A node\'s own part can be typed in while results are open.');
        assert.equal(await evaluate(window, `[...document.querySelectorAll('#nodeEditorStates .partChip, #nodeEditorStates .stateSummary')].every((control) => !control.disabled)`), true, 'What only goes somewhere is off while results are open.');
        await clickElement(window, `document.querySelector('#nodeEditor [data-editor-tab="parameters"]')`);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('#nodeEditorParameters :is(input, select, button)')].every((control) => control.disabled)`), true, 'A node\'s own parameters can be changed while results are open.');
        await evaluate(window, `document.querySelector('#closeResults').click()`);
        await waitFor(window, `document.querySelector('#closeResultsDialog').open`, 'Closing the results did not ask.');
        await evaluate(window, `document.querySelector('#confirmCloseResults').click()`);
        await waitFor(window, `document.querySelector('#resultTransport').hidden`, 'The results did not close.');
    });

    await run('+ State adds a state, and a node\'s own part typed into a state\'s equation lands on that state, each undone and redone', async () => {
        await loadAuthoringProject();
        await openNode('Mass');
        await clickElement(window, `document.querySelector('#editAddState')`);
        await waitFor(window, `window.__debugProject.serialize().nodes[0].states.length === 3`, '+ State added no state.');
        // Nothing changes it yet, so it is on a folded line, with the states beside it that start alike.
        const added = (await savedProject()).nodes[0].states[2].symbol;
        assert.equal(await evaluate(window, `Boolean(document.querySelector('#nodeEditorStates .stateFold[data-symbols~="${added}"]'))`), true, 'The new state is not on a line of the Equations tab.');
        await undoRedo('undo');
        assert.equal((await savedProject()).nodes[0].states.length, 2, 'Undo left the new state behind.');
        await undoRedo('redo');
        assert.equal((await savedProject()).nodes[0].states.length, 3, 'Redo did not bring the state back.');
        await undoRedo('undo');

        // In the second state's field, not the first's: the part lands on the state it is typed into.
        await openNode('Mass');
        await writeOwnPart(window, 'speed', '\\mathrm{position}');
        const terms = () => savedProject().then((project) => project.nodes[0].sourceTerms);
        assert.deepEqual((await terms()).map((term) => term.state), ['speed']);
        await undoRedo('undo');
        assert.equal((await terms()).length, 0, 'Undo left the new term behind.');
        await undoRedo('redo');
        assert.deepEqual((await terms()).map((term) => term.state), ['speed'], 'Redo did not bring the term back on its state.');
    });

    await run('New relationship picks each end on the canvas, lands on its target\'s first state, and one undo takes it away', async () => {
        await loadAuthoringProject();
        await clickElement(window, `document.querySelector('#addButton')`);
        await clickElement(window, `document.querySelector('[data-add-kind="edge"]')`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden && /source/.test(document.querySelector('#endpointPickTitle').textContent)`, 'New relationship did not start by picking its source.');
        await clickElement(window, nodeLabel('Probe'));
        await waitFor(window, `/target/.test(document.querySelector('#endpointPickTitle').textContent)`, 'Clicking Probe did not pick the source.');
        await clickElement(window, nodeLabel('Mass'));
        await waitFor(window, `document.querySelector('#endpointPickBanner').hidden`, 'Clicking Mass did not pick the target.');
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`, 'The new relationship did not open its card.');
        // While only the source was known, its states must not have become where the part lands.
        const made = (await savedProject()).edges.find((edge) => edge.id !== 7);
        assert.deepEqual([made.source.nodeId, made.target.nodeId, made.equationModel.output], [4, 1, { role: 'target', stateId: 2 }]);
        await undoRedo('undo');
        assert.equal((await savedProject()).edges.length, 1, 'Undo left the new relationship behind.');
        await undoRedo('redo');
        assert.equal((await savedProject()).edges.length, 2, 'Redo did not bring the relationship back.');
    });

    // A model that says no kind of any state (every node settling) and one that says them: the engine reads each by its own rules,
    // and one state saying its kind anywhere is enough to read the whole file by the second.
    const kindsBox = { type: 'primitive', shape: 'box', color: '#888888' };
    const kindsTerm = (id, state, stateId, latex, mathJson, bindings, setsValue) => ({ id, state, expression: latex, expressionModel: { latex, mathJson, bindings, output: { stateId } }, ...(setsValue ? { setsValue: true } : {}) });
    // x rises at 1/s; y = 2x and z = y + 1 are set directly, which in a file saying no kinds settles within the step.
    const chainNode = (overrides = {}) => ({
        id: 1, name: 'Chain', position: [-2, 0, 0], appearance: kindsBox,
        states: [{ id: 2, name: 'X', symbol: 'x', initialValue: 0 }, { id: 3, name: 'Y', symbol: 'y', initialValue: 0 }, { id: 4, name: 'Z', symbol: 'z', initialValue: 0 }],
        sourceTerms: [
            kindsTerm(5, 'x', 2, '1', 1, [], false),
            kindsTerm(6, 'y', 3, '2\\cdot x', ['Multiply', 2, 'x'], [{ symbol: 'x', kind: 'state', nodeId: 1, stateId: 2 }], true),
            kindsTerm(7, 'z', 4, 'y+1', ['Add', 'y', 1], [{ symbol: 'y', kind: 'state', nodeId: 1, stateId: 3 }], true)
        ],
        ...overrides
    });
    const kindsProject = (nodes) => ({ format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], nodes, edges: [] });
    const loadKinds = async (nodes) => {
        await evaluate(window, `(async () => { document.querySelectorAll('.contextCard').forEach((card) => card.classList.add('hidden')); await window.__debugProject.load(${JSON.stringify(kindsProject(nodes))}); })()`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === ${nodes.length}`, 'The model did not load.');
    };
    const kindsOf = (node) => [node.updates ?? null, ...node.states.map((state) => state.kind ?? null), ...node.sourceTerms.map((term) => term.setsValue ?? null)];

    await run('a node pasted or a part placed into a model saying its states\' kinds otherwise keeps the numbers of both, as one undoable step', async () => {
        const saying = { id: 30, name: 'Other', position: [2, 0, 0], appearance: kindsBox, states: [{ id: 31, name: 'Q', symbol: 'q', initialValue: 0, kind: 'rate' }], sourceTerms: [] };
        const copyNode = async (id, name) => {
            await evaluate(window, `window.__debugTransform.selectExactly([${id}])`);
            await clickElement(window, `document.querySelector('#copySelection')`);
            await waitFor(window, `window.modelClipboard.read()?.nodes?.[0]?.name === ${JSON.stringify(name)}`, `${name} was not copied.`);
        };
        const paste = async (count) => {
            await evaluate(window, `window.__debugTransform.selectExactly([])`);
            await clickElement(window, `document.querySelector('#pasteSelection')`);
            await waitFor(window, `window.__debugProject.serialize().nodes.length === ${count}`, 'Paste put nothing in.');
        };
        const chain = async () => (await savedProject()).nodes.find((node) => node.name.startsWith('Chain'));

        // Into a model that says no kinds, a node that says its kind: the model says them too, as it is read now, so Chain's
        // values still settle (z = 2x + 1 in the step, not a step late). Undo puts Chain back as it was.
        await loadKinds([saying]);
        await copyNode(30, 'Other');
        await loadKinds([chainNode()]);
        const asLoaded = kindsOf(await chain());
        await paste(2);
        assert.deepEqual(kindsOf(await chain()), ['settle', 'rate', 'update', 'update', null, null, null], 'Chain\'s values no longer settle in the step.');
        await undoRedo('undo');
        assert.deepEqual(kindsOf(await chain()), asLoaded, 'Undo left Chain saying its kinds.');
        assert.equal((await savedProject()).nodes.length, 1);
        await undoRedo('redo');
        assert.deepEqual(kindsOf(await chain()), ['settle', 'rate', 'update', 'update', null, null, null], 'Redo did not say Chain\'s kinds again.');

        // The other way: Chain, saying none, pasted into a model that says its kinds, says them before it goes in.
        await loadKinds([chainNode()]);
        await copyNode(1, 'Chain');
        await loadKinds([saying]);
        await paste(2);
        assert.deepEqual(kindsOf(await chain()), ['settle', 'rate', 'update', 'update', null, null, null], 'Pasted Chain\'s values no longer settle in the step.');
        assert.equal((await savedProject()).nodes.find((node) => node.name === 'Other').states[0].kind, 'rate');

        // A library assembly, which says no kinds, placed into a model that says them: its program's outputs are Updates that settle.
        // The bundled assemblies carry a C++ program, which the web edition's library leaves out.
        if (!driver.capabilities.cppProviders) return;
        await loadKinds([saying]);
        await placeFromLibrary('pidIsa', 'PID controller (ISA', `window.__debugProject.serialize().nodes.length === 2`);
        const pid = (await savedProject()).nodes.find((node) => node.name !== 'Other');
        assert.ok(pid.states.every((state) => state.kind), 'The placed PID controller says no kinds in a model that says them.');
        assert.equal(pid.updates, 'settle', 'The placed PID controller\'s updates no longer settle.');
        await evaluate(window, `document.querySelector('#componentLibraryButton').click()`);
    });

    await run('a node switched off keeps its values set directly, and shows its own equations, when the model is made to say its kinds', async () => {
        const gauge = { id: 30, name: 'Gauge', position: [2, 0, 0], appearance: kindsBox, states: [{ id: 31, name: 'Reading', symbol: 'reading', initialValue: 0 }, { id: 33, name: 'Offset', symbol: 'offset', initialValue: 0 }], sourceTerms: [kindsTerm(32, 'reading', 31, '5', 5, [], true)] };
        await loadKinds([chainNode({ enabled: false }), gauge]);
        // A part typed into an Update in a model that says no kinds sets its value as the state's other part does, and the model
        // still says none: nothing else changes.
        await openNode('Gauge');
        await writeOwnPart(window, 'reading', '5+1');
        const reading = (await savedProject()).nodes[1].sourceTerms.filter((term) => term.state === 'reading');
        assert.deepEqual(reading.map((term) => term.setsValue ?? null), [true], 'The part typed into a value set directly does not set it.');
        assert.ok((await savedProject()).nodes.every((node) => node.states.every((state) => state.kind === undefined)), 'Typing a part made the model say its kinds.');
        // Choosing a state's kind makes it say them all, the switched-off Chain included.
        await writeOwnPart(window, 'offset', '1');
        await evaluate(window, `document.querySelector('#nodeEditorStates .stateCard[data-symbol="offset"] .stateKind').click()`);
        await evaluate(window, `document.querySelector('#nodeEditorStates .stateCard[data-symbol="offset"] .kindOption[data-kind="update"]').click()`);
        await waitFor(window, `window.__debugProject.serialize().nodes[0].states.some((state) => state.kind)`, 'Choosing a kind did not make the model say its kinds.');
        assert.deepEqual(kindsOf((await savedProject()).nodes[0]), ['settle', 'rate', 'update', 'update', null, null, null],
            'Switched off, Chain\'s values set directly became rates, which it would integrate once switched back on.');
        // Its Equations tab shows each of its terms on its state, marked off, not as terms reaching no state.
        await evaluate(window, `document.querySelectorAll('.contextCard').forEach((card) => card.classList.add('hidden'))`);
        await openNode('Chain');
        assert.deepEqual(await evaluate(window, `['x', 'y', 'z'].map((symbol) => document.querySelectorAll('#nodeEditorStates .stateCard[data-symbol="' + symbol + '"] .ownPart.off').length)`), [1, 1, 1]);
        assert.equal(await evaluate(window, `document.querySelector('#nodeEditorStrayTerms').hidden`), true, 'Its own terms are listed as reaching no state.');
    });

    await run('Undo after opening a project undoes what was done in it, not an equation left half-written in the project before', async () => {
        const gauge = { id: 30, name: 'Gauge', position: [2, 0, 0], appearance: kindsBox, states: [{ id: 31, name: 'Reading', symbol: 'reading', initialValue: 0 }], sourceTerms: [kindsTerm(32, 'reading', 31, '5', 5, [], false)] };
        await loadKinds([gauge]);
        await openNode('Gauge');
        // Typing in its own part, not yet left.
        await evaluate(window, `(() => { const field = document.querySelector('#nodeEditorStates .stateCard[data-symbol="reading"] .ownPart'); field.focus(); field.setValue('7'); field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        // Another project opened while the equation is still being written; there, a Thermal link is placed and undone.
        const body = (id, name, x) => ({ id, name, position: [x, 0, 0], appearance: kindsBox, states: [{ id: id + 1, name: 'Temperature', symbol: 'temperature', initialValue: 300, unit: 'K' }], sourceTerms: [] });
        await loadKinds([body(1, 'Pack', -2), body(10, 'Housing', 2)]);
        await evaluate(window, `window.__debugTransform.selectExactly([1, 10])`);
        await placeFromLibrary('thermalLink', 'Thermal link', `window.__debugProject.serialize().edges.length === 2`);
        await evaluate(window, `document.querySelector('#componentLibraryButton').click()`);
        await undoRedo('undo');
        assert.equal((await savedProject()).edges.length, 0, 'Undo did not take the Thermal link away.');
        await undoRedo('redo');
        assert.equal((await savedProject()).edges.length, 2, 'Redo did not bring the Thermal link back.');
        // The field left half-written in the project before, losing the focus now, draws nothing over this project's node.
        await evaluate(window, `document.activeElement?.blur()`);
        await openNode('Pack');
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(await evaluate(window, `document.querySelector('#editNodeName').value`), 'Pack', 'A field of the project before drew its node over this one\'s.');
    });

    await run('a node\'s Equations tab shows one equation per state: its own part typed in, every other part a chip in its names that opens it, and states nothing changes folded', async () => {
        await freshExample('fourBarLinkage');
        await openNode('Crank pin B');
        // Three equations and two folded lines, not nine cards.
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('#nodeEditorStates > .stateCard')].map((card) => card.dataset.symbol)`), ['x', 'y', 'z']);
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('#nodeEditorStates > .stateFold .stateSummary')].map((line) => line.textContent.replace(/\\s+/g, ' ').trim())`),
            ['▸ Roll, pitch, yaw · stay at 0 rad', '▸ X, Y, Z velocity · stay at 0 m/s']);
        assert.equal(await evaluate(window, `document.querySelector('#nodeEditorStates .stateCard[data-symbol="x"] .stateSummary').textContent.replace(/\\s+/g, ' ').trim()`), '▸ X position · x · starts at 1 m');
        // Its own part, typed in; Crank drive X's part, read-only, in Crank pin B's names: its own y bare, Ground pivot A's as y_A.
        assert.equal(await evaluate(window, `document.querySelector('#nodeEditorStates .stateCard[data-symbol="x"] .ownPart').value`), '\\mathrm{vx}');
        const chip = `document.querySelector('#nodeEditorStates .stateCard[data-symbol="x"] .partChip[data-term-type="relationship"]')`;
        assert.equal(await evaluate(window, `${chip}.dataset.latex`), String.raw`-\mathrm{angularVelocity} \cdot \left(y - y_{\mathrm{A}}\right)`);
        assert.equal(await evaluate(window, `${chip}.dataset.sign`), '−', 'A part that starts with a minus does not take it as its sign.');
        // The sign stands between the parts, outside the chip: dx/dt = vx − [ω·(y − y_A)].
        assert.deepEqual(await evaluate(window, `[...document.querySelector('#nodeEditorStates .stateCard[data-symbol="x"] .stateEquation').children].filter((element) => !element.hidden).map((element) => element.classList.contains('partOperator') ? element.textContent : element.className.split(' ')[0])`),
            ['stateOrder', 'ownPart', '−', 'partChip'], 'The sign does not stand between the own part and the chip.');
        assert.doesNotMatch(await evaluate(window, `${chip}.querySelector('.partChipBody').textContent`), /^[−+-]/, 'The chip still carries its sign inside.');
        assert.match(await evaluate(window, `${chip}.querySelector('small').textContent`), /Crank drive X/);
        // A short name given on Details is the one its states go by in others' equations.
        await openNode('Ground pivot A');
        await evaluate(window, `document.querySelector('#nodeEditor [data-editor-tab="details"]').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeShortName').placeholder`), 'A', 'The derived short name is not shown.');
        await typeInto(`document.querySelector('#editNodeShortName')`, 'G');
        await openNode('Crank pin B');
        assert.equal(await evaluate(window, `${chip}.dataset.latex`), String.raw`-\mathrm{angularVelocity} \cdot \left(y - y_{\mathrm{G}}\right)`);
        assert.equal((await savedProject()).nodes.find((node) => node.name === 'Ground pivot A').shortName, 'G');
        await undoRedo('undo');
        // The chip opens the relationship it belongs to.
        await openNode('Crank pin B');
        await evaluate(window, `${chip}.click()`);
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden') && document.querySelector('#editEdgeName').value === 'Crank drive X'`, 'The chip did not open Crank drive X.');
        // Typing its own part is one undoable step, and what is stored is the node's source term on that state.
        await openNode('Crank pin B');
        await writeOwnPart(window, 'x', '\\mathrm{vx}+1');
        const ownOnX = async () => (await savedProject()).nodes.find((node) => node.name === 'Crank pin B').sourceTerms.filter((term) => term.state === 'x').map((term) => term.expressionModel.latex);
        assert.deepEqual(await ownOnX(), ['\\mathrm{vx}+1']);
        await undoRedo('undo');
        assert.deepEqual(await ownOnX(), ['\\mathrm{vx}'], 'Undo did not take the typing back in one step.');
        // A symbol its own part uses that nothing defines is offered under its field, and made its own part's parameter.
        await openNode('Crank pin B');
        await writeOwnPart(window, 'z', '\\mathrm{vz}\\cdot c');
        const addC = `document.querySelector('#nodeEditorStates .stateCard[data-symbol="z"] .ownPartDiagnostics .addParameterAction[data-symbol="c"]')`;
        await waitFor(window, `Boolean(${addC})`, 'An unknown symbol in a node\'s own part is not offered as a parameter.');
        await evaluate(window, `${addC}.click()`);
        await waitFor(window, `document.querySelector('#nodeEditorStates .stateCard[data-symbol="z"] .ownPartDiagnostics').classList.contains('valid')`, 'The own part was not valid once c was a parameter.');
        const ownOnZ = async () => (await savedProject()).nodes.find((node) => node.name === 'Crank pin B').sourceTerms.find((term) => term.state === 'z');
        assert.deepEqual((await ownOnZ()).parameters.map((parameter) => [parameter.name, parameter.symbol, parameter.value]), [['Parameter c', 'c', 1]]);
        await undoRedo('undo');
        assert.deepEqual((await ownOnZ()).parameters, [], 'Undo did not take the parameter away in one step.');
        await undoRedo('undo');

        // Several own parts on one state read as one sum, and the first edit makes them one, their parameters with them;
        // a state the node's program sets reads "set by program", saying which output it is.
        const box = { type: 'primitive', shape: 'box', color: '#888888' };
        const term = (id, latex, mathJson, parameters) => ({ id, state: 'level', expression: latex, parameters, expressionModel: { latex, mathJson, bindings: [], output: { stateId: 2 } } });
        await evaluate(window, `window.__debugProject.load(${JSON.stringify({
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], edges: [],
            nodes: [{
                id: 1, name: 'Tank', position: [0, 0, 0], appearance: box,
                states: [{ id: 2, name: 'Level', symbol: 'level', initialValue: 0 }, { id: 3, name: 'Valve', symbol: 'valve', initialValue: 0 }, { id: 4, name: 'Flow', symbol: 'flow', initialValue: 0 }],
                sourceTerms: [term(5, '\\mathrm{k}', 'k', [{ id: 6, name: 'Inflow', symbol: 'k', value: 2, mode: 'constant' }]), term(7, '-\\mathrm{k}', ['Negate', 'k'], [{ id: 8, name: 'Leak', symbol: 'k', value: 0.5, mode: 'constant' }])],
                implementation: { kind: 'python', providerApiVersion: 1, source: '', bindings: [], outputs: [{ key: 'valve', stateId: 3, setsValue: true }, { key: 'flow', stateId: 4, setsValue: true }] }
            }]
        })})`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 1`, 'The tank did not load.');
        await openNode('Tank');
        assert.equal(await evaluate(window, `document.querySelectorAll('#nodeEditorStates .stateCard[data-symbol="level"] .ownPart').length`), 1, 'Two own parts on one state are not one field.');
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('#nodeEditorStates .setByProgram')].map((line) => line.textContent.replace(/\\s+/g, ' ').trim())`),
            ['set by program Python · output 1 of 2 ›', 'set by program Python · output 2 of 2 ›']);
        await writeOwnPart(window, 'level', '\\mathrm{k}-\\mathrm{k2}');
        const tank = (await savedProject()).nodes[0];
        assert.equal(tank.sourceTerms.length, 1, 'The first edit did not make the two own parts one.');
        assert.deepEqual(tank.sourceTerms[0].parameters.map((parameter) => [parameter.symbol, parameter.value]), [['k', 2], ['k2', 0.5]], 'The parameters did not come together, the clashing one renamed.');
        await undoRedo('undo');
        assert.equal((await savedProject()).nodes[0].sourceTerms.length, 2, 'Undo did not bring both own parts back.');
    });

    await run('a relationship\'s card shows each state it lands on as that state\'s whole equation, its own part the one thing editable, in both ends\' names', async () => {
        await freshExample('fourBarLinkage');
        await openRelationship('Crank drive X');
        // Crank pin B's x: its own part, read-only and in both ends' names, then this relationship's part, the field.
        const ownChip = `document.querySelector('#edgeLanding [data-landing-lhs] .partChip[data-term-type="sourceTerm"]')`;
        assert.match(await evaluate(window, `${ownChip}.querySelector('small').textContent`), /Crank pin B/);
        assert.equal(await evaluate(window, `${ownChip}.dataset.latex`), String.raw`\mathrm{vx}_{\mathrm{B}}`);
        assert.match(await evaluate(window, `document.querySelector('#edgeLanding .rowLeftSide').textContent`), /x/);
        // Its field's part starts with a minus, which is its sign: nothing stands between the chip and the field ("+ −").
        assert.equal(await evaluate(window, `document.querySelectorAll('#edgeLanding [data-landing-lhs] .partOperator').length`), 0, 'A + stands before a part that starts with a minus.');
        const shown = await evaluate(window, `document.querySelector('#editEdgeMathField').value`);
        assert.ok(shown.includes('y_{\\mathrm{B}}') && shown.includes('y_{\\mathrm{A}}'), `The part is not shown in both ends' names: ${shown}`);
        assert.ok(!shown.includes('targetY'), 'The part is shown in the relationship\'s own names.');
        // The references insert themselves as the card writes them.
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('#editStateReferenceChips button')].map((button) => button.textContent).filter((label) => /^y_/.test(label))`), ['y_A', 'y_B']);
        // Typed in those names, stored in the relationship's own, as one undoable step.
        const stored = async () => (await savedProject()).edges.find((edge) => edge.name === 'Crank drive X').equationModel.latex;
        const before = await stored();
        await evaluate(window, `(() => { const field = document.querySelector('#editEdgeMathField'); field.focus(); field.setValue('y_B-y_A'); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(window, `window.__debugProject.serialize().edges.find((edge) => edge.name === 'Crank drive X').equationModel.latex === ${JSON.stringify(String.raw`\mathrm{targetY}-\mathrm{sourceY}`)}`, 'What was typed in both ends\' names was not stored in the relationship\'s own.');
        await undoRedo('undo');
        assert.equal(await stored(), before, 'Undo did not bring the part back.');
        // Crank drive X runs one way: one row.
        await openRelationship('Crank drive X');
        assert.equal(await evaluate(window, `document.querySelector('#edgeOtherEndRow').hidden`), true);
        // Written as a program, its part is a chip that opens the program.
        await evaluate(window, `(() => { const select = document.querySelector('#editEdgeImplementationKind'); select.value = 'cpp'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(window, `Boolean(document.querySelector('#edgeLanding .partChip.live.program'))`, 'A relationship written as a program has no chip for its part.');
        await undoRedo('undo');

        // A relationship running both ways: the other end's row, its part negated.
        await freshExample('thermalEquilibrium');
        await openRelationship((await savedProject()).edges.find((edge) => edge.directionality !== 'directed').name);
        assert.equal(await evaluate(window, `document.querySelector('#edgeOtherEndRow').hidden`), false, 'A relationship running both ways has no row for its other end.');
        assert.match(await evaluate(window, `document.querySelector('#edgeOtherEndRow .partChip.live small').textContent`), /negated/);
        assert.ok(await evaluate(window, `document.querySelector('#edgeOtherEndRow').getBoundingClientRect().height > 0`), 'The other end\'s row is not on screen.');
        // Taken away whole, its minus stands before it, outside the chip.
        assert.equal(await evaluate(window, `document.querySelector('#edgeOtherEndRow .partChip.live').previousElementSibling?.textContent`), '−');

        // A node's program writing two states: each of its chips says which output it is.
        const box = { type: 'primitive', shape: 'box', color: '#888888' };
        await evaluate(window, `window.__debugProject.load(${JSON.stringify({
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], edges: [],
            nodes: [{
                id: 1, name: 'Mixer', position: [0, 0, 0], appearance: box,
                states: [{ id: 2, name: 'Hot', symbol: 'hot', initialValue: 0 }, { id: 3, name: 'Cold', symbol: 'cold', initialValue: 0 }], sourceTerms: [],
                implementation: { kind: 'python', providerApiVersion: 1, source: '', bindings: [], outputs: [{ key: 'hot', stateId: 2 }, { key: 'cold', stateId: 3 }] }
            }]
        })})`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 1`, 'The mixer did not load.');
        await openNode('Mixer');
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('#nodeEditorStates .partChip[data-term-type="program"] .partChipBody')].map((body) => body.textContent.trim())`), ['Python · output 1 of 2', 'Python · output 2 of 2']);
    });

    await run('a parameter given a display symbol is written by it in every equation it is in, and what is typed with it is stored by its symbol', async () => {
        await freshExample('fourBarLinkage');
        await openRelationship('Crank drive X');
        await evaluate(window, `document.querySelector('#edgeEditor [data-editor-tab="parameters"]').click()`);
        await typeInto(`document.querySelector('#edgeEditorParameters [data-field="displaySymbol"]')`, '\\omega');
        const parameter = async () => (await savedProject()).edges.find((edge) => edge.name === 'Crank drive X').parameters[0];
        assert.equal((await parameter()).displaySymbol, '\\omega', 'The display symbol was not kept.');
        assert.equal((await parameter()).symbol, 'angularVelocity', 'The symbol the engine reads changed.');
        // Its field, and the chip of its part on Crank pin B, write it as ω.
        await openRelationship('Crank drive X');
        assert.match(await evaluate(window, `document.querySelector('#editEdgeMathField').value`), /\\omega/);
        await openNode('Crank pin B');
        assert.match(await evaluate(window, `document.querySelector('#nodeEditorStates .stateCard[data-symbol="x"] .partChip[data-term-type="relationship"]').dataset.latex`), /^-\\omega/);
        // Typed with ω, stored by its symbol.
        await openRelationship('Crank drive X');
        await evaluate(window, `(() => { const field = document.querySelector('#editEdgeMathField'); field.focus(); field.setValue('\\\\omega\\\\cdot(y_B-y_A)'); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitFor(window, `window.__debugProject.serialize().edges.find((edge) => edge.name === 'Crank drive X').equationModel.latex.startsWith('\\\\mathrm{angularVelocity}')`, 'What was typed with ω was not stored by the parameter\'s symbol.');
        // Left empty, it is written by its symbol again, and the file says nothing of it.
        await evaluate(window, `document.querySelector('#edgeEditor [data-editor-tab="parameters"]').click()`);
        await typeInto(`document.querySelector('#edgeEditorParameters [data-field="displaySymbol"]')`, '');
        assert.equal('displaySymbol' in (await parameter()), false, 'An empty display symbol is written to the file.');
    });

    await run('a node\'s states are reordered by button and by key, and each move is undone', async () => {
        await loadAuthoringProject();
        await openNode('Mass');
        // Each state's fields are opened from its line.
        await openStateFields(window, 'position');
        await openStateFields(window, 'speed');
        const order = async () => (await savedProject()).nodes[0].states.map(({ symbol }) => symbol);
        const row = (symbol) => `[...document.querySelectorAll('#nodeEditorStates .editorStateRow')].find((item) => item.querySelector('[data-field="symbol"]').value === ${JSON.stringify(symbol)})`;
        assert.equal(await evaluate(window, `${row('position')}.querySelector('[data-move="-1"]').disabled`), true, 'The first state cannot move up.');
        // By button: the speed moves before the position it changes, as semi-implicit integration wants.
        await evaluate(window, `${row('speed')}.querySelector('[data-move="-1"]').click()`);
        assert.deepEqual(await order(), ['speed', 'position']);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.deepEqual(await order(), ['position', 'speed']);
        // Undo closes the inspector, as it always does; open it again.
        await openNode('Mass');
        // By key, from a field of the row, which keeps the keyboard on the moved row.
        await evaluate(window, `(() => { const field = ${row('position')}.querySelector('[data-field="name"]'); field.focus(); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })); })()`);
        assert.deepEqual(await order(), ['speed', 'position']);
        assert.equal(await evaluate(window, `document.activeElement === ${row('position')}.querySelector('[data-field="name"]')`), true,
            `The moved row keeps the focus, not ${await evaluate(window, `document.activeElement?.outerHTML?.slice(0, 120)`)}.`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.deepEqual(await order(), ['position', 'speed']);
    });

    // Waits for the engine's own verdict on the model as it now is.
    const engineVerdict = async (message) => {
        await settle(window, 'validation');
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && !document.querySelector('#validationSummary').classList.contains('pending')`, message, 15000);
        return evaluate(window, `!document.querySelector('#validationSummary').classList.contains('error')`);
    };
    const gainParameter = { id: 8, name: 'Gain', symbol: 'gain', value: 2, mode: 'constant' };
    const singleSense = {
        id: 7, name: 'Sense', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 4, stateId: 5 }, directionality: 'bidirectional',
        equation: String.raw`\mathrm{sourceSpeed}`,
        equationModel: { latex: String.raw`\mathrm{sourceSpeed}`, output: { role: 'target', stateId: 6 }, bindings: [], mathJson: 'sourceSpeed' },
        parameters: [gainParameter], appearance: { color: '#888888', offset: 0 }
    };

    await run('a relationship gets several equations that set values, each written, named, moved and removed in the canvas', async () => {
        await loadAuthoringProject({ edges: [singleSense] });
        await openRelationship('Sense');
        const several = () => savedProject().then((project) => project.edges[0]);
        const rowSelector = (kind, index) => `document.querySelector('#editEdgeEquationsList .severalRow[data-kind="${kind}"][data-index="${index}"]')`;
        const setRowLatex = (kind, index, latex) => typeInto(`${rowSelector(kind, index)}.querySelector('textarea')`, latex);
        const select = (selector, value) => evaluate(window, `(() => { const element = ${selector}; element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('change', { bubbles: true })); })()`);

        // The one equation becomes the first of several, setting its state; the relationship becomes directed.
        await select(`document.querySelector('#editEdgeImplementationKind')`, 'equations');
        await waitFor(window, `!document.querySelector('#editEdgeEquationsList').hidden`, 'The equations editor did not open.');
        let edge = await several();
        assert.equal(edge.directionality, 'directed');
        assert.deepEqual(edge.equationModel.outputs, [{ role: 'target', stateId: 6, latex: String.raw`\mathrm{sourceSpeed}`, mathJson: 'sourceSpeed', setsValue: true }]);
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeDirectionality').disabled`), true);
        await evaluate(window, `document.querySelector('[data-equation-mode="latex"]').click()`);

        // An intermediate quantity, renamed: the equations reading it follow.
        await evaluate(window, `document.querySelector('[data-add-several="definition"]').click()`);
        await setRowLatex('definition', 0, String.raw`2\cdot\mathrm{gain}`);
        await evaluate(window, `document.querySelector('[data-add-several="output"]').click()`);
        await waitFor(window, `Boolean(${rowSelector('output', 1)})`, 'The new equation row did not appear.');
        assert.equal(await evaluate(window, `${rowSelector('output', 1)}.querySelector('select').selectedOptions[0].title`), 'target.angle', 'A new equation sets a state no other equation sets.');
        await setRowLatex('output', 1, String.raw`\mathrm{q1}\cdot\mathrm{sourceSpeed}`);
        await waitFor(window, `${rowSelector('output', 1)}.querySelector('.equationDiagnostics').classList.contains('valid')`, 'The equation reading the quantity was not valid.');
        await typeInto(`${rowSelector('definition', 0)}.querySelector('[data-field="symbol"]')`, 'twice');
        edge = await several();
        assert.deepEqual(edge.equationModel.definitions, [{ symbol: 'twice', latex: String.raw`2\cdot\mathrm{gain}`, mathJson: ['Multiply', 2, 'gain'] }]);
        assert.equal(edge.equationModel.outputs[1].latex, String.raw`\mathrm{twice}\cdot\mathrm{sourceSpeed}`);
        assert.deepEqual([edge.equationModel.outputs[1].mathJson[0], ...edge.equationModel.outputs[1].mathJson.slice(1).sort()], ['Multiply', 'sourceSpeed', 'twice']);
        assert.deepEqual(edge.equationModel.bindings.map(({ symbol }) => symbol).sort(), ['gain', 'sourceSpeed']);
        assert.equal(await engineVerdict('The model with several equations was not validated.'), true, 'The engine should accept the equations written in the canvas.');

        // A reference chip inserts into the equation that has the focus. This window is often not the one in front by now (earlier
        // tests open others), and a focus event is then held back, so the app asks which field has the focus rather than which one
        // last said so; this used to insert into the other equation. The chips are also rebuilt whenever the native check of the
        // edit settles, so a click that lands in the middle of a rebuild is lost: focus and click again until it takes.
        await waitFor(window, `(() => {
            const field = ${rowSelector('output', 0)}.querySelector('textarea');
            if (field.value.endsWith('\\mathrm{twice}')) return true;
            field.focus();
            field.setSelectionRange(field.value.length, field.value.length);
            [...document.querySelectorAll('#editStateReferenceChips button')].find((chip) => chip.textContent === 'twice')?.click();
            return field.value.endsWith('\\mathrm{twice}');
        })()`, 'The chip did not insert into the focused equation.', 8000);

        // Two equations setting one state are refused on the row, by name.
        await select(`${rowSelector('output', 1)}.querySelector('select')`, (await evaluate(window, `${rowSelector('output', 0)}.querySelector('select').value`)));
        assert.match(await evaluate(window, `${rowSelector('output', 1)}.querySelector('.equationDiagnostics').textContent`), /target\.reading is set by another equation/);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await openRelationship('Sense');

        // Moved by button and by key, then removed.
        await evaluate(window, `${rowSelector('output', 1)}.querySelector('[data-move="-1"]').click()`);
        assert.deepEqual((await several()).equationModel.outputs.map(({ stateId }) => stateId), [5, 6]);
        await evaluate(window, `(() => { const field = ${rowSelector('output', 0)}.querySelector('textarea'); field.focus(); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })); })()`);
        assert.deepEqual((await several()).equationModel.outputs.map(({ stateId }) => stateId), [6, 5]);
        await evaluate(window, `${rowSelector('output', 1)}.querySelector('[data-remove]').click()`);
        assert.deepEqual((await several()).equationModel.outputs.map(({ stateId }) => stateId), [6]);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.deepEqual((await several()).equationModel.outputs.map(({ stateId }) => stateId), [6, 5], 'Undo brings a removed equation back.');

        // Back to one equation: the first stays, with the quantity it reads written into it.
        await openRelationship('Sense');
        await evaluate(window, `(() => { window.__confirmAnswer = window.confirm; window.confirm = () => true; })()`);
        await select(`document.querySelector('#editEdgeImplementationKind')`, 'equation');
        await evaluate(window, `(() => { window.confirm = window.__confirmAnswer; })()`);
        edge = await several();
        assert.equal(edge.equationModel.outputs, undefined);
        assert.deepEqual(edge.equationModel.output, { role: 'target', stateId: 6 });
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeDirectionality').disabled`), false);
        await evaluate(window, `document.querySelector('[data-equation-mode="visual"]').click()`);
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
    });

    await run('a run records each part: a relationship\'s Results tab plots what it adds, and chips give each part\'s value at the timeline\'s point', async () => {
        await freshExample();
        await waitFor(window, `!document.querySelector('#runButton').disabled`, 'Run was not available.', 15000);
        await openRunDialog(window);
        await evaluate(window, `(() => { document.querySelector('#runTargetTime').value = '5'; document.querySelector('#startRun').click(); })()`);
        await waitFor(window, `!document.querySelector('#continueRun').hidden && document.querySelector('#continueRun').textContent === 'Extend simulation'`, 'The run did not complete.', 30000);

        // A relationship's card opens on its Results: what it added to the air's temperature over the run.
        await openRelationship('Air convection gain');
        await waitFor(window, `document.querySelector('#edgeEditor [data-editor-tab].active')?.dataset.editorTab === 'results'`, 'The relationship\'s card did not open on Results while results are open.');
        await waitFor(window, `document.querySelector('.edgeResultsPanel').classList.contains('hasResults')`, 'The relationship\'s Results tab drew nothing.', 10000)
            .catch(async (error) => { throw new Error(`${error.message} It said: ${await evaluate(window, `document.querySelector('#edgeResultEmpty').textContent.trim()`)}`); });
        assert.match(await evaluate(window, `document.querySelector('.edgeResultsPanel').textContent`), /Enclosed air/);

        // On the air's Equations tab, the relationship's chip gives its value where the timeline stands, and another as it moves.
        await openNode('Enclosed air');
        await evaluate(window, `document.querySelector('#nodeEditor [data-editor-tab="equations"]').click()`);
        const badge = `document.querySelector('#nodeEditorStates .partChip[data-term-type="relationship"] .partValue')`;
        await waitFor(window, `Boolean(${badge}) && !${badge}.hidden && /^= /.test(${badge}.textContent)`, 'A chip gave no value while results are open.');
        const atEnd = await evaluate(window, `${badge}.textContent`);
        // Nothing to type while results are open: the air's empty own part invites nothing, and looks empty and locked; no plain
        // field of an editor shows an invitation either, only a placeholder that says what is in effect.
        const ownPart = `document.querySelector('#nodeEditorStates .stateCard[data-symbol="temperature"] .ownPart')`;
        assert.equal(await evaluate(window, `${ownPart}.getAttribute('placeholder') ?? ''`), '', 'An empty own part invites typing while results are open.');
        // And it draws nothing in its place: with the attribute removed, MathLive's placeholder is an object, drawn as "[object Object]".
        assert.equal(await evaluate(window, `${ownPart}.placeholder === ''`), true, 'An empty own part draws text of its own while results are open.');
        assert.equal(await evaluate(window, `${ownPart}.classList.contains('lockedEmpty')`), true);
        const invitations = `[...document.querySelectorAll('[data-entity-editor] :is(input, textarea)[placeholder]:not([data-default-placeholder])')].filter((field) => !field.value && getComputedStyle(field, '::placeholder').color !== 'rgba(0, 0, 0, 0)').map((field) => field.id || field.dataset.field || field.className)`;
        assert.deepEqual(await evaluate(window, invitations), [], 'A field of an editor invites typing while results are open.');
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('[data-entity-editor] math-field[placeholder]:not([placeholder=""])')].map((field) => field.id || field.className)`), [], 'An equation field invites typing while results are open.');
        await evaluate(window, `(() => { const slider = document.querySelector('#resultTimeline'); slider.value = slider.min; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitFor(window, `${badge}.textContent !== ${JSON.stringify(atEnd)}`, 'A chip\'s value did not follow the timeline.');

        // Results closed: no values.
        await evaluate(window, `document.querySelector('#closeResults').click()`);
        await waitFor(window, `document.querySelector('#closeResultsDialog').open || document.querySelector('#resultTransport').hidden`, 'Closing the results neither asked nor closed them.');
        await evaluate(window, `document.querySelector('#closeResultsDialog[open] #confirmCloseResults')?.click()`);
        await waitFor(window, `document.querySelector('#resultTransport').hidden`, 'The results did not close.');
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.partValue')].every((element) => element.hidden)`), true, 'A value stayed once results were closed.');
        // Closed: the own part invites typing again.
        await waitFor(window, `${ownPart}?.getAttribute('placeholder')?.includes('type this node\\'s own term') && !${ownPart}.classList.contains('lockedEmpty')`, 'The own part did not invite typing again once results were closed.');
    });

    await run('a relationship a toolbox wrote with several equations opens readable, and editing one equation keeps the others exactly', async () => {
        // As the robotics toolbox writes a joint: its own binding symbols, MathJSON, and LaTeX that is only for show.
        const written = {
            id: 7, name: 'Joint', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 4, stateId: 5 }, directionality: 'directed',
            equation: '', parameters: [gainParameter], appearance: { color: '#888888', offset: 0 },
            equationModel: {
                bindings: [{ symbol: 'pX', kind: 'state', role: 'source', nodeId: 1, stateId: 2 }, { symbol: 'gain', kind: 'parameter', parameterId: 8 }],
                definitions: [{ symbol: 'cosq', mathJson: ['Cos', 'pX'], latex: String.raw`\cos\left(\mathrm{p}_{X}\right)` }],
                outputs: [
                    { role: 'target', stateId: 5, mathJson: ['Multiply', 'gain', 'cosq'], latex: String.raw`\mathrm{gain}\,\mathrm{cosq}`, setsValue: true },
                    { role: 'target', stateId: 6, mathJson: ['Add', 'pX', 1], setsValue: true }
                ]
            }
        };
        await loadAuthoringProject({ edges: [written] });
        assert.equal(await engineVerdict('The toolbox relationship was not validated.'), true);
        await openRelationship('Joint');
        await evaluate(window, `document.querySelector('[data-equation-mode="latex"]').click()`);
        const rowField = (kind, index) => `document.querySelector('#editEdgeEquationsList .severalRow[data-kind="${kind}"][data-index="${index}"] textarea')`;
        assert.equal(await evaluate(window, `${rowField('definition', 0)}.value`), String.raw`\cos\left(\mathrm{pX}\right)`, 'LaTeX that does not read back is shown as written from the MathJSON.');
        assert.equal(await evaluate(window, `${rowField('output', 1)}.value`), String.raw`\mathrm{pX}+1`, 'An equation with no LaTeX is shown as written from its MathJSON.');
        assert.equal(await evaluate(window, `[...document.querySelectorAll('#editEdgeEquationsList .equationDiagnostics')].every((item) => item.classList.contains('valid'))`), true);
        // Opening it changed nothing.
        assert.deepEqual((await savedProject()).edges[0].equationModel, written.equationModel);
        await typeInto(rowField('output', 1), String.raw`\mathrm{pX}+2`);
        const edited = (await savedProject()).edges[0].equationModel;
        assert.deepEqual(edited.outputs[1].mathJson, ['Add', 'pX', 2]);
        assert.deepEqual(edited.outputs[0].mathJson, written.equationModel.outputs[0].mathJson);
        assert.deepEqual(edited.definitions[0].mathJson, written.equationModel.definitions[0].mathJson);
        assert.deepEqual(edited.bindings, written.equationModel.bindings, 'The toolbox\'s bindings are kept as they were.');
        assert.equal(await engineVerdict('The edited relationship was not validated.'), true);
        await evaluate(window, `document.querySelector('[data-equation-mode="visual"]').click()`);
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
    });

    await run('a shared parameter is given a schedule, edited, removed and undone from the parameters table', async () => {
        await loadAuthoringProject({
            sharedParameters: [{ id: 100, name: 'Price', symbol: 'price', value: 2, unit: '', mode: 'constant' }],
            edges: [{ ...singleSense, directionality: 'directed', equation: String.raw`\mathrm{gain}`,
                equationModel: { latex: String.raw`\mathrm{gain}`, output: { role: 'target', stateId: 6 }, bindings: [{ kind: 'parameter', parameterId: 8, symbol: 'gain' }], mathJson: 'gain' },
                parameters: [{ ...gainParameter, sharedParameterId: 100 }] }]
        });
        const shared = async () => (await savedProject()).sharedParameters.find(({ id }) => id === 100);
        if (await evaluate(window, `document.querySelector('#parametersPanel').hidden`)) await evaluate(window, `document.querySelector('#parametersButton').click()`);
        await waitFor(window, `!document.querySelector('#parametersPanel').hidden`, 'The parameters panel did not open.');
        const sharedRow = `document.querySelector('#parametersTable tr.sharedRow')`;
        await waitFor(window, `Boolean(${sharedRow}?.querySelector('.scheduleAdd'))`, 'The shared parameter has no schedule button.');
        await evaluate(window, `${sharedRow}.querySelector('.scheduleAdd').click()`);
        await waitFor(window, `document.querySelector('#scheduleDialog').open`, 'The schedule dialog did not open.');
        assert.equal(await evaluate(window, `document.querySelector('#scheduleSamples').value`), '0, 2', 'A new schedule starts from the constant it replaces.');
        // Times that do not increase cannot be saved, and the dialog says why.
        await typeInto(`document.querySelector('#scheduleSamples')`, 'time, price\n0, 2\n10, 3\n10, 4', 'input');
        assert.match(await evaluate(window, `document.querySelector('#scheduleError').textContent`), /times must increase/);
        assert.equal(await evaluate(window, `document.querySelector('#scheduleSave').disabled`), true);
        await typeInto(`document.querySelector('#scheduleSamples')`, 'time, price\n0, 2\n10, 3\n20, 4', 'input');
        assert.match(await evaluate(window, `document.querySelector('#scheduleSummary').textContent`), /3 samples, linearly interpolated/);
        // Saved by key, as by the button.
        await evaluate(window, `document.querySelector('#scheduleSamples').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: !/Mac/.test(navigator.platform), metaKey: /Mac/.test(navigator.platform), bubbles: true }))`);
        await waitFor(window, `!document.querySelector('#scheduleDialog').open`, 'Ctrl+Enter did not save the schedule.');
        assert.deepEqual((await shared()).schedule, { interpolation: 'linear', samples: [[0, 2], [10, 3], [20, 4]] });
        assert.equal(await engineVerdict('The scheduled parameter was not validated.'), true);
        // Edited: each value held.
        await evaluate(window, `${sharedRow}.querySelector('.scheduleOpen').click()`);
        await waitFor(window, `document.querySelector('#scheduleDialog').open`, 'The schedule did not open for editing.');
        assert.equal(await evaluate(window, `document.querySelector('#scheduleSamples').value`), '0, 2\n10, 3\n20, 4');
        await evaluate(window, `(() => { const select = document.querySelector('#scheduleInterpolation'); select.value = 'hold'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await evaluate(window, `document.querySelector('#scheduleSave').click()`);
        assert.equal((await shared()).schedule.interpolation, 'hold');
        // Removed from the dialog, and undone.
        await evaluate(window, `${sharedRow}.querySelector('.scheduleOpen').click()`);
        await evaluate(window, `document.querySelector('#scheduleRemove').click()`);
        assert.equal((await shared()).schedule, undefined);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal((await shared()).schedule?.interpolation, 'hold');
        await evaluate(window, `document.querySelector('#parametersButton').click()`);
    });

    await run('a node gets a program in the node editor: its language, inputs from any node or shared parameter, outputs and source', async () => {
        await loadAuthoringProject({ sharedParameters: [{ id: 100, name: 'Setpoint', symbol: 'setpoint', value: 10, unit: '', mode: 'constant' }] });
        await openNode('Mass');
        const program = async () => (await savedProject()).nodes[0].implementation;
        const select = (selector, value) => evaluate(window, `(() => { const element = ${selector}; element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await select(`document.querySelector('#editNodeProgramKind')`, 'python');
        await waitFor(window, `!document.querySelector('#nodeProgramFields').hidden`, 'The program fields did not open.');
        assert.match((await program()).source, /class Mass\(NodeProvider\)/, 'A new program starts from a template.');
        assert.match(await evaluate(window, `document.querySelector('#nodeProgramError').textContent`), /Add an output/);
        // An input reading another node's state, one reading a shared parameter, and an output setting a value.
        await evaluate(window, `document.querySelector('#editAddNodeProgramInput').click()`);
        await select(`document.querySelector('#nodeProgramInputs .nodeProgramRow select')`, 'state:4:6');
        await evaluate(window, `document.querySelector('#editAddNodeProgramInput').click()`);
        await select(`document.querySelectorAll('#nodeProgramInputs .nodeProgramRow')[1].querySelector('select')`, 'shared:100');
        await typeInto(`document.querySelectorAll('#nodeProgramInputs .nodeProgramRow')[1].querySelector('[data-field="key"]')`, 'setpoint');
        await evaluate(window, `document.querySelector('#editAddNodeProgramOutput').click()`);
        await evaluate(window, `(() => { const box = document.querySelector('#nodeProgramOutputs [data-field="setsValue"]'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        let implementation = await program();
        assert.deepEqual(implementation.bindings, [{ key: 'input', kind: 'state', nodeId: 4, stateId: 6 }, { key: 'setpoint', kind: 'parameter', sharedParameterId: 100 }]);
        assert.deepEqual(implementation.outputs, [{ key: 'output', stateId: 2, setsValue: true }]);
        assert.equal(await evaluate(window, `document.querySelector('#nodeProgramError').textContent`), '');
        // The template is written again from the inputs and outputs, and the source is typed: one undo step each.
        await evaluate(window, `(() => { window.__confirmAnswer = window.confirm; window.confirm = () => true; })()`);
        await evaluate(window, `document.querySelector('#editNodeProgramTemplate').click()`);
        await evaluate(window, `(() => { window.confirm = window.__confirmAnswer; })()`);
        implementation = await program();
        assert.match(implementation.source, /ScalarPort\("setpoint", "setpoint", ""\)/);
        assert.match(implementation.source, /outputs\.add_gradient\("output", 0\.0\)/);
        await typeInto(`document.querySelector('#editNodeProgramSource')`, implementation.source.replace('0.0)', 'inputs["setpoint"])'));
        assert.match((await program()).source, /add_gradient\("output", inputs\["setpoint"\]\)/);
        assert.equal(await engineVerdict('The node with a program was not validated.'), true);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.match((await program()).source, /add_gradient\("output", 0\.0\)/, 'Undo takes back the typing.');
        // C++, then none.
        await openNode('Mass');
        await select(`document.querySelector('#editNodeProgramKind')`, 'cpp');
        implementation = await program();
        assert.equal(implementation.kind, 'cpp');
        assert.match(implementation.source, /public konjugate::sdk::v1::NodeProvider/);
        assert.equal(implementation.bindings.length, 2, 'The inputs carry over to another language.');
        await select(`document.querySelector('#editNodeProgramKind')`, '');
        assert.equal(await program(), undefined);
    });

    await run('a node is computed by an installed FMU, wired under the FMU\'s own keys', async () => {
        // An FMU stand-in: what the Extensions explorer lists, and the ports the desktop reads from its modelDescription.
        await evaluate(window, `(() => {
            window.__extensionsList = window.extensions.list; window.__fmuPorts = window.extensions.fmuPorts;
            window.extensions.list = async () => [{ packageType: 'fmu', packageId: 'guid-1', name: 'Heater', version: '1.0', enabled: true }];
            window.extensions.fmuPorts = async () => ({ name: 'Heater', fmiVersion: '2.0', inputs: [{ key: 'power', name: 'power', causality: 'input' }], outputs: [{ key: 'temperature', name: 'temperature' }] });
        })()`);
        try {
            await loadAuthoringProject();
            await openNode('Mass');
            await evaluate(window, `(() => { const element = document.querySelector('#editNodeProgramKind'); element.value = 'fmi'; element.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            await waitFor(window, `document.querySelectorAll('#nodeProgramInputs .nodeProgramRow').length === 1`, 'The FMU\'s input was not listed.');
            let implementation = (await savedProject()).nodes[0].implementation;
            assert.deepEqual(implementation, { kind: 'fmi', fmuId: 'guid-1', fmuVersion: '1.0', bindings: [{ key: 'power', kind: 'state', stateId: null }], outputs: [{ key: 'temperature', stateId: null, setsValue: true }] });
            assert.equal(await evaluate(window, `document.querySelector('#nodeProgramInputs [data-field="key"]').readOnly`), true, 'The FMU\'s keys are its own.');
            assert.equal(await evaluate(window, `document.querySelector('#editAddNodeProgramInput').hidden`), true);
            await evaluate(window, `(() => { const element = document.querySelector('#nodeProgramInputs select'); element.value = 'state:4:6'; element.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            await evaluate(window, `(() => { const element = document.querySelector('#nodeProgramOutputs select'); element.value = '3'; element.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            implementation = (await savedProject()).nodes[0].implementation;
            assert.deepEqual(implementation.bindings, [{ key: 'power', kind: 'state', nodeId: 4, stateId: 6 }]);
            assert.deepEqual(implementation.outputs, [{ key: 'temperature', stateId: 3, setsValue: true }]);
            assert.equal(await evaluate(window, `document.querySelector('#nodeProgramOutputs [data-field="setsValue"]').disabled`), true, 'An FMU reports values, never rates.');
        } finally {
            await evaluate(window, `window.extensions.list = window.__extensionsList; window.extensions.fmuPorts = window.__fmuPorts`);
        }
    }, { skip: driver.kind !== 'playwright' && 'stands in for an installed FMU, which the desktop bridge does not let a test replace; the FMU import fidelity tests cover real ones' });

    await run('a node is given body parts for result visualizers, each from a mesh file, named, coloured, replaced and removed', async () => {
        await loadAuthoringProject();
        await openNode('Mass');
        await evaluate(window, `document.querySelector('[data-editor-tab="appearance"]').click()`);
        const parts = async () => (await savedProject()).nodes[0].appearance.parts;
        // A one-triangle STL in millimetres, chosen as a person picks a file.
        const choose = (selector, size) => evaluate(window, `(() => {
            const stl = ['solid t', 'facet normal 0 0 1', 'outer loop', 'vertex 0 0 0', 'vertex ${size} 0 0', 'vertex 0 ${size} 0', 'endloop', 'endfacet', 'endsolid t'].join(String.fromCharCode(10));
            const transfer = new DataTransfer();
            transfer.items.add(new File([stl], 'triangle.stl'));
            const input = ${selector};
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await choose(`document.querySelector('#editAddNodePart')`, 1000);
        await waitFor(window, `document.querySelectorAll('#nodeParts .nodePartRow').length === 1`, 'The part was not added.');
        let saved = await parts();
        assert.deepEqual(saved, [{ prefix: '', color: '#888888', mesh: { position: [0, 0, 0, 1, 0, 0, 0, 1, 0], normal: [0, 0, 1, 0, 0, 1, 0, 0, 1], index: [0, 1, 2] } }]);
        assert.match(await evaluate(window, `document.querySelector('#nodeParts .nodePartProblem').textContent`), /no state x, y, z/, 'A part its node cannot place says so.');
        await typeInto(`document.querySelector('#nodeParts [data-field="prefix"]')`, 'arm');
        await typeInto(`document.querySelector('#nodeParts [data-field="color"]')`, '#d08b4a');
        await choose(`document.querySelector('#nodeParts .partMesh input')`, 500);
        await waitFor(window, `document.querySelector('#nodeParts .partMesh')?.textContent.startsWith('1 triangles')`, 'The replaced mesh was not shown.');
        saved = await parts();
        assert.equal(saved[0].prefix, 'arm');
        assert.equal(saved[0].color, '#d08b4a');
        assert.deepEqual(saved[0].mesh.position, [0, 0, 0, 0.5, 0, 0, 0, 0.5, 0]);
        await evaluate(window, `document.querySelector('#nodeParts .nodePartRow > button').click()`);
        assert.equal(await parts(), undefined, 'With no parts left, the node has none.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal((await parts())[0].prefix, 'arm');
    });

    await run('an installed plugin\'s provider is chosen for a relationship and for a source term', async () => {
        await evaluate(window, `(() => {
            window.__extensionsList = window.extensions.list;
            window.extensions.list = async () => [{ packageType: 'plugin', packageId: 'example.helloProvider', name: 'Hello', version: '0.1.0',
                enabled: true, manifest: { contributes: [{ providerId: 'example.helloWorld', runtime: 'python' }] } }];
        })()`);
        try {
            await loadAuthoringProject({ edges: [{ ...singleSense, directionality: 'directed' }] });
            const select = (selector, value) => evaluate(window, `(() => { const element = ${selector}; element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            const reference = JSON.stringify(['example.helloProvider', '0.1.0', 'example.helloWorld']);
            await openRelationship('Sense');
            await select(`document.querySelector('#editEdgeImplementationKind')`, 'plugin');
            await waitFor(window, `!document.querySelector('#editEdgePluginProviderFields').hidden && document.querySelector('#editEdgePluginProvider').options.length === 2`, 'The installed providers were not offered.');
            assert.equal(await evaluate(window, `document.querySelector('#editEdgeProviderCode').hidden`), true, 'A plugin provider has no source to edit.');
            await select(`document.querySelector('#editEdgePluginProvider')`, reference);
            let edge = (await savedProject()).edges[0];
            assert.deepEqual({ ...edge.implementation, output: undefined }, {
                kind: 'plugin', providerApiVersion: 1, pluginId: 'example.helloProvider', pluginVersion: '0.1.0', providerId: 'example.helloWorld', bindings: [], output: undefined
            });
            assert.equal(edge.implementation.output.stateId, 6, 'The state it updates carries over.');
            await select(`document.querySelector('#editEdgeImplementationKind')`, 'python');
            edge = (await savedProject()).edges[0];
            assert.match(edge.implementation.source, /RelationshipProvider/, 'A program starts from a template again.');
            await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);

            // The Mass node's own part on its position, written with the plugin's provider from the state's "{ } plugin".
            await openNode('Mass');
            await evaluate(window, `document.querySelector('#nodeEditorStates .stateFold[data-symbols~="position"] .stateSummary')?.click()`);
            await waitFor(window, `Boolean(document.querySelector('#nodeEditorStates .stateCard[data-symbol="position"] .ownPluginPart'))`, 'A state offers no "{ } plugin" while a plugin offers a provider.');
            await evaluate(window, `document.querySelector('#nodeEditorStates .stateCard[data-symbol="position"] .ownPluginPart').click()`);
            await waitFor(window, `!document.querySelector('#sourceTermEditor').classList.contains('hidden')`, 'The own part\'s program card did not open.');
            assert.equal(await evaluate(window, `document.querySelector('#termImplementationKind').value`), 'plugin');
            await waitFor(window, `!document.querySelector('#termPluginProviderFields').hidden && document.querySelector('#termPluginProvider').options.length === 2`, 'The installed providers were not offered for the source term.');
            await select(`document.querySelector('#termPluginProvider')`, reference);
            const term = (await savedProject()).nodes[0].sourceTerms.at(-1);
            assert.equal(term.implementation.kind, 'plugin');
            assert.equal(term.implementation.providerId, 'example.helloWorld');
        } finally {
            await evaluate(window, `window.extensions.list = window.__extensionsList`);
        }
    }, { skip: driver.kind !== 'playwright' && 'stands in for an installed plugin, which the desktop bridge does not let a test replace' });

    await run('the guided tour takes a new user from an empty canvas to a first run, and can be skipped or gone back in', async () => {
        const step = () => evaluate(window, `window.__debugTour.step()`);
        const waitForStep = async (id) => {
            try { await waitFor(window, `window.__debugTour.step() === ${JSON.stringify(id)}`, `The tour did not reach "${id}".`, 15000); } catch (error) {
                const facts = await evaluate(window, `JSON.stringify({ step: window.__debugTour.step(), error: document.querySelector('#editNodeError').textContent, dialog: document.querySelector('#runLaunchDialog').open, runError: document.querySelector('#runLaunchError').textContent, status: document.querySelector('#statusText').textContent, nodeCard: !document.querySelector('#nodeEditor').classList.contains('hidden'), nodes: window.__debugProject.serialize().nodes.map((node) => [node.name, node.states.length]), blockers: window.__debugTour.blockers() })`);
                throw new Error(`${error.message} ${facts}`);
            }
        };
        const press = (selector) => evaluate(window, `document.querySelector(${JSON.stringify(selector)}).click()`);
        const fill = () => press('.tourFloating .tourSecondary');
        const emptyDocument = { format: 'konjugate', version: 1, metadata: { units: 'SI' }, runConfigurations: [], sharedParameters: [], nodes: [], edges: [], subsystems: [], edgeGroups: [] };
        const start = async () => {
            // A run an earlier test started may still be finishing, and would put its result back after the project is replaced.
            await waitFor(window, `!window.__debugTour.blockers().simulationRunning`, 'An earlier simulation did not finish.', 30000);
            await evaluate(window, `window.__debugProject.load(${JSON.stringify(emptyDocument)}, 'tour.kjt')`);
            await waitFor(window, `document.querySelector('.modelStatus')?.textContent.includes('0 nodes') && !window.__debugTour.blockers().hasResult && !window.__debugTour.blockers().dirty`, 'The empty project did not load.');
            await evaluate(window, `window.__debugTour.start()`);
            await waitForStep('welcome').catch(async (error) => { throw new Error(`${error.message} ${JSON.stringify(await evaluate(window, 'window.__debugTour.blockers()'))}`); });
        };

        // Skipping: the card goes away, says where to find the tour again, and leaves the model alone.
        await start();
        await press('.tourFloating .tourActions .tourLink');
        await waitFor(window, `!window.__debugTour.active() && document.querySelector('.tourFloating').hidden`, 'Skipping did not end the tour.');

        // The whole way, by the Add menu and the "Fill this in for me" buttons.
        await start();
        await press('.tourFloating .tourPrimary');
        await waitForStep('addNode');
        await press('#addButton');
        await press('[data-add-kind="node"]');
        await waitForStep('firstNode');
        // The card never sits over what the person is working in: the card of the node or relationship just made, at the side.
        const cardOverlaps = (selector) => evaluate(window, `(() => { const a = document.querySelector('.tourFloating').getBoundingClientRect(); const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top); })()`);
        await waitFor(window, `document.querySelector('.tourFloating .tourTitle').textContent.startsWith('Define')`, 'The card did not describe the new node.');
        assert.equal(await evaluate(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`), true, 'New node did not open its card.');
        assert.equal(await cardOverlaps('#nodeEditor'), false, 'The tour card covers the new node\'s card.');
        await fill();
        await waitForStep('secondNode');
        await fill();
        await waitForStep('addEdge');
        await fill();
        await waitForStep('equation');
        assert.equal(await cardOverlaps('#edgeEditor'), false, 'The tour card covers the new relationship\'s card.');
        await fill();
        await waitFor(window, `document.querySelector('#equationDiagnostics').classList.contains('valid')`, 'The tour\'s equation was not valid.', 15000);
        await waitForStep('run');
        await waitFor(window, `document.querySelector('#runButton').title === 'Run simulation'`, 'The model was not validated for a run.', 15000);
        await fill();
        await waitFor(window, `document.querySelector('#runTargetTime').value === '10'`, 'The run time was not filled in.');
        await press('#startRun');
        await waitForStep('plotBlock');
        // Clicking the block's label opens its editor with the plot of its temperature.
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Block')).click()`);
        await waitForStep('results');
        assert.ok(await evaluate(window, `document.querySelector('#nodeResultPlot').getBoundingClientRect().width > 0`), 'The block\'s plot was not on screen.');
        const saved = await savedProject();
        assert.deepEqual(saved.nodes.map((node) => [node.name, node.states[0].symbol, node.states[0].initialValue]), [['Heater', 'temperature', 350], ['Block', 'temperature', 300]]);
        assert.equal(saved.edges.length, 1);
        assert.match(saved.edges[0].equation, /sourceTemperature/);
        await evaluate(window, `(() => { const slider = document.querySelector('#resultTimeline'); slider.value = slider.max; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitForStep('finish');
        assert.match(await evaluate(window, `document.querySelector('.tourFloating .tourText').textContent`), driver.capabilities.multiWindow ? /Extensions dialog/ : /desktop app adds/);
        await press('.tourFloating .tourPrimary');
        await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tour.');

        // Undoing an earlier step is noticed: a model with its second node gone sends a person at "run" back to it.
        await start();
        await press('.tourFloating .tourPrimary');
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(saved)}, 'tour.kjt')`);
        await waitForStep('run');
        await evaluate(window, `window.__debugProject.load(${JSON.stringify({ ...saved, nodes: saved.nodes.slice(0, 1), edges: [] })}, 'tour.kjt')`);
        await waitFor(window, `!document.querySelector('.tourFloating .tourNotice').hidden`, 'The tour did not notice the missing node.');
        await press('.tourFloating > .tourLink');
        await waitForStep('secondNode');
        await evaluate(window, `window.__debugTour.stop()`);
    });

    await run('opening a project replaces the edge groups of the one before, and brings its own', async () => {
        const box = { type: 'primitive', shape: 'box', color: '#888888' };
        const body = (id, name) => ({ id, name, position: [id, 0, 0], appearance: box, states: [{ id: id + 100, name: 'Temperature', symbol: 'temperature', initialValue: 300, unit: 'K' }], sourceTerms: [] });
        const grouped = {
            format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], subsystems: [],
            nodes: [body(1, 'A'), body(2, 'B')],
            edges: [],
            edgeGroups: [{ id: 50, name: 'Shared heat', memberNodeIds: [1, 2], color: '#2fb8a4', definition: { parameters: [], output: { symbol: 'temperature' }, equation: String.raw`0.1\cdot(\mathrm{sourceTemperature}-\mathrm{targetTemperature})`, implementation: null } }]
        };
        const empty = { format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], subsystems: [], nodes: [], edges: [], edgeGroups: [] };
        await waitFor(window, `!window.__debugTour.blockers().simulationRunning`, 'An earlier simulation did not finish.', 30000);
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(grouped)}, 'grouped.kjt')`);
        await waitFor(window, `window.__debugProject.serialize().edgeGroups.length === 1`, 'The project\'s edge group was not loaded.');
        // Opened without one (a project saved before edge groups had none to write): none is left from the project before.
        const { edgeGroups: _dropped, ...withoutGroups } = { ...empty, nodes: [body(7, 'C')] };
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(withoutGroups)}, 'plain.kjt')`);
        await waitFor(window, `document.querySelector('.modelStatus')?.textContent.includes('1 nodes')`, 'The second project did not load.');
        assert.deepEqual(await evaluate(window, `window.__debugProject.serialize().edgeGroups`), [], 'The edge group of the project before was kept.');
        await evaluate(window, `window.__debugProject.load(${JSON.stringify(empty)}, 'empty.kjt')`);
    });

    // ---- Tutorials (docs/proposals/tutorials.md): the list, and each tutorial that starts from an example, played the whole way.
    const tutorialHelpers = () => {
        const press = (selector) => evaluate(window, `document.querySelector(${JSON.stringify(selector)}).click()`);
        const waitForStep = async (id, timeout = 15000) => {
            try { await waitFor(window, `window.__debugTour.step() === ${JSON.stringify(id)}`, `The tutorial did not reach "${id}".`, timeout); } catch (error) {
                const facts = await evaluate(window, `JSON.stringify({ tutorial: window.__debugTour.tutorial(), step: window.__debugTour.step(), status: document.querySelector('#statusText').textContent, tuning: document.querySelector('#parameterTuningStatus')?.textContent, blockers: window.__debugTour.blockers() })`);
                throw new Error(`${error.message} ${facts}`);
            }
        };
        // A node's label by its exact name ("Thermal mass", not "Thermal mass copy"), among those on screen.
        const clickLabel = (name) => evaluate(window, `(() => { const labels = [...document.querySelectorAll('.objectLabel')].filter((label) => label.getClientRects().length); (labels.find((label) => label.querySelector('strong')?.textContent === ${JSON.stringify(name)}) ?? labels.find((label) => label.textContent.includes(${JSON.stringify(name)}))).click(); })()`);
        const cardOverlaps = (selector) => evaluate(window, `(() => { const a = document.querySelector('.tourFloating').getBoundingClientRect(); const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top); })()`);
        // A clean, empty project, so starting a tutorial asks nothing (the question about unsaved work is a native dialog on the desktop).
        const clean = async () => {
            await waitFor(window, `!window.__debugTour.blockers().simulationRunning`, 'An earlier simulation did not finish.', 30000);
            if (await evaluate(window, `window.__debugTour.active()`)) await evaluate(window, `window.__debugTour.stop()`);
            const emptyDocument = { format: 'konjugate', version: 1, metadata: { units: 'SI' }, runConfigurations: [], sharedParameters: [], nodes: [], edges: [], subsystems: [], edgeGroups: [] };
            await evaluate(window, `window.__debugProject.load(${JSON.stringify(emptyDocument)}, 'tutorial.kjt')`);
            await waitFor(window, `document.querySelector('.modelStatus')?.textContent.includes('0 nodes') && !window.__debugTour.blockers().hasResult && !window.__debugTour.blockers().dirty`, 'The empty project did not load.');
        };
        return { press, waitForStep, clickLabel, cardOverlaps, clean };
    };

    // The list as the dialog shows it with nothing typed: grouped by area, in the areas' order.
    const tutorialListOrder = groupTutorials().flatMap((group) => group.tutorials.map((tutorial) => tutorial.id));
    await run('the Tutorials button lists every tutorial, grouped, searchable, and starts one from its example without opening the guide', async () => {
        const { press, waitForStep, clean } = tutorialHelpers();
        await clean();
        const handlesBefore = driver.allHandles?.() ?? [];
        await press('#tutorialsButton');
        await waitFor(window, `document.querySelector('#tutorialsDialog').open`, 'The Tutorials list did not open.');
        assert.equal(await evaluate(window, `document.activeElement === document.querySelector('#tutorialsSearch')`), true, 'The search field is ready to type in.');
        assert.equal(await evaluate(window, `document.querySelector('.tutorialsGroup').textContent`), 'Start here');
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.tutorialEntry')].map((entry) => entry.dataset.tutorial)`), tutorialListOrder, 'Every tutorial, grouped by area.');
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.tutorialsGroup')].map((heading) => heading.textContent)`), groupTutorials().map((group) => group.title));
        // A tutorial only the desktop app can play is listed everywhere, with a note in place of Start where it cannot be played.
        assert.equal(await evaluate(window, `Boolean(document.querySelector('.tutorialEntry[data-tutorial="liveTwin"] .tutorialEditionNote'))`), !driver.capabilities.multiWindow);
        assert.match(await evaluate(window, `document.querySelector('.tutorialEntry[data-tutorial="calibrateTank"] .tutorialEntryMeta').textContent`), /Starts from the Tank Calibration example/);
        const search = (text) => evaluate(window, `(() => { const field = document.querySelector('#tutorialsSearch'); field.value = ${JSON.stringify(text)}; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await search('pid');
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.tutorialEntry')].map((entry) => entry.dataset.tutorial)`), ['tuneController']);
        assert.equal(await evaluate(window, `document.querySelectorAll('.tutorialsGroup').length`), 0, 'A search lists matches, not groups.');
        await search('zzzz');
        assert.equal(await evaluate(window, `document.querySelector('#tutorialsEmpty').hidden`), false);
        // Enter in the search field does not close the list.
        await evaluate(window, `document.querySelector('#tutorialsSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
        assert.equal(await evaluate(window, `document.querySelector('#tutorialsDialog').open`), true);
        await search('calibrate');
        await press('.tutorialEntry[data-tutorial="calibrateTank"] .helpFeedbackPrimary');
        await waitFor(window, `!document.querySelector('#tutorialsDialog').open`, 'Starting a tutorial did not close the list.');
        await waitFor(window, `window.__debugTour.tutorial() === 'calibrateTank'`, 'The calibration tutorial did not start.');
        await waitForStep('welcome');
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 3`, 'The Tank Calibration example did not load.');
        assert.equal(await evaluate(window, `document.querySelector('.tourFloating').getAttribute('aria-label')`), 'Calibrate a model against measured data');
        assert.equal(await evaluate(window, `document.querySelector('#exampleGuideButton').hidden`), false, 'The example\'s guide is one click away.');
        if (driver.capabilities.multiWindow) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            assert.equal(driver.allHandles().length, handlesBefore.length, 'The example guide window opened over the tutorial.');
        }
        // Leaving says where to find it again.
        await press('.tourFloating .tourActions .tourLink');
        await waitFor(window, `!window.__debugTour.active()`, 'Leaving did not end the tutorial.');
        assert.match(await evaluate(window, `document.querySelector('#statusText').textContent`), /take it again any time from Tutorials/);
    });

    await run('the calibration tutorial fits the tank to its measurements, keeps the fit and runs it, and is ticked in the list', async () => {
        const { press, waitForStep, clickLabel, clean } = tutorialHelpers();
        await clean();
        assert.equal(await evaluate(window, `window.__debugTour.startTutorial('calibrateTank')`), true);
        await waitForStep('welcome');
        await press('.tourFloating .tourPrimary');
        await waitForStep('openTuning');
        await press('#parameterTuningButton');
        await waitForStep('addData');
        // The card's link downloads the example's measurements; it does not load them: choosing the file is the person's to do.
        assert.match(await evaluate(window, `document.querySelector('.tourFloating .tourContentLink').textContent`), /Download the measurements/);
        const shipped = await readFile(join(process.cwd(), 'examples', 'tankCalibrationMeasured.csv'), 'utf8');
        if (driver.capabilities.multiWindow) {
            // On the desktop it is saved straight to the Downloads folder (the test's own, beside its user data), and the card says where.
            await press('.tourFloating .tourContentLink');
            await waitFor(window, `/^Saved to .*Downloads/.test(document.querySelector('.tourFloating .tourLinkNote').textContent)`, 'The card did not say where the file was saved.');
            const savedPath = (await evaluate(window, `document.querySelector('.tourFloating .tourLinkNote').textContent`)).replace(/^Saved to /, '');
            assert.equal(await readFile(savedPath, 'utf8'), shipped, 'The downloaded copy is not the example\'s measurements.');
            // Downloading it again keeps the first copy and saves another beside it, as a browser does.
            await press('.tourFloating .tourContentLink');
            await waitFor(window, `/\\(1\\)\\.csv$/.test(document.querySelector('.tourFloating .tourLinkNote').textContent)`, 'A second download did not get a name of its own.');
        } else {
            const downloaded = await driver.captureExport(() => press('.tourFloating .tourContentLink'));
            assert.equal(downloaded.bytes.toString('utf8'), shipped, 'The downloaded copy is not the example\'s measurements.');
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(await evaluate(window, `window.__debugTour.step()`), 'addData', 'Downloading the file is not choosing it.');
        // Choosing it through "Choose CSV file" (the file picker cannot be driven, so its file is handed over as the picker would).
        await evaluate(window, `window.__debugParameterTuning.loadCsv(${JSON.stringify(shipped)}, 'tankCalibrationMeasured.csv')`);
        await waitForStep('runFit');
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningStatus').textContent`), /Matched 1 to existing states/);
        await waitFor(window, `!document.querySelector('#runParameterTuning').disabled && !document.querySelector('#runParameterTuning').hidden`, 'Run fit was not offered.');
        await press('#runParameterTuning');
        await waitForStep('apply', 120000);
        await waitFor(window, `!document.querySelector('#commitParameterTuning').disabled`, 'Apply fitted values was not offered.');
        await press('#commitParameterTuning');
        await waitForStep('run', 30000);
        const saved = await savedProject();
        const capacitance = saved.sharedParameters.find((parameter) => parameter.symbol === 'waterThermalCapacitance').value;
        const loss = saved.edges.find((edge) => edge.name === 'Ambient heat loss').parameters.find((parameter) => parameter.symbol === 'heatLossCoefficient').value;
        assert.ok(Math.abs(capacitance / 209000 - 1) < 0.05, `The fit found the capacitance: ${capacitance}.`);
        assert.ok(Math.abs(loss / 20 - 1) < 0.05, `The fit found the heat loss: ${loss}.`);
        await waitFor(window, `document.querySelector('#runButton').title === 'Run simulation'`, 'The model was not validated for a run.', 15000);
        // A run left online (paced against the clock) by something earlier would take the eight simulated hours: the fill turns it off.
        await press('#runButton');
        await waitFor(window, `document.querySelector('#runLaunchDialog').open`, 'The Run dialog did not open.');
        await evaluate(window, `(() => { const online = document.querySelector('#runOnlineMode'); online.checked = true; online.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        // Skipping the step runs it as asked, offline, whatever the Run dialog was left set to.
        await press('.tourFloating .tourSkipStep');
        await waitFor(window, `!document.querySelector('#runLaunchDialog').open`, 'The skipped run did not start.', 15000);
        await waitForStep('plotTank', 60000);
        assert.equal(await evaluate(window, `document.querySelector('#runOnlineMode').checked`), false, 'The skipped run was left online.');
        await clickLabel('Water tank');
        await waitForStep('finish');
        await press('.tourFloating .tourPrimary');
        await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tutorial.');
        assert.match(await evaluate(window, `document.querySelector('#statusText').textContent`), /Tutorial finished/);
        await press('#tutorialsButton');
        await waitFor(window, `Boolean(document.querySelector('.tutorialEntry[data-tutorial="calibrateTank"] .tutorialDone'))`, 'The finished tutorial was not ticked.');
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.tutorialEntry')].map((entry) => entry.dataset.tutorial)`), tutorialListOrder, 'A finished tutorial keeps its place.');
        await press('#tutorialsClose');
    });

    await run('the controller tutorial runs the joint, raises the gain in the relationship editor, runs it again and compares', async () => {
        const { press, waitForStep, clickLabel, cardOverlaps, clean } = tutorialHelpers();
        await clean();
        assert.equal(await evaluate(window, `window.__debugTour.startTutorial('tuneController')`), true);
        await waitForStep('welcome');
        await press('.tourFloating .tourPrimary');
        await waitForStep('run');
        await waitFor(window, `document.querySelector('#runButton').title === 'Run simulation'`, 'The model was not validated for a run.', 15000);
        await press('#runButton');
        await waitFor(window, `document.querySelector('#runLaunchDialog').open`, 'The Run dialog did not open.');
        await evaluate(window, `(() => { const field = document.querySelector('#runTargetTime'); field.value = '10'; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await press('#startRun');
        await waitForStep('plotAngle', 60000);
        await clickLabel('Joint link');
        await waitForStep('closeResults');
        // The Joint link's editor is open and covers the end of the timeline, so the step points at its close button first.
        await waitFor(window, `!document.querySelector('.tourRing').hidden && Math.abs(document.querySelector('.tourRing').getBoundingClientRect().top - document.querySelector('#nodeEditor > header [data-close-card]').getBoundingClientRect().top) < 8`, 'The ring did not move to the editor\'s close button.');
        await press('#nodeEditor > header [data-close-card]');
        await waitFor(window, `document.querySelector('#nodeEditor').classList.contains('hidden')`, 'The editor did not close.');
        await waitFor(window, `Math.abs(document.querySelector('.tourRing').getBoundingClientRect().top - document.querySelector('#closeResults').getBoundingClientRect().top) < 8`, 'The ring did not move to Close and edit.');
        await press('#closeResults');
        await waitFor(window, `document.querySelector('#closeResultsDialog').open`, 'Closing the results did not ask first.');
        await press('#confirmCloseResults');
        await waitForStep('openController');
        await press('.tourFloating .tourSkipStep');
        await waitForStep('changeGain');
        assert.equal(await evaluate(window, `document.querySelector('#edgeEditor').classList.contains('hidden')`), false, 'Skipping did not open the controller.');
        assert.equal(await cardOverlaps('#edgeEditor'), false, 'The tutorial card covers the relationship editor.');
        // Changing the gain by hand, as the card asks.
        await evaluate(window, `(() => { const input = document.querySelector('#edgeEditorParameters [data-parameter-id="19"] input[data-field="value"]'); input.value = '10'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitForStep('rerun');
        const saved = await savedProject();
        assert.equal(saved.edges.find((edge) => edge.name === 'Position control').parameters.find((parameter) => parameter.symbol === 'gain').value, 10);
        await press('.tourFloating .tourSkipStep');
        await waitForStep('compare', 60000);
        await clickLabel('Joint link');
        await waitForStep('finish');
        assert.match(await evaluate(window, `document.querySelector('.tourFloating .tourText').textContent`), /unstable/);
        await press('.tourFloating .tourPrimary');
        await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tutorial.');
    });

    await run('the optimisation tutorial writes an objective with the card\'s buttons, maximises it over eight hours and holds it to a limit', async () => {
        const { press, waitForStep, clean } = tutorialHelpers();
        await clean();
        assert.equal(await evaluate(window, `window.__debugTour.startTutorial('optimiseObjective')`), true);
        await waitForStep('welcome');
        await press('.tourFloating .tourPrimary');
        await waitForStep('openTuning');
        await press('#parameterTuningButton');
        await waitForStep('chooseObjective');
        await press('#parameterTuningGoalObjective');
        await waitForStep('writeObjective');
        await evaluate(window, `[...document.querySelectorAll('#parameterTuningSummaryButtons button')].find((button) => button.textContent === 'final').click()`);
        await evaluate(window, `[...document.querySelectorAll('#parameterTuningStateChips button')].find((button) => button.textContent.includes('Water tank · Water temperature')).click()`);
        await waitForStep('setGoal', 15000);
        await evaluate(window, `(() => {
            const set = (selector, value, kind = 'input') => { const field = document.querySelector(selector); field.value = value; field.dispatchEvent(new Event(kind, { bubbles: true })); };
            set('#parameterTuningDirection', 'maximise', 'change'); set('#parameterTuningRunTime', '28800'); set('#parameterTuningTimeStep', '600');
        })()`);
        await waitForStep('addLimit');
        // The limit by skipping: the card writes it as the buttons would.
        await press('.tourFloating .tourSkipStep');
        await waitForStep('runSearch', 15000);
        const limitRow = await evaluate(window, `(() => { const row = document.querySelector('#parameterTuningConstraintRows .parameterTuningConstraintRow'); return { latex: row.querySelector('math-field').value, limit: row.querySelector('[data-field="limit"]').value }; })()`);
        assert.match(limitRow.latex, /max.*waterTankTankTemperature/);
        assert.equal(limitRow.limit, '340');
        await waitFor(window, `!document.querySelector('#runParameterTuning').disabled`, 'The search could not be run.', 15000);
        await press('#runParameterTuning');
        await waitForStep('review', 180000);
        assert.match(await evaluate(window, `document.querySelector('#parameterTuningComparisonStatus').textContent`), /^Maximised objective: .*All limits hold\./);
        const report = await evaluate(window, `window.__debugParameterTuning.report()`);
        assert.ok(report.finalLoss <= 340.5 && report.finalLoss > 320, `The search settled just under the limit: ${report.finalLoss}.`);
        await press('.tourFloating .tourPrimary');
        await waitForStep('finish');
        await press('.tourFloating .tourPrimary');
        await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tutorial.');
        await evaluate(window, `document.querySelector('#cancelParameterTuning').click()`);
    });

    await run('the stability tutorial stiffens a spring, follows the pre-run warning to its cause and fixes it with substeps', async () => {
        const { press, waitForStep, clickLabel, clean } = tutorialHelpers();
        await clean();
        assert.equal(await evaluate(window, `window.__debugTour.startTutorial('fixInstability')`), true);
        await waitForStep('welcome');
        await press('.tourFloating .tourPrimary');
        await waitForStep('stiffen');
        // The spring's row in its relationship label, when the labels show rows (they may be collapsed by an earlier scenario's detail).
        if (await evaluate(window, `Boolean(document.querySelector('.relationshipRow[data-relationship="8"]'))`)) {
            await evaluate(window, `document.querySelector('.relationshipRow[data-relationship="8"]').click()`);
            await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`, 'The spring did not open.');
            await evaluate(window, `(() => { const input = document.querySelector('#edgeEditorParameters [data-parameter-id="9"] input[data-field="value"]'); input.value = '400'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        } else {
            await press('.tourFloating .tourSkipStep');
        }
        await waitForStep('seeWarning');
        await settle(window, 'validation');
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && document.querySelector('#validationIssues').textContent.includes('at least 11')`, 'The pre-run check did not warn about the stiff spring.', 15000);
        await press('#validationSummary');
        await waitForStep('followWarning');
        await evaluate(window, `[...document.querySelectorAll('#validationIssues .validationIssue')].find((item) => item.textContent.includes('at least 11')).click()`);
        await waitForStep('raiseSubsteps');
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeName').value`), 'Spring force', 'The warning led to the relationship it blames.');
        await clickLabel('Suspended mass');
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'The mass did not open.');
        await press('#nodeEditor [data-editor-tab="numerics"]');
        await evaluate(window, `(() => { const input = document.querySelector('#editNodeSubsteps'); input.value = '11'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitForStep('run', 15000);
        await press('.tourFloating .tourSkipStep');
        // The mass's editor is still open from its substeps, so its plot may be on screen as soon as the run ends: the step is then done.
        await waitFor(window, `['plot', 'finish'].includes(window.__debugTour.step())`, 'The run did not finish.', 60000);
        if (await evaluate(window, `window.__debugTour.step()`) === 'plot') await clickLabel('Suspended mass');
        await waitForStep('finish');
        await press('.tourFloating .tourPrimary');
        await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tutorial.');
    });

    await run('the components tutorial builds a motor and its load from library parts and relationships, and runs it', async () => {
        const { press, waitForStep, clickLabel, clean } = tutorialHelpers();
        await clean();
        assert.equal(await evaluate(window, `window.__debugTour.startTutorial('buildFromComponents')`), true);
        await waitForStep('welcome');
        await press('.tourFloating .tourPrimary');
        await waitForStep('openLibrary');
        await press('#componentLibraryButton');
        await waitForStep('placeParts');
        await waitFor(window, `document.querySelectorAll('.componentLibraryItem').length > 0`, 'The library did not load.', 10000);
        for (const id of ['voltageSource', 'motor', 'torqueLoad']) {
            const before = await evaluate(window, `window.__debugProject.serialize().nodes.length`);
            await press(`[data-template-id="${id}"]`);
            await waitFor(window, `window.__debugProject.serialize().nodes.length === ${before + 1}`, `${id} was not placed.`);
        }
        await waitForStep('armature');
        // The ring follows the template, then each end, then Create edge.
        await press('[data-template-id="armatureDynamics"]');
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'The template did not ask for its ends.');
        await clickLabel('Voltage source');
        await waitFor(window, `document.querySelector('#endpointPickTitle').textContent.includes('target')`, 'The source end was not taken.');
        await clickLabel('Motor');
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden') && document.querySelector('#equationDiagnostics').classList.contains('valid')`, 'The template\'s equation did not bind itself.', 10000);
        await waitForStep('shaft');
        await press('.tourFloating .tourSkipStep');
        await waitForStep('run', 20000);
        const saved = await savedProject();
        assert.deepEqual(saved.edges.map((edge) => edge.name).sort(), ['Armature dynamics', 'Shaft dynamics']);
        await press('.tourFloating .tourSkipStep');
        await waitFor(window, `['plot', 'finish'].includes(window.__debugTour.step())`, 'The run did not finish.', 60000);
        if (await evaluate(window, `window.__debugTour.step()`) === 'plot') await clickLabel('Motor');
        await waitForStep('finish');
        await press('.tourFloating .tourPrimary');
        await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tutorial.');
    });

    await run('the branches tutorial forks a run at 4 s with a new target angle, runs the fork and compares it with the baseline', async () => {
        const { press, waitForStep, clickLabel, clean } = tutorialHelpers();
        await clean();
        assert.equal(await evaluate(window, `window.__debugTour.startTutorial('whatIfBranches')`), true);
        await waitForStep('welcome');
        await press('.tourFloating .tourPrimary');
        await waitForStep('run');
        await press('.tourFloating .tourSkipStep');
        await waitForStep('scrub', 60000);
        await evaluate(window, `(() => { const timeline = document.querySelector('#resultTimeline'); timeline.value = '4'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitForStep('fork');
        await press('#branchesButton');
        await waitFor(window, `!document.querySelector('#branchesPanel').hidden && /^Fork at 4/.test(document.querySelector('#forkHereLabel').textContent)`, 'The branches did not offer a fork at 4 s.');
        await press('#forkHereButton');
        await waitForStep('changeTarget');
        await waitFor(window, `!document.querySelector('#forkParameterPanel').hidden`, 'The fork\'s parameters were not offered.');
        await evaluate(window, `(() => { const input = [...document.querySelectorAll('#forkParameterRows input[type="number"]')].find((candidate) => candidate.getAttribute('aria-label') === 'Setpoint angle value'); input.value = '-0.5'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await press('#confirmForkParameters');
        await waitFor(window, `document.querySelector('#runLaunchDialog').open && /^Fork from 4/.test(document.querySelector('#runLaunchDescription').textContent)`, 'The fork\'s Run dialog did not open.');
        await evaluate(window, `(() => { const field = document.querySelector('#runTargetTime'); field.value = '10'; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await press('#startRun');
        await waitForStep('plot', 60000);
        assert.equal(await evaluate(window, `document.querySelector('#branchesButtonCount').textContent`), '2');
        await clickLabel('Joint link');
        await waitForStep('compare');
        await press('#branchesButton');
        await waitFor(window, `document.querySelectorAll('#branchTree .branchTreeItem').length === 2`, 'The branch tree did not list both branches.');
        const tracesAlone = await evaluate(window, `document.querySelector('#nodeResultPlot').data?.length ?? 0`);
        await evaluate(window, `(() => { const box = document.querySelector('#branchTree .branchCompareToggle:not(:disabled)'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitForStep('finish');
        await waitFor(window, `document.querySelector('#nodeResultPlot').data.length > ${tracesAlone}`, 'Comparing did not add the baseline\'s curves.', 10000);
        await press('.tourFloating .tourPrimary');
        await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tutorial.');
    }, { skip: !driver.capabilities.forks && 'the web engine keeps no checkpoints to fork from' });

    await run('the inference tutorial downloads a heating record, finds the two causes of the room\'s temperature and imports them as a model', async () => {
        const { press, waitForStep, clean } = tutorialHelpers();
        await clean();
        assert.equal(await evaluate(window, `window.__debugTour.startTutorial('discoverEquations')`), true);
        await waitForStep('welcome');
        await press('.tourFloating .tourPrimary');
        await waitForStep('openInference');
        await press('#causalInferenceButton');
        await waitForStep('addData');
        const recording = await readFile(join(process.cwd(), 'examples', 'heatingRecord.csv'), 'utf8');
        if (driver.capabilities.multiWindow) {
            await press('.tourFloating .tourContentLink');
            await waitFor(window, `/^Saved to .*heatingRecord.*\\.csv$/.test(document.querySelector('.tourFloating .tourLinkNote').textContent)`, 'The card did not say where the recording was saved.');
            const savedPath = (await evaluate(window, `document.querySelector('.tourFloating .tourLinkNote').textContent`)).replace(/^Saved to /, '');
            assert.equal(await readFile(savedPath, 'utf8'), recording);
        } else {
            const downloaded = await driver.captureExport(() => press('.tourFloating .tourContentLink'));
            assert.equal(downloaded.bytes.toString('utf8'), recording);
        }
        // Chosen through "Choose CSV file" (handed over as the file picker would).
        await evaluate(window, `window.__debugCausalInference.loadCsv(${JSON.stringify(recording)})`);
        await waitForStep('runInference');
        await waitFor(window, `!document.querySelector('#runCausalInference').disabled`, 'Run inference was not offered.');
        await press('#runCausalInference');
        await waitForStep('import', 60000);
        const found = await evaluate(window, `[...document.querySelectorAll('#causalInferenceCandidateRows .causalInferenceCandidateMain')].map((span) => span.textContent)`);
        assert.ok(found.some((text) => text.includes('outdoorTemperature → roomTemperature')), `The weather's effect was not found: ${found}`);
        assert.ok(found.some((text) => text.includes('heaterPower → roomTemperature')), `The heater's effect was not found: ${found}`);
        assert.equal(found.length, 2, `Only the two causes were found: ${found}`);
        await press('#commitCausalInference');
        await waitForStep('readEquation', 15000);
        const saved = await savedProject();
        assert.equal(saved.nodes.length, 3);
        assert.equal(saved.edges.length, 2);
        await press('.tourFloating .tourSkipStep');
        await waitForStep('finish');
        await press('.tourFloating .tourPrimary');
        await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tutorial.');
    });

    // Closes a tutorial's twin window, its twin stopped first if it is still running.
    const closeTutorialTwin = async () => {
        const twin = await driver.waitForNewHandle([], { titleIncludes: 'Live twin' }, 2000).catch(() => null);
        if (!twin) return;
        await evaluate(twin, `(() => { const stop = document.querySelector('#roomStop'); if (stop && !stop.hidden && !stop.disabled) stop.click(); })()`).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 500));
        await twin.close();
        await waitFor(window, `!window.__debugTour.blockers().simulationRunning`, 'The project window was left busy.', 10000);
    };

    await run('the live twin tutorial follows a person into the twin window, through a demonstration, to the drift warning', async () => {
        const { press, waitForStep, clean } = tutorialHelpers();
        await clean();
        assert.equal(await evaluate(window, `window.__debugTour.startTutorial('liveTwin')`), true);
        await waitForStep('welcome');
        await press('.tourFloating .tourPrimary');
        await waitForStep('openTwin');
        const beforeTwin = driver.allHandles();
        await press('#liveTwinButton');
        const twin = await driver.waitForNewHandle(beforeTwin, { titleIncludes: 'Live twin' }, 15000);
        await waitForStep('chooseDemo');
        // The twin window covers the card, so the step is shown there too.
        await waitFor(twin, `!document.querySelector('#tutorialBanner').hidden && document.querySelector('#tutorialBannerTitle').textContent === 'Choose a demonstration'`, 'The step was not shown in the twin window.');
        await evaluate(twin, `document.querySelector('#openDemos').click()`);
        await waitFor(twin, `document.querySelector('#demosDialog').open`, 'The demonstrations were not offered.');
        await evaluate(twin, `document.querySelector('[data-demo="drifting"]').click()`);
        await waitForStep('watch', 60000);
        await waitFor(twin, `document.querySelector('#tutorialBannerTitle').textContent === 'The control room'`, 'The next step was not shown in the twin window.');
        await waitForStep('drift', 120000);
        await waitForStep('finish', 180000);
        await waitFor(twin, `document.querySelector('#tutorialBanner').hidden`, 'The banner stayed after the twin\'s steps.');
        await press('.tourFloating .tourPrimary');
        await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tutorial.');
        await closeTutorialTwin();
    }, { skip: !driver.capabilities.multiWindow && 'the live twin has its own window, in the desktop app' });

    await run('the steering tutorial binds W and S to the joint\'s target angle in Settings and steers it with them in a real-time run', async () => {
        const { press, waitForStep, clickLabel, clean } = tutorialHelpers();
        const key = (type, code) => evaluate(window, `window.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, { code: ${JSON.stringify(code)}, bubbles: true, cancelable: true }))`);
        await clean();
        await evaluate(window, `window.__debugSteering.steering.save({ bindings: [] })`);
        try {
            assert.equal(await evaluate(window, `window.__debugTour.startTutorial('steerByHand')`), true);
            await waitForStep('welcome');
            await press('.tourFloating .tourPrimary');
            await waitForStep('openControllers');
            await press('#settingsButton');
            await waitFor(window, `document.querySelector('#settingsDialog').open`, 'Settings did not open.');
            await press('[data-settings-target="controllers"]');
            await waitForStep('bindKey');
            const setpointBind = await evaluate(window, `(() => { const row = [...document.querySelectorAll('#controllerParameters .controllerParameter')].find((candidate) => candidate.querySelector('.settingsItemLabel').textContent === 'Setpoint angle'); return row ? \`[data-bind-symbol="\${row.dataset.symbol}"]\` : null; })()`);
            assert.ok(setpointBind, 'Setpoint angle was not listed to bind.');
            await waitFor(window, `document.querySelector('.tourRing') && document.querySelector('${setpointBind}')`, 'The Bind button was not there.');
            await press(setpointBind);
            await waitFor(window, `Boolean(document.querySelector('#controllerParameters .controllerParameter.listening'))`, 'Bind did not wait for a key.');
            await key('keydown', 'KeyW');
            await key('keyup', 'KeyW');
            await waitForStep('addDownKey');
            await press('#controllerParameters .controllerBindingRow [data-change]');
            await waitFor(window, `document.querySelector('.inputBindingDialog')?.open`, 'The binding\'s settings did not open.');
            await evaluate(window, `[...document.querySelectorAll('.inputBindingDialog footer button')].find((button) => button.textContent.startsWith('Add a key')).click()`);
            await key('keydown', 'KeyS');
            await key('keyup', 'KeyS');
            await waitFor(window, `document.querySelector('.inputBindingDialog strong')?.textContent === '⌨ W / S'`, 'The second key was not added.');
            await evaluate(window, `document.querySelector('.inputBindingDialog button[type=submit]').click()`);
            await waitForStep('startRun');
            // The run started by skipping: online, in real time.
            await press('.tourFloating .tourSkipStep');
            await waitForStep('steer', 20000);
            assert.equal(await evaluate(window, `window.__debugTour.blockers().simulationRunning`), true, 'The run was not going.');
            await key('keydown', 'KeyW');
            await new Promise((resolve) => setTimeout(resolve, 1200));
            await key('keyup', 'KeyW');
            await waitForStep('plot', 10000);
            const record = await evaluate(window, `window.__debugSteering.result().interventions.filter((change) => change.kind !== 'restart')`);
            assert.ok(record.length > 0 && record.every((change) => change.parameterId === 21), 'The steering was recorded against the target angle.');
            await waitFor(window, `!window.__debugTour.blockers().simulationRunning`, 'The real-time run did not end.', 60000);
            await clickLabel('Joint link');
            await waitForStep('finish');
            await press('.tourFloating .tourPrimary');
            await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tutorial.');
        } finally {
            await evaluate(window, `window.__debugSteering.steering.save({ bindings: [] })`);
        }
    }, { skip: !driver.capabilities.multiWindow && 'the steering tutorial is for the desktop app' });

    await run('the organising tutorial copies a body into three, meshes them with an edge group, folds them into a subsystem and runs inside it', async () => {
        const { press, waitForStep, clickLabel, clean } = tutorialHelpers();
        await clean();
        assert.equal(await evaluate(window, `window.__debugTour.startTutorial('organiseModel')`), true);
        await waitForStep('welcome');
        await press('.tourFloating .tourPrimary');
        await waitForStep('placeMass');
        await press('#componentLibraryButton');
        await waitFor(window, `Boolean(document.querySelector('[data-template-id="thermalMass"]'))`, 'The library did not load.', 10000);
        await press('[data-template-id="thermalMass"]');
        await waitForStep('copyPaste');
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((label) => label.textContent.includes('Thermal mass'))`, 'The body was not placed.');
        await clickLabel('Thermal mass');
        await waitFor(window, `!document.querySelector('#copySelection').disabled`, 'Copy was not offered.');
        await press('#copySelection');
        await waitFor(window, `!document.querySelector('#pasteSelection').disabled`, 'Paste was not offered.');
        await press('#pasteSelection');
        await waitFor(window, `window.__debugProject.serialize().nodes.length === 2`, 'The first paste did not land.');
        await press('#pasteSelection');
        await waitForStep('warmOne');
        await press('.tourFloating .tourSkipStep');
        await waitForStep('selectAll');
        await evaluate(window, `(() => { document.activeElement?.blur?.(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })); })()`);
        await waitForStep('makeGroup');
        await press('#createEdgeGroup');
        await waitForStep('groupEquation');
        await waitFor(window, `document.querySelectorAll('.modelStatus span')[1].textContent === '6 relationships'`, 'The group did not mesh three bodies into six relationships.');
        await press('.tourFloating .tourSkipStep');
        await waitForStep('makeSubsystem', 15000);
        if (await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length < 3`)) await evaluate(window, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })); })()`);
        await press('#createSubsystem');
        await waitFor(window, `document.querySelector('#subsystemDialog').open`, 'The subsystem was not asked for.');
        await evaluate(window, `(() => { document.querySelector('#subsystemName').value = 'Bodies'; document.querySelector('#subsystemCreate').click(); })()`);
        await waitForStep('enter');
        // A box's label is put in the page when it is next drawn, so its Open button is waited for.
        await waitFor(window, `Boolean([...document.querySelectorAll('.subsystemLabel')].find((label) => label.textContent.includes('Bodies'))?.querySelector('.subsystemOpen'))`, 'The Bodies box has no Open button.');
        await evaluate(window, `[...document.querySelectorAll('.subsystemLabel')].find((label) => label.textContent.includes('Bodies')).querySelector('.subsystemOpen').click()`);
        await waitForStep('run');
        await press('.tourFloating .tourSkipStep');
        await waitFor(window, `['plot', 'leave'].includes(window.__debugTour.step())`, 'The run did not finish.', 60000);
        if (await evaluate(window, `window.__debugTour.step()`) === 'plot') await clickLabel('Thermal mass');
        await waitForStep('leave');
        await press('[data-subsystem-parent]');
        await waitForStep('finish');
        const saved = await savedProject();
        assert.equal(saved.edgeGroups.length, 1);
        assert.equal(saved.subsystems.length, 1);
        assert.equal(saved.nodes.filter((node) => node.subsystemId === saved.subsystems[0].id).length, 3);
        await press('.tourFloating .tourPrimary');
        await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tutorial.');
    });

    await run('the reuse tutorial makes a component with a port and a parameter, places it twice, connects and runs them, and keeps it in my library', async () => {
        const { press, waitForStep, clean } = tutorialHelpers();
        await clean();
        assert.equal(await evaluate(window, `window.__debugTour.startTutorial('reuseComponent')`), true);
        await waitForStep('welcome', 20000);
        await press('.tourFloating .tourPrimary');
        for (const step of ['fold', 'openCard', 'port', 'expose', 'another', 'ownValue', 'connect', 'run', 'library', 'fromLibrary']) {
            await waitForStep(step, step === 'library' ? 120000 : 20000);
            await waitFor(window, `!document.querySelector('.tourFloating .tourSkipStep').hidden && !document.querySelector('.tourFloating .tourSkipStep').disabled`, `${step} offered no Skip this step.`);
            await press('.tourFloating .tourSkipStep');
            await waitFor(window, `window.__debugTour.step() !== ${JSON.stringify(step)}`, `Skipping ${step} did not move on.`, 180000);
            assert.equal(await evaluate(window, `document.querySelector('.tourFloating .tourNotice').hidden`), true, `After skipping ${step}, a step was reported undone.`);
        }
        assert.equal(await evaluate(window, `window.__debugTour.step()`), 'finish');
        const saved = await evaluate(window, `window.__debugProject.serialize()`);
        const pairs = saved.subsystems.filter((subsystem) => subsystem.definitionId != null && !saved.subsystemDefinitions.find((definition) => definition.id === subsystem.definitionId)?.link);
        assert.equal(pairs.length, 2, 'Two instances.');
        assert.equal(new Set(pairs.map((subsystem) => subsystem.definitionId)).size, 1, 'Of one component.');
        assert.ok(saved.subsystemDefinitions.some((item) => item.link?.kind === 'library'), 'A third, placed from my library, is linked to it.');
        const definition = saved.subsystemDefinitions.find((item) => item.id === pairs[0].definitionId).document;
        assert.ok(definition.component.ports.some((port) => port.name === 'Outlet'), 'The port is named.');
        assert.ok(definition.sharedParameters.some((shared) => shared.exposed && shared.symbol === 'conductance'), 'Conductance is exposed.');
        assert.deepEqual(saved.sharedParameters.filter((shared) => pairs.some((pair) => pair.id === shared.subsystemId) && shared.symbol.startsWith('conductance')).map((shared) => [shared.symbol, shared.value]).sort((a, b) => a[1] - b[1]), [['conductance2', 10], ['conductance', 50]], 'Each instance has its own conductance, under a symbol of its own.');
        assert.ok(saved.edges.some((edge) => edge.name === 'Link'), 'The two are connected.');
        assert.ok((await evaluate(window, `window.componentLibrary.list()`)).some((template) => template.source === 'user' && template.kind === 'component' && template.name === 'Pair'), 'The component is in my library.');
        await press('.tourFloating .tourPrimary');
        await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tutorial.');
        // My library is the machine's: the component saved here is taken out again, so the scenarios after this find it as they expect.
        await evaluate(window, `window.componentLibrary.list().then((templates) => Promise.all(templates.filter((template) => template.source === 'user' && template.name === 'Pair').map((template) => window.componentLibrary.removeUser(template.id))))`);
    });

    await run('the joystick tutorial binds two joysticks\' four axes to an excavator and digs with them in a real-time run', async () => {
        const { press, waitForStep, clean } = tutorialHelpers();
        const left = 'Left joystick (simulated)';
        const right = 'Right joystick (simulated)';
        const axis = (pad, index, value) => evaluate(window, `(() => { const devices = window.__debugSteering.devices; devices.moveAxis(${JSON.stringify(pad)}, ${index}, ${value}); devices.poll(); })()`);
        const tipHeight = () => evaluate(window, `(() => { const project = window.__debugProject.serialize(); const tip = project.nodes.find((node) => node.name === 'Bucket tip'); const id = tip.states.find((state) => state.symbol === 'height').id; return window.__debugSteering.result()?.samples.at(-1)?.states.find((entry) => entry.stateId === id)?.value ?? null; })()`);
        await clean();
        await evaluate(window, `window.__debugSteering.steering.save({ bindings: [] })`);
        try {
            assert.equal(await evaluate(window, `window.__debugTour.startTutorial('driveWithJoysticks')`), true);
            await waitForStep('welcome');
            await press('.tourFloating .tourPrimary');
            await waitForStep('connect');
            // The card says what Konjugate sees, as it changes: nothing, then one joystick (two axes, not yet four), then two.
            await waitFor(window, `/sees no joystick/.test(document.querySelector('.tourFloating .tourStatus').textContent)`, 'The card did not say no joystick is seen.');
            await press('#settingsButton');
            await waitFor(window, `document.querySelector('#settingsDialog').open`, 'Settings did not open.');
            await press('[data-settings-target="controllers"]');
            await waitFor(window, `Boolean(document.querySelector('#controllerDevices .controllerNoDevice'))`, 'Settings did not say no controller is seen.');
            // With nothing seen, the steps for connecting one are open; the card's link opens them too.
            assert.equal(await evaluate(window, `document.querySelector('#controllerHelp').open`), true, 'The steps for connecting a controller were not open.');
            assert.match(await evaluate(window, `document.querySelector('#controllerHelp').textContent`), /PlayStation 4 controller: hold PS and Share/);
            await evaluate(window, `document.querySelector('#controllerHelp > summary').click()`);
            assert.equal(await evaluate(window, `document.querySelector('#controllerHelp').open`), false);
            await press('.tourFloating .tourContentLink');
            await waitFor(window, `document.querySelector('#controllerHelp').open`, 'The card\'s link did not open the steps for connecting a controller.');
            // The computer has nothing connected: the row says so. Then the left joystick is connected but not used in the window yet:
            // the row names it and says to press a button, and so does the card.
            await evaluate(window, `window.__debugSteering.setConnectedControllers([])`);
            await waitFor(window, `/No controller connected to this computer/.test(document.querySelector('#controllerDevices .controllerNoDevice').textContent)`, 'Settings did not say nothing is connected to the computer.');
            await evaluate(window, `window.__debugSteering.setConnectedControllers([{ name: ${JSON.stringify(left)}, vendorId: 0, productId: 0 }])`);
            await waitFor(window, `/Press one of its buttons while this window is in front/.test(document.querySelector('#controllerDevices .controllerNotSeen')?.textContent ?? '')`, 'Settings did not name the controller that is connected but not seen.');
            await waitFor(window, `/This computer has Left joystick \\(simulated\\) connected: press one of its buttons/.test(document.querySelector('.tourFloating .tourStatus').textContent)`, 'The card did not say to press a button on the connected joystick.');
            await evaluate(window, `(() => { const devices = window.__debugSteering.devices; devices.connectGamepad(${JSON.stringify(left)}, { axes: 2, buttons: 4 }); devices.poll(); })()`);
            await waitFor(window, `!document.querySelector('#controllerDevices .controllerNotSeen')`, 'The joystick, once seen, was still listed as not seen.');
            await waitFor(window, `/one controller .*2 axes in all: four are needed/.test(document.querySelector('.tourFloating .tourStatus').textContent)`, 'The card did not say one joystick is not enough.');
            assert.equal(await evaluate(window, `window.__debugTour.step()`), 'connect', 'One joystick of two axes is not four.');
            await evaluate(window, `(() => { const devices = window.__debugSteering.devices; devices.connectGamepad(${JSON.stringify(right)}, { axes: 2, buttons: 4 }); devices.poll(); })()`);
            await waitForStep('bind');
            // Settings › Controllers lists both, each with its two axes and four buttons, moving as they are moved.
            await waitFor(window, `document.querySelectorAll('#controllerDevices .controllerDevice[data-device-id]').length === 2`, 'Settings did not list the two joysticks.');
            // Each drawn as a stick in its gate (not a standard gamepad), with its four buttons beneath.
            assert.equal(await evaluate(window, `document.querySelectorAll('#controllerDevices [data-device-id="Left joystick (simulated)"] .controllerOutline.joystick .controllerKnob[data-stick="0,1"]').length`), 1);
            assert.equal(await evaluate(window, `document.querySelectorAll('#controllerDevices [data-device-id="Left joystick (simulated)"] .controllerOutline [data-button]').length`), 4);
            await axis(left, 0, 0.8);
            await waitFor(window, `document.querySelector('#controllerDevices .controllerKnob[data-pad="Left joystick (simulated)"]').classList.contains('moved')`, 'The drawn stick did not follow the joystick.');
            await evaluate(window, `(() => { const devices = window.__debugSteering.devices; devices.setButton(${JSON.stringify(left)}, 2, 1); devices.poll(); })()`);
            await waitFor(window, `document.querySelector('#controllerDevices .controllerOutline [data-pad="Left joystick (simulated)"][data-button="2"]').classList.contains('active')`, 'The drawn button did not light up.');
            await evaluate(window, `(() => { const devices = window.__debugSteering.devices; devices.setButton(${JSON.stringify(left)}, 2, 0); devices.poll(); })()`);
            await axis(left, 0, 0);
            // Bound by hand, as the card says: Bind beside Swing command, the left joystick moved, and the page goes on to each command not
            // bound yet by itself, the card saying which control to move for it.
            const status = () => evaluate(window, `document.querySelector('.tourFloating .tourStatus').textContent`);
            // The card is drawn again on the tour's poll (every 300 ms), after the page has changed: waited for, then asserted, so a wrong
            // text is still shown as it was. (Read at once, it once still said "2 of 4 bound" under a loaded coverage run.)
            const statusSays = async (pattern) => {
                await waitFor(window, `${pattern}.test(document.querySelector('.tourFloating .tourStatus').textContent)`, '').catch(() => {});
                assert.match(await status(), pattern);
            };
            await statusSays(/^Next: Swing command, with the left joystick left or right\. Press Bind beside it\.$/);
            await press('[data-bind-symbol="swingCommand"]');
            await waitFor(window, `/^Listening for Swing command: move the left joystick left or right/.test(document.querySelector('.tourFloating .tourStatus').textContent)`, 'The card did not say what to move for Swing command.');
            const order = [['swingCommand', left, 0, 'boomCommand'], ['boomCommand', right, 1, 'stickCommand'], ['stickCommand', left, 1, 'bucketCommand']];
            for (const [symbol, pad, index, next] of order) {
                await axis(pad, index, 0.9);
                await waitFor(window, `window.__debugSteering.steering.document.bindings.some((binding) => binding.parameter.symbol === ${JSON.stringify(symbol)})`, `${symbol} was not bound.`);
                // Still held over, the control just bound is not taken again for the next command.
                await waitFor(window, `document.querySelector('.controllerParameter[data-symbol="${next}"]')?.classList.contains('listening')`, `The page did not go on to ${next}.`);
                await new Promise((resolve) => setTimeout(resolve, 150));
                await axis(pad, index, 0);
            }
            await statusSays(/^3 of 4 bound\. Listening for Bucket command: move the right joystick left or right\.$/);
            assert.match(await evaluate(window, `document.querySelector('#controllerBindStatus').textContent`), /^Bound .* to Stick command\. Now Bucket command: move the control for it, or press Esc to stop\.$/);
            const handBindings = await evaluate(window, `window.__debugSteering.steering.document.bindings.map((binding) => [binding.parameter.symbol, binding.device.id, binding.control.type, binding.control.index])`);
            assert.deepEqual(handBindings, [['swingCommand', left, 'axis', 0], ['boomCommand', right, 'axis', 1], ['stickCommand', left, 'axis', 1]]);
            // The last by skipping: bound to its axis the same way, the three made by hand kept as they are, and nothing listened for.
            await press('.tourFloating .tourSkipStep');
            await waitForStep('startRun');
            assert.deepEqual(await evaluate(window, `window.__debugSteering.steering.document.bindings.filter((binding) => binding.device.id === ${JSON.stringify(right)}).map((binding) => [binding.parameter.symbol, binding.control.index])`), [['boomCommand', 1], ['bucketCommand', 0]]);
            assert.equal(await evaluate(window, `Boolean(document.querySelector('.controllerParameter.listening'))`), false, 'Skipping left the page waiting for a control.');
            await press('#settingsClose');
            await press('.tourFloating .tourSkipStep');
            // The machine in 3D: the Pose Visualizer opened on the run as it goes, from the card, drawing the cab, boom, stick and bucket at
            // their true size and moving them as the joysticks move the machine. Without the add-on the card says so and Next carries on.
            await waitForStep('watch3d', 20000);
            if (driver.capabilities.addons && installedAddons.has('konjugate.poseVisualizer')) {
                await waitFor(window, `/Press Pose/.test(document.querySelector('.tourFloating .tourStatus').textContent)`, 'The card did not say to press Pose.');
                const before = driver.allHandles();
                await evaluate(window, `[...document.querySelectorAll('.tourFloating button')].find((button) => button.textContent === 'Open it for me').click()`);
                const poseWindow = await driver.waitForNewHandle(before);
                const bodies = () => evaluate(poseWindow, `window.__debugPoseVisualizer?.bodies() ?? []`);
                await waitFor(poseWindow, `(window.__debugPoseVisualizer?.bodies() ?? []).filter((body) => body.part).length === 4`, 'The 3D view did not draw the four parts at their true size.');
                assert.deepEqual((await bodies()).map((body) => body.name).sort(), ['Machine pose · boom', 'Machine pose · bucket', 'Machine pose · cab', 'Machine pose · stick']);
                await waitFor(window, `/^Open\\./.test(document.querySelector('.tourFloating .tourStatus').textContent)`, 'The card did not see the 3D view open.');
                // With the 3D view in front, the project window keeps its controllers (a real gamepad is read then too; a simulated one always is).
                await waitFor(window, `window.__debugSteering.followsFocus()`, 'The project window was not handed the controllers while the 3D view had focus.');
                const stickAt = async () => (await bodies()).find((body) => body.name.endsWith('stick')).position;
                const startedAt = await stickAt();
                // The right joystick forward lowers the boom, and the stick's end of it comes down in the 3D view as the run goes.
                await axis(right, 1, -1);
                await waitFor(poseWindow, `(window.__debugPoseVisualizer.bodies().find((body) => body.name.endsWith('stick'))?.position[2] ?? Infinity) < ${startedAt[2]} - 0.2`, 'The 3D view did not follow the boom coming down.', 15000);
                await axis(right, 1, 0);
                await closeWhenValidated(poseWindow);
                await waitFor(window, `!window.__debugSteering.followsFocus()`, 'The controllers were still handed to the project window once the 3D view closed.');
            } else {
                assert.match(await evaluate(window, `document.querySelector('.tourFloating .tourStatus').textContent`), /not installed|installed/);
            }
            await press('.tourFloating .tourPrimary');
            await waitForStep('dig', 20000);
            // The Bucket tip's plot, open while the run goes, draws the run so far and keeps up with it (a live run's window holds only its
            // latest sample, so the plot keeps its own).
            await evaluate(window, `[...document.querySelectorAll('.node-label-container')].find((label) => label.textContent.includes('Bucket tip')).click()`);
            await waitFor(window, `Boolean(document.querySelector('[data-editor-tab="results"]')) && !document.querySelector('#nodeEditor').classList.contains('hidden')`, 'The Bucket tip\'s editor did not open.');
            await evaluate(window, `document.querySelector('[data-editor-tab="results"]').click()`);
            await waitFor(window, `(document.querySelector('#nodeResultPlot').data?.[0]?.x.length ?? 0) >= 3`, 'The Bucket tip\'s plot did not draw the run so far.');
            const plotted = await evaluate(window, `document.querySelector('#nodeResultPlot').data[0].x.at(-1)`);
            await waitFor(window, `document.querySelector('#nodeResultPlot').data[0].x.at(-1) > ${plotted} + 0.5`, 'The Bucket tip\'s plot did not keep up with the run.');
            // Dig with the right joystick: forward lowers the boom until the tip touches the ground, back raises it with the bucket curled.
            await axis(right, 1, -1);
            await waitFor(window, `(() => { const project = window.__debugProject.serialize(); const tip = project.nodes.find((node) => node.name === 'Bucket tip'); const id = tip.states.find((state) => state.symbol === 'height').id; return (window.__debugSteering.result()?.samples.at(-1)?.states.find((entry) => entry.stateId === id)?.value ?? 1) <= 0; })()`, 'The tip did not reach the ground.', 20000);
            await axis(right, 1, 1);
            await axis(right, 0, -1);
            await waitForStep('record', 30000);
            await axis(right, 1, 0);
            await axis(right, 0, 0);
            assert.ok(await tipHeight() >= 2.5, 'The tip was lifted.');
            const record = await evaluate(window, `window.__debugSteering.result().interventions.filter((change) => change.kind !== 'restart').length`);
            assert.ok(record > 0, 'The joysticks\' movements were recorded.');
            assert.equal(await evaluate(window, `document.querySelector('#controlHistoryPanel').hidden`), false, 'The record is shown as the run is driven.');
            await press('.tourFloating .tourPrimary');
            await waitForStep('finish');
            await press('.tourFloating .tourPrimary');
            await waitFor(window, `!window.__debugTour.active()`, 'Finishing did not end the tutorial.');
        } finally {
            // The real-time run is stopped rather than left to play out its minute, for the scenarios after.
            await evaluate(window, `document.querySelector('#simulationStop')?.click()`);
            await waitFor(window, `!window.__debugTour.blockers().simulationRunning`, 'The run did not stop.', 15000).catch(() => {});
            await evaluate(window, `(() => { const devices = window.__debugSteering.devices; devices.disconnectGamepad(${JSON.stringify(left)}); devices.disconnectGamepad(${JSON.stringify(right)}); devices.poll(); window.__debugSteering.setConnectedControllers(undefined); return window.__debugSteering.steering.save({ bindings: [] }); })()`);
        }
    }, { skip: !driver.capabilities.multiWindow && 'the joystick tutorial is for the desktop app' });

    await run('every tutorial can be skipped step by step to its end, each skip doing the step so the next one works', async () => {
        const { press, clean } = tutorialHelpers();
        // KONJUGATE_INTERACTION_TUTORIALS=refitTwin,liveTwin skips through only those, to check one tutorial without the rest.
        const onlyTutorials = process.env.KONJUGATE_INTERACTION_TUTORIALS?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? null;
        for (const id of ['firstModel', 'buildFromComponents', 'organiseModel', 'equationsThatDoMore', ...(driver.capabilities.multiWindow ? ['programRelationship'] : []), ...(driver.capabilities.aiAssistant ? ['askAssistant'] : []), 'parametersAndRuns', 'layoutModel', 'fixInstability', 'calibrateTank', 'optimiseObjective', 'tuneController', ...(driver.capabilities.multiWindow ? ['steerByHand', 'driveWithJoysticks'] : []), ...(driver.capabilities.forks ? ['scheduleChanges'] : []), ...(driver.capabilities.forks ? ['whatIfBranches'] : []), 'discoverEquations', 'replayLog', ...(driver.capabilities.multiWindow ? ['keepAndShare', 'exportModel', 'extendKonjugate', 'liveTwin', 'matchSignals', 'refitTwin'] : [])].filter((entry) => !onlyTutorials || onlyTutorials.includes(entry))) {
            await clean();
            // The assistant's model is the person's to set up; here, the fake Ollama's, in use (as an earlier test may have left it).
            if (id === 'askAssistant') {
                fakeOllama.models.add('qwen3.5:4b');
                await evaluate(window, `(async () => {
                    const { configurations } = await window.aiProviders.listConfigurations();
                    const kept = configurations.find((configuration) => configuration.model === 'qwen3.5:4b' && configuration.endpoint === ${JSON.stringify(fakeOllama.endpoint)})
                        ?? await window.aiProviders.saveConfiguration({ name: 'Qwen3.5 4B', provider: 'ollama', endpoint: ${JSON.stringify(fakeOllama.endpoint)}, model: 'qwen3.5:4b', timeoutSeconds: 120, think: false });
                    await window.aiProviders.setActiveConfiguration(kept.uuid);
                })()`);
            }
            assert.equal(await evaluate(window, `window.__debugTour.startTutorial(${JSON.stringify(id)})`), true);
            await waitFor(window, `window.__debugTour.step() === 'welcome'`, `${id} did not start.`);
            await press('.tourFloating .tourPrimary');
            for (let guard = 0; guard < 20; guard += 1) {
                const step = await evaluate(window, `window.__debugTour.step()`);
                if (step === 'finish') break;
                // A step with nothing to do (something to read) waits for Next.
                if (!await evaluate(window, `document.querySelector('.tourFloating .tourPrimary').hidden`)) {
                    await press('.tourFloating .tourPrimary');
                    await waitFor(window, `window.__debugTour.step() !== ${JSON.stringify(step)}`, `${id}: Next on ${step} did not move on.`);
                    continue;
                }
                // The card can move on while the skip before is still at work (a run's step is done once the run starts, and its skip
                // waits for the run to end, up to three minutes), with this step's buttons off until it has finished.
                await waitFor(window, `!document.querySelector('.tourFloating .tourSkipStep').hidden && !document.querySelector('.tourFloating .tourSkipStep').disabled`, `${id}/${step} offered no Skip this step.`, 180000);
                // Exporting and saving ask where, through the system's save dialog: answered with a file of the test's own.
                const savesAFile = { keepAndShare: { export: 'results.csv', save: 'Thermal management.kjt' }, exportModel: { program: 'springMassDamper.py', fmu: 'springMassDamper.fmu' } }[id]?.[step];
                if (savesAFile) await driver.captureExport(() => press('.tourFloating .tourSkipStep'), { fileName: savesAFile, maxAttempts: 1200 });
                else await press('.tourFloating .tourSkipStep');
                // Skipping a restart loads the window again, and the tutorial carries on a moment after: until then there is no step, which
                // is not the next one.
                await waitFor(window, `Boolean(window.__debugTour?.active()) && ![null, ${JSON.stringify(step)}].includes(window.__debugTour.step())`, `${id}: skipping ${step} did not move on.`, 300000);
                assert.equal(await evaluate(window, `document.querySelector('.tourFloating .tourNotice').hidden`), true, `${id}: after skipping ${step}, a step was reported undone: ${await evaluate(window, `document.querySelector('.tourFloating .tourNotice').textContent`)}`);
            }
            assert.equal(await evaluate(window, `window.__debugTour.step()`), 'finish', `${id} did not reach its end.`);
            // Each skip did its step: the model is what the tutorial builds, whatever the person skipped.
            const saved = await savedProject();
            if (id === 'firstModel') {
                assert.deepEqual(saved.nodes.map((node) => node.name), ['Heater', 'Block']);
                assert.equal(saved.edges.length, 1);
            } else if (id === 'calibrateTank') {
                const loss = saved.edges.find((edge) => edge.name === 'Ambient heat loss').parameters.find((parameter) => parameter.symbol === 'heatLossCoefficient').value;
                assert.ok(Math.abs(loss / 20 - 1) < 0.05, `The skipped fit found the heat loss: ${loss}.`);
            } else if (id === 'buildFromComponents') {
                assert.deepEqual(saved.nodes.map((node) => node.name).sort(), ['Motor', 'Torque load', 'Voltage source']);
                assert.deepEqual(saved.edges.map((edge) => edge.name).sort(), ['Armature dynamics', 'Shaft dynamics']);
            } else if (id === 'organiseModel') {
                assert.equal(saved.edgeGroups.length, 1);
                assert.equal(saved.nodes.filter((node) => node.subsystemId === saved.subsystems[0]?.id).length, 3);
            } else if (id === 'equationsThatDoMore') {
                const hotBody = saved.nodes.find((node) => node.name === 'Hot body');
                assert.ok(hotBody.states.some((state) => state.symbol === 'temperatureCelsius'));
                assert.equal(hotBody.states.find((state) => state.symbol === 'temperatureCelsius').kind, 'update', 'The Celsius state is an update.');
            } else if (id === 'programRelationship') {
                assert.equal(saved.edges.find((edge) => edge.name === 'Conduction').implementation.kind, 'python');
            } else if (id === 'askAssistant') {
                assert.equal(await evaluate(window, `document.querySelector('#applyAssistantProposal').disabled`), true, 'The proposal was applied.');
                await evaluate(window, `document.querySelector('#closeAssistantPanel')?.click()`);
            } else if (id === 'parametersAndRuns') {
                const mass = saved.sharedParameters.find((shared) => shared.symbol === 'mass');
                assert.equal(mass?.value, 2);
                assert.ok(saved.edges.every((edge) => edge.parameters.filter((parameter) => parameter.symbol === 'mass').every((parameter) => parameter.sharedParameterId === mass.id)), 'Both masses read the shared one.');
            } else if (id === 'layoutModel') {
                assert.equal(saved.nodes.find((node) => node.name === 'Water tank').scale[1], 1.5);
                // Put the view back for the tests after.
                await evaluate(window, `(() => { if (document.querySelector('#lock2DButton').getAttribute('aria-pressed') === 'true') document.querySelector('#lock2DButton').click(); })()`);
            } else if (id === 'fixInstability') {
                assert.equal(saved.nodes.find((node) => node.name === 'Suspended mass').numerics.substepsPerGlobalStep, 11);
                assert.equal(await evaluate(window, `document.querySelector('#validationIssues').textContent.includes('unstable')`), false, 'The warning is gone.');
            } else if (id === 'optimiseObjective') {
                assert.equal(await evaluate(window, `document.querySelector('#parameterTuningComparisonStatus').textContent.includes('All limits hold')`), true, 'The skipped search held to its limit.');
                await evaluate(window, `document.querySelector('#cancelParameterTuning').click()`);
            } else if (id === 'driveWithJoysticks') {
                assert.ok((await evaluate(window, `window.__debugSteering.result().interventions`)).some((change) => change.kind !== 'restart'), 'The skipped dig was recorded.');
                await evaluate(window, `window.__debugSteering.steering.save({ bindings: [] })`);
            } else if (id === 'steerByHand') {
                assert.ok((await evaluate(window, `window.__debugSteering.result().interventions`)).some((change) => change.parameterId === 21), 'The skipped steering was recorded.');
                await evaluate(window, `window.__debugSteering.steering.save({ bindings: [] })`);
            } else if (id === 'scheduleChanges') {
                assert.ok((await evaluate(window, `window.__debugSteering.result().interventions`)).some((change) => change.mode === 'waveform'), 'The repeat carried the wave.');
            } else if (id === 'keepAndShare') {
                assert.match(await evaluate(window, `document.querySelector('#statusText').textContent`), /saved with simulation results|Tutorial/);
            } else if (id === 'refitTwin') {
                assert.notEqual(saved.edges.flatMap((edge) => edge.parameters ?? []).find((parameter) => parameter.id === 10).value, 20, 'The refit was kept in the model.');
                assert.deepEqual(await evaluate(window, `window.__debugTwin.setup()?.live?.inputs?.heaterPower`),
                    { forecast: 'plan', plan: { repeat: 'daily', timeZone: 'UTC', points: [{ at: 32400, value: 1000 }, { at: 39600, value: 0 }, { at: 43200, value: 1000 }, { at: 50400, value: 0 }] } },
                    'The operator\'s plan for the heater was kept with the twin.');
            } else if (id === 'liveTwin' || id === 'matchSignals') {
                assert.ok(saved.nodes.some((node) => node.name === 'Water tank'), 'The skipped demonstration opened the rig\'s model.');
            } else if (id === 'replayLog') {
                const capacitance = saved.sharedParameters.find((parameter) => parameter.id === 43).value;
                assert.ok(Math.abs(capacitance / 501600 - 1) < 0.03, `The skipped calibration found the capacitance: ${capacitance}.`);
            } else if (id === 'discoverEquations') {
                assert.equal(saved.nodes.length, 3);
                assert.equal(saved.edges.length, 2);
            } else if (id === 'whatIfBranches') {
                assert.equal(await evaluate(window, `document.querySelector('#branchesButtonCount').textContent`), '2', 'The skipped fork made a second branch.');
            } else if (id === 'extendKonjugate') {
                assert.ok(await evaluate(window, `Boolean(document.querySelector('#addonRailButtons .addonTool[data-addon-id="konjugate.resultPlotViewer"]'))`));
            } else if (id === 'exportModel') {
                assert.match(await evaluate(window, `document.querySelector('#statusText').textContent`), /Exported|Tutorial/);
            } else if (id === 'tuneController') {
                assert.equal(saved.edges.find((edge) => edge.name === 'Position control').parameters.find((parameter) => parameter.symbol === 'gain').value, 10);
            }
            await press('.tourFloating .tourPrimary');
            await waitFor(window, `!window.__debugTour.active()`, `${id} did not finish.`);
            // A real-time run is stopped rather than left to play out, for the tutorials after.
            if (await evaluate(window, `window.__debugTour.blockers().simulationRunning`)) {
                await evaluate(window, `document.querySelector('#simulationStop')?.click()`);
                await waitFor(window, `!window.__debugTour.blockers().simulationRunning`, 'The run did not stop.', 15000).catch(() => {});
            }
            if (['liveTwin', 'matchSignals', 'refitTwin'].includes(id)) await closeTutorialTwin();
        }
    });

    await run('an example with a tutorial offers it at the top of its guide, and the guide starts it in its window', async () => {
        const { waitForStep, clean } = tutorialHelpers();
        await clean();
        const before = driver.allHandles();
        await evaluate(window, `document.querySelector('#exampleButton').click()`);
        await waitFor(window, `Boolean([...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.querySelector('b').textContent === 'Tank Calibration'))`, 'Examples explorer did not populate.');
        await evaluate(window, `[...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.querySelector('b').textContent === 'Tank Calibration').click()`);
        await waitFor(window, `document.querySelector('#examplesExplorerDetailTitle').textContent === 'Tank Calibration'`, 'The example was not selected.');
        await evaluate(window, `document.querySelector('#examplesExplorerLoad').click()`);
        const guideWindow = await driver.waitForNewHandle(before, { titleIncludes: 'Example Guide' });
        await waitFor(guideWindow, `Boolean(document.querySelector('[data-start-tutorial]'))`, 'The guide did not offer its tutorial.');
        assert.deepEqual(await evaluate(guideWindow, `[...document.querySelectorAll('.tourCard strong')].map((title) => title.textContent)`), ['Calibrate a model against measured data', 'Optimise towards a goal'], 'The guide offers every tutorial on its example.');
        // Pressed after the script has answered: the button closes the guide window, which would otherwise race the answer.
        await evaluate(guideWindow, `setTimeout(() => document.querySelector('[data-start-tutorial]').click(), 0)`);
        await waitFor(window, `window.__debugTour.tutorial() === 'calibrateTank'`, 'The guide did not start its tutorial.');
        await waitForStep('welcome');
        await evaluate(window, `window.__debugTour.stop()`);
    }, { skip: !driver.capabilities.renderedExampleGuide && 'the web edition opens an example\'s guide as its raw .md file, with no page to offer the tutorial in' });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (const asked of driver.takeNativeDialogs?.() ?? []) console.log(`  (after the last test, a native ${asked.kind} dialog, "${asked.title}", was answered as cancelled)`);
    await fakeOllama?.close();
    await driver.finish?.();
    const total = durations.reduce((sum, entry) => sum + entry.seconds, 0);
    if (durations.length > 1) {
        console.log(`\nThe slowest scenarios, of ${total.toFixed(0)} s in all:`);
        for (const { name, seconds } of [...durations].sort((a, b) => b.seconds - a.seconds).slice(0, 10)) console.log(`  ${seconds.toFixed(1).padStart(6)} s  ${name.slice(0, 110)}`);
    }
    console.log(`Interaction tests: ${passedCount} passed, ${failures.length} failed, ${skippedCount} skipped, ${passedCount + failures.length + skippedCount} total`);
    // A renamed scenario would quietly leave its group, and then be retried without what it needs: said instead.
    const missing = [...groupOf.keys()].filter((name) => !scenariosSeen.has(name));
    if (missing.length) throw new Error(`scenarioGroups names scenarios the runner does not have (renamed?): ${missing.join('; ')}`);
    if (process.env.KONJUGATE_INTERACTION_RESULTS) await writeFile(process.env.KONJUGATE_INTERACTION_RESULTS, `${JSON.stringify({ outcomes }, null, 2)}\n`);
    if (failures.length) {
        console.log(`\nFailed (${failures.length}):`);
        for (const { name, error } of failures) console.log(`  ✗ ${name}\n      ${String(error?.message ?? error).split('\n').slice(0, 3).join('\n      ')}`);
        throw new Error(`${failures.length} interaction test${failures.length === 1 ? '' : 's'} failed: ${failures.map((failure) => failure.name).join('; ')}`);
    }
}
