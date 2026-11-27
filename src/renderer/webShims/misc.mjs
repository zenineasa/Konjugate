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
import { pluginComponentTemplates } from './packages.mjs';
import { isPhoneLayout, onPhoneLayoutChange } from '../phoneLayout.mjs';
import { normalizeShapeLibraryEntry, uploadedShapeEntry, uploadedShapeFileName } from '../../shapeLibraryCatalog.mjs';
import { validateComponentTemplate } from '../../componentTemplate.mjs';
import { createUserLibraryStore } from '../../userLibraryStore.mjs';
import { bugReportUrl, formatBugReportEmail } from '../../bugReport.mjs';
import { welcomeLinks } from '../../welcomeModel.mjs';
import { normalizeOwnershipDefaults } from '../../ownership.mjs';
import { normalizeInputBindings } from '../../inputBindings.mjs';

const minimumUiZoom = 0.75;
const maximumUiZoom = 1.5;
const uiZoomStep = 0.1;
let currentZoom = 1;
function applyZoom(factor) {
    currentZoom = Math.min(maximumUiZoom, Math.max(minimumUiZoom, Math.round(factor * 10) / 10));
    document.documentElement.style.zoom = currentZoom;
    return currentZoom;
}
// Much of the interface is set in 6 to 9 pixel type, which is dense on a desktop and unreadable on a phone, so a phone starts
// enlarged. The same A+ and A- (in the phone menu) still adjust it. What a phone is is src/renderer/phoneLayout.mjs's say. Held on its
// side it has height for little else than the model, so it is enlarged less, and the size follows the phone as it is turned until the
// person has chosen one.
const phoneUiZoom = { portrait: 1.4, landscape: 1.2 };
let zoomChosen = false;
const applyPhoneZoom = () => {
    if (zoomChosen) return;
    if (!isPhoneLayout()) { if (currentZoom !== 1) applyZoom(1); return; }
    applyZoom(phoneUiZoom[window.matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait']);
};
if (window.matchMedia) {
    applyPhoneZoom();
    window.matchMedia('(orientation: landscape)').addEventListener('change', applyPhoneZoom);
    onPhoneLayoutChange(applyPhoneZoom);
}
export const uiZoom = {
    get: () => currentZoom,
    increase: () => { zoomChosen = true; return applyZoom(currentZoom + uiZoomStep); },
    decrease: () => { zoomChosen = true; return applyZoom(currentZoom - uiZoomStep); },
    reset: () => { zoomChosen = false; applyPhoneZoom(); return currentZoom; },
    limits: { minimum: minimumUiZoom, maximum: maximumUiZoom }
};

export const windowControls = {
    minimize: () => {},
    toggleMaximize: () => {},
    close: () => {},
    // A new tab with an empty project: ?new tells it not to bring back the project this browser kept (webShims/projectFiles.mjs's autosave).
    newWindow: () => window.open(`${location.pathname}?new`, '_blank'),
    onMaximizedChange: () => {}
};

// The first-model tour (docs/proposals/guidedTour.md). The web edition has no Welcome window: a first-time visitor is offered the tour on
// the empty canvas, beside the examples (firstSteps below), and it starts whenever the Konjugate button is pressed (what opens the Welcome
// window on the desktop). It never starts by itself.
const tourStarters = [];
const storage = (action) => { try { return action(window.localStorage); } catch { return null; } };
export const tour = {
    onStart: (callback) => { tourStarters.push(callback); },
    recordCompleted: async () => true
};

// The first steps a first-time visitor is offered on the empty canvas (the first-model tutorial, an example). Dismissed, or once a tutorial
// has been started or an example opened, never again in this browser (local storage); "Remind me later" hides them until the web edition is
// next opened, a reload in the same visit included (session storage). Where storage is blocked, only this page's word counts, as for the
// finished tutorials. The desktop has no such card: its Welcome window and Tutorials say the same.
const firstStepsDoneKey = 'konjugate.firstStepsDone';
const firstStepsLaterKey = 'konjugate.firstStepsLater';
const inSession = (action) => { try { return action(window.sessionStorage); } catch { return null; } };
const firstStepsInMemory = { done: false, later: false };
export const firstSteps = {
    offered: async () => {
        // '' when nothing is kept yet; null when the storage is blocked.
        const done = storage((local) => local.getItem(firstStepsDoneKey) ?? '');
        const later = inSession((session) => session.getItem(firstStepsLaterKey) ?? '');
        return !(done === null ? firstStepsInMemory.done : done === '1') && !(later === null ? firstStepsInMemory.later : later === '1');
    },
    done: async () => {
        firstStepsInMemory.done = true;
        storage((local) => local.setItem(firstStepsDoneKey, '1'));
    },
    later: async () => {
        firstStepsInMemory.later = true;
        inSession((session) => session.setItem(firstStepsLaterKey, '1'));
    }
};

// The tutorials (docs/proposals/tutorials.md). Which are finished is kept in this browser's local storage (or, where that is blocked,
// only until the page closes); a tutorial's data file is read, and downloaded, from beside the examples, where the examples themselves are.
const tutorialsCompletedKey = 'konjugate.tutorialsCompleted';
let tutorialsCompletedInMemory = [];
export const tutorials = {
    completed: async () => {
        const stored = storage((local) => JSON.parse(local.getItem(tutorialsCompletedKey) ?? 'null'));
        return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : tutorialsCompletedInMemory;
    },
    recordCompleted: async (id) => {
        const next = [...new Set([...await tutorials.completed(), id])];
        tutorialsCompletedInMemory = next;
        storage((local) => local.setItem(tutorialsCompletedKey, JSON.stringify(next)));
        return true;
    },
    loadData: async (fileName) => {
        const response = await fetch(new URL(`../../examples/${fileName.split('/').map(encodeURIComponent).join('/')}`, import.meta.url));
        if (!response.ok) throw new Error('That file is not part of a tutorial.');
        return response.text();
    },
    // Downloaded as the browser downloads any file: to the Downloads folder, unless the browser is set to ask.
    downloadData: async (fileName) => {
        const text = await tutorials.loadData(fileName);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
        const name = fileName.split('/').at(-1);
        link.download = name;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
        return { path: null, fileName: name };
    },
    // Started from an example's guide, in the guide panel (webShims/guidePanel.mjs) rather than a window of its own.
    onStart: (callback) => { tutorialStarters.push(callback); }
};
const tutorialStarters = [];
export const startTutorialInPage = (id) => tutorialStarters.forEach((start) => start(id));

export const applicationInfo = {
    get: async () => ({ version }),
    openWelcome: async () => { tourStarters.forEach((start) => start()); },
    // As the desktop's: Konjugate's own repository pages only, in a new tab.
    openExternal: async (url) => {
        if (typeof url !== 'string' || !url.startsWith('https://github.com/zenineasa/Konjugate/')) return false;
        window.open(url, '_blank', 'noopener');
        return true;
    }
};

// The defaults for the ownership block of new projects (docs/proposals/modelOwnership.md). In the browser they are kept in its own storage and
// never leave it; storage that is blocked reads as no defaults and changes last only until the page is closed.
const ownershipDefaultsKey = 'konjugate.ownershipDefaults';
let ownershipDefaultsInMemory = {};
export const ownershipDefaults = {
    get: async () => {
        try {
            const text = window.localStorage.getItem(ownershipDefaultsKey);
            return text ? normalizeOwnershipDefaults(JSON.parse(text)) : {};
        } catch {
            return ownershipDefaultsInMemory;
        }
    },
    set: async (defaults) => {
        const kept = normalizeOwnershipDefaults(defaults);
        ownershipDefaultsInMemory = kept;
        try {
            if (Object.keys(kept).length) window.localStorage.setItem(ownershipDefaultsKey, JSON.stringify(kept));
            else window.localStorage.removeItem(ownershipDefaultsKey);
        } catch { /* storage blocked: the defaults hold for this page only */ }
        return kept;
    }
};

// The controller bindings a person keeps (docs/proposals/humanInputBinding.md). In the browser they are kept in its own storage, shared by
// its tabs of the web edition (another tab's change arrives as a storage event); storage that is blocked keeps them for this page only.
const inputBindingsKey = 'konjugate.inputBindings';
let inputBindingsInMemory = normalizeInputBindings(null);
export const inputBindings = {
    get: async () => {
        try {
            const text = window.localStorage.getItem(inputBindingsKey);
            return text ? normalizeInputBindings(JSON.parse(text)) : inputBindingsInMemory;
        } catch {
            return inputBindingsInMemory;
        }
    },
    set: async (document) => {
        const kept = normalizeInputBindings(document);
        inputBindingsInMemory = kept;
        try { window.localStorage.setItem(inputBindingsKey, JSON.stringify(kept)); } catch { /* storage blocked: kept for this page only */ }
        return kept;
    },
    onChanged: (callback) => {
        window.addEventListener('storage', (event) => {
            if (event.key !== inputBindingsKey) return;
            try { callback(normalizeInputBindings(JSON.parse(event.newValue ?? 'null'))); } catch { /* not what was written */ }
        });
    },
    // A page cannot list what the computer has connected without asking the person to choose a device, nor open its settings: the
    // Controllers page says how to connect one instead.
    connectedControllers: async () => null,
    canOpenBluetoothSettings: async () => false,
    openBluetoothSettings: async () => false,
    // A tab reads its controllers while it is the one in use; nothing hands them to it.
    onFollowFocus: () => {}
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
        const own = [...bundled.map((template) => ({ ...template, source: 'bundled' })), ...user.map((template) => ({ ...template, source: 'user' }))];
        // What installed plugins add, after the rest, as on the desktop; one whose id is already taken is skipped there.
        return [...own, ...await pluginComponentTemplates(new Set(own.map((template) => template.id)))];
    },
    saveUser: async (template) => ({ ...await userComponentLibrary.save(template), source: 'user' }),
    updateUser: async (id, changes) => ({ ...await userComponentLibrary.update(id, changes), source: 'user' }),
    moveUserSection: (from, to) => userComponentLibrary.moveSection(from, to),
    removeUser: (id) => userComponentLibrary.remove(id)
};

// Installed packages: webShims/packages.mjs.
export { extensions } from './packages.mjs';

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
    listDraftModels: async () => [],
    saveConfiguration: async () => ({ available: false }),
    removeConfiguration: async () => ({ available: false }),
    setActiveConfiguration: async () => ({ available: false }),
    testDraftConnection: async () => ({ available: false }),
    signIn: async () => ({ ok: false, error: { message: 'Signing in to a provider needs the desktop app.', code: 'signInUnavailable' } }),
    cancelSignIn: async () => false,
    openKeyPage: async () => false,
    detectTools: async () => [],
    generateProposal: async () => {
        throw new Error('AI-assisted authoring is not available in the web edition yet.');
    },
    cancelRequest: async () => {},
    onProgress: () => {}
};

export { addons, launcherHost } from './addons.mjs';
