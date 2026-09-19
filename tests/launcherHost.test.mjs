/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateAddonManifest } from '../src/addonHost.mjs';
import {
    buildRunManifest, composeBranchSamples, decodeText, extractSeries, fetchAllowed, safeFileName, resolveInterventions, resultsToCsv, runImporter, runScenarioBranches, sha256
} from '../src/launcherHost.mjs';

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'launcher');

const launcher = () => ({
    addonId: 'example.thermalStart', name: 'Thermal Start', version: '0.1.0', apiVersion: 1, kind: 'launcher', entry: 'index.html',
    permissions: ['data.import', 'scenario.run', 'model.open', 'results.export', 'pages.open'],
    contributes: {
        toolstrip: [{ commandId: 'openStart', label: 'Thermal', tooltip: 'Open Thermal Start', symbol: '◆', when: 'always', contexts: [] }],
        importers: [{ importerId: 'rooms', name: 'Rooms', entry: 'importers/rooms.mjs', files: [{ role: 'rooms', label: 'Rooms', required: true, sample: 'samples/rooms.csv' }] }],
        scenarios: [{
            scenarioId: 'coldDay', name: 'Cold day', description: 'The outside temperature drops.', forkAt: 5, runTime: 20,
            interventions: [{ parameter: 'outsideTemperature', target: 'global', value: 250 }]
        }],
        pages: [{ pageId: 'gettingStarted', label: 'Getting started', entry: 'help/gettingStarted.html' }]
    }
});

test('a well-formed launcher manifest is accepted', () => {
    assert.equal(validateAddonManifest(launcher()).kind, 'launcher');
});

test('a launcher manifest is rejected when it breaks the contract', () => {
    const rejects = (mutate, pattern) => {
        const manifest = launcher();
        mutate(manifest);
        assert.throws(() => validateAddonManifest(manifest), pattern);
    };
    rejects((m) => { m.permissions.push('model.write'); }, /unsupported permission/);
    rejects((m) => { m.contributes.toolstrip[0].when = 'resultsActive'; }, /always-visible toolstrip/);
    rejects((m) => { m.contributes.toolstrip[0].contexts = ['resultSession']; }, /always-visible toolstrip/);
    rejects((m) => { m.entry = '../index.html'; }, /relative path/);
    rejects((m) => { m.contributes.importers[0].entry = '/etc/importer.mjs'; }, /relative path/);
    rejects((m) => { m.contributes.importers[0].entry = 'importers/rooms.js'; }, /must end in \.mjs/);
    rejects((m) => { m.contributes.importers[0].files[0].sample = '../secret.csv'; }, /relative path/);
    rejects((m) => { m.contributes.importers[0].files[0].multiple = 'yes'; }, /multiple must be true or false/);
    rejects((m) => { m.contributes.importers[0].files[0].sample = ['a.csv', 'b.csv']; }, /several files/);
    rejects((m) => { m.contributes.importers.push({ ...m.contributes.importers[0] }); }, /duplicated importer/);
    rejects((m) => { m.contributes.scenarios[0].runTime = 3; }, /longer run time/);
    rejects((m) => { m.contributes.scenarios[0].interventions[0].target = 'nowhere'; }, /intervention/);
    rejects((m) => { m.contributes.scenarios[0].interventions[0].fractionOfMaximum = 0.5; }, /exactly one of value or fractionOfMaximum/);
    rejects((m) => { m.contributes.scenarios[0].choose = {}; }, /choice needs a label/);
    rejects((m) => { m.contributes.scenarios[0].effects = 'x'; }, /effects must be a list/);
    rejects((m) => { m.contributes.pages[0].entry = 'help/../../x.html'; }, /relative path/);
    rejects((m) => { m.apiVersion = 2; }, /Unsupported launcher API version/);
});

test('an importer runs in a worker, can read its own package JSON, and its output is checked', async () => {
    const importer = { entry: 'echoImporter.mjs' };
    const run = (text) => runImporter({ addonDirectory: fixtureDirectory, importer, files: [{ role: 'data', name: 'data.csv', text }], timeoutMilliseconds: 1500 });
    assert.deepEqual((await run('hello')).report.summary, { text: 'hello', extra: 7 });
    await assert.rejects(() => run('boom'), /The importer failed: boom/);
    await assert.rejects(() => run('bad'), /unexpected result/);
    await assert.rejects(() => run('hang'), /did not finish within/);
});

