/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createWebFileCache } from '../src/webFileCache.mjs';
import { createMemoryVolume } from '../src/webVolume.mjs';

const sha256Hex = async (input) => createHash('sha256').update(input).digest('hex');
const bytes = (text) => new TextEncoder().encode(text);

test('what was fetched is kept with when, answered while young enough, and a changed entry is dropped', async () => {
    let clock = Date.parse('2026-11-01T00:00:00Z');
    const volume = createMemoryVolume();
    const cache = createWebFileCache({ volume, sha256Hex, now: () => clock });
    assert.equal(await cache.get('https://a.example.com/x'), null);
    const { retrievedAt } = await cache.put('https://a.example.com/x', bytes('hello'));
    const hit = await cache.get('https://a.example.com/x');
    assert.deepEqual([new TextDecoder().decode(hit.bytes), hit.retrievedAt], ['hello', retrievedAt]);
    assert.deepEqual(await cache.info(), { entries: 1, bytes: 5, oldest: retrievedAt, newest: retrievedAt });
    clock += 31 * 86400000;
    assert.equal(await cache.get('https://a.example.com/x'), null, 'older than 30 days by default');
    assert.notEqual(await cache.get('https://a.example.com/x', { maximumAgeDays: 40 }), null);
    for (const name of volume.files.keys()) if (name.endsWith('.data')) volume.files.set(name, bytes('tampered'));
    assert.equal(await cache.get('https://a.example.com/x', { maximumAgeDays: 40 }), null, 'bytes that are not what was kept are not used');
    assert.deepEqual(await cache.info(), { entries: 0, bytes: 0, oldest: null, newest: null });
});

test('past its size the entries used longest ago go first, and clearing removes all', async () => {
    let clock = Date.parse('2026-11-01T00:00:00Z');
    const cache = createWebFileCache({ volume: createMemoryVolume(), sha256Hex, maximumBytes: 10, now: () => (clock += 1000) });
    await cache.put('https://a.example.com/1', bytes('aaaa'));
    await cache.put('https://a.example.com/2', bytes('bbbb'));
    await cache.get('https://a.example.com/1');
    await cache.put('https://a.example.com/3', bytes('cccc'));
    assert.notEqual(await cache.get('https://a.example.com/1'), null);
    assert.equal(await cache.get('https://a.example.com/2'), null, 'the one used longest ago went');
    assert.notEqual(await cache.get('https://a.example.com/3'), null);
    await cache.clear();
    assert.equal((await cache.info()).entries, 0);
});
