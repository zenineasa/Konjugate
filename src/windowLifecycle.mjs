/* Copyright © 2026 Zenin Easa Panthakkalakath */

export function auxiliaryWindowPresentation(mainWindow, platform = process.platform) {
    if (!mainWindow || mainWindow.isDestroyed()) return {};
    if (platform === 'darwin' && mainWindow.isFullScreen()) return { fullscreen: true };
    return { parent: mainWindow };
}
export function auxiliaryWindowBounds(mainWindow, defaultWidth, defaultHeight, savedBounds, screenModule) {
    const width = savedBounds?.width ?? defaultWidth;
    const height = savedBounds?.height ?? defaultHeight;
    let { x, y } = savedBounds ?? {};
    if (typeof x !== 'number' || typeof y !== 'number') {
        const parentBounds = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow.getBounds() : screenModule.getPrimaryDisplay().workArea;
        x = Math.round(parentBounds.x + (parentBounds.width - width) / 2);
        y = Math.round(parentBounds.y + (parentBounds.height - height) / 2);
    }
    const work = screenModule.getDisplayMatching({ x, y, width, height }).workArea;
    x = Math.min(Math.max(x, work.x), Math.max(work.x, work.x + work.width - width));
    y = Math.min(Math.max(y, work.y), Math.max(work.y, work.y + work.height - height));
    return { x, y, width, height };
}
