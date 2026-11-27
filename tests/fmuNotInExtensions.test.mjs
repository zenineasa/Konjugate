/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Extensions does not list FMUs (the single FMU workflow, stage 3): an FMU is added to a model with Add › FMU… and looked after on its
// node's card and in Settings › Providers, so Extensions has no FMUs tab, no FMU detail and no Add to model. The window cannot be
// started by a unit test, so this reads its sources.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the Extensions window has no FMUs tab, FMU detail or Add to model', async () => {
    const html = await read('src/renderer/index.html');
    assert.doesNotMatch(html, /data-extensions-tab="fmu"/, 'No FMUs tab.');
    assert.doesNotMatch(html, /id="extensionsDetailFmu"/, 'No FMU detail.');
    assert.doesNotMatch(html, /id="extensionsAddFmuToModel"/, 'No Add to model.');
});

test('the Extensions list leaves FMUs out, while the Add menu still reads them from the library', async () => {
    const renderer = await read('src/renderer/renderer.mjs');
    const from = renderer.indexOf('async function refreshExtensionsList()');
    const refresh = renderer.slice(from, renderer.indexOf('\n}\n', from));
    assert.match(refresh, /packageType !== 'fmu'/, 'The list Extensions shows has no FMUs.');
    assert.doesNotMatch(renderer, /extensionsAddFmuToModel|extensionsDetailFmu/, 'Nothing refers to what was removed.');
    assert.match(renderer, /\.filter\(\(entry\) => entry\.packageType === 'fmu'\)\.slice\(0, 24\)/, 'Add › FMU… still offers the library\'s FMUs.');
});
