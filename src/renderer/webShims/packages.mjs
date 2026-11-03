/* Copyright © 2026 Zenin Easa Panthakkalakath */

// window.extensions for the web shell (docs/proposals/webEditionPackages.md, stage 1): installing .kjp plugins from a file, listing,
// enabling, disabling and uninstalling them, kept in the browser (src/webPackageStore.mjs). What a plugin adds that can run here
// reaches the page through pluginComponentTemplates and pluginExamples below, which the component library and the Examples
// window read. Add-ons, and plugins that provide relationship providers, are turned away at install, with the reason.

import { version } from './buildInfo.mjs';
import { reviewPackage } from './packageReview.mjs';
import { createBrowserStorage, createPackageStore } from '../../webPackageStore.mjs';
import { readPackageCompatibilityFacts } from '../../packageInspection.mjs';
import { verifyPackageArchiveAsync } from '../../packageSignature.mjs';
import { fetchMirrorIndex, fetchMirroredImage, fetchMirroredPackages, mirrorUpdates } from '../../webRegistry.mjs';
import { registryVideoUrlPatternForWeb } from '../../webRegistryPaths.mjs';

let opened = null;
// One store for the page, made when first needed, so a page that never touches packages never opens the browser's storage.
export function packageStore() {
    opened ??= createBrowserStorage().then((storage) => createPackageStore({ storage, appVersion: version }));
    return opened;
}

// A file chosen by the person, or null if none is. Called from the click that asked for it, since a browser opens a file chooser only
// then: nothing is awaited before the input is clicked.
function chooseFile() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.kja,.kjp';
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
        input.addEventListener('cancel', () => resolve(null), { once: true });
        input.click();
    });
}

// Said to the page whenever what is installed changes, so that what depends on it (the model's validation, which names a plugin it could
// not find) is looked at again.
const packagesChanged = () => window.dispatchEvent(new Event('konjugate:packages-changed'));

// The registry as this site carries it (webRegistry.mjs), read once per page and again when Discover is asked for afresh.
const mirrorBase = new URL('../../registry/', import.meta.url).href;
let mirrorIndex = null;
const registryIndex = (fresh = false) => {
    if (!mirrorIndex || fresh) mirrorIndex = fetchMirrorIndex({ base: mirrorBase }).catch((error) => { mirrorIndex = null; throw error; });
    return mirrorIndex;
};
// The prefix an entry the Extensions window holds belongs to: the window passes the entry itself, not its name.
async function prefixOf(entry) {
    const { registry } = await registryIndex();
    const found = Object.entries(registry.prefixes).find(([, candidate]) => candidate.downloadUrl === entry?.downloadUrl && candidate.title === entry?.title);
    if (!found) throw new Error('That package is no longer in the registry.');
    return found[0];
}
const toDataUrl = ({ mimeType, bytes }) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes], { type: mimeType }));
});

export const extensions = {
    list: async () => (await packageStore()).list(),
    install: async () => {
        const file = await chooseFile();
        if (!file) return null;
        const lower = file.name.toLowerCase();
        const extension = lower.endsWith('.kja') ? '.kja' : lower.endsWith('.kjp') ? '.kjp' : null;
        if (!extension) throw new Error(lower.endsWith('.fmu') ? 'FMUs run in the desktop app only.' : 'Only .kja add-ons and .kjp plugins can be installed.');
        const store = await packageStore();
        const archive = new Uint8Array(await file.arrayBuffer());
        // Refused before the review if this Konjugate cannot use it, or if the web edition cannot run it (inspect throws or says why).
        const inspected = store.inspect(archive, extension);
        if (inspected.refusal) throw new Error(inspected.refusal);
        if (!await reviewPackage(inspected)) return null;
        const installed = await store.install(archive, extension);
        // The browser may clear a site's storage under pressure unless asked not to; asked once there is something to lose.
        navigator.storage?.persist?.().catch(() => {});
        const { packageType, packageId, version: installedVersion } = installed.packageManifest;
        packagesChanged();
        return { packageType, packageId, version: installedVersion };
    },
    uninstall: async (packageType, packageId, packageVersion) => {
        await (await packageStore()).uninstall(packageType, packageId, packageVersion);
        packagesChanged();
        return { packageType, packageId, version: packageVersion };
    },
    setEnabled: async (packageType, packageId, packageVersion, enabled) => {
        await (await packageStore()).setEnabled(packageType, packageId, packageVersion, enabled);
        packagesChanged();
        return { packageType, packageId, version: packageVersion, enabled };
    },
    // No FMU is ever installed in the web edition.
    fmuPorts: async () => ({ error: 'FMUs run in the desktop app only.' }),
    // Nothing is restarted for in the web edition: an installed package is in effect at once.
    restartPending: async () => false,
    onRestartPendingChange: () => {},
    // Discover and install read the registry mirrored on this site (stage 4 of the proposal).
    discoverRegistry: async () => {
        const { registry, stale } = await registryIndex(true);
        return { registry, stale };
    },
    // Each package of the entry is downloaded from the mirror, checked against the size and hash the mirror recorded, checked against its
    // publisher's key, and shown in the review with what that check found, as the review of a file is; one the person declines is left.
    installFromRegistry: async (entry) => {
        const index = await registryIndex();
        const store = await packageStore();
        const results = [];
        for (const { bytes } of await fetchMirroredPackages(await prefixOf(entry), index, { base: mirrorBase })) {
            const extension = packageExtension(bytes);
            const inspected = store.inspect(bytes, extension);
            if (inspected.refusal) throw new Error(inspected.refusal);
            const verification = await verifyPackageArchiveAsync(bytes, { namespaces: index.registry });
            if (!await reviewPackage({ ...inspected, verification })) continue;
            const installed = await store.install(bytes, extension);
            const { packageType, packageId, version: installedVersion } = installed.packageManifest;
            results.push({ packageType, packageId, version: installedVersion, verification });
        }
        if (results.length) {
            navigator.storage?.persist?.().catch(() => {});
            packagesChanged();
        }
        return results;
    },
    registryImage: async (prefix) => {
        const entry = (await registryIndex()).registry.prefixes[prefix];
        const image = entry && await fetchMirroredImage(entry, null, { base: mirrorBase });
        return image ? toDataUrl(image) : null;
    },
    registryScreenshot: async (prefix, screenshotIndex) => {
        const entry = (await registryIndex()).registry.prefixes[prefix];
        const image = entry && Number.isInteger(screenshotIndex) ? await fetchMirroredImage(entry, screenshotIndex, { base: mirrorBase }) : null;
        return image ? toDataUrl(image) : null;
    },
    // The person's own browser opens a video the entry names, only if it is one of the two YouTube forms the registry allows.
    openRegistryVideo: async (prefix, videoIndex) => {
        const url = (await registryIndex()).registry.prefixes[prefix]?.videos?.[videoIndex]?.url;
        if (typeof url !== 'string' || !registryVideoUrlPatternForWeb.test(url)) return false;
        window.open(url, '_blank', 'noopener,noreferrer');
        return true;
    },
    // A link a publisher wrote is opened only after the person has seen it, as on the desktop.
    openRegistryLink: async (url) => {
        if (typeof url !== 'string' || !url.startsWith('https://')) return false;
        if (!window.confirm(`Open this link in a new tab?\n\n${url}\n\nThis comes from a third-party registry listing, not from Konjugate itself.`)) return false;
        window.open(url, '_blank', 'noopener,noreferrer');
        return true;
    },
    // Against the mirror, one small file, so it costs no request quota and is cheap to ask whenever the window opens.
    checkUpdates: async ({ force = false } = {}) => {
        try {
            return mirrorUpdates(await registryIndex(force), await (await packageStore()).list());
        } catch {
            return [];
        }
    }
};

