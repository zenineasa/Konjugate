// Copyright © 2026 Zenin Easa Panthakkalakath

// Builds the experimental web engine (docs/proposals/webEdition.md) via the "web" CMake preset --
// entirely separate from scripts/buildEngine.mjs's own desktop build, and never run as part of it.

import { join } from 'node:path';
import { emsdkDirectory, ensurePython310OrNewerOnPath, pathExists, rootDirectory, run, vcpkgDirectory } from './developmentEnvironment.mjs';

if (!await pathExists(join(vcpkgDirectory, 'scripts', 'buildsystems', 'vcpkg.cmake'))) {
    throw new Error('The development dependencies are not configured. Run npm run setup first.');
}
if (!await pathExists(join(emsdkDirectory, 'upstream', 'emscripten', 'emcc'))) {
    throw new Error('The Emscripten SDK is not installed. Run npm run setup:web first.');
}
ensurePython310OrNewerOnPath();

// Emscripten's own CMake toolchain file resolves the compiler relative to $EMSDK/$EMSCRIPTEN_ROOT
// (or by finding em++ on PATH) -- set both so vcpkg's chainloaded toolchain can find it the same
// way emsdk_env.sh would set up an interactive shell.
process.env.EMSDK = emsdkDirectory;
const emscriptenRoot = join(emsdkDirectory, 'upstream', 'emscripten');
process.env.PATH = `${emsdkDirectory}${process.platform === 'win32' ? ';' : ':'}${emscriptenRoot}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;

await run('cmake', ['--preset', 'web'], { cwd: join(rootDirectory, 'engine') });
await run('cmake', ['--build', '--preset', 'web'], { cwd: join(rootDirectory, 'engine') });

console.log('Web engine built at out/engineWeb/konjugateEngine.js (+ .wasm).');
