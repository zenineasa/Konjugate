/* Copyright © 2026 Zenin Easa Panthakkalakath */

// window.projectFiles for the web shell (docs/proposals/webEdition.md). Load/save (including
// encrypted .kjt, via browserProjectCodec.mjs's scrypt-based KDF -- the same one desktop uses,
// so files move between editions) go through the File System Access API where available (falls
// back to an <input type=file> picker for opening and a download-blob for saving where it isn't
// -- Firefox and Safari at time of writing). Examples are served as static files, listed via a
// manifest scripts/buildWebShell.mjs generates at build time (mirroring what
// src/main.mjs's projectListExamples handler computes at request time, since a browser has no
// directory-listing capability of its own). Package/FMU/toolchain-dependent operations
// (exportFmu, mergeFmus) are honestly unavailable, matching webEdition.md's existing stance.

import { decodeResultFile } from '../../engineProtocol.mjs';
import { pluginExampleBytes, pluginExampleEntries, pluginExampleGuide } from './packages.mjs';
import { showGuidePanel } from './guidePanel.mjs';
import { startTutorialInPage } from './misc.mjs';
import { tutorialsForExample } from '../../tutorials/index.mjs';
import { publicNoticeOf } from '../../ownership.mjs';
import { BrowserProjectFileError, decodeProjectContent, encodeProjectContent, inspectProjectContent } from '../../browserProjectCodec.mjs';
import { rendererResultProjection } from '../../resultSession.mjs';
import { registerCompletedResult } from '../../webEngineLiveShim.mjs';

function isFsaSupported() {
    return typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function';
}

function downloadBlob(bytes, fileName, mimeType) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Set by the shell's drag-drop handler (see webShims/index.mjs) just before it synthesizes the
// same Ctrl/Cmd+O keypress renderer.mjs's own keyboard shortcut already handles -- open() below
// picks this up instead of showing a file picker, so a drop reuses openProject()'s real flow
// (including its confirmDiscard() check) with zero changes to renderer.mjs.
let pendingDroppedFile = null;
export function setPendingDroppedFile(bytes, fileName) {
    pendingDroppedFile = { bytes, fileName };
}

let handleCounter = 0;
const fileHandles = new Map(); // synthetic path id -> FileSystemFileHandle, so a second Save doesn't re-prompt
// synthetic path id -> { bytes, fileName, handle } for an encrypted file whose password hasn't
// been supplied yet -- unlock() below re-decodes from here, mirroring src/main.mjs's own
// pendingEncryptedPaths Set (there, keyed by a real filesystem path to re-read; here, by a
// synthetic id since there's no path to re-read from in a browser).
const pendingEncryptedFiles = new Map();

async function fileFromBytes(bytes, fileName, handle = null, password = null) {
    const inspection = inspectProjectContent(bytes);
    if (!password && inspection.encrypted) {
        const path = String(++handleCounter);
        pendingEncryptedFiles.set(path, { bytes, fileName, handle });
        return { path, fileName, encrypted: true, requiresPassword: true, ...(inspection.publicNotice ? { publicNotice: inspection.publicNotice } : {}) };
    }
    const decoded = await decodeProjectContent(bytes, { password });
    const path = handle ? String(++handleCounter) : null;
    if (handle) fileHandles.set(path, handle);
    let embeddedResult = null;
    if (decoded.result) {
        const jobId = crypto.randomUUID();
        const result = decodeResultFile(decoded.result);
        registerCompletedResult(jobId, result);
        embeddedResult = { sessionId: jobId, result: rendererResultProjection(result) };
    }
    return { path, fileName, encrypted: Boolean(password), content: decoded.content, embeddedResult };
}

