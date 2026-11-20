/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The web edition's Python providers (src/webPythonProviderBridge.mjs), on a real Pyodide: the one in node_modules, with the
// provider SDK from engine/sdk/python, in place of the copies the web shell serves beside the module. Requests are sent as the
// engine's WasmPyodideProviderBackend (engine/src/providerRuntime.cpp) writes them, with every number quoted, as Boost's JSON writer
// does; the providers are the examples in examples/providers.
//
// The bridge keeps one Pyodide for the page, so these tests run in order: the first checks that a failed load is not kept.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installPythonProviderBridge, runPythonSyntaxCheck, setPythonProviderSources } from '../src/webPythonProviderBridge.mjs';

const root = join(import.meta.dirname, '..');
const pyodideDirectory = join(root, 'node_modules', 'pyodide');
let failReads = 0;
setPythonProviderSources({
    importPyodide: () => import(pathToFileURL(join(pyodideDirectory, 'pyodide.mjs')).href),
    indexURL: `${pyodideDirectory}/`,
    async readSdkFile(fileName) {
        if (failReads > 0) {
            failReads -= 1;
            throw new Error(`Could not fetch the Python provider SDK file '${fileName}'.`);
        }
        return readFile(join(root, 'engine', 'sdk', 'python', 'konjugate', fileName), 'utf8');
    }
});
const example = (name) => readFile(join(root, 'examples', 'providers', name), 'utf8');

test('a load that fails is not kept, and the sources cannot be changed once Pyodide is loaded', async () => {
    failReads = 1;
    await assert.rejects(runPythonSyntaxCheck('x = 1'), /Could not fetch the Python provider SDK file '__init__.py'/);
    assert.deepEqual(await runPythonSyntaxCheck('x = 1'), { valid: true, diagnostics: [] }, 'The next use loads it again.');
    assert.throws(() => setPythonProviderSources({}), /already loaded/);
});

test('the provider editor\'s syntax check says where the first error is', async () => {
    assert.deepEqual(await runPythonSyntaxCheck('def evaluate(self):\n    return 1\n'), { valid: true, diagnostics: [] });
    const { valid, diagnostics: [diagnostic] } = await runPythonSyntaxCheck('x = 1\ndef broken(:\n    pass\n');
    assert.equal(valid, false);
    assert.equal(diagnostic.line, 2);
    assert.equal(diagnostic.severity, 'error');
    assert.ok(diagnostic.column >= 1);
    assert.match(diagnostic.message, /syntax/i);
    assert.deepEqual(await runPythonSyntaxCheck('source = 1'), { valid: true, diagnostics: [] }, 'A source naming the checker\'s own variable is still just checked.');
});

// A Module with the bridge installed, and a function that sends it a request as the engine does, answering the parsed reply.
async function bridged() {
    const Module = {};
    await installPythonProviderBridge(Module);
    return (request) => JSON.parse(Module.evaluatePythonProviderBridge(typeof request === 'string' ? request : JSON.stringify(request)));
}

test('a relationship provider is created from its source, initialized, evaluated and shut down', async () => {
    const send = await bridged();
    assert.deepEqual(send({ kind: 'create', processKey: 'hello', source: await example('helloWorld.py') }), { ok: true });
    assert.deepEqual(send({ kind: 'initialize', processKey: 'hello', instances: [{ instanceId: '1', inputKeys: ['input'] }, { instanceId: '2', inputKeys: ['input'] }] }),
        { ok: true, initializedIds: [1, 2] });
    assert.deepEqual(send({ kind: 'evaluateBatch', processKey: 'hello', sequence: '1', simulationTime: '0', stepSize: '0.1', evaluations: [{ instanceId: '1', inputs: ['3'] }, { instanceId: '2', inputs: ['-0.5'] }] }),
        { ok: true, contributions: [{ instanceId: 1, value: 6 }, { instanceId: 2, value: -1 }] });
    assert.deepEqual(send({ kind: 'shutdown', processKey: 'hello' }), { ok: true });
    assert.deepEqual(send({ kind: 'evaluateBatch', processKey: 'hello', sequence: '2', simulationTime: '0', stepSize: '0.1', evaluations: [] }),
        { ok: false, code: 'bridgeFailure', message: 'No Python provider bridge for \'hello\'.', fatal: true }, 'Shut down, it is gone.');
});

