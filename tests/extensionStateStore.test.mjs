/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createExtensionStateStore } from '../src/extensionStateStore.mjs';

async function withStore(defaultDisabled, task) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-extension-state-'));
    try {
        await task(createExtensionStateStore({ directory, defaultDisabled }), directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('defaults to an empty disabled list with no defaultDisabled passed', () => withStore(undefined, async (store) => {
    assert.deepEqual(await store.list(), []);
}));

test('seeds defaultDisabled only on first creation', () => withStore(['addon:example.helloWorld:0.1.0'], async (store, directory) => {
    assert.deepEqual(await store.list(), ['addon:example.helloWorld:0.1.0']);

    const reopened = createExtensionStateStore({ directory, defaultDisabled: ['plugin:some.other:1.0.0'] });
    assert.deepEqual(await reopened.list(), ['addon:example.helloWorld:0.1.0']);
}));

test('setEnabled(key, false) persists across a fresh store instance', () => withStore([], async (store, directory) => {
    await store.setEnabled('addon:example.helloWorld:0.1.0', false);

    const reopened = createExtensionStateStore({ directory });
    assert.deepEqual(await reopened.list(), ['addon:example.helloWorld:0.1.0']);
}));

test('setEnabled(key, true) removes a previously-disabled key', () => withStore(['addon:example.helloWorld:0.1.0'], async (store) => {
    await store.setEnabled('addon:example.helloWorld:0.1.0', true);
    assert.deepEqual(await store.list(), []);
}));

test('toggling one key does not disturb others already in the set', () => withStore(
    ['addon:example.helloWorld:0.1.0', 'plugin:example.helloProvider:0.1.0'],
    async (store) => {
        await store.setEnabled('addon:example.helloWorld:0.1.0', true);
        assert.deepEqual(await store.list(), ['plugin:example.helloProvider:0.1.0']);
    }
));
