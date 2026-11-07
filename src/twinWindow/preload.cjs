/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The twin's own window (docs/proposals/controlRoom.md): what it may ask of the main process, and nothing more.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('windowControls', Object.freeze({
    minimize: () => ipcRenderer.send('windowMinimize'),
    toggleMaximize: () => ipcRenderer.send('windowMaximizeToggle'),
    close: () => ipcRenderer.send('windowClose'),
    onMaximizedChange: (callback) => ipcRenderer.on('windowMaximizedChange', (_event, value) => callback(value))
}));

contextBridge.exposeInMainWorld('twin', Object.freeze({
    // The project's model, its name, and the twin's saved setup, when the window opens and whenever the project window opens it again.
    onContext: (callback) => ipcRenderer.on('twinContext', (_event, context) => callback(context)),
    // The setup, handed to the project window to be kept with the project.
    saveSetup: (setup) => ipcRenderer.invoke('twinSaveSetup', setup),
    openConnections: () => ipcRenderer.invoke('twinOpenConnections'),
    // The twin's status, for the project window's toolbar chip.
    reportStatus: (status) => ipcRenderer.invoke('twinStatus', status),
    // Asked of the project window: 'keepValues' (fitted or set values kept in the model, undoable there), 'scenarios',
    // 'keepScenario', 'renameScenario', 'deleteScenario'.
    askProject: (action, payload) => ipcRenderer.invoke('twinAskProject', action, payload),
    // The project's model, changed in the project window.
    onModelChanged: (callback) => ipcRenderer.on('twinModelChanged', (_event, document) => callback(document)),
    // The engine's fit, for a refit on the latest window.
    fit: (content, csv, config) => ipcRenderer.invoke('engineFit', content, csv, config),
    // The simulated rig's model opened in the project window, for a demonstration; the window's context follows.
    openDemoModel: (variant) => ipcRenderer.invoke('twinOpenDemoModel', variant),
    memory: Object.freeze({
        get: () => ipcRenderer.invoke('twinMemoryGet'),
        save: (memory) => ipcRenderer.invoke('twinMemorySave', memory)
    }),
    liveTwin: Object.freeze({
        start: (settings, source, projectPath) => ipcRenderer.invoke('liveTwinStart', settings, source, projectPath),
        stop: () => ipcRenderer.invoke('liveTwinStop'),
        onEvent: (callback) => ipcRenderer.on('liveTwinEvent', (_event, update) => callback(update)),
        listen: (url, seconds) => ipcRenderer.invoke('liveTwinListen', url, seconds),
        browseOpcUa: (url, security, trustServer) => ipcRenderer.invoke('liveTwinBrowseOpcUa', url, security, trustServer),
        demo: (variant) => ipcRenderer.invoke('liveTwinDemo', variant),
        applyModel: (document) => ipcRenderer.invoke('liveTwinApplyModel', document),
        setAlert: (alertAt) => ipcRenderer.invoke('liveTwinSetAlert', alertAt),
        refitPlan: () => ipcRenderer.invoke('liveTwinRefitPlan'),
        applyRefit: (values, cycle) => ipcRenderer.invoke('liveTwinApplyRefit', values, cycle),
        detach: () => ipcRenderer.invoke('liveTwinDetach'),
        sandboxSetInput: (signal, value) => ipcRenderer.invoke('liveTwinSandboxSetInput', signal, value),
        sandboxRunFor: (seconds) => ipcRenderer.invoke('liveTwinSandboxRunFor', seconds),
        sandboxClose: () => ipcRenderer.invoke('liveTwinSandboxClose'),
        readRecording: (path) => ipcRenderer.invoke('liveTwinReadRecording', path),
        showRecording: (path) => ipcRenderer.invoke('liveTwinShowRecording', path),
        pathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } }
    }),
    pushService: Object.freeze({
        state: () => ipcRenderer.invoke('pushServiceState'),
        keys: () => ipcRenderer.invoke('pushKeysList')
    })
}));
