/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { auxiliaryWindowPresentation, senderOwnsWindow } from '../src/windowLifecycle.mjs';

test('identifies a window by its stable WebContents id rather than wrapper identity', () => {
    const window = { isDestroyed: () => false, webContents: { id: 42 } };
    assert.equal(senderOwnsWindow({ id: 42 }, window), true);
    assert.equal(senderOwnsWindow({ id: 41 }, window), false);
    assert.equal(senderOwnsWindow({ id: 42 }, { ...window, isDestroyed: () => true }), false);
});

test('opens macOS full-screen auxiliary windows independently in their own Space', () => {
    const mainWindow = { isDestroyed: () => false, isFullScreen: () => true };
    assert.deepEqual(auxiliaryWindowPresentation(mainWindow, 'darwin'), { fullscreen: true });
    assert.deepEqual(auxiliaryWindowPresentation(mainWindow, 'win32'), { parent: mainWindow });
    mainWindow.isFullScreen = () => false;
    assert.deepEqual(auxiliaryWindowPresentation(mainWindow, 'darwin'), { parent: mainWindow });
});
