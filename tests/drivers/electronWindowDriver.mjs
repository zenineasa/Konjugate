/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Electron half of the interaction-test suite's driver split (see
// playwrightWebDriver.mjs's own header comment for the other half, and
// tests/interactionRunner.mjs's own top-of-file comment for the shared "handle" contract both
// drivers implement). This file is a mechanical lift of logic tests/interactionRunner.mjs already
// had inline before the split -- wrapping a BrowserWindow's webContents.executeJavaScript/
// sendInputEvent calls, dialog.showSaveDialog stubbing, and BrowserWindow.getAllWindows() polling
// into the shared handle/driver shape -- not new behavior.

import { app, BrowserWindow, dialog } from 'electron';
import { mkdtemp, readFile } from 'node:fs/promises';
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
        // Brings the window in front of the others: a window behind another may report itself hidden, and the canvas
        // does not draw while it is.
        async focus() {
            win.show();
            win.focus();
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

// The operating system's own dialogs (save, open, a message box) cannot be clicked by a test, and one left open stays on the
// screen for the rest of the run and after it. While the tests run, each is answered as a person backing out would: a save or an
// open cancelled, a message box with its cancel button. Each is recorded, so the runner can say which test asked for one. A test
// that needs an answer (captureExport) sets its own for as long as it needs it.
const nativeDialogs = [];
function answerNativeDialogs() {
    const options = (args) => (args[0] && typeof args[0] === 'object' && !('webContents' in args[0]) ? args[0] : args[1]) ?? {};
    const record = (kind, args) => nativeDialogs.push({ kind, title: options(args).title ?? options(args).message ?? '' });
    dialog.showSaveDialog = async (...args) => { record('save', args); return { canceled: true, filePath: undefined }; };
    dialog.showOpenDialog = async (...args) => { record('open', args); return { canceled: true, filePaths: [] }; };
    dialog.showMessageBox = async (...args) => {
        record('message', args);
        const { cancelId, buttons = [] } = options(args);
        const cancel = cancelId ?? buttons.findIndex((label) => /cancel|^no\b|don.t|keep/i.test(label));
        return { response: cancel >= 0 ? cancel : 0, checkboxChecked: false };
    };
    dialog.showSaveDialogSync = (...args) => { record('save', args); return undefined; };
    dialog.showOpenDialogSync = (...args) => { record('open', args); return undefined; };
    dialog.showMessageBoxSync = (...args) => { record('message', args); return options(args).cancelId ?? 0; };
}

export function createElectronDriver(mainWindow) {
    const mainHandle = wrapWindow(mainWindow);
    answerNativeDialogs();

    return {
        // The native dialogs asked for since the last call, each answered as cancelled.
        takeNativeDialogs() {
            return nativeDialogs.splice(0);
        },
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
        // fileName: the file the save dialog is answered with, in a folder of its own (a project is named after its file).
        async captureExport(trigger, { extension = 'bin', fileName = null, maxAttempts = 100, intervalMs = 25 } = {}) {
            const exportPath = fileName
                ? join(await mkdtemp(join(tmpdir(), 'konjugate-interaction-export-')), fileName)
                : join(tmpdir(), `konjugate-interaction-export-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);
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
            parameterWaveforms: true,
            startPausedRuns: true,
            heldCommands: true,
            forks: true,
            fitProgress: true,
            renderedExampleGuide: true,
            aiAssistant: true,
            cancellableValidation: true
        },
        async dispose() {
            // Nothing to tear down -- the suite's own caller (src/main.mjs) owns the app/window
            // lifecycle, exactly as it did before this driver existed.
        }
    };
}
