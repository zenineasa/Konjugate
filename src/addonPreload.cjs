/* Copyright © 2026 Zenin Easa Panthakkalakath */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('konjugateVisualizer', Object.freeze({
    getContext: () => ipcRenderer.invoke('visualizerGetContext'),
    listSignals: () => ipcRenderer.invoke('visualizerListSignals'),
    readSeries: (signalUuids, options) => ipcRenderer.invoke('visualizerReadSeries', { signalUuids, options }),
    seek: (time) => ipcRenderer.send('visualizerSeek', Number(time)),
    onTimelineChange: (callback) => ipcRenderer.on('visualizerTimelineChange', (_event, time) => callback(time)),
    onSelectionChange: (callback) => ipcRenderer.on('visualizerSelectionChange', (_event, nodeId) => callback(nodeId)),
    onSessionChange: (callback) => ipcRenderer.on('visualizerSessionChange', () => callback())
}));
