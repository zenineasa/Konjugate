// Copyright © 2026 Zenin Easa Panthakkalakath

// The web edition's service worker (scripts/buildWebShell.mjs fills in the three __…__ values and writes it to the root of the site as
// sw.js). It does nothing until a person asks to use the web edition offline. Then it keeps a copy of the whole build -- the page, its
// scripts, the engine -- in a cache named for the build, and serves from it first. Only same-origin GETs are touched.
//
// A build's files only ever come from that build's cache, so two builds never mix: a new worker downloads its own build in full while the
// old one keeps serving the old, and with offline use on it waits until the page asks it to take over (the person's tap on "Reload"),
// so a model that is running is never swapped for a different engine underneath it.

'use strict';

const buildId = '__BUILD_ID__';
const precachePaths = __PRECACHE_PATHS__;
const precacheBytes = __PRECACHE_BYTES__;
// The files too large to be worth fetching in one go on a phone's connection (path -> bytes): they are fetched in pieces, and a piece
// that arrived is kept, so an interrupted copy continues from where it stopped, not from the file's start.
const largeFiles = __LARGE_FILES__;

const startPage = 'renderer/index.html';
const prefix = 'konjugate-';
const cacheName = `${prefix}${buildId}`;
const settingsCacheName = `${prefix}settings`;
const partsCacheName = `${prefix}parts-${buildId}`;
const pieceBytes = 4 * 1024 * 1024;
const offlineKey = 'offline';
const simultaneousDownloads = 6;
const attemptsPerFile = 4;

const base = () => new URL('./', self.registration.scope).href;

let saving = false;
let progress = { done: 0, total: precachePaths.length };

async function offlineEnabled() {
    const settings = await caches.open(settingsCacheName);
    return Boolean(await settings.match(offlineKey));
}

async function setOfflineEnabled(enabled) {
    const settings = await caches.open(settingsCacheName);
    if (enabled) await settings.put(offlineKey, new Response('1'));
    else await settings.delete(offlineKey);
}

async function broadcast(message) {
    for (const client of await self.clients.matchAll({ includeUncontrolled: true })) client.postMessage(message);
}

async function status() {
    const enabled = await offlineEnabled();
    // Files already stored by an earlier, interrupted attempt, which the next one keeps.
    const saved = saving || enabled ? progress.done : (await caches.keys()).includes(cacheName) ? (await (await caches.open(cacheName)).keys()).length : 0;
    return { type: 'status', buildId, state: saving ? 'saving' : enabled ? 'ready' : 'off', bytes: precacheBytes, ...progress, saved };
}

// A phone's connection drops now and then (the screen turns off, the signal changes), so a file is tried a few times before the copy gives up.
async function fetchIntoCache(cache, url) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            const response = await fetch(url, { cache: 'reload' });
            if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
            await cache.put(url, response);
            return;
        } catch (error) {
            if (attempt === attemptsPerFile) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
    }
}

// A large file, fetched a piece at a time with Range requests and the pieces kept in a cache of their own until the file is whole. A
// piece asks for the same file the first one got (If-Range with its ETag), and a server that cannot or will not serve a range sends the
// whole file, which is then simply kept as it is. The pieces must add up to the size the build recorded, so a file that changed under
// the copy is never stored.
async function fetchInPieces(cache, url, size) {
    const parts = await caches.open(partsCacheName);
    let etag = null;
    let type = null;
    for (let start = 0; start < size; start += pieceBytes) {
        const key = `${url}#${start}`;
        const kept = await parts.match(key);
        if (kept) {
            etag ??= kept.headers.get('x-etag') || null;
            type ??= kept.headers.get('x-type') || null;
            continue;
        }
        const end = Math.min(start + pieceBytes, size) - 1;
        let response;
        for (let attempt = 1; ; attempt += 1) {
            try {
                response = await fetch(url, { cache: 'reload', headers: { Range: `bytes=${start}-${end}`, ...(etag ? { 'If-Range': etag } : {}) } });
                if (response.status !== 200 && response.status !== 206) throw new Error(`${url} answered ${response.status}.`);
                break;
            } catch (error) {
                if (attempt === attemptsPerFile) throw error;
                await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            }
        }
        if (response.status === 200) {
            // The whole file came back (no range support, or it is not the file the earlier pieces came from).
            await caches.delete(partsCacheName);
            await cache.put(url, response);
            return;
        }
        const total = /^bytes \d+-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1];
        if (Number(total) !== size) throw new Error(`${url} is not the size this build expects.`);
        const blob = await response.blob();
        if (blob.size !== end - start + 1) throw new Error(`${url} stopped part way through a piece.`);
        etag ??= response.headers.get('etag');
        type ??= response.headers.get('content-type');
        await parts.put(key, new Response(blob, { headers: { 'x-etag': etag ?? '', 'x-type': type ?? '' } }));
    }
    const blobs = [];
    for (let start = 0; start < size; start += pieceBytes) blobs.push(await (await parts.match(`${url}#${start}`)).blob());
    await cache.put(url, new Response(new Blob(blobs), { headers: type ? { 'content-type': type } : {} }));
    await caches.delete(partsCacheName);
}

