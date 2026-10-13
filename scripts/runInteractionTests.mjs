/* Copyright © 2026 Zenin Easa Panthakkalakath */

import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installInteractionAddons } from './interactionAddons.mjs';

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const userDataDirectory = await mkdtemp(join(tmpdir(), 'konjugate-interaction-'));
environment.KONJUGATE_INTERACTION_USER_DATA = userDataDirectory;
environment.KONJUGATE_INTERACTION_INSTALLED_ADDONS = (await installInteractionAddons(process.cwd(), userDataDirectory)).join(',');
// --use-mock-keychain: listing model configurations asks Electron's safeStorage whether encryption is
// available, which on macOS looks up (or creates) an item in the login Keychain and prompts for access.
// The tests do not need the real Keychain, so Chromium's mock one keeps them from asking.
const child = spawn(electronPath, ['.', '--interaction-test', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-mock-keychain'], {
    cwd: process.cwd(),
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
