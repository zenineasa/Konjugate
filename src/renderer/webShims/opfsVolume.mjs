/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A volume (webVolume.mjs) kept in the browser's private file system (OPFS): the place a launcher's stored files and fetch cache live in the web
// edition. Each add-on has a folder of its own under `addonFiles` or `addonCache`, which no page of another site can reach and the add-on's own
// frame never sees. A writer saves what it was given when it is closed (the browser writes to a swap file until then), so a download that is
// interrupted by the network is closed and keeps what arrived, while one interrupted by the tab closing does not.

const safeId = (addonId) => String(addonId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);

// Whether this browser lets a page write to its private file system the way the volume needs.
export const opfsAvailable = () => typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
    && typeof FileSystemFileHandle !== 'undefined' && typeof FileSystemFileHandle.prototype.createWritable === 'function';

export const unavailableMessage = 'Stored files need a browser that lets a page keep files in its private storage (a current Chrome, Edge, Firefox or Safari).';

const notFound = (error) => error?.name === 'NotFoundError';

export async function openOpfsVolume(kind, addonId) {
    if (!opfsAvailable()) throw new Error(unavailableMessage);
    // Asked for once; a browser may still clear what it was not promised to keep when it is short of space.
    navigator.storage.persist?.().catch(() => {});
    const root = await navigator.storage.getDirectory();
    const directory = await (await root.getDirectoryHandle(kind, { create: true })).getDirectoryHandle(safeId(addonId), { create: true });
    const handleOf = async (name, create = false) => {
        try { return await directory.getFileHandle(name, { create }); } catch (error) { if (notFound(error)) return null; throw error; }
    };
    const volume = {
        async names() {
            const found = [];
            for await (const [name, handle] of directory.entries()) if (handle.kind === 'file') found.push(name);
            return found;
        },
        async size(name) { const handle = await handleOf(name); return handle ? (await handle.getFile()).size : null; },
        async blob(name) { const handle = await handleOf(name); return handle ? handle.getFile() : null; },
        async readText(name) { const handle = await handleOf(name); return handle ? (await handle.getFile()).text() : null; },
        async writeText(name, text) {
            const writer = await volume.open(name, { append: false });
            try { await writer.write(new TextEncoder().encode(text)); await writer.close(); } catch (error) { await writer.abort(); throw error; }
        },
        async open(name, { append = false } = {}) {
            const handle = await handleOf(name, true);
            const writable = await handle.createWritable({ keepExistingData: append });
            if (append) await writable.seek((await handle.getFile()).size);
            return { write: (bytes) => writable.write(bytes), close: () => writable.close(), abort: () => writable.abort().catch(() => {}) };
        },
        async rename(from, to) {
            const handle = await handleOf(from);
            if (!handle) throw new Error(`${from} is not there.`);
            await volume.remove(to);
            if (typeof handle.move === 'function') { await handle.move(to); return; }
            const writer = await volume.open(to, { append: false });
            const reader = (await handle.getFile()).stream().getReader();
            for (;;) { const { done, value } = await reader.read(); if (done) break; await writer.write(value); }
            await writer.close();
            await volume.remove(from);
        },
        async remove(name) {
            try { await directory.removeEntry(name); } catch (error) { if (!notFound(error)) throw error; }
        },
        async clear() { for (const name of await volume.names()) await volume.remove(name); }
    };
    return volume;
}

// Everything an add-on kept: its stored files and its fetch cache. Removed with the add-on's last version, because on the web there is no other
// way for the person to reach them (the desktop leaves them in a folder they can open).
export async function removeOpfsAddonData(addonId) {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return;
    const root = await navigator.storage.getDirectory();
    for (const kind of ['addonFiles', 'addonCache']) {
        try { await (await root.getDirectoryHandle(kind)).removeEntry(safeId(addonId), { recursive: true }); } catch (error) { if (!notFound(error)) throw error; }
    }
}
