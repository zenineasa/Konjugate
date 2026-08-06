// Copyright © 2026 Zenin Easa Panthakkalakath

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
    commandExists,
    executablePath,
    pathExists,
    rootDirectory,
    run,
    vcpkgCommit,
    vcpkgDirectory
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

let isPartialClone = false;
if (await pathExists(join(vcpkgDirectory, '.git'))) {
    try {
        await run('git', ['config', '--get', 'remote.origin.promisor'], { cwd: vcpkgDirectory, stdio: 'ignore' });
        isPartialClone = true;
    } catch {
        isPartialClone = false;
    }
}
if (isPartialClone) {
    console.log('Re-cloning vcpkg fully to avoid Windows network subprocess issues...');
    await rm(vcpkgDirectory, { recursive: true, force: true });
}

if (!await pathExists(join(vcpkgDirectory, '.git'))) {
    await mkdir(join(rootDirectory, '.tools'), { recursive: true });
    await run('git', [
        'clone', '--no-checkout',
        'https://github.com/microsoft/vcpkg.git', vcpkgDirectory
    ]);
}

let hasPinnedCommit = true;
try {
    await run('git', ['cat-file', '-e', `${vcpkgCommit}^{commit}`], { cwd: vcpkgDirectory, stdio: 'ignore' });
} catch {
    hasPinnedCommit = false;
}
if (!hasPinnedCommit) {
    await run('git', ['fetch', '--depth', '1', 'origin', vcpkgCommit], { cwd: vcpkgDirectory });
}
await run('git', ['checkout', '--detach', vcpkgCommit], { cwd: vcpkgDirectory });

if (!await pathExists(executablePath('vcpkg'))) {
    const bootstrap = process.platform === 'win32' ? 'bootstrap-vcpkg.bat' : './bootstrap-vcpkg.sh';
    const shell = process.platform === 'win32' ? 'cmd.exe' : bootstrap;
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', bootstrap, '-disableMetrics'] : ['-disableMetrics'];
    await run(shell, args, { cwd: vcpkgDirectory });
}

await run('cmake', ['--preset', 'development'], { cwd: join(rootDirectory, 'engine') });
console.log('Development dependencies are configured. Run npm run dev to build and start Konjugate.');
