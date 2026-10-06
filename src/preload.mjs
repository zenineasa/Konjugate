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

// What the app knows about updates (see src/updateCoordinator.mjs). The window only reads it, asks for
// a fresh check, skips a version, or copies the command the main process already holds.
contextBridge.exposeInMainWorld('appUpdate', {
    status: () => ipcRenderer.invoke('appUpdateStatus'),
    checkNow: () => ipcRenderer.invoke('appUpdateCheckNow'),
    skip: (version) => ipcRenderer.invoke('appUpdateSkip', version),
    copyCommand: () => ipcRenderer.invoke('appUpdateCopyCommand'),
    onChange: (callback) => ipcRenderer.on('appUpdateStatus', (_event, status) => callback(status))
});

contextBridge.exposeInMainWorld('applicationInfo', {
    get: () => ipcRenderer.invoke('applicationInfo'),
    openWelcome: () => ipcRenderer.invoke('applicationOpenWelcome'),
    openExternal: (url) => ipcRenderer.invoke('applicationOpenExternal', url),
    restart: () => ipcRenderer.invoke('applicationRestart')
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
    save: (path, content, suggestedFilename, password, resultBranches) => ipcRenderer.invoke('projectSave', { path, content, suggestedFilename, password, resultBranches }),
    exportResultsCsv: (suggestedFilename, csv) => ipcRenderer.invoke('projectExportResultsCsv', { suggestedFilename, csv }),
    exportGeneratedProgram: (suggestedFilename, source, kind) => ipcRenderer.invoke('projectExportGeneratedProgram', { suggestedFilename, source, kind }),
    exportFmu: (suggestedFilename, document, modelName) => ipcRenderer.invoke('projectExportFmu', { suggestedFilename, document, modelName }),
    mergeFmus: () => ipcRenderer.invoke('projectMergeFmus'),
    confirmDiscard: () => ipcRenderer.invoke('projectConfirmDiscard')
});

contextBridge.exposeInMainWorld('extensions', {
    list: () => ipcRenderer.invoke('packageList'),
    install: () => ipcRenderer.invoke('packageInstall'),
    uninstall: (packageType, packageId, version) => ipcRenderer.invoke('packageUninstall', { packageType, packageId, version }),
    setEnabled: (packageType, packageId, version, enabled) => ipcRenderer.invoke('packageSetEnabled', { packageType, packageId, version, enabled }),
    // The Explorer's "Discover" side (see docs/extensionsExplorer.md).
    discoverRegistry: () => ipcRenderer.invoke('packageDiscoverRegistry'),
    installFromRegistry: (entry, namespaces) => ipcRenderer.invoke('packageInstallFromRegistry', { entry, namespaces }),
    // An entry's image as a data: URL, or null (see the packageRegistryImage handler in src/main.mjs).
    registryImage: (prefix) => ipcRenderer.invoke('packageRegistryImage', prefix),
    // An entry's screenshots (downloaded on demand, not bundled) and its video links (opened in the
    // person's own browser) -- the renderer names an entry and a position, never a URL.
    registryScreenshot: (prefix, index) => ipcRenderer.invoke('packageRegistryScreenshot', { prefix, index }),
    openRegistryVideo: (prefix, index) => ipcRenderer.invoke('packageOpenRegistryVideo', { prefix, index }),
    // Separate from applicationInfo.openExternal's fixed allowlist -- a registry entry's own links
    // point at whatever a third-party publisher declared, so this confirms with the person first
    // instead (see the matching handler in src/main.mjs).
    openRegistryLink: (url) => ipcRenderer.invoke('packageOpenRegistryLink', url),
    // Set once an install/uninstall needs a restart to take effect (not enable/disable, not FMUs --
    // both already apply immediately) and never cleared except by an actual restart. restartPending
    // is the pull-based initial state for a window that opened after the flag was already set
    // elsewhere; onRestartPendingChange is the live push for as long as this window stays open.
    restartPending: () => ipcRenderer.invoke('packageRestartPending'),
    onRestartPendingChange: (callback) => {
        ipcRenderer.on('packageRestartPendingChanged', (_event, pending) => callback(pending));
    },
    // One GitHub Releases API call per installed, registry-known package (see docs/extensionsExplorer.md's
    // Update checking note) -- returns [{prefix, latestVersion, releaseUrl, outdated}] for whichever
    // entries have a newer release than what's installed. Cached main-process side for an hour
    // (shared across windows, cleared by any install/uninstall); force bypasses that cache.
    checkUpdates: ({ force = false } = {}) => ipcRenderer.invoke('packageCheckUpdates', { force })
});

contextBridge.exposeInMainWorld('shapeLibrary', {
    list: () => ipcRenderer.invoke('shapeLibraryList'),
    load: (id) => ipcRenderer.invoke('shapeLibraryLoad', id),
    saveUpload: (fileName, data) => ipcRenderer.invoke('shapeLibrarySaveUpload', { fileName, data })
});

// A launcher add-on's "open in canvas": the host sends a decoded project (model plus any result
// branches) for this window to load, exactly like an example.
contextBridge.exposeInMainWorld('launcherHost', {
    onOpenProject: (callback) => ipcRenderer.on('launcherOpenProject', (_event, payload) => callback(payload)),
    // A project is being built for this window (onOpenProject follows), or its build failed.
    onOpenProjectPending: (callback) => ipcRenderer.on('launcherOpenProjectPending', () => callback()),
    onOpenProjectAbandoned: (callback) => ipcRenderer.on('launcherOpenProjectAbandoned', () => callback()),
    // A launcher keeps its session with the open project without opening a model.
    onKeepAddonData: (callback) => ipcRenderer.on('launcherKeepAddonData', (_event, { addonId, entry }) => callback(addonId, entry)),
    // The host asks for the data a launcher keeps with the open project; the window answers from its own copy.
    onAddonDataRequest: (callback) => ipcRenderer.on('launcherAddonDataRequest', (_event, { requestId, addonId }) => {
        let data = null;
        try { data = callback(addonId) ?? null; } catch { data = null; }
        ipcRenderer.send('launcherAddonDataReply', { requestId, data });
    })
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
    validate: (content, options = {}) => ipcRenderer.invoke('engineValidate', content, options),
    infer: (csv, config) => ipcRenderer.invoke('engineInfer', csv, config),
    fit: (content, csv, config) => ipcRenderer.invoke('engineFit', content, csv, config),
    checkSubstepConvergence: (content, runConfiguration, nodeIds) => ipcRenderer.invoke('engineCheckSubstepConvergence', content, runConfiguration, nodeIds),
    run: (content, configuration) => ipcRenderer.invoke('engineRun', content, configuration),
    start: (content, configuration) => ipcRenderer.invoke('engineStart', content, configuration),
    setPacing: (jobId, pacing) => ipcRenderer.invoke('engineSetPacing', jobId, pacing),
    setExecutionState: (jobId, executionState) => ipcRenderer.invoke('engineSetExecutionState', jobId, executionState),
    setParameterValue: (jobId, parameterId, value) => ipcRenderer.invoke('engineSetParameterValue', jobId, parameterId, value),
    scheduleParameterValue: (jobId, parameterId, schedule) => ipcRenderer.invoke('engineScheduleParameterValue', jobId, parameterId, schedule),
    readResultSeries: (jobId, signalIds, options) => ipcRenderer.invoke('engineReadResultSeries', jobId, signalIds, options),
    readResultSample: (jobId, time) => ipcRenderer.invoke('engineReadResultSample', jobId, time),
    readCheckpoint: (jobId, time) => ipcRenderer.invoke('engineReadCheckpoint', jobId, time),
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
