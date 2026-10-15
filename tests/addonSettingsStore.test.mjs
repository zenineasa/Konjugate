/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAddonSettingsStore, maximumAddonSettingsBytes } from '../src/addonSettingsStore.mjs';

async function withStore(task) {
    const userData = await mkdtemp(join(tmpdir(), 'konjugate-addon-settings-'));
    try {
        await task(createAddonSettingsStore({ userData }), userData);
    } finally {
        await rm(userData, { recursive: true, force: true });
    }
}

test('an add-on has no settings until it keeps some, and they last across a fresh store', () => withStore(async (store, userData) => {
    assert.equal(await store.get('konjugate.poseVisualizer'), null);
    await store.set('konjugate.poseVisualizer', { profiles: [{ name: 'Planar' }] });
    assert.deepEqual(await createAddonSettingsStore({ userData }).get('konjugate.poseVisualizer'), { profiles: [{ name: 'Planar' }] });
    // One add-on's settings are not another's.
    assert.equal(await store.get('konjugate.resultsAnalysis'), null);
}));

test('null removes an add-on\'s settings, and so does remove', () => withStore(async (store, userData) => {
    await store.set('example.one', { a: 1 });
    await store.set('example.one', null);
    assert.equal(await store.get('example.one'), null);
    await store.set('example.two', { b: 2 });
    await store.remove('example.two');
    assert.deepEqual(await readdir(join(userData, 'addonSettings')), []);
}));

test('settings larger than the limit are refused and the old ones kept', () => withStore(async (store) => {
    await store.set('example.one', { a: 1 });
    await assert.rejects(store.set('example.one', 'x'.repeat(maximumAddonSettingsBytes)), /at most 256 KB/);
    assert.deepEqual(await store.get('example.one'), { a: 1 });
}));
