/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createWebFileStore } from '../src/webFileStore.mjs';
import { createMemoryVolume } from '../src/webVolume.mjs';

const sha256Hex = async (text) => createHash('sha256').update(text).digest('hex');
const hosts = ['files.example.com'];
const file = (name, bytes) => Object.assign(new Blob([bytes]), { name });

// A server holding `bytes` at one address, as a transport sees it: honours a start-only Range when the validator matches, can cut a body short,
// and can leave out the headers a browser would not be shown.
function server(bytes, { etag = '"v1"', lastModified = 'Mon, 02 Nov 2026 10:00:00 GMT', ranges = true, cutAfter = null, exposeEtag = true, exposeRange = true, redirectTo = null } = {}) {
    const requests = [];
    const transport = {
        requests,
        async stream({ url, headers = {}, method = 'GET', signal }) {
            requests.push({ url, headers, method });
            const final = redirectTo ?? url;
            const answer = (status, body, extra = {}) => {
                const map = new Map(Object.entries({ 'last-modified': lastModified, ...(exposeEtag ? { etag } : {}), ...extra }));
                return { status, url: final, headers: map, cancel: async () => {}, body: body && (async function* () { for (let at = 0; at < body.length; at += 1000) { if (signal?.aborted) return; yield body.subarray(at, Math.min(body.length, at + 1000)); } if (cutAfter !== null && body.length) throw new Error('connection lost'); })() };
            };
            if (method === 'HEAD') return answer(200, null, { 'content-length': String(bytes.length) });
            const wanted = /^bytes=(\d+)-$/.exec(headers.Range ?? '');
            if (wanted && ranges && (headers['If-Range'] === etag || headers['If-Range'] === lastModified)) {
                const start = Number(wanted[1]);
                if (start >= bytes.length) return answer(416, null);
                const body = bytes.subarray(start);
                return answer(206, body, { 'content-length': String(body.length), ...(exposeRange ? { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) });
            }
            if (wanted && headers['If-Range'] && headers['If-Range'] !== etag && headers['If-Range'] !== lastModified) return answer(200, bytes, { 'content-length': String(bytes.length) });
            const body = cutAfter === null ? bytes : bytes.subarray(0, cutAfter);
            return answer(200, body, { 'content-length': String(bytes.length) });
        },
        async fetchText({ url }) { requests.push({ url, text: true }); return transport.sums?.[url] ?? ''; }
    };
    return transport;
}
const storeFor = (transport, volume = createMemoryVolume()) => ({ volume, store: createWebFileStore({ volume, transport, sha256Hex }) });
const bytesOf = async (store, id) => new Uint8Array(await (await store.get(id)).blob.arrayBuffer());

test('a file the person chooses is kept as a copy, listed, described, read back and removed', async () => {
    const { store, volume } = storeFor(server(new Uint8Array(0)));
    const original = randomBytes(5000);
    const entry = await store.putFile({ file: file('my map.osm.pbf', original), details: { area: 'Lyon' } });
    assert.deepEqual([entry.name, entry.bytes, entry.origin, entry.details], ['my map.osm.pbf', 5000, { kind: 'upload', name: 'my map.osm.pbf' }, { area: 'Lyon' }]);
    assert.match(entry.id, /^[0-9a-f]{32}$/);
    assert.deepEqual([...await bytesOf(store, entry.id)], [...original]);
    assert.deepEqual((await store.list()).map((item) => item.id), [entry.id]);
    assert.equal(await store.usage(), 5000);
    const described = await store.describe(entry.id, { age: 3 });
    assert.deepEqual(described.details, { area: 'Lyon', age: 3 });
    await assert.rejects(store.describe('nope', {}), /No such stored file/);
    await assert.rejects(store.describe(entry.id, 'text'), /must be an object/);
    await assert.rejects(store.describe(entry.id, { big: 'x'.repeat(17000) }), /16 KB/);
    assert.equal(await store.get('../etc'), null);
    await store.remove(entry.id);
    assert.deepEqual([await store.list(), await store.get(entry.id), [...volume.files.keys()]], [[], null, []]);
});

test('a download is kept whole, with its progress and where it came from, and checked against the sum published beside it', async () => {
    const original = randomBytes(5500);
    const transport = server(original);
    const sum = createHash('md5').update(original).digest('hex');
    transport.sums = { 'https://files.example.com/m.md5': `${sum}  m.osm.pbf\n`, 'https://files.example.com/bad.md5': `${'0'.repeat(32)}  m\n`, 'https://files.example.com/none.md5': 'oops' };
    const { store, volume } = storeFor(transport);
    const progress = [];
    const entry = await store.download({ url: 'https://files.example.com/a/m.osm.pbf', hosts, server: 'Example Files', checksumUrl: 'https://files.example.com/m.md5', onProgress: (item) => progress.push(item), details: { area: 'x' } });
    assert.deepEqual([entry.name, entry.bytes, entry.origin, entry.details], ['m.osm.pbf', 5500, { kind: 'download', url: 'https://files.example.com/a/m.osm.pbf', server: 'Example Files' }, { area: 'x' }]);
    assert.deepEqual(progress.at(-1), { done: 5500, total: 5500, resumedFrom: 0 });
    assert.deepEqual([...await bytesOf(store, entry.id)], [...original]);
    assert.deepEqual([...volume.files.keys()].filter((name) => name.endsWith('.part') || name.endsWith('.partial')), [], 'Nothing unfinished is left.');
    await assert.rejects(store.download({ url: 'https://files.example.com/b', hosts, checksumUrl: 'https://files.example.com/bad.md5' }), /does not match the checksum/);
    await assert.rejects(store.download({ url: 'https://files.example.com/c', hosts, checksumUrl: 'https://files.example.com/none.md5' }), /could not be read/);
    assert.equal((await store.list()).length, 1, 'A file that fails its sum is not kept.');
    // a sum that cannot be read leaves the whole download in place, as on the desktop, to be tried again
    assert.deepEqual((await store.partials()).map((item) => [item.name, item.bytes]), [['c', 5500]]);
});

test('a download keeps to the declared hosts, https, the size limit, one at a time, and can be cancelled', async () => {
    const transport = server(randomBytes(3000));
    const { store } = storeFor(transport);
    for (const url of ['http://files.example.com/a', 'https://evil.example.com/a', 'https://u:p@files.example.com/a', 'nonsense']) await assert.rejects(store.download({ url, hosts }), url);
    assert.equal(transport.requests.length, 0, 'Nothing refused reached the network.');
    const huge = server(new Uint8Array(10));
    const original = huge.stream;
    huge.stream = async (request) => { const answer = await original(request); answer.headers.set('content-length', String(2 * 1024 * 1024 * 1024)); return answer; };
    await assert.rejects(storeFor(huge).store.download({ url: 'https://files.example.com/huge', hosts }), /larger than the 1024 MB/);
    const { store: slow } = storeFor(server(randomBytes(30000)));
    const first = slow.download({ url: 'https://files.example.com/same', hosts });
    await assert.rejects(slow.download({ url: 'https://files.example.com/same', hosts }), /already being downloaded/);
    await first;
    const controller = new AbortController();
    const { store: cancelled } = storeFor(server(randomBytes(30000)));
    await assert.rejects(cancelled.download({ url: 'https://files.example.com/c', hosts, signal: controller.signal, onProgress: () => controller.abort() }), /cancelled/);
});

test('a download that stops is kept and continued from where it stopped, when the server still has the same file', async () => {
    const original = randomBytes(9000);
    const volume = createMemoryVolume();
    const cut = server(original, { cutAfter: 4000 });
    const { store } = storeFor(cut, volume);
    await assert.rejects(store.download({ url: 'https://files.example.com/big.bin', hosts, name: 'Big' }), /connection lost/);
    const [partial] = await store.partials();
    assert.deepEqual([partial.name, partial.bytes, partial.total], ['Big', 4000, 9000]);
    assert.equal((await store.list()).length, 0);
    // asking for the same address again continues with a Range request, and the whole file is what is kept
    const whole = server(original);
    const { store: again } = storeFor(whole, volume);
    const progress = [];
    const entry = await again.download({ url: 'https://files.example.com/big.bin', hosts, name: 'Big', onProgress: (item) => progress.push(item) });
    assert.deepEqual(whole.requests[0].headers, { Range: 'bytes=4000-', 'If-Range': '"v1"' });
    assert.equal(progress[0].resumedFrom, 4000);
    assert.deepEqual([...await bytesOf(again, entry.id)], [...original]);
    assert.deepEqual(await again.partials(), []);
});

test('the continuing is checked: a changed file, a server that sends the whole, one that hides its headers, or no way to tell all start again', async () => {
    const original = randomBytes(9000);
    const stopped = async (options) => {
        const volume = createMemoryVolume();
        await assert.rejects(storeFor(server(original, { cutAfter: 4000, ...options }), volume).store.download({ url: 'https://files.example.com/x', hosts }), /connection lost/);
        return volume;
    };
    // the file changed on the server: If-Range does not match, the server sends it whole
    let volume = await stopped();
    let { store } = storeFor(server(randomBytes(9000), { etag: '"v2"', lastModified: 'Tue, 03 Nov 2026 10:00:00 GMT' }), volume);
    let entry = await store.download({ url: 'https://files.example.com/x', hosts });
    assert.equal(entry.bytes, 9000);
    assert.equal(await store.usage(), 9000, 'The old half was not joined to the new file.');
    // a server that ignores Range sends 200 and the whole
    volume = await stopped();
    const ignoring = server(original, { ranges: false });
    ({ store } = storeFor(ignoring, volume));
    entry = await store.download({ url: 'https://files.example.com/x', hosts });
    assert.deepEqual([...await bytesOf(store, entry.id)], [...original]);
    // headers that are not exposed: the last-modified date still says which file it is, and a 206 is taken to start where asked
    volume = await stopped({ exposeEtag: false, exposeRange: false });
    const hiding = server(original, { exposeEtag: false, exposeRange: false });
    ({ store } = storeFor(hiding, volume));
    entry = await store.download({ url: 'https://files.example.com/x', hosts });
    assert.equal(hiding.requests[0].headers['If-Range'], 'Mon, 02 Nov 2026 10:00:00 GMT');
    assert.deepEqual([...await bytesOf(store, entry.id)], [...original]);
    // nothing to tell the file by: it starts again, with no Range request
    const undated = (options) => { const made = server(original, options); const stream = made.stream; made.stream = async (request) => { const answer = await stream(request); answer.headers.delete('last-modified'); return answer; }; return made; };
    volume = createMemoryVolume();
    await assert.rejects(storeFor(undated({ cutAfter: 4000, exposeEtag: false }), volume).store.download({ url: 'https://files.example.com/x', hosts }), /connection lost/);
    const restarting = undated({ exposeEtag: false });
    ({ store } = storeFor(restarting, volume));
    entry = await store.download({ url: 'https://files.example.com/x', hosts });
    assert.equal(restarting.requests.every((request) => !request.headers.Range), true);
    assert.deepEqual([...await bytesOf(store, entry.id)], [...original]);
    // a download left a week is dropped, as is a half with nothing in it
    volume = await stopped();
    const later = createWebFileStore({ volume, transport: server(original), sha256Hex, now: () => Date.now() + 8 * 24 * 60 * 60 * 1000 });
    assert.deepEqual(await later.partials(), []);
    assert.deepEqual([...volume.files.keys()], []);
    // giving one up
    volume = await stopped();
    ({ store } = storeFor(server(original), volume));
    const [only] = await store.partials();
    await store.discardPartial(only.id);
    assert.deepEqual(await store.partials(), []);
});

test('how large a file is, asked before it is downloaded, from a declared host only', async () => {
    const transport = server(randomBytes(1234));
    const { store } = storeFor(transport);
    assert.equal(await store.size({ url: 'https://files.example.com/a', hosts }), 1234);
    assert.equal(transport.requests[0].method, 'HEAD');
    await assert.rejects(store.size({ url: 'https://evil.example.com/a', hosts }), /may not download from evil\.example\.com/);
});
