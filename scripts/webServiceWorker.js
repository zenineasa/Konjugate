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

const startPage = 'renderer/index.html';
const prefix = 'konjugate-';
const cacheName = `${prefix}${buildId}`;
const settingsCacheName = `${prefix}settings`;
const offlineKey = 'offline';
const simultaneousDownloads = 6;

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
    return { type: 'status', buildId, state: saving ? 'saving' : enabled ? 'ready' : 'off', bytes: precacheBytes, ...progress };
}

// Fetches every file of this build into its cache, a few at a time, skipping any a first attempt already stored. A file that cannot be
// fetched fails the whole copy, so the cache never claims to hold a build it does not.
async function precache() {
    const cache = await caches.open(cacheName);
    const queue = [...precachePaths];
    progress = { done: 0, total: queue.length };
    const download = async () => {
        while (queue.length) {
            const url = new URL(queue.shift(), base()).href;
            if (!await cache.match(url)) {
                const response = await fetch(url, { cache: 'reload' });
                if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
                await cache.put(url, response);
            }
            progress.done += 1;
            await broadcast({ type: 'progress', ...progress });
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
        if (name.startsWith(prefix) && name !== cacheName && name !== settingsCacheName) await caches.delete(name);
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
    event.waitUntil(offlineEnabled().then((enabled) => (enabled ? precache() : self.skipWaiting())));
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
