/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8 } from 'fflate';
import { createPackageArchive } from '../src/packageArchive.mjs';
import { launcherApiSource } from '../src/webAddonDocument.mjs';
import { createLauncherBridge, webLauncherRefusal } from '../src/webLauncherBridge.mjs';
import { importerWorkerSource } from '../src/webImporterWorker.mjs';
import { createMemoryStorage, createPackageStore } from '../src/webPackageStore.mjs';

const launcherManifest = (overrides = {}) => ({
    kind: 'launcher', addonId: 'example.toolbox', name: 'Example Toolbox', version: '1.0.0', apiVersion: 1, entry: 'ui/index.html',
    permissions: ['data.import', 'model.open', 'pages.open', 'links.open'], links: { hosts: ['maps.example.com'] },
    contributes: {
        toolstrip: [{ commandId: 'open', label: 'Toolbox', tooltip: 'Open the toolbox', when: 'always' }],
        importers: [{ importerId: 'csv', name: 'CSV', entry: 'importer.mjs', files: [{ role: 'data', label: 'Data file', required: true, accept: ['csv'], sample: 'sample.csv' }, { role: 'extra', label: 'Extra', multiple: true, accept: ['csv'] }] }],
        pages: [{ pageId: 'help', label: 'Help', entry: 'help.html' }]
    },
    ...overrides
});

function bridgeFor(manifest = launcherManifest(), hostOverrides = {}) {
    const calls = { opened: [], pages: [], links: [], emitted: [], importer: [], saved: [] };
    const host = {
        readPackageFile: async (path) => (path === 'sample.csv' ? strToU8('a,b\n1,2\n') : null),
        chooseFiles: async () => [{ name: 'mine.csv', bytes: strToU8('x,y\n3,4\n') }],
        runImporter: async ({ files, options, onProgress }) => {
            calls.importer.push({ files, options });
            onProgress({ done: 1, total: 2, message: 'half' });
            return { ok: true, report: { rows: 1 }, document: { nodes: [], edges: [] }, parameterIndex: [{ entity: 'Tank' }, { entity: 'Tank' }] };
        },
        openProject: async (payload) => calls.opened.push(payload),
        openPage: async (page) => calls.pages.push(page),
        openLink: async (href) => { calls.links.push(href); return true; },
        emit: (channel, payload) => calls.emitted.push([channel, payload]),
        sha256: async (bytes) => `hash${bytes.length}`,
        appVersion: '1.3.4',
        encodeModel: async (content) => new TextEncoder().encode(`kjt:${content.length}`),
        saveFiles: async (name, files) => calls.saved.push({ name, files }),
        ...hostOverrides
    };
    return { bridge: createLauncherBridge({ manifest, host }), calls };
}

test('a launcher that needs more than this slice offers is turned away saying what', () => {
    assert.equal(webLauncherRefusal(launcherManifest()), null);
    assert.match(webLauncherRefusal(launcherManifest({ permissions: ['data.import', 'analysis.infer'] })), /analysis\.infer/);
    assert.match(webLauncherRefusal(launcherManifest({ permissions: ['network.fetch'], network: { hosts: ['a.example.com'] } })), /network\.fetch/);
    assert.match(webLauncherRefusal(launcherManifest({ requires: ['storedFiles'] })), /storedFiles/);
    const binary = launcherManifest();
    binary.contributes.importers[0].files[0] = { role: 'data', label: 'Map', binary: true, accept: ['pbf'] };
    assert.match(webLauncherRefusal(binary), /binary/);
});

