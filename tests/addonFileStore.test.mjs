// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addonFilesDirectory, createFileStore, maximumStoredFileBytes } from '../src/addonFileStore.mjs';

const scratch = () => mkdtemp(join(tmpdir(), 'konjugate-files-'));
const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');
// A server answering from a map of addresses: { status, headers, body (bytes, sent in chunks), text }.
function server(routes) {
    const asked = [];
    const fetchImpl = async (url, options) => {
        asked.push(url);
        const route = routes[url];
        if (!route) return new Response('not here', { status: 404 });
        if (route.redirect) return new Response(null, { status: 302, headers: { location: route.redirect } });
        if (route.text !== undefined) return new Response(route.text, { status: 200 });
        const chunks = [];
        for (let at = 0; at < route.body.length; at += 1000) chunks.push(route.body.subarray(at, at + 1000));
        const stream = new ReadableStream({
            async pull(controller) {
                if (options.signal?.aborted) { controller.error(new Error('aborted')); return; }
                const next = chunks.shift();
                if (next) controller.enqueue(next); else controller.close();
                await new Promise((resolve) => setTimeout(resolve, 1));
            }
        });
        return new Response(stream, { status: 200, headers: { ...(route.length === null ? {} : { 'content-length': String(route.length ?? route.body.length) }), ...(route.encoding ? { 'content-encoding': route.encoding } : {}) } });
    };
    return { fetchImpl, asked };
}

test('a store keeps each add-on\'s files in a folder of its own under the user\'s data', () => {
    assert.equal(addonFilesDirectory('/data', 'konjugate.logistics.toolbox'), join('/data', 'addonFiles', 'konjugate.logistics.toolbox'));
    assert.equal(addonFilesDirectory('/data', '../escape'), join('/data', 'addonFiles', '.._escape'));
    assert.equal(maximumStoredFileBytes, 1024 * 1024 * 1024);
});

test('a file of the user\'s is brought in as a copy, marked as theirs, described, listed, and removed', async () => {
    const directory = join(await scratch(), 'store');
    const store = createFileStore({ directory, now: () => Date.parse('2026-10-15T09:00:00Z') });
    const source = join(await scratch(), 'switzerland-261013.osm.pbf');
    await writeFile(source, Buffer.from('a map of a country'));
    const entry = await store.putCopy({ path: source, details: { region: 'Switzerland' } });
    assert.match(entry.id, /^[0-9a-f]{32}$/);
    assert.deepEqual({ ...entry, id: null }, { id: null, name: 'switzerland-261013.osm.pbf', bytes: 18, storedAt: '2026-10-15T09:00:00.000Z', origin: { kind: 'upload', name: 'switzerland-261013.osm.pbf' }, details: { region: 'Switzerland' } });
    // A copy: the bytes are the store's own, at a path the host reads.
    const kept = await store.get(entry.id);
    assert.equal((await readFile(kept.path)).toString(), 'a map of a country');
    assert.notEqual(kept.path, source);
    // Details added later are merged; too much, or not an object, is refused.
    const described = await store.describe(entry.id, { dataDate: '2026-10-13T20:21:31Z' });
    assert.deepEqual(described.details, { region: 'Switzerland', dataDate: '2026-10-13T20:21:31Z' });
    await assert.rejects(() => store.describe(entry.id, { big: 'x'.repeat(20000) }), /larger than the 16 KB/);
    await assert.rejects(() => store.describe(entry.id, ['a']), /must be an object/);
    await assert.rejects(() => store.describe('nonsense', {}), /No such stored file/);
    assert.deepEqual((await store.list()).map((item) => item.id), [entry.id]);
    assert.equal(await store.usage(), 18);
    await store.remove(entry.id);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get(entry.id), null);
    assert.deepEqual(await readdir(directory), []);
});

test('a download is streamed to disk with its progress, kept with where it came from, and checked against its published sum', async () => {
    const store = createFileStore({ directory: join(await scratch(), 'store'), now: () => Date.parse('2026-10-15T10:00:00Z') });
    const body = Buffer.alloc(5500, 7);
    const { fetchImpl, asked } = server({
        'https://download.geofabrik.de/europe/switzerland-latest.osm.pbf': { redirect: 'https://download.geofabrik.de/europe/switzerland-261013.osm.pbf' },
        'https://download.geofabrik.de/europe/switzerland-261013.osm.pbf': { body },
        'https://download.geofabrik.de/europe/switzerland-latest.osm.pbf.md5': { text: `${md5(body)}  switzerland-latest.osm.pbf\n` }
    });
    const heard = [];
    const entry = await store.download({
        url: 'https://download.geofabrik.de/europe/switzerland-latest.osm.pbf', server: 'Geofabrik', hosts: ['download.geofabrik.de'], fetchImpl,
        checksumUrl: 'https://download.geofabrik.de/europe/switzerland-latest.osm.pbf.md5', onProgress: (progress) => heard.push(progress), details: { region: 'Switzerland' }
    });
    assert.deepEqual({ ...entry, id: null }, { id: null, name: 'switzerland-latest.osm.pbf', bytes: 5500, storedAt: '2026-10-15T10:00:00.000Z', origin: { kind: 'download', url: 'https://download.geofabrik.de/europe/switzerland-latest.osm.pbf', server: 'Geofabrik' }, details: { region: 'Switzerland' } });
    assert.deepEqual(heard.at(-1), { done: 5500, total: 5500 });
    assert.ok(heard.length >= 5 && heard.every((item, index) => index === 0 || item.done > heard[index - 1].done), 'rising, chunk by chunk');
    assert.equal(asked.length, 3, 'the redirect followed, and the sum fetched');
    assert.equal(await store.digest(entry.id), createHash('sha256').update(body).digest('hex'));
});

