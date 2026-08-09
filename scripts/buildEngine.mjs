// Copyright © 2026 Zenin Easa Panthakkalakath

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists, rootDirectory, run, vcpkgDirectory } from './developmentEnvironment.mjs';

const preset = process.argv.includes('--no-metis') ? 'development-no-metis' : 'development';
if (!await pathExists(join(vcpkgDirectory, 'scripts', 'buildsystems', 'vcpkg.cmake'))) {
    throw new Error('The development dependencies are not configured. Run npm run setup first.');
}
await run('cmake', ['--preset', preset], { cwd: join(rootDirectory, 'engine') });
await run('cmake', ['--build', '--preset', preset], { cwd: join(rootDirectory, 'engine') });

if (process.argv.includes('--install')) {
    const engineBuildDir = join(rootDirectory, 'out', preset === 'development-no-metis' ? 'engine-no-metis' : 'engine');
    const enginePackageDir = join(rootDirectory, 'out', 'packageResources', 'engine');
    await rm(enginePackageDir, { recursive: true, force: true });
    await run('cmake', ['--install', engineBuildDir, '--config', 'RelWithDebInfo', '--prefix', enginePackageDir]);
}
