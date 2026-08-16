/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeProjectBundle, encodeProjectFile, inspectProjectFile } from './projectFile.mjs';
import { cppProviderSdkPath, startEngineRun, validateWithEngine } from './engineAdapter.mjs';
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
import { auxiliaryWindowPresentation, senderOwnsWindow } from './windowLifecycle.mjs';
import { listDiagnostics, onDiagnostic, recordDiagnostic } from './diagnosticsLog.mjs';

if ((process.argv.includes('--interaction-test') || process.argv.includes('--generate-example-thumbnails')) && process.env.KONJUGATE_INTERACTION_USER_DATA) {
    app.setPath('userData', process.env.KONJUGATE_INTERACTION_USER_DATA);
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
let mainWindow = null;
let analysisWindow = null;
let exampleGuideWindow = null;
let exampleGuideBounds = null;
let providerEditorWindow = null;
let providerEditorBounds = null;
let providerEditorOwner = null;
let analysisAddonId = null;
let visualizerManifest = null;
let visualizerSession = null;
const addonRegistry = new Map();
const activeEngineJobs = new Map();
const completedEngineResults = new Map();
const activeAIRequests = new Map();
const activeAIOperations = new Set();
const activeValidationOperations = new Set();
let aiProviderRegistry = null;
let aiConfigurationStore = null;
let providerToolchainStore = null;
let applicationShutdownPromise = null;
let applicationShutdownComplete = false;

function getWindowFromEvent(event) {
    return BrowserWindow.fromWebContents(event.sender);
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

function createWindow() {
    mainWindow = new BrowserWindow({
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

    const owner = mainWindow.webContents;
    const ownerUnavailable = () => {
        abortAIOperations(owner);
        shutdownValidationOperations(owner);
        shutdownEngineJobs(owner);
    };
    owner.once('destroyed', ownerUnavailable);
    owner.once('render-process-gone', ownerUnavailable);

    installCustomWindowState(mainWindow);

    if (process.argv.includes('--interaction-test')) {
        mainWindow.webContents.once('did-finish-load', async () => {
            try {
                const { runInteractionTests } = await import('../tests/interactionRunner.mjs');
                await runInteractionTests(mainWindow);
                app.exit(0);
            } catch (error) {
                console.error(error);
                app.exit(1);
            }
        });
    }
    if (process.argv.includes('--generate-example-thumbnails')) {
        mainWindow.webContents.once('did-finish-load', async () => {
            try {
                const { generateExampleThumbnails } = await import('../tests/generateExampleThumbnails.mjs');
                await generateExampleThumbnails(mainWindow);
                app.exit(0);
            } catch (error) {
                console.error(error);
                app.exit(1);
            }
        });
    }

    mainWindow.loadFile(join(currentDir, 'renderer', 'index.html'));
}

async function checkForUpdates() {
    let update;
    try {
        update = await findAvailableUpdate(app.getVersion());
    } catch (error) {
        console.warn('Update check failed:', error.message);
        return;
    }
    if (!update || !mainWindow || mainWindow.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
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

async function openExampleGuide(id) {
    if (!(await exampleFiles()).includes(id)) throw new Error('That example is not available.');
    const guideName = id.replace(/\.kjt$/, '.md');
    const markdown = await readFile(join(examplesDir, guideName), 'utf8');
    const payload = { id, title: exampleLabel(id), markdown };
    if (!exampleGuideWindow || exampleGuideWindow.isDestroyed()) {
        exampleGuideWindow = new BrowserWindow({
            width: 720,
            height: 760,
            ...exampleGuideBounds,
            ...auxiliaryWindowPresentation(mainWindow),
            minWidth: 480,
            minHeight: 420,
            frame: false,
            backgroundColor: '#09131b',
            title: `${payload.title} · Example Guide`,
            webPreferences: {
                preload: join(currentDir, 'exampleGuide', 'preload.cjs'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
            }
        });
        installCustomWindowState(exampleGuideWindow);
        exampleGuideWindow.on('close', () => { exampleGuideBounds = exampleGuideWindow?.getBounds() ?? exampleGuideBounds; });
        exampleGuideWindow.on('closed', () => { exampleGuideWindow = null; });
        exampleGuideWindow.webContents.once('did-finish-load', () => exampleGuideWindow?.webContents.send('exampleGuideContent', payload));
        await exampleGuideWindow.loadFile(join(currentDir, 'exampleGuide', 'index.html'));
    } else {
        exampleGuideWindow.setTitle(`${payload.title} · Example Guide`);
        exampleGuideWindow.webContents.send('exampleGuideContent', payload);
        exampleGuideWindow.show();
        exampleGuideWindow.focus();
    }
    return true;
}

function openProviderEditorWindow(ownerWebContents, payload) {
    providerEditorOwner = ownerWebContents;
    if (!providerEditorWindow || providerEditorWindow.isDestroyed()) {
        providerEditorWindow = new BrowserWindow({
            width: 820,
            height: 640,
            ...providerEditorBounds,
            ...auxiliaryWindowPresentation(mainWindow),
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
        installCustomWindowState(providerEditorWindow);
        providerEditorWindow.on('close', () => { providerEditorBounds = providerEditorWindow?.getBounds() ?? providerEditorBounds; });
        providerEditorWindow.on('closed', () => { providerEditorWindow = null; providerEditorOwner = null; });
        providerEditorWindow.webContents.once('did-finish-load', () => providerEditorWindow?.webContents.send('providerEditorContent', payload));
        providerEditorWindow.loadFile(join(currentDir, 'providerEditor', 'index.html'));
    } else {
        providerEditorWindow.webContents.send('providerEditorContent', payload);
        providerEditorWindow.show();
        providerEditorWindow.focus();
    }
}

function senderIs(window, event) {
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
}

function requireProjectWindow(event) {
    if (!senderIs(mainWindow, event)) throw new Error('Only the project window can access AI providers.');
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

function beginApplicationShutdown() {
    if (applicationShutdownPromise) return applicationShutdownPromise;
    abortAIOperations();
    applicationShutdownPromise = (async () => {
        await Promise.all([shutdownEngineJobs(), shutdownValidationOperations()]);
        await closeCompletedEngineResults();
    })();
    return applicationShutdownPromise;
}

function visualizerCan(permission) {
    return visualizerManifest?.permissions.includes(permission);
}

async function discoverAddons() {
    addonRegistry.clear();
    const addonRoots = [
        join(currentDir, '..', 'addons'),
        join(app.getPath('userData'), 'addons')
    ];
    for (const addonsDirectory of addonRoots) {
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
}

async function openResultsVisualizer({ addonDirectory, manifest }, payload) {
    if (analysisWindow && !analysisWindow.isDestroyed() && analysisAddonId !== manifest.addonId) {
        analysisWindow.destroy();
        analysisWindow = null;
    }
    analysisAddonId = manifest.addonId;
    visualizerManifest = manifest;
    const liveResult = activeEngineJobs.get(payload.engineJobId)?.latestResult;
    const completedResult = completedEngineResults.get(payload.engineJobId)?.result;
    visualizerSession = createVisualizerSession({ ...payload, result: liveResult ?? completedResult ?? payload.result, sessionId: randomUUID() });
    if (analysisWindow && !analysisWindow.isDestroyed()) {
        analysisWindow.setTitle(`${visualizerSession.projectName} — Results`);
        analysisWindow.webContents.send('visualizerSessionChange');
        analysisWindow.show();
        analysisWindow.focus();
        return;
    }
    const createdWindow = new BrowserWindow({
        width: 1080,
        height: 720,
        minWidth: 720,
        minHeight: 480,
        title: `${visualizerSession.projectName} — Results`,
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
    analysisWindow = createdWindow;
    createdWindow.on('closed', () => {
        if (analysisWindow === createdWindow) {
            analysisWindow = null;
            analysisAddonId = null;
        }
    });
    await analysisWindow.loadFile(join(addonDirectory, manifest.entry));
}

ipcMain.handle('addonListToolstripContributions', async (event) => {
    if (!senderIs(mainWindow, event)) return [];
    await discoverAddons();
    return [...addonRegistry.values()].flatMap(({ manifest }) => publicToolstripContributions(manifest));
});

ipcMain.handle('addonInvokeCommand', async (event, { addonId, commandId, contexts = {} }) => {
    if (!senderIs(mainWindow, event)) throw new Error('Only the project window can invoke add-on commands.');
    if (!addonRegistry.size) await discoverAddons();
    const addon = addonRegistry.get(addonId);
    const contribution = addon?.manifest.contributes?.toolstrip?.find((item) => item.commandId === commandId);
    if (!addon || !contribution) throw new Error('That add-on command is unavailable.');
    if (!(contribution.contexts ?? []).every((context) => contexts[context])) throw new Error('The add-on command requires unavailable context.');
    if (addon.manifest.kind === 'resultVisualizer') {
        await openResultsVisualizer(addon, contexts.resultSession);
        return { addonId, commandId, sessionId: visualizerSession.sessionId };
    }
    throw new Error(`Unsupported add-on kind: ${addon.manifest.kind}.`);
});

ipcMain.on('visualizerHostTimelineChange', (event, time) => {
    if (!senderIs(mainWindow, event) || !visualizerSession) return;
    visualizerSession.time = Number(time);
    if (visualizerCan('timeline.read') && analysisWindow && !analysisWindow.isDestroyed()) {
        analysisWindow.webContents.send('visualizerTimelineChange', visualizerSession.time);
    }
});

ipcMain.on('visualizerHostSelectionChange', (event, nodeId) => {
    if (!senderIs(mainWindow, event) || !visualizerSession) return;
    visualizerSession.selectedNodeId = nodeId ?? null;
    if (visualizerCan('selection.read') && analysisWindow && !analysisWindow.isDestroyed()) {
        analysisWindow.webContents.send('visualizerSelectionChange', nodeId ?? null);
    }
});

function updateVisualizerResult(jobId, result) {
    if (!visualizerSession || visualizerSession.engineJobId !== jobId) return;
    visualizerSession.samples = result.samples;
    visualizerSession.run = {
        ...visualizerSession.run,
        sampleCount: result.samples.length,
        lifecycle: result.lifecycle,
        simulationTime: Number(result.simulationTime),
        availableResultTime: Number(result.availableResultTime),
        pacing: structuredClone(result.pacing)
    };
    if (!analysisWindow || analysisWindow.isDestroyed()) return;
    if (visualizerCan('results.live.read')) {
        analysisWindow.webContents.send('visualizerSamplesAvailable', {
            sampleCount: visualizerSession.run.sampleCount,
            availableResultTime: visualizerSession.run.availableResultTime
        });
    }
    if (visualizerCan('simulation.status.read')) {
        analysisWindow.webContents.send('visualizerRunStatusChange', structuredClone(visualizerSession.run));
    }
    if (visualizerCan('simulation.pacing.read')) {
        analysisWindow.webContents.send('visualizerPacingChange', structuredClone(visualizerSession.run.pacing));
    }
}

ipcMain.on('visualizerCloseSession', (event) => {
    if (!senderIs(mainWindow, event)) return;
    visualizerSession = null;
    visualizerManifest = null;
    analysisAddonId = null;
    analysisWindow?.close();
});

ipcMain.handle('visualizerGetContext', (event) => {
    if (!senderIs(analysisWindow, event) || !visualizerSession || !visualizerCan('results.read')) return null;
    return publicVisualizerContext(visualizerSession);
});

ipcMain.handle('visualizerListSignals', (event) => {
    if (!senderIs(analysisWindow, event) || !visualizerSession || !visualizerCan('results.read')) return [];
    return structuredClone(visualizerSession.signals);
});

ipcMain.handle('visualizerReadSeries', (event, { signalIds, options }) => {
    if (!senderIs(analysisWindow, event) || !visualizerSession || !visualizerCan('results.read')) return [];
    return readSignalSeries(visualizerSession, signalIds, options);
});

ipcMain.handle('visualizerTitlebarStylesheet', (event) => {
    if (!senderIs(analysisWindow, event)) throw new Error('The titlebar stylesheet is available only to the active add-on window.');
    return pathToFileURL(join(currentDir, 'addonTitlebar.css')).href;
});

ipcMain.on('visualizerSeek', (event, time) => {
    if (!senderIs(analysisWindow, event) || !visualizerSession || !visualizerCan('timeline.seek')) return;
    if (['running', 'paused'].includes(visualizerSession.run.lifecycle)) return;
    const boundedTime = Math.max(0, Math.min(Number(time), visualizerSession.run.availableResultTime));
    visualizerSession.time = boundedTime;
    mainWindow?.webContents.send('visualizerSeekRequest', boundedTime);
});

ipcMain.handle('visualizerRequestPacing', async (event, pacing) => {
    if (!senderIs(analysisWindow, event) || !visualizerSession || !visualizerCan('simulation.pacing.control')) {
        throw new Error('The visualizer does not have permission to control pacing.');
    }
    const job = activeEngineJobs.get(visualizerSession.engineJobId);
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
    const targetWindow = getWindowFromEvent(event);
    if (!targetWindow) return;
    if (senderOwnsWindow(event.sender, mainWindow)) app.quit();
    else targetWindow.close();
});

ipcMain.handle('diagnosticsList', () => listDiagnostics());
onDiagnostic((entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('diagnosticsIssue', entry);
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
    if (!senderIs(mainWindow, event)) throw new Error('Only the project window can open example guides.');
    return openExampleGuide(id);
});

const shapesDir = join(currentDir, '..', 'assets', 'shapes');

async function shapeLibraryManifest() {
    return JSON.parse(await readFile(join(shapesDir, 'manifest.json'), 'utf8')).shapes;
}

ipcMain.handle('shapeLibraryList', async () => shapeLibraryManifest());

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
}

ipcMain.handle('componentLibraryList', async () => {
    await discoverComponentLibrary();
    return [...componentLibraryRegistry.values()];
});

ipcMain.handle('shapeLibraryLoad', async (_event, id) => {
    const shape = (await shapeLibraryManifest()).find((candidate) => candidate.id === id);
    if (!shape) throw new Error('That shape is not available.');
    return { ...shape, data: await readFile(join(shapesDir, shape.file)) };
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
    const bytes = await readFile(path);
    const inspection = inspectProjectFile(bytes);
    if (inspection.encrypted) {
        pendingEncryptedPaths.add(path);
        return { path, fileName: basename(path), encrypted: true, requiresPassword: true };
    }
    return { path, fileName: basename(path), encrypted: false, ...await decodeProjectForRenderer(bytes) };
});

ipcMain.handle('projectUnlock', async (_event, { path, password }) => {
    if (!pendingEncryptedPaths.has(path)) throw new Error('Select the encrypted project again.');
    const project = await decodeProjectForRenderer(await readFile(path), { password });
    pendingEncryptedPaths.delete(path);
    return { path, fileName: basename(path), encrypted: true, ...project };
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
    openProviderEditorWindow(event.sender, payload);
});

ipcMain.handle('providerEditorValidate', async (_event, { source, kind }) => (
    kind === 'python' ? validatePythonSource(source) : validateCppSource(source)
));

let pendingProviderApply = null;

ipcMain.handle('providerEditorApply', (_event, { source }) => {
    if (!providerEditorOwner || providerEditorOwner.isDestroyed()) {
        return { applied: false, error: 'The originating window is no longer available.' };
    }
    // The project window computes success/failure (e.g. its edge or source term may have been
    // deleted while this editor was open) and reports back over providerEditorApplyResult,
    // since webContents.send() has no built-in reply channel of its own.
    pendingProviderApply?.({ applied: false, error: 'Superseded by a newer apply.' });
    return new Promise((resolve) => {
        pendingProviderApply = resolve;
        providerEditorOwner.send('providerEditorApplied', { source });
    });
});

ipcMain.on('providerEditorApplyResult', (event, result) => {
    if (!senderIs(mainWindow, event)) return;
    pendingProviderApply?.(result);
    pendingProviderApply = null;
});

function requireMainWindow(event) {
    if (!senderIs(mainWindow, event)) throw new Error('Only the project window can access toolchain settings.');
}

ipcMain.on('clipboardReadBuffer', (event, format) => {
    event.returnValue = clipboard.readBuffer(format);
});

ipcMain.on('clipboardWriteBuffer', (event, { format, buffer }) => {
    clipboard.writeBuffer(format, Buffer.from(buffer));
    event.returnValue = true;
});

ipcMain.handle('providerToolchainGet', async (event, kind) => {
    requireMainWindow(event);
    const settings = await providerToolchainStore.get();
    const overridePath = kind === 'python' ? settings.python.interpreterPath : settings.cpp.compilerPath;
    const guess = kind === 'python' ? await autoDetectPythonInterpreter() : (await autoDetectCppCompiler()).compiler;
    const detectedPath = guess && (await testToolchainPath(kind, guess)).valid ? guess : null;
    return { overridePath, detectedPath };
});

ipcMain.handle('providerToolchainSet', async (event, { kind, path }) => {
    requireMainWindow(event);
    const trimmed = (path ?? '').trim();
    if (trimmed) {
        const test = await testToolchainPath(kind, trimmed);
        if (!test.valid) throw new Error(test.message || 'That path could not be verified.');
    }
    const settings = await providerToolchainStore.set(kind, trimmed);
    return kind === 'python' ? settings.python : settings.cpp;
});

ipcMain.handle('providerToolchainTest', async (event, { kind, path }) => {
    requireMainWindow(event);
    return testToolchainPath(kind, path);
});

ipcMain.handle('providerToolchainBrowse', async (event, kind) => {
    requireMainWindow(event);
    const result = await dialog.showOpenDialog(mainWindow, {
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
    requireMainWindow(event);
    const settings = await providerToolchainStore.get();
    return { executionMode: settings.executionMode, options: providerExecutionModes };
});

ipcMain.handle('providerExecutionModeSet', async (event, executionMode) => {
    requireMainWindow(event);
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

ipcMain.handle('aiGenerateProposal', async (event, { requestUuid, configurationUuid, request, context }) => {
    requireProjectWindow(event);
    if (typeof requestUuid !== 'string' || requestUuid.length > 100) throw new Error('A valid AI request identifier is required.');
    if (typeof request !== 'string' || !request.trim() || request.length > 8000) throw new Error('The AI request must contain between 1 and 8,000 characters.');
    if (!context || typeof context !== 'object' || JSON.stringify(context).length > 1_000_000) throw new Error('The model context is invalid or too large.');
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
        const proposal = await aiProviderRegistry.generate({ ...resolved, context, request: request.trim(), signal: controller.signal });
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
        providerToolchains: {
            cpp: { compilerPath: resolvedCpp?.compiler ?? '' },
            python: { interpreterPath: resolvedPython ?? '' },
            executionMode
        }
    };
};

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
            updateVisualizerResult(execution.jobId, result);
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
        updateVisualizerResult(execution.jobId, result);
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
    if (!senderIs(mainWindow, event)) return [];
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
    if (!senderIs(mainWindow, event)) return null;
    const stored = completedEngineResults.get(jobId);
    if (!stored) return null;
    return structuredClone(await stored.reader.readNearestSample(Number(time)));
});

ipcMain.handle('engineReleaseResult', async (event, jobId) => {
    if (!senderIs(mainWindow, event)) return false;
    const stored = completedEngineResults.get(jobId);
    if (!stored) return false;
    completedEngineResults.delete(jobId);
    await stored.reader.close();
    await stored.cleanup();
    return true;
});

app.whenReady().then(async () => {
    const operationSchema = JSON.parse(await readFile(join(currentDir, '..', 'schemas', 'assistantOperations.schema.json'), 'utf8'));
    aiProviderRegistry = createAIProviderRegistry(createRemoteAIProviders({ operationSchema }));
    aiConfigurationStore = createAIConfigurationStore({
        directory: join(app.getPath('userData'), 'ai'),
        credentialVault: createElectronCredentialVault(safeStorage)
    });
    providerToolchainStore = createProviderToolchainStore({
        directory: join(app.getPath('userData'), 'providers')
    });
    createWindow();
    if (!process.argv.includes('--interaction-test')) checkForUpdates();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
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
