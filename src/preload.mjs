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
    loadDefault: () => ipcRenderer.invoke('projectLoadDefault'),
    open: () => ipcRenderer.invoke('projectOpen'),
    save: (path, content) => ipcRenderer.invoke('projectSave', { path, content })
});
