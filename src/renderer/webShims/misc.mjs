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
import { normalizeShapeLibraryEntry, uploadedShapeEntry, uploadedShapeFileName } from '../../shapeLibraryCatalog.mjs';
import { validateComponentTemplate } from '../../componentTemplate.mjs';
import { createUserLibraryStore } from '../../userLibraryStore.mjs';
import { bugReportUrl, formatBugReportEmail } from '../../bugReport.mjs';
import { welcomeLinks } from '../../welcomeModel.mjs';

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

// The first-model tour (docs/proposals/guidedTour.md). The web edition has no Welcome window, so it offers the tour itself: once, on a
// first visit, and again whenever the Konjugate button is pressed (what opens the Welcome window on the desktop). Whether it was
// offered is kept in this browser's local storage, which may be unavailable (a private window), in which case it is offered every visit.
const tourOfferedKey = 'konjugate.tourOffered';
const tourStarters = [];
const storage = (action) => { try { return action(window.localStorage); } catch { return null; } };
export const tour = {
    onStart: (callback) => {
        tourStarters.push(callback);
        if (storage((local) => local.getItem(tourOfferedKey))) return;
        storage((local) => local.setItem(tourOfferedKey, '1'));
        // After the renderer has finished setting itself up.
        setTimeout(callback, 800);
    },
    recordCompleted: async () => true
};

export const applicationInfo = {
    get: async () => ({ version }),
    openWelcome: async () => { tourStarters.forEach((start) => start()); }
};

// Help & feedback (src/bugReport.mjs). The web edition reports its browser, not an installer or Electron, and opens GitHub in a new tab.
const webBugReportDetails = () => ({ version, browser: navigator.userAgent });
export const helpFeedback = {
    details: async () => formatBugReportEmail(webBugReportDetails()),
    openGitHub: async () => { window.open(bugReportUrl(welcomeLinks.reportProblem, webBugReportDetails()), '_blank', 'noopener'); },
    onOpen: () => {}
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

// The shapes a person uploads are kept in the browser (IndexedDB), the counterpart of the desktop app's shapes folder in its user data;
// what they are called and listed as is decided in src/shapeLibraryCatalog.mjs, the same code the desktop uses.
const userShapeDatabaseName = 'konjugate-user-shape-library';

function openUserShapeDatabase() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('This browser cannot keep shapes here (private browsing, or storage turned off).'));
            return;
        }
        const request = indexedDB.open(userShapeDatabaseName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('shapes', { keyPath: 'file' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('The browser could not open its shape storage.'));
    });
}

async function userShapeRequest(mode, action) {
    const database = await openUserShapeDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction('shapes', mode);
        const request = action(transaction.objectStore('shapes'));
        transaction.oncomplete = () => { database.close(); resolve(request?.result); };
        transaction.onerror = transaction.onabort = () => {
            database.close();
            reject(transaction.error ?? new Error('The browser could not store the shape.'));
        };
    });
}

// Kept shapes, or none when the browser will not keep any: the bundled ones must still list.
const uploadedShapes = async () => (await userShapeRequest('readonly', (store) => store.getAll()).catch(() => [])) ?? [];

async function shapeLibraryManifest() {
    const response = await fetch(new URL('../../assets/shapes/manifest.json', import.meta.url));
    const bundled = response.ok ? (await response.json()).shapes.map(normalizeShapeLibraryEntry) : [];
    return [...bundled, ...(await uploadedShapes()).map(({ file }) => uploadedShapeEntry(file))];
}
export const shapeLibrary = {
    list: () => shapeLibraryManifest(),
    load: async (id) => {
        const shape = (await shapeLibraryManifest()).find((candidate) => candidate.id === id);
        if (!shape) throw new Error('That shape is not available.');
        if (shape.source === 'user') {
            const kept = await userShapeRequest('readonly', (store) => store.get(shape.file));
            if (!kept) throw new Error('That shape is not available.');
            return { ...shape, data: new Uint8Array(kept.data) };
        }
        const response = await fetch(new URL(`../../assets/shapes/${shape.file}`, import.meta.url));
        if (!response.ok) throw new Error('That shape is not available.');
        return { ...shape, data: new Uint8Array(await response.arrayBuffer()) };
    },
    saveUpload: async (fileName, data) => {
        const taken = new Set((await uploadedShapes()).map(({ file }) => file));
        const file = uploadedShapeFileName(fileName, (name) => taken.has(name));
        await userShapeRequest('readwrite', (store) => store.put({ file, data: new Uint8Array(data) }));
        return { id: `userUploaded/${file}` };
    }
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
