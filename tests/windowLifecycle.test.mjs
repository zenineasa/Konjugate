/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { auxiliaryWindowPresentation } from '../src/windowLifecycle.mjs';

test('opens macOS full-screen auxiliary windows independently in their own Space', () => {
    const mainWindow = { isDestroyed: () => false, isFullScreen: () => true };
    assert.deepEqual(auxiliaryWindowPresentation(mainWindow, 'darwin'), { fullscreen: true });
    assert.deepEqual(auxiliaryWindowPresentation(mainWindow, 'win32'), { parent: mainWindow });
    mainWindow.isFullScreen = () => false;
    assert.deepEqual(auxiliaryWindowPresentation(mainWindow, 'darwin'), { parent: mainWindow });
});
