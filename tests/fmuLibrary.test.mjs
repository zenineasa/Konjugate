/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Settings › Providers › FMUs in your library (the single FMU workflow, stage 4): each FMU in the library, which open model uses it, and
// Remove for one no open model uses, with a confirmation that says what removing it means for projects that are not open.

import assert from 'node:assert/strict';
import test from 'node:test';
import { fmuLibraryRows, fmuRemovalQuestion } from '../src/fmuLibrary.mjs';

const installed = [
    { packageId: 'guid-b', version: '1.0.0', name: 'Boiler', manifest: { archiveBytes: 2 * 1024 * 1024, modelName: 'Boiler' } },
    { packageId: 'guid-a', version: '1.0.1', name: 'Pump', manifest: { archiveBytes: 512 * 1024 } },
    { packageId: 'guid-a', version: '1.0.0', name: 'Pump', manifest: {} }
];

test('each FMU is listed with which open models use it, and only one none uses can be removed', () => {
    const rows = fmuLibraryRows(installed, [
        { project: 'Room.kjt', fmus: [{ guid: 'guid-a', version: '1.0.1' }, { guid: 'guid-a', version: '1.0.1' }] },
        { project: 'Plant.kjt', fmus: [{ guid: 'guid-a', version: '1.0.1' }] },
        { project: 'Untitled', fmus: [] }
    ]);
    assert.deepEqual(rows.map(({ guid, version, name, usedBy, removable }) => ({ guid, version, name, usedBy, removable })), [
        { guid: 'guid-b', version: '1.0.0', name: 'Boiler', usedBy: [], removable: true },
        { guid: 'guid-a', version: '1.0.0', name: 'Pump', usedBy: [], removable: true },
        { guid: 'guid-a', version: '1.0.1', name: 'Pump', usedBy: ['Plant.kjt', 'Room.kjt'], removable: false }
    ], 'By name, then version; each model said once; a version in use is not removable, another version of it is.');
    assert.equal(rows[0].size, '2.0 MB');
    assert.equal(rows[2].size, '512 KB');
    assert.equal(rows[1].size, null, 'An FMU installed before sizes were kept says none.');
});

test('a window that did not answer makes nothing removable, since its model may use any of them', () => {
    const rows = fmuLibraryRows(installed, [{ project: 'Room.kjt', fmus: [] }, null]);
    assert.equal(rows.every((row) => !row.removable), true);
    assert.equal(rows.every((row) => row.unanswered === 1), true, 'Each row says how many windows did not answer.');
});

test('the confirmation says what a project that is not open loses: one that keeps the FMU gets it back, one that links it does not', () => {
    const question = fmuRemovalQuestion({ name: 'Pump', version: '1.0.0' });
    assert.match(question, /^Remove Pump \(version 1\.0\.0\) from your library\?/);
    assert.match(question, /No model open now uses it\./);
    assert.match(question, /A project that keeps this FMU in its file installs it again when it is opened\./);
    assert.match(question, /A project not open now that links this FMU, rather than keeping it in its file, will need it added again with Add › FMU…\./);
});

// The wiring, read from the sources (the main process and the windows cannot be started by a unit test).
import { readFile } from 'node:fs/promises';
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Settings › Providers lists the library from every open window\'s answer, and Remove is checked again in the main process', async () => {
    const [main, preload, renderer, html, web] = await Promise.all(['src/main.mjs', 'src/preload.mjs', 'src/renderer/renderer.mjs', 'src/renderer/index.html', 'src/renderer/webShims/packages.mjs'].map(read));
    assert.match(main, /ipcMain\.handle\('packageFmuLibrary'/);
    assert.match(main, /ipcMain\.handle\('packageRemoveFmu'/);
    assert.match(main, /\[\.\.\.projectWindows\]/, 'Every project window is asked, and only project windows.');
    const remove = main.slice(main.indexOf("ipcMain.handle('packageRemoveFmu'"), main.indexOf("ipcMain.handle('packageRemoveFmu'") + 900);
    assert.match(remove, /removable/, 'Removing asks the windows again and refuses an FMU in use.');
    assert.match(preload, /fmuLibrary: \(\) => ipcRenderer\.invoke\('packageFmuLibrary'\)/);
    assert.match(preload, /removeFmu: \(guid, version\) => ipcRenderer\.invoke\('packageRemoveFmu'/);
    assert.match(preload, /ipcRenderer\.on\('fmuUsageRequest'/);
    assert.match(renderer, /onFmuUsageRequest\?\.\(/, 'Each window answers with its model\'s FMUs.');
    assert.match(renderer, /fmuRemovalQuestion\(row\)/, 'Remove asks first, in the shared words.');
    assert.match(html, /id="fmuLibrarySection"/);
    assert.match(renderer, /\$\('#fmuLibrarySection'\)\.hidden = document\.documentElement\.hasAttribute\('data-web-edition'\)/, 'Hidden in the web edition, which has no FMUs.');
    assert.match(web, /fmuLibrary: async \(\) => \[\]/);
});

test('an FMU node\'s card says which version of the library it uses', async () => {
    const renderer = await read('src/renderer/renderer.mjs');
    assert.match(renderer, /In your library as version \$\{implementation\.fmuVersion\}/);
});
