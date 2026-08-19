/* Copyright © 2026 Zenin Easa Panthakkalakath */

export function auxiliaryWindowPresentation(mainWindow, platform = process.platform) {
    if (!mainWindow || mainWindow.isDestroyed()) return {};
    if (platform === 'darwin' && mainWindow.isFullScreen()) return { fullscreen: true };
    return { parent: mainWindow };
}
