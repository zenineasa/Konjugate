/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Electron half of the interaction-test suite's driver split (see
// playwrightWebDriver.mjs's own header comment for the other half, and
// tests/interactionRunner.mjs's own top-of-file comment for the shared "handle" contract both
// drivers implement). This file is a mechanical lift of logic tests/interactionRunner.mjs already
// had inline before the split -- wrapping a BrowserWindow's webContents.executeJavaScript/
// sendInputEvent calls, dialog.showSaveDialog stubbing, and BrowserWindow.getAllWindows() polling
// into the shared handle/driver shape -- not new behavior.

import { app, BrowserWindow, dialog, ipcMain, session, shell, webContents } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeDialogAnswers, describeDialog } from './nativeDialogAnswers.mjs';

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

// The operating system's own dialogs cannot be clicked by a script, and one left open stays on the screen for the rest of the run
// and after it, for a person to close. While the app is driven every one is answered here instead (tests/drivers/nativeDialogAnswers.mjs
// decides how; docs/drivingTheApp.md says how a script chooses): with an answer the script queued, or as a person backing out would.
// Each is recorded, so the runner can say which test asked for one. Installed once, before the app opens its first window, and it
// covers every way Konjugate brings up something native:
//   - the main process's dialogs, at Electron's native binding beneath the dialog module, so a reference to dialog.showMessageBox
//     taken early, the Sync forms, dialog.showErrorBox and Electron's own "A JavaScript error occurred in the main process" box
//     are all answered;
//   - shell.openExternal, openPath, showItemInFolder and trashItem, which would bring another app in front of the run: recorded and
//     not done;
//   - a window's alert, confirm and prompt, through a preload registered on every session (nativeDialogPreload.cjs);
//   - a window's <input type="file"> chooser, through the window's DevTools protocol, which takes it before it is shown.
// And a watchdog: should a native dialog get past all of that (a window that loaded before the preload was registered, a page
// that kept the browser's own confirm), the DevTools protocol sees it open, it is said loudly with its text and dismissed, and if it
// cannot be dismissed the app is ended rather than left waiting for a click nobody will make.
let interception = null;
// A dialog's options: Electron takes them second when a window is given first.
const dialogOptions = (args) => (args[0] && typeof args[0] === 'object' && !('webContents' in args[0]) ? args[0] : args[1]) ?? {};
const rendererDialogChannel = 'konjugate-test:native-dialog';

