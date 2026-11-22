/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Electron half of the interaction-test suite's driver split (see
// playwrightWebDriver.mjs's own header comment for the other half, and
// tests/interactionRunner.mjs's own top-of-file comment for the shared "handle" contract both
// drivers implement). This file is a mechanical lift of logic tests/interactionRunner.mjs already
// had inline before the split -- wrapping a BrowserWindow's webContents.executeJavaScript/
// sendInputEvent calls, dialog.showSaveDialog stubbing, and BrowserWindow.getAllWindows() polling
// into the shared handle/driver shape -- not new behavior.

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One handle per BrowserWindow, cached by identity so the same raw window always maps back to the
// same handle object -- scenario code compares handles by reference (e.g. `excluding: [window]`,
// `candidate !== someHandle`), which only works if wrapping is idempotent.
const handlesByWindow = new WeakMap();
// The coverage being taken, when it is (see createRendererCoverage), so a handle can take a window's counts before closing it.
let windowCoverage = null;

function wrapWindow(win) {
    let handle = handlesByWindow.get(win);
    if (handle) return handle;
    handle = {
        // A script that closes its own window (a guide's "Take the tutorial" button, which the main process answers by
        // closing the guide) can take the reply with it, and executeJavaScript's promise then never settles. The window
        // going away ends the wait instead: with the script's answer if it came first, else with an error naming why.
        async evaluate(expression) {
            const contents = win.webContents;
            if (contents.isDestroyed()) throw new Error('The window was closed before the script could run.');
            let onGone;
            const gone = new Promise((resolve, reject) => {
                onGone = () => reject(new Error('The window closed before the script answered.'));
                contents.once('destroyed', onGone);
            });
            gone.catch(() => {}); // the script answered first; the window closing later is nothing to report
            try {
                return await Promise.race([contents.executeJavaScript(expression, true), gone]);
            } finally {
                if (!contents.isDestroyed()) contents.removeListener('destroyed', onGone);
            }
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
        // Takes the window out of sight without minimizing it, for where minimizing does nothing (see canMinimize).
        async hide() {
            win.hide();
        },
        async close() {
            await windowCoverage?.take(win);
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

// Whether a window can be minimized here, found once by minimizing a throwaway window: minimizing is the window manager's to do, and a
// display with none (Linux CI's bare Xvfb) leaves the window as it was. Said in the run's output, so a run shows what it found.
let minimizeProbe = null;
function probeMinimize() {
    minimizeProbe ??= (async () => {
        const probe = new BrowserWindow({ width: 200, height: 120, show: false, title: 'Minimize probe' });
        try {
            await probe.loadURL('about:blank');
            probe.showInactive();
            await new Promise((resolve) => setTimeout(resolve, 200));
            probe.minimize();
            // macOS animates the window into the Dock: about half a second.
            for (const until = Date.now() + 3000; !probe.isMinimized() && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 100));
            const minimizes = probe.isMinimized();
            console.log(`  (this display ${minimizes ? 'minimizes windows' : 'does not minimize windows (no window manager?): a window is hidden instead where a test would minimize it'}; ${process.platform})`);
            return minimizes;
        } finally {
            if (!probe.isDestroyed()) probe.destroy();
        }
    })();
    return minimizeProbe;
}

// The operating system's own dialogs (save, open, a message box) cannot be clicked by a test, and one left open stays on the
// screen for the rest of the run and after it. While the tests run, each is answered as a person backing out would: a save or an
// open cancelled, a message box with its cancel button. Each is recorded, so the runner can say which test asked for one. A test
// that needs an answer (captureExport) sets its own for as long as it needs it.
const nativeDialogs = [];
// A dialog's options: Electron takes them second when a window is given first.
const dialogOptions = (args) => (args[0] && typeof args[0] === 'object' && !('webContents' in args[0]) ? args[0] : args[1]) ?? {};
function answerNativeDialogs() {
    const options = dialogOptions;
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

// With KONJUGATE_INTERACTION_COVERAGE set to a folder, every window's code is measured while the scenarios run (V8's precise
// coverage, through each window's debugger) and written there as renderer-<n>.json files, for scripts/coverageReport.mjs. A
// window is measured from when it is created, so its modules' top-level code counts; the project window, open before the
// scenarios start, is loaded again once measuring has started. A window's counts are taken when the driver closes it, when it
// closes by itself (taken as it starts to close, so a little at the very end may be missed), and from every window still open
// when the scenarios finish. Taking counts resets them, so the files add up rather than repeat.
function createRendererCoverage(directory) {
    const measured = new Set();
    const pending = new Set();
    let written = 0;

    async function begin(win) {
        if (measured.has(win) || win.isDestroyed()) return;
        measured.add(win);
        const contents = win.webContents;
        try {
            if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
            await contents.debugger.sendCommand('Profiler.enable');
            await contents.debugger.sendCommand('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
        } catch {
            measured.delete(win);
            return;
        }
        win.once('close', () => { take(win); });
    }

    // Takes the window's counts so far and writes them; never fails a scenario.
    function take(win) {
        if (!measured.has(win) || win.isDestroyed()) return Promise.resolve();
        const contents = win.webContents;
        const taking = (async () => {
            try {
                const { result } = await contents.debugger.sendCommand('Profiler.takePreciseCoverage');
                // Numbered before anything else is awaited: two windows' counts taken at once must not share a file.
                written += 1;
                const file = join(directory, `renderer-${written}.json`);
                await mkdir(directory, { recursive: true });
                await writeFile(file, JSON.stringify({ result }));
            } catch { /* the window went before its counts could be taken */ }
        })();
        pending.add(taking);
        taking.finally(() => pending.delete(taking));
        return taking;
    }

    return {
        async start(mainWindow) {
            app.on('browser-window-created', (_event, win) => { begin(win); });
            for (const win of BrowserWindow.getAllWindows()) if (win !== mainWindow) await begin(win);
            await begin(mainWindow);
            await new Promise((resolve) => { mainWindow.webContents.once('did-finish-load', resolve); mainWindow.webContents.reload(); });
        },
        take,
        async finish() {
            await Promise.all(BrowserWindow.getAllWindows().map(take));
            await Promise.all([...pending]);
        }
    };
}

// Restarting Konjugate (to start an add-on just installed) relaunches the app and exits this one, which would end the suite with
// it, and leave the relaunched copy running the suite again on its own. For the tests it is done in place instead: the other
// windows closed and the project window loaded again, as a restarted Konjugate opens it, so what carries on after a restart (a
// tutorial at the step it was on) is still what is tested, and the window the scenarios hold stays the same.
function restartInPlace(mainWindow) {
    ipcMain.removeHandler('applicationRestart');
    ipcMain.handle('applicationRestart', () => {
        console.log('  (Konjugate was restarted in place: its other windows closed and the project window loaded again)');
        for (const win of BrowserWindow.getAllWindows()) if (win !== mainWindow && !win.isDestroyed()) win.destroy();
        mainWindow.webContents.reload();
    });
}

export function createElectronDriver(mainWindow) {
    const mainHandle = wrapWindow(mainWindow);
    answerNativeDialogs();
    restartInPlace(mainWindow);
    const coverage = process.env.KONJUGATE_INTERACTION_COVERAGE ? createRendererCoverage(process.env.KONJUGATE_INTERACTION_COVERAGE) : null;
    windowCoverage = coverage;

    return {
        // Before the first scenario, and after the last.
        async prepare() {
            await coverage?.start(mainWindow);
        },
        async finish() {
            await coverage?.finish();
        },
        // The native dialogs asked for since the last call, each answered as cancelled.
        takeNativeDialogs() {
            return nativeDialogs.splice(0);
        },
        kind: 'electron',
        mainHandle,
        allHandles() {
            return BrowserWindow.getAllWindows().map(wrapWindow);
        },
        // The app's window in front, the one a person sees and types into. A test's windows are often not in the active app, which
        // then has no focused window: the app is made active first, which focuses the one in front.
        // The system can take a moment to hand the app the front (longer while another app is busy in front of it), so it is asked again.
        async focusedHandle() {
            for (let attempt = 0; attempt < 8 && !BrowserWindow.getFocusedWindow(); attempt += 1) {
                app.focus({ steal: true });
                await new Promise((resolve) => setTimeout(resolve, 300));
            }
            const focused = BrowserWindow.getFocusedWindow();
            return focused ? wrapWindow(focused) : null;
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
        // While `trigger` runs, an open dialog is answered with `open` (a path) and a message box with the button labelled
        // `button`, as a person choosing them would. Returns what each dialog asked, its message and detail, for the test to read.
        async answerDialogs({ open = null, button = null }, trigger) {
            const originalOpen = dialog.showOpenDialog;
            const originalMessage = dialog.showMessageBox;
            const asked = [];
            if (open) dialog.showOpenDialog = async (...args) => {
                asked.push({ kind: 'open', title: dialogOptions(args).title ?? '' });
                return { canceled: false, filePaths: [open] };
            };
            if (button) dialog.showMessageBox = async (...args) => {
                const { message = '', detail = '', buttons = [] } = dialogOptions(args);
                asked.push({ kind: 'message', message, detail, buttons });
                const response = buttons.indexOf(button);
                if (response < 0) throw new Error(`The dialog "${message}" has no ${button} button (it has ${buttons.join(', ')}).`);
                return { response, checkboxChecked: false };
            };
            try {
                await trigger();
                return asked;
            } finally {
                dialog.showOpenDialog = originalOpen;
                dialog.showMessageBox = originalMessage;
            }
        },
        async simulateOsFileOpen(path) {
            app.emit('open-file', { preventDefault() {} }, path);
        },
        // Whether minimizing a window does anything on this display (probed once, see probeMinimize).
        canMinimize: probeMinimize,
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
            aiAssistant: true,
            cancellableValidation: true
        },
        async dispose() {
            // Nothing to tear down -- the suite's own caller (src/main.mjs) owns the app/window
            // lifecycle, exactly as it did before this driver existed.
        }
    };
}
