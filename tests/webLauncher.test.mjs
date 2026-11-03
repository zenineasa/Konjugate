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
    assert.match(webLauncherRefusal(launcherManifest({ permissions: ['files.store'] })), /files\.store/);
    assert.equal(webLauncherRefusal(launcherManifest({ permissions: ['data.import', 'network.fetch'], network: { hosts: ['a.example.com'] } })), null);
    assert.match(webLauncherRefusal(launcherManifest({ permissions: ['data.import', 'network.fetch'], network: { hosts: ['a.example.com'] }, requires: ['fetchCache'] })), /fetchCache/);
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
    for (const method of ['cacheInfo', 'clearCache', 'reloadFiles', 'storeFiles', 'downloadFile', 'infer', 'checkPython']) {
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
    permissions: ['data.import', 'scenario.run', 'results.export', 'model.open'], links: undefined,
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

test('opening in the canvas carries the baseline and the named scenario\'s fork in as branches', async () => {
    const { bridge, calls } = runnerBridge();
    await bridge.call('useSample', { importerId: 'csv' });
    await bridge.call('runImport', { importerId: 'csv' });
    const first = await bridge.call('openInCanvas', {});
    assert.equal(first.ok, true, first.message);
    assert.deepEqual(calls.opened.at(-1).branches, [], 'Before any run there is nothing to carry.');
    await bridge.call('runScenario', { scenarioId: 'boost', signals: [] });
    await bridge.call('openInCanvas', {});
    const [only] = calls.opened.at(-1).branches;
    assert.equal(calls.opened.at(-1).branches.length, 1);
    assert.deepEqual([only.label, only.parentBranchUuid, only.forkTime], ['Baseline', null, null]);
    await bridge.call('openInCanvas', { scenarioId: 'boost' });
    const [baseline, fork] = calls.opened.at(-1).branches;
    assert.equal(fork.label, 'Boost');
    assert.equal(fork.parentBranchUuid, baseline.branchUuid);
    assert.equal(fork.forkTime, 5);
    assert.deepEqual(fork.result.samples.map((sample) => sample.time), [5, 10], 'The fork holds its own run, from the fork point.');
    assert.notEqual(fork.branchUuid, baseline.branchUuid);
});

test('a launcher fetches from the hosts it declares, into a file role or as text, and nowhere else', async () => {
    const asked = [];
    const manifest = launcherManifest({ permissions: ['data.import', 'network.fetch'], network: { hosts: ['data.example.com'] } });
    const { bridge } = bridgeFor(manifest, { fetchBytes: async (href, hosts) => { asked.push([href, hosts]); return strToU8('t,v\n1,2\n'); } });
    const filed = await bridge.call('fetchFile', { importerId: 'csv', role: 'data', url: 'https://data.example.com/s?x=1', name: 'AAPL: daily' });
    assert.deepEqual([filed.ok, filed.name, filed.bytes, filed.cached], [true, 'AAPL_ daily', 8, false]);
    assert.match(filed.retrievedAt, /^\d{4}-/);
    assert.deepEqual(asked[0], ['https://data.example.com/s?x=1', ['data.example.com']]);
    const shown = (await bridge.call('getManifest', {})).files.data;
    assert.deepEqual([shown.name, shown.fetched], ['AAPL_ daily', true]);
    assert.deepEqual((await bridge.call('fetchText', { url: 'https://data.example.com/q' })).text, 't,v\n1,2\n');
    for (const url of ['http://data.example.com/', 'https://evil.example.com/', 'https://u:p@data.example.com/', 'nonsense']) {
        assert.equal((await bridge.call('fetchText', { url })).ok, false, url);
        assert.equal((await bridge.call('fetchFile', { importerId: 'csv', role: 'data', url, name: 'x' })).ok, false, url);
    }
    assert.match((await bridge.call('fetchFile', { importerId: 'csv', role: 'nope', url: 'https://data.example.com/', name: 'x' })).message, /undeclared file role/);
    assert.match((await bridge.call('fetchFile', { importerId: 'csv', role: 'data', url: 'https://data.example.com/', name: '' })).message, /Give the series a name/);
    assert.match((await bridge.call('fetchFile', { importerId: 'csv', role: 'data', url: 'https://data.example.com/', name: 'x', cache: 'sometimes' })).message, /use, refresh or off/);
    assert.equal(asked.length, 2, 'Nothing refused reached the network.');
    const { bridge: bare } = bridgeFor(launcherManifest(), { fetchBytes: async () => { throw new Error('reached'); } });
    assert.match((await bare.call('fetchText', { url: 'https://data.example.com/' })).message, /not granted network\.fetch/);
    const { bridge: big } = bridgeFor(manifest, { fetchBytes: async () => new Uint8Array(1024 * 1024 + 1) });
    assert.match((await big.call('fetchText', { url: 'https://data.example.com/' })).message, /larger than a window/);
    assert.equal((await big.call('fetchFile', { importerId: 'csv', role: 'data', url: 'https://data.example.com/', name: 'big' })).ok, true, 'A file may be larger than text a window receives.');
});

test('a fetch from a page keeps to the listed hosts, the size limit and the time limit, and says when a server will not be read', async () => {
    const { fetchAllowedFromPage } = await import('../src/webFetch.mjs');
    const hosts = ['data.example.com'];
    const asked = [];
    const answering = (answer) => async (request) => { asked.push(request); return answer; };
    const fetchWith = (answer, extra = {}) => fetchAllowedFromPage({ url: 'https://data.example.com/a', hosts, transport: answering(answer), ...extra });
    assert.deepEqual([...await fetchWith({ status: 200, bytes: new Uint8Array([104, 105]).buffer })], [104, 105]);
    assert.deepEqual(asked[0], { url: 'https://data.example.com/a', hosts: ['data.example.com'], maximumBytes: 5 * 1024 * 1024, timeoutMilliseconds: 20000 });
    await assert.rejects(fetchWith({ error: 'host', host: 'evil.example.com' }), /came from evil\.example\.com, which this window may not connect to/);
    await assert.rejects(fetchWith({ error: 'network' }), /may also not allow a web page to read it/);
    await assert.rejects(fetchWith({ error: 'timeout' }), /did not answer within 20 seconds/);
    await assert.rejects(fetchWith({ error: 'size' }), /larger than the size limit/);
    await assert.rejects(fetchWith({ error: 'stopped' }), /stopped part way/);
    await assert.rejects(fetchWith({ status: 404 }), /answered 404 \(not found/);
    await assert.rejects(fetchWith({ status: 429 }), /too many requests/);
    await assert.rejects(fetchWith({ status: 500 }), /answered 500\./);
    await assert.rejects(fetchWith({ status: 200, bytes: new Uint8Array(5).buffer }, { maximumBytes: 4 }), /larger than the size limit/);
    const before = asked.length;
    for (const url of ['http://data.example.com/a', 'https://other.example.com/a', 'https://u:p@data.example.com/a', 'nonsense']) await assert.rejects(fetchAllowedFromPage({ url, hosts, transport: answering({ status: 200, bytes: new ArrayBuffer(0) }) }), url);
    assert.equal(asked.length, before, 'Nothing refused was asked of the network.');
});

test('the frame a fetch is made from has no origin of its own to give, takes https only, and checks the hosts again, after any redirect', async () => {
    const { readFile } = await import('node:fs/promises');
    const shell = await readFile(new URL('../src/renderer/fetchFrame.html', import.meta.url), 'utf8');
    assert.match(shell, /Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src https:; form-action 'none'; base-uri 'none'"/);
    assert.match(shell, /credentials: 'omit'/);
    assert.match(shell, /referrerPolicy: 'no-referrer'/);
    assert.match(shell, /event\.source !== parent/);
    // the host list is checked on the address asked for and on where the answer came from, before the body is read
    assert.ok(shell.indexOf('listed(address)') < shell.indexOf('await fetch('));
    assert.ok(shell.indexOf('listed(source)') < shell.indexOf('response.body.getReader()'));
    const runner = await readFile(new URL('../src/renderer/webShims/fetchRunner.mjs', import.meta.url), 'utf8');
    assert.match(runner, /setAttribute\('sandbox', 'allow-scripts'\)/);
    assert.doesNotMatch(runner, /allow-same-origin/);
});

test('a launcher keeps its session with the project it opens, or without opening one, and gets it back with its inputs', async () => {
    const manifest = launcherManifest({ permissions: ['data.import', 'model.open', 'project.data'], version: '1.2.0' });
    let kept = null;
    const { bridge, calls } = bridgeFor(manifest, { keepAddonData: (id, entry) => { kept = { id, entry }; }, requestAddonData: async () => kept?.entry ?? null });
    assert.match((await bridge.call('restoreSession', {})).session ?? 'none', /none/, 'nothing kept yet');
    await bridge.call('useSample', { importerId: 'csv' });
    await bridge.call('runImport', { importerId: 'csv' });
    // with the project it opens: the entry is attached to the model's text, beside any entry already there
    assert.deepEqual(await bridge.call('openInCanvas', { session: { picked: ['a'] } }), { ok: true });
    const attached = JSON.parse(calls.opened.at(-1).content).addonData['example.toolbox'];
    assert.deepEqual([attached.version, attached.addonVersion, attached.window, attached.inputs.map((input) => [input.role, input.name, input.sample])], [1, '1.2.0', { picked: ['a'] }, [['data', 'sample.csv', true]]]);
    assert.equal(JSON.parse(calls.opened.at(-1).content).addonData['example.toolbox'].inputs[0].sha256, 'hash8');
    // without opening anything
    assert.deepEqual(await bridge.call('keepSession', { session: { sites: [1, 2] } }), { ok: true });
    assert.equal(kept.id, 'example.toolbox');
    assert.deepEqual(kept.entry.window, { sites: [1, 2] });
    // restored into a fresh bridge: the inputs are pending again, flagged restored, and the window gets its state back
    const { bridge: later } = bridgeFor(manifest, { requestAddonData: async () => ({ ...kept.entry, inputs: kept.entry.inputs.map(({ sha256: dropped, ...input }) => input) }) });
    const restored = await later.call('restoreSession', {});
    assert.deepEqual([restored.ok, restored.session, restored.inputs], [true, { sites: [1, 2] }, [{ role: 'data', name: 'sample.csv', bytes: 8 }]]);
    assert.deepEqual((await later.call('getManifest', {})).files.data, { name: 'sample.csv', bytes: 8, sample: true, fetched: false });
    assert.equal((await later.call('runImport', { importerId: 'csv' })).imported, true, 'The restored inputs run the importer as before.');
    // an entry this host does not know, or that is too large, is not taken or kept
    const { bridge: odd } = bridgeFor(manifest, { requestAddonData: async () => ({ version: 2, inputs: [] }) });
    assert.deepEqual(await odd.call('restoreSession', {}), { ok: true, session: null });
    assert.match((await bridge.call('keepSession', { session: { big: 'x'.repeat(3 * 1024 * 1024) } })).message, /larger than the host keeps/);
    // without the permission nothing is kept, restored or attached
    const { bridge: bare, calls: bareCalls } = bridgeFor(launcherManifest({ permissions: ['data.import', 'model.open'] }), { keepAddonData: () => { throw new Error('kept'); }, requestAddonData: async () => { throw new Error('asked'); } });
    await bare.call('useSample', { importerId: 'csv' });
    await bare.call('runImport', { importerId: 'csv' });
    for (const [method, params] of [['keepSession', { session: {} }], ['restoreSession', {}], ['openInCanvas', { session: {} }]]) assert.match((await bare.call(method, params)).message, /not granted project\.data/, method);
    assert.deepEqual(bareCalls.opened, []);
});