test('a node provider keeps its own state, which is checkpointed and restored', async () => {
    const send = await bridged();
    send({ kind: 'create', processKey: 'accumulator', source: await example('accumulatorNode.py') });
    send({ kind: 'initialize', processKey: 'accumulator', instances: [{ instanceId: '7', inputKeys: ['input'] }] });
    const evaluate = (input) => send({ kind: 'evaluateNode', processKey: 'accumulator', sequence: '0', simulationTime: '0', stepSize: '0.5', evaluations: [{ instanceId: '7', inputs: [String(input)] }] });
    assert.deepEqual(evaluate(2), { ok: true, contributions: [{ instanceId: 7, outputs: { output: 1 } }] });
    const { ok, payloadBase64 } = send({ kind: 'checkpoint', processKey: 'accumulator', instanceId: '7' });
    assert.equal(ok, true);
    assert.equal(Buffer.from(payloadBase64, 'base64').readDoubleBE(0), 1, 'Its running total, as the provider packs it.');
    assert.deepEqual(evaluate(2), { ok: true, contributions: [{ instanceId: 7, outputs: { output: 2 } }] });
    assert.deepEqual(send({ kind: 'restore', processKey: 'accumulator', instanceId: '7', payloadBase64 }), { ok: true });
    assert.deepEqual(evaluate(4), { ok: true, contributions: [{ instanceId: 7, outputs: { output: 3 } }] }, 'From the restored total, not the later one.');
    assert.deepEqual(send({ kind: 'restore', processKey: 'accumulator', instanceId: '7', payloadBase64: '' }),
        { ok: false, code: 'workerFailure', message: 'Accumulator checkpoint must contain one float.', fatal: true }, 'The provider\'s own refusal comes back.');
});

test('several providers live side by side, each under its own key', async () => {
    const send = await bridged();
    send({ kind: 'create', processKey: 'a', source: await example('helloWorld.py') });
    send({ kind: 'create', processKey: 'b', source: (await example('helloWorld.py')).replace('2.0 * inputs', '10.0 * inputs') });
    for (const key of ['a', 'b']) send({ kind: 'initialize', processKey: key, instances: [{ instanceId: '1', inputKeys: ['input'] }] });
    const value = (key) => send({ kind: 'evaluateBatch', processKey: key, sequence: '1', simulationTime: '0', stepSize: '1', evaluations: [{ instanceId: '1', inputs: ['1'] }] }).contributions[0].value;
    assert.deepEqual([value('a'), value('b')], [2, 10]);
});

test('a request the provider cannot take comes back as a failure the engine can report, never as an exception', async () => {
    const send = await bridged();
    send({ kind: 'create', processKey: 'hello', source: await example('helloWorld.py') });
    assert.deepEqual(send({ kind: 'evaluateBatch', processKey: 'hello', sequence: '1', simulationTime: '0', stepSize: '1', evaluations: [] }),
        { ok: false, code: 'notInitialized', message: 'Evaluation received before initialization.', fatal: true });
    assert.equal(send({ kind: 'initialize', processKey: 'hello', instances: [{ instanceId: '1', inputKeys: ['nope'] }] }).code, 'unknownInputKey');
    assert.match(send({ kind: 'teleport', processKey: 'hello' }).message, /Unknown web provider bridge request kind: teleport/);
    assert.equal(send('{ not json').code, 'bridgeFailure');
    const noProvider = send({ kind: 'create', processKey: 'empty', source: 'x = 1\n' });
    assert.equal(noProvider.ok, false);
    assert.equal(noProvider.code, 'bridgeFailure');
    const broken = send({ kind: 'create', processKey: 'broken', source: 'def (:\n' });
    assert.equal(broken.ok, false, 'A source that does not even parse.');
});
