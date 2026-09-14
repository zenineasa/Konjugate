// Copyright © 2026 Zenin Easa Panthakkalakath

// Installs the Emscripten SDK used only by the experimental web build (see
// docs/proposals/webEdition.md) -- entirely separate from scripts/setupDevelopment.mjs's own
// vcpkg-based native-desktop setup, and never run as part of it, since ordinary desktop
// development has no use for a WASM toolchain. Mirrors setupDevelopment.mjs's own
// clone-if-missing/checkout-a-pinned-version/install shape for the same reason that script does
// it that way: reproducibility across machines and CI, not whatever "latest" happens to be today.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
    commandExists,
    emsdkDirectory,
    emsdkVersion,
    ensurePython310OrNewerOnPath,
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
