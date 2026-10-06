/* Copyright © 2026 Zenin Easa Panthakkalakath */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowControls', Object.freeze({
    minimize: () => ipcRenderer.send('windowMinimize'),
    toggleMaximize: () => ipcRenderer.send('windowMaximizeToggle'),
    close: () => ipcRenderer.send('windowClose'),
    onMaximizedChange: (callback) => ipcRenderer.on('windowMaximizedChange', (_event, value) => callback(value))
}));

// The Welcome window's Updates section (see src/updateCoordinator.mjs and docs/updates.md).
contextBridge.exposeInMainWorld('appUpdate', Object.freeze({
    status: () => ipcRenderer.invoke('appUpdateStatus'),
    checkNow: () => ipcRenderer.invoke('appUpdateCheckNow'),
    skip: (version) => ipcRenderer.invoke('appUpdateSkip', version),
    copyCommand: () => ipcRenderer.invoke('appUpdateCopyCommand'),
    onChange: (callback) => ipcRenderer.on('appUpdateStatus', (_event, status) => callback(status))
}));

contextBridge.exposeInMainWorld('exampleGuide', Object.freeze({
    onContent: (callback) => ipcRenderer.on('exampleGuideContent', (_event, payload) => callback(payload)),
    openExternal: (url) => ipcRenderer.invoke('applicationOpenExternal', url),
    // The Welcome window (docs/proposals/welcomeWindow.md). Content that arrives after the window opens
    // comes as patches; everything the page asks for is an id or nothing -- never a URL or text -- so the
    // main process decides what is opened or copied.
    onWelcomePatch: (callback) => ipcRenderer.on('welcomePatch', (_event, patch) => callback(patch)),
    markEpisodeOpened: (videoId) => ipcRenderer.invoke('welcomeEpisodeOpened', videoId),
    dismissFeatured: (id) => ipcRenderer.invoke('welcomeDismissFeatured', id),
    openFeatured: (id) => ipcRenderer.invoke('welcomeOpenFeatured', id),
    copyBugReportDetails: () => ipcRenderer.invoke('appCopyBugReportDetails'),
    // The Welcome window's one-time recommended-add-ons offer (see docs/extensionsExplorer.md) --
    // entries is exactly the recommendedAddons array this same window was sent in onContent.
    installRecommendedAddons: (entries) => ipcRenderer.invoke('welcomeInstallRecommendedAddons', entries),
    // Same channel the main window's restart-pending banner uses (see src/main.mjs); exposed here
    // too so this window can offer it right where the install that caused it just happened.
    restart: () => ipcRenderer.invoke('applicationRestart')
}));
