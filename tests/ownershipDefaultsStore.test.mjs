/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOwnershipDefaultsStore, ownershipDefaultsFile } from '../src/ownershipDefaultsStore.mjs';

async function withStore(run) {
    const userData = await mkdtemp(join(tmpdir(), 'konjugate-ownership-'));
    try {
        await run(createOwnershipDefaultsStore({ userData }), userData);
    } finally {
        await rm(userData, { recursive: true, force: true });
    }
}

test('there are no defaults until some are set', async () => {
    await withStore(async (store) => assert.deepEqual(await store.get(), {}));
});

test('defaults are kept cleaned and read back', async () => {
    await withStore(async (store) => {
        const kept = await store.set({ owner: ' Acme ', copyright: 'Copyright © {year} Acme', license: { id: 'MIT' }, contact: '', revision: '3', lastSavedAt: '2026-01-01T00:00:00Z' });
        assert.deepEqual(kept, { owner: 'Acme', copyright: 'Copyright © {year} Acme', license: { id: 'MIT' } });
        assert.deepEqual(await store.get(), kept);
    });
});

test('setting nothing removes the file', async () => {
    await withStore(async (store, userData) => {
        await store.set({ owner: 'Acme' });
        await store.set({});
        assert.deepEqual(await store.get(), {});
        await assert.rejects(readFile(ownershipDefaultsFile(userData)));
    });
});

test('a file that is not what was written reads as no defaults', async () => {
    await withStore(async (store, userData) => {
        await writeFile(ownershipDefaultsFile(userData), 'not json');
        assert.deepEqual(await store.get(), {});
        await writeFile(ownershipDefaultsFile(userData), JSON.stringify({ defaults: ['owner'] }));
        assert.deepEqual(await store.get(), {});
    });
});
