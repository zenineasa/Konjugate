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
    apply: (source, target) => ipcRenderer.invoke('providerEditorApply', { source, target }),
    check: (source, kind, inputs) => ipcRenderer.invoke('providerEditorCheck', { source, kind, inputs }),
    setDirty: (dirty) => ipcRenderer.send('providerEditorDirty', Boolean(dirty)),
    reportStatus: (status) => ipcRenderer.send('providerEditorStatus', status),
    onCloseRequest: (callback) => ipcRenderer.on('providerEditorCloseRequest', (_event, requestId) => callback(requestId)),
    answerCloseRequest: (requestId, closed) => ipcRenderer.send('providerEditorCloseAnswer', { requestId, closed: Boolean(closed) })
}));
