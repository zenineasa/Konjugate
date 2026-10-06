/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addonCacheDirectory, createAddonCache, exists } from '../src/addonCache.mjs';

const scratch = async () => mkdtemp(join(tmpdir(), 'konjugate-addon-cache-'));
const day = 86400000;

test("an add-on's cache lives in its own folder under the user's data", () => {
    assert.equal(addonCacheDirectory('/data', 'konjugate.logistics.toolbox'), join('/data', 'addonCache', 'konjugate.logistics.toolbox'));
    assert.equal(addonCacheDirectory('/data', '../evil/../id'), join('/data', 'addonCache', '.._evil_.._id'));
});

test('bytes kept are answered with when they were really fetched, until they are too old', async () => {
    const directory = await scratch();
    let clock = Date.parse('2026-10-01T10:00:00Z');
    const cache = createAddonCache({ directory: join(directory, 'cache'), now: () => clock });
    assert.equal(await cache.get('https://example.org/a'), null);
    await cache.put('https://example.org/a', Buffer.from('roads'));
    clock += 3 * day;
    const hit = await cache.get('https://example.org/a');
    assert.equal(hit.bytes.toString(), 'roads');
    assert.equal(hit.retrievedAt, '2026-10-01T10:00:00.000Z', 'the date it was fetched, not the date it was read');
    assert.equal(await cache.get('https://example.org/a', { maximumAgeDays: 2 }), null, 'older than asked for');
    clock += 40 * day;
    assert.equal(await cache.get('https://example.org/a'), null, 'older than a month by default');
    assert.equal(await cache.get('https://example.org/b'), null);
    await rm(directory, { recursive: true, force: true });
});

test('a file changed on disk is not used', async () => {
    const directory = await scratch();
    const cache = createAddonCache({ directory });
    await cache.put('https://example.org/a', Buffer.from('roads'));
    const data = (await readdir(directory)).find((name) => name.endsWith('.data'));
    await writeFile(join(directory, data), 'tampered');
    assert.equal(await cache.get('https://example.org/a'), null);
    assert.equal((await cache.info()).entries, 0, 'and it is dropped');
    await rm(directory, { recursive: true, force: true });
});

test('past its size, the cache drops what was used longest ago', async () => {
    const directory = await scratch();
    let clock = 0;
    const cache = createAddonCache({ directory, maximumBytes: 25, now: () => (clock += 1000) });
    await cache.put('u1', Buffer.alloc(10));
    await cache.put('u2', Buffer.alloc(10));
    await cache.get('u1');
    await cache.put('u3', Buffer.alloc(10));
    assert.ok(await cache.get('u1'), 'used recently: kept');
    assert.equal(await cache.get('u2'), null, 'used longest ago: dropped');
    assert.ok(await cache.get('u3'));
    assert.equal((await cache.info()).bytes, 20);
    await rm(directory, { recursive: true, force: true });
});

test('the cache says how much it holds, and clears', async () => {
    const directory = await scratch();
    let clock = Date.parse('2026-10-01T00:00:00Z');
    const cache = createAddonCache({ directory: join(directory, 'cache'), now: () => clock });
    assert.deepEqual(await cache.info(), { entries: 0, bytes: 0, oldest: null, newest: null });
    await cache.put('u1', Buffer.alloc(100));
    clock += day;
    await cache.put('u2', Buffer.alloc(50));
    assert.deepEqual(await cache.info(), { entries: 2, bytes: 150, oldest: '2026-10-01T00:00:00.000Z', newest: '2026-10-02T00:00:00.000Z' });
    await cache.clear();
    assert.equal(await exists(join(directory, 'cache')), false);
    assert.equal((await cache.info()).entries, 0);
    await rm(directory, { recursive: true, force: true });
});
