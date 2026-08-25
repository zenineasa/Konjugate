/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeProjectBundle, encodeProjectFile, inspectProjectFile } from './projectFile.mjs';
import { cppProviderSdkPath, inferWithEngine, startEngineRun, validateWithEngine } from './engineAdapter.mjs';
import { executionProjectDocument } from './subsystems.mjs';
import { stripEdgeGroups } from './edgeGroups.mjs';
import { projectDocumentSignals, resultSignalsToCsv } from './resultExport.mjs';
import { matchRunConfiguration, parseCliFlags } from './cliArgs.mjs';
import {
    createVisualizerSession,
    publicToolstripContributions,
    publicVisualizerContext,
    readSignalSeries,
    validateAddonManifest
} from './addonHost.mjs';
import { createAIConfigurationStore, createElectronCredentialVault } from './aiConfigurationStore.mjs';
import { createAIProviderRegistry } from './aiProviderRegistry.mjs';
import { createRemoteAIProviders } from './aiRemoteProviders.mjs';
import { openIndexedResult } from './indexedResultReader.mjs';
import { defaultPlaybackSampleLimit, rendererResultProjection, resultSignalSeries } from './resultSession.mjs';
import { createProviderToolchainStore, providerExecutionModes } from './providerToolchainStore.mjs';
import { findAvailableUpdate } from './updateCheck.mjs';
import { auxiliaryWindowPresentation } from './windowLifecycle.mjs';
import { parseKjtPathFromArgv } from './fileAssociation.mjs';
import { listDiagnostics, onDiagnostic, recordDiagnostic } from './diagnosticsLog.mjs';
import { inspectPackageArchive, installPackageArchive, listInstalledPackages, packageKey, uninstallPackage } from './packageArchive.mjs';
import { createExtensionStateStore } from './extensionStateStore.mjs';

if ((process.argv.includes('--interaction-test') || process.argv.includes('--generate-example-thumbnails')) && process.env.KONJUGATE_INTERACTION_USER_DATA) {
    app.setPath('userData', process.env.KONJUGATE_INTERACTION_USER_DATA);
}

// A --cli invocation is a one-shot batch job (run/validate a project, write output, exit), not
// a GUI instance -- it must run and exit on its own even while a real GUI instance is already
// open, so it skips single-instance-lock/open-file entirely below rather than risk being
// silently absorbed into an already-running instance's second-instance handler and never
// actually doing anything.
const isCliMode = process.argv.includes('--cli');

// macOS can fire 'open-file' (double-click on a .kjt) before 'ready' resolves on a cold
// launch -- queued here and drained once app.whenReady() runs, rather than assuming a window
// already exists. openOrFocusProjectFile/parseKjtPathFromArgv are function declarations
// defined further down; referencing them here is safe since neither handler below can run
// before the rest of this module (and their const dependencies) has finished evaluating.
const openFileQueue = [];
if (!isCliMode) {
    app.on('open-file', (event, path) => {
        event.preventDefault();
        if (app.isReady()) openOrFocusProjectFile(path);
        else openFileQueue.push(path);
    });

    // Must run after the userData override above (requestSingleInstanceLock's lock file lives
    // under userData) so interaction-test/thumbnail runs never false-positive collide with a
    // real running instance, or each other in CI, by checking the default profile's lock file
    // instead.
    if (!app.requestSingleInstanceLock()) {
        app.quit();
        process.exit(0);
    }
    app.on('second-instance', (_event, argv) => {
        const path = parseKjtPathFromArgv(argv);
        if (path) {
            openOrFocusProjectFile(path);
            return;
        }
        const [anyProjectWindow] = projectWindows;
        if (anyProjectWindow?.isMinimized()) anyProjectWindow.restore();
        anyProjectWindow?.show();
        anyProjectWindow?.focus();
    });
}

// Backstop for anything logged via console.error/console.warn -- including paths nobody has
// explicitly wired up to a UI element -- so it still reaches the renderer's diagnostics panel
// instead of vanishing into a console nobody watching a packaged app will ever open.
function formatConsoleArgs(args) {
    return args.map((arg) => (
        arg instanceof Error ? (arg.stack || arg.message) : (typeof arg === 'string' ? arg : JSON.stringify(arg))
    )).join(' ');
}
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
console.error = (...args) => {
    originalConsoleError(...args);
    recordDiagnostic({ severity: 'error', message: formatConsoleArgs(args) });
};
console.warn = (...args) => {
    originalConsoleWarn(...args);
    recordDiagnostic({ severity: 'warning', message: formatConsoleArgs(args) });
};
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');

const currentDir = dirname(fileURLToPath(import.meta.url));
const pendingEncryptedPaths = new Set();
// Every open project window, plus one state record per window replacing what used to be a
// single set of module-level globals -- each project window gets its own aux windows (example
// guide/about, provider editor, results visualizer) and its own pending-provider-apply state,
// since two project windows can now legitimately have any of these open at once.
const projectWindows = new Set();
const projectWindowState = new WeakMap();
function createProjectWindowState() {
    return {
        exampleGuideWindow: null, exampleGuideBounds: null,
        providerEditorWindow: null, providerEditorBounds: null, providerEditorOwner: null, pendingProviderApply: null,
        analysisWindow: null, analysisAddonId: null, visualizerManifest: null, visualizerSession: null,
        currentProjectPath: null
    };
}
// A window created specifically to open an OS-provided file (double-click, second-instance
// argv, macOS open-file) stores its decode outcome here -- keyed by promise rather than a
// plain value so it's set synchronously at window-creation time (avoiding a race against the
// renderer's own pending-open pull, which can fire before an async readFile/decode settles).
const pendingWindowOpens = new WeakMap();
const addonRegistry = new Map();
const activeEngineJobs = new Map();
const completedEngineResults = new Map();
const activeAIRequests = new Map();
const activeAIOperations = new Set();
const activeValidationOperations = new Set();
const activeInferenceOperations = new Set();
let aiProviderRegistry = null;
let aiConfigurationStore = null;
let providerToolchainStore = null;
let extensionStateStore = null;
let applicationShutdownPromise = null;
let applicationShutdownComplete = false;

function getWindowFromEvent(event) {
    return BrowserWindow.fromWebContents(event.sender);
}

function senderIs(window, event) {
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
}

function isProjectWindow(window) {
    return Boolean(window && !window.isDestroyed() && projectWindows.has(window));
}

function senderIsProjectWindow(event) {
    return isProjectWindow(getWindowFromEvent(event));
}

function requireProjectWindow(event, message = 'Only a project window can do this.') {
    if (!senderIsProjectWindow(event)) throw new Error(message);
}

// Reverse lookup for an auxiliary window's own IPC handlers: given the event from e.g. the
// results-visualizer window itself, find which project window owns it (by comparing against
// that field in every project window's state record) -- the aux window has no identity of its
// own to gate on, only "whichever project window currently has one open under this field."
function projectWindowForAuxSender(event, field) {
    for (const projectWindow of projectWindows) {
        if (senderIs(projectWindowState.get(projectWindow)[field], event)) return projectWindow;
    }
    return null;
}

function installCustomWindowState(window) {
    const sendExpandedState = (expanded) => {
        if (!window.webContents.isDestroyed()) window.webContents.send('windowMaximizedChange', expanded);
    };
    window.on('maximize', () => sendExpandedState(true));
    window.on('unmaximize', () => sendExpandedState(false));
    window.on('enter-full-screen', () => sendExpandedState(true));
    window.on('leave-full-screen', () => sendExpandedState(false));
    window.webContents.on('did-finish-load', () => {
        sendExpandedState(process.platform === 'darwin' ? window.isFullScreen() : window.isMaximized());
    });
}

