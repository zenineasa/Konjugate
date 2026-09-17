// Copyright © 2026 Zenin Easa Panthakkalakath

// Installs the Emscripten SDK used only by the experimental web build (see
// docs/proposals/webEdition.md), and prepares the two things scripts/setupDevelopment.mjs's own
// desktop setup provides that the web build turns out to need too -- this is NOT "entirely
// separate from setupDevelopment.mjs's own setup" the way an earlier version of this comment
// claimed, on either count:
//   - vcpkg, bootstrapped here via developmentEnvironment.mjs's shared ensureVcpkgBootstrapped():
//     the web CMake presets pull the same portable C++ dependencies (Eigen, Boost.PropertyTree,
//     METIS, ...) through vcpkg that the native desktop preset does, just cross-compiled for
//     wasm32-emscripten.
//   - src/generated/reportMessages.mjs, generated here via generateReportProtocol.mjs: gitignored
//     JS-side protobuf bindings scripts/buildWebShell.mjs's own import-graph walk pulls in
//     transitively (through src/reportProtocol.mjs), with no connection to vcpkg/emsdk at all --
//     pure protobufjs-cli codegen from the committed protocol/engineProtocol.proto.
// Both gaps were found the same way: a real CI run of a version-tag-triggered web-edition deploy
// -- the first tag push after wiring that deploy up at all -- failing on a runner that had only
// ever run this script, not setupDevelopment.mjs. Every local machine that happened to work
// already had both from an earlier desktop `npm run setup`. Deliberately still excludes
// setupDevelopment.mjs's native-compiler check and `cmake --preset development` configure step --
// neither has anything to do with either gap, and the web build needs neither.
//
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
await run(process.execPath, [join(rootDirectory, 'scripts', 'generateReportProtocol.mjs')]);

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
