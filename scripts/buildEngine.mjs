// Copyright © 2026 Zenin Easa Panthakkalakath

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists, rootDirectory, run, vcpkgDirectory } from './developmentEnvironment.mjs';

// --sanitize builds engine-sanitize/ with ASan+UBSan (Linux only -- see engine/CMakePresets.json)
// for local reproduction of what the sanitize CI job runs; it is never combined with --install
// since a sanitizer-instrumented binary is a diagnostic build, not something to package.
const preset = process.argv.includes('--sanitize') ? 'sanitize' :
    process.argv.includes('--no-metis') ? 'development-no-metis' : 'development';
const presetBinaryDirName = { development: 'engine', 'development-no-metis': 'engine-no-metis', sanitize: 'engine-sanitize' }[preset];
if (!await pathExists(join(vcpkgDirectory, 'scripts', 'buildsystems', 'vcpkg.cmake'))) {
    throw new Error('The development dependencies are not configured. Run npm run setup first.');
}
await run('cmake', ['--preset', preset], { cwd: join(rootDirectory, 'engine') });
await run('cmake', ['--build', '--preset', preset], { cwd: join(rootDirectory, 'engine') });

// Regenerated on every engine build, same as protobuf_generate_cpp() above regenerates the C++
// side on every `cmake --build` -- keeps src/generated/reportMessages.mjs from ever silently
// drifting out of sync with protocol/engineProtocol.proto after an edit to it.
await run(process.execPath, [join(rootDirectory, 'scripts', 'generateReportProtocol.mjs')]);

if (process.argv.includes('--install')) {
    const engineBuildDir = join(rootDirectory, 'out', presetBinaryDirName);
    const enginePackageDir = join(rootDirectory, 'out', 'packageResources', 'engine');
    await rm(enginePackageDir, { recursive: true, force: true });
    await run('cmake', ['--install', engineBuildDir, '--config', 'RelWithDebInfo', '--prefix', enginePackageDir]);
}