export function interceptNativeDialogs() {
    if (interception) return interception;
    const answers = createNativeDialogAnswers();
    const listeners = new Set();
    const notify = (record) => {
        if (record.error) console.error(`  [native dialog] ${describeDialog(record)}`);
        for (const listener of listeners) {
            try { listener(record); } catch { /* a listener's own failure is not the dialog's */ }
        }
    };
    const answer = (asked) => {
        const { result, record } = answers.answer(asked);
        notify(record);
        return result;
    };

    // The main process's dialogs, at the binding the dialog module calls (lib/browser/api/dialog.ts in Electron: its settings are the
    // options it was given, checked and filled in, with the window as settings.window). Node keeps one object per binding, so the
    // module's own reference sees these.
    const binding = process._linkedBinding('electron_browser_dialog');
    const fromSettings = (kind, settings = {}) => ({
        kind, source: 'main',
        title: settings.title ?? '', message: settings.message ?? '', detail: settings.detail ?? '',
        ...(Array.isArray(settings.buttons) ? { buttons: settings.buttons } : {}),
        ...(Number.isInteger(settings.cancelId) ? { cancelId: settings.cancelId } : {}),
        ...(settings.checkboxLabel ? { checkboxChecked: Boolean(settings.checkboxChecked) } : {}),
        ...(settings.defaultPath ? { path: settings.defaultPath } : {})
    });
    const replacements = {
        showSaveDialog: async (settings) => answer(fromSettings('save', settings)),
        showSaveDialogSync: (settings) => { const result = answer(fromSettings('save', settings)); return result.canceled ? '' : result.filePath; },
        showOpenDialog: async (settings) => answer(fromSettings('open', settings)),
        showOpenDialogSync: (settings) => { const result = answer(fromSettings('open', settings)); return result.canceled ? undefined : result.filePaths; },
        showMessageBox: async (settings) => answer(fromSettings('message', settings)),
        showMessageBoxSync: (settings) => answer(fromSettings('message', settings)).response,
        showErrorBox: (title, content) => {
            console.error(`  [native dialog] An error box was asked for: ${title}${content ? `\n${content}` : ''}`);
            answer({ kind: 'error', source: 'main', title: String(title ?? ''), message: String(content ?? '') });
        },
        showCertificateTrustDialog: async (_window, _certificate, message) => { answer({ kind: 'certificate', source: 'main', message: String(message ?? '') }); }
    };
    for (const [name, replacement] of Object.entries(replacements)) {
        binding[name] = replacement;
        if (process._linkedBinding('electron_browser_dialog')[name] !== replacement) throw new Error(`Native dialogs could not be intercepted: Electron's dialog.${name} could not be replaced.`);
    }

    // Outside apps.
    const outside = {
        openExternal: async (url) => { answer({ kind: 'external', source: 'main', message: `shell.openExternal ${url}`, url: String(url) }); },
        openPath: async (path) => { answer({ kind: 'external', source: 'main', message: `shell.openPath ${path}`, path: String(path) }); return ''; },
        showItemInFolder: (path) => { answer({ kind: 'external', source: 'main', message: `shell.showItemInFolder ${path}`, path: String(path) }); },
        trashItem: async (path) => { answer({ kind: 'external', source: 'main', message: `shell.trashItem ${path}`, path: String(path) }); }
    };
    for (const [name, replacement] of Object.entries(outside)) shell[name] = replacement;

    // A window's alert, confirm and prompt. The reply is wrapped: a reply of undefined would leave the window waiting.
    ipcMain.on(rendererDialogChannel, (event, asked) => {
        const kind = ['alert', 'confirm', 'prompt'].includes(asked?.kind) ? asked.kind : 'alert';
        let url = '';
        try { url = event.sender.getURL(); } catch { /* gone */ }
        event.returnValue = { value: answer({ kind, source: 'renderer', message: String(asked?.message ?? ''), url }) };
    });
    // From the app's folder rather than this module's: a packaged test build bundles this module into the main process's own.
    const preload = join(app.getAppPath(), 'tests', 'drivers', 'nativeDialogPreload.cjs');
    const withPreload = new WeakSet();
    const preloadFound = existsSync(preload);
    if (!preloadFound) console.error(`  [native dialog] no dialog preload at ${preload}: a window's alert, confirm and prompt are left to the watchdog.`);
    const registerPreload = (ses) => {
        if (!preloadFound || !ses || withPreload.has(ses)) return;
        withPreload.add(ses);
        try { ses.registerPreloadScript({ type: 'frame', filePath: preload }); } catch (error) { console.error(`  [native dialog] could not register the dialog preload: ${error.message}`); }
    };
    registerPreload(session.defaultSession);
    app.on('session-created', registerPreload);

    // Each window's DevTools protocol: its file chooser taken before it is shown, and the watchdog.
    const watched = new WeakSet();
    const bypass = (contents, params) => {
        const record = answers.note({
            kind: params.type ?? 'dialog', source: 'renderer', message: params.message ?? '', url: params.url ?? '',
            answer: 'dismissed by the watchdog', bypassed: true,
            error: `A native ${params.type ?? ''} dialog reached the screen past the interception: "${params.message ?? ''}" (from ${params.url || 'a window'}).`
        });
        console.error(`\n  [native dialog] ${record.error}\n`);
        contents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false }).then(() => notify(record), (error) => {
            record.answer = 'left on the screen';
            notify(record);
            console.error(`  [native dialog] It could not be dismissed (${error.message}): the app is ended rather than left waiting for a click.`);
            setTimeout(() => app.exit(70), 500);
        });
    };
    const chooseFiles = async (contents, { backendNodeId, mode }) => {
        const filePaths = answer({ kind: 'open', source: 'renderer', title: mode === 'selectMultiple' ? 'Choose files' : 'Choose a file', url: contents.getURL() }).filePaths;
        if (!filePaths.length) return;
        const files = mode === 'selectMultiple' ? filePaths : filePaths.slice(0, 1);
        try {
            await contents.debugger.sendCommand('DOM.setFileInputFiles', { files, backendNodeId });
        } catch {
            await contents.debugger.sendCommand('DOM.enable');
            await contents.debugger.sendCommand('DOM.setFileInputFiles', { files, backendNodeId });
        }
    };
    const watch = (contents) => {
        if (!contents || watched.has(contents) || contents.isDestroyed()) return;
        watched.add(contents);
        try {
            if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
        } catch (error) {
            console.error(`  [native dialog] the watchdog could not watch ${contents.getURL() || 'a window'}: ${error.message}`);
            return;
        }
        contents.debugger.on('message', (_event, method, params) => {
            if (method === 'Page.javascriptDialogOpening') bypass(contents, params);
            else if (method === 'Page.fileChooserOpened') chooseFiles(contents, params).catch((error) => console.error(`  [native dialog] the chosen files could not be given to the window: ${error.message}`));
        });
        contents.debugger.sendCommand('Page.enable')
            .then(() => contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }))
            .catch(() => { /* the window went first */ });
    };
    app.on('web-contents-created', (_event, contents) => watch(contents));
    for (const contents of webContents.getAllWebContents()) watch(contents);

    interception = {
        answers,
        // Every native dialog so far, those past the interception included, oldest first.
        records: () => answers.records(),
        onDialog(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
    return interception;
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
    const dialogs = interceptNativeDialogs();
    restartInPlace(mainWindow);
    const coverage = process.env.KONJUGATE_INTERACTION_COVERAGE ? createRendererCoverage(process.env.KONJUGATE_INTERACTION_COVERAGE) : null;
    windowCoverage = coverage;
    // checkDialogs looks at the dialogs after the last it looked at.
    let checkedUpTo = 0;

    return {
        // Before the first scenario, and after the last.
        async prepare() {
            await coverage?.start(mainWindow);
        },
        async finish() {
            await coverage?.finish();
        },
        // The native dialogs asked for since the last call (not the outside apps asked for), with how each was answered.
        takeNativeDialogs() {
            return dialogs.answers.take().filter((record) => record.kind !== 'external');
        },
        // Queues the answer for the next native dialog of its kind: { button: 'Discard changes' } or { response: 1 } for a message box
        // (or a window's confirm/alert, whose buttons are OK and Cancel), { filePaths: [...] } for an open dialog or a file chooser,
        // { filePath } for a save dialog, { text } for a prompt, { kind, cancel: true } to cancel one; with expect: 'some text' (or a
        // RegExp) the dialog must say it. Answers of a kind are used in order.
        answerNextDialog(answer) {
            return dialogs.answers.queue(answer);
        },
        // Queues `answer`, runs `trigger`, and waits for the dialog the answer was for. Returns what the dialog asked (kind, title,
        // message, detail, buttons) and the answer given; throws if no such dialog came, or the answer did not fit it (a button it does
        // not have, wording it does not say), naming what it offered.
        async answerDialog(answer, trigger, { timeoutMs = 10000 } = {}) {
            const queue = dialogs.answers.queue(answer);
            const ahead = dialogs.answers.queued().filter((queued) => queued.kind === queue.kind).length - 1;
            const servedBy = { message: ['message', 'alert', 'confirm'], open: ['open'], save: ['save'], prompt: ['prompt'] }[queue.kind];
            let seen = 0;
            let stop = () => {};
            const answered = new Promise((resolve) => {
                stop = dialogs.onDialog((record) => {
                    if (!servedBy.includes(record.kind) || record.bypassed) return;
                    if (seen++ === ahead) resolve(record);
                });
            });
            let timer;
            try {
                await trigger?.();
                const record = await Promise.race([answered, new Promise((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error(`No ${queue.kind} dialog came within ${timeoutMs} ms for the answer ${JSON.stringify(answer)}.`)), timeoutMs);
                })]);
                if (record.error) throw new Error(record.error);
                return record;
            } catch (error) {
                // An answer not used is not left for a later dialog.
                const left = dialogs.answers.clearQueued().filter((queued) => queued !== queue);
                for (const queued of left) dialogs.answers.queue(queued);
                throw error;
            } finally {
                clearTimeout(timer);
                stop();
            }
        },
        // What a native dialog with no answer queued gets: 'cancel' (the default), 'fail' (cancelled, and an error for checkDialogs),
        // or a function given the dialog that returns an answer, or nothing to cancel it.
        setDialogPolicy(policy) {
            dialogs.answers.setUnmatched(policy);
        },
        // Every native dialog so far, oldest first: { kind, source ('main' or 'renderer'), title, message, detail, buttons, answer,
        // error? }. Outside apps asked for are listed as kind 'external'.
        nativeDialogs() {
            return dialogs.records();
        },
        // Calls `listener` with each native dialog's record as it is answered; returns a function that stops it.
        onNativeDialog(listener) {
            return dialogs.onDialog(listener);
        },
        // The answers queued and not yet used, dropped.
        clearDialogAnswers() {
            return dialogs.answers.clearQueued();
        },
        // Waits for the next native dialog (of `kind`, saying `includes`) to be asked for after this call.
        async waitForDialog({ kind = null, includes = null } = {}, timeoutMs = 10000) {
            let stop = () => {};
            let timer;
            try {
                return await new Promise((resolve, reject) => {
                    stop = dialogs.onDialog((record) => {
                        if (kind && record.kind !== kind) return;
                        if (includes && ![record.title, record.message, record.detail].some((text) => text.includes(includes))) return;
                        resolve(record);
                    });
                    timer = setTimeout(() => reject(new Error(`No native ${kind ?? ''} dialog${includes ? ` saying "${includes}"` : ''} came within ${timeoutMs} ms.`)), timeoutMs);
                });
            } finally {
                clearTimeout(timer);
                stop();
            }
        },
        // Throws if a native dialog since the last check went wrong: an answer that did not fit, one with no answer under the 'fail'
        // policy, or one that got past the interception.
        checkDialogs() {
            const wrong = dialogs.records().filter((record) => record.error && record.id > checkedUpTo);
            checkedUpTo = dialogs.records().length;
            if (wrong.length) throw new Error(wrong.map((record) => record.error).join('\n'));
        },
        // A window (the project window by default) as a PNG at `path`, through the window itself: no screen-recording permission needed.
        // The capture lags the drawing, so the window is asked to draw again and given a moment first.
        async screenshot(path, handle = mainHandle) {
            const win = handle._raw;
            if (win.isDestroyed()) throw new Error('The window is closed.');
            win.webContents.invalidate();
            await new Promise((resolve) => setTimeout(resolve, 800));
            const image = await win.webContents.capturePage();
            await writeFile(path, image.toPNG());
            return path;
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
        // Every open window as a PNG in `directory`, named from `prefix`: what a failed scenario left on screen, for a CI run
        // nobody watched. Best effort: a window that is gone, hidden or slow to draw is left out rather than holding the run.
        async captureWindows(directory, prefix) {
            const saved = [];
            await mkdir(directory, { recursive: true });
            // A capture lags the drawing, and taken at once can show a frame from before the failure: each window is asked to draw
            // again, and given a moment.
            for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.invalidate();
            await new Promise((resolve) => setTimeout(resolve, 1000));
            for (const [index, win] of BrowserWindow.getAllWindows().entries()) {
                if (win.isDestroyed() || !win.isVisible()) continue;
                try {
                    const image = await Promise.race([
                        win.webContents.capturePage(),
                        new Promise((resolve) => setTimeout(() => resolve(null), 5000))
                    ]);
                    if (!image || image.isEmpty()) continue;
                    const file = join(directory, `${prefix}-window${index + 1}.png`);
                    await writeFile(file, image.toPNG());
                    saved.push(file);
                } catch { /* the window went while it was being taken */ }
            }
            return saved;
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
