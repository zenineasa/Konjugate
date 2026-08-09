// Copyright © 2026 Zenin Easa Panthakkalakath

import { join } from 'node:path';
import { rootDirectory, run } from './developmentEnvironment.mjs';

const engineDirectory = join(rootDirectory, 'out', 'engine');
const executable = join(engineDirectory, process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');

await run(process.execPath, [join(rootDirectory, 'scripts', 'buildEngine.mjs')]);
await run('ctest', ['--test-dir', engineDirectory, '-C', 'RelWithDebInfo', '--output-on-failure']);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'engineCompatibility.mjs'), executable]);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'numericalRegression.mjs'), executable]);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'edgeDirectionalityContract.mjs'), executable]);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'edgeNullStateIdContract.mjs'), executable]);
