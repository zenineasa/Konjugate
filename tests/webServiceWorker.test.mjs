// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { offlineButtonState } from '../src/renderer/webShims/offline.mjs';

const scope = 'https://example.com/app/';

// A worker made from the real template, with a small in-memory stand-in for the browser's cache storage and network.
async function loadWorker({ buildId = 'b1', paths = ['', 'renderer/index.html', 'engine/e.wasm'], offline = false, files = {}, caches: existing = {}, large = {}, pieceBytes = null } = {}) {
    const template = (await readFile(new URL('../scripts/webServiceWorker.js', import.meta.url), 'utf8'))
        .replace('__BUILD_ID__', buildId).replace('__PRECACHE_PATHS__', JSON.stringify(paths)).replace('__PRECACHE_BYTES__', '1000').replace('__LARGE_FILES__', JSON.stringify(large));
    const source = pieceBytes ? template.replace('4 * 1024 * 1024', String(pieceBytes)) : template;
    const stores = new Map(Object.entries(existing).map(([name, entries]) => [name, new Map(Object.entries(entries))]));
    const listeners = {};
    const fetched = [];
    let online = true;
    const makeCache = (map) => ({
        match: async (request, options) => {
            const url = typeof request === 'string' ? request : request.url;
            const key = options?.ignoreSearch ? url.split('?')[0] : url;
            return map.get(key)?.clone();
        },
        put: async (request, response) => { map.set((typeof request === 'string' ? request : request.url).split('?')[0], response); },
        delete: async (request) => map.delete(request),
        keys: async () => [...map.keys()]
    });
    const environment = {
        module: { exports: {} },
        Response,
        Blob,
        URL,
        Promise,
        console,
        // Waits between a file's attempts are not waited for here.
        setTimeout: (callback) => setTimeout(callback, 0),
        self: {
            registration: { scope },
            clients: { matchAll: async () => [], claim: async () => {} },
            addEventListener: (type, listener) => { listeners[type] = listener; },
            skipWaiting: () => { environment.skipped = true; }
        },
        caches: {
            open: async (name) => { if (!stores.has(name)) stores.set(name, new Map()); return makeCache(stores.get(name)); },
            keys: async () => [...stores.keys()],
            delete: async (name) => stores.delete(name)
        },
        fetch: async (request) => {
            const url = typeof request === 'string' ? request : request.url;
            fetched.push(url);
            if (!online) throw new TypeError('offline');
            const path = url.slice(scope.length);
            return path in files || path === '' ? new Response(files[path] ?? 'x', { status: 200 }) : new Response('', { status: 404 });
        }
    };
    vm.runInNewContext(source, environment);
    if (offline) await environment.module.exports.setOfflineEnabled(true);
    return { api: environment.module.exports, stores, fetched, listeners, setOnline: (value) => { online = value; }, environment };
}

const request = (path, { method = 'GET', mode = 'cors', headers = {} } = {}) => ({
    url: path.startsWith('http') ? path : scope + path, method, mode, headers: new Headers(headers)
});

test('only the site\'s own plain GETs are handled, never a range request or the worker\'s own file', async () => {
    const { api } = await loadWorker();
    assert.equal(api.shouldHandle(request('renderer/index.html')), true);
    assert.equal(api.shouldHandle(request('renderer/index.html', { method: 'HEAD' })), true);
    assert.equal(api.shouldHandle(request('renderer/index.html', { method: 'POST' })), false);
    assert.equal(api.shouldHandle(request('https://elsewhere.example/x.js')), false);
    assert.equal(api.shouldHandle(request('engine/e.wasm', { headers: { range: 'bytes=0-9' } })), false);
    assert.equal(api.shouldHandle(request('sw.js')), false);
});

test('a stored file is served without the network', async () => {
    const { api, fetched } = await loadWorker({ caches: { 'konjugate-b1': { [`${scope}renderer/index.html`]: new Response('stored') } } });
    assert.equal(await (await api.respond(request('renderer/index.html'))).text(), 'stored');
    assert.deepEqual(fetched, []);
});

