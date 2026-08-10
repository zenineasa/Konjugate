// Copyright © 2026 Zenin Easa Panthakkalakath

// Runs the same --interaction-test suite scripts/runInteractionTests.mjs runs, but against the
// packaged app binary instead of the dev Electron launch. main.mjs's resolveEnginePath() has a
// dedicated packaged-resource code path (packaged: app.isPackaged) that the dev-mode suite never
// exercises; likewise example/add-on discovery, icon loading, and anything else resolved
// relative to the app's on-disk layout differs between an unpackaged checkout and an asar/
// resources bundle. Requires a package built for the host platform -- run `make packageApp` (or
// the platform-specific target) first; this does not build one itself.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootDirectory } from './developmentEnvironment.mjs';
import { packagedAppExecutable } from './packagedPaths.mjs';

const executable = packagedAppExecutable(rootDirectory);
if (!existsSync(executable)) {
    throw new Error(`No packaged app binary found at ${executable}. Run "make packageApp" (or the platform-specific package target) first.`);
}

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const userDataDirectory = await mkdtemp(join(tmpdir(), 'konjugate-packaged-interaction-'));
environment.KONJUGATE_INTERACTION_USER_DATA = userDataDirectory;
const child = spawn(executable, ['--interaction-test', '--disable-gpu', '--enable-unsafe-swiftshader'], {
    cwd: rootDirectory,
    env: environment,
    stdio: 'inherit'
});

child.once('error', (error) => {
    console.error(error);
    process.exitCode = 1;
});
child.once('exit', (code, signal) => {
    rm(userDataDirectory, { recursive: true, force: true }).finally(() => {
        process.exitCode = code ?? (signal ? 1 : 0);
    });
});
