/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Disable FMU is retired (the single FMU workflow, stage 1): an FMU node is switched off as any node is, and nothing switches off the
// FMU itself. The main process and the windows cannot be started by a unit test, so this reads the sources and checks they agree;
// tests/fmiResolver.test.mjs checks that an FMU an older Konjugate listed as disabled still runs.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const block = (source, start, next) => {
    const from = source.indexOf(start);
    assert.ok(from >= 0, `${start} not found.`);
    const to = source.indexOf(next, from + start.length);
    return source.slice(from, to < 0 ? undefined : to);
};

test('the main process passes no disabled FMUs to a run, lists every FMU as enabled, and does not switch one off', async () => {
    const main = await read('src/main.mjs');
    assert.doesNotMatch(main, /disabledFmuKeys/, 'A run is given no list of disabled FMUs.');
    const list = block(main, "ipcMain.handle('packageList'", 'ipcMain.handle(');
    assert.doesNotMatch(list, /packageKey\('fmu'/, 'An FMU is never listed as disabled, whatever an older settings file says.');
    const setEnabled = block(main, "ipcMain.handle('packageSetEnabled'", 'ipcMain.handle(');
    assert.match(setEnabled, /packageType === 'fmu'/, 'Switching an FMU off is refused.');
});

test('no window offers to disable an FMU or leaves one out for being disabled', async () => {
    const renderer = await read('src/renderer/renderer.mjs');
    assert.doesNotMatch(renderer, /packageType === 'fmu' && entry\.enabled !== false/, 'FMUs are not filtered by an enabled flag.');
    // Extensions does not list FMUs at all (tests/fmuNotInExtensions.test.mjs), so it offers no Disable for one.
});