// Fetches every file of this build into its cache, a few at a time, skipping any a first attempt already stored. A file that cannot be
// fetched fails the whole copy, so the cache never claims to hold a build it does not.
// `kind` says to the page what the copy is for: 'save' (the person asked for offline use) or 'update' (a new build, fetched in the background).
async function precache(kind = 'save') {
    const cache = await caches.open(cacheName);
    const queue = [...precachePaths];
    progress = { done: 0, total: queue.length };
    const download = async () => {
        while (queue.length) {
            const queuedPath = queue.shift();
            const url = new URL(queuedPath, base()).href;
            if (!await cache.match(url)) {
                const size = largeFiles[queuedPath];
                await (size ? fetchInPieces(cache, url, size) : fetchIntoCache(cache, url));
            }
            progress.done += 1;
            await broadcast({ type: 'progress', kind, ...progress });
        }
    };
    await Promise.all(Array.from({ length: simultaneousDownloads }, download));
}

async function enableOffline() {
    if (saving) return;
    saving = true;
    try {
        await precache();
        await setOfflineEnabled(true);
    } catch (error) {
        await broadcast({ type: 'error', message: String(error?.message ?? error) });
    } finally {
        saving = false;
        await broadcast(await status());
    }
}

async function disableOffline() {
    await setOfflineEnabled(false);
    for (const name of await caches.keys()) if (name.startsWith(prefix) && name !== settingsCacheName) await caches.delete(name);
    await broadcast(await status());
}

// Another build's cache is of no use to this worker once it is the one serving, and is what would otherwise fill the person's storage.
async function deleteOldCaches() {
    for (const name of await caches.keys()) {
        if (name.startsWith(prefix) && name !== cacheName && name !== settingsCacheName && name !== partsCacheName) await caches.delete(name);
    }
}

// Only the site's own plain GETs, and the HEADs that ask about them (MathLive sends one for its own script, to find its fonts): a range
// request (a video, say) cannot be answered from a whole stored response, and the worker's own file is never served from the cache it
// is there to manage.
function shouldHandle(request) {
    return (request.method === 'GET' || request.method === 'HEAD') && request.url.startsWith(base()) && !request.headers.has('range') && !request.url.startsWith(`${base()}sw.js`);
}

async function respond(request) {
    const cache = await caches.open(cacheName);
    // A HEAD is answered with the stored file itself; the browser drops the body of a response to a HEAD.
    const stored = await cache.match(request, { ignoreSearch: true, ignoreMethod: true });
    if (stored) return stored;
    try {
        const response = await fetch(request);
        // A file the copy leaves out (Pyodide, say) is kept when first used, but only once offline use is on.
        if (request.method === 'GET' && response.status === 200 && await offlineEnabled()) await cache.put(request, response.clone());
        return response;
    } catch (error) {
        if (request.mode === 'navigate') {
            const page = await cache.match(new URL(startPage, base()).href);
            if (page) return page;
        }
        throw error;
    }
}

if (typeof module !== 'undefined') {
    module.exports = {
        buildId, cacheName, settingsCacheName, status, precache, enableOffline, disableOffline, deleteOldCaches, shouldHandle, respond,
        setOfflineEnabled
    };
}

self.addEventListener('install', (event) => {
    // With offline use on, the new build is downloaded now and the worker then waits to be told to take over. With it off there is
    // nothing stored to protect, so it takes over at once.
    event.waitUntil(offlineEnabled().then((enabled) => (enabled ? precache('update') : self.skipWaiting())));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(deleteOldCaches().then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
    const type = event.data?.type;
    if (type === 'skipWaiting') self.skipWaiting();
    else if (type === 'status') event.waitUntil(status().then((message) => event.source?.postMessage(message)));
    else if (type === 'enableOffline') event.waitUntil(enableOffline());
    else if (type === 'disableOffline') event.waitUntil(disableOffline());
});

self.addEventListener('fetch', (event) => {
    if (shouldHandle(event.request)) event.respondWith(respond(event.request));
});
