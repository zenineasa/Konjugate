/* Copyright © 2026 Zenin Easa Panthakkalakath */

// window.providerEditor for the web shell: the web host of the code editor (docs/proposals/codeEditor.md, "One editor on the web").
// A page cannot open a second window of the app, so the same editor the desktop window holds (src/providerEditor/editorCore.mjs) sits
// in a panel that floats over the project at the size the window would be, moves by its title bar, resizes from its corner and leaves
// the canvas usable beside it. It keeps renderer.mjs's openWindow / onApplied / reportApplied contract, so the project side is the same
// on both.
//
// Lint: Python through Pyodide (as runs use), C++ through the in-browser clang of the threads build. Check program: the WASM engine's
// checkProgram through window.engine.checkProgram.

import { runPythonSyntaxCheck } from '../../webPythonProviderBridge.mjs';
import { threads } from './buildInfo.mjs';
import { createLintScheduler, lintHash } from '../../lintScheduler.mjs';

export const cppNeedsDesktopMessage = 'C++ programs are checked and run in the desktop app, or in a browser that allows the faster web build.';
const boundsKey = 'konjugate.providerEditor.panelBounds';

let panel = null;
let titleElement = null;
let editorPromise = null;
const appliedListeners = [];
const statusListeners = [];
let requestHandler = null;
let pendingApply = null;

function savedBounds() {
    try {
        const bounds = JSON.parse(localStorage.getItem(boundsKey) ?? 'null');
        return bounds && ['left', 'top', 'width', 'height'].every((key) => Number.isFinite(bounds[key])) ? bounds : null;
    } catch { return null; }
}

// The window's size (820 × 640) where the page has room, kept on the page; toward the right, so the canvas stays usable at the left.
function placePanel() {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const saved = savedBounds();
    const width = Math.min(saved?.width ?? 820, viewportWidth - 16);
    const height = Math.min(saved?.height ?? 640, viewportHeight - 16);
    const left = Math.min(Math.max(8, saved?.left ?? viewportWidth - width - 24), Math.max(8, viewportWidth - width - 8));
    const top = Math.min(Math.max(8, saved?.top ?? Math.round((viewportHeight - height) / 2)), Math.max(8, viewportHeight - height - 8));
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
}

function keepBounds() {
    const rect = panel.getBoundingClientRect();
    try { localStorage.setItem(boundsKey, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) })); } catch { /* not kept */ }
}

function ensurePanel() {
    if (panel) return;
    const stylesheet = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('../../providerEditor/editorCore.css', import.meta.url).href });
    document.head.append(stylesheet);
    panel = document.createElement('section');
    panel.className = 'webProgramEditorPanel';
    panel.id = 'webProgramEditorPanel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Program');
    panel.innerHTML = `
        <header class="webProgramEditorTitleBar"><span>Program</span><button type="button" class="webProgramEditorClose" aria-label="Close">×</button></header>
        <div class="webProgramEditorBody"></div>`;
    titleElement = panel.querySelector('.webProgramEditorTitleBar span');
    document.body.append(panel);

    // Moving by the title bar.
    const titleBar = panel.querySelector('.webProgramEditorTitleBar');
    titleBar.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest('button')) return;
        const rect = panel.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        titleBar.setPointerCapture(event.pointerId);
        const move = (moveEvent) => {
            const left = Math.min(Math.max(0, moveEvent.clientX - offsetX), window.innerWidth - 60);
            const top = Math.min(Math.max(0, moveEvent.clientY - offsetY), window.innerHeight - 32);
            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
        };
        const end = () => {
            titleBar.removeEventListener('pointermove', move);
            titleBar.removeEventListener('pointerup', end);
            titleBar.removeEventListener('pointercancel', end);
            keepBounds();
        };
        titleBar.addEventListener('pointermove', move);
        titleBar.addEventListener('pointerup', end);
        titleBar.addEventListener('pointercancel', end);
    });
    // Resized from its corner (CSS resize): the size is kept when it changes.
    new ResizeObserver(() => { if (!panel.hidden) keepBounds(); }).observe(panel);
    // Typing in the editor is not the project's shortcuts (Delete, the canvas's keys).
    panel.addEventListener('keydown', (event) => event.stopPropagation());
    panel.querySelector('.webProgramEditorClose').addEventListener('click', () => editorPromise?.then((editor) => editor.requestClose()));
}

