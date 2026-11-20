/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The launcher's IPC handlers (registerLauncherHandlers in src/launcherHost.mjs), driven as a launcher window drives them: a
// window is opened for an add-on with openLauncher, and each request comes from that window's webContents. Electron's parts
// (ipcMain, BrowserWindow, dialog, shell, app) are small fakes that record what was asked of them; the add-on is a real package in
// a temporary folder, its importer tests/fixtures/launcher/echoImporter.mjs, and files, the fetch cache and stored files are real.
// The handlers that run the engine (baseline, scenario, export of a run) are covered by tests/launcherHost.test.mjs's engine test
// and the interaction suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAddonManifest } from '../src/addonHost.mjs';
import { registerLauncherHandlers } from '../src/launcherHost.mjs';

const fixtureDirectory = join(import.meta.dirname, 'fixtures', 'launcher');
const addonId = 'example.dataStart';

function manifest(change = (value) => value) {
    return validateAddonManifest(change({
        addonId, name: 'Data Start', version: '0.2.0', apiVersion: 1, kind: 'launcher', entry: 'index.html',
        permissions: ['data.import', 'scenario.run', 'model.open', 'results.export', 'pages.open', 'analysis.infer', 'network.fetch', 'project.data', 'links.open', 'files.store'],
        requires: ['fetchCache', 'keepSession', 'projectSession', 'storedFiles', 'openLink', 'binaryInputs', 'multipleBinaryInputs', 'pythonCheck'],
        network: { hosts: ['data.example.com'] },
        links: { hosts: ['maps.example.com'] },
        contributes: {
            toolstrip: [{ commandId: 'open', label: 'Data', tooltip: 'Open Data Start', symbol: 'D', when: 'always', contexts: [] }],
            importers: [{
                importerId: 'series', name: 'Series', entry: 'echoImporter.mjs', files: [
                    { role: 'data', label: 'Data', required: true, sample: 'samples/data.csv' },
                    { role: 'notes', label: 'Notes', multiple: true, accept: ['txt'] },
                    { role: 'extract', label: 'Extract', binary: true, multiple: true, accept: ['pbf'] }
                ]
            }],
            scenarios: [{ scenarioId: 'hot', name: 'Hot day', description: 'Warmer.', forkAt: 5, runTime: 20, interventions: [{ parameter: 'outside', target: 'global', value: 310 }] }],
            pages: [{ pageId: 'help', label: 'Help', entry: 'help/index.html' }]
        }
    }));
}

class FakeWebContents {
    static nextId = 1;
    constructor() { this.id = FakeWebContents.nextId++; this.sent = []; this.listeners = {}; }
    send(channel, payload) { this.sent.push([channel, payload]); }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    on(name, listener) { this.listeners[name] = listener; }
    channels() { return this.sent.map(([channel]) => channel); }
}

