/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The web edition's one-shot engine operations (src/webEngineAdapter.mjs) against a stand-in for the WebAssembly engine module
// (tests/fixtures/fakeWebEngine.mjs): what each operation writes into the module's filesystem, the arguments it calls main() with,
// which exit codes it accepts, what it reads back, and that it leaves nothing behind. That the real WebAssembly engine answers
// these the same way the desktop engine does is checked in a real browser by the web interaction suite.
//
// The adapter keeps one module for the page, so these tests run in order: the first checks that a failed start is not kept.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeProjectContent } from '../src/browserProjectCodec.mjs';
import {
    checkProgramWithWebEngine, checkSubstepConvergenceWithWebEngine, ensureCppProvidersReady, ensurePythonProvidersReady, fitWithWebEngine, getWebEngineCapabilities,
    inferWithWebEngine, runWithWebEngine, validateWithWebEngine
} from '../src/webEngineAdapter.mjs';
import { encodeMessage, resultFile } from './fixtures/engineMessages.mjs';

const engineModuleUrl = pathToFileURL(join(import.meta.dirname, 'fixtures', 'fakeWebEngine.mjs')).href;
const content = JSON.stringify({ format: 'konjugate', version: 1, nodes: [{ id: 1, name: 'Tank', states: [{ id: 2, name: 'T', symbol: 'T', initialValue: 20 }] }], edges: [] });
const engine = globalThis.fakeWebEngine = { callMain: () => 0, failStarts: 0 };

// What the engine was last called with, and the files it found, read as the call was made.
let seen = null;
function answer(handler) {
    engine.callMain = (Module, argv) => {
        const files = Object.fromEntries([...Module.FS.files].map(([path, bytes]) => [path, bytes]));
        seen = { argv, files, Module };
        return handler(Module, argv) ?? 0;
    };
}
const scratchDirectories = () => [...engine.modules.at(-1).FS.directories].filter((path) => path.startsWith('/scratch-'));
const text = (bytes) => new TextDecoder().decode(bytes);

test('a start that fails is not kept, so the next call starts the module again', async () => {
    engine.failStarts = 1;
    answer((Module) => { Module.options.print('{"version":"1.0"}'); });
    await assert.rejects(getWebEngineCapabilities(engineModuleUrl), /section was shorter than expected size/);
    assert.deepEqual(await getWebEngineCapabilities(engineModuleUrl), { available: true, capabilities: { version: '1.0' } });
    assert.equal(engine.starts, 2);
});

test('capabilities are what the module prints, and the module is started once for the page', async () => {
    answer((Module, argv) => { assert.deepEqual(argv, ['capabilities']); Module.options.print('{"metis":'); Module.options.print('false}'); });
    assert.deepEqual(await getWebEngineCapabilities(engineModuleUrl), { available: true, capabilities: { metis: false } });
    assert.equal(engine.starts, 2, 'Not started again.');
    answer(() => 1);
    await assert.rejects(getWebEngineCapabilities(engineModuleUrl), /The engine exited with code 1/);
});

test('validation writes the project as a project file and reads the report back, with invalid models accepted', async () => {
    const report = encodeMessage('ValidationReport', { reportVersion: 1, engineVersion: '9.9', valid: false, issues: [{ code: 'unbound', severity: 'error', message: 'x is unbound.' }] });
    answer((Module, argv) => { Module.FS.writeFile(argv[3], report); return 2; });
    const { available, report: decoded } = await validateWithWebEngine(engineModuleUrl, content);
    assert.equal(available, true);
    assert.equal(decoded.valid, false);
    assert.equal(decoded.issues[0].message, 'x is unbound.');
    const [command, inputPath, flag, reportPath] = seen.argv;
    assert.deepEqual([command, flag], ['validate', '--report']);
    assert.match(inputPath, /^\/scratch-[^/]+\/input\.kjt$/);
    assert.match(reportPath, /^\/scratch-[^/]+\/validation\.bin$/);
    assert.equal((await decodeProjectContent(seen.files[inputPath])).content, content, 'The model goes in as the desktop engine is given it.');
    assert.deepEqual(scratchDirectories(), [], 'Nothing is left behind.');

    answer(() => 3);
    await assert.rejects(validateWithWebEngine(engineModuleUrl, content), /The engine exited with code 3/);
    assert.deepEqual(scratchDirectories(), [], 'Not even after a failure.');
});