// The check as you type, one at a time, stopped when superseded or after 10 s, answers kept by source (src/lintScheduler.mjs), as on the
// desktop. Pyodide's check runs to its end once started (it is quick); the in-browser clang is killed.
const lint = createLintScheduler({
    key: (request) => `${request.kind}|${lintHash(request.source)}`,
    run: async (request, signal) => (request.kind === 'python'
        ? runPythonSyntaxCheck(request.source)
        : (await import('../../webCppProviderBridge.mjs')).runCppSyntaxCheck(request.source, { signal }))
});

async function validate(source, kind) {
    if (kind === 'cpp' && !threads) return { valid: null, message: cppNeedsDesktopMessage };
    if (kind !== 'python' && kind !== 'cpp') return { valid: null, message: '' };
    const answer = await lint.schedule({ kind, source });
    window.__programLintStats = { ...lint.stats }; // Debug/test hook only: how many checks ran, were kept, or ran at once.
    return answer;
}

// Test, through the web engine. A version 2 C++ program cannot run in the web engine: it is tested in the desktop app.
async function test(source, kind, request) {
    if (kind === 'cpp') return { available: false, reason: 'Test this C++ program in the desktop app.' };
    if (!window.engine?.testProgram) return { available: false, reason: 'Test runs in the desktop app.' };
    return window.engine.testProgram({ kind, source, ...request });
}

// The program's ports as the web engine reads them. A version 2 C++ program cannot run in the web engine, so it is read on the desktop.
async function describe(source, kind, inputs) {
    if (kind === 'cpp') return { available: false, reason: 'The engine reads a C++ program’s memory and clock in the desktop app.' };
    if (!window.engine?.describeProgram) return { available: false, reason: 'The engine reads a program’s memory and clock in the desktop app.' };
    return window.engine.describeProgram({ kind, source, inputs: inputs ?? {} });
}

// The project's answer to an apply comes back through reportApplied, as on the desktop.
function apply(source, target) {
    pendingApply?.({ applied: false, error: 'Superseded by a newer apply.' });
    return new Promise((resolve) => {
        pendingApply = resolve;
        if (!appliedListeners.length) { pendingApply = null; resolve({ applied: false, error: 'The project is not listening.' }); return; }
        appliedListeners.forEach((listener) => listener({ source, target: target ?? null }));
    });
}

function reportApplied(result) {
    const resolve = pendingApply;
    pendingApply = null;
    resolve?.(result);
}

function ensureEditor() {
    ensurePanel();
    if (!editorPromise) {
        editorPromise = import('../../providerEditor/editorCore.mjs').then(({ createProgramEditor }) => createProgramEditor({
            root: panel.querySelector('.webProgramEditorBody'),
            host: {
                validate,
                test,
                describe,
                openExternal: (url) => { window.open(url, '_blank', 'noopener'); },
                bind: async (key, value, target) => (requestHandler
                    ? requestHandler({ action: 'bind', target, payload: { key, value } })
                    : { applied: false, error: 'The project is not listening.' }),
                apply,
                close: () => { panel.hidden = true; },
                setTitle: (text) => { titleElement.textContent = text; panel.setAttribute('aria-label', text); },
                reportStatus: (status) => statusListeners.forEach((listener) => listener(status))
            }
        }));
        editorPromise.catch(() => { editorPromise = null; });
    }
    return editorPromise;
}

async function openWindow(payload = {}) {
    const editor = await ensureEditor();
    if (panel.hidden) {
        placePanel();
        panel.hidden = false;
    }
    await editor.open(payload);
    window.__providerEditorView = editor.view; // Debug/test hook only; not part of the app's public surface.
    window.__providerEditor = editor;
}

function onApplied(callback) {
    appliedListeners.push(callback);
}

// What the editor asks of the project besides Apply (binding a port from Ports).
function onRequest(callback) {
    requestHandler = callback;
}

// What lint and Check found, for the card's status line.
function onStatus(callback) {
    statusListeners.push(callback);
}

// Leaving the page, or anything that asks the editor to go first: true when it may.
async function confirmClose() {
    if (!editorPromise || panel?.hidden) return true;
    const editor = await editorPromise;
    return editor.dirty ? editor.requestClose() : true;
}

window.addEventListener('beforeunload', (event) => {
    if (!panel || panel.hidden || !window.__providerEditor?.dirty) return;
    event.preventDefault();
    event.returnValue = '';
});

export default {
    openWindow,
    onApplied,
    reportApplied,
    confirmClose,
    onStatus,
    onRequest
};