class FakeWindow {
    static created = [];
    constructor(options = {}) {
        this.options = options;
        this.webContents = new FakeWebContents();
        this.destroyed = false;
        this.listeners = {};
        this.shown = 0;
        this.focused = 0;
        FakeWindow.created.push(this);
    }
    on(name, listener) { (this.listeners[name] ??= []).push(listener); }
    once(name, listener) { this.on(name, listener); }
    emit(name, ...args) { for (const listener of this.listeners[name] ?? []) listener(...args); }
    isDestroyed() { return this.destroyed; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
    show() { this.shown += 1; }
    focus() { this.focused += 1; }
    setMenu() {}
    async loadFile(path) { this.loaded = path; }
}

// A launcher window open for the add-on, and a function that sends it a request as that window: answers { ok, ... }.
async function openedLauncher(t, { change, deps = {} } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateLauncherHandlers-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const addonDirectory = join(directory, 'addon');
    await cp(fixtureDirectory, addonDirectory, { recursive: true });
    await mkdir(join(addonDirectory, 'samples'));
    await mkdir(join(addonDirectory, 'help'));
    await writeFile(join(addonDirectory, 'samples', 'data.csv'), 'from the sample\n');
    await writeFile(join(addonDirectory, 'index.html'), '<!doctype html>');
    await writeFile(join(addonDirectory, 'help', 'index.html'), '<!doctype html>');
    const userData = join(directory, 'userData');
    const addon = { manifest: manifest(change), addonDirectory };
    const handlers = {};
    const dialogAnswers = [];
    const projectWindow = new FakeWindow();
    const state = {};
    const fake = {
        ipcMain: { handle: (channel, handler) => { handlers[channel] = handler; }, on() {}, removeListener() {} },
        dialog: { showOpenDialog: async (window, options) => { fake.dialogOptions = options; return dialogAnswers.shift() ?? { canceled: true, filePaths: [] }; } },
        BrowserWindow: FakeWindow,
        app: { getPath: () => userData, getVersion: () => '9.9.9' },
        screen: {}, currentDir: '/app/src', iconPath: null,
        projectWindows: [projectWindow], projectWindowState: new Map([[projectWindow, state]]),
        installCustomWindowState: () => {}, auxiliaryWindowBounds: () => ({ width: 1180, height: 800 }), auxiliaryWindowPresentation: () => ({}),
        engineOptions: async () => ({ providerToolchains: { python: { interpreterPath: '/usr/bin/python3', chosen: true } } }),
        decodeProjectForRenderer: async (buffer) => ({ projectBytes: buffer.length }),
        addonRegistry: new Map([[addonId, addon]]),
        inferWithEngine: async () => ({ available: false }),
        fetchImpl: async () => new Response('fetched'),
        ...deps
    };
    const { openLauncher } = registerLauncherHandlers(fake);
    await openLauncher(projectWindow, addon);
    const launcherWindow = state.launcherWindow;
    const ask = (channel, request, sender = launcherWindow.webContents) => handlers[channel]({ sender }, request);
    return { ask, handlers, addon, addonDirectory, directory, projectWindow, launcherWindow, state, dialogAnswers, fake, openLauncher };
}

test('a launcher opens in a sandboxed window of its own, once, and only that window may ask', async (t) => {
    const { ask, handlers, launcherWindow, addonDirectory, projectWindow, addon, openLauncher } = await openedLauncher(t);
    assert.equal(launcherWindow.options.webPreferences.preload, join('/app/src', 'launcherPreload.cjs'));
    assert.deepEqual([launcherWindow.options.webPreferences.contextIsolation, launcherWindow.options.webPreferences.nodeIntegration, launcherWindow.options.webPreferences.sandbox], [true, false, true]);
    assert.equal(launcherWindow.loaded, join(addonDirectory, 'index.html'));
    const created = FakeWindow.created.length;
    await openLauncher(projectWindow, addon);
    assert.equal(FakeWindow.created.length, created, 'Opening it again brings the open window forward.');
    assert.equal(launcherWindow.focused, 1);

    const stranger = new FakeWebContents();
    assert.deepEqual(await ask('launcherGetManifest', {}, stranger), { ok: false, message: 'This request did not come from an open launcher window.' });
    assert.match(await handlers.launcherTitlebarStylesheet({ sender: launcherWindow.webContents }), /^file:.*addonTitlebar\.css$/);
    assert.throws(() => handlers.launcherTitlebarStylesheet({ sender: stranger }), /only to a launcher window/);

    launcherWindow.destroy();
    assert.equal((await ask('launcherGetManifest', {})).ok, false, 'A closed window asks nothing more.');
});

test('the manifest the window sees lists what it declared and nothing of the package\'s paths', async (t) => {
    const { ask } = await openedLauncher(t);
    const answer = await ask('launcherGetManifest', {});
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.network, { hosts: ['data.example.com'] });
    assert.deepEqual(answer.importers[0].files.map((file) => [file.role, file.hasSample, file.multiple, file.binary]), [['data', true, false, false], ['notes', false, true, false], ['extract', false, true, true]]);
    assert.ok(!JSON.stringify(answer).includes('samples/data.csv'), 'A sample is said to exist, not where it is.');
    assert.deepEqual(answer.scenarios[0].interventions, [{ parameter: 'outside', target: 'global', value: 310, fractionOfMaximum: null, at: 0, duration: 0 }]);
    assert.deepEqual(answer.pages, [{ pageId: 'help', label: 'Help' }]);
    assert.deepEqual(answer.files, {});
    assert.equal(answer.imported, null);
});

