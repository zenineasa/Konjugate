/* Copyright © 2026 Zenin Easa Panthakkalakath */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowControls', Object.freeze({
    minimize: () => ipcRenderer.send('windowMinimize'),
    toggleMaximize: () => ipcRenderer.send('windowMaximizeToggle'),
    close: () => ipcRenderer.send('windowClose'),
    onMaximizedChange: (callback) => ipcRenderer.on('windowMaximizedChange', (_event, value) => callback(value))
}));

contextBridge.exposeInMainWorld('providerEditorWindow', Object.freeze({
    onContent: (callback) => ipcRenderer.on('providerEditorContent', (_event, payload) => callback(payload)),
    validate: (source, kind) => ipcRenderer.invoke('providerEditorValidate', { source, kind }),
    apply: (source) => ipcRenderer.invoke('providerEditorApply', { source })
}));
