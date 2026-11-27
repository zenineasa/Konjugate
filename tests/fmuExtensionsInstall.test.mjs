/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Extensions › Install… with an .fmu does as Add › FMU does since FMI review #1: an FMU whose build differs from the one in the library
// with the same ID is installed beside it, and said; the very same archive is the library's copy, reused. It refused a newer build with
// the same ID as "already installed" (installFmuArchive at its default version 1.0.0). The handler runs in the Electron main process,
// which a unit test cannot start, so this reads the sources and checks the pieces agree; tests/fmuInstallOrReuse.test.mjs checks
// installOrReuseFmu itself.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
// The source of the handler or listener beginning at `start`, up to the next one at the same indentation.
const block = (source, start, next) => {
    const from = source.indexOf(start);
    assert.ok(from >= 0, `${start} not found.`);
    const to = source.indexOf(next, from + start.length);
    return source.slice(from, to < 0 ? undefined : to);
};

test('Extensions › Install… installs an .fmu as Add › FMU does: beside a differing build with the same ID, reusing the same archive', async () => {
    const main = await read('src/main.mjs');
    const install = block(main, "ipcMain.handle('packageInstall'", 'ipcMain.handle(');
    const fmuPart = block(install, "if (lowerPath.endsWith('.fmu'))", "const extension = ");
    assert.doesNotMatch(fmuPart, /installFmuArchive\(/, 'An .fmu is not installed at a fixed version, which refuses a newer build with the same ID.');
    assert.match(fmuPart, /installOrReuseFmu\(/, 'An .fmu goes through installOrReuseFmu, as Add › FMU does.');
    assert.match(fmuPart, /reused:\s*installed\.reused/, 'The window is told the library\'s copy was reused.');
    assert.match(fmuPart, /besideVersion:\s*installed\.besideVersion/, 'The window is told which build it went beside.');
});

test('the Extensions window says when an installed FMU went beside another build, or was already in the library', async () => {
    const renderer = await read('src/renderer/renderer.mjs');
    const listener = block(renderer, "$('#extensionsInstall').addEventListener('click'", "$('#extensionsDiscoverInstall')");
    assert.match(listener, /fmuBesideNote\(installed\)/, 'A build kept beside another with the same ID is said, as Add › FMU says it.');
    assert.match(listener, /installed\.reused/, 'An FMU already in the library is said to be the library\'s copy.');
});
