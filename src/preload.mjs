/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('windowControls', {
    minimize: () => ipcRenderer.send('windowMinimize'),
    toggleMaximize: () => ipcRenderer.send('windowMaximizeToggle'),
    close: () => ipcRenderer.send('windowClose'),
    onMaximizedChange: (callback) => {
        ipcRenderer.on('windowMaximizedChange', (_event, isMaximized) => {
            callback(isMaximized);
        });
    }
});

contextBridge.exposeInMainWorld('projectFiles', {
    listExamples: () => ipcRenderer.invoke('projectListExamples'),
    loadExample: (id) => ipcRenderer.invoke('projectLoadExample', id),
    open: () => ipcRenderer.invoke('projectOpen'),
    unlock: (path, password) => ipcRenderer.invoke('projectUnlock', { path, password }),
    save: (path, content, suggestedFilename, password) => ipcRenderer.invoke('projectSave', { path, content, suggestedFilename, password }),
    confirmDiscard: () => ipcRenderer.invoke('projectConfirmDiscard')
});
