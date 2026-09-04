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
    newWindow: () => ipcRenderer.send('newProjectWindow'),
    onMaximizedChange: (callback) => {
        ipcRenderer.on('windowMaximizedChange', (_event, isMaximized) => {
            callback(isMaximized);
        });
    }
});

contextBridge.exposeInMainWorld('applicationInfo', {
    get: () => ipcRenderer.invoke('applicationInfo'),
    openWelcome: () => ipcRenderer.invoke('applicationOpenWelcome')
});

contextBridge.exposeInMainWorld('diagnostics', {
    list: () => ipcRenderer.invoke('diagnosticsList'),
    onIssue: (callback) => {
        ipcRenderer.on('diagnosticsIssue', (_event, entry) => callback(entry));
    }
});

contextBridge.exposeInMainWorld('projectFiles', {
    listExamples: () => ipcRenderer.invoke('projectListExamples'),
    loadExample: (id) => ipcRenderer.invoke('projectLoadExample', id),
    openExampleGuide: (id) => ipcRenderer.invoke('projectOpenExampleGuide', id),
    openCausalInferenceInteractionHelp: () => ipcRenderer.invoke('projectOpenCausalInferenceInteractionHelp'),
    open: () => ipcRenderer.invoke('projectOpen'),
    pendingOpen: () => ipcRenderer.invoke('projectPendingOpen'),
    pathChanged: (path) => ipcRenderer.send('projectPathChanged', path),
    unlock: (path, password) => ipcRenderer.invoke('projectUnlock', { path, password }),
    save: (path, content, suggestedFilename, password, resultSessionId) => ipcRenderer.invoke('projectSave', { path, content, suggestedFilename, password, resultSessionId }),
    exportResultsCsv: (suggestedFilename, csv) => ipcRenderer.invoke('projectExportResultsCsv', { suggestedFilename, csv }),
    exportGeneratedProgram: (suggestedFilename, source, kind) => ipcRenderer.invoke('projectExportGeneratedProgram', { suggestedFilename, source, kind }),
    exportFmu: (suggestedFilename, document, modelName) => ipcRenderer.invoke('projectExportFmu', { suggestedFilename, document, modelName }),
    confirmDiscard: () => ipcRenderer.invoke('projectConfirmDiscard')
});

contextBridge.exposeInMainWorld('extensions', {
    list: () => ipcRenderer.invoke('packageList'),
    install: () => ipcRenderer.invoke('packageInstall'),
    uninstall: (packageType, packageId, version) => ipcRenderer.invoke('packageUninstall', { packageType, packageId, version }),
    setEnabled: (packageType, packageId, version, enabled) => ipcRenderer.invoke('packageSetEnabled', { packageType, packageId, version, enabled })
});

contextBridge.exposeInMainWorld('shapeLibrary', {
    list: () => ipcRenderer.invoke('shapeLibraryList'),
    load: (id) => ipcRenderer.invoke('shapeLibraryLoad', id),
    saveUpload: (fileName, data) => ipcRenderer.invoke('shapeLibrarySaveUpload', { fileName, data })
});

contextBridge.exposeInMainWorld('componentLibrary', {
    list: () => ipcRenderer.invoke('componentLibraryList')
});

contextBridge.exposeInMainWorld('providerEditor', {
    openWindow: (payload) => ipcRenderer.invoke('providerEditorOpenWindow', payload),
    onApplied: (callback) => ipcRenderer.on('providerEditorApplied', (_event, payload) => callback(payload)),
    reportApplied: (result) => ipcRenderer.send('providerEditorApplyResult', result)
});

contextBridge.exposeInMainWorld('providerToolchains', {
    get: (kind) => ipcRenderer.invoke('providerToolchainGet', kind),
    set: (kind, path) => ipcRenderer.invoke('providerToolchainSet', { kind, path }),
    test: (kind, path) => ipcRenderer.invoke('providerToolchainTest', { kind, path }),
    browse: (kind) => ipcRenderer.invoke('providerToolchainBrowse', kind),
    executionMode: {
        get: () => ipcRenderer.invoke('providerExecutionModeGet'),
        set: (executionMode) => ipcRenderer.invoke('providerExecutionModeSet', executionMode)
    }
});

const graphClipboardFormat = 'application/x-konjugate-graph-fragment';
contextBridge.exposeInMainWorld('modelClipboard', {
    write: (fragment) => ipcRenderer.sendSync('clipboardWriteBuffer', {
        format: graphClipboardFormat,
        buffer: Buffer.from(JSON.stringify(fragment))
    }),
    read: () => {
        const bytes = ipcRenderer.sendSync('clipboardReadBuffer', graphClipboardFormat);
        if (!bytes || !bytes.length) return null;
        try {
            // `bytes` crosses the IPC boundary as a plain Uint8Array, not a Node Buffer.
            // Uint8Array.prototype.toString is Array.prototype.toString, which ignores the
            // 'utf8' argument and comma-joins the raw byte values instead of decoding them --
            // wrap it in Buffer.from() first so the encoding argument actually takes effect.
            return JSON.parse(Buffer.from(bytes).toString('utf8'));
        } catch {
            return null;
        }
    }
});

contextBridge.exposeInMainWorld('engine', {
    capabilities: () => ipcRenderer.invoke('engineCapabilities'),
    validate: (content) => ipcRenderer.invoke('engineValidate', content),
    infer: (csv, config) => ipcRenderer.invoke('engineInfer', csv, config),
    fit: (content, csv, config) => ipcRenderer.invoke('engineFit', content, csv, config),
    run: (content, configuration) => ipcRenderer.invoke('engineRun', content, configuration),
    start: (content, configuration) => ipcRenderer.invoke('engineStart', content, configuration),
    setPacing: (jobId, pacing) => ipcRenderer.invoke('engineSetPacing', jobId, pacing),
    setExecutionState: (jobId, executionState) => ipcRenderer.invoke('engineSetExecutionState', jobId, executionState),
    setParameterValue: (jobId, parameterId, value) => ipcRenderer.invoke('engineSetParameterValue', jobId, parameterId, value),
    readResultSeries: (jobId, signalIds, options) => ipcRenderer.invoke('engineReadResultSeries', jobId, signalIds, options),
    readResultSample: (jobId, time) => ipcRenderer.invoke('engineReadResultSample', jobId, time),
    releaseResult: (jobId) => ipcRenderer.invoke('engineReleaseResult', jobId),
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
    generateProposal: async (requestUuid, configurationUuid, request, context, history) => {
        const result = await ipcRenderer.invoke('aiGenerateProposal', { requestUuid, configurationUuid, request, context, history });
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
