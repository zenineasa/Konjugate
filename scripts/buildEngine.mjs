// Copyright © 2026 Zenin Easa Panthakkalakath

import { join } from 'node:path';
import { pathExists, rootDirectory, run, vcpkgDirectory } from './developmentEnvironment.mjs';

const preset = process.argv.includes('--no-metis') ? 'development-no-metis' : 'development';
if (!await pathExists(join(vcpkgDirectory, 'scripts', 'buildsystems', 'vcpkg.cmake'))) {
    throw new Error('The development dependencies are not configured. Run npm run setup first.');
}
await run('cmake', ['--preset', preset], { cwd: join(rootDirectory, 'engine') });
await run('cmake', ['--build', '--preset', preset], { cwd: join(rootDirectory, 'engine') });
