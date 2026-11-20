/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The preload interface check (scripts/checkPreloadApis.mjs), on small source folders written for each case, and on the app's own
// src/ for how it reads the real windows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { preloadApiFindings } from '../scripts/checkPreloadApis.mjs';

async function findingsFor(t, files) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugatePreload-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = join(directory, 'src');
    for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(source, path)), { recursive: true });
        await writeFile(join(source, path), text);
    }
    const result = await preloadApiFindings(source);
    return { ...result, unused: result.findings.flatMap((finding) => finding.entries).map((entry) => entry.split(' ')[0]) };
}

const projectWindow = {
    'preload.mjs': [
        "contextBridge.exposeInMainWorld('engine', {",
        "    start: (content) => ipcRenderer.invoke('engineStart', content),",
        '    // Asked for by nothing any more.',
        "    cancel: (jobId) => ipcRenderer.invoke('engineCancel', jobId),",
        "    onUpdate(callback) { ipcRenderer.on('engineRunUpdate', (_event, value) => callback(value)); },",
        "    limits: { steps: 10, seconds: 60 },",
        "    readSeries: async (jobId) => ipcRenderer.invoke('engineReadSeries', jobId)",
        '});',
        "contextBridge.exposeInMainWorld('windowControls', Object.freeze({",
        "    minimize: () => ipcRenderer.send('windowMinimize'),",
        "    onMaximizedChange: (callback) => ipcRenderer.on('windowMaximizedChange', callback)",
        '}));'
    ].join('\n'),
    'renderer/index.html': '<script type="module" src="renderer.mjs"></script><script src="../../node_modules/plotly.js-dist-min/plotly.min.js"></script>',
    'renderer/renderer.mjs': [
        "import { plotSeries } from './plots.mjs';",
        "const { start } = window.engine;",
        'window.engine.onUpdate(() => {});',
        "plotSeries({ api: window.engine });",
        "const panel = await import('./panel.mjs');",
        'window.windowControls.minimize();'
    ].join('\n'),
    'renderer/plots.mjs': "export const plotSeries = ({ api }) => api.readSeries('job');",
    'renderer/panel.mjs': "export const steps = window.engine.limits.steps;"
};

test('a member the window reads, under any name, in any module it loads, is used; one it never reads is reported', async (t) => {
    const { unused, checked } = await findingsFor(t, projectWindow);
    assert.deepEqual(unused, ['engine.cancel', 'windowControls.onMaximizedChange']);
    assert.deepEqual(checked, [{ file: 'src/preload.mjs', members: 7, modules: 3 }], 'Its page and the modules it imports, statically or not; not a script from node_modules.');
});

test('an interface several windows expose the same way is used by any of them; one exposed differently is checked in each', async (t) => {
    const { unused } = await findingsFor(t, {
        ...projectWindow,
        'guide/preload.cjs': [
            "contextBridge.exposeInMainWorld('engine', Object.freeze({ start: () => {}, cancel: () => {}, onUpdate: () => {}, limits: {}, readSeries: () => {} }));",
            "contextBridge.exposeInMainWorld('windowControls', Object.freeze({ minimize: () => {}, onMaximizedChange: () => {}, close: () => {} }));"
        ].join('\n'),
        'guide/index.html': '<script type="module" src="guide.mjs"></script>',
        'guide/guide.mjs': 'window.engine.cancel(); window.windowControls.onMaximizedChange(() => {}); window.windowControls.close();'
    });
    assert.deepEqual(unused.sort(), ['windowControls.minimize', 'windowControls.onMaximizedChange'],
        'The same engine in both: the guide\'s cancel counts for the project window. Window controls that differ are each the window\'s own.');
});

test('the preloads of add-ons\' pages are interfaces for code elsewhere, and are not checked', async (t) => {
    const { unused, skipped } = await findingsFor(t, {
        ...projectWindow,
        'addonPreload.cjs': "contextBridge.exposeInMainWorld('konjugateVisualizer', Object.freeze({ readSeries: () => {}, seek: () => {} }));",
        'launcherPreload.cjs': "contextBridge.exposeInMainWorld('konjugateLauncher', Object.freeze({ runImport: () => {} }));"
    });
    assert.deepEqual(skipped.sort(), ['src/addonPreload.cjs', 'src/launcherPreload.cjs']);
    assert.ok(!unused.some((entry) => entry.startsWith('konjugate')));
});

test('the app\'s own windows are all read, through their pages\' modules', async () => {
    const { checked, skipped } = await preloadApiFindings(join(import.meta.dirname, '..', 'src'));
    assert.deepEqual(checked.map((window) => window.file).sort(), ['src/exampleGuide/preload.cjs', 'src/preload.mjs', 'src/providerEditor/preload.cjs', 'src/twinWindow/preload.cjs']);
    assert.deepEqual(skipped.sort(), ['src/addonPreload.cjs', 'src/launcherPreload.cjs']);
    const project = checked.find((window) => window.file === 'src/preload.mjs');
    assert.ok(project.members > 100 && project.modules > 50, 'The project window\'s whole interface, and the modules its page loads.');
});
