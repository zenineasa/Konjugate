/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeProjectFile, encodeProjectFile, inspectProjectFile } from './projectFile.mjs';
import { startEngineRun, validateWithEngine } from './engineAdapter.mjs';
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
import { nearestResultSample, rendererResultProjection, resultSignalSeries } from './resultSession.mjs';

if (process.argv.includes('--interaction-test') && process.env.KONJUGATE_INTERACTION_USER_DATA) {
    app.setPath('userData', process.env.KONJUGATE_INTERACTION_USER_DATA);
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const pendingEncryptedPaths = new Set();
let mainWindow = null;
let analysisWindow = null;
let exampleGuideWindow = null;
let exampleGuideBounds = null;
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

    mainWindow.loadFile(join(currentDir, 'renderer', 'index.html'));
}

async function openExampleGuide(id) {
    if (!(await exampleFiles()).includes(id)) throw new Error('That example is not available.');
    const guideName = id.replace(/\.konjugate\.json$/, '.md');
    const markdown = await readFile(join(examplesDir, guideName), 'utf8');
    const payload = { id, title: exampleLabel(id), markdown };
    if (!exampleGuideWindow || exampleGuideWindow.isDestroyed()) {
        exampleGuideWindow = new BrowserWindow({
            width: 720,
            height: 760,
            ...exampleGuideBounds,
            minWidth: 480,
            minHeight: 420,
            frame: false,
            backgroundColor: '#09131b',
            title: `${payload.title} · Example Guide`,
            parent: mainWindow,
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

function beginApplicationShutdown() {
    if (applicationShutdownPromise) return applicationShutdownPromise;
    abortAIOperations();
    applicationShutdownPromise = Promise.all([shutdownEngineJobs(), shutdownValidationOperations()]);
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
    const completedResult = completedEngineResults.get(payload.engineJobId);
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
    if (targetWindow === mainWindow) app.quit();
    else targetWindow.close();
});

const examplesDir = join(currentDir, '..', 'examples');

async function exampleFiles() {
    return (await readdir(examplesDir)).filter((name) => name.endsWith('.konjugate.json'));
}

function exampleLabel(fileName) {
    const stem = fileName.replace(/\.konjugate\.json$/, '');
    return `${stem.charAt(0).toUpperCase()}${stem.slice(1)}`.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

ipcMain.handle('projectListExamples', async () => (await exampleFiles()).map((fileName) => ({
    id: fileName,
    label: exampleLabel(fileName),
    suggestedFilename: fileName.replace(/\.konjugate\.json$/, '.kjt')
})));

ipcMain.handle('projectLoadExample', async (_event, id) => {
    if (!(await exampleFiles()).includes(id)) throw new Error('That example is not available.');
    return { content: await readFile(join(examplesDir, id), 'utf8'), suggestedFilename: id };
});

ipcMain.handle('projectOpenExampleGuide', async (event, id) => {
    if (!senderIs(mainWindow, event)) throw new Error('Only the project window can open example guides.');
    return openExampleGuide(id);
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
    return { path, fileName: basename(path), encrypted: false, content: await decodeProjectFile(bytes) };
});

ipcMain.handle('projectUnlock', async (_event, { path, password }) => {
    if (!pendingEncryptedPaths.has(path)) throw new Error('Select the encrypted project again.');
    const content = await decodeProjectFile(await readFile(path), { password });
    pendingEncryptedPaths.delete(path);
    return { path, fileName: basename(path), encrypted: true, content };
});

ipcMain.handle('projectSave', async (event, { path: existingPath, content, suggestedFilename, password }) => {
    const targetWindow = getWindowFromEvent(event);
    let path = existingPath;
    if (!path) {
        const defaultName = (suggestedFilename || 'untitled.kjt').replace(/(?:\.konjugate)?\.json$/i, '.kjt');
        const result = await dialog.showSaveDialog(targetWindow, {
            title: 'Save Konjugate project',
            defaultPath: defaultName,
            filters: [{ name: password ? 'Encrypted Konjugate project' : 'Konjugate project', extensions: ['kjt'] }]
        });
        if (result.canceled) return null;
        path = result.filePath;
    }
    if (!path.toLowerCase().endsWith('.kjt')) path = path.replace(/(?:\.konjugate)?\.json$/i, '') + '.kjt';
    const bytes = await encodeProjectFile(content, { password });
    const verification = await decodeProjectFile(bytes, { password });
    if (verification !== content) throw new Error('The saved project could not be verified.');
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
        await unlink(temporaryPath).catch(() => {});
        throw error;
    }
    return { path, fileName: basename(path), encrypted: Boolean(password) };
});

ipcMain.handle('projectConfirmDiscard', async (event) => {
    const result = await dialog.showMessageBox(getWindowFromEvent(event), {
        type: 'warning',
        title: 'Unsaved changes',
        message: 'Discard unsaved changes?',
        detail: 'Your changes have not been saved and cannot be recovered after closing or opening another project.',
        buttons: ['Cancel', 'Discard changes'],
        defaultId: 0,
        cancelId: 0
    });
    return result.response === 1;
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

const engineOptions = () => ({
    applicationPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged
});

ipcMain.handle('engineValidate', async (event, content) => {
    const active = { owner: event.sender, controller: new AbortController(), completion: null };
    activeValidationOperations.add(active);
    try {
        active.completion = validateWithEngine(content, { ...engineOptions(), signal: active.controller.signal });
        return await active.completion;
    } finally {
        activeValidationOperations.delete(active);
    }
});

ipcMain.handle('engineRun', async (event, content, configuration) => {
    const execution = await startEngineRun(content, configuration, engineOptions());
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
    execution = await startEngineRun(content, configuration, engineOptions(), {
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
    execution.completion.then((result) => {
        if (updateTimer) clearTimeout(updateTimer);
        updateTimer = null;
        latestUpdate = null;
        completedEngineResults.set(execution.jobId, result);
        updateVisualizerResult(execution.jobId, result);
        if (!owner.isDestroyed()) owner.send('engineRunComplete', {
            jobId: execution.jobId,
            result: rendererResultProjection(result)
        });
    }).catch((error) => {
        if (updateTimer) clearTimeout(updateTimer);
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

ipcMain.handle('engineReadResultSeries', (event, jobId, signalIds, options) => {
    if (!senderIs(mainWindow, event)) return [];
    const result = completedEngineResults.get(jobId);
    if (!result) return [];
    return resultSignalSeries(result, signalIds, options);
});

ipcMain.handle('engineReadResultSample', (event, jobId, time) => {
    if (!senderIs(mainWindow, event)) return null;
    return structuredClone(nearestResultSample(completedEngineResults.get(jobId), Number(time)));
});

ipcMain.handle('engineReleaseResult', (event, jobId) => {
    if (!senderIs(mainWindow, event)) return false;
    return completedEngineResults.delete(jobId);
});

app.whenReady().then(async () => {
    const operationSchema = JSON.parse(await readFile(join(currentDir, '..', 'schemas', 'assistantOperations.schema.json'), 'utf8'));
    aiProviderRegistry = createAIProviderRegistry(createRemoteAIProviders({ operationSchema }));
    aiConfigurationStore = createAIConfigurationStore({
        directory: join(app.getPath('userData'), 'ai'),
        credentialVault: createElectronCredentialVault(safeStorage)
    });
    createWindow();

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