test('a request beyond the launcher\'s permissions or its declarations is refused with the reason', async (t) => {
    const { ask } = await openedLauncher(t, { change: (value) => ({ ...value, permissions: ['data.import'], requires: [], network: undefined, links: undefined }) });
    assert.deepEqual(await ask('launcherFetchText', { url: 'https://data.example.com/x' }), { ok: false, message: 'This launcher was not granted network.fetch.' });
    assert.deepEqual(await ask('launcherOpenInCanvas', {}), { ok: false, message: 'This launcher was not granted model.open.' });
    assert.deepEqual(await ask('launcherUseSample', { importerId: 'nope' }), { ok: false, message: 'The launcher named an undeclared importer.' });
    assert.deepEqual(await ask('launcherClearFile', { importerId: 'series', role: 'nope' }), { ok: false, message: 'The launcher named an undeclared file role.' });
});

test('the sample is imported through the add-on\'s own importer, and the model it builds can be opened in the canvas', async (t) => {
    const { ask, projectWindow } = await openedLauncher(t);
    assert.deepEqual(await ask('launcherRunImport', { importerId: 'series' }), { ok: false, message: 'Choose Data first.' });
    assert.deepEqual(await ask('launcherOpenInCanvas', {}), { ok: false, message: 'Import your data first.' });
    assert.deepEqual(await ask('launcherRunScenario', { scenarioId: 'hot' }), { ok: false, message: 'Import your data first.' });
    assert.deepEqual(await ask('launcherRunBaseline', {}), { ok: false, message: 'Import your data first.' });

    assert.equal((await ask('launcherUseSample', { importerId: 'series' })).ok, true);
    assert.deepEqual((await ask('launcherGetManifest', {})).files.data, { name: 'data.csv', bytes: 16, sample: true, fetched: false });
    const imported = await ask('launcherRunImport', { importerId: 'series' });
    assert.equal(imported.ok, true);
    assert.equal(imported.imported, true);
    assert.deepEqual(imported.report.summary, { text: 'from the sample', extra: 7 });
    assert.equal((await ask('launcherGetManifest', {})).imported.importerId, 'series');

    assert.deepEqual(await ask('launcherOpenInCanvas', { focus: true }), { ok: true });
    assert.deepEqual(projectWindow.webContents.channels(), ['launcherOpenProjectPending', 'launcherOpenProject']);
    const [, opened] = projectWindow.webContents.sent[1];
    assert.equal(opened.addonName, 'Data Start');
    assert.equal(opened.suggestedFilename, 'DataStart.kjt');
    assert.ok(opened.projectBytes > 0);
    assert.equal(projectWindow.focused, 1);
});

test('a project that cannot be built for the canvas is abandoned, so the project window stops waiting for it', async (t) => {
    const { ask, projectWindow } = await openedLauncher(t, { deps: { decodeProjectForRenderer: async () => { throw new Error('too large to open'); } } });
    await ask('launcherUseSample', { importerId: 'series' });
    await ask('launcherRunImport', { importerId: 'series' });
    assert.deepEqual(await ask('launcherOpenInCanvas', {}), { ok: false, message: 'too large to open' });
    assert.deepEqual(projectWindow.webContents.channels(), ['launcherOpenProjectPending', 'launcherOpenProjectAbandoned']);
});

test('chosen files are read once chosen, listed by role, cleared one by one, and read again when they change on disk', async (t) => {
    const { ask, directory, dialogAnswers, fake } = await openedLauncher(t);
    const data = join(directory, 'mine.csv');
    const first = join(directory, 'first.txt');
    const second = join(directory, 'second.txt');
    await writeFile(data, 'version one\n');
    await writeFile(first, 'a');
    await writeFile(second, 'bb');

    assert.deepEqual(await ask('launcherChooseFile', { importerId: 'series', role: 'data' }), { ok: true, chosen: false }, 'Cancelled.');
    dialogAnswers.push({ canceled: false, filePaths: [data] });
    assert.deepEqual(await ask('launcherChooseFile', { importerId: 'series', role: 'data' }), { ok: true, chosen: true, name: 'mine.csv', names: ['mine.csv'], bytes: 12 });
    assert.deepEqual(fake.dialogOptions.filters, [{ name: 'CSV', extensions: ['csv'] }]);
    dialogAnswers.push({ canceled: false, filePaths: [first, second] });
    await ask('launcherChooseFile', { importerId: 'series', role: 'notes' });
    assert.deepEqual(fake.dialogOptions.properties, ['openFile', 'multiSelections']);
    let files = (await ask('launcherGetManifest', {})).files;
    assert.equal(files.data.name, 'mine.csv');
    assert.deepEqual(files.notes.map((file) => file.name), ['first.txt', 'second.txt'], 'A role that takes several lists them all.');

    await ask('launcherClearFile', { importerId: 'series', role: 'notes', name: 'first.txt' });
    files = (await ask('launcherGetManifest', {})).files;
    assert.deepEqual(files.notes.map((file) => file.name), ['second.txt']);

    assert.deepEqual(await ask('launcherReloadFiles', { importerId: 'series' }), { ok: true, changed: 0, missing: [] });
    await writeFile(data, 'version two, longer\n');
    assert.deepEqual(await ask('launcherReloadFiles', { importerId: 'series' }), { ok: true, changed: 1, missing: [] });
    assert.equal((await ask('launcherGetManifest', {})).files.data.bytes, 20);
    await rm(second);
    assert.deepEqual(await ask('launcherReloadFiles', { importerId: 'series' }), { ok: true, changed: 0, missing: ['second.txt'] });

    await ask('launcherClearFile', { importerId: 'series', role: 'data' });
    assert.equal((await ask('launcherGetManifest', {})).files.data, undefined);
});