test('a launcher installs from a file, and one needing more than the web edition gives is refused at install with the reason', async () => {
    const pack = (manifest) => createPackageArchive({
        packageManifest: { format: 'konjugate-package', formatVersion: 1, packageType: 'addon', packageId: manifest.addonId, name: manifest.name, version: '1.0.0', contents: { manifest: 'addon.json' } },
        contributionManifest: manifest,
        files: { 'ui/index.html': strToU8('<html></html>'), 'importer.mjs': strToU8('export default () => {}'), 'sample.csv': strToU8('a\n1'), 'help.html': strToU8('<p>help</p>') }
    });
    const packages = createPackageStore({ storage: createMemoryStorage(), appVersion: '1.3.4' });
    await packages.install(pack(launcherManifest()), '.kja');
    assert.equal((await packages.runnableAddons()).length, 1);
    await assert.rejects(packages.install(pack(launcherManifest({ addonId: 'example.other', permissions: ['analysis.infer'], links: undefined })), '.kja'), /analysis\.infer/);
    await packages.install(pack({ ...scenarioManifest(), addonId: 'example.scenarios' }), '.kja');
    assert.equal((await packages.runnableAddons()).length, 2, 'A launcher that runs scenarios installs.');
});

test('the window is told what the manifest declares, and what is chosen', async () => {
    const { bridge } = bridgeFor();
    const first = await bridge.call('getManifest');
    assert.equal(first.ok, true);
    assert.deepEqual(first.scenarios, []);
    assert.deepEqual(first.pages, [{ pageId: 'help', label: 'Help' }]);
    assert.equal(first.importers[0].files[0].hasSample, true);
    await bridge.call('chooseFile', { importerId: 'csv', role: 'data' });
    assert.equal((await bridge.call('getManifest')).files.data.name, 'mine.csv');
});

test('choosing a file, the sample and clearing work on declared ids only', async () => {
    const { bridge } = bridgeFor();
    assert.deepEqual(await bridge.call('chooseFile', { importerId: 'csv', role: 'data' }), { ok: true, chosen: true, name: 'mine.csv', names: ['mine.csv'], bytes: 8 });
    assert.equal((await bridge.call('chooseFile', { importerId: 'nope', role: 'data' })).ok, false);
    assert.match((await bridge.call('chooseFile', { importerId: 'csv', role: 'nope' })).message, /undeclared file role/);
    await bridge.call('useSample', { importerId: 'csv' });
    assert.equal((await bridge.call('getManifest')).files.data.sample, true);
    await bridge.call('clearFile', { importerId: 'csv', role: 'data' });
    assert.equal((await bridge.call('getManifest')).files.data, undefined);
    const { bridge: none } = bridgeFor(launcherManifest(), { chooseFiles: async () => null });
    assert.deepEqual(await none.call('chooseFile', { importerId: 'csv', role: 'data' }), { ok: true, chosen: false });
});

test('a file over the size limit is refused', async () => {
    const { bridge } = bridgeFor(launcherManifest(), { chooseFiles: async () => [{ name: 'big.csv', bytes: new Uint8Array(11 * 1024 * 1024) }] });
    assert.match((await bridge.call('chooseFile', { importerId: 'csv', role: 'data' })).message, /larger than the 10 MB limit/);
});

test('an import needs its required files, passes the importer its inputs and reports progress, and what it builds opens in the canvas', async () => {
    const { bridge, calls } = bridgeFor();
    assert.match((await bridge.call('runImport', { importerId: 'csv' })).message, /Choose Data file first/);
    assert.match((await bridge.call('openInCanvas')).message, /Import your data first/);
    await bridge.call('useSample', { importerId: 'csv' });
    const result = await bridge.call('runImport', { importerId: 'csv', options: { depth: 2 } });
    assert.deepEqual([result.ok, result.imported, result.entities], [true, true, ['Tank']]);
    assert.deepEqual(calls.importer[0].files, [{ role: 'data', name: 'sample.csv', text: 'a,b\n1,2\n', encoding: 'utf-8' }]);
    assert.deepEqual(calls.emitted, [['launcherProgress', { stage: 'import', importerId: 'csv', done: 1, total: 2, message: 'half' }]]);
    assert.equal((await bridge.call('openInCanvas', { silent: true })).ok, true);
    assert.deepEqual([calls.opened[0].suggestedFilename, calls.opened[0].silent, calls.opened[0].addonName], ['ExampleToolbox.kjt', true, 'Example Toolbox']);
    assert.equal(JSON.parse(calls.opened[0].content).nodes.length, 0);
    // choosing another file forgets the model built from the earlier one
    await bridge.call('chooseFile', { importerId: 'csv', role: 'data' });
    assert.match((await bridge.call('openInCanvas')).message, /Import your data first/);
});

