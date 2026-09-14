// Copyright © 2026 Zenin Easa Panthakkalakath

// Builds the experimental web engine (docs/proposals/webEdition.md) via the "web" CMake preset (or
// "web-threads", the pthread-enabled phase-6 variant -- pass "threads" as the first CLI argument,
// e.g. `node scripts/buildWebEngine.mjs threads`, matching npm run build:web:threads) -- entirely
// separate from scripts/buildEngine.mjs's own desktop build, and never run as part of it.

import { join } from 'node:path';
import { emsdkDirectory, ensurePython310OrNewerOnPath, pathExists, rootDirectory, run, vcpkgDirectory } from './developmentEnvironment.mjs';

const preset = process.argv[2] === 'threads' ? 'web-threads' : 'web';

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

await run('cmake', ['--preset', preset], { cwd: join(rootDirectory, 'engine') });
await run('cmake', ['--build', '--preset', preset], { cwd: join(rootDirectory, 'engine') });

const outputDirectory = preset === 'web-threads' ? 'out/engineWebThreads' : 'out/engineWeb';
console.log(`Web engine built at ${outputDirectory}/konjugateEngine.js (+ .wasm).`);
