/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A launcher add-on's cache of what it fetched, on disk, so data fetched once (a city's roads, say) loads again
// without the network and without asking a public server for it twice. One folder per add-on under the user's data,
// never seen by the add-on's window: the window asks for an address, as it always does, and says whether it may be
// answered from the cache. Each entry keeps when it was really fetched, so a model built from it still says so.
// Opt-in per fetch: an add-on whose data must always be fresh (prices, say) never uses it. Kept across reinstalls;
// removed with the add-on.
//
// An entry is two files, named by the SHA-256 of its address: <key>.data (the bytes as fetched) and <key>.json
// ({ url, retrievedAt, usedAt, bytes, sha256 }). When the cache passes its size, the entries used longest ago go first.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const defaultMaximumCacheBytes = 512 * 1024 * 1024;
export const defaultMaximumAgeDays = 30;
export const maximumAgeDaysLimit = 3650;

const keyOf = (url) => createHash('sha256').update(String(url)).digest('hex');
const safeId = (addonId) => String(addonId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);

// The folder an add-on's cache lives in.
export function addonCacheDirectory(userData, addonId) {
    return join(userData, 'addonCache', safeId(addonId));
}

export function createAddonCache({ directory, maximumBytes = defaultMaximumCacheBytes, now = () => Date.now() }) {
    const paths = (url) => {
        const key = keyOf(url);
        return { data: join(directory, `${key}.data`), meta: join(directory, `${key}.json`) };
    };
    const readMeta = async (path) => {
        try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
    };
    const entries = async () => {
        let names = [];
        try { names = await readdir(directory); } catch { return []; }
        const found = [];
        for (const name of names.filter((item) => item.endsWith('.json'))) {
            const meta = await readMeta(join(directory, name));
            if (meta) found.push({ ...meta, key: name.slice(0, -5) });
        }
        return found;
    };
    const remove = (key) => Promise.all([rm(join(directory, `${key}.data`), { force: true }), rm(join(directory, `${key}.json`), { force: true })]);

    return {
        directory,
        // The bytes fetched from `url` no more than `maximumAgeDays` ago, with when they were fetched; else null.
        async get(url, { maximumAgeDays = defaultMaximumAgeDays } = {}) {
            const { data, meta: metaPath } = paths(url);
            const meta = await readMeta(metaPath);
            if (!meta || meta.url !== url) return null;
            const age = now() - Date.parse(meta.retrievedAt);
            if (!(age <= Math.min(maximumAgeDays, maximumAgeDaysLimit) * 86400000)) return null;
            let bytes;
            try { bytes = await readFile(data); } catch { return null; }
            // A file changed or cut short on disk is not used.
            if (bytes.length !== meta.bytes || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) { await remove(keyOf(url)); return null; }
            await writeFile(metaPath, JSON.stringify({ ...meta, usedAt: new Date(now()).toISOString() })).catch(() => {});
            return { bytes, retrievedAt: meta.retrievedAt };
        },
        // Keeps the bytes fetched from `url` now; then makes room, the entries used longest ago going first.
        async put(url, bytes, { retrievedAt = new Date(now()).toISOString() } = {}) {
            await mkdir(directory, { recursive: true });
            const { data, meta } = paths(url);
            await writeFile(data, bytes);
            await writeFile(meta, JSON.stringify({ url, retrievedAt, usedAt: new Date(now()).toISOString(), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
            const all = (await entries()).sort((a, b) => Date.parse(a.usedAt) - Date.parse(b.usedAt));
            let total = all.reduce((sum, entry) => sum + entry.bytes, 0);
            for (const entry of all) {
                if (total <= maximumBytes) break;
                if (entry.url === url) continue;
                await remove(entry.key);
                total -= entry.bytes;
            }
            return { retrievedAt };
        },
        // How much is kept: { entries, bytes, oldest, newest } (dates of fetching).
        async info() {
            const all = await entries();
            const dates = all.map((entry) => entry.retrievedAt).sort();
            return { entries: all.length, bytes: all.reduce((sum, entry) => sum + entry.bytes, 0), oldest: dates[0] ?? null, newest: dates.at(-1) ?? null };
        },
        async clear() {
            await rm(directory, { recursive: true, force: true });
        }
    };
}

// Whether a path holds anything (for tests and the uninstall).
export async function exists(path) {
    try { await stat(path); return true; } catch { return false; }
}
