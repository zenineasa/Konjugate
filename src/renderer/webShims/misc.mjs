/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Every window.* global except engine (engine.mjs), projectFiles (projectFiles.mjs), and
// providerEditor (providerEditor.mjs) for the web shell (docs/proposals/webEdition.md). Bundled-
// content lists (shapeLibrary, componentLibrary) are served as static files -- the
// componentLibrary one is generated at build time by scripts/buildWebShell.mjs, mirroring
// src/main.mjs's discoverComponentLibrary() for the bundled portion only, since assembling it
// requires a directory scan a browser can't do itself; shapeLibrary's is fetched straight from
// the existing assets/shapes/manifest.json and normalized the same way src/main.mjs's
// shapeLibraryManifest() does. Package installation, C++ providers, add-ons, and AI-provider
// credential storage are honestly unavailable -- see webEdition.md's "Two genuinely different
// classes of missing native code" and its Electron-shell section for why each of these has no
// browser equivalent yet. Python providers (phase 4) are real -- see providerToolchains below and
// providerEditor.mjs.

import { threads, version } from './buildInfo.mjs';
import { normalizeShapeLibraryEntry } from '../../shapeLibraryCatalog.mjs';
import { validateComponentTemplate } from '../../componentTemplate.mjs';
import { createUserLibraryStore } from '../../userLibraryStore.mjs';

const minimumUiZoom = 0.75;
const maximumUiZoom = 1.5;
const uiZoomStep = 0.1;
let currentZoom = 1;
function applyZoom(factor) {
    currentZoom = Math.min(maximumUiZoom, Math.max(minimumUiZoom, Math.round(factor * 10) / 10));
    document.documentElement.style.zoom = currentZoom;
    return currentZoom;
}
export const uiZoom = {
    get: () => currentZoom,
    increase: () => applyZoom(currentZoom + uiZoomStep),
    decrease: () => applyZoom(currentZoom - uiZoomStep),
    reset: () => applyZoom(1),
    limits: { minimum: minimumUiZoom, maximum: maximumUiZoom }
};

export const windowControls = {
    minimize: () => {},
    toggleMaximize: () => {},
    close: () => {},
    newWindow: () => window.open(location.href, '_blank'),
    onMaximizedChange: () => {}
};

export const applicationInfo = {
    get: async () => ({ version }),
    openWelcome: async () => {}
};

export const diagnostics = {
    list: async () => [],
    onIssue: () => {}
};

let clipboardFragment = null;
export const modelClipboard = {
    write: (fragment) => { clipboardFragment = fragment; },
    read: () => clipboardFragment
};

async function shapeLibraryManifest() {
    const response = await fetch(new URL('../../assets/shapes/manifest.json', import.meta.url));
    if (!response.ok) return [];
    const parsed = await response.json();
    return parsed.shapes.map(normalizeShapeLibraryEntry);
}
export const shapeLibrary = {
    list: () => shapeLibraryManifest(),
    load: async (id) => {
        const shape = (await shapeLibraryManifest()).find((candidate) => candidate.id === id);
        if (!shape) throw new Error('That shape is not available.');
        const response = await fetch(new URL(`../../assets/shapes/${shape.file}`, import.meta.url));
        if (!response.ok) throw new Error('That shape is not available.');
        return { ...shape, data: new Uint8Array(await response.arrayBuffer()) };
    },
    saveUpload: async () => ({ available: false })
};

// The user's own templates live in the browser (IndexedDB), the counterpart of the desktop app's user data folder. What is
// allowed with them is not decided here but in src/userLibraryStore.mjs, the same code the desktop uses; this is only where
// they are kept.
const userLibraryDatabaseName = 'konjugate-user-component-library';

function openUserLibraryDatabase() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('This browser cannot keep templates here (private browsing, or storage turned off).'));
            return;
        }
        const request = indexedDB.open(userLibraryDatabaseName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('templates', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('The browser could not open its template storage.'));
    });
}

async function userLibraryRequest(mode, action) {
    const database = await openUserLibraryDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction('templates', mode);
        const request = action(transaction.objectStore('templates'));
        transaction.oncomplete = () => { database.close(); resolve(request?.result); };
        transaction.onerror = transaction.onabort = () => {
            database.close();
            reject(transaction.error ?? new Error('The browser could not store the template.'));
        };
    });
}

