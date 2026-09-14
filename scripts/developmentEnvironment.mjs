// Copyright © 2026 Zenin Easa Panthakkalakath

import { execFileSync, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const vcpkgCommit = 'eaca4a577b6b678c6e10252754b6988a61746c19';
export const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
export const vcpkgDirectory = join(rootDirectory, '.tools', 'vcpkg');

// Pinned like vcpkgCommit above, for the same reason: a reproducible toolchain version rather
// than whatever "latest" happens to resolve to on a given day. Only needed for the web build (see
// docs/proposals/webEdition.md) -- ordinary desktop development never touches this.
export const emsdkVersion = '6.0.9';
export const emsdkDirectory = join(rootDirectory, '.tools', 'emsdk');

import { existsSync } from 'node:fs';

if (process.platform === 'win32') {
    const vsSearchDirs = [
        'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin',
        'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Tools\\MSVC\\14.51.36231\\bin\\Hostx64\\x64',
        'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin',
        'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin'
    ];
    for (const dir of vsSearchDirs) {
        if (existsSync(dir) && !process.env.PATH?.includes(dir)) {
            process.env.PATH = `${dir};${process.env.PATH ?? ''}`;
        }
    }

    const keepVars = ['SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'TEMP', 'TMP', 'PATH'];
    for (const envVar of ['VCPKG_KEEP_ENV_VARS', 'VCPKG_ENV_PASSTHROUGH_UNTRACKED']) {
        const current = process.env[envVar] ? process.env[envVar].split(';') : [];
        for (const v of keepVars) {
            if (!current.includes(v)) {
                current.push(v);
            }
        }
        process.env[envVar] = current.join(';');
    }
} else if (process.platform === 'darwin') {
    process.env.MACOSX_DEPLOYMENT_TARGET ??= '11.0';
}

// emsdk (the web build's only consumer of this) requires Python 3.10+, but macOS ships an older
// stub at /usr/bin/python3 (Xcode Command Line Tools, frozen at 3.9.x for a long time) that sits
// earlier on PATH than a newer Homebrew install at /opt/homebrew/bin or /usr/local/bin (Intel) --
// confirmed directly on a real machine: PATH listed /usr/bin before /opt/homebrew/bin, so the
// stub always won even with a perfectly good 3.14 installed. Same shape as this file's own
// Windows vsSearchDirs block above: search known install locations and prepend one that
// satisfies the requirement, rather than touching the user's actual shell configuration.
export function ensurePython310OrNewerOnPath() {
    if (process.platform === 'win32') return;
    const parseMinor = (versionOutput) => {
        const match = versionOutput.match(/Python (\d+)\.(\d+)/);
        return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
    };
    const satisfies = (version) => version && (version.major > 3 || (version.major === 3 && version.minor >= 10));

    const currentVersion = (() => {
        try {
            return parseMinor(execFileSync('python3', ['--version'], { encoding: 'utf8' }));
        } catch {
            return null;
        }
    })();
    if (satisfies(currentVersion)) return;

    const candidateDirs = ['/opt/homebrew/bin', '/usr/local/bin'];
    for (const dir of candidateDirs) {
        const candidate = join(dir, 'python3');
        if (!existsSync(candidate)) continue;
        try {
            if (satisfies(parseMinor(execFileSync(candidate, ['--version'], { encoding: 'utf8' })))) {
                process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
                return;
            }
        } catch {
            // Not a usable interpreter -- keep searching the remaining candidates.
        }
    }
    throw new Error(
        'The web build needs Python 3.10 or newer. macOS\'s bundled /usr/bin/python3 (Xcode Command Line ' +
        'Tools) is often older than that -- install a newer one (e.g. `brew install python3`) and retry.'
    );
}

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