test('what an importer derives replaces the files of its roles, and a failing importer is reported', async () => {
    const derived = bridgeFor(launcherManifest(), { runImporter: async () => ({ ok: true, report: {}, derived: [{ role: 'extra', name: 'cleaned.csv', text: 'z\n9' }] }) });
    await derived.bridge.call('useSample', { importerId: 'csv' });
    const first = await derived.bridge.call('runImport', { importerId: 'csv' });
    assert.deepEqual([first.imported, first.derived], [false, [{ role: 'extra', name: 'cleaned.csv', bytes: 3 }]]);
    assert.equal((await derived.bridge.call('getManifest')).files.extra[0].name, 'cleaned.csv');
    const failing = bridgeFor(launcherManifest(), { runImporter: async () => { throw new Error('The importer failed: boom'); } });
    await failing.bridge.call('useSample', { importerId: 'csv' });
    assert.deepEqual(await failing.bridge.call('runImport', { importerId: 'csv' }), { ok: false, message: 'The importer failed: boom' });
});

test('pages and links go only where the manifest says, and without the permission nothing happens', async () => {
    const { bridge, calls } = bridgeFor();
    assert.equal((await bridge.call('openPage', { pageId: 'help' })).ok, true);
    assert.equal(calls.pages[0].entry, 'help.html');
    assert.match((await bridge.call('openPage', { pageId: '../x' })).message, /undeclared page/);
    assert.equal((await bridge.call('openLink', { url: 'https://maps.example.com/dir?a=1' })).opened, true);
    for (const url of ['http://maps.example.com/', 'https://evil.example.com/', 'https://user:pw@maps.example.com/', 'javascript:alert(1)', 'not a url']) assert.equal((await bridge.call('openLink', { url })).ok, false, url);
    assert.deepEqual(calls.links, ['https://maps.example.com/dir?a=1']);
    const { bridge: limited, calls: limitedCalls } = bridgeFor(launcherManifest({ permissions: ['data.import'] }));
    for (const [method, params] of [['openPage', { pageId: 'help' }], ['openLink', { url: 'https://maps.example.com/' }], ['openInCanvas', {}]]) assert.match((await limited.call(method, params)).message, /was not granted/);
    assert.deepEqual([limitedCalls.pages, limitedCalls.links, limitedCalls.opened], [[], [], []]);
});

test('what this slice cannot do answers that it is not available, and only the named methods are reachable', async () => {
    const { bridge } = bridgeFor();
    for (const method of ['fetchText', 'fetchFile', 'keepSession', 'storeFiles', 'downloadFile', 'infer', 'checkPython']) {
        const answer = await bridge.call(method, {});
        assert.equal(answer.ok, false);
        assert.match(answer.message, /not available in the web edition yet/);
    }
    assert.match((await bridge.call('openInCanvas', { session: {} })).message, /Import your data first|not available/);
    for (const method of ['constructor', 'toString', '__proto__', 'handlers', undefined, 7]) assert.match((await bridge.call(method, {})).message, /Unknown method/);
});

