/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { auxiliaryWindowBounds, auxiliaryWindowPresentation } from '../src/windowLifecycle.mjs';

test('opens macOS full-screen auxiliary windows independently in their own Space', () => {
    const mainWindow = { isDestroyed: () => false, isFullScreen: () => true };
    assert.deepEqual(auxiliaryWindowPresentation(mainWindow, 'darwin'), { fullscreen: true });
    assert.deepEqual(auxiliaryWindowPresentation(mainWindow, 'win32'), { parent: mainWindow });
    mainWindow.isFullScreen = () => false;
    assert.deepEqual(auxiliaryWindowPresentation(mainWindow, 'darwin'), { parent: mainWindow });
});

// A menu bar 25px tall sits above this work area, matching a typical macOS display.
const workArea = { x: 0, y: 25, width: 1440, height: 875 };
const fakeScreen = { getPrimaryDisplay: () => ({ workArea }), getDisplayMatching: () => ({ workArea }) };

test('auxiliaryWindowBounds centers on the parent when nothing is saved', () => {
    assert.deepEqual(auxiliaryWindowBounds(null, 720, 760, null, fakeScreen), { x: 360, y: 83, width: 720, height: 760 });
});

test('auxiliaryWindowBounds clamps default centering below the menu bar when the parent sits flush against the screen top', () => {
    const mainWindow = { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 1440, height: 800 }) };
    const bounds = auxiliaryWindowBounds(mainWindow, 720, 760, null, fakeScreen);
    assert.equal(bounds.y, workArea.y);
});

test('auxiliaryWindowBounds leaves a valid saved position untouched', () => {
    const saved = { x: 100, y: 100, width: 600, height: 500 };
    assert.deepEqual(auxiliaryWindowBounds(null, 720, 760, saved, fakeScreen), saved);
});

test('auxiliaryWindowBounds clamps a saved position left over from a moved or disconnected display', () => {
    const saved = { x: 100, y: -600, width: 600, height: 500 };
    const bounds = auxiliaryWindowBounds(null, 720, 760, saved, fakeScreen);
    assert.equal(bounds.y, workArea.y);
    assert.equal(bounds.x, saved.x);
});
