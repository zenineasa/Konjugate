/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { contextBridge, ipcRenderer, webFrame } from 'electron';

const minimumUiZoom = 0.75;
const maximumUiZoom = 1.5;
const uiZoomStep = 0.1;

function setUiZoom(factor) {
    const nextFactor = Math.min(maximumUiZoom, Math.max(minimumUiZoom, Math.round(factor * 10) / 10));
    webFrame.setZoomFactor(nextFactor);
    return nextFactor;
}

contextBridge.exposeInMainWorld('uiZoom', {
    get: () => webFrame.getZoomFactor(),
    increase: () => setUiZoom(webFrame.getZoomFactor() + uiZoomStep),
    decrease: () => setUiZoom(webFrame.getZoomFactor() - uiZoomStep),
    reset: () => setUiZoom(1),
    limits: { minimum: minimumUiZoom, maximum: maximumUiZoom }
});

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

contextBridge.exposeInMainWorld('engine', {
    validate: (content) => ipcRenderer.invoke('engineValidate', content),
    run: (content, configuration) => ipcRenderer.invoke('engineRun', content, configuration),
    start: (content, configuration) => ipcRenderer.invoke('engineStart', content, configuration),
    setPacing: (jobId, pacing) => ipcRenderer.invoke('engineSetPacing', jobId, pacing),
    setExecutionState: (jobId, executionState) => ipcRenderer.invoke('engineSetExecutionState', jobId, executionState),
    cancel: (jobId) => ipcRenderer.invoke('engineCancel', jobId),
    onUpdate: (callback) => ipcRenderer.on('engineRunUpdate', (_event, update) => callback(update)),
    onComplete: (callback) => ipcRenderer.on('engineRunComplete', (_event, update) => callback(update)),
    onError: (callback) => ipcRenderer.on('engineRunError', (_event, update) => callback(update))
});

contextBridge.exposeInMainWorld('aiProviders', {
    listConfigurations: () => ipcRenderer.invoke('aiListConfigurations'),
    listModels: (configurationUuid) => ipcRenderer.invoke('aiListModels', configurationUuid),
    listDraftModels: (configuration, credential) => ipcRenderer.invoke('aiListDraftModels', configuration, credential),
    saveConfiguration: (configuration, credential) => ipcRenderer.invoke('aiSaveConfiguration', configuration, credential),
    removeConfiguration: (configurationUuid) => ipcRenderer.invoke('aiRemoveConfiguration', configurationUuid),
    setActiveConfiguration: (configurationUuid) => ipcRenderer.invoke('aiSetActiveConfiguration', configurationUuid),
    testConnection: (configurationUuid) => ipcRenderer.invoke('aiTestConnection', configurationUuid),
    testDraftConnection: (configuration, credential) => ipcRenderer.invoke('aiTestDraftConnection', configuration, credential),
    generateProposal: async (requestUuid, configurationUuid, request, context) => {
        const result = await ipcRenderer.invoke('aiGenerateProposal', { requestUuid, configurationUuid, request, context });
        if (result.ok) return result.proposal;
        if (result.error?.code === 'requestCancelled') throw new DOMException(result.error.message, 'AbortError');
        const error = new Error(result.error?.message ?? 'The model provider could not generate a proposal.');
        error.code = result.error?.code;
        throw error;
    },
    cancelRequest: (requestUuid) => ipcRenderer.invoke('aiCancelRequest', requestUuid)
});

contextBridge.exposeInMainWorld('addons', {
    listToolstripContributions: () => ipcRenderer.invoke('addonListToolstripContributions'),
    invokeCommand: (addonId, commandId, contexts) => ipcRenderer.invoke('addonInvokeCommand', { addonId, commandId, contexts }),
    publishEvent: (eventName, value) => {
        if (eventName === 'timeline.change') ipcRenderer.send('visualizerHostTimelineChange', value);
        else if (eventName === 'selection.change') ipcRenderer.send('visualizerHostSelectionChange', value);
    },
    closeContext: (contextName) => {
        if (contextName === 'resultSession') ipcRenderer.send('visualizerCloseSession');
    },
    onRequest: (requestName, callback) => {
        if (requestName === 'timeline.seek') {
            ipcRenderer.on('visualizerSeekRequest', (_event, time) => callback(time));
        }
    }
});