// A package's own manifest says whether it is an add-on or a plugin, so a file taken from the mirror needs no extension chosen by the person.
function packageExtension(bytes) {
    return readPackageCompatibilityFacts(bytes).packageManifest.packageType === 'addon' ? '.kja' : '.kjp';
}

// A model with each reference to an installed plugin's provider replaced by the provider's source, for the engine (the desktop does this
// in src/pluginResolver.mjs). A model that names no plugin is passed on untouched and the browser's storage is not opened for it. Throws
// PluginResolutionError, whose message says what to do, when a plugin is missing, disabled or cannot run here.
export async function resolvePluginReferences(content) {
    if (typeof content === 'string' && !/"kind"\s*:\s*"plugin"/.test(content)) return content;
    return (await packageStore()).resolveModel(content);
}

// What the enabled plugins add to the component library, given the ids already taken by the bundled and the person's own templates.
export async function pluginComponentTemplates(takenIds) {
    return (await packageStore()).pluginComponentTemplates(takenIds);
}

// The page's Content-Security-Policy allows images from data: and not from blob:, so an example's thumbnail is carried as a data URL.
function dataUrl(bytes, type) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return `data:${type};base64,${btoa(binary)}`;
}

const objectUrls = new Map();
const objectUrlFor = (key, bytes, type) => {
    if (!objectUrls.has(key)) objectUrls.set(key, URL.createObjectURL(new Blob([bytes], { type })));
    return objectUrls.get(key);
};

// The example models the enabled plugins add, in the shape projectListExamples returns on the desktop. `takenIds` are the bundled ones.
export async function pluginExampleEntries(takenIds) {
    const store = await packageStore();
    const entries = [];
    for (const example of (await store.pluginExamples(takenIds)).values()) {
        const thumbnail = example.thumbnail ? await store.readFile(example.packageEntry, example.thumbnail) : null;
        entries.push({
            id: example.id, label: example.name, suggestedFilename: example.id, domains: example.domains, description: example.description,
            thumbnailUrl: thumbnail ? dataUrl(thumbnail, /\.jpe?g$/i.test(example.thumbnail) ? 'image/jpeg' : /\.webp$/i.test(example.thumbnail) ? 'image/webp' : 'image/png') : null,
            source: { pluginId: example.pluginId, pluginVersion: example.pluginVersion }
        });
    }
    return entries;
}

// A plugin example's project file, or null when `id` is not one.
export async function pluginExampleBytes(id, takenIds) {
    const store = await packageStore();
    const example = (await store.pluginExamples(takenIds)).get(id);
    return example ? store.readFile(example.packageEntry, example.entry) : null;
}

// The address of a plugin example's guide, or null when it has none.
export async function pluginExampleGuideUrl(id, takenIds) {
    const store = await packageStore();
    const example = (await store.pluginExamples(takenIds)).get(id);
    if (!example?.guide) return null;
    const bytes = await store.readFile(example.packageEntry, example.guide);
    return bytes ? objectUrlFor(`${example.pluginId}@${example.pluginVersion}:${example.guide}`, bytes, 'text/plain;charset=utf-8') : null;
}