test('a fetch reaches only the listed hosts, and a fetched file can be kept in the add-on\'s cache', async (t) => {
    let fetches = 0;
    const { ask } = await openedLauncher(t, { deps: { fetchImpl: async (url) => { fetches += 1; return new Response(`answer ${fetches} from ${new URL(url).pathname}`); } } });
    assert.deepEqual(await ask('launcherFetchText', { url: 'https://data.example.com/symbols' }), { ok: true, text: 'answer 1 from /symbols' });
    assert.match((await ask('launcherFetchText', { url: 'https://elsewhere.example.org/x' })).message, /may not connect to elsewhere\.example\.org/);
    assert.equal(fetches, 1, 'An unlisted host is never asked.');

    assert.deepEqual(await ask('launcherFetchFile', { importerId: 'series', role: 'data', url: 'https://data.example.com/a.csv', name: '' }), { ok: false, message: 'Give the series a name.' });
    assert.deepEqual(await ask('launcherFetchFile', { importerId: 'series', role: 'data', url: 'https://data.example.com/a.csv', name: 'a.csv', cache: 'always' }), { ok: false, message: 'A fetch is cached with use, refresh or off.' });
    const fetched = await ask('launcherFetchFile', { importerId: 'series', role: 'data', url: 'https://data.example.com/a.csv', name: 'a.csv', cache: 'use' });
    assert.equal(fetched.cached, false);
    const again = await ask('launcherFetchFile', { importerId: 'series', role: 'data', url: 'https://data.example.com/a.csv', name: 'a.csv', cache: 'use' });
    assert.equal(again.cached, true, 'The second is read from the cache.');
    assert.equal(again.retrievedAt, fetched.retrievedAt, 'Saying when it was really fetched.');
    assert.equal(fetches, 2);
    assert.equal((await ask('launcherGetManifest', {})).files.data.fetched, true);
    assert.equal((await ask('launcherCacheInfo', {})).entries, 1);
    assert.deepEqual(await ask('launcherClearCache', {}), { ok: true });
    assert.equal((await ask('launcherCacheInfo', {})).entries, 0);
    const refreshed = await ask('launcherFetchFile', { importerId: 'series', role: 'data', url: 'https://data.example.com/a.csv', name: 'a.csv', cache: 'refresh' });
    assert.equal(refreshed.cached, false);
    assert.equal(fetches, 3);
});

test('a link opens in the browser only on a listed host, and only where the host can open one', async (t) => {
    const opened = [];
    const { ask } = await openedLauncher(t, { deps: { shell: { openExternal: async (href) => { opened.push(href); } } } });
    assert.deepEqual(await ask('launcherOpenLink', { url: 'https://maps.example.com/dir/a/b' }), { ok: true });
    assert.deepEqual(opened, ['https://maps.example.com/dir/a/b']);
    assert.match((await ask('launcherOpenLink', { url: 'https://data.example.com/' })).message, /may not connect to data\.example\.com/, 'Fetch hosts are not link hosts.');

    const { ask: askWithoutShell } = await openedLauncher(t);
    assert.deepEqual(await askWithoutShell('launcherOpenLink', { url: 'https://maps.example.com/' }), { ok: false, message: 'This version of Konjugate cannot open pages in the browser.' });
});

