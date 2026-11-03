/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A launcher add-on's cache of what it fetched, in the web edition: addonCache.mjs for a page, with the same entries (<key>.data and
// <key>.json), the same age and size rules and the same opt-in per fetch, kept in a `volume` (webVolume.mjs). `sha256Hex(textOrBytes)` is
// async. No Node, no DOM.

import { defaultMaximumAgeDays, defaultMaximumCacheBytes, maximumAgeDaysLimit } from './addonCacheLimits.mjs';

export function createWebFileCache({ volume, sha256Hex, maximumBytes = defaultMaximumCacheBytes, now = () => Date.now() }) {
    const keyOf = (url) => sha256Hex(String(url));
    const readMeta = async (name) => { try { const text = await volume.readText(name); return text === null ? null : JSON.parse(text); } catch { return null; } };
    const entries = async () => {
        const found = [];
        for (const name of (await volume.names()).filter((item) => item.endsWith('.json'))) {
            const meta = await readMeta(name);
            if (meta) found.push({ ...meta, key: name.slice(0, -5) });
        }
        return found;
    };
    const remove = (key) => Promise.all([volume.remove(`${key}.data`), volume.remove(`${key}.json`)]);

    return {
        // The bytes fetched from `url` no more than `maximumAgeDays` ago, with when they were fetched; else null.
        async get(url, { maximumAgeDays = defaultMaximumAgeDays } = {}) {
            const key = await keyOf(url);
            const meta = await readMeta(`${key}.json`);
            if (!meta || meta.url !== url) return null;
            const age = now() - Date.parse(meta.retrievedAt);
            if (!(age <= Math.min(maximumAgeDays, maximumAgeDaysLimit) * 86400000)) return null;
            const blob = await volume.blob(`${key}.data`);
            if (!blob) return null;
            const bytes = new Uint8Array(await blob.arrayBuffer());
            // A file changed or cut short is not used.
            if (bytes.length !== meta.bytes || await sha256Hex(bytes) !== meta.sha256) { await remove(key); return null; }
            await volume.writeText(`${key}.json`, JSON.stringify({ ...meta, usedAt: new Date(now()).toISOString() })).catch(() => {});
            return { bytes, retrievedAt: meta.retrievedAt };
        },
        // Keeps the bytes fetched from `url` now; then makes room, the entries used longest ago going first.
        async put(url, bytes, { retrievedAt = new Date(now()).toISOString() } = {}) {
            const key = await keyOf(url);
            const out = await volume.open(`${key}.data`, { append: false });
            await out.write(bytes);
            await out.close();
            await volume.writeText(`${key}.json`, JSON.stringify({ url, retrievedAt, usedAt: new Date(now()).toISOString(), bytes: bytes.length, sha256: await sha256Hex(bytes) }));
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
        async clear() { await volume.clear(); }
    };
}