test('an importer can return only data, receive options, and build a model from construction operations', async () => {
    const importer = { entry: 'echoImporter.mjs' };
    const run = (text, options) => runImporter({ addonDirectory: fixtureDirectory, importer, files: [{ role: 'data', name: 'data.csv', text }], options, timeoutMilliseconds: 1500 });
    const first = await run('data-only', { stage: 'read' });
    assert.deepEqual(first.data, { received: 'read', files: 1 });
    assert.equal(first.document, undefined);
    const built = await run('operations');
    assert.equal(built.document.nodes[0].sourceTerms[0].expression, '-x');
    assert.equal(typeof built.data.references.x, 'number');
});

test('a launcher file role may accept several files and list several samples', () => {
    const manifest = launcher();
    Object.assign(manifest.contributes.importers[0].files[0], { multiple: true, sample: ['samples/a.csv', 'samples/b.csv'] });
    assert.equal(validateAddonManifest(manifest).kind, 'launcher');
});

test('a scenario can take values or paths of values that the window supplies', () => {
    const index = [
        { key: 'drive', scope: 'series', entity: 'Gold', sharedParameterId: 1, name: 'Drive (Gold)', live: true, minimum: -0.5, maximum: 0.5, value: 0 },
        { key: 'drive', scope: 'series', entity: 'Oil', sharedParameterId: 2, name: 'Drive (Oil)', live: true, minimum: -0.5, maximum: 0.5, value: 0 },
        { key: 'gain', scope: 'series', entity: 'Gold', sharedParameterId: 3, name: 'Gain (Gold)', live: true, minimum: 0, maximum: 20, value: 0 }
    ];
    const scenario = { name: 'Replay', interventions: [{ parameter: 'gain', target: 'supplied', value: 8 }, { parameter: 'drive', target: 'supplied', samples: true }] };
    const resolved = resolveInterventions(scenario, index, null, { entities: ['Gold'], samples: { Gold: [[0, 0.01], [1, 0.9], [2, -0.02]] } });
    assert.deepEqual(resolved.map((change) => [change.parameter, change.entity]), [['gain', 'Gold'], ['drive', 'Gold']]);
    assert.equal(resolved[0].value, 8);
    assert.deepEqual(resolved[1].samples, [{ time: 0, value: 0.01 }, { time: 1, value: 0.5 }, { time: 2, value: -0.02 }], 'Values are held to the parameter\'s range.');
    assert.throws(() => resolveInterventions(scenario, index, null, null), /needs the window to supply data/);
    assert.throws(() => resolveInterventions(scenario, index, null, { entities: ['Oil'], samples: { Oil: [[0, 1], [1, 2]] } }), /does not have for Oil|gain/);
    assert.throws(() => resolveInterventions(scenario, index, null, { entities: ['Gold'], samples: { Gold: [[0, 1]] } }), /at least two/);
    assert.throws(() => resolveInterventions(scenario, index, null, { entities: ['Gold'], samples: { Gold: [[0, 'x'], [1, 2]] } }), /at least two/);
});

test('a supplied intervention takes a value or samples, and not both or neither', () => {
    const withIntervention = (intervention) => { const manifest = launcher(); manifest.contributes.scenarios[0].interventions = [intervention]; return manifest; };
    assert.equal(validateAddonManifest(withIntervention({ parameter: 'drive', target: 'supplied', samples: true })).kind, 'launcher');
    assert.equal(validateAddonManifest(withIntervention({ parameter: 'gain', target: 'supplied', value: 8 })).kind, 'launcher');
    assert.throws(() => validateAddonManifest(withIntervention({ parameter: 'drive', target: 'supplied' })), /supplied target takes a value, or samples/);
    assert.throws(() => validateAddonManifest(withIntervention({ parameter: 'drive', target: 'supplied', samples: true, value: 1 })), /supplied target takes a value, or samples/);
});

