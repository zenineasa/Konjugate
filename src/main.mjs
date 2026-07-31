/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

    mainWindow.on('maximize', () => {
        mainWindow.webContents.send('windowMaximizedChange', true);
    });

    mainWindow.on('unmaximize', () => {
        mainWindow.webContents.send('windowMaximizedChange', false);
    });

    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send(
            'windowMaximizedChange',
            mainWindow.isMaximized()
        );
    });

    mainWindow.loadFile(join(currentDir, 'renderer', 'index.html'));
}

ipcMain.on('windowMaximizeToggle', (event) => {
    const targetWindow = getWindowFromEvent(event);

    if (targetWindow?.isMaximized()) {
        targetWindow.unmaximize();
    } else {
        targetWindow?.maximize();
    }
});

ipcMain.on('windowMinimize', (event) => {
    getWindowFromEvent(event)?.minimize();
});

ipcMain.on('windowClose', (event) => {
    getWindowFromEvent(event)?.close();
});

ipcMain.handle('projectLoadDefault', async () => {
    const path = join(currentDir, '..', 'examples', 'thermal-management.konjugate.json');
    return { path, content: await readFile(path, 'utf8') };
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
    return { path, content: await readFile(path, 'utf8') };
});

ipcMain.handle('projectSave', async (event, { path: existingPath, content }) => {
    const targetWindow = getWindowFromEvent(event);
    let path = existingPath;
    if (!path) {
        const result = await dialog.showSaveDialog(targetWindow, {
            title: 'Save Konjugate project',
            defaultPath: 'model.konjugate.json',
            filters: [{ name: 'Konjugate project', extensions: ['konjugate.json', 'json'] }]
        });
        if (result.canceled) return null;
        path = result.filePath;
    }
    await writeFile(path, content, 'utf8');
    return { path };
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