test('the Python check is asked of the providers\' Python, saying whether it was chosen', async (t) => {
    const asked = [];
    const { ask } = await openedLauncher(t, { deps: { checkPython: async (request) => { asked.push(request); return { found: true, message: 'fine' }; } } });
    assert.deepEqual(await ask('launcherCheckPython', { modules: ['numpy'] }), { ok: true, found: true, message: 'fine' });
    assert.deepEqual(asked, [{ interpreter: '/usr/bin/python3', chosen: true, modules: ['numpy'] }]);
});

test('inference takes a CSV and answers the edges and self terms, or says the engine is missing', async (t) => {
    let available = false;
    const { ask } = await openedLauncher(t, { deps: { inferWithEngine: async (csv) => (available ? { available: true, report: { edges: [{ from: 'a', to: csv.length }] } } : { available: false }) } });
    assert.deepEqual(await ask('launcherInfer', { csv: '' }), { ok: false, message: 'Provide the table as CSV text.' });
    assert.deepEqual(await ask('launcherInfer', { csv: 't,a\n0,1\n' }), { ok: false, message: 'The inference engine is not available.' });
    available = true;
    assert.deepEqual(await ask('launcherInfer', { csv: 't,a\n0,1\n' }), { ok: true, edges: [{ from: 'a', to: 8 }], selfTerms: [] });
});

test('a session is kept with the project window only with project.data', async (t) => {
    const { ask, projectWindow } = await openedLauncher(t);
    await ask('launcherUseSample', { importerId: 'series' });
    assert.deepEqual(await ask('launcherKeepSession', { session: { zoom: 3 } }), { ok: true });
    const [[channel, kept]] = projectWindow.webContents.sent;
    assert.equal(channel, 'launcherKeepAddonData');
    assert.equal(kept.addonId, addonId);
    assert.deepEqual(kept.entry.window, { zoom: 3 });
    assert.deepEqual(kept.entry.inputs.map((input) => input.name), ['data.csv']);

    const { ask: askWithout } = await openedLauncher(t, { change: (value) => ({ ...value, permissions: value.permissions.filter((permission) => permission !== 'project.data'), requires: ['fetchCache', 'storedFiles', 'openLink', 'binaryInputs', 'multipleBinaryInputs', 'pythonCheck'] }) });
    assert.deepEqual(await askWithout('launcherKeepSession', { session: {} }), { ok: false, message: 'This launcher was not granted project.data.' });
});

