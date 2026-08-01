/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeProjectFile, encodeProjectFile, inspectProjectFile } from './projectFile.mjs';
import { runWithEngine, validateWithEngine } from './engineAdapter.mjs';
import {
    createVisualizerSession,
    publicToolstripContributions,
    publicVisualizerContext,
    readSignalSeries,
    validateAddonManifest
} from './addonHost.mjs';

const currentDir = dirname(fileURLToPath(import.meta.url));
const pendingEncryptedPaths = new Set();
let mainWindow = null;
let analysisWindow = null;
let analysisAddonId = null;
let visualizerManifest = null;
let visualizerSession = null;
const addonRegistry = new Map();

function getWindowFromEvent(event) {
    return BrowserWindow.fromWebContents(event.sender);
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
            sandbox: false
        }
    });

    const sendExpandedState = (expanded) => {
        if (!mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('windowMaximizedChange', expanded);
        }
    };

    mainWindow.on('maximize', () => sendExpandedState(true));
    mainWindow.on('unmaximize', () => sendExpandedState(false));
    mainWindow.on('enter-full-screen', () => sendExpandedState(true));
    mainWindow.on('leave-full-screen', () => sendExpandedState(false));

    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send(
            'windowMaximizedChange',
            process.platform === 'darwin' ? mainWindow.isFullScreen() : mainWindow.isMaximized()
        );
    });

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

function senderIs(window, event) {
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
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
    visualizerSession = createVisualizerSession({ ...payload, sessionId: randomUUID() });
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
        backgroundColor: '#081119',
        webPreferences: {
            preload: join(currentDir, 'addonPreload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
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

ipcMain.handle('visualizerReadSeries', (event, { signalUuids, options }) => {
    if (!senderIs(analysisWindow, event) || !visualizerSession || !visualizerCan('results.read')) return [];
    return readSignalSeries(visualizerSession, signalUuids, options);
});

ipcMain.on('visualizerSeek', (event, time) => {
    if (!senderIs(analysisWindow, event) || !visualizerSession || !visualizerCan('timeline.seek')) return;
    const boundedTime = Math.max(0, Math.min(Number(time), visualizerSession.run.duration));
    visualizerSession.time = boundedTime;
    mainWindow?.webContents.send('visualizerSeekRequest', boundedTime);
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

ipcMain.on('windowClose', () => {
    app.quit();
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

ipcMain.handle('engineValidate', async (_event, content) => validateWithEngine(content, {
    applicationPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged
}));

ipcMain.handle('engineRun', async (_event, content, configuration) => runWithEngine(content, configuration, {
    applicationPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged
}));

app.whenReady().then(() => {
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