test('inference passes only the options that were set, and reads its report back', async () => {
    answer((Module, argv) => { Module.FS.writeFile(argv[3], encodeMessage('InferenceReport', { reportVersion: 1 })); });
    await inferWithWebEngine(engineModuleUrl, 't,x\n0,1\n1,2\n', {});
    assert.deepEqual(seen.argv.slice(4), []);
    assert.equal(text(seen.files[seen.argv[1]]), 't,x\n0,1\n1,2\n');
    const { available } = await inferWithWebEngine(engineModuleUrl, 't,x\n0,1\n', {
        skeletonThreshold: 0.1, coefficientThreshold: 0.2, validationFraction: 0.3, candidateLags: [1, 2], ridgePenalties: [0, 0.5], candidateDegrees: [1, 3], includeInteractionTerms: false
    });
    assert.equal(available, true);
    assert.deepEqual(seen.argv.slice(4), [
        '--skeleton-threshold', '0.1', '--coefficient-threshold', '0.2', '--validation-fraction', '0.3', '--lags', '1,2', '--ridge-penalties', '0,0.5', '--degrees', '1,3', '--include-interaction-terms', 'false'
    ]);
});

test('a fit writes its objective for the engine to read, and a fit that did not converge still answers', async () => {
    answer((Module, argv) => { Module.FS.writeFile(argv[4], encodeMessage('FittingReport', { reportVersion: 1 })); return 1; });
    const objective = { terms: [{ signal: 'T', weight: 2 }] };
    const { available } = await fitWithWebEngine(engineModuleUrl, content, 'time,T\n0,20\n', { objective, maxIterations: 5 });
    assert.equal(available, true);
    const objectivePath = seen.argv[seen.argv.indexOf('--objective-file') + 1];
    assert.deepEqual(JSON.parse(text(seen.files[objectivePath])), objective);
    assert.equal(seen.argv[seen.argv.indexOf('--max-iterations') + 1], '5');
    assert.equal(text(seen.files[seen.argv[2]]), 'time,T\n0,20\n');

    await fitWithWebEngine(engineModuleUrl, content, null, {});
    assert.ok(!seen.argv.includes('--objective-file'));
    assert.ok(!Object.keys(seen.files).some((path) => path.endsWith('objective.json')), 'No objective, no file.');
    assert.equal(text(seen.files[seen.argv[2]]), '', 'No measurements is an empty table.');
    answer(() => 2);
    await assert.rejects(fitWithWebEngine(engineModuleUrl, content, '', {}), /The engine exited with code 2/);
});

test('a run is given its configuration and its result file is decoded', async () => {
    answer((Module, argv) => { Module.FS.writeFile(argv[5], resultFile({ stateIds: [2], batches: [[0, 1]], values: (time) => [20 + time] })); });
    const configuration = { globalTimeStep: 1, targetTime: 1 };
    const { available, result } = await runWithWebEngine(engineModuleUrl, content, configuration);
    assert.equal(available, true);
    assert.deepEqual(seen.argv.filter((arg) => arg.startsWith('--')), ['--configuration', '--output']);
    assert.deepEqual(JSON.parse(text(seen.files[seen.argv[3]])), configuration);
    assert.deepEqual(result.samples.map((sample) => sample.states[0].value), [20, 21]);
    assert.deepEqual(scratchDirectories(), []);
});

test('providers are made ready only for a model that has them', async () => {
    const Module = {};
    for (const document of ['not json', content, JSON.stringify({ nodes: [{ implementation: { kind: 'builtin' } }], edges: [{ implementation: null }] })]) {
        await ensurePythonProvidersReady(Module, document);
        await ensureCppProvidersReady(Module, document);
    }
    assert.deepEqual(Module, {}, 'Neither Pyodide nor a C++ toolchain is loaded, and nothing is installed on the module.');
    assert.deepEqual(await checkSubstepConvergenceWithWebEngine(), { available: false });
});

test('Check program writes the source and the desktop\'s configuration, answers the engine\'s JSON, and says why when it stops', async () => {
    const report = { ok: true, program: 'Heater', kind: 'node', inputs: [], problems: [], outputs: { power: 1.5 }, memory: {} };
    answer((Module, argv) => { Module.FS.writeFile(argv[5], JSON.stringify(report)); });
    assert.deepEqual(await checkProgramWithWebEngine(engineModuleUrl, { kind: 'cpp', source: 'struct Heater {};', inputs: { kp: 2 }, time: 0.5 }),
        { available: true, ...report });
    const [command, sourcePath, ...flags] = seen.argv;
    assert.equal(command, 'checkProgram');
    assert.match(sourcePath, /program\.cpp$/);
    assert.equal(text(seen.files[sourcePath]), 'struct Heater {};');
    assert.deepEqual(flags.filter((arg) => arg.startsWith('--')), ['--configuration', '--report']);
    assert.deepEqual(JSON.parse(text(seen.files[flags[1]])), { kind: 'cpp', inputs: { kp: 2 }, time: 0.5 });
    answer((Module) => { Module.options.printErr('Something went wrong.'); return 1; });
    assert.deepEqual(await checkProgramWithWebEngine(engineModuleUrl, { kind: 'cpp', source: '' }),
        { available: true, ok: false, problems: ['Something went wrong.'] });
    answer(() => 3);
    assert.deepEqual((await checkProgramWithWebEngine(engineModuleUrl, { kind: 'cpp', source: '' })).problems, ['The engine exited with code 3.']);
    assert.deepEqual(scratchDirectories(), []);
});

