/* Copyright © 2026 Zenin Easa Panthakkalakath */

// window.addons and window.launcherHost for the web shell (docs/proposals/webEditionPackages.md, stages 3 and 5): result visualizers and
// launchers installed as .kja files, opened in a panel. The add-on runs in an iframe with sandbox="allow-scripts" and no allow-same-origin, so
// it has an opaque origin and cannot reach this page's storage, cookies or DOM, and its document carries a policy that lets nothing in or out
// (addonFrame.html). The only way between it and the page is postMessage, and every request it makes is answered by webAddonBridge.mjs (a
// visualizer) or webLauncherBridge.mjs (a launcher), which check the permissions the person approved. The desktop's windows and preloads
// (main.mjs, addonPreload.cjs, launcherHost.mjs, launcherPreload.cjs) are the model for what it can ask.

import { createVisualizerSession, publicToolstripContributions } from '../../addonHost.mjs';
import { createVisualizerBridge } from '../../webAddonBridge.mjs';
import { createLauncherBridge } from '../../webLauncherBridge.mjs';
import { buildAddonDocument, launcherApiSource } from '../../webAddonDocument.mjs';
import { runImporterInFrame } from './importerRunner.mjs';
import { packageStore, resolvePluginReferences } from './packages.mjs';
import { canSendCommands, runModel } from '../../webLauncherEngine.mjs';

const readyTimeoutMilliseconds = 10_000;
const frameAddress = new URL('../addonFrame.html', import.meta.url).href;
const engineModuleUrl = new URL('../../engine/konjugateEngine.js', import.meta.url).href;

let current = null;
let page = null;
const seekHandlers = [];

function downloadCsv(fileName, text) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

// A panel is made once, hidden, so the phone layout can treat the add-on's as one of its sheets (phoneSheets.mjs knows it by id).
function panelElement(id, className) {
    let panel = document.getElementById(id);
    if (!panel) {
        panel = document.createElement('section');
        panel.id = id;
        panel.className = `liveParameterPanel addonPanel ${className}`;
        panel.hidden = true;
        panel.setAttribute('aria-label', 'Add-on');
        panel.innerHTML = `<header><div><strong data-title></strong><small data-hint></small></div><button data-close type="button" aria-label="Close add-on">×</button></header><p data-message hidden></p>`;
        panel.querySelector('[data-close]').addEventListener('click', () => (id === 'addonPanel' ? closeAddon() : closePage()));
        (document.getElementById('canvas') ?? document.body).append(panel);
        // The ids the phone layer and the tests know the close button by.
        panel.querySelector('[data-close]').id = id === 'addonPanel' ? 'closeAddonPanel' : 'closeAddonPagePanel';
    }
    return panel;
}

function showProblem(panel, message) {
    const text = panel.querySelector('[data-message]');
    text.textContent = message;
    text.hidden = !message;
}

// Shows `html` in a sandboxed frame in `panel` and answers the frame's messages: { konjugate: 'call', id, method, params } through
// `bridge.call` (when the add-on has an API), and 'ready' once its API is in place. Returns the running state; stop() removes the frame.
function startFrame(panel, { label, build, bridge }) {
    const frame = document.createElement('iframe');
    // allow-scripts only: with no allow-same-origin the frame's origin is opaque. Nothing else is added (no popups, no top navigation, no forms).
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', label);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.className = 'addonFrame';
    const state = { frame, bridge, timer: null, ready: false, onMessage: null, stop() {
        clearTimeout(state.timer);
        window.removeEventListener('message', state.onMessage);
        // The frame is removed, not hidden, so the add-on stops running and what it held is gone.
        frame.remove();
    } };
    const failed = (text) => {
        frame.remove();
        showProblem(panel, `${label} could not be opened: ${text}`);
    };
    state.onMessage = async (event) => {
        // Only the frame this panel made, whatever else posts to the page.
        if (event.source !== frame.contentWindow) return;
        const message = event.data;
        if (!message || typeof message !== 'object') return;
        if (message.konjugate === 'shell') {
            try {
                frame.contentWindow?.postMessage({ document: await build() }, '*');
            } catch (error) {
                failed(error.message);
            }
        } else if (message.konjugate === 'ready') {
            state.ready = true;
            clearTimeout(state.timer);
        } else if (message.konjugate === 'call' && Number.isSafeInteger(message.id) && bridge) {
            let reply;
            try {
                reply = { konjugate: 'result', id: message.id, value: await bridge.call(message.method, message.params) };
            } catch (error) {
                reply = { konjugate: 'result', id: message.id, error: String(error?.message ?? error).slice(0, 300) };
            }
            try {
                frame.contentWindow?.postMessage(reply, '*');
            } catch {
                frame.contentWindow?.postMessage({ konjugate: 'result', id: message.id, error: 'The answer could not be sent.' }, '*');
            }
        }
    };
    window.addEventListener('message', state.onMessage);
    // A page that never says it is ready (a broken add-on, a script that throws before the API is used) is given up on.
    if (bridge) state.timer = setTimeout(() => { if (!state.ready) failed('it did not start.'); }, readyTimeoutMilliseconds);
    frame.src = frameAddress;
    panel.append(frame);
    panel.hidden = false;
    return state;
}

