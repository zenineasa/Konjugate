// Copyright © 2026 Zenin Easa Panthakkalakath

// Generates src/generated/reportMessages.mjs from protocol/engineProtocol.proto via pbjs
// (protobufjs-cli) -- the JS-side counterpart to protobuf_generate_cpp() in engine/CMakeLists.txt,
// which generates the equivalent C++ classes into out/engine at CMake configure time. Neither
// generated form is committed to the repo (matching the existing assets/icons/ precedent: a
// gitignored, generated directory, rebuilt by a setup/build step) -- this one just runs at
// `npm run setup` time instead of CMake configure time, since there's no C++ build step to hang
// it off of for the renderer/main-process side.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { rootDirectory, run } from './developmentEnvironment.mjs';

const generatedDirectory = join(rootDirectory, 'src', 'generated');
await mkdir(generatedDirectory, { recursive: true });
// npm's local .bin wrapper: a plain (extension-less) shim on macOS/Linux, a .cmd shim on Windows.
const pbjsPath = join(rootDirectory, 'node_modules', '.bin', process.platform === 'win32' ? 'pbjs.cmd' : 'pbjs');
await run(pbjsPath, [
    '-t', 'static-module',
    '-w', 'esm',
    '-o', join(generatedDirectory, 'reportMessages.mjs'),
    join(rootDirectory, 'protocol', 'engineProtocol.proto')
]);
console.log('Generated src/generated/reportMessages.mjs from protocol/engineProtocol.proto.');
