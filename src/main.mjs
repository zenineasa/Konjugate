/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));

function getWindowFromEvent(event) {
    return BrowserWindow.fromWebContents(event.sender);
}

function createWindow() {
    const mainWindow = new BrowserWindow({
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

    mainWindow.loadFile(join(currentDir, 'renderer', 'index.html'));
}

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
    suggestedFilename: fileName
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
        filters: [{ name: 'Konjugate project', extensions: ['json', 'konjugate'] }]
    });
    if (result.canceled) return null;
    const [path] = result.filePaths;
    return { path, fileName: basename(path), content: await readFile(path, 'utf8') };
});

ipcMain.handle('projectSave', async (event, { path: existingPath, content, suggestedFilename }) => {
    const targetWindow = getWindowFromEvent(event);
    let path = existingPath;
    if (!path) {
        const result = await dialog.showSaveDialog(targetWindow, {
            title: 'Save Konjugate project',
            defaultPath: suggestedFilename || 'untitled.konjugate.json',
            filters: [{ name: 'Konjugate project', extensions: ['konjugate.json', 'json'] }]
        });
        if (result.canceled) return null;
        path = result.filePath;
    }
    await writeFile(path, content, 'utf8');
    return { path, fileName: basename(path) };
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
