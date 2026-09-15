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

import { version } from './buildInfo.mjs';
import { normalizeShapeLibraryEntry } from '../../shapeLibraryCatalog.mjs';

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

export const componentLibrary = {
    list: async () => {
        const response = await fetch(new URL('../../assets/componentLibrary/webManifest.json', import.meta.url));
        if (!response.ok) return [];
        return response.json();
    }
};

export const extensions = {
    list: async () => [],
    install: async () => ({ available: false }),
    uninstall: async () => ({ available: false }),
    setEnabled: async () => ({ available: false })
};

// providerEditor lives in its own file (providerEditor.mjs) -- it needs a real <dialog>, unlike
// everything else here.

// Python's toolchain is Pyodide, bundled with the app -- there's no interpreter path to locate,
// override, or browse to (see docs/proposals/webEdition.md, phase 4). C++'s toolchain UI stays
// honestly unavailable (phase 5's concern: a WASM-hosted C++ compiler, not attempted yet).
export const providerToolchains = {
    get: async (kind) => kind === 'python' ? { available: true, path: 'Pyodide (bundled)', detectedPath: 'Pyodide (bundled)' } : { available: false },
    set: async () => ({ available: false }),
    test: async (kind) => kind === 'python' ? { available: true } : { available: false },
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
    cancelRequest: async () => {}
};

export const addons = {
    listToolstripContributions: async () => [],
    invokeCommand: async () => ({ available: false }),
    publishEvent: () => {},
    closeContext: () => {},
    onRequest: () => {}
};