test('a download that does not match its sum, stops short, is cancelled, or comes from elsewhere is not kept', async () => {
    const directory = join(await scratch(), 'store');
    const store = createFileStore({ directory });
    const body = Buffer.alloc(3000, 1);
    const { fetchImpl } = server({
        'https://download.geofabrik.de/a.osm.pbf': { body },
        'https://download.geofabrik.de/a.osm.pbf.md5': { text: `${'0'.repeat(32)}  a.osm.pbf` },
        'https://download.geofabrik.de/short.osm.pbf': { body, length: 4000 },
        'https://download.geofabrik.de/away': { redirect: 'https://elsewhere.example/a.osm.pbf' },
        'https://download.geofabrik.de/huge.osm.pbf': { body, length: 2 * maximumStoredFileBytes }
    });
    const hosts = ['download.geofabrik.de'];
    await assert.rejects(() => store.download({ url: 'https://download.geofabrik.de/a.osm.pbf', hosts, fetchImpl, checksumUrl: 'https://download.geofabrik.de/a.osm.pbf.md5' }), /does not match the checksum published beside it/);
    await assert.rejects(() => store.download({ url: 'https://download.geofabrik.de/short.osm.pbf', hosts, fetchImpl }), /stopped at 3000 of 4000 bytes/);
    await assert.rejects(() => store.download({ url: 'https://download.geofabrik.de/away', hosts, fetchImpl }), /may not download from elsewhere\.example/);
    await assert.rejects(() => store.download({ url: 'http://download.geofabrik.de/a.osm.pbf', hosts, fetchImpl }), /Only https/);
    await assert.rejects(() => store.download({ url: 'https://download.geofabrik.de/huge.osm.pbf', hosts, fetchImpl }), /larger than the 1024 MB/);
    await assert.rejects(() => store.download({ url: 'https://download.geofabrik.de/missing.osm.pbf', hosts, fetchImpl }), /answered 404/);
    const cancel = new AbortController();
    const cancelled = store.download({ url: 'https://download.geofabrik.de/a.osm.pbf', hosts, fetchImpl, signal: cancel.signal, onProgress: () => cancel.abort() });
    await assert.rejects(() => cancelled, /cancelled/);
    // Nothing half-written is left behind.
    assert.deepEqual(await store.list(), []);
    assert.deepEqual((await readdir(directory).catch(() => [])).filter((name) => !name.endsWith('.json')), []);
});

test('how large a file is, asked of its server before downloading it, through redirects, at a declared host only', async () => {
    const store = createFileStore({ directory: join(await scratch(), 'store') });
    const asked = [];
    const fetchImpl = async (url, options) => {
        asked.push([options.method, url]);
        if (url.endsWith('latest.osm.pbf')) return new Response(null, { status: 302, headers: { location: 'https://download.geofabrik.de/europe/switzerland-261013.osm.pbf' } });
        if (url.endsWith('261013.osm.pbf')) return new Response(null, { status: 200, headers: { 'content-length': '548389794' } });
        if (url.endsWith('quiet.osm.pbf')) return new Response(null, { status: 200 });
        return new Response(null, { status: 404 });
    };
    const hosts = ['download.geofabrik.de'];
    assert.equal(await store.size({ url: 'https://download.geofabrik.de/europe/switzerland-latest.osm.pbf', hosts, fetchImpl }), 548389794);
    assert.deepEqual(asked.map(([method]) => method), ['HEAD', 'HEAD'], 'asked, not downloaded');
    assert.equal(await store.size({ url: 'https://download.geofabrik.de/quiet.osm.pbf', hosts, fetchImpl }), null, 'a server that does not say');
    await assert.rejects(() => store.size({ url: 'https://download.geofabrik.de/missing.osm.pbf', hosts, fetchImpl }), /answered 404/);
    await assert.rejects(() => store.size({ url: 'https://elsewhere.example/a.osm.pbf', hosts, fetchImpl }), /may not download from elsewhere\.example/);
});

test('a file sent compressed is kept whole: its content-length counts it compressed, so it is not held to that', async () => {
    const store = createFileStore({ directory: await mkdtemp(join(tmpdir(), 'konjugate-files-')) });
    const body = new TextEncoder().encode('<mujoco model="scene">'.repeat(15));
    // As GitHub answers raw text: gzip, with the compressed length, while fetch hands over the body unpacked.
    const { fetchImpl } = server({ 'https://raw.githubusercontent.com/scene.xml': { body, length: 262, encoding: 'gzip' } });
    const progress = [];
    const entry = await store.download({ url: 'https://raw.githubusercontent.com/scene.xml', hosts: ['raw.githubusercontent.com'], fetchImpl, onProgress: (step) => progress.push(step) });
    assert.equal(entry.bytes, body.length);
    assert.ok(progress.every(({ total }) => total === null), 'The compressed length is not shown as the total.');
    // And how large it is, asked first, is not known either.
    const head = async () => new Response(null, { status: 200, headers: { 'content-length': '262', 'content-encoding': 'gzip' } });
    assert.equal(await store.size({ url: 'https://raw.githubusercontent.com/scene.xml', hosts: ['raw.githubusercontent.com'], fetchImpl: head }), null);
});
