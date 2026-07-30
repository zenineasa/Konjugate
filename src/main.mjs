/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { app, BrowserWindow, ipcMain } from 'electron';
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
