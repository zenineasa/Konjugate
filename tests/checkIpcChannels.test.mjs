/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The IPC channel check (scripts/checkIpcChannels.mjs), on small source folders written for each case: a main process and a preload
// that match, and each kind of mismatch it reports; and on the app's own src/, which must match throughout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ipcChannelFindings } from '../scripts/checkIpcChannels.mjs';

// The findings for a source folder holding these files ({ 'main.mjs': text, 'preload.mjs': text, ... }), as { title: [channels] }.
async function findingsFor(t, files) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateIpc-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = join(directory, 'src');
    for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(source, path)), { recursive: true });
        await writeFile(join(source, path), text);
    }
    const { findings, counts } = await ipcChannelFindings(source);
    return { counts, found: Object.fromEntries(findings.map(({ title, entries }) => [title.split(' (')[0], entries.map((entry) => entry.split(/[\s:]/)[0])])) };
}

const matching = {
    'main.mjs': [
        "ipcMain.handle('projectSave', async () => true);",
        'ipcMain.on("rendererReady", () => {});',
        "window.webContents.send('runUpdate', {});",
        'const tellProjectWindows = (channel, value) => {',
        '    for (const window of windows) window.webContents.send(channel, value);',
        '};',
        "tellProjectWindows('pullProgress', 1);",
        "// ipcMain.handle('onlyInAComment', () => {});"
    ].join('\n'),
    'preload.mjs': [
        "const invokePlainly = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch(() => {});",
        "save: () => invokePlainly('projectSave'),",
        "ready: () => ipcRenderer.send('rendererReady'),",
        "onUpdate: (callback) => ipcRenderer.on('runUpdate', (_event, value) => callback(value)),",
        "onPull: (callback) => ipcRenderer.on('pullProgress', (_event, value) => callback(value)),"
    ].join('\n'),
    'renderer/page.mjs': "send('notIpc'); window.engine.save();"
};

test('a main process and a preload that agree on every channel, through wrappers and either quote, find nothing', async (t) => {
    const { found, counts } = await findingsFor(t, matching);
    assert.deepEqual(found, {});
    assert.deepEqual(counts, { handled: 2, asked: 2, sent: 2, heard: 2 }, 'A channel only named in a comment, or a page\'s own send(), is not one.');
});

test('each kind of mismatch is reported under its own heading, with the channel', async (t) => {
    const { found } = await findingsFor(t, {
        'main.mjs': [
            matching['main.mjs'],
            "ipcMain.handle('leftBehind', () => {});",
            "projectWindow.webContents.send('nobodyListens', 1);",
            "ipcMain.on('askedTheOtherWay', () => {});"
        ].join('\n'),
        'twinWindow/preload.cjs': [
            "ipcRenderer.invoke('nowhere');",
            "ipcRenderer.on('neverSent', () => {});",
            "ipcRenderer.invoke('askedTheOtherWay');"
        ].join('\n'),
        'preload.mjs': matching['preload.mjs']
    });
    assert.deepEqual(found, {
        'Asked for by a window, handled by nothing in the main process': ['nowhere'],
        'Handled in the main process, asked for by no window': ['leftBehind'],
        'Sent to windows, listened for by no window': ['nobodyListens'],
        'Listened for by a window, sent by nothing in the main process': ['neverSent'],
        'Asked for one way and handled another': ['askedTheOtherWay']
    });
});

test('a channel name the check cannot read is reported rather than guessed at', async (t) => {
    const { found } = await findingsFor(t, {
        ...matching,
        'main.mjs': `${matching['main.mjs']}\nfor (const channel of names) window.webContents.send(channel, 1);`,
        'addonPreload.cjs': 'const name = pick(); ipcRenderer.invoke(name);'
    });
    assert.deepEqual(Object.keys(found), ['Channel names this check cannot read']);
    assert.deepEqual(found['Channel names this check cannot read'].sort(), ['src/addonPreload.cjs', 'src/main.mjs'], 'Not even where a wrapper elsewhere takes a parameter of that name.');
});

test('the app\'s own channels all match', async () => {
    const { findings, counts } = await ipcChannelFindings(join(import.meta.dirname, '..', 'src'));
    assert.deepEqual(findings, []);
    assert.ok(counts.handled > 100 && counts.sent > 20, 'It found the app\'s channels to match.');
});