function closeAddon() {
    if (!current) return;
    current.stop();
    current = null;
    panelElement('addonPanel', '').hidden = true;
    closePage();
}

function closePage() {
    if (!page) return;
    page.stop();
    page = null;
    panelElement('addonPagePanel', 'addonPagePanel').hidden = true;
}

function sendToFrame(message) {
    if (current) current.frame.contentWindow?.postMessage(message, '*');
}

async function openVisualizer(store, entry, contexts) {
    const payload = contexts?.resultSession;
    if (!payload) throw new Error('The add-on command requires unavailable context.');
    const session = createVisualizerSession({ ...payload, sessionId: crypto.randomUUID() });
    const panel = panelElement('addonPanel', 'visualizerPanel');
    const { manifest } = entry;
    // The same add-on asked for again, with a newer result: its frame is kept and told, as the desktop's window is.
    if (current?.addonId === manifest.addonId) {
        sendToFrame({ konjugate: 'event', ...current.bridge.replaceSession(session) });
        panel.hidden = false;
        return;
    }
    closeAddon();
    const bridge = createVisualizerBridge({
        manifest, session,
        settings: { get: (id) => store.getAddonSettings(id), set: (id, value) => store.setAddonSettings(id, value) },
        saveCsv: async (fileName, text) => downloadCsv(fileName, text),
        requestSeek: (time) => seekHandlers.forEach((handler) => handler(time))
    });
    panel.querySelector('[data-title]').textContent = manifest.name;
    panel.querySelector('[data-hint]').textContent = `${session.projectName} · results`;
    showProblem(panel, '');
    panel.classList.remove('launcherPanel');
    current = { ...startFrame(panel, { label: manifest.name, bridge, build: () => buildAddonDocument({ entry: manifest.entry, readFile: (path) => store.readFile(entry, path) }) }), addonId: manifest.addonId, kind: 'resultVisualizer' };
}

// What opening a model from a launcher asks of the project window: the renderer registered for it as it does for the desktop's.
const openProjectListeners = [];
const pendingListeners = [];
const abandonedListeners = [];

// A file chosen by the person, as bytes: [{ name, bytes }], or null if none is chosen. Called inside the click that asked for it.
function chooseFiles({ label, extensions, multiple }) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = Boolean(multiple);
        input.accept = extensions.map((extension) => `.${extension}`).join(',');
        input.setAttribute('aria-label', label);
        input.addEventListener('change', async () => resolve(await Promise.all([...input.files].map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })))), { once: true });
        input.addEventListener('cancel', () => resolve(null), { once: true });
        input.click();
    });
}

