/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The data add-ons keep with a project (docs/projectSchema.md, `addonData`) lives in the project window, beside the
// model, so the main process asks that window for an add-on's entry and waits for its answer. Launchers and result
// visualizers both ask, over the same channel: one counter for every request keeps one asker from taking another's
// answer.

let nextRequestId = 1;

export function requestAddonData({ ipcMain, projectWindow, addonId, timeoutMilliseconds = 5000 }) {
    return new Promise((resolvePromise) => {
        const requestId = nextRequestId++;
        const timer = setTimeout(() => { ipcMain.removeListener('launcherAddonDataReply', listener); resolvePromise(null); }, timeoutMilliseconds);
        function listener(event, reply) {
            if (event.sender !== projectWindow.webContents || reply?.requestId !== requestId) return;
            clearTimeout(timer);
            ipcMain.removeListener('launcherAddonDataReply', listener);
            resolvePromise(reply.data ?? null);
        }
        ipcMain.on('launcherAddonDataReply', listener);
        projectWindow.webContents.send('launcherAddonDataRequest', { requestId, addonId });
    });
}

// Gives the project window an add-on's new entry to keep with the project (null removes it); the project counts as
// unsaved until it is saved.
export function keepAddonData(projectWindow, addonId, entry) {
    projectWindow.webContents.send('launcherKeepAddonData', { addonId, entry });
}