test('scenario interventions resolve to concrete parameter changes', () => {
    const index = [
        { key: 'withdrawalRate', scope: 'institution', entity: 'Alder', sharedParameterId: 1, name: 'Withdrawal (Alder)', live: true, minimum: 0, maximum: 0.2 },
        { key: 'withdrawalRate', scope: 'institution', entity: 'Birch', sharedParameterId: 2, name: 'Withdrawal (Birch)', live: true, minimum: 0, maximum: 0.2 },
        { key: 'lending', scope: 'institution', entity: 'Alder', sharedParameterId: 3, name: 'Lending (Alder)', live: true, minimum: 0, maximum: 100 },
        { key: 'haircut', scope: 'global', sharedParameterId: 4, name: 'Haircut', live: true, minimum: 0, maximum: 1 },
        { key: 'fixed', scope: 'global', sharedParameterId: 5, name: 'Fixed', live: false }
    ];
    const scenario = { name: 'Stress', interventions: [
        { parameter: 'withdrawalRate', target: 'chosen', value: 0.05 },
        { parameter: 'lending', target: 'chosen', fractionOfMaximum: 0.5, at: 3 },
        { parameter: 'haircut', target: 'global', value: 5 }
    ] };
    const resolved = resolveInterventions(scenario, index, 'Alder');
    assert.deepEqual(resolved.map((change) => [change.sharedParameterId, change.value, change.at]), [[1, 0.05, 0], [3, 50, 3], [4, 1, 0]], 'Values are clamped to the parameter range.');
    assert.equal(resolveInterventions({ name: 'Run on all', interventions: [{ parameter: 'withdrawalRate', target: 'all', value: 0.01 }] }, index).length, 2);
    assert.throws(() => resolveInterventions(scenario, index, null), /choose one first/);
    assert.throws(() => resolveInterventions({ name: 'X', interventions: [{ parameter: 'absent', target: 'global', value: 1 }] }, index), /does not have/);
    assert.throws(() => resolveInterventions({ name: 'X', interventions: [{ parameter: 'fixed', target: 'global', value: 1 }] }, index), /cannot be changed during a run/);
});

const document = { nodes: [{ id: 1, name: 'Room', states: [{ id: 2, symbol: 'temperature', name: 'Temperature', unit: 'K' }] }], edges: [] };
const sample = (time, value) => ({ time, states: [{ stateId: 2, value }] });

test('a forked branch reads as one continuous history, and series and CSV come out in the expected shape', () => {
    const parent = [sample(0, 1), sample(1, 2), sample(2, 3), sample(3, 4)];
    const child = [sample(2, 30), sample(3, 40)];
    const composed = composeBranchSamples(parent, child, 2);
    assert.deepEqual(composed.map((item) => [item.time, item.states[0].value]), [[0, 1], [1, 2], [2, 30], [3, 40]]);
    assert.deepEqual(extractSeries(composed, document, ['temperature']), { Room: { temperature: [[0, 1], [1, 2], [2, 30], [3, 40]] } });
    assert.deepEqual(extractSeries(composed, document, ['humidity']), {});
    const csv = resultsToCsv([{ label: 'Base, line', samples: parent.slice(0, 1) }, { label: 'Cold', samples: child.slice(0, 1) }], document);
    assert.equal(csv, 'branch,time,node,state,unit,value\n"Base, line",0,Room,Temperature,K,1\nCold,2,Room,Temperature,K,30\n');
});

test('the run manifest records what produced a result', () => {
    const manifest = buildRunManifest({
        appVersion: '1.2.3', addon: { addonId: 'example.thermalStart', name: 'Thermal Start', version: '0.1.0' }, importerId: 'rooms',
        inputs: [{ role: 'rooms', name: 'rooms.csv', sha256: 'abc', bytes: 12, text: 'not recorded' }], contentText: '{"a":1}', document,
        config: { targetTime: 20 }, scenario: { scenarioId: 'coldDay', name: 'Cold day', description: 'd', forkAt: 5 }, chosenEntity: null,
        interventions: [{ sharedParameterId: 4, value: 250 }], files: { 'results.csv': { sha256: 'x', bytes: 1 } }
    });
    assert.equal(manifest.model.sha256, sha256('{"a":1}'));
    assert.deepEqual(manifest.inputs, [{ role: 'rooms', name: 'rooms.csv', sha256: 'abc', bytes: 12 }], 'The file text is never recorded, only its hash.');
    assert.equal(manifest.scenario.forkAt, 5);
    assert.equal(manifest.package.version, '0.1.0');
});

