// Copyright © 2026 Zenin Easa Panthakkalakath

import { readFile, readdir, stat } from 'node:fs/promises';
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

// Whether an assembled web shell carries the current engine: the shell's copy is the engine last built (the copy does not keep its
// time, so its bytes are compared), and that build is newer than every engine source. The web interaction tests turn on what needs a
// current engine only then.
export async function shellHasCurrentEngine(rootDirectory, threads = true) {
    const built = join(rootDirectory, 'out', threads ? 'engineWebThreads' : 'engineWeb', 'konjugateEngine.wasm');
    const shipped = join(rootDirectory, 'out', threads ? 'webShellThreads' : 'webShell', 'engine', 'konjugateEngine.wasm');
    const [builtBytes, shippedBytes] = await Promise.all([readFile(built).catch(() => null), readFile(shipped).catch(() => null)]);
    if (!builtBytes || !shippedBytes || !builtBytes.equals(shippedBytes)) return false;
    return !await staleEngineSource(built, ['src', 'include', 'CMakeLists.txt', 'CMakePresets.json'].map((name) => join(rootDirectory, 'engine', name)));
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
