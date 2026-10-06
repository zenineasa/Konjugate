/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createUpdateSkipStore } from '../src/updateSkipStore.mjs';

async function withDirectory(run) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateSkip-'));
    try {
        await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('nothing is skipped until something is, and what is skipped survives a restart', async () => {
    await withDirectory(async (directory) => {
        assert.equal(await createUpdateSkipStore({ directory }).get(), null);
        await createUpdateSkipStore({ directory }).set('1.2.0');
        // A different store object over the same directory, as after an app restart.
        assert.equal(await createUpdateSkipStore({ directory }).get(), '1.2.0');
    });
});

test('skipping another version replaces the first, and null clears it', async () => {
    await withDirectory(async (directory) => {
        const store = createUpdateSkipStore({ directory });
        await store.set('1.2.0');
        await store.set('1.3.0');
        assert.equal(await store.get(), '1.3.0');
        await store.set(null);
        assert.equal(await store.get(), null);
    });
});

test('the directory is created when it does not exist yet', async () => {
    await withDirectory(async (directory) => {
        const store = createUpdateSkipStore({ directory: join(directory, 'not', 'there', 'yet') });
        await store.set('1.2.0');
        assert.equal(await store.get(), '1.2.0');
    });
});

test('a missing, corrupt or wrong-shaped file means nothing is skipped, never an error', async () => {
    await withDirectory(async (directory) => {
        const store = createUpdateSkipStore({ directory });
        const path = join(directory, 'updateSkipped.json');
        for (const content of ['', 'not json', '[]', 'null', '{}', '{"version":2,"skippedVersion":"1.2.0"}', '{"version":1,"skippedVersion":42}', '{"version":1,"skippedVersion":""}']) {
            await writeFile(path, content);
            assert.equal(await store.get(), null, JSON.stringify(content));
        }
    });
});

test('only a non-empty string or null can be stored', async () => {
    await withDirectory(async (directory) => {
        const store = createUpdateSkipStore({ directory });
        for (const bad of [undefined, 42, '', {}, ['1.2.0']]) await assert.rejects(() => store.set(bad), /non-empty string/, String(bad));
        assert.equal(await store.get(), null);
    });
});

test('the file is written whole and no temporary files are left behind', async () => {
    await withDirectory(async (directory) => {
        const store = createUpdateSkipStore({ directory, uuidFactory: () => 'fixed' });
        await store.set('1.2.0');
        assert.deepEqual(await readdir(directory), ['updateSkipped.json']);
        assert.deepEqual(JSON.parse(await readFile(join(directory, 'updateSkipped.json'), 'utf8')), { version: 1, skippedVersion: '1.2.0' });
    });
});

test('a directory is required', () => {
    assert.throws(() => createUpdateSkipStore(), /requires a directory/);
});
