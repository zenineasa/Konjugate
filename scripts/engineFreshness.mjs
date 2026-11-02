// Copyright © 2026 Zenin Easa Panthakkalakath

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// The web shell carries a copy of the engine's WebAssembly and never builds it, so a shell assembled after the engine's sources changed
// but before the engine was rebuilt ships the older engine, which can reject models the current one accepts.
async function newestModification(path) {
    const info = await stat(path).catch(() => null);
    if (!info) return null;
    if (!info.isDirectory()) return { path, time: info.mtimeMs };
    let newest = null;
    for (const entry of await readdir(path)) {
        const found = await newestModification(join(path, entry));
        if (found && (!newest || found.time > newest.time)) newest = found;
    }
    return newest;
}

export async function staleEngineSource(enginePath, sourcePaths) {
    const built = await stat(enginePath).catch(() => null);
    if (!built) return null;
    let newest = null;
    for (const sourcePath of sourcePaths) {
        const found = await newestModification(sourcePath);
        if (found && (!newest || found.time > newest.time)) newest = found;
    }
    return newest && newest.time > built.mtimeMs ? newest.path : null;
}
