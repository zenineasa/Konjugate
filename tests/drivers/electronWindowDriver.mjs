/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Electron half of the interaction-test suite's driver split (see
// playwrightWebDriver.mjs's own header comment for the other half, and
// tests/interactionRunner.mjs's own top-of-file comment for the shared "handle" contract both
// drivers implement). This file is a mechanical lift of logic tests/interactionRunner.mjs already
// had inline before the split -- wrapping a BrowserWindow's webContents.executeJavaScript/
// sendInputEvent calls, dialog.showSaveDialog stubbing, and BrowserWindow.getAllWindows() polling
// into the shared handle/driver shape -- not new behavior.

import { app, BrowserWindow, dialog } from 'electron';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One handle per BrowserWindow, cached by identity so the same raw window always maps back to the
// same handle object -- scenario code compares handles by reference (e.g. `excluding: [window]`,
// `candidate !== someHandle`), which only works if wrapping is idempotent.
const handlesByWindow = new WeakMap();

function wrapWindow(win) {
    let handle = handlesByWindow.get(win);
    if (handle) return handle;
    handle = {
        async evaluate(expression) {
            return win.webContents.executeJavaScript(expression, true);
        },
        async mouseMove(point, { modifiers = [] } = {}) {
            win.webContents.sendInputEvent({ type: 'mouseMove', ...point, modifiers });
        },
        async mouseDown(point, { button = 'left', clickCount = 1, modifiers = [] } = {}) {
            win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button, clickCount, modifiers });
        },
        async mouseUp(point, { button = 'left', clickCount = 1, modifiers = [] } = {}) {
            win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button, clickCount, modifiers });
        },
        async click(point, { modifiers = [] } = {}) {
            await handle.mouseMove(point, { modifiers });
            await handle.mouseDown(point, { button: 'left', clickCount: 1, modifiers });
            await handle.mouseUp(point, { button: 'left', clickCount: 1, modifiers });
        },
        async rightClick(point, { modifiers = [] } = {}) {
            await handle.mouseMove(point, { modifiers });
            await handle.mouseDown(point, { button: 'right', clickCount: 1, modifiers });
            await handle.mouseUp(point, { button: 'right', clickCount: 1, modifiers });
        },
        async keyDown(keyCode) {
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        },
        async keyUp(keyCode) {
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
        },
        onConsoleMessage(listener) {
            const wrapped = (event) => listener(event.message);
            win.webContents.on('console-message', wrapped);
            return () => win.webContents.off('console-message', wrapped);
        },
        async title() {
            return win.getTitle();
        },
        async close() {
            win.close();
        },
        async isDestroyed() {
            return win.isDestroyed();
        },
        parent() {
            const parentWindow = win.getParentWindow();
            return parentWindow ? wrapWindow(parentWindow) : null;
        },
        // Internal only -- used by allHandles()/waitForNewHandle() to compare against the raw
        // BrowserWindow.getAllWindows() list without re-deriving it from the handle itself.
        _raw: win
    };
    handlesByWindow.set(win, handle);
    return handle;
}

export function createElectronDriver(mainWindow) {
    const mainHandle = wrapWindow(mainWindow);

    return {
        kind: 'electron',
        mainHandle,
        allHandles() {
            return BrowserWindow.getAllWindows().map(wrapWindow);
        },
        async waitForNewHandle(existingHandles, { titleIncludes, excluding = [] } = {}, timeoutMs = 5000) {
            const excludedRaws = new Set([...existingHandles, ...excluding].map((handle) => handle._raw));
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeoutMs) {
                const candidates = BrowserWindow.getAllWindows().filter((win) => !excludedRaws.has(win));
                for (const win of candidates) {
                    if (titleIncludes && !win.getTitle().includes(titleIncludes)) continue;
                    return wrapWindow(win);
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error(`No new window appeared${titleIncludes ? ` with a title including "${titleIncludes}"` : ''} within ${timeoutMs}ms.`);
        },
        async captureExport(trigger, { extension = 'bin', maxAttempts = 100, intervalMs = 25 } = {}) {
            const exportPath = join(tmpdir(), `konjugate-interaction-export-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);
            const originalShowSaveDialog = dialog.showSaveDialog;
            dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
            try {
                await trigger();
                let bytes = null;
                for (let attempt = 0; attempt < maxAttempts && bytes === null; attempt += 1) {
                    try { bytes = await readFile(exportPath); } catch { await new Promise((resolve) => setTimeout(resolve, intervalMs)); }
                }
                if (!bytes) throw new Error(`Export did not write a file at ${exportPath}.`);
                return { path: exportPath, bytes };
            } finally {
                dialog.showSaveDialog = originalShowSaveDialog;
            }
        },
        async simulateOsFileOpen(path) {
            app.emit('open-file', { preventDefault() {} }, path);
        },
        capabilities: {
            multiWindow: true,
            osFileOpen: true,
            addons: true,
            fmuExport: true,
            aiProviderCredentials: true,
            providerExecutionModeSelector: true,
            cppProviders: true,
            renderedExampleGuide: true,
            aiAssistant: true
        },
        async dispose() {
            // Nothing to tear down -- the suite's own caller (src/main.mjs) owns the app/window
            // lifecycle, exactly as it did before this driver existed.
        }
    };
}
