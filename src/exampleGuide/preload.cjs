/* Copyright © 2026 Zenin Easa Panthakkalakath */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowControls', Object.freeze({
    minimize: () => ipcRenderer.send('windowMinimize'),
    toggleMaximize: () => ipcRenderer.send('windowMaximizeToggle'),
    close: () => ipcRenderer.send('windowClose'),
    onMaximizedChange: (callback) => ipcRenderer.on('windowMaximizedChange', (_event, value) => callback(value))
}));

contextBridge.exposeInMainWorld('exampleGuide', Object.freeze({
    onContent: (callback) => ipcRenderer.on('exampleGuideContent', (_event, payload) => callback(payload)),
    openExternal: (url) => ipcRenderer.invoke('applicationOpenExternal', url),
    // The Welcome window's one-time recommended-add-ons offer (see docs/extensionsExplorer.md) --
    // entries is exactly the recommendedAddons array this same window was sent in onContent.
    installRecommendedAddons: (entries) => ipcRenderer.invoke('welcomeInstallRecommendedAddons', entries),
    // Same channel the main window's restart-pending banner uses (see src/main.mjs); exposed here
    // too so this window can offer it right where the install that caused it just happened.
    restart: () => ipcRenderer.invoke('applicationRestart')
}));