// pendingFileOpen, when given, is a Promise resolving to the payload the new window's
// renderer will pull via projectPendingOpen once it's ready to load a project.
function createProjectWindow(pendingFileOpen) {
    const window = new BrowserWindow({
        width: 1200,
        height: 760,
        minWidth: 720,
        minHeight: 480,
        frame: false,
        backgroundColor: '#08111f',
        title: 'Konjugate',
        icon: join(currentDir, '..', 'assets', 'icons', 'app.png'),
        webPreferences: {
            preload: join(currentDir, 'preload.mjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
        }
    });
    projectWindows.add(window);
    projectWindowState.set(window, createProjectWindowState());
    if (pendingFileOpen) pendingWindowOpens.set(window, pendingFileOpen);
    window.on('closed', () => projectWindows.delete(window));

    const owner = window.webContents;
    const ownerUnavailable = () => {
        abortAIOperations(owner);
        shutdownValidationOperations(owner);
        shutdownInferenceOperations(owner);
        shutdownEngineJobs(owner);
    };
    owner.once('destroyed', ownerUnavailable);
    owner.once('render-process-gone', ownerUnavailable);

    installCustomWindowState(window);

    window.loadFile(join(currentDir, 'renderer', 'index.html'));
    return window;
}

function findProjectWindowByPath(path) {
    for (const projectWindow of projectWindows) {
        if (projectWindowState.get(projectWindow).currentProjectPath === path) return projectWindow;
    }
    return null;
}

// The single entry point for every OS-initiated open (double-click, second-instance argv,
// macOS open-file): reuses an already-open window on this exact file rather than opening a
// confusing duplicate, otherwise opens a new window and lets its renderer pull the decoded
// (or failed) payload once it's ready via projectPendingOpen.
function openOrFocusProjectFile(path) {
    const existing = findProjectWindowByPath(path);
    if (existing) {
        if (existing.isMinimized()) existing.restore();
        existing.show();
        existing.focus();
        return;
    }
    createProjectWindow(readProjectFilePayload(path).catch((error) => ({ error: error.message })));
}

async function checkForUpdates(window) {
    let update;
    try {
        update = await findAvailableUpdate(app.getVersion());
    } catch (error) {
        console.warn('Update check failed:', error.message);
        return;
    }
    if (!update || !window || window.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(window, {
        type: 'info',
        title: 'Update available',
        message: `Konjugate ${update.version} is available.`,
        detail: `You're running ${app.getVersion()}.`,
        buttons: ['View Release', 'Later'],
        defaultId: 0,
        cancelId: 1
    });
    if (response === 0) shell.openExternal(update.url);
}

async function openGuideWindow(projectWindow, payload) {
    const state = projectWindowState.get(projectWindow);
    if (!state.exampleGuideWindow || state.exampleGuideWindow.isDestroyed()) {
        const createdWindow = new BrowserWindow({
            width: 720,
            height: 760,
            ...state.exampleGuideBounds,
            ...auxiliaryWindowPresentation(projectWindow),
            minWidth: 480,
            minHeight: 420,
            frame: false,
            backgroundColor: '#09131b',
            title: `${payload.title} · ${payload.kind === 'about' ? 'About' : 'Example Guide'}`,
            webPreferences: {
                preload: join(currentDir, 'exampleGuide', 'preload.cjs'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
            }
        });
        state.exampleGuideWindow = createdWindow;
        installCustomWindowState(createdWindow);
        createdWindow.on('close', () => { state.exampleGuideBounds = createdWindow.isDestroyed() ? state.exampleGuideBounds : createdWindow.getBounds(); });
        createdWindow.on('closed', () => { if (state.exampleGuideWindow === createdWindow) state.exampleGuideWindow = null; });
        createdWindow.webContents.once('did-finish-load', () => { if (!createdWindow.isDestroyed()) createdWindow.webContents.send('exampleGuideContent', payload); });
        await createdWindow.loadFile(join(currentDir, 'exampleGuide', 'index.html'));
    } else {
        state.exampleGuideWindow.setTitle(`${payload.title} · ${payload.kind === 'about' ? 'About' : 'Example Guide'}`);
        state.exampleGuideWindow.webContents.send('exampleGuideContent', payload);
        state.exampleGuideWindow.show();
        state.exampleGuideWindow.focus();
    }
    return true;
}

async function openExampleGuide(projectWindow, id) {
    if (!(await exampleFiles()).includes(id)) throw new Error('That example is not available.');
    const guideName = id.replace(/\.kjt$/, '.md');
    const markdown = await readFile(join(examplesDir, guideName), 'utf8');
    return openGuideWindow(projectWindow, {
        id,
        title: exampleLabel(id),
        markdown,
        kind: 'example'
    });
}

// docs/ is excluded wholesale from packaging (see ignoredTopLevelDirectories in
// packageElectron.mjs) -- About.md is shipped individually as its own extraResource instead,
// which @electron/packager copies flattened directly into Resources/, not Resources/docs/.
function aboutMarkdownPath() {
    return app.isPackaged ? join(process.resourcesPath, 'About.md') : join(currentDir, '..', 'docs', 'About.md');
}

async function openAboutWindow(projectWindow) {
    const markdown = (await readFile(aboutMarkdownPath(), 'utf8'))
        .replace('**runtime version**', `**${app.getVersion()}**`);
    return openGuideWindow(projectWindow, {
        title: 'Konjugate',
        markdown,
        kind: 'about'
    });
}

function openProviderEditorWindow(projectWindow, ownerWebContents, payload) {
    const state = projectWindowState.get(projectWindow);
    state.providerEditorOwner = ownerWebContents;
    if (!state.providerEditorWindow || state.providerEditorWindow.isDestroyed()) {
        const createdWindow = new BrowserWindow({
            width: 820,
            height: 640,
            ...state.providerEditorBounds,
            ...auxiliaryWindowPresentation(projectWindow),
            minWidth: 480,
            minHeight: 360,
            frame: false,
            backgroundColor: '#09131b',
            title: 'Provider source',
            webPreferences: {
                preload: join(currentDir, 'providerEditor', 'preload.cjs'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false
            }
        });
        state.providerEditorWindow = createdWindow;
        installCustomWindowState(createdWindow);
        createdWindow.on('close', () => { state.providerEditorBounds = createdWindow.isDestroyed() ? state.providerEditorBounds : createdWindow.getBounds(); });
        createdWindow.on('closed', () => {
            if (state.providerEditorWindow === createdWindow) { state.providerEditorWindow = null; state.providerEditorOwner = null; }
        });
        createdWindow.webContents.once('did-finish-load', () => { if (!createdWindow.isDestroyed()) createdWindow.webContents.send('providerEditorContent', payload); });
        createdWindow.loadFile(join(currentDir, 'providerEditor', 'index.html'));
    } else {
        state.providerEditorWindow.webContents.send('providerEditorContent', payload);
        state.providerEditorWindow.show();
        state.providerEditorWindow.focus();
    }
}

function aiRequestKey(sender, requestUuid) {
    return `${sender.id}:${requestUuid}`;
}

async function withAIOperation(owner, timeoutSeconds, operation) {
    const controller = new AbortController();
    const active = { owner, controller };
    const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    activeAIOperations.add(active);
    try {
        return await operation(controller.signal);
    } finally {
        clearTimeout(timeout);
        activeAIOperations.delete(active);
    }
}

function abortAIOperations(owner = null) {
    for (const [key, active] of activeAIRequests) {
        if (owner && active.owner !== owner) continue;
        active.controller.abort();
        activeAIRequests.delete(key);
    }
    for (const active of activeAIOperations) {
        if (owner && active.owner !== owner) continue;
        active.controller.abort();
        activeAIOperations.delete(active);
    }
}

async function shutdownValidationOperations(owner = null) {
    const operations = [...activeValidationOperations].filter((active) => !owner || active.owner === owner);
    for (const active of operations) active.controller.abort();
    await Promise.allSettled(operations.map((active) => active.completion));
}

async function shutdownInferenceOperations(owner = null) {
    const operations = [...activeInferenceOperations].filter((active) => !owner || active.owner === owner);
    for (const active of operations) active.controller.abort();
    await Promise.allSettled(operations.map((active) => active.completion));
}

async function shutdownEngineJobs(owner = null) {
    const jobs = [...activeEngineJobs.values()].filter((job) => !owner || job.owner === owner);
    await Promise.allSettled(jobs.map((job) => job.shutdown()));
}

async function closeCompletedEngineResults() {
    const results = [...completedEngineResults.values()];
    completedEngineResults.clear();
    await Promise.allSettled(results.map(async ({ reader, cleanup }) => {
        await reader.close();
        await cleanup();
    }));
}

async function createEmbeddedResultSession(resultBytes) {
    if (!resultBytes) return null;
    const directory = await mkdtemp(join(tmpdir(), 'konjugateEmbeddedResult-'));
    const path = join(directory, 'result.bin');
    try {
        await writeFile(path, resultBytes);
        const reader = await openIndexedResult(path);
        const result = rendererResultProjection({
            ...reader.metadata,
            samples: await reader.readSamples({ maximumSamples: defaultPlaybackSampleLimit })
        });
        const sessionId = randomUUID();
        completedEngineResults.set(sessionId, {
            result,
            reader,
            path,
            cleanup: () => rm(directory, { recursive: true, force: true })
        });
        return { sessionId, result };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

async function decodeProjectForRenderer(bytes, options = {}) {
    const bundle = await decodeProjectBundle(bytes, options);
    JSON.parse(bundle.content);
    return { content: bundle.content, embeddedResult: await createEmbeddedResultSession(bundle.result) };
}

// Shared by the dialog-driven projectOpen handler and every OS-initiated open (double-click,
// second-instance argv, macOS open-file) -- everything projectOpen does after its own
// dialog.showOpenDialog call, factored out so neither path duplicates the encrypted/decode logic.
async function readProjectFilePayload(path) {
    const bytes = await readFile(path);
    const inspection = inspectProjectFile(bytes);
    if (inspection.encrypted) {
        pendingEncryptedPaths.add(path);
        return { path, fileName: basename(path), encrypted: true, requiresPassword: true };
    }
    return { path, fileName: basename(path), encrypted: false, ...await decodeProjectForRenderer(bytes) };
}

// Shared by projectSave and CLI mode's --output-kjt: write via a temp file + rename so a
// crash or a concurrent read of `path` never observes a partially-written file; falls back to
// a direct overwrite on platforms/situations where the rename itself can't complete in place.
async function atomicWriteFile(path, bytes) {
    const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryPath, bytes);
        try {
            await rename(temporaryPath, path);
        } catch (error) {
            if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
            await writeFile(path, bytes);
            await unlink(temporaryPath);
        }
    } catch (error) {
        await unlink(temporaryPath).catch(() => { });
        throw error;
    }
}

function beginApplicationShutdown() {
    if (applicationShutdownPromise) return applicationShutdownPromise;
    abortAIOperations();
    applicationShutdownPromise = (async () => {
        await Promise.all([shutdownEngineJobs(), shutdownValidationOperations(), shutdownInferenceOperations()]);
        await closeCompletedEngineResults();
    })();
    return applicationShutdownPromise;
}

function visualizerCan(manifest, permission) {
    return manifest?.permissions.includes(permission);
}

// Hello World ships disabled out of the box, but only for a brand-new userData directory --
// extensionStateStore's own first-run-only seeding is what keeps a later re-enable sticky.
// Derived from the live bundled manifest rather than a hardcoded version string, so a future
// version bump to this add-on doesn't silently stop matching.
async function defaultDisabledExtensionKeys() {
    try {
        const manifest = JSON.parse(await readFile(join(currentDir, '..', 'addons', 'helloWorld', 'addon.json'), 'utf8'));
        return [packageKey('addon', manifest.addonId, manifest.version)];
    } catch {
        return [];
    }
}

async function discoverAddons() {
    addonRegistry.clear();
    const flatAddonRoots = [
        join(currentDir, '..', 'addons'),
        join(app.getPath('userData'), 'addons')
    ];
    for (const addonsDirectory of flatAddonRoots) {
        const entries = await readdir(addonsDirectory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const addonDirectory = join(addonsDirectory, entry.name);
            try {
                const manifest = validateAddonManifest(JSON.parse(await readFile(join(addonDirectory, 'addon.json'), 'utf8')));
                if (addonRegistry.has(manifest.addonId)) throw new Error(`Duplicate add-on ID: ${manifest.addonId}.`);
                addonRegistry.set(manifest.addonId, { addonDirectory, manifest });
            } catch (error) {
                console.warn(`Skipping add-on ${entry.name}: ${error.message}`);
            }
        }
    }
    // Installed (packaged) add-ons live one level deeper than the bundled/flat-user roots above
    // -- installPackageArchive() writes userData/packages/addons/<addonId>/<version>/addon.json,
    // matching discoverComponentLibrary()'s equivalent two-level walk for plugins below.
    const packagedAddonRoot = join(app.getPath('userData'), 'packages', 'addons');
    const addonIds = await readdir(packagedAddonRoot, { withFileTypes: true }).catch(() => []);
    for (const idEntry of addonIds) {
        if (!idEntry.isDirectory()) continue;
        const versions = await readdir(join(packagedAddonRoot, idEntry.name), { withFileTypes: true }).catch(() => []);
        for (const versionEntry of versions) {
            if (!versionEntry.isDirectory()) continue;
            const addonDirectory = join(packagedAddonRoot, idEntry.name, versionEntry.name);
            try {
                const manifest = validateAddonManifest(JSON.parse(await readFile(join(addonDirectory, 'addon.json'), 'utf8')));
                if (addonRegistry.has(manifest.addonId)) throw new Error(`Duplicate add-on ID: ${manifest.addonId}.`);
                addonRegistry.set(manifest.addonId, { addonDirectory, manifest });
            } catch (error) {
                console.warn(`Skipping packaged add-on ${idEntry.name}/${versionEntry.name}: ${error.message}`);
            }
        }
    }
}

async function openResultsVisualizer(projectWindow, { addonDirectory, manifest }, payload) {
    const state = projectWindowState.get(projectWindow);
    if (state.analysisWindow && !state.analysisWindow.isDestroyed() && state.analysisAddonId !== manifest.addonId) {
        state.analysisWindow.destroy();
        state.analysisWindow = null;
    }
    state.analysisAddonId = manifest.addonId;
    state.visualizerManifest = manifest;
    const liveResult = activeEngineJobs.get(payload.engineJobId)?.latestResult;
    const completedResult = completedEngineResults.get(payload.engineJobId)?.result;
    state.visualizerSession = createVisualizerSession({ ...payload, result: liveResult ?? completedResult ?? payload.result, sessionId: randomUUID() });
    if (state.analysisWindow && !state.analysisWindow.isDestroyed()) {
        state.analysisWindow.setTitle(`${state.visualizerSession.projectName} — Results`);
        state.analysisWindow.webContents.send('visualizerSessionChange');
        state.analysisWindow.show();
        state.analysisWindow.focus();
        return;
    }
    const createdWindow = new BrowserWindow({
        width: 1080,
        height: 720,
        minWidth: 720,
        minHeight: 480,
        ...auxiliaryWindowPresentation(projectWindow),
        title: `${state.visualizerSession.projectName} — Results`,
        frame: false,
        backgroundColor: '#081119',
        webPreferences: {
            preload: join(currentDir, 'addonPreload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });
    installCustomWindowState(createdWindow);
    state.analysisWindow = createdWindow;
    createdWindow.on('closed', () => {
        if (state.analysisWindow === createdWindow) {
            state.analysisWindow = null;
            state.analysisAddonId = null;
        }
    });
    await state.analysisWindow.loadFile(join(addonDirectory, manifest.entry));
}

ipcMain.handle('addonListToolstripContributions', async (event) => {
    if (!senderIsProjectWindow(event)) return [];
    await discoverAddons();
    const disabledKeys = await extensionStateStore.list();
    return [...addonRegistry.values()]
        .filter(({ manifest }) => !disabledKeys.includes(packageKey('addon', manifest.addonId, manifest.version)))
        .flatMap(({ manifest }) => publicToolstripContributions(manifest));
});

ipcMain.handle('addonInvokeCommand', async (event, { addonId, commandId, contexts = {} }) => {
    if (!senderIsProjectWindow(event)) throw new Error('Only a project window can invoke add-on commands.');
    if (!addonRegistry.size) await discoverAddons();
    const addon = addonRegistry.get(addonId);
    const contribution = addon?.manifest.contributes?.toolstrip?.find((item) => item.commandId === commandId);
    if (!addon || !contribution) throw new Error('That add-on command is unavailable.');
    if ((await extensionStateStore.list()).includes(packageKey('addon', addon.manifest.addonId, addon.manifest.version))) {
        throw new Error('This add-on is disabled.');
    }
    if (!(contribution.contexts ?? []).every((context) => contexts[context])) throw new Error('The add-on command requires unavailable context.');
    if (addon.manifest.kind === 'resultVisualizer') {
        const projectWindow = getWindowFromEvent(event);
        await openResultsVisualizer(projectWindow, addon, contexts.resultSession);
        return { addonId, commandId, sessionId: projectWindowState.get(projectWindow).visualizerSession.sessionId };
    }
    throw new Error(`Unsupported add-on kind: ${addon.manifest.kind}.`);
});

ipcMain.on('visualizerHostTimelineChange', (event, time) => {
    if (!senderIsProjectWindow(event)) return;
    const state = projectWindowState.get(getWindowFromEvent(event));
    if (!state.visualizerSession) return;
    state.visualizerSession.time = Number(time);
    if (visualizerCan(state.visualizerManifest, 'timeline.read') && state.analysisWindow && !state.analysisWindow.isDestroyed()) {
        state.analysisWindow.webContents.send('visualizerTimelineChange', state.visualizerSession.time);
    }
});

ipcMain.on('visualizerHostSelectionChange', (event, nodeId) => {
    if (!senderIsProjectWindow(event)) return;
    const state = projectWindowState.get(getWindowFromEvent(event));
    if (!state.visualizerSession) return;
    state.visualizerSession.selectedNodeId = nodeId ?? null;
    if (visualizerCan(state.visualizerManifest, 'selection.read') && state.analysisWindow && !state.analysisWindow.isDestroyed()) {
        state.analysisWindow.webContents.send('visualizerSelectionChange', nodeId ?? null);
    }
});

function updateVisualizerResult(projectWindow, jobId, result) {
    const state = projectWindow && projectWindowState.get(projectWindow);
    if (!state || !state.visualizerSession || state.visualizerSession.engineJobId !== jobId) return;
    state.visualizerSession.samples = result.samples;
    state.visualizerSession.run = {
        ...state.visualizerSession.run,
        sampleCount: result.samples.length,
        lifecycle: result.lifecycle,
        simulationTime: Number(result.simulationTime),
        availableResultTime: Number(result.availableResultTime),
        pacing: structuredClone(result.pacing)
    };
    if (!state.analysisWindow || state.analysisWindow.isDestroyed()) return;
    if (visualizerCan(state.visualizerManifest, 'results.live.read')) {
        state.analysisWindow.webContents.send('visualizerSamplesAvailable', {
            sampleCount: state.visualizerSession.run.sampleCount,
            availableResultTime: state.visualizerSession.run.availableResultTime
        });
    }
    if (visualizerCan(state.visualizerManifest, 'simulation.status.read')) {
        state.analysisWindow.webContents.send('visualizerRunStatusChange', structuredClone(state.visualizerSession.run));
    }
    if (visualizerCan(state.visualizerManifest, 'simulation.pacing.read')) {
        state.analysisWindow.webContents.send('visualizerPacingChange', structuredClone(state.visualizerSession.run.pacing));
    }
}

ipcMain.on('visualizerCloseSession', (event) => {
    if (!senderIsProjectWindow(event)) return;
    const state = projectWindowState.get(getWindowFromEvent(event));
    state.visualizerSession = null;
    state.visualizerManifest = null;
    state.analysisAddonId = null;
    state.analysisWindow?.close();
});

ipcMain.handle('visualizerGetContext', (event) => {
    const projectWindow = projectWindowForAuxSender(event, 'analysisWindow');
    const state = projectWindow && projectWindowState.get(projectWindow);
    if (!state?.visualizerSession || !visualizerCan(state.visualizerManifest, 'results.read')) return null;
    return publicVisualizerContext(state.visualizerSession);
});

ipcMain.handle('visualizerListSignals', (event) => {
    const projectWindow = projectWindowForAuxSender(event, 'analysisWindow');
    const state = projectWindow && projectWindowState.get(projectWindow);
    if (!state?.visualizerSession || !visualizerCan(state.visualizerManifest, 'results.read')) return [];
    return structuredClone(state.visualizerSession.signals);
});

ipcMain.handle('visualizerReadSeries', (event, { signalIds, options }) => {
    const projectWindow = projectWindowForAuxSender(event, 'analysisWindow');
    const state = projectWindow && projectWindowState.get(projectWindow);
    if (!state?.visualizerSession || !visualizerCan(state.visualizerManifest, 'results.read')) return [];
    return readSignalSeries(state.visualizerSession, signalIds, options);
});

ipcMain.handle('visualizerTitlebarStylesheet', (event) => {
    if (!projectWindowForAuxSender(event, 'analysisWindow')) throw new Error('The titlebar stylesheet is available only to the active add-on window.');
    return pathToFileURL(join(currentDir, 'addonTitlebar.css')).href;
});

ipcMain.on('visualizerSeek', (event, time) => {
    const projectWindow = projectWindowForAuxSender(event, 'analysisWindow');
    const state = projectWindow && projectWindowState.get(projectWindow);
    if (!state?.visualizerSession || !visualizerCan(state.visualizerManifest, 'timeline.seek')) return;
    if (['running', 'paused'].includes(state.visualizerSession.run.lifecycle)) return;
    const boundedTime = Math.max(0, Math.min(Number(time), state.visualizerSession.run.availableResultTime));
    state.visualizerSession.time = boundedTime;
    projectWindow.webContents.send('visualizerSeekRequest', boundedTime);
});

ipcMain.handle('visualizerRequestPacing', async (event, pacing) => {
    const projectWindow = projectWindowForAuxSender(event, 'analysisWindow');
    const state = projectWindow && projectWindowState.get(projectWindow);
    if (!state?.visualizerSession || !visualizerCan(state.visualizerManifest, 'simulation.pacing.control')) {
        throw new Error('The visualizer does not have permission to control pacing.');
    }
    const job = activeEngineJobs.get(state.visualizerSession.engineJobId);
    if (!job) throw new Error('The simulation is no longer running.');
    return job.setPacing(pacing);
});

ipcMain.on('windowMaximizeToggle', (event) => {
    const targetWindow = getWindowFromEvent(event);
    if (!targetWindow) return;

    if (process.platform === 'darwin') {
        targetWindow.setFullScreen(!targetWindow.isFullScreen());
    } else if (targetWindow.isMaximized()) {
        targetWindow.unmaximize();
    } else {
        targetWindow.maximize();
    }
});

ipcMain.on('windowMinimize', (event) => {
    getWindowFromEvent(event)?.minimize();
});

ipcMain.on('windowClose', (event) => {
    // Just close this window -- 'window-all-closed' below already handles quitting the whole
    // app on non-macOS once truly zero windows remain, which is exactly what's needed now that
    // more than one project window can exist (closing one used to force-quit the entire app).
    getWindowFromEvent(event)?.close();
});

ipcMain.handle('applicationInfo', () => ({ version: app.getVersion() }));
ipcMain.handle('applicationOpenAbout', (event) => openAboutWindow(getWindowFromEvent(event)));
ipcMain.on('newProjectWindow', () => createProjectWindow());
ipcMain.handle('applicationOpenExternal', (event, url) => {
    if (typeof url !== 'string' || !['https://discord.gg/', 'https://github.com/zenineasa/Konjugate/'].some((prefix) => url.startsWith(prefix))) return false;
    shell.openExternal(url);
    return true;
});

ipcMain.handle('diagnosticsList', () => listDiagnostics());
onDiagnostic((entry) => {
    for (const window of projectWindows) {
        if (!window.isDestroyed()) window.webContents.send('diagnosticsIssue', entry);
    }
});

const examplesDir = join(currentDir, '..', 'examples');

async function exampleFiles() {
    return (await readdir(examplesDir)).filter((name) => name.endsWith('.kjt'));
}

function exampleLabel(fileName) {
    const stem = fileName.replace(/\.kjt$/, '');
    return `${stem.charAt(0).toUpperCase()}${stem.slice(1)}`.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

let examplesManifestCache = null;
async function examplesManifest() {
    if (!examplesManifestCache) {
        const parsed = JSON.parse(await readFile(join(examplesDir, 'manifest.json'), 'utf8'));
        examplesManifestCache = new Map(parsed.examples.map((entry) => [entry.id, entry]));
    }
    return examplesManifestCache;
}

// The guide's own "## Overview" paragraph doubles as the explorer card's description, rather
// than duplicating it by hand in the manifest -- every example guide already opens with exactly
// this structure (see docs/examples restructuring), so it stays in sync with the guide for free.
async function exampleDescription(stem) {
    const markdown = await readFile(join(examplesDir, `${stem}.md`), 'utf8').catch(() => '');
    const match = markdown.match(/## Overview\r?\n\r?\n([\s\S]+?)(?=\r?\n##\s|\r?\n*$)/);
    return match ? match[1].trim() : '';
}

ipcMain.handle('projectListExamples', async () => {
    const manifest = await examplesManifest();
    return Promise.all((await exampleFiles()).map(async (fileName) => {
        const stem = fileName.replace(/\.kjt$/, '');
        const thumbnailPath = join(examplesDir, `${stem}.png`);
        return {
            id: fileName,
            label: exampleLabel(fileName),
            suggestedFilename: fileName,
            domains: manifest.get(stem)?.domains ?? [],
            description: await exampleDescription(stem),
            thumbnailUrl: existsSync(thumbnailPath) ? pathToFileURL(thumbnailPath).href : null
        };
    }));
});

ipcMain.handle('projectLoadExample', async (_event, id) => {
    if (!(await exampleFiles()).includes(id)) throw new Error('That example is not available.');
    return { ...await decodeProjectForRenderer(await readFile(join(examplesDir, id))), suggestedFilename: id };
});

ipcMain.handle('projectOpenExampleGuide', async (event, id) => {
    requireProjectWindow(event, 'Only a project window can open example guides.');
    return openExampleGuide(getWindowFromEvent(event), id);
});

const shapesDir = join(currentDir, '..', 'assets', 'shapes');
const userShapesDir = join(app.getPath('userData'), 'shapes');
const shapeFormatPattern = /\.(stl|step|stp)$/i;

// Mirrors discoverComponentLibrary's bundled-plus-writable-userData split: the bundled manifest
// is hand-curated (name/domain/tags), while every user upload gets a self-describing entry
// synthesized directly from its filename -- there's no separate manifest to keep in sync for
// something that's supposed to "just show up" the moment a file is saved into userShapesDir.
async function shapeLibraryManifest() {
    const bundled = (JSON.parse(await readFile(join(shapesDir, 'manifest.json'), 'utf8')).shapes)
        .map((shape) => {
            const domains = Array.isArray(shape.domains)
                ? shape.domains
                : (shape.domain ? [shape.domain] : []);
            return {
                ...shape,
                domains,
                domain: domains[0] ?? 'general',
                source: 'bundled'
            };
        });
    const uploadedEntries = await readdir(userShapesDir, { withFileTypes: true }).catch(() => []);
    const uploaded = uploadedEntries
        .filter((entry) => entry.isFile() && shapeFormatPattern.test(entry.name))
        .map((entry) => {
            const format = entry.name.split('.').pop().toLowerCase();
            return {
                id: `userUploaded/${entry.name}`,
                name: entry.name.slice(0, -(format.length + 1)),
                domains: ['userUploaded'],
                domain: 'userUploaded',
                format,
                file: entry.name,
                tags: [],
                source: 'user'
            };
        });
    return [...bundled, ...uploaded];
}

ipcMain.handle('shapeLibraryList', async () => shapeLibraryManifest());

ipcMain.handle('shapeLibrarySaveUpload', async (_event, { fileName, data }) => {
    const format = fileName.split('.').pop()?.toLowerCase();
    if (!['stl', 'step', 'stp'].includes(format)) {
        throw new Error('Only STL, STEP, or STP files can be saved to the shape library.');
    }
    await mkdir(userShapesDir, { recursive: true });
    const stem = basename(fileName, `.${format}`).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'shape';
    let candidateName = `${stem}.${format}`;
    for (let counter = 1; existsSync(join(userShapesDir, candidateName)); counter += 1) {
        candidateName = `${stem} (${counter}).${format}`;
    }
    await writeFile(join(userShapesDir, candidateName), Buffer.from(data));
    return { id: `userUploaded/${candidateName}` };
});

const componentTemplateIdPattern = /^[a-zA-Z][\w-]*$/;

// Validates a bundled or user-saved node/edge template. Deliberately hand-rolled like
// validateAddonManifest rather than a schema library -- the shape is small and stable.
function validateComponentTemplate(template) {
    if (!template || (template.kind !== 'node' && template.kind !== 'edge')) throw new Error('A template must have kind "node" or "edge".');
    if (!componentTemplateIdPattern.test(template.id ?? '')) throw new Error('A template needs a valid id.');
    if (!template.name) throw new Error('A template needs a name.');
    const domains = template.domains ?? [];
    if (!Array.isArray(domains) || !domains.length || !domains.every((domain) => typeof domain === 'string' && domain)) {
        throw new Error('A template needs a non-empty domains array.');
    }
    if (template.kind === 'node') {
        if (!Array.isArray(template.states) || !template.states.length) throw new Error('A node template needs at least one state.');
        const stateSymbols = new Set();
        template.states.forEach((state) => {
            if (!componentTemplateIdPattern.test(state.symbol ?? '') || !state.label) throw new Error('A node template state needs a label and symbol.');
            stateSymbols.add(state.symbol);
        });
        (template.sourceTerms ?? []).forEach((term) => {
            if (!stateSymbols.has(term.state) || !term.expression) throw new Error('A node template source term needs a state matching one of its own states and an expression.');
        });
    } else {
        // A port is usually one expected state symbol per role, but an edge whose equation
        // couples more than one state on the same side (e.g. a motor's current and angular
        // velocity, both referenced from the same "target" role) needs to declare more than one.
        const validPort = (port) => port !== undefined && (Array.isArray(port) ? port.length : true) &&
            [port].flat().every((symbol) => componentTemplateIdPattern.test(symbol ?? ''));
        if (!template.ports || !validPort(template.ports.source) || !validPort(template.ports.target)) {
            throw new Error('An edge template needs source and target port symbols.');
        }
        if (!template.latex) throw new Error('An edge template needs a latex expression.');
        (template.parameters ?? []).forEach((parameter) => {
            if (!componentTemplateIdPattern.test(parameter.symbol ?? '') || !parameter.name) throw new Error('An edge template parameter needs a name and symbol.');
        });
        // Required, not just validated-if-present: the builder's own "no explicit output yet"
        // default is the target's first state, but that default is unreliable once an edge template
        // arms a chained two-endpoint pick (refreshStateReferences briefly runs source-only, which
        // leaves an implicit selection that then survives once the target is picked too) -- so a
        // template can never safely rely on it and must always say which state it means to update.
        if (!template.output || !['source', 'target'].includes(template.output.role) || !componentTemplateIdPattern.test(template.output.state ?? '')) {
            throw new Error('An edge template needs an output naming a role ("source" or "target") and a state symbol.');
        }
        if (template.bidirectional !== undefined && typeof template.bidirectional !== 'boolean') {
            throw new Error('An edge template\'s bidirectional flag must be a boolean.');
        }
    }
    return structuredClone(template);
}

const componentLibraryRegistry = new Map();

async function discoverComponentLibrary() {
    componentLibraryRegistry.clear();
    const componentLibraryRoots = [
        join(currentDir, '..', 'assets', 'componentLibrary'),
        join(app.getPath('userData'), 'componentLibrary')
    ];
    for (const componentLibraryDirectory of componentLibraryRoots) {
        const entries = await readdir(componentLibraryDirectory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            try {
                const template = validateComponentTemplate(JSON.parse(await readFile(join(componentLibraryDirectory, entry.name), 'utf8')));
                if (componentLibraryRegistry.has(template.id)) throw new Error(`Duplicate template ID: ${template.id}.`);
                componentLibraryRegistry.set(template.id, template);
            } catch (error) {
                console.warn(`Skipping component template ${entry.name}: ${error.message}`);
            }
        }
    }
    const pluginRoot = join(app.getPath('userData'), 'packages', 'plugins');
    const pluginIds = await readdir(pluginRoot, { withFileTypes: true }).catch(() => []);
    const disabledKeys = await extensionStateStore.list();
    for (const pluginIdEntry of pluginIds) {
        if (!pluginIdEntry.isDirectory()) continue;
        const pluginVersions = await readdir(join(pluginRoot, pluginIdEntry.name), { withFileTypes: true }).catch(() => []);
        for (const versionEntry of pluginVersions) {
            if (!versionEntry.isDirectory()) continue;
            const pluginDirectory = join(pluginRoot, pluginIdEntry.name, versionEntry.name);
            try {
                const manifest = JSON.parse(await readFile(join(pluginDirectory, 'plugin.json'), 'utf8'));
                // A disabled plugin has no other place to be filtered out (unlike add-ons, which
                // stay in addonRegistry so packageList can still show them with a toggle) --
                // componentLibraryRegistry IS the active-templates list consumed directly by the
                // Component Library panel, so this is where it must be skipped.
                if (disabledKeys.includes(packageKey('plugin', manifest.pluginId, manifest.version))) continue;
                for (const contribution of manifest.contributes ?? []) {
                    if (contribution.kind !== 'component') continue;
                    const template = validateComponentTemplate(JSON.parse(await readFile(join(pluginDirectory, contribution.entry), 'utf8')));
                    if (template.id !== contribution.componentId) throw new Error(`Component ID mismatch: ${contribution.componentId}.`);
                    if (componentLibraryRegistry.has(template.id)) throw new Error(`Duplicate template ID: ${template.id}.`);
                    componentLibraryRegistry.set(template.id, {
                        ...template,
                        source: 'plugin',
                        pluginId: manifest.pluginId,
                        pluginVersion: manifest.version
                    });
                }
            } catch (error) {
                console.warn(`Skipping plugin components from ${pluginIdEntry.name}/${versionEntry.name}: ${error.message}`);
            }
        }
    }
}

ipcMain.handle('componentLibraryList', async () => {
    await discoverComponentLibrary();
    return [...componentLibraryRegistry.values()];
});

ipcMain.handle('shapeLibraryLoad', async (_event, id) => {
    const shape = (await shapeLibraryManifest()).find((candidate) => candidate.id === id);
    if (!shape) throw new Error('That shape is not available.');
    const baseDir = shape.source === 'user' ? userShapesDir : shapesDir;
    return { ...shape, data: await readFile(join(baseDir, shape.file)) };
});

ipcMain.handle('projectOpen', async (event) => {
    const targetWindow = getWindowFromEvent(event);
    const result = await dialog.showOpenDialog(targetWindow, {
        title: 'Open Konjugate project',
        properties: ['openFile'],
        filters: [
            { name: 'Konjugate project', extensions: ['kjt'] }
        ]
    });
    if (result.canceled) return null;
    const [path] = result.filePaths;
    if (!path.toLowerCase().endsWith('.kjt')) throw new Error('Only .kjt project files are supported.');
    return readProjectFilePayload(path);
});

ipcMain.handle('packageInstall', async (event) => {
    const targetWindow = getWindowFromEvent(event);
    const result = await dialog.showOpenDialog(targetWindow, {
        title: 'Install Konjugate package',
        properties: ['openFile'],
        filters: [{ name: 'Konjugate packages', extensions: ['kja', 'kjp'] }]
    });
    if (result.canceled) return null;
    const [path] = result.filePaths;
    const extension = path.toLowerCase().endsWith('.kja') ? '.kja' : path.toLowerCase().endsWith('.kjp') ? '.kjp' : null;
    if (!extension) throw new Error('Only .kja add-ons and .kjp plugins can be installed.');
    const archive = await readFile(path);
    const inspected = inspectPackageArchive(archive, { extension });
    const permissions = inspected.contributionManifest.permissions ?? [];
    const detail = [
        `${inspected.packageManifest.name} ${inspected.packageManifest.version}`,
        `Publisher package: ${inspected.packageManifest.packageId}`,
        `Type: ${inspected.packageManifest.packageType}`,
        permissions.length ? `Permissions: ${permissions.join(', ')}` : 'Permissions: none'
    ].join('\n');
    const confirmation = await dialog.showMessageBox(targetWindow, {
        type: 'question',
        buttons: ['Cancel', 'Install'],
        defaultId: 1,
        cancelId: 0,
        title: 'Review package installation',
        message: `Install ${inspected.packageManifest.name}?`,
        detail
    });
    if (confirmation.response !== 1) return null;
    const installed = await installPackageArchive(archive, {
        extension,
        directory: join(app.getPath('userData'), 'packages')
    });
    await discoverAddons();
    return {
        packageType: installed.packageManifest.packageType,
        packageId: installed.packageManifest.packageId,
        version: installed.packageManifest.version
    };
});

ipcMain.handle('packageList', async () => {
    await discoverAddons();
    const disabledKeys = await extensionStateStore.list();
    const packagedAddonRoot = join(app.getPath('userData'), 'packages', 'addons');
    const bundled = [...addonRegistry.values()]
        .filter(({ addonDirectory }) => !addonDirectory.startsWith(`${packagedAddonRoot}${sep}`))
        .map(({ manifest }) => ({
            packageType: 'addon', packageId: manifest.addonId, name: manifest.name, version: manifest.version,
            source: 'bundled', permissions: manifest.permissions ?? [], manifest, installPath: null,
            enabled: !disabledKeys.includes(packageKey('addon', manifest.addonId, manifest.version))
        }));
    const installed = (await listInstalledPackages(join(app.getPath('userData'), 'packages'))).map((entry) => ({
        ...entry, enabled: !disabledKeys.includes(packageKey(entry.packageType, entry.packageId, entry.version))
    }));
    return [...bundled, ...installed];
});

ipcMain.handle('packageUninstall', async (_event, { packageType, packageId, version }) => {
    await uninstallPackage({ directory: join(app.getPath('userData'), 'packages'), packageType, packageId, version });
    await discoverAddons();
    await discoverComponentLibrary();
    return { packageType, packageId, version };
});

ipcMain.handle('packageSetEnabled', async (_event, { packageType, packageId, version, enabled }) => {
    await extensionStateStore.setEnabled(packageKey(packageType, packageId, version), enabled);
    await discoverAddons();
    await discoverComponentLibrary();
    return { packageType, packageId, version, enabled };
});

ipcMain.handle('projectUnlock', async (_event, { path, password }) => {
    if (!pendingEncryptedPaths.has(path)) throw new Error('Select the encrypted project again.');
    const project = await decodeProjectForRenderer(await readFile(path), { password });
    pendingEncryptedPaths.delete(path);
    return { path, fileName: basename(path), encrypted: true, ...project };
});

// Pull-based rather than pushed against a fresh window's did-finish-load: lets the renderer
// ask "was I opened with a file?" once on its own startup and reuse its existing open/unlock
// UI verbatim, rather than timing a webContents.send() against a load that can itself fail.
ipcMain.handle('projectPendingOpen', (event) => {
    const window = getWindowFromEvent(event);
    const pending = pendingWindowOpens.get(window);
    if (pending) pendingWindowOpens.delete(window);
    return pending ?? null;
});

// Lets openOrFocusProjectFile find an already-open window on the same file instead of opening
// a confusing duplicate -- main has no other visibility into which window has which file open.
ipcMain.on('projectPathChanged', (event, path) => {
    if (!senderIsProjectWindow(event)) return;
    const state = projectWindowState.get(getWindowFromEvent(event));
    if (state) state.currentProjectPath = path || null;
});

ipcMain.handle('projectSave', async (event, { path: existingPath, content, suggestedFilename, password, resultSessionId }) => {
    const targetWindow = getWindowFromEvent(event);
    let path = existingPath;
    if (!path) {
        const defaultName = suggestedFilename || 'untitled.kjt';
        const result = await dialog.showSaveDialog(targetWindow, {
            title: 'Save Konjugate project',
            defaultPath: defaultName,
            filters: [{ name: password ? 'Encrypted Konjugate project' : 'Konjugate project', extensions: ['kjt'] }]
        });
        if (result.canceled) return null;
        path = result.filePath;
    }
    if (!path.toLowerCase().endsWith('.kjt')) path += '.kjt';
    const storedResult = resultSessionId ? completedEngineResults.get(resultSessionId) : null;
    if (resultSessionId && !storedResult?.path) throw new Error('The simulation results are no longer available.');
    const resultBytes = storedResult ? await readFile(storedResult.path) : null;
    const bytes = await encodeProjectFile(content, { password, result: resultBytes });
    const verification = await decodeProjectBundle(bytes, { password });
    if (verification.content !== content || Boolean(verification.result) !== Boolean(resultBytes)) {
        throw new Error('The saved project could not be verified.');
    }
    await atomicWriteFile(path, bytes);
    return { path, fileName: basename(path), encrypted: Boolean(password), includesResults: Boolean(resultBytes) };
});

ipcMain.handle('projectExportResultsCsv', async (event, { suggestedFilename, csv }) => {
    const targetWindow = getWindowFromEvent(event);
    const result = await dialog.showSaveDialog(targetWindow, {
        title: 'Export results as CSV',
        defaultPath: suggestedFilename || 'results.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (result.canceled) return null;
    let path = result.filePath;
    if (!path.toLowerCase().endsWith('.csv')) path += '.csv';
    await writeFile(path, csv, 'utf8');
    return { path, fileName: basename(path) };
});

ipcMain.handle('projectConfirmDiscard', async (event) => {
    const result = await dialog.showMessageBox(getWindowFromEvent(event), {
        type: 'warning',
        title: 'Unsaved changes',
        message: 'Discard unsaved changes?',
        detail: 'Unsaved model changes or simulation results cannot be recovered after closing or opening another project.',
        buttons: ['Cancel', 'Discard changes'],
        defaultId: 0,
        cancelId: 0
    });
    return result.response === 1;
});

function runProcess(command, args, { input } = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args);
        } catch (error) {
            resolve({ code: -1, stdout: '', stderr: error.message });
            return;
        }
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => resolve({ code: -1, stdout: '', stderr: error.message }));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        if (input !== undefined) child.stdin.write(input);
        child.stdin.end();
    });
}

// Returns what auto-detection alone would choose, ignoring any stored override — used both
// as resolveCppCompiler()'s fallback and to show the user what "auto-detect" currently means.
async function autoDetectCppCompiler() {
    if (process.platform === 'darwin') {
        const result = await runProcess('xcrun', ['-find', 'clang++']);
        if (result.code === 0 && result.stdout.trim()) return { compiler: result.stdout.trim(), flavor: 'clang' };
    }
    if (process.platform === 'win32') {
        const msvcBin = 'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Tools\\MSVC\\14.51.36231\\bin\\Hostx64\\x64';
        if (existsSync(msvcBin) && !process.env.PATH.includes(msvcBin)) {
            process.env.PATH = msvcBin + ';' + process.env.PATH;
        }
        const candidateCls = [
            'cl.exe',
            'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Tools\\MSVC\\14.51.36231\\bin\\Hostx64\\x64\\cl.exe',
            'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.40.33807\\bin\\Hostx64\\x64\\cl.exe'
        ];
        for (const candidate of candidateCls) {
            const clResult = await runProcess(candidate, ['/?']);
            if (clResult.code === 0 || clResult.stderr.includes('Microsoft') || clResult.stdout.includes('Microsoft')) {
                return { compiler: candidate, flavor: 'msvc' };
            }
        }
        for (const candidate of ['clang++', 'g++', 'c++']) {
            const result = await runProcess(candidate, ['--version']);
            if (result.code === 0) return { compiler: candidate, flavor: 'clang' };
        }
    }
    return { compiler: 'c++', flavor: 'clang' };
}

// A GUI-launched app doesn't inherit the shell PATH additions a compiler manager (Homebrew,
// asdf, a non-default MSVC install, ...) may rely on, so auto-detection can genuinely miss a
// toolchain that is present on the machine. A stored override takes precedence when set.
async function resolveCppCompiler() {
    const overridePath = (await providerToolchainStore.get()).cpp.compilerPath;
    if (overridePath) {
        return { compiler: overridePath, flavor: /(^|[\\/])cl(\.exe)?$/i.test(overridePath) ? 'msvc' : 'clang' };
    }
    return autoDetectCppCompiler();
}

async function autoDetectPythonInterpreter() {
    for (const candidate of ['python3', 'python']) {
        if ((await runProcess(candidate, ['--version'])).code === 0) return candidate;
    }
    return null;
}

async function resolvePythonInterpreter() {
    const overridePath = (await providerToolchainStore.get()).python.interpreterPath;
    if (overridePath) return overridePath;
    return (await autoDetectPythonInterpreter()) ?? 'python3';
}

// Runs a candidate compiler/interpreter path with a harmless version-reporting flag to confirm
// it is actually runnable, before it is saved as an override or used to explain a failure.
async function testToolchainPath(kind, path) {
    const trimmed = (path ?? '').trim();
    if (!trimmed) return { valid: false, message: 'Enter a path first.' };
    if (kind === 'python') {
        const result = await runProcess(trimmed, ['--version']);
        if (result.code === 0) return { valid: true, message: (result.stdout || result.stderr).trim() || 'Python found.' };
        return { valid: false, message: result.stderr.trim() || result.stdout.trim() || 'That path could not be run.' };
    }
    const versionResult = await runProcess(trimmed, ['--version']);
    if (versionResult.code === 0) return { valid: true, message: versionResult.stdout.trim().split('\n')[0] || 'Compiler found.' };
    const helpResult = await runProcess(trimmed, ['/?']);
    if (helpResult.code === 0 || helpResult.stdout.includes('Microsoft') || helpResult.stderr.includes('Microsoft')) {
        return { valid: true, message: 'MSVC compiler found.' };
    }
    return { valid: false, message: versionResult.stderr.trim() || versionResult.stdout.trim() || 'That path could not be run.' };
}

async function resolveAppleSdkSysroot() {
    const result = await runProcess('xcrun', ['--show-sdk-path']);
    return result.code === 0 ? result.stdout.trim() : '';
}

function parseCompilerDiagnostics(output, filePath) {
    const clangPattern = /^(.*):(\d+):(\d+):\s+(error|warning|note):\s+(.*)$/;
    const msvcPattern = /^(.*)\((\d+)(?:,(\d+))?\):\s+(error|warning)\s+([A-Z0-9]+):\s+(.*)$/;
    const severityByLevel = { error: 'error', warning: 'warning', note: 'info' };
    const diagnostics = [];
    for (const rawLine of output.split('\n')) {
        const trimmed = rawLine.trim();
        const clangMatch = trimmed.match(clangPattern);
        if (clangMatch && (clangMatch[1] === filePath || clangMatch[1].endsWith('relationship.cpp'))) {
            diagnostics.push({
                line: Number(clangMatch[2]),
                column: Number(clangMatch[3]),
                severity: severityByLevel[clangMatch[4]] ?? 'error',
                message: clangMatch[5]
            });
            continue;
        }
        const msvcMatch = trimmed.match(msvcPattern);
        if (msvcMatch && (msvcMatch[1] === filePath || msvcMatch[1].endsWith('relationship.cpp'))) {
            diagnostics.push({
                line: Number(msvcMatch[2]),
                column: Number(msvcMatch[3] ?? 1),
                severity: severityByLevel[msvcMatch[4]] ?? 'error',
                message: `${msvcMatch[5]}: ${msvcMatch[6]}`
            });
        }
    }
    return diagnostics;
}

function findMsvcIncludeDirs() {
    const includeDirs = [];
    const vsBases = [
        'C:\\Program Files\\Microsoft Visual Studio',
        'C:\\Program Files (x86)\\Microsoft Visual Studio'
    ];
    for (const vsBase of vsBases) {
        if (!existsSync(vsBase)) continue;
        try {
            for (const year of readdirSync(vsBase)) {
                const yearPath = join(vsBase, year);
                for (const edition of readdirSync(yearPath)) {
                    const msvcPath = join(yearPath, edition, 'VC', 'Tools', 'MSVC');
                    if (existsSync(msvcPath)) {
                        for (const version of readdirSync(msvcPath)) {
                            const inc = join(msvcPath, version, 'include');
                            if (existsSync(inc)) {
                                includeDirs.push(inc);
                                break;
                            }
                        }
                    }
                    if (includeDirs.length) break;
                }
                if (includeDirs.length) break;
            }
        } catch {}
        if (includeDirs.length) break;
    }
    const winKitsBases = [
        'C:\\Program Files (x86)\\Windows Kits\\10\\Include',
        'C:\\Program Files\\Windows Kits\\10\\Include'
    ];
    for (const winKitBase of winKitsBases) {
        if (!existsSync(winKitBase)) continue;
        try {
            const sdks = readdirSync(winKitBase);
            if (sdks.length) {
                const latestSdk = join(winKitBase, sdks[sdks.length - 1]);
                for (const sub of ['ucrt', 'um', 'shared']) {
                    const inc = join(latestSdk, sub);
                    if (existsSync(inc)) includeDirs.push(inc);
                }
                break;
            }
        } catch {}
    }
    return includeDirs;
}

// Runs syntax checking (-fsyntax-only on Clang/GCC, /zs on MSVC), a parse/type-check pass that never produces or runs a binary.
async function validateCppSource(source) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateProviderCheck-'));
    try {
        const filePath = join(directory, 'relationship.cpp');
        await writeFile(filePath, source ?? '', 'utf8');
        const { compiler, flavor } = await resolveCppCompiler();
        const includePath = join(cppProviderSdkPath({
            applicationPath: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged
        }), 'include');
        let args;
        if (flavor === 'msvc') {
            const msvcIncs = findMsvcIncludeDirs();
            if (!process.env.INCLUDE && msvcIncs.length) {
                process.env.INCLUDE = msvcIncs.join(';');
            }
            args = ['/std:c++20', '/EHsc', '/Zs', '/nologo', '/I' + includePath];
            for (const dir of msvcIncs) {
                args.push('/I' + dir);
            }
            args.push(filePath);
        } else {
            args = ['-std=c++20', '-fsyntax-only', '-I' + includePath];
            if (process.platform === 'darwin') {
                const sysroot = await resolveAppleSdkSysroot();
                if (sysroot) args.push('-isysroot', sysroot);
            }
            args.push(filePath);
        }
        const result = await runProcess(compiler, args);
        const output = (result.stderr + '\n' + result.stdout).trim();
        const diagnostics = parseCompilerDiagnostics(output, filePath);
        if (result.code !== 0 && diagnostics.length === 0) {
            diagnostics.push({
                line: 1,
                column: 1,
                severity: 'error',
                message: output || `The C++ compiler ("${compiler}") exited with code ${result.code}.`
            });
        }
        return { valid: result.code === 0, diagnostics };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// Pure ast.parse — a syntax check only. It never imports or executes the source, which
// matters because this runs automatically as the user types.
const PYTHON_SYNTAX_CHECK_SCRIPT = 'import ast, sys\n'
    + 'try:\n'
    + '    ast.parse(sys.stdin.read())\n'
    + 'except SyntaxError as error:\n'
    + '    print(f"{error.lineno or 1}:{error.offset or 1}: {error.msg}", file=sys.stderr)\n'
    + '    sys.exit(1)\n';

async function validatePythonSource(source) {
    const interpreter = await resolvePythonInterpreter();
    const result = await runProcess(interpreter, ['-c', PYTHON_SYNTAX_CHECK_SCRIPT], { input: source ?? '' });
    if (result.code === 0) return { valid: true, diagnostics: [] };
    const match = result.stderr.trim().match(/^(\d+):(\d+):\s*(.*)$/);
    if (!match) {
        return { valid: false, diagnostics: [{ line: 1, column: 1, severity: 'error', message: result.stderr.trim() || 'Python syntax check failed.' }] };
    }
    return { valid: false, diagnostics: [{ line: Number(match[1]), column: Number(match[2]), severity: 'error', message: match[3] }] };
}

ipcMain.handle('providerEditorOpenWindow', (event, payload) => {
    openProviderEditorWindow(getWindowFromEvent(event), event.sender, payload);
});

ipcMain.handle('providerEditorValidate', async (_event, { source, kind }) => (
    kind === 'python' ? validatePythonSource(source) : validateCppSource(source)
));

ipcMain.handle('providerEditorApply', (event, { source }) => {
    // This call comes from the provider-editor window itself, not a project window -- find
    // which project window owns it (each can have its own provider editor open now).
    const projectWindow = projectWindowForAuxSender(event, 'providerEditorWindow');
    const state = projectWindow && projectWindowState.get(projectWindow);
    if (!state?.providerEditorOwner || state.providerEditorOwner.isDestroyed()) {
        return { applied: false, error: 'The originating window is no longer available.' };
    }
    // The project window computes success/failure (e.g. its edge or source term may have been
    // deleted while this editor was open) and reports back over providerEditorApplyResult,
    // since webContents.send() has no built-in reply channel of its own.
    state.pendingProviderApply?.({ applied: false, error: 'Superseded by a newer apply.' });
    return new Promise((resolve) => {
        state.pendingProviderApply = resolve;
        state.providerEditorOwner.send('providerEditorApplied', { source });
    });
});

ipcMain.on('providerEditorApplyResult', (event, result) => {
    if (!senderIsProjectWindow(event)) return;
    const state = projectWindowState.get(getWindowFromEvent(event));
    state.pendingProviderApply?.(result);
    state.pendingProviderApply = null;
});

ipcMain.on('clipboardReadBuffer', (event, format) => {
    event.returnValue = clipboard.readBuffer(format);
});

ipcMain.on('clipboardWriteBuffer', (event, { format, buffer }) => {
    clipboard.writeBuffer(format, Buffer.from(buffer));
    event.returnValue = true;
});

const requireToolchainWindow = (event) => requireProjectWindow(event, 'Only a project window can access toolchain settings.');

ipcMain.handle('providerToolchainGet', async (event, kind) => {
    requireToolchainWindow(event);
    const settings = await providerToolchainStore.get();
    const overridePath = kind === 'python' ? settings.python.interpreterPath : settings.cpp.compilerPath;
    const guess = kind === 'python' ? await autoDetectPythonInterpreter() : (await autoDetectCppCompiler()).compiler;
    const detectedPath = guess && (await testToolchainPath(kind, guess)).valid ? guess : null;
    return { overridePath, detectedPath };
});

ipcMain.handle('providerToolchainSet', async (event, { kind, path }) => {
    requireToolchainWindow(event);
    const trimmed = (path ?? '').trim();
    if (trimmed) {
        const test = await testToolchainPath(kind, trimmed);
        if (!test.valid) throw new Error(test.message || 'That path could not be verified.');
    }
    const settings = await providerToolchainStore.set(kind, trimmed);
    return kind === 'python' ? settings.python : settings.cpp;
});

ipcMain.handle('providerToolchainTest', async (event, { kind, path }) => {
    requireToolchainWindow(event);
    return testToolchainPath(kind, path);
});

ipcMain.handle('providerToolchainBrowse', async (event, kind) => {
    requireToolchainWindow(event);
    const result = await dialog.showOpenDialog(getWindowFromEvent(event), {
        title: kind === 'python' ? 'Select a Python interpreter' : 'Select a C++ compiler',
        properties: ['openFile'],
        ...(process.platform === 'win32' ? { filters: [{ name: 'Executable', extensions: ['exe'] }] } : {})
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
});

// Advanced/expert setting: how C++ relationship providers run relative to the engine process.
// See ProviderExecutionMode in the engine for what each option actually does; '' ("Automatic")
// leaves it to the engine's own default rather than persisting a specific choice, so a future
// change to that default reaches users who never touched this setting.
ipcMain.handle('providerExecutionModeGet', async (event) => {
    requireToolchainWindow(event);
    const settings = await providerToolchainStore.get();
    return { executionMode: settings.executionMode, options: providerExecutionModes };
});

ipcMain.handle('providerExecutionModeSet', async (event, executionMode) => {
    requireToolchainWindow(event);
    const settings = await providerToolchainStore.set('executionMode', executionMode);
    return { executionMode: settings.executionMode };
});

ipcMain.handle('aiListConfigurations', async (event) => {
    requireProjectWindow(event);
    const result = await aiConfigurationStore.list();
    return { ...result, providers: aiProviderRegistry.descriptors() };
});

ipcMain.handle('aiListModels', async (event, configurationUuid) => {
    requireProjectWindow(event);
    const resolved = await aiConfigurationStore.resolve(configurationUuid);
    return withAIOperation(event.sender, resolved.configuration.timeoutSeconds,
        (signal) => aiProviderRegistry.listModels({ ...resolved, signal }));
});

ipcMain.handle('aiListDraftModels', async (event, configuration, credential) => {
    requireProjectWindow(event);
    const resolved = await aiConfigurationStore.resolveDraft(configuration, credential);
    return withAIOperation(event.sender, resolved.configuration.timeoutSeconds,
        (signal) => aiProviderRegistry.listModels({ ...resolved, signal }));
});

ipcMain.handle('aiSaveConfiguration', async (event, configuration, credential) => {
    requireProjectWindow(event);
    return aiConfigurationStore.save(configuration, credential);
});

ipcMain.handle('aiRemoveConfiguration', async (event, configurationUuid) => {
    requireProjectWindow(event);
    return aiConfigurationStore.remove(configurationUuid);
});

ipcMain.handle('aiSetActiveConfiguration', async (event, configurationUuid) => {
    requireProjectWindow(event);
    return aiConfigurationStore.setActive(configurationUuid);
});

ipcMain.handle('aiTestConnection', async (event, configurationUuid) => {
    requireProjectWindow(event);
    const resolved = await aiConfigurationStore.resolve(configurationUuid);
    return withAIOperation(event.sender, resolved.configuration.timeoutSeconds,
        (signal) => aiProviderRegistry.testConnection({ ...resolved, signal }));
});

ipcMain.handle('aiTestDraftConnection', async (event, configuration, credential) => {
    requireProjectWindow(event);
    const resolved = await aiConfigurationStore.resolveDraft(configuration, credential);
    return withAIOperation(event.sender, resolved.configuration.timeoutSeconds,
        (signal) => aiProviderRegistry.testConnection({ ...resolved, signal }));
});

ipcMain.handle('aiGenerateProposal', async (event, { requestUuid, configurationUuid, request, context, history }) => {
    requireProjectWindow(event);
    if (typeof requestUuid !== 'string' || requestUuid.length > 100) throw new Error('A valid AI request identifier is required.');
    if (typeof request !== 'string' || !request.trim() || request.length > 8000) throw new Error('The AI request must contain between 1 and 8,000 characters.');
    if (!context || typeof context !== 'object' || JSON.stringify(context).length > 1_000_000) throw new Error('The model context is invalid or too large.');
    if (history !== undefined) {
        const validHistory = Array.isArray(history) && history.length <= 5 &&
            history.every((turn) => turn && typeof turn.request === 'string' && typeof turn.outcome === 'string');
        if (!validHistory || JSON.stringify(history).length > 20_000) throw new Error('The conversation history is invalid or too large.');
    }
    const key = aiRequestKey(event.sender, requestUuid);
    activeAIRequests.get(key)?.controller.abort();
    const resolved = await aiConfigurationStore.resolve(configurationUuid);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, resolved.configuration.timeoutSeconds * 1000);
    activeAIRequests.set(key, { owner: event.sender, controller });
    try {
        const proposal = await aiProviderRegistry.generate({ ...resolved, context, request: request.trim(), history, signal: controller.signal });
        return { ok: true, proposal };
    } catch (error) {
        const message = timedOut
            ? `The model did not respond within ${resolved.configuration.timeoutSeconds} seconds. Increase the timeout in this model configuration or choose a faster model.`
            : error.name === 'AbortError' ? 'Proposal generation was cancelled.' : error.message;
        const code = timedOut ? 'requestTimedOut' : error.name === 'AbortError' ? 'requestCancelled' : error.code ?? 'providerError';
        return { ok: false, error: { message, code } };
    } finally {
        clearTimeout(timeout);
        if (activeAIRequests.get(key)?.controller === controller) activeAIRequests.delete(key);
    }
});

ipcMain.handle('aiCancelRequest', async (event, requestUuid) => {
    requireProjectWindow(event);
    const key = aiRequestKey(event.sender, requestUuid);
    const active = activeAIRequests.get(key);
    if (!active || active.owner !== event.sender) return false;
    active.controller.abort();
    activeAIRequests.delete(key);
    return true;
});

const engineOptions = async () => {
    const resolvedCpp = await resolveCppCompiler();
    const resolvedPython = await resolvePythonInterpreter();
    const { executionMode } = await providerToolchainStore.get();
    return {
        applicationPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        packaged: app.isPackaged,
        pluginDirectory: join(app.getPath('userData'), 'packages'),
        disabledPluginKeys: await extensionStateStore.list(),
        providerToolchains: {
            cpp: { compilerPath: resolvedCpp?.compiler ?? '' },
            python: { interpreterPath: resolvedPython ?? '' },
            executionMode
        }
    };
};

const cliUsage = 'Usage: konjugate --cli run <project.kjt> --target-time <seconds> '
    + '[--configuration <name-or-id>] [--output-kjt <path>] [--output-csv <path>]\n'
    + '       konjugate --cli validate <project.kjt>';

// Runs entirely inside app.whenReady() (see the branch there) -- never creates a BrowserWindow,
// and always ends in app.exit(code) rather than leaving the process running or calling the
// graceful app.quit(), since a CLI invocation is a one-shot batch job, not a long-lived instance.
async function runCliMode() {
    const cliArgs = process.argv.slice(process.argv.indexOf('--cli') + 1);
    const [subcommand, inputPath, ...rest] = cliArgs;
    if (!subcommand || !inputPath || !['run', 'validate'].includes(subcommand)) {
        console.error(cliUsage);
        app.exit(2);
        return;
    }
    const flags = parseCliFlags(rest);

    providerToolchainStore = createProviderToolchainStore({ directory: join(app.getPath('userData'), 'providers') });
    extensionStateStore = createExtensionStateStore({
        directory: join(app.getPath('userData'), 'packages'),
        defaultDisabled: await defaultDisabledExtensionKeys()
    });

    let bundle;
    try {
        // KONJUGATE_PASSWORD, not a --password flag, matching the engine's own CLI convention
        // for the same input -- a password never belongs in shell history or a process list.
        bundle = await decodeProjectBundle(await readFile(inputPath), { password: process.env.KONJUGATE_PASSWORD });
    } catch (error) {
        console.error(`Could not read or decode "${inputPath}": ${error.message}`);
        app.exit(1);
        return;
    }
    const options = await engineOptions();

    if (subcommand === 'validate') {
        const outcome = await validateWithEngine(bundle.content, options);
        if (!outcome.available) {
            console.error('The simulation engine is unavailable.');
            app.exit(1);
            return;
        }
        console.log(JSON.stringify(outcome.report, null, 2));
        app.exit(outcome.report.valid ? 0 : 2);
        return;
    }

    const targetTime = Number(flags['target-time']);
    if (!Number.isFinite(targetTime) || targetTime <= 0) {
        console.error('--target-time <seconds> (a positive number) is required for --cli run.');
        app.exit(2);
        return;
    }
    const document = JSON.parse(bundle.content);
    const runConfigurations = document.runConfigurations ?? [];
    const runConfiguration = matchRunConfiguration(runConfigurations, document.activeRunConfigurationId, flags.configuration);
    if (flags.configuration && !runConfiguration) {
        console.error(`No run configuration named or numbered "${flags.configuration}".`);
        app.exit(2);
        return;
    }
    if (!runConfiguration) {
        console.error('The project has no run configurations.');
        app.exit(2);
        return;
    }

    const configuration = { ...runConfiguration, targetTime, pacing: { mode: 'fastest' } };
    console.log(`Running "${inputPath}" with configuration "${runConfiguration.name}" for ${targetTime}s of simulated time...`);
    let execution;
    try {
        execution = await startEngineRun(
            JSON.stringify(stripEdgeGroups(executionProjectDocument(document))), configuration, options, { retainResult: true }
        );
    } catch (error) {
        console.error(`The simulation failed: ${error.message}`);
        app.exit(1);
        return;
    }
    if (!execution.available) {
        console.error('The simulation engine is unavailable.');
        app.exit(1);
        return;
    }

    let result;
    try {
        result = await execution.completion;
    } catch (error) {
        console.error(`The simulation failed: ${error.message}`);
        await execution.cleanup();
        app.exit(1);
        return;
    }

    try {
        if (flags['output-kjt']) {
            const resultBytes = await readFile(execution.resultPath);
            await atomicWriteFile(flags['output-kjt'], await encodeProjectFile(bundle.content, { result: resultBytes }));
            console.log(`Wrote ${flags['output-kjt']}`);
        }
        if (flags['output-csv']) {
            const csv = resultSignalsToCsv(result, projectDocumentSignals(document));
            await writeFile(flags['output-csv'], csv, 'utf8');
            console.log(`Wrote ${flags['output-csv']}`);
        }
        if (!flags['output-kjt'] && !flags['output-csv']) {
            console.log('Simulation completed. Pass --output-kjt and/or --output-csv to save the result.');
        }
    } catch (error) {
        console.error(`Could not write output: ${error.message}`);
        await execution.cleanup();
        app.exit(1);
        return;
    }
    await execution.cleanup();
    app.exit(0);
}

ipcMain.handle('engineValidate', async (event, content) => {
    const active = { owner: event.sender, controller: new AbortController(), completion: null };
    activeValidationOperations.add(active);
    try {
        active.completion = validateWithEngine(content, { ...await engineOptions(), signal: active.controller.signal });
        return await active.completion;
    } finally {
        activeValidationOperations.delete(active);
    }
});

ipcMain.handle('engineInfer', async (event, csvContent, config) => {
    const active = { owner: event.sender, controller: new AbortController(), completion: null };
    activeInferenceOperations.add(active);
    try {
        active.completion = inferWithEngine(csvContent, config, { ...await engineOptions(), signal: active.controller.signal });
        return await active.completion;
    } finally {
        activeInferenceOperations.delete(active);
    }
});

ipcMain.handle('engineRun', async (event, content, configuration) => {
    const execution = await startEngineRun(content, configuration, await engineOptions());
    if (!execution.available) return execution;
    activeEngineJobs.set(execution.jobId, { owner: event.sender, latestResult: null, ...execution });
    try {
        return { available: true, result: await execution.completion };
    } finally {
        activeEngineJobs.delete(execution.jobId);
    }
});

ipcMain.handle('engineStart', async (event, content, configuration) => {
    const owner = event.sender;
    const projectWindow = getWindowFromEvent(event);
    let execution;
    let latestUpdate = null;
    let updateTimer = null;
    const flushUpdate = () => {
        updateTimer = null;
        if (latestUpdate && !owner.isDestroyed()) owner.send('engineRunUpdate', latestUpdate);
        latestUpdate = null;
    };
    const projectLiveResult = (result) => ({
        ...result,
        samples: result.samples?.length ? [result.samples.at(-1)] : [],
        checkpoints: []
    });
    execution = await startEngineRun(content, configuration, await engineOptions(), {
        retainResult: true,
        onUpdate: (result) => {
            const job = activeEngineJobs.get(execution.jobId);
            if (job) job.latestResult = result;
            updateVisualizerResult(projectWindow, execution.jobId, result);
            latestUpdate = { jobId: execution.jobId, result: projectLiveResult(result) };
            updateTimer ??= setTimeout(flushUpdate, 100);
        }
    });
    if (!execution.available) return { available: false };
    activeEngineJobs.set(execution.jobId, { owner, latestResult: null, ...execution });
    execution.completion.then(async (result) => {
        if (updateTimer) clearTimeout(updateTimer);
        updateTimer = null;
        latestUpdate = null;
        const reader = await openIndexedResult(execution.resultPath);
        completedEngineResults.set(execution.jobId, { result, reader, cleanup: execution.cleanup, path: execution.resultPath });
        updateVisualizerResult(projectWindow, execution.jobId, result);
        if (!owner.isDestroyed()) owner.send('engineRunComplete', {
            jobId: execution.jobId,
            result: rendererResultProjection(result)
        });
    }).catch((error) => {
        if (updateTimer) clearTimeout(updateTimer);
        console.error(`[Engine Error] Simulation job ${execution.jobId} failed:`, error.message || error);
        execution.cleanup().catch(() => { });
        if (!owner.isDestroyed()) owner.send('engineRunError', { jobId: execution.jobId, message: error.message });
    }).finally(() => activeEngineJobs.delete(execution.jobId));
    return { available: true, jobId: execution.jobId };
});

ipcMain.handle('engineSetPacing', async (event, jobId, pacing) => {
    const job = activeEngineJobs.get(jobId);
    if (!job || job.owner !== event.sender) throw new Error('That simulation job is not active.');
    return job.setPacing(pacing);
});

ipcMain.handle('engineSetExecutionState', async (event, jobId, executionState) => {
    const job = activeEngineJobs.get(jobId);
    if (!job || job.owner !== event.sender) throw new Error('That simulation job is not active.');
    return job.setExecutionState(executionState);
});

ipcMain.handle('engineSetParameterValue', async (event, jobId, parameterId, value) => {
    const job = activeEngineJobs.get(jobId);
    if (!job || job.owner !== event.sender) throw new Error('That simulation job is not active.');
    return job.setParameterValue(parameterId, value);
});

ipcMain.handle('engineCancel', async (event, jobId) => {
    const job = activeEngineJobs.get(jobId);
    if (!job || job.owner !== event.sender) return false;
    await job.cancel();
    return true;
});

ipcMain.handle('engineReadResultSeries', async (event, jobId, signalIds, options) => {
    if (!senderIsProjectWindow(event)) return [];
    const stored = completedEngineResults.get(jobId);
    if (!stored) return [];
    const result = {
        ...stored.reader.metadata,
        samples: await stored.reader.readSamples({
            startTime: options?.startTime,
            endTime: options?.endTime,
            maximumSamples: options?.maxPoints
        })
    };
    return resultSignalSeries(result, signalIds, options);
});

ipcMain.handle('engineReadResultSample', async (event, jobId, time) => {
    if (!senderIsProjectWindow(event)) return null;
    const stored = completedEngineResults.get(jobId);
    if (!stored) return null;
    return structuredClone(await stored.reader.readNearestSample(Number(time)));
});

ipcMain.handle('engineReleaseResult', async (event, jobId) => {
    if (!senderIsProjectWindow(event)) return false;
    const stored = completedEngineResults.get(jobId);
    if (!stored) return false;
    completedEngineResults.delete(jobId);
    await stored.reader.close();
    await stored.cleanup();
    return true;
});

app.whenReady().then(async () => {
    if (isCliMode) {
        await runCliMode();
        return;
    }
    const operationSchema = JSON.parse(await readFile(join(currentDir, '..', 'schemas', 'assistantOperations.schema.json'), 'utf8'));
    aiProviderRegistry = createAIProviderRegistry(createRemoteAIProviders({ operationSchema }));
    aiConfigurationStore = createAIConfigurationStore({
        directory: join(app.getPath('userData'), 'ai'),
        credentialVault: createElectronCredentialVault(safeStorage)
    });
    providerToolchainStore = createProviderToolchainStore({
        directory: join(app.getPath('userData'), 'providers')
    });
    extensionStateStore = createExtensionStateStore({
        directory: join(app.getPath('userData'), 'packages'),
        defaultDisabled: await defaultDisabledExtensionKeys()
    });

    // A file passed on the initial launch (Windows/Linux double-click, or a path Electron
    // handed us via process.argv) opens directly into the first window rather than opening
    // blank and then a second one; any additional macOS open-file paths queued before ready
    // get their own window each via the normal open-or-focus routing.
    const initialPath = parseKjtPathFromArgv(process.argv) ?? openFileQueue.shift() ?? null;
    const firstWindow = initialPath
        ? createProjectWindow(readProjectFilePayload(initialPath).catch((error) => ({ error: error.message })))
        : createProjectWindow();
    for (const queuedPath of openFileQueue.splice(0)) openOrFocusProjectFile(queuedPath);

    // These CLI-driven harness hooks are wired only for this one, first-created window --
    // never inside createProjectWindow() itself, since that factory is also used for every
    // window a user opens via "New Window" (and every window the interaction-test suite itself
    // opens to exercise multi-window behavior), which must never recursively re-run the suite.
    if (process.argv.includes('--interaction-test')) {
        firstWindow.webContents.once('did-finish-load', async () => {
            try {
                const { runInteractionTests } = await import('../tests/interactionRunner.mjs');
                await runInteractionTests(firstWindow);
                app.exit(0);
            } catch (error) {
                console.error(error);
                app.exit(1);
            }
        });
    } else {
        checkForUpdates(firstWindow);
    }
    if (process.argv.includes('--generate-example-thumbnails')) {
        firstWindow.webContents.once('did-finish-load', async () => {
            try {
                const { generateExampleThumbnails } = await import('../tests/generateExampleThumbnails.mjs');
                await generateExampleThumbnails(firstWindow);
                app.exit(0);
            } catch (error) {
                console.error(error);
                app.exit(1);
            }
        });
    }

    app.on('activate', () => {
        if (projectWindows.size === 0) {
            createProjectWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', (event) => {
    if (applicationShutdownComplete) return;
    event.preventDefault();
    beginApplicationShutdown().finally(() => {
        applicationShutdownComplete = true;
        app.quit();
    });
});
