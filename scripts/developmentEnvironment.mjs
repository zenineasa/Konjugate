// Copyright © 2026 Zenin Easa Panthakkalakath

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const vcpkgCommit = 'ce613c41372b23b1f51333815feb3edd87ef8a8b';
export const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
export const vcpkgDirectory = join(rootDirectory, '.tools', 'vcpkg');

export function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit', ...options });
        child.once('error', (error) => reject(new Error(`Could not run ${command}: ${error.message}`)));
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}.`)));
    });
}

export async function commandExists(command) {
    try {
        const locator = process.platform === 'win32' ? 'where.exe' : 'which';
        await run(locator, [command], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export async function pathExists(path) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

export function executablePath(name) {
    return join(vcpkgDirectory, process.platform === 'win32' ? `${name}.exe` : name);
}
