// Copyright © 2026 Zenin Easa Panthakkalakath

// Linux-only (see engine/CMakePresets.json's "sanitize" preset condition): builds the engine with
// ASan+UBSan and runs it through the same C++ unit tests (ctest) plus the same executable-driven
// contract/regression scripts testEngine.mjs runs against an ordinary build, so a real
// use-after-free, buffer overrun or undefined-behavior violation exercised by any of them aborts
// the process instead of silently passing. checkNodeProviderExample.mjs is intentionally not
// included here -- it exercises the Python provider runtime, not the C++ engine binary, so a
// sanitized rebuild of konjugateEngine wouldn't change its behavior.

import { join } from 'node:path';
import { rootDirectory, run } from './developmentEnvironment.mjs';

const engineDirectory = join(rootDirectory, 'out', 'engine-sanitize');
const executable = join(engineDirectory, 'konjugateEngine');

await run(process.execPath, [join(rootDirectory, 'scripts', 'buildEngine.mjs'), '--sanitize']);
await run('ctest', ['--test-dir', engineDirectory, '-C', 'Debug', '--output-on-failure']);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'engineCompatibility.mjs'), executable, 'no-metis']);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'numericalRegression.mjs'), executable]);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'edgeDirectionalityContract.mjs'), executable]);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'edgeNullStateIdContract.mjs'), executable]);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'disabledEntityContract.mjs'), executable]);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'continuousTimeDrift.mjs'), executable]);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'causalInferenceCommitAndRun.mjs'), executable]);
