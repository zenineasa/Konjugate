/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The place a launcher's stored files and fetch cache are kept in the web edition (webFileStore.mjs, webFileCache.mjs): a flat set of named
// files, one set per add-on. The page backs it with the browser's private file system (renderer/webShims/opfsVolume.mjs); this is the same
// interface held in memory, for tests. A volume answers:
//   names() -> [name]; size(name) -> bytes | null; blob(name) -> a Blob | null; readText(name) -> string | null; writeText(name, text);
//   open(name, { append }) -> { write(Uint8Array), close(), abort() }; rename(from, to); remove(name) (no error if it is not there); clear().
// No Node, no DOM.

export function createMemoryVolume() {
    const files = new Map();
    return {
        files,
        async names() { return [...files.keys()]; },
        async size(name) { return files.has(name) ? files.get(name).length : null; },
        async blob(name) { return files.has(name) ? new Blob([files.get(name)]) : null; },
        async readText(name) { return files.has(name) ? new TextDecoder().decode(files.get(name)) : null; },
        async writeText(name, text) { files.set(name, new TextEncoder().encode(text)); },
        async open(name, { append = false } = {}) {
            const chunks = append && files.has(name) ? [files.get(name)] : [];
            return {
                async write(bytes) { chunks.push(Uint8Array.from(bytes)); },
                async close() {
                    const whole = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
                    let at = 0;
                    for (const chunk of chunks) { whole.set(chunk, at); at += chunk.length; }
                    files.set(name, whole);
                },
                async abort() {}
            };
        },
        async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
        async remove(name) { files.delete(name); },
        async clear() { files.clear(); }
    };
}
