/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The update experience is spread over the Electron main process, two preload scripts and two pages,
// none of which a unit test can start. These tests read the sources and check that the pieces agree
// with each other, which is where this kind of feature quietly breaks (a renamed channel, a method
// exposed in one window and not the other, a browser page importing a Node module).
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const channelsIn = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1]).sort();

test('every update channel a preload calls is handled by the main process, and nothing extra is handled', async () => {
    const [main, projectPreload, guidePreload] = await Promise.all([read('src/main.mjs'), read('src/preload.mjs'), read('src/exampleGuide/preload.cjs')]);
    const handled = channelsIn(main, /ipcMain\.handle\('(appUpdate[A-Za-z]*)'/g);
    assert.deepEqual(handled, ['appUpdateCheckNow', 'appUpdateCopyCommand', 'appUpdateSkip', 'appUpdateStatus']);
    for (const [name, preload] of [['src/preload.mjs', projectPreload], ['src/exampleGuide/preload.cjs', guidePreload]]) {
        const invoked = [...new Set(channelsIn(preload, /ipcRenderer\.invoke\('(appUpdate[A-Za-z]*)'/g))];
        assert.deepEqual(invoked, handled, `${name} must call exactly the channels the main process handles`);
        assert.match(preload, /ipcRenderer\.on\('appUpdateStatus'/, `${name} must listen for pushed status`);
    }
    assert.match(main, /webContents\.send\('appUpdateStatus'/, 'the main process must push status to the windows');
});

test('both windows expose the same appUpdate methods', async () => {
    const [projectPreload, guidePreload] = await Promise.all([read('src/preload.mjs'), read('src/exampleGuide/preload.cjs')]);
    // The methods inside the appUpdate block only: from its opening up to the next exposeInMainWorld.
    const methods = (source) => {
        const start = source.indexOf("exposeInMainWorld('appUpdate'");
        const next = source.indexOf('exposeInMainWorld(', start + 1);
        return [...source.slice(start, next === -1 ? undefined : next).matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((match) => match[1]);
    };
    assert.deepEqual(methods(projectPreload), ['status', 'checkNow', 'skip', 'copyCommand', 'onChange']);
    assert.deepEqual(methods(guidePreload), ['status', 'checkNow', 'skip', 'copyCommand', 'onChange']);
});

test('there is no update dialog any more: the launch check starts the coordinator and focus asks it again', async () => {
    const main = await read('src/main.mjs');
    assert.doesNotMatch(main, /Update available/, 'the old modal must be gone');
    assert.doesNotMatch(main, /checkForUpdates/);
    assert.match(main, /startUpdateChecks\(\)\.catch\(/, 'the launch must start the checks, and a failure to start must not be an unhandled rejection');
    assert.match(main, /app\.on\('browser-window-focus', \(\) => \{ updateCoordinator\?\.maybeCheck\(\); \}\)/);
    assert.match(main, /updateCoordinator\.maybeCheck\(\);\s*\n\}/, 'the launch check itself');
});

test('the copy handler takes no text from the window, so a page cannot use it to fill the clipboard', async () => {
    const main = await read('src/main.mjs');
    const handler = main.slice(main.indexOf("ipcMain.handle('appUpdateCopyCommand'"), main.indexOf("app.on('browser-window-focus'"));
    assert.match(handler, /ipcMain\.handle\('appUpdateCopyCommand', \(\) =>/, 'the handler must declare no arguments');
    assert.match(handler, /updateCoordinator\?\.status\(\)\.command/);
    assert.match(handler, /clipboard\.writeText\(command\)/);
});

test('the skip handler ignores anything that is not a version string', async () => {
    const main = await read('src/main.mjs');
    const handler = main.slice(main.indexOf("ipcMain.handle('appUpdateSkip'"), main.indexOf("ipcMain.handle('appUpdateCopyCommand'"));
    assert.match(handler, /typeof version !== 'string' \|\| version === ''/);
});

test('browser pages import only the Node-free display model, never the modules that need Node', async () => {
    const [guideRenderer, projectRenderer, panel] = await Promise.all([read('src/exampleGuide/renderer.mjs'), read('src/renderer/renderer.mjs'), read('src/updatePanel.mjs')]);
    assert.ok(/from '\.\.\/updatePanel\.mjs'/.test(guideRenderer), 'the Welcome page must import the display model');
    // Real import statements only: a comment may name these modules. (Assertions here are written so a
    // failure prints the file name, not the file: these sources are large.)
    const nodeModuleImport = /^\s*(?:import\b[^;]*?from|export\b[^;]*?from)\s+'[^']*(?:updateCheck|updateCoordinator|updateSkipStore)\.mjs'/m;
    for (const [name, source] of [['exampleGuide/renderer.mjs', guideRenderer], ['renderer/renderer.mjs', projectRenderer]]) {
        assert.ok(!nodeModuleImport.test(source), `${name} is a web page and cannot load Node modules`);
    }
    assert.ok(!/^\s*import\s/m.test(panel), 'updatePanel.mjs must import nothing');
});

test('the title bar has the badge inside the Konjugate button, and the Welcome page has its section', async () => {
    const [html, guideRenderer] = await Promise.all([read('src/renderer/index.html'), read('src/exampleGuide/renderer.mjs')]);
    assert.match(html, /<button id="welcomeButton"[^>]*>Konjugate<span id="appUpdateBadge"[^>]*hidden><\/span><\/button>/);
    assert.match(guideRenderer, /kind === 'welcome' \? '<section id="updatesSection"/, 'only the Welcome window carries the section');
});

test('the web edition, which has no app to update, tolerates the missing update API', async () => {
    const renderer = await read('src/renderer/renderer.mjs');
    assert.match(renderer, /window\.appUpdate\?\.status\(\)/);
    assert.match(renderer, /window\.appUpdate\?\.onChange\(/);
});