async function bundledComponentTemplates() {
    const response = await fetch(new URL('../../assets/componentLibrary/webManifest.json', import.meta.url));
    return response.ok ? response.json() : [];
}

async function readUserTemplates() {
    const stored = await userLibraryRequest('readonly', (store) => store.getAll()).catch(() => []);
    return stored.flatMap((template) => {
        try {
            return [validateComponentTemplate(template)];
        } catch {
            return [];
        }
    });
}

const userComponentLibrary = createUserLibraryStore({
    readAll: readUserTemplates,
    write: (template) => userLibraryRequest('readwrite', (store) => store.put(template)),
    remove: (id) => userLibraryRequest('readwrite', (store) => store.delete(id)),
    otherTemplateIds: async () => (await bundledComponentTemplates()).map((template) => template.id)
});

export const componentLibrary = {
    list: async () => {
        const [bundled, user] = await Promise.all([bundledComponentTemplates(), readUserTemplates()]);
        return [...bundled.map((template) => ({ ...template, source: 'bundled' })), ...user.map((template) => ({ ...template, source: 'user' }))];
    },
    saveUser: async (template) => ({ ...await userComponentLibrary.save(template), source: 'user' }),
    updateUser: async (id, changes) => ({ ...await userComponentLibrary.update(id, changes), source: 'user' }),
    moveUserSection: (from, to) => userComponentLibrary.moveSection(from, to),
    removeUser: (id) => userComponentLibrary.remove(id)
};

export const extensions = {
    list: async () => [],
    install: async () => ({ available: false }),
    uninstall: async () => ({ available: false }),
    setEnabled: async () => ({ available: false }),
    // No FMU is ever installed in the web edition.
    fmuPorts: async () => ({ error: 'FMUs run in the desktop app only.' }),
    // Called unconditionally at renderer startup (restart-pending badge, update-count badge), so
    // they need no-op stand-ins here -- nothing is ever installed in the web edition to restart for
    // or update.
    restartPending: async () => false,
    onRestartPendingChange: () => {},
    checkUpdates: async () => []
};

// providerEditor lives in its own file (providerEditor.mjs) -- it needs a real <dialog>, unlike
// everything else here.

// Python's toolchain is Pyodide, bundled with the app -- there's no interpreter path to locate,
// override, or browse to (see docs/proposals/webEdition.md, phase 4). C++'s toolchain is clang,
// fetched on demand from Wasmer's registry (see src/webCppProviderBridge.mjs) -- real, but only
// on the pthread-enabled "threads" build: @wasmer/sdk's browser runtime needs SharedArrayBuffer/
// cross-origin isolation the same way the threads build's own parallel execution does, which the
// default shell is not served with. The default shell's providerToolchains.get('cpp') stays
// honestly unavailable rather than claim a toolchain it cannot actually reach.
export const providerToolchains = {
    get: async (kind) => {
        if (kind === 'python') return { available: true, path: 'Pyodide (bundled)', detectedPath: 'Pyodide (bundled)' };
        if (kind === 'cpp' && threads) return { available: true, path: 'clang 16 (via Wasmer, fetched on demand)', detectedPath: 'clang 16 (via Wasmer, fetched on demand)' };
        return { available: false };
    },
    set: async () => ({ available: false }),
    test: async (kind) => {
        if (kind === 'python') return { available: true };
        if (kind === 'cpp' && threads) return { available: true };
        return { available: false };
    },
    browse: async () => ({ available: false }),
    executionMode: {
        get: async () => ({ available: false }),
        set: async () => ({ available: false })
    }
};

export const aiProviders = {
    listConfigurations: async () => [],
    listModels: async () => [],
    listDraftModels: async () => [],
    saveConfiguration: async () => ({ available: false }),
    removeConfiguration: async () => ({ available: false }),
    setActiveConfiguration: async () => ({ available: false }),
    testConnection: async () => ({ available: false }),
    testDraftConnection: async () => ({ available: false }),
    generateProposal: async () => {
        throw new Error('AI-assisted authoring is not available in the web edition yet.');
    },
    cancelRequest: async () => {},
    onProgress: () => {}
};

export const addons = {
    listToolstripContributions: async () => [],
    invokeCommand: async () => ({ available: false }),
    publishEvent: () => {},
    closeContext: () => {},
    onRequest: () => {}
};
