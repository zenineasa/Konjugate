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
// Invoked as a plain Node script via process.execPath, not through npm's node_modules/.bin shim:
// that shim is a .cmd file on Windows, and node's spawn() cannot execute a .cmd directly without
// shell: true (verified against a real Windows CI failure -- spawn EINVAL). pbjs's actual
// entrypoint is itself just a Node script (bin/pbjs, `#!/usr/bin/env node`), so running it
// through process.execPath sidesteps the .cmd/shell question entirely, on every platform.
const pbjsPath = join(rootDirectory, 'node_modules', 'protobufjs-cli', 'bin', 'pbjs');
await run(process.execPath, [
    pbjsPath,
    '-t', 'static-module',
    '-w', 'esm',
    '-o', join(generatedDirectory, 'reportMessages.mjs'),
    join(rootDirectory, 'protocol', 'engineProtocol.proto')
]);
console.log('Generated src/generated/reportMessages.mjs from protocol/engineProtocol.proto.');
