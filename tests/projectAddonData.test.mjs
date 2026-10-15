/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { keepAddonData, requestAddonData } from '../src/projectAddonData.mjs';

// A project window that records what it was sent, and an ipcMain to answer on.
function fakes() {
    const ipcMain = new EventEmitter();
    const sent = [];
    const projectWindow = { webContents: { send: (channel, payload) => sent.push({ channel, payload }) } };
    return { ipcMain, projectWindow, sent };
}

test('two requests in flight at once each get their own answer, whoever asked', async () => {
    const { ipcMain, projectWindow, sent } = fakes();
    // A launcher and a visualizer ask the same window at the same moment.
    const launcher = requestAddonData({ ipcMain, projectWindow, addonId: 'example.launcher' });
    const visualizer = requestAddonData({ ipcMain, projectWindow, addonId: 'example.visualizer' });
    const [first, second] = sent.map(({ payload }) => payload);
    assert.notEqual(first.requestId, second.requestId);
    ipcMain.emit('launcherAddonDataReply', { sender: projectWindow.webContents }, { requestId: second.requestId, data: 'visualizer data' });
    ipcMain.emit('launcherAddonDataReply', { sender: projectWindow.webContents }, { requestId: first.requestId, data: 'launcher data' });
    assert.equal(await launcher, 'launcher data');
    assert.equal(await visualizer, 'visualizer data');
    assert.equal(ipcMain.listenerCount('launcherAddonDataReply'), 0);
});

test('an answer from another window is ignored, and no answer at all is null', async () => {
    const { ipcMain, projectWindow, sent } = fakes();
    const pending = requestAddonData({ ipcMain, projectWindow, addonId: 'example.visualizer', timeoutMilliseconds: 20 });
    ipcMain.emit('launcherAddonDataReply', { sender: {} }, { requestId: sent[0].payload.requestId, data: 'not yours' });
    assert.equal(await pending, null);
    assert.equal(ipcMain.listenerCount('launcherAddonDataReply'), 0);
});

test('keeping data sends the entry to the project window', () => {
    const { projectWindow, sent } = fakes();
    keepAddonData(projectWindow, 'example.visualizer', null);
    assert.deepEqual(sent, [{ channel: 'launcherKeepAddonData', payload: { addonId: 'example.visualizer', entry: null } }]);
});