// A forked scenario against the real engine: a level fed by a shared live gain, doubled at the fork.
const enginePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'engine', 'konjugateEngine');
test('a scenario forks the baseline at its time and changes a live shared parameter from there', { skip: !existsSync(enginePath) && 'the engine is not built' }, async () => {
    const { startEngineRun } = await import('../src/engineAdapter.mjs');
    const engineOptions = { applicationPath: join(dirname(fileURLToPath(import.meta.url)), '..'), resourcesPath: '', packaged: false };
    const node = (id, name, stateId) => ({ id, name, position: [0, 0, 0], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#888888' }, states: [{ id: stateId, name: 'Level', symbol: 'level', initialValue: 0 }] });
    const project = {
        format: 'konjugate', version: 1, metadata: { units: 'SI' }, nodes: [node(1, 'Source', 2), node(3, 'Target', 4)],
        edges: [{
            id: 5, name: 'Feed', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 3, stateId: 4 }, directionality: 'directed', equation: '\\mathrm{gain}',
            equationModel: { latex: '\\mathrm{gain}', output: { role: 'target', stateId: 4 }, bindings: [{ kind: 'parameter', parameterId: 6, symbol: 'gain' }], mathJson: 'gain' },
            parameters: [{ id: 6, name: 'Gain', symbol: 'gain', value: 1, mode: 'live', control: { minimum: 0, maximum: 10, step: 1 }, sharedParameterId: 7 }],
            appearance: { color: '#888888', offset: 0 }
        }],
        sharedParameters: [{ id: 7, name: 'Shared gain', symbol: 'gain', value: 1, mode: 'live', control: { minimum: 0, maximum: 10, step: 1 } }],
        runConfigurations: [{ id: 8, name: 'Default', globalTimeStep: 0.1, outputInterval: 0.5 }], activeRunConfigurationId: 8
    };
    const content = JSON.stringify(project);
    const config = { name: 'Baseline', targetTime: 10, globalTimeStep: 0.1, outputInterval: 0.5 };
    const baselineRun = await startEngineRun(content, config, engineOptions, { retainResult: true });
    const baselineResult = await baselineRun.completion;
    const baseline = { result: baselineResult, resultPath: baselineRun.resultPath, cleanup: baselineRun.cleanup };
    const scenario = { forkAt: 5, runTime: 10 };
    const { forkTime, child } = await runScenarioBranches({ content, config, scenario, interventions: [{ sharedParameterId: 7, value: 3, at: 0 }], baseline, engineOptions });
    assert.equal(forkTime, 5);
    const finalLevel = (samples) => samples.at(-1).states.find((state) => state.stateId === 4).value;
    assert.ok(Math.abs(finalLevel(baselineResult.samples) - 10) < 1e-6, 'Baseline: gain 1 for 10 days.');
    // Gain 1 for 5 days, then 3 for 5 days: 5 + 15 = 20.
    assert.ok(Math.abs(finalLevel(child.result.samples) - 20) < 0.2, `Scenario level ${finalLevel(child.result.samples)} should be about 20`);
    assert.equal(child.result.samples[0].time, 5, 'The forked run starts at the fork point.');
    await baseline.cleanup?.();
    await child.cleanup?.();
});

test('text is decoded as UTF-8, UTF-16 or, failing that, Windows-1252, and the encoding is reported', () => {
    assert.deepEqual(decodeText(Buffer.from('Crédit,1\n', 'utf8')), { text: 'Crédit,1\n', encoding: 'utf-8' });
    assert.deepEqual(decodeText(Buffer.from([0xEF, 0xBB, 0xBF, 0x41])).encoding, 'utf-8');
    assert.equal(decodeText(Buffer.from([0x43, 0x72, 0xE9, 0x64, 0x69, 0x74])).text, 'Crédit', 'A Windows-1252 é (0xE9) is not valid UTF-8.');
    assert.equal(decodeText(Buffer.from([0x43, 0x72, 0xE9, 0x64, 0x69, 0x74])).encoding, 'windows-1252');
    assert.deepEqual(decodeText(Buffer.from([0xFF, 0xFE, 0x41, 0x00, 0x42, 0x00])), { text: 'AB', encoding: 'utf-16le' });
});

const answer = (status, body = 'ok', headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), arrayBuffer: async () => new TextEncoder().encode(body).buffer });