test('with offline use off a file comes from the network and nothing is kept', async () => {
    const { api, stores } = await loadWorker({ files: { 'a.js': 'net' } });
    assert.equal(await (await api.respond(request('a.js'))).text(), 'net');
    assert.equal(stores.get('konjugate-b1').size, 0);
});

test('with offline use on a file the copy left out is kept when first used, and a failed answer is not', async () => {
    const { api, stores } = await loadWorker({ offline: true, files: { 'node_modules/pyodide/p.js': 'py' } });
    await api.respond(request('node_modules/pyodide/p.js'));
    assert.equal(stores.get('konjugate-b1').has(`${scope}node_modules/pyodide/p.js`), true);
    const missing = await api.respond(request('nope.js'));
    assert.equal(missing.status, 404);
    assert.equal(stores.get('konjugate-b1').has(`${scope}nope.js`), false);
});

test('with no network a page navigation falls back to the stored start page, and anything else fails', async () => {
    const { api, setOnline } = await loadWorker({ caches: { 'konjugate-b1': { [`${scope}renderer/index.html`]: new Response('shell') } } });
    setOnline(false);
    assert.equal(await (await api.respond(request('renderer/index.html?x=1', { mode: 'navigate' }))).text(), 'shell');
    assert.equal(await (await api.respond(request('somewhere', { mode: 'navigate' }))).text(), 'shell');
    await assert.rejects(api.respond(request('other.js')));
});

test('saving for offline use stores every file, reports ready, and a later start copies nothing it already holds', async () => {
    const files = { 'renderer/index.html': 'h', 'engine/e.wasm': 'w' };
    const { api, stores, fetched } = await loadWorker({ files });
    await api.enableOffline();
    assert.equal(stores.get('konjugate-b1').size, 3);
    assert.equal((await api.status()).state, 'ready');
    const before = fetched.length;
    await api.precache();
    assert.equal(fetched.length, before);
});

test('a file that cannot be fetched leaves offline use off', async () => {
    const { api } = await loadWorker({ files: { 'renderer/index.html': 'h' } });
    await api.enableOffline();
    assert.equal((await api.status()).state, 'off');
});

test('a file that fails once is tried again, and a partial copy is reported as such and continued', async () => {
    const { api, environment, setOnline } = await loadWorker({ files: { 'renderer/index.html': 'h', 'engine/e.wasm': 'w' } });
    const realFetch = environment.fetch;
    let failures = 1;
    environment.fetch = async (request) => { if (String(request).endsWith('e.wasm') && failures-- > 0) throw new TypeError('dropped'); return realFetch(request); };
    await api.enableOffline();
    assert.equal((await api.status()).state, 'ready');
    environment.fetch = async () => { throw new TypeError('offline'); };
    const partial = await loadWorker({ files: { 'renderer/index.html': 'h' }, caches: { 'konjugate-b1': { [scope + 'renderer/index.html']: new Response('h') } } });
    const status = await partial.api.status();
    assert.equal(status.state, 'off');
    assert.equal(status.saved, 1);
    setOnline(true);
});

test('a large file is fetched in pieces, and a piece that arrived is not fetched again after an interruption', async () => {
    const body = 'abcdefghijklmnopqrstuvwxyz';
    const { api, environment, stores } = await loadWorker({ paths: ['engine/e.wasm'], large: { 'engine/e.wasm': body.length }, pieceBytes: 10 });
    const requested = [];
    let dropAt = 'bytes=10-19';
    environment.fetch = async (url, options = {}) => {
        const range = options.headers?.Range;
        requested.push(range);
        if (range === dropAt) throw new TypeError('dropped');
        const [from, to] = range.slice(6).split('-').map(Number);
        return new Response(body.slice(from, to + 1), { status: 206, headers: { 'content-range': `bytes ${from}-${to}/${body.length}`, etag: '"v1"', 'content-type': 'application/wasm' } });
    };
    await api.enableOffline();
    assert.equal((await api.status()).state, 'off');
    assert.equal(stores.get('konjugate-parts-b1').size, 1);
    dropAt = null;
    requested.length = 0;
    await api.enableOffline();
    assert.deepEqual(requested.filter(Boolean), ['bytes=10-19', 'bytes=20-25']);
    assert.equal(await (await stores.get('konjugate-b1').get(scope + 'engine/e.wasm')).text(), body);
    assert.equal(stores.has('konjugate-parts-b1'), false);
});

