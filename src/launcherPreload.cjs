/* Copyright © 2026 Zenin Easa Panthakkalakath */

const { contextBridge, ipcRenderer } = require('electron');

// Same host-supplied titlebar as every add-on window (see addonPreload.cjs); duplicated here because a
// sandboxed preload cannot require a sibling file.
async function installAddonTitlebar() {
    const titlebar = document.createElement('header');
    titlebar.className = 'konjugateAddonTitlebar';
    titlebar.innerHTML = '<div class="konjugateAddonIdentity"><span aria-hidden="true">K</span><strong>Konjugate</strong><i></i><b></b></div><div class="konjugateAddonWindowControls"><button type="button" data-window-action="minimize" aria-label="Minimize">−</button><button type="button" data-window-action="maximize" aria-label="Maximize"><span>□</span></button><button class="close" type="button" data-window-action="close" aria-label="Close">×</button></div>';
    titlebar.querySelector('.konjugateAddonIdentity b').textContent = document.title || 'Add-on';
    // Konjugate's own logo, not a stand-in letter, so an add-on window reads as part of the application.
    ipcRenderer.invoke('addonTitlebarIcon').then((source) => {
        const image = document.createElement('img');
        image.alt = '';
        image.src = source;
        titlebar.querySelector('.konjugateAddonIdentity > span').replaceWith(image);
    }).catch(() => {});
    document.body.prepend(titlebar);
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = await ipcRenderer.invoke('launcherTitlebarStylesheet');
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

// The whole surface a launcher window has. Every argument names something the manifest declared (an
// importer, a file role, a scenario, a page); none takes a path or a URL.
contextBridge.exposeInMainWorld('konjugateLauncher', Object.freeze({
    getManifest: () => ipcRenderer.invoke('launcherGetManifest'),
    chooseFile: (importerId, role) => ipcRenderer.invoke('launcherChooseFile', { importerId, role }),
    clearFile: (importerId, role, name) => ipcRenderer.invoke('launcherClearFile', { importerId, role, name }),
    fetchText: (url) => ipcRenderer.invoke('launcherFetchText', { url }),
    fetchFile: (importerId, role, url, name) => ipcRenderer.invoke('launcherFetchFile', { importerId, role, url, name }),
    reloadFiles: (importerId) => ipcRenderer.invoke('launcherReloadFiles', { importerId }),
    useSample: (importerId) => ipcRenderer.invoke('launcherUseSample', { importerId }),
    infer: (csv, config) => ipcRenderer.invoke('launcherInfer', { csv, config }),
    runImport: (importerId, options) => ipcRenderer.invoke('launcherRunImport', { importerId, options }),
    runScenario: (scenarioId, options) => ipcRenderer.invoke('launcherRunScenario', { scenarioId, ...options }),
    openInCanvas: (scenarioId) => ipcRenderer.invoke('launcherOpenInCanvas', { scenarioId }),
    exportResults: (scenarioId, options) => ipcRenderer.invoke('launcherExportResults', { scenarioId, ...options }),
    openPage: (pageId) => ipcRenderer.invoke('launcherOpenPage', { pageId }),
    onProgress: (callback) => ipcRenderer.on('launcherProgress', (_event, progress) => callback(progress))
}));