test('a fetch reaches only the hosts the manifest lists, over https, and follows redirects only within them', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return url.includes('start') ? answer(302, '', { location: '/next' }) : url.includes('away') ? answer(302, '', { location: 'https://evil.example/x' }) : answer(200, 'data'); };
    const hosts = ['data.example.com'];
    assert.equal(new TextDecoder().decode(await fetchAllowed({ url: 'https://data.example.com/file', hosts, fetchImpl })), 'data');
    assert.equal(new TextDecoder().decode(await fetchAllowed({ url: 'https://data.example.com/start', hosts, fetchImpl })), 'data');
    assert.deepEqual(calls.slice(-2), ['https://data.example.com/start', 'https://data.example.com/next']);
    await assert.rejects(() => fetchAllowed({ url: 'https://data.example.com/away', hosts, fetchImpl }), /may not connect to evil\.example/);
    await assert.rejects(() => fetchAllowed({ url: 'https://other.example.com/file', hosts, fetchImpl }), /may not connect to other\.example\.com/);
    await assert.rejects(() => fetchAllowed({ url: 'http://data.example.com/file', hosts, fetchImpl }), /Only https/);
    await assert.rejects(() => fetchAllowed({ url: 'https://user:pw@data.example.com/file', hosts, fetchImpl }), /user name or password/);
    await assert.rejects(() => fetchAllowed({ url: 'not a url', hosts, fetchImpl }), /not a web address/);
});

test('a fetch explains a missing symbol, rate limiting, a network failure and an oversized answer', async () => {
    const hosts = ['data.example.com'];
    const url = 'https://data.example.com/x';
    await assert.rejects(() => fetchAllowed({ url, hosts, fetchImpl: async () => answer(404) }), /404 \(not found: check the symbol\)/);
    await assert.rejects(() => fetchAllowed({ url, hosts, fetchImpl: async () => answer(429) }), /too many requests/);
    await assert.rejects(() => fetchAllowed({ url, hosts, fetchImpl: async () => { throw new Error('offline'); } }), /Could not reach data\.example\.com/);
    await assert.rejects(() => fetchAllowed({ url, hosts, fetchImpl: async () => answer(200, 'x', { 'content-length': String(6 * 1024 * 1024) }) }), /larger than the size limit/);
});

test('a launcher that fetches must list exact host names, and only such a launcher may list them', () => {
    const withNetwork = (mutate) => { const manifest = launcher(); manifest.permissions.push('network.fetch'); manifest.network = { hosts: ['query1.finance.yahoo.com'] }; mutate(manifest); return manifest; };
    assert.equal(validateAddonManifest(withNetwork(() => {})).kind, 'launcher');
    for (const hosts of [undefined, [], ['*.yahoo.com'], ['https://yahoo.com'], ['localhost'], ['a b.com']]) {
        assert.throws(() => validateAddonManifest(withNetwork((manifest) => { manifest.network = hosts === undefined ? undefined : { hosts }; })), /exact host names/);
    }
    assert.throws(() => validateAddonManifest({ ...launcher(), network: { hosts: ['example.com'] } }), /only with the network\.fetch permission/);
});

test('a name for a fetched file cannot carry a path', () => {
    assert.equal(safeFileName('../../etc/passwd'), '.._.._etc_passwd');
    assert.equal(safeFileName('S&P 500'), 'S&P 500');
    assert.equal(safeFileName('  '), '');
});
