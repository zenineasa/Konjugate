/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { describeAssistantProgress } from '../src/assistantProgress.mjs';

test('before anything arrives the panel says it is waiting, with the elapsed time', () => {
    assert.equal(describeAssistantProgress({ attempt: 1, attempts: 3, phase: 'sending' }, 4.7).headline, 'Waiting for the model… (4 s)');
    assert.equal(describeAssistantProgress(null, 0).headline, 'Waiting for the model… (0 s)');
});

test('reasoning without output is "thinking"; output is "writing" with a character count', () => {
    assert.match(describeAssistantProgress({ phase: 'receiving', thinking: 'Let me see' }, 3).headline, /^The model is thinking…/);
    assert.match(describeAssistantProgress({ phase: 'receiving', thinking: 'x', outputCharacters: 1240 }, 3).headline, /writing the proposal… 1,240 characters/);
});

test('validation is its own stage', () => {
    assert.match(describeAssistantProgress({ phase: 'validating', outputCharacters: 500 }, 9).headline, /^Checking the proposal…/);
});

test('a repair attempt names its attempt and why the last proposal was rejected', () => {
    const { headline, notes } = describeAssistantProgress({ attempt: 2, attempts: 3, phase: 'sending', repairReason: 'Unknown symbol x.' }, 20);
    assert.match(headline, /^Attempt 2 of 3: Waiting for the model…/);
    assert.deepEqual(notes, ['The previous proposal was rejected, so the model was asked again: Unknown symbol x.']);
    assert.deepEqual(describeAssistantProgress({ attempt: 1, repairReason: 'stale' }, 1).notes, []);
});

test('progress reaches the panel over a channel main sends and the preload listens to, and the web shim stubs', async () => {
    const { readFile } = await import('node:fs/promises');
    const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    const [main, preload, shim] = await Promise.all([read('src/main.mjs'), read('src/preload.mjs'), read('src/renderer/webShims/misc.mjs')]);
    assert.ok(main.includes("send('aiProgress'"));
    assert.ok(preload.includes("ipcRenderer.on('aiProgress'"));
    assert.match(shim, /onProgress: \(\) => \{\}/);
});