async function openLauncher(store, entry) {
    const { manifest } = entry;
    const panel = panelElement('addonPanel', 'launcherPanel');
    if (current?.addonId === manifest.addonId) {
        panel.hidden = false;
        return;
    }
    closeAddon();
    const readPackageFile = (path) => store.readFile(entry, path);
    const bridge = createLauncherBridge({
        manifest,
        host: {
            readPackageFile,
            chooseFiles,
            emit: (channel, payload) => sendToFrame({ konjugate: 'event', channel, payload }),
            runImporter: async ({ importer, files, options, onProgress }) => {
                const bytes = await readPackageFile(importer.entry);
                if (!bytes) throw new Error(`The importer ${importer.entry} is not in the package.`);
                return runImporterInFrame({ source: new TextDecoder().decode(bytes), importer, files, options, onProgress, readPackageFile });
            },
            // Plugins the model names are resolved to their source first, as every engine call from the page does.
            runModel: async ({ content, config, commands }) => runModel(engineModuleUrl, await resolvePluginReferences(content), config, commands),
            canSendCommands: canSendCommands(),
            openProject: async (payload) => {
                pendingListeners.forEach((listener) => listener());
                try {
                    for (const listener of openProjectListeners) await listener(payload);
                } catch (error) {
                    abandonedListeners.forEach((listener) => listener());
                    throw error;
                }
            },
            openPage: async (declaredPage) => {
                closePage();
                const pagePanel = panelElement('addonPagePanel', 'addonPagePanel');
                pagePanel.querySelector('[data-title]').textContent = declaredPage.label;
                pagePanel.querySelector('[data-hint]').textContent = manifest.name;
                showProblem(pagePanel, '');
                page = startFrame(pagePanel, { label: declaredPage.label, bridge: null, build: () => buildAddonDocument({ entry: declaredPage.entry, readFile: readPackageFile, apiSource: '' }) });
            },
            // A link a publisher wrote is opened only after the person has seen it, as on the desktop's confirmation.
            openLink: async (href) => {
                if (!window.confirm(`Open this link in a new tab?\n\n${href}\n\nThis comes from the ${manifest.name} add-on, not from Konjugate itself.`)) return false;
                window.open(href, '_blank', 'noopener,noreferrer');
                return true;
            }
        }
    });
    panel.querySelector('[data-title]').textContent = manifest.name;
    panel.querySelector('[data-hint]').textContent = 'Toolbox';
    showProblem(panel, '');
    current = { ...startFrame(panel, { label: manifest.name, bridge, build: () => buildAddonDocument({ entry: manifest.entry, readFile: readPackageFile, apiSource: launcherApiSource }) }), addonId: manifest.addonId, kind: 'launcher' };
}

export const addons = {
    listToolstripContributions: async () => (await (await packageStore()).runnableAddons()).flatMap((entry) => publicToolstripContributions(entry.manifest)),
    invokeCommand: async (addonId, commandId, contexts = {}) => {
        const store = await packageStore();
        const entry = (await store.runnableAddons()).find((item) => item.packageId === addonId);
        if (!entry?.manifest.contributes?.toolstrip?.some((item) => item.commandId === commandId)) throw new Error('That add-on command is unavailable.');
        if (entry.manifest.kind === 'launcher') await openLauncher(store, entry);
        else await openVisualizer(store, entry, contexts);
        return { addonId, commandId };
    },
    // The page changed something an open visualizer may be told of; the bridge says whether this one may hear it.
    publishEvent: (name, payload) => {
        if (current?.kind !== 'resultVisualizer') return;
        const event = current.bridge.event(name, payload);
        if (event) sendToFrame({ konjugate: 'event', ...event });
    },
    // A result session ending closes a visualizer, not a launcher, which does not depend on one.
    closeContext: (name) => { if (name === 'resultSession' && current?.kind === 'resultVisualizer') closeAddon(); },
    onRequest: (name, handler) => { if (name === 'timeline.seek') seekHandlers.push(handler); }
};

// What the renderer registers with on the desktop to take a project a launcher built (see renderer.mjs); here the launcher's host calls these.
export const launcherHost = {
    onOpenProject: (listener) => { openProjectListeners.push(listener); },
    onOpenProjectPending: (listener) => { pendingListeners.push(listener); },
    onOpenProjectAbandoned: (listener) => { abandonedListeners.push(listener); },
    onKeepAddonData: () => {},
    onAddonDataRequest: () => {}
};

// An add-on that is uninstalled or turned off while open is closed with it.
window.addEventListener('konjugate:packages-changed', async () => {
    if (!current) return;
    const stillThere = (await (await packageStore()).runnableAddons()).some((item) => item.packageId === current?.addonId);
    if (!stillThere) closeAddon();
});

if (typeof document !== 'undefined') panelElement('addonPanel', '');