test('files kept for the user are copied in, described, given to a binary role, and removed', async (t) => {
    const { ask, directory, dialogAnswers } = await openedLauncher(t);
    const extract = join(directory, 'city.osm.pbf');
    await writeFile(extract, Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(await ask('launcherStoredFiles', {}), { ok: true, files: [], bytes: 0 });

    dialogAnswers.push({ canceled: false, filePaths: [join(directory, 'notes.txt')] });
    assert.match((await ask('launcherStoreFiles', { accept: ['osm.pbf'] })).message, /only \.osm\.pbf files are kept here/, 'Refused before anything is copied.');
    dialogAnswers.push({ canceled: false, filePaths: [extract] });
    const stored = await ask('launcherStoreFiles', { accept: ['osm.pbf'], details: { label: 'City' } });
    assert.equal(stored.ok, true);
    const [file] = stored.files;
    assert.equal(file.name, 'city.osm.pbf');
    assert.equal(file.bytes, 4);
    assert.equal((await ask('launcherStoredFiles', {})).bytes, 4);

    assert.equal((await ask('launcherDescribeStoredFile', { id: file.id, details: { label: 'Town' } })).file.details.label, 'Town');
    assert.deepEqual(await ask('launcherUseStoredFiles', { importerId: 'series', role: 'data', ids: [file.id] }), { ok: false, message: 'Stored files are given to a binary file role.' });
    assert.deepEqual(await ask('launcherUseStoredFiles', { importerId: 'series', role: 'extract', ids: [] }), { ok: false, message: 'Name the stored files to use.' });
    const used = await ask('launcherUseStoredFiles', { importerId: 'series', role: 'extract', ids: [file.id] });
    assert.ok(used.ok);
    assert.ok(!('path' in used.files[0]), 'The window never sees where the bytes are.');
    assert.deepEqual((await ask('launcherGetManifest', {})).files.extract.map((entry) => [entry.name, entry.binary]), [['city.osm.pbf', true]]);

    assert.deepEqual(await ask('launcherRemoveStoredFile', { id: file.id }), { ok: true });
    assert.deepEqual(await ask('launcherUseStoredFiles', { importerId: 'series', role: 'extract', ids: [file.id] }), { ok: false, message: 'A stored file named is no longer kept.' });
    assert.deepEqual((await ask('launcherStoredFiles', {})).files, []);
    assert.deepEqual(await ask('launcherPartialDownloads', {}), { ok: true, partials: [] });
});

test('a binary file stays chosen across imports and goes to the importer as bytes, which it turns into text files', async (t) => {
    const { ask, directory, dialogAnswers, launcherWindow } = await openedLauncher(t);
    const extract = join(directory, 'area.pbf');
    await writeFile(extract, Buffer.from([10, 20, 30]));
    await ask('launcherUseSample', { importerId: 'series' });
    dialogAnswers.push({ canceled: false, filePaths: [extract] });
    assert.deepEqual(await ask('launcherChooseFile', { importerId: 'series', role: 'extract' }), { ok: true, chosen: true, name: 'area.pbf', names: ['area.pbf'], bytes: 3 });
    const plain = await ask('launcherRunImport', { importerId: 'series' });
    assert.equal(plain.imported, true, 'A run that does not ask for the binary files is not given them: the sample alone builds the model.');
    const answer = await ask('launcherRunImport', { importerId: 'series', options: { useBinaryFiles: true } });
    assert.equal(answer.ok, true, answer.message);
    assert.equal(answer.imported, false, 'Only derived files, no model.');
    assert.deepEqual(answer.data, { bytes: 3, isBytes: true, text: null });
    assert.deepEqual(answer.derived, [{ role: 'data', name: 'from-extract.csv', bytes: 15 }]);
    const files = (await ask('launcherGetManifest', {})).files;
    assert.deepEqual(files.data, { name: 'from-extract.csv', bytes: 15, sample: false, fetched: false, derivedFrom: 'area.pbf' }, 'The derived file takes the sample\'s place.');
    assert.equal(files.extract[0].name, 'area.pbf', 'The binary file stays chosen.');
    assert.ok(launcherWindow.webContents.channels().every((channel) => channel === 'launcherProgress'));
});

test('a help page opens in a locked-down window of its own, once', async (t) => {
    const { ask, addonDirectory } = await openedLauncher(t);
    assert.deepEqual(await ask('launcherOpenPage', { pageId: 'nope' }), { ok: false, message: 'The launcher named an undeclared page.' });
    const before = FakeWindow.created.length;
    assert.deepEqual(await ask('launcherOpenPage', { pageId: 'help' }), { ok: true });
    const page = FakeWindow.created.at(-1);
    assert.equal(FakeWindow.created.length, before + 1);
    assert.equal(page.loaded, join(addonDirectory, 'help', 'index.html'));
    assert.deepEqual(page.webContents.openHandler(), { action: 'deny' }, 'It opens no windows of its own.');
    let prevented = false;
    page.webContents.listeners['will-navigate']({ preventDefault: () => { prevented = true; } });
    assert.ok(prevented, 'It navigates nowhere.');
    await ask('launcherOpenPage', { pageId: 'help' });
    assert.equal(FakeWindow.created.length, before + 1, 'Asked again, the open page comes forward.');
    assert.equal(page.focused, 1);
});

test('an export needs an imported model and a run to export', async (t) => {
    const { ask } = await openedLauncher(t);
    assert.deepEqual(await ask('launcherExportResults', {}), { ok: false, message: 'Import your data first.' });
    await ask('launcherUseSample', { importerId: 'series' });
    await ask('launcherRunImport', { importerId: 'series' });
    assert.deepEqual(await ask('launcherExportResults', {}), { ok: false, message: 'Run a scenario first, so there is something to export.' });
    assert.deepEqual(await ask('launcherRunScenario', { scenarioId: 'cold' }), { ok: false, message: 'The launcher named an undeclared scenario.' });
});

test('closing the project window closes its launcher', async (t) => {
    const { projectWindow, launcherWindow, state } = await openedLauncher(t);
    projectWindow.destroy();
    assert.ok(launcherWindow.isDestroyed());
    assert.equal(state.launcherWindow, null);
});
