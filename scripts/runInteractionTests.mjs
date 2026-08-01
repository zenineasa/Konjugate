/* Copyright © 2026 Zenin Easa Panthakkalakath */

import electronPath from 'electron';
import { spawn } from 'node:child_process';

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', '--interaction-test'], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit'
});

child.once('error', (error) => {
    console.error(error);
    process.exitCode = 1;
});
child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
});