test('the API a launcher sees, and the worker an importer runs in, have the desktop\'s shape', () => {
    for (const name of ['getManifest', 'chooseFile', 'clearFile', 'useSample', 'runImport', 'openInCanvas', 'openPage', 'openLink', 'runScenario', 'onProgress']) assert.match(launcherApiSource, new RegExp(name));
    assert.match(launcherApiSource, /konjugateLauncher/);
    for (const name of ['progress', 'applyOperations', 'reconcileEquationBindings', 'validateEquationLatex', 'readPackageJson']) assert.match(importerWorkerSource, new RegExp(name));
    // neither the worker source nor the frame ever reaches for the network or the page's storage
    assert.doesNotMatch(importerWorkerSource, /fetch\(|XMLHttpRequest|localStorage|indexedDB|importScripts/);
});

test('the importer\'s frame starts from a page whose policy lets nothing in or out beyond the blob: scripts it makes itself', async () => {
    const { readFile } = await import('node:fs/promises');
    const shell = await readFile(new URL('../src/renderer/importerFrame.html', import.meta.url), 'utf8');
    const policy = shell.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.match(policy, /^default-src 'none';/);
    assert.match(policy, /script-src 'unsafe-inline' blob:;/);
    assert.match(policy, /worker-src blob:;/);
    assert.doesNotMatch(policy, /connect-src|img-src|frame-src|https?:|\*/);
    const runner = (await readFile(new URL('../src/renderer/webShims/importerRunner.mjs', import.meta.url), 'utf8')).split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    assert.match(runner, /setAttribute\('sandbox', 'allow-scripts'\)/);
    assert.doesNotMatch(runner, /allow-same-origin/);
});

// ---- scenarios --------------------------------------------------------------------------------------

const scenarioManifest = () => launcherManifest({
    permissions: ['data.import', 'scenario.run', 'results.export'], links: undefined,
    contributes: {
        ...launcherManifest().contributes,
        scenarios: [{ scenarioId: 'boost', name: 'Boost', description: 'Raise the gain', forkAt: 5, runTime: 10, interventions: [{ parameter: 'gain', target: 'global', value: 3 }] }]
    }
});
const modelDocument = {
    nodes: [{ id: 1, name: 'Room', states: [{ id: 4, name: 'Level', symbol: 'level' }] }], edges: [],
    sharedParameters: [{ id: 7, name: 'Gain', symbol: 'gain', value: 1, mode: 'live' }],
    runConfigurations: [{ globalTimeStep: 0.5, outputInterval: 5, targetTime: 10 }]
};
const sampled = (values) => values.map(([time, level]) => ({ time, states: [{ stateId: 4, value: level }] }));

function runnerBridge({ canSendCommands = false } = {}) {
    const runs = [];
    const { bridge, calls } = bridgeFor(scenarioManifest(), {
        canSendCommands,
        runImporter: async () => ({ ok: true, report: {}, document: modelDocument, parameterIndex: [{ key: 'gain', scope: 'global', name: 'Gain', sharedParameterId: 7, live: true, value: 1, minimum: 0, maximum: 10 }] }),
        runModel: async (run) => {
            runs.push(run);
            return run.config.startCheckpoint
                ? { samples: sampled([[5, 5], [10, 20]]), checkpoints: [] }
                : { samples: sampled([[0, 0], [5, 5], [10, 10]]), checkpoints: [{ time: 0, states: [] }, { time: 5, states: [{ stateId: 4, value: 5 }] }, { time: 10, states: [] }] };
        }
    });
    return { bridge, runs, calls };
}

test('a scenario runs the baseline once and forks it, writing its changes into the model where commands cannot be sent', async () => {
    const { bridge, runs } = runnerBridge();
    assert.equal((await bridge.call('runScenario', { scenarioId: 'boost', signals: ['level'] })).message, 'Import your data first.');
    await bridge.call('useSample', { importerId: 'csv' });
    assert.equal((await bridge.call('runImport', { importerId: 'csv' })).imported, true);
    const answer = await bridge.call('runScenario', { scenarioId: 'boost', signals: ['level'] });
    assert.equal(answer.ok, true, answer.message);
    assert.equal(answer.forkTime, 5);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].config.targetTime, 10, 'The baseline runs the scenario\'s length.');
    assert.deepEqual(runs[1].config.startCheckpoint, { time: 5, states: [{ stateId: 4, value: 5 }] });
    assert.deepEqual(runs[1].commands, []);
    const forked = JSON.parse(runs[1].content);
    assert.deepEqual(forked.sharedParameters[0].schedule, { interpolation: 'linear', samples: [[5, 3]] }, 'A step at the fork is the parameter at 3 from there.');
    assert.deepEqual(answer.branches.map((branch) => branch.id), ['baseline', 'scenario']);
    assert.deepEqual(answer.branches[1].series, { Room: { level: [[0, 0], [5, 5], [10, 20]] } }, 'The branch is the baseline up to the fork and the fork after it.');
    await bridge.call('runBaseline', { runTime: 10, signals: ['level'] });
    assert.equal(runs.length, 2, 'The baseline of that length is kept, so a plain run of it runs nothing again.');
});

