/* Copyright © 2026 Zenin Easa Panthakkalakath */

// window.componentFiles for the web shell: the browser's side of component files (docs/subsystems.md#component-files).
// Saving and placing work as for projects (the File System Access API where there is one, a download and a file picker
// where not); a link to a file cannot be followed by path in a browser, so `read` and `resolve` say so and a linked
// component is updated by choosing its file again ("Update from file…").

import { publicNoticeOf } from '../../ownership.mjs';
import { decodeProjectContent, encodeProjectContent, inspectProjectContent } from '../../browserProjectCodec.mjs';

let pending = null;
let counter = 0;
const encrypted = new Map();
const changedCallbacks = [];

async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fromBytes(bytes, fileName, savedAt, password = null) {
    if (!password && inspectProjectContent(bytes).encrypted) {
        const path = `component-${++counter}`;
        encrypted.set(path, { bytes, fileName, savedAt });
        return { path, fileName, encrypted: true, requiresPassword: true };
    }
    const { content } = await decodeProjectContent(bytes, { password });
    JSON.parse(content);
    return { path: null, fileName, encrypted: Boolean(password), content, sha256: await sha256(content), savedAt };
}

function pickFile() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.kjt';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) { resolve(null); return; }
            try {
                resolve({ bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name, savedAt: new Date(file.lastModified).toISOString() });
            } catch (error) { reject(error); }
        }, { once: true });
        input.click();
    });
}

async function open() {
    if (pending) {
        const file = pending;
        pending = null;
        return fromBytes(file.bytes, file.fileName, file.savedAt);
    }
    if (typeof window.showOpenFilePicker === 'function') {
        let handle;
        try {
            [handle] = await window.showOpenFilePicker({ types: [{ description: 'Konjugate project or component', accept: { 'application/octet-stream': ['.kjt'] } }] });
        } catch (error) {
            if (error.name === 'AbortError') return null;
            throw error;
        }
        const file = await handle.getFile();
        return fromBytes(new Uint8Array(await file.arrayBuffer()), file.name, new Date(file.lastModified).toISOString());
    }
    const file = await pickFile();
    return file ? fromBytes(file.bytes, file.fileName, file.savedAt) : null;
}

async function unlock(path, password) {
    const file = encrypted.get(path);
    if (!file) throw new Error('Choose the encrypted component again.');
    encrypted.delete(path);
    return fromBytes(file.bytes, file.fileName, file.savedAt, password);
}

let lastSaved = null;
async function save(suggestedFilename, content) {
    const bytes = await encodeProjectContent(content, { publicNotice: publicNoticeOf(content) });
    const fileName = suggestedFilename || 'Component.kjt';
    lastSaved = { fileName, content };
    if (typeof window.showSaveFilePicker === 'function' && !window.__debugComponentFiles?.capture) {
        let handle;
        try {
            handle = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: 'Konjugate component', accept: { 'application/octet-stream': ['.kjt'] } }] });
        } catch (error) {
            if (error.name === 'AbortError') return null;
            throw error;
        }
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        return { path: null, fileName: handle.name, sha256: await sha256(content), savedAt: new Date().toISOString() };
    }
    if (!window.__debugComponentFiles?.capture) {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    return { path: null, fileName, sha256: await sha256(content), savedAt: new Date().toISOString() };
}

// For the interaction tests, which cannot answer a browser's file picker: the next file chosen, and what was last saved.
window.__debugComponentFiles = {
    capture: false,
    provide: async (content, fileName = 'Component.kjt') => {
        pending = { bytes: await encodeProjectContent(content, {}), fileName, savedAt: new Date().toISOString() };
    },
    lastSaved: () => lastSaved
};

export const componentFiles = {
    open,
    unlock,
    read: async () => ({ unavailable: true }),
    resolve: async () => null,
    save,
    editInWindow: async () => false,
    onChanged: (callback) => { changedCallbacks.push(callback); },
    followsPaths: false
};
