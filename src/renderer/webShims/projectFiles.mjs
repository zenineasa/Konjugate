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
    if (!password && inspectProjectContent(bytes).encrypted) {
        const path = String(++handleCounter);
        pendingEncryptedFiles.set(path, { bytes, fileName, handle });
        return { path, fileName, encrypted: true, requiresPassword: true };
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

async function save(path, content, suggestedFilename, password, resultSessionId) {
    if (resultSessionId) {
        throw new Error("Saving simulation results with the project isn't supported in the web edition yet " +
            '-- export results as CSV separately, or save the model only.');
    }
    const bytes = await encodeProjectContent(content, { password });
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

async function listExamples() {
    const manifestUrl = new URL('../../examples/webManifest.json', import.meta.url);
    const response = await fetch(manifestUrl);
    if (!response.ok) return [];
    const examples = await response.json();
    return examples.map((example) => ({
        ...example,
        thumbnailUrl: example.thumbnailUrl ? new URL(example.thumbnailUrl, manifestUrl).href : null
    }));
}

async function loadExample(id) {
    const response = await fetch(new URL(`../../examples/${id}`, import.meta.url));
    if (!response.ok) throw new Error('That example is not available.');
    const file = await fileFromBytes(new Uint8Array(await response.arrayBuffer()), id);
    return { ...file, suggestedFilename: id };
}

async function openExampleGuide(id) {
    window.open(new URL(`../../examples/${id.replace(/\.kjt$/, '.md')}`, import.meta.url), '_blank');
}

async function openCausalInferenceInteractionHelp() {
    window.open(new URL('../../docs/causalInferenceInteractionHelp.md', import.meta.url), '_blank');
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
    confirmDiscard
};