async function open() {
    if (pendingDroppedFile) {
        const { bytes, fileName } = pendingDroppedFile;
        pendingDroppedFile = null;
        return fileFromBytes(bytes, fileName);
    }
    if (isFsaSupported()) {
        let handle;
        try {
            [handle] = await window.showOpenFilePicker({
                types: [{ description: 'Konjugate project', accept: { 'application/octet-stream': ['.kjt'] } }]
            });
        } catch (error) {
            if (error.name === 'AbortError') return null;
            throw error;
        }
        const file = await handle.getFile();
        return fileFromBytes(new Uint8Array(await file.arrayBuffer()), file.name, handle);
    }
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.kjt';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) { resolve(null); return; }
            try {
                resolve(await fileFromBytes(new Uint8Array(await file.arrayBuffer()), file.name));
            } catch (error) {
                reject(error);
            }
        }, { once: true });
        input.click();
    });
}

async function unlock(path, password) {
    const pending = pendingEncryptedFiles.get(path);
    if (!pending) throw new BrowserProjectFileError('Select the encrypted project again.', 'INVALID_STATE');
    pendingEncryptedFiles.delete(path);
    return fileFromBytes(pending.bytes, pending.fileName, pending.handle, password);
}

async function save(path, content, suggestedFilename, password, resultBranches) {
    if (resultBranches) {
        throw new Error("Saving simulation results with the project isn't supported in the web edition yet " +
            '-- export results as CSV separately, or save the model only.');
    }
    const bytes = await encodeProjectContent(content, { password, publicNotice: publicNoticeOf(content) });
    if (isFsaSupported()) {
        let handle = path ? fileHandles.get(path) : null;
        if (!handle) {
            try {
                handle = await window.showSaveFilePicker({
                    suggestedName: suggestedFilename || 'untitled.kjt',
                    types: [{ description: 'Konjugate project', accept: { 'application/octet-stream': ['.kjt'] } }]
                });
            } catch (error) {
                if (error.name === 'AbortError') return null;
                throw error;
            }
        }
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        const resolvedPath = path && fileHandles.get(path) === handle ? path : String(++handleCounter);
        fileHandles.set(resolvedPath, handle);
        return { path: resolvedPath, fileName: handle.name, encrypted: Boolean(password), includesResults: false };
    }
    const fileName = suggestedFilename || 'untitled.kjt';
    downloadBlob(bytes, fileName, 'application/octet-stream');
    return { path: null, fileName, encrypted: Boolean(password), includesResults: false };
}

async function bundledExamples() {
    const manifestUrl = new URL('../../examples/webManifest.json', import.meta.url);
    const response = await fetch(manifestUrl);
    if (!response.ok) return [];
    const examples = await response.json();
    return examples.map((example) => ({
        ...example,
        thumbnailUrl: example.thumbnailUrl ? new URL(example.thumbnailUrl, manifestUrl).href : null
    }));
}

// The bundled examples, then those installed plugins add (a plugin's example whose id a bundled one has is left out).
async function listExamples() {
    const bundled = await bundledExamples();
    return [...bundled, ...await pluginExampleEntries(new Set(bundled.map((example) => example.id)))];
}

async function loadExample(id) {
    const bundledIds = new Set((await bundledExamples()).map((example) => example.id));
    const pluginBytes = await pluginExampleBytes(id, bundledIds);
    if (pluginBytes) return { ...await fileFromBytes(pluginBytes, id), suggestedFilename: id };
    const response = await fetch(new URL(`../../examples/${id}`, import.meta.url));
    if (!response.ok) throw new Error('That example is not available.');
    const file = await fileFromBytes(new Uint8Array(await response.arrayBuffer()), id);
    // A tutorial's model beside the examples (dataSources/labVessel.kjt) takes its own file name.
    return { ...file, suggestedFilename: id.split('/').at(-1) };
}

