/* Copyright © 2026 Zenin Easa Panthakkalakath */

export function senderOwnsWindow(sender, window) {
    return Boolean(sender && window && !window.isDestroyed() && sender.id === window.webContents.id);
}

export function auxiliaryWindowPresentation(mainWindow, platform = process.platform) {
    if (!mainWindow || mainWindow.isDestroyed()) return {};
    if (platform === 'darwin' && mainWindow.isFullScreen()) return { fullscreen: true };
    return { parent: mainWindow };
}
