/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProviderToolchainStore, providerExecutionModes } from '../src/providerToolchainStore.mjs';

async function withStore(task) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-toolchains-'));
    try {
        await task(createProviderToolchainStore({ directory }), directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('defaults executionMode to automatic (empty string)', () => withStore(async (store) => {
    const state = await store.get();
    assert.equal(state.executionMode, '');
    assert.deepEqual(providerExecutionModes, ['', 'pipeWorker', 'sharedMemoryWorker', 'inProcess']);
}));

test('persists a chosen execution mode across a fresh store instance', () => withStore(async (store, directory) => {
    const saved = await store.set('executionMode', 'inProcess');
    assert.equal(saved.executionMode, 'inProcess');

    const reopened = await createProviderToolchainStore({ directory }).get();
    assert.equal(reopened.executionMode, 'inProcess');
}));

test('rejects an unsupported execution mode without persisting it', () => withStore(async (store) => {
    await assert.rejects(() => store.set('executionMode', 'bogusMode'));
    assert.equal((await store.get()).executionMode, '');
}));

test('an existing toolchains.json predating executionMode keeps its saved paths and defaults the new field', () => withStore(async (store, directory) => {
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, 'toolchains.json'),
        JSON.stringify({ version: 1, cpp: { compilerPath: '/usr/bin/clang++' }, python: { interpreterPath: '/usr/bin/python3' } })
    );

    const state = await store.get();
    assert.equal(state.cpp.compilerPath, '/usr/bin/clang++');
    assert.equal(state.python.interpreterPath, '/usr/bin/python3');
    assert.equal(state.executionMode, '');
}));

test('setting executionMode does not disturb previously saved compiler/interpreter paths', () => withStore(async (store) => {
    await store.set('cpp', '/usr/bin/clang++');
    await store.set('python', '/usr/bin/python3');
    await store.set('executionMode', 'sharedMemoryWorker');

    const state = await store.get();
    assert.equal(state.cpp.compilerPath, '/usr/bin/clang++');
    assert.equal(state.python.interpreterPath, '/usr/bin/python3');
    assert.equal(state.executionMode, 'sharedMemoryWorker');
}));

test('get() returns independent clones', () => withStore(async (store) => {
    const first = await store.get();
    first.executionMode = 'inProcess';
    const second = await store.get();
    assert.equal(second.executionMode, '');
}));
