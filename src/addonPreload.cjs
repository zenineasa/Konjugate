/* Copyright © 2026 Zenin Easa Panthakkalakath */

const { contextBridge, ipcRenderer } = require('electron');

async function installAddonTitlebar() {
    const titlebar = document.createElement('header');
    titlebar.className = 'konjugateAddonTitlebar';
    titlebar.innerHTML = '<div class="konjugateAddonIdentity"><span aria-hidden="true">K</span><strong>Konjugate</strong><i></i><b></b></div><div class="konjugateAddonWindowControls"><button type="button" data-window-action="minimize" aria-label="Minimize">−</button><button type="button" data-window-action="maximize" aria-label="Maximize"><span>□</span></button><button class="close" type="button" data-window-action="close" aria-label="Close">×</button></div>';
    titlebar.querySelector('.konjugateAddonIdentity b').textContent = document.title || 'Add-on';
    document.body.prepend(titlebar);
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = await ipcRenderer.invoke('visualizerTitlebarStylesheet');
    document.head.append(stylesheet);
    titlebar.addEventListener('click', (event) => {
        const action = event.target.closest('[data-window-action]')?.dataset.windowAction;
        if (action === 'minimize') ipcRenderer.send('windowMinimize');
        else if (action === 'maximize') ipcRenderer.send('windowMaximizeToggle');
        else if (action === 'close') ipcRenderer.send('windowClose');
    });
    ipcRenderer.on('windowMaximizedChange', (_event, maximized) => {
        const button = titlebar.querySelector('[data-window-action="maximize"]');
        button.querySelector('span').textContent = maximized ? '❐' : '□';
        button.ariaLabel = process.platform === 'darwin'
            ? `${maximized ? 'Exit' : 'Enter'} full screen`
            : maximized ? 'Restore' : 'Maximize';
    });
}

window.addEventListener('DOMContentLoaded', installAddonTitlebar, { once: true });

contextBridge.exposeInMainWorld('konjugateVisualizer', Object.freeze({
    getContext: () => ipcRenderer.invoke('visualizerGetContext'),
    listSignals: () => ipcRenderer.invoke('visualizerListSignals'),
    readSeries: (signalIds, options) => ipcRenderer.invoke('visualizerReadSeries', { signalIds, options }),
    seek: (time) => ipcRenderer.send('visualizerSeek', Number(time)),
    requestPacing: (pacing) => ipcRenderer.invoke('visualizerRequestPacing', pacing),
    onTimelineChange: (callback) => ipcRenderer.on('visualizerTimelineChange', (_event, time) => callback(time)),
    onSelectionChange: (callback) => ipcRenderer.on('visualizerSelectionChange', (_event, nodeId) => callback(nodeId)),
    onSamplesAvailable: (callback) => ipcRenderer.on('visualizerSamplesAvailable', (_event, update) => callback(update)),
    onRunStatusChange: (callback) => ipcRenderer.on('visualizerRunStatusChange', (_event, status) => callback(status)),
    onPacingChange: (callback) => ipcRenderer.on('visualizerPacingChange', (_event, pacing) => callback(pacing)),
    onSessionChange: (callback) => ipcRenderer.on('visualizerSessionChange', () => callback())
}));