test('a large file whose pieces do not add up to the size the build recorded is not stored', async () => {
    const { api, environment, stores } = await loadWorker({ paths: ['engine/e.wasm'], large: { 'engine/e.wasm': 20 }, pieceBytes: 10 });
    environment.fetch = async () => new Response('0123456789', { status: 206, headers: { 'content-range': 'bytes 0-9/99' } });
    await api.enableOffline();
    assert.equal((await api.status()).state, 'off');
    assert.equal(stores.get('konjugate-b1').size, 0);
});

test('removing offline use deletes the build\'s files and turns it off', async () => {
    const { api, stores } = await loadWorker({ offline: true, caches: { 'konjugate-b1': { a: new Response('1') }, 'konjugate-old': { b: new Response('2') }, 'unrelated': { c: new Response('3') } } });
    await api.disableOffline();
    assert.deepEqual([...stores.keys()].sort(), ['konjugate-settings', 'unrelated']);
    assert.equal((await api.status()).state, 'off');
});

test('taking over deletes other builds\' files but keeps its own, the setting and what is not the site\'s', async () => {
    const { api, stores } = await loadWorker({ caches: { 'konjugate-b1': {}, 'konjugate-old': {}, 'konjugate-settings': {}, 'other': {} } });
    await api.deleteOldCaches();
    assert.deepEqual([...stores.keys()].sort(), ['konjugate-b1', 'konjugate-settings', 'other']);
});

test('a new build takes over at once with offline use off, and waits to be told with it on', async () => {
    const off = await loadWorker({ files: { 'renderer/index.html': 'h', 'engine/e.wasm': 'w' } });
    let installing;
    off.listeners.install({ waitUntil: (promise) => { installing = promise; } });
    await installing;
    assert.equal(off.environment.skipped, true);
    const on = await loadWorker({ offline: true, files: { 'renderer/index.html': 'h', 'engine/e.wasm': 'w' } });
    let pending;
    on.listeners.install({ waitUntil: (promise) => { pending = promise; } });
    await pending;
    assert.equal(on.environment.skipped, undefined);
    assert.equal(on.stores.get('konjugate-b1').size, 3);
});

test('the offline button says what pressing it does and how far a copy has got', () => {
    assert.equal(offlineButtonState(null).disabled, true);
    assert.deepEqual(offlineButtonState({ state: 'off', bytes: 150_557_392 }), { label: 'Use offline (151 MB)', disabled: false });
    assert.deepEqual(offlineButtonState({ state: 'saving', done: 5, total: 20 }), { label: 'Saving for offline use… 25%', disabled: true });
    assert.equal(offlineButtonState({ state: 'ready' }).disabled, false);
    assert.match(offlineButtonState({ state: 'ready' }).label, /Available offline/);
    assert.match(offlineButtonState({ state: 'off', bytes: 1 }, { failed: true }).label, /try again/);
    assert.equal(offlineButtonState({ state: 'off', bytes: 1 }, { shortage: true }).disabled, true);
    assert.match(offlineButtonState({ state: 'off', bytes: 1, saved: 50, total: 100 }).label, /Continue saving.*50%/);
});

test('a HEAD for a stored file is answered from it, and a HEAD for another is never stored', async () => {
    const { api, stores } = await loadWorker({ offline: true, files: { 'b.js': 'net' }, caches: { 'konjugate-b1': { [`${scope}a.js`]: new Response('stored') } } });
    assert.equal((await api.respond(request('a.js', { method: 'HEAD' }))).status, 200);
    await api.respond(request('b.js', { method: 'HEAD' }));
    assert.equal(stores.get('konjugate-b1').has(`${scope}b.js`), false);
});
