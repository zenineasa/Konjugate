// Copyright © 2026 Zenin Easa Panthakkalakath

// Installs the Emscripten SDK used only by the experimental web build (see
// docs/proposals/webEdition.md), and bootstraps vcpkg alongside it -- the web CMake presets pull
// the same portable C++ dependencies (Eigen, Boost.PropertyTree, METIS, ...) through vcpkg that
// the native desktop preset does, just cross-compiled for wasm32-emscripten, so this is NOT
// "entirely separate from scripts/setupDevelopment.mjs's own vcpkg-based setup" the way an
// earlier version of this comment claimed -- that was true for the *native compiler and desktop
// CMake preset* (still not needed here, and still not run here), but not for vcpkg itself, which
// this script shares via developmentEnvironment.mjs's ensureVcpkgBootstrapped(). Confirmed the
// hard way: a CI runner that had only ever run this script (not scripts/setupDevelopment.mjs)
// failed npm run build:web with "development dependencies are not configured" -- every local
// machine that happened to work already had vcpkg from an earlier desktop `npm run setup`.
// Mirrors setupDevelopment.mjs's own clone-if-missing/checkout-a-pinned-version/install shape for
// emsdk specifically, for the same reason that script does it that way for vcpkg: reproducibility
// across machines and CI, not whatever "latest" happens to be today.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
    commandExists,
    emsdkDirectory,
    emsdkVersion,
    ensurePython310OrNewerOnPath,
    ensureVcpkgBootstrapped,
    pathExists,
    rootDirectory,
    run
} from './developmentEnvironment.mjs';

for (const command of ['cmake', 'git', 'python3']) {
    if (!await commandExists(command)) {
        throw new Error(`${command} is required for the web build. See docs/developmentSetup.md for the platform prerequisites.`);
    }
}
ensurePython310OrNewerOnPath();
await ensureVcpkgBootstrapped();

if (!await pathExists(join(emsdkDirectory, '.git'))) {
    await mkdir(join(rootDirectory, '.tools'), { recursive: true });
    await run('git', ['clone', 'https://github.com/emscripten-core/emsdk.git', emsdkDirectory]);
}

await run('git', ['fetch', '--depth', '1', 'origin', 'tag', emsdkVersion], { cwd: emsdkDirectory });
await run('git', ['checkout', '--detach', emsdkVersion], { cwd: emsdkDirectory });

const emsdkScript = process.platform === 'win32' ? 'emsdk.bat' : './emsdk';
await run(emsdkScript, ['install', emsdkVersion], { cwd: emsdkDirectory });
await run(emsdkScript, ['activate', emsdkVersion], { cwd: emsdkDirectory });

console.log('Emscripten SDK is installed and activated for the web build. Run npm run build:web to build the WASM engine core.');
