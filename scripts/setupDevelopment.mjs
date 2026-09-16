// Copyright © 2026 Zenin Easa Panthakkalakath

import { join } from 'node:path';
import {
    commandExists,
    ensureVcpkgBootstrapped,
    rootDirectory,
    run
} from './developmentEnvironment.mjs';

for (const command of ['cmake', 'git']) {
    if (!await commandExists(command)) {
        throw new Error(`${command} is required. See docs/developmentSetup.md for the platform prerequisites.`);
    }
}

const compilerCommand = process.platform === 'win32' ? 'cl' : 'c++';
if (!await commandExists(compilerCommand)) {
    const hint = process.platform === 'win32'
        ? 'Run setup from a Visual Studio Developer PowerShell or Developer Command Prompt.'
        : 'Install the platform C++ compiler described in docs/developmentSetup.md.';
    throw new Error(`A C++20 compiler is required. ${hint}`);
}

await ensureVcpkgBootstrapped();

await run('cmake', ['--preset', 'development'], { cwd: join(rootDirectory, 'engine') });
await run(process.execPath, [join(rootDirectory, 'scripts', 'generateReportProtocol.mjs')]);
console.log('Development dependencies are configured. Run npm run dev to build and start Konjugate.');
