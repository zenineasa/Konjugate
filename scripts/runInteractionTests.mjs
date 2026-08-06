/* Copyright © 2026 Zenin Easa Panthakkalakath */

import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const userDataDirectory = await mkdtemp(join(tmpdir(), 'konjugate-interaction-'));
environment.KONJUGATE_INTERACTION_USER_DATA = userDataDirectory;
const child = spawn(electronPath, ['.', '--interaction-test', '--disable-gpu'], {
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