// An example's guide, rendered in the guide panel beside the model (never by sending the tab to the raw .md file, which took the person
// away from their model with no way back). Returns whether there was a guide to show, as the desktop's openExampleGuide does.
async function openExampleGuide(id) {
    const bundled = await bundledExamples();
    const pluginGuide = await pluginExampleGuide(id, new Set(bundled.map((example) => example.id)));
    if (pluginGuide) {
        showGuidePanel({ ...pluginGuide, kind: 'example' }, { startTutorial: startTutorialInPage });
        return true;
    }
    const example = bundled.find((entry) => entry.id === id);
    if (!example) return false;
    const response = await fetch(new URL(`../../examples/${id.replace(/\.kjt$/, '.md')}`, import.meta.url));
    if (!response.ok) throw new Error('That example has no guide.');
    // An example with tutorials says so at the top of its guide (docs/proposals/tutorials.md); only those this edition has.
    const tutorials = tutorialsForExample(id).filter((tutorial) => tutorial.editions.includes('web'))
        .map((tutorial) => ({ id: tutorial.id, title: tutorial.title, minutes: tutorial.minutes, summary: tutorial.summary }));
    showGuidePanel({ title: example.label, markdown: await response.text(), kind: 'example', tutorials }, { startTutorial: startTutorialInPage });
    return true;
}

async function openCausalInferenceInteractionHelp() {
    const response = await fetch(new URL('../../docs/causalInferenceInteractionHelp.md', import.meta.url));
    if (!response.ok) throw new Error('The causal inference help is not available.');
    showGuidePanel({ title: 'Causal inference', markdown: await response.text(), kind: 'help' }, { startTutorial: startTutorialInPage });
}

async function exportResultsCsv(suggestedFilename, csv) {
    downloadBlob(new TextEncoder().encode(csv), suggestedFilename || 'results.csv', 'text/csv');
    return { path: null, fileName: suggestedFilename || 'results.csv' };
}

async function exportGeneratedProgram(suggestedFilename, source, kind) {
    const fileName = suggestedFilename || (kind === 'cpp' ? 'program.cpp' : 'program.py');
    downloadBlob(new TextEncoder().encode(source), fileName, kind === 'cpp' ? 'text/x-c++src' : 'text/x-python');
    return { path: null, fileName };
}

// The project open in this tab, kept in the browser (IndexedDB, which holds far more than local storage) so a reload or a closed tab
// does not lose it: written as the same bytes Save writes (browserProjectCodec.mjs, model only), read back when the page opens. One
// project is kept, the latest any tab wrote. Where the browser has no IndexedDB (or refuses it, as some private windows do) every call
// rejects, and the page asks before it is closed with unsaved changes instead.
const autosaveDatabaseName = 'konjugate.autosave';
const autosaveStoreName = 'projects';
const autosaveKey = 'current';
let autosaveDatabasePromise = null;
function autosaveDatabase() {
    autosaveDatabasePromise ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(autosaveDatabaseName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(autosaveStoreName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return autosaveDatabasePromise;
}
async function autosaveRequest(mode, action) {
    const database = await autosaveDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(autosaveStoreName, mode);
        const request = action(transaction.objectStore(autosaveStoreName));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('The browser did not keep the project.'));
    });
}

const autosave = {
    // `content` is a project file's text; `details` are kept beside it as they are (its file name, whether it had unsaved changes,
    // whether a result was left out, the example it came from).
    write: async (content, details) => {
        const bytes = await encodeProjectContent(content);
        await autosaveRequest('readwrite', (store) => store.put({ ...details, bytes, savedAt: Date.now() }, autosaveKey));
    },
    // The kept project as { content, savedAt, ...details }, or null when none is kept.
    read: async () => {
        const record = await autosaveRequest('readonly', (store) => store.get(autosaveKey));
        if (!record?.bytes) return null;
        const { bytes, ...details } = record;
        return { ...details, content: (await decodeProjectContent(bytes)).content };
    },
    clear: () => autosaveRequest('readwrite', (store) => store.delete(autosaveKey))
};

async function confirmDiscard() {
    return window.confirm('You have unsaved changes. Discard them and continue?');
}

export default {
    listExamples,
    loadExample,
    openExampleGuide,
    openCausalInferenceInteractionHelp,
    open,
    pendingOpen: async () => null, // no OS file-association concept in a single browser tab
    pathChanged: () => {},
    unlock,
    save,
    exportResultsCsv,
    exportGeneratedProgram,
    exportFmu: async () => ({ available: false }),
    mergeFmus: async () => ({ available: false }),
    confirmDiscard,
    autosave
};
