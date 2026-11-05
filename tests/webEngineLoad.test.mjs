/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { startEngineModule } from '../src/webEngineLoad.mjs';

const url = 'https://example.test/engine/konjugateEngine.js';

// A page whose engine file arrives short a given number of times before it arrives whole.
function scenario({ expected = 10, shortBy = 0, startFailsFirst = true, sidecar = true } = {}) {
    const calls = { fetches: [], starts: [] };
    let shortLeft = shortBy;
    const fetchFunction = async (address, init) => {
        calls.fetches.push([address.split('/').pop(), init?.cache]);
        if (address.endsWith('.json')) return sidecar ? { ok: true, json: async () => ({ wasmBytes: expected }) } : { ok: false };
        const length = shortLeft-- > 0 ? expected - 3 : expected;
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(length) };
    };
    const importModule = async () => ({
        default: async (options) => {
            calls.starts.push(Boolean(options.wasmBinary));
            if (startFailsFirst && !options.wasmBinary) throw new Error('Aborted(CompileError: section was shorter than expected size)');
            return { started: true };
        }
    });
    return { calls, options: { importModule, fetchFunction } };
}

test('a module that starts normally is not fetched again', async () => {
    const { calls, options } = scenario({ startFailsFirst: false });
    assert.deepEqual(await startEngineModule(url, {}, options), { started: true });
    assert.deepEqual(calls, { fetches: [], starts: [false] });
});

test('a failed start is retried with the file fetched past the cache and checked against its recorded size', async () => {
    const { calls, options } = scenario({ shortBy: 1 });
    assert.deepEqual(await startEngineModule(url, {}, options), { started: true });
    assert.deepEqual(calls.starts, [false, true]);
    assert.deepEqual(calls.fetches.filter(([name]) => name.endsWith('.wasm')), [['konjugateEngine.wasm', 'reload'], ['konjugateEngine.wasm', 'reload']]);
});

test('a file that keeps arriving short is reported with both sizes', async () => {
    const { options } = scenario({ shortBy: 99 });
    await assert.rejects(startEngineModule(url, {}, options), /keeps arriving incomplete \(7 of 10 bytes\)/);
});

test('without a recorded size the original failure is what the caller sees', async () => {
    const { options } = scenario({ sidecar: false });
    await assert.rejects(startEngineModule(url, {}, options), /CompileError/);
});