test('where the page can send commands the fork is held paused and gets the desktop\'s commands', async () => {
    const { bridge, runs } = runnerBridge({ canSendCommands: true });
    await bridge.call('useSample', { importerId: 'csv' });
    await bridge.call('runImport', { importerId: 'csv' });
    await bridge.call('runScenario', { scenarioId: 'boost', signals: [] });
    assert.equal(runs[1].config.startPaused, true);
    assert.deepEqual(runs[1].commands, [
        { type: 'setRunState', state: 'paused' },
        { type: 'scheduleParameterValue', parameterId: 7, mode: 'step', startTime: 5, targetValue: 3 },
        { type: 'setRunState', state: 'running' }
    ]);
    assert.equal(JSON.parse(runs[1].content).sharedParameters[0].schedule, undefined, 'The model is left as it was.');
});

test('importing again drops the baseline, and a launcher without scenario.run cannot run', async () => {
    const { bridge, runs } = runnerBridge();
    await bridge.call('useSample', { importerId: 'csv' });
    await bridge.call('runImport', { importerId: 'csv' });
    await bridge.call('runBaseline', { runTime: 10 });
    await bridge.call('runImport', { importerId: 'csv' });
    await bridge.call('runBaseline', { runTime: 10 });
    assert.equal(runs.length, 2, 'A new model has its own baseline.');
    assert.match((await bridge.call('runBaseline', { runTime: 99999999 })).message, /run length/);
    const plain = bridgeFor(launcherManifest());
    assert.match((await plain.bridge.call('runScenario', { scenarioId: 'boost' })).message, /was not granted scenario\.run/);
    assert.match((await plain.bridge.call('runBaseline', {})).message, /was not granted scenario\.run/);
});

test('results are exported as one set of files with a manifest that records what produced them', async () => {
    const { bridge, calls } = runnerBridge();
    assert.match((await bridge.call('exportResults', {})).message, /Import your data first/);
    await bridge.call('useSample', { importerId: 'csv' });
    await bridge.call('runImport', { importerId: 'csv', options: { depth: 2 } });
    assert.match((await bridge.call('exportResults', {})).message, /Run a scenario first/);
    await bridge.call('runScenario', { scenarioId: 'boost', signals: [] });
    const answer = await bridge.call('exportResults', { scenarioId: 'boost', summaryCsv: 'a,b\n1,2\n' });
    assert.equal(answer.ok, true, answer.message);
    assert.deepEqual(answer.files, ['results.csv', 'summary.csv', 'model.kjt', 'run-manifest.json']);
    assert.match(answer.folder, /^ExampleToolbox-.*\.zip$/);
    const [{ name, files }] = calls.saved;
    assert.match(name, /^ExampleToolbox-/);
    const csv = new TextDecoder().decode(files['results.csv']);
    assert.match(csv, /^branch,time,node,state,unit,value\nBaseline,0,Room,Level,,0\n/);
    assert.match(csv, /Boost,10,Room,Level,,20\n$/);
    const manifest = JSON.parse(new TextDecoder().decode(files['run-manifest.json']));
    assert.equal(manifest.konjugate.version, '1.3.4');
    assert.equal(manifest.scenario.scenarioId, 'boost');
    assert.deepEqual(manifest.importerOptions, { depth: 2 });
    assert.equal(manifest.inputs[0].sha256, 'hash8', 'The input file is recorded by its hash.');
    assert.equal(manifest.files['results.csv'].sha256, `hash${files['results.csv'].length}`);
    assert.ok(!('run-manifest.json' in manifest.files));
    const plain = await bridge.call('exportResults', {});
    assert.equal(plain.ok, true);
    assert.doesNotMatch(new TextDecoder().decode(calls.saved[1].files['results.csv']), /Boost/, 'Without a scenario named, only the baseline is exported.');
    const without = bridgeFor(launcherManifest());
    assert.match((await without.bridge.call('exportResults', {})).message, /was not granted results\.export/);
});
