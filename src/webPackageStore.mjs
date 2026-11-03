/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Installed add-ons and plugins in the web edition (docs/proposals/webEditionPackages.md, stage 1). The desktop keeps packages
// under <userData>/packages and reads them with node:fs; a browser has no such directory, so the same layout
// (packages/<type>s/<id>/<version>/<files>) is kept in the browser's private file system (OPFS), or in IndexedDB where a browser
// cannot write files to it, behind the small `storage` interface below. All the rules (what a package may contain, whether it
// suits this Konjugate, which of its parts can run here) live in packageInspection.mjs and here, with no storage in them, so
// they are the same under test as in a browser.
//
// storage: { read(path) -> Uint8Array | null, write(path, bytes), list(directory) -> [{ name, directory }], remove(path) }
// with '/'-separated paths from the storage's own root; remove takes a file or a whole directory and does nothing for a missing path.

import { strFromU8, strToU8 } from 'fflate';
import { validateComponentTemplate } from './componentTemplate.mjs';
import { PluginResolutionError, pluginIdPattern, pluginVersionPattern, resolveReferencesInDocument } from './pluginReferences.mjs';
import { webAddonRefusal, maximumSettingsBytes } from './webAddonBridge.mjs';
import { inspectPackageArchive, packageCompatibility, PackageArchiveError, packageKey, safeArchivePath, validatePackageManifest } from './packageInspection.mjs';

const packagesRoot = 'packages';
const statePath = `${packagesRoot}/state.json`;
const settingsPath = (addonId) => `addonSettings/${String(addonId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)}.json`;

// The provider runtimes the web edition can run from an installed plugin. Python runs in Pyodide, which the page already loads for a
// provider typed into the editor. C++ needs a compiler the default build does not have, so a plugin's C++ providers are kept but not
// offered (and the threads build's compiler is not yet wired to plugins).
export const webProviderRuntimes = ['python'];

const isProvider = (contribution) => contribution.kind !== 'component' && contribution.kind !== 'example';

// What the web edition cannot run of a package, said plainly, or null when some of it can run. A package is refused only when none of
// it can: a plugin with Python providers and C++ ones installs for the first (see webPackageNotes for what the review says of the rest).
export function webPackageRefusal(packageManifest, contributionManifest) {
    if (packageManifest.packageType === 'addon') return webAddonRefusal(contributionManifest);
    const contributions = contributionManifest.contributes ?? [];
    const usable = contributions.some((item) => !isProvider(item) || webProviderRuntimes.includes(item.runtime));
    if (contributions.length && !usable) {
        const runtimes = [...new Set(contributions.filter(isProvider).map((item) => (item.runtime === 'cpp' ? 'C++' : item.runtime)))].join(' and ');
        return `This plugin provides relationship providers (${runtimes}), which the web edition cannot run yet. They work in the desktop app.`;
    }
    return null;
}

// What of an installable package will not be available here, for the review to say: [] when all of it will.
export function webPackageNotes(contributionManifest) {
    // An add-on's `contributes` is an object (its toolstrip), a plugin's a list.
    const skipped = (Array.isArray(contributionManifest.contributes) ? contributionManifest.contributes : []).filter((item) => isProvider(item) && !webProviderRuntimes.includes(item.runtime));
    if (!skipped.length) return [];
    return [`${skipped.length} of its providers (${[...new Set(skipped.map((item) => (item.runtime === 'cpp' ? 'C++' : item.runtime)))].join(', ')}) cannot run in the web edition and will not be offered here.`];
}

export function createMemoryStorage() {
    const files = new Map();
    return {
        async read(path) { return files.get(path) ?? null; },
        async write(path, bytes) { files.set(path, new Uint8Array(bytes)); },
        async list(directory) {
            const prefix = directory ? `${directory}/` : '';
            const found = new Map();
            for (const path of files.keys()) {
                if (!path.startsWith(prefix)) continue;
                const [name, ...rest] = path.slice(prefix.length).split('/');
                found.set(name, rest.length > 0);
            }
            return [...found].map(([name, isDirectory]) => ({ name, directory: isDirectory }));
        },
        async remove(path) {
            for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
        }
    };
}

// OPFS. A browser that cannot write a file through it from the page (older Safari) gets IndexedDB instead (createBrowserStorage).
export function createOpfsStorage(rootName = 'konjugate') {
    const root = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(rootName, { create: true });
    const directory = async (path, create) => {
        let handle = await root();
        for (const part of path.split('/').filter(Boolean)) handle = await handle.getDirectoryHandle(part, { create });
        return handle;
    };
    const missing = (error) => error?.name === 'NotFoundError' || error?.name === 'TypeMismatchError';
    const split = (path) => {
        const parts = path.split('/');
        return [parts.slice(0, -1).join('/'), parts.at(-1)];
    };
    return {
        async read(path) {
            const [parent, name] = split(path);
            try {
                const file = await (await directory(parent, false)).getFileHandle(name);
                return new Uint8Array(await (await file.getFile()).arrayBuffer());
            } catch (error) {
                if (missing(error)) return null;
                throw error;
            }
        },
        async write(path, bytes) {
            const [parent, name] = split(path);
            const file = await (await directory(parent, true)).getFileHandle(name, { create: true });
            const writable = await file.createWritable();
            await writable.write(bytes);
            await writable.close();
        },
        async list(path) {
            try {
                const found = [];
                for await (const [name, handle] of (await directory(path, false)).entries()) found.push({ name, directory: handle.kind === 'directory' });
                return found;
            } catch (error) {
                if (missing(error)) return [];
                throw error;
            }
        },
        async remove(path) {
            const [parent, name] = split(path);
            try {
                await (await directory(parent, false)).removeEntry(name, { recursive: true });
            } catch (error) {
                if (!missing(error)) throw error;
            }
        }
    };
}

// IndexedDB: one object store keyed by path. For a browser with no OPFS, or whose OPFS cannot be written to from the page.
export function createIndexedDbStorage(databaseName = 'konjugate-packages') {
    let opened = null;
    const database = () => {
        opened ??= new Promise((resolve, reject) => {
            const request = indexedDB.open(databaseName, 1);
            request.onupgradeneeded = () => request.result.createObjectStore('files');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return opened;
    };
    const run = async (mode, action) => {
        const store = (await database()).transaction('files', mode).objectStore('files');
        return new Promise((resolve, reject) => {
            const request = action(store);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    };
    const keysUnder = (prefix) => run('readonly', (store) => store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)));
    return {
        async read(path) {
            const value = await run('readonly', (store) => store.get(path));
            return value ? new Uint8Array(value) : null;
        },
        async write(path, bytes) { await run('readwrite', (store) => store.put(new Uint8Array(bytes).buffer, path)); },
        async list(directory) {
            const prefix = directory ? `${directory}/` : '';
            const found = new Map();
            for (const key of await keysUnder(prefix)) {
                const [name, ...rest] = key.slice(prefix.length).split('/');
                found.set(name, rest.length > 0);
            }
            return [...found].map(([name, isDirectory]) => ({ name, directory: isDirectory }));
        },
        async remove(path) {
            await run('readwrite', (store) => store.delete(path));
            for (const key of await keysUnder(`${path}/`)) await run('readwrite', (store) => store.delete(key));
        }
    };
}

export async function createBrowserStorage() {
    const opfs = Boolean(navigator.storage?.getDirectory) && typeof globalThis.FileSystemFileHandle?.prototype?.createWritable === 'function';
    return opfs ? createOpfsStorage() : createIndexedDbStorage();
}

const json = (bytes) => JSON.parse(strFromU8(bytes));

export function createPackageStore({ storage, appVersion }) {
    const directoryOf = (packageType, packageId, version) => `${packagesRoot}/${packageType}s/${packageId}/${version}`;

    async function disabledKeys() {
        try {
            const bytes = await storage.read(statePath);
            return bytes ? (json(bytes).disabled ?? []) : [];
        } catch {
            return [];
        }
    }
    const saveDisabledKeys = (keys) => storage.write(statePath, strToU8(JSON.stringify({ disabled: keys })));

    // What the review shows before anything is written: the archive judged as the desktop judges it, and what the web edition says
    // of it. Throws PackageArchiveError for a broken or incompatible archive.
    function inspect(archive, extension) {
        const inspected = inspectPackageArchive(archive, { extension, appVersion });
        return { ...inspected, refusal: webPackageRefusal(inspected.packageManifest, inspected.contributionManifest), notes: webPackageNotes(inspected.contributionManifest) };
    }

    async function exists(packageType, packageId, version) {
        return Boolean(await storage.read(`${directoryOf(packageType, packageId, version)}/package.json`));
    }

    async function install(archive, extension) {
        const inspected = inspect(archive, extension);
        if (inspected.refusal) throw new PackageArchiveError(inspected.refusal, 'UNSUPPORTED_IN_WEB');
        const { packageManifest, files } = inspected;
        const { packageType, packageId, version } = packageManifest;
        if (await exists(packageType, packageId, version)) throw new PackageArchiveError('That package version is already installed.', 'ALREADY_INSTALLED');
        const target = directoryOf(packageType, packageId, version);
        // A copy that an earlier attempt left half written has no package.json (written last, below) and is cleared first.
        await storage.remove(target);
        try {
            const names = Object.keys(files).filter((name) => name !== 'package.json');
            for (const name of names) await storage.write(`${target}/${safeArchivePath(name)}`, files[name]);
            await storage.write(`${target}/package.json`, files['package.json']);
        } catch (error) {
            await storage.remove(target);
            if (error instanceof PackageArchiveError) throw error;
            throw new PackageArchiveError(`The package could not be installed: ${error.message}`, 'INSTALL_FAILED');
        }
        // Only now, with the new version whole, are the older ones removed, as on the desktop.
        for (const sibling of await storage.list(`${packagesRoot}/${packageType}s/${packageId}`)) {
            if (sibling.name !== version) await storage.remove(`${packagesRoot}/${packageType}s/${packageId}/${sibling.name}`);
        }
        return { ...inspected, installPath: target };
    }

    // The shape the Extensions window already reads (see packageList in src/main.mjs), plus `enabled` and, for one this Konjugate
    // cannot run, `incompatible`.
    async function list() {
        const disabled = await disabledKeys();
        const entries = [];
        for (const packageType of ['addon', 'plugin']) {
            for (const idEntry of await storage.list(`${packagesRoot}/${packageType}s`)) {
                if (!idEntry.directory) continue;
                for (const versionEntry of await storage.list(`${packagesRoot}/${packageType}s/${idEntry.name}`)) {
                    const installPath = directoryOf(packageType, idEntry.name, versionEntry.name);
                    try {
                        const packageBytes = await storage.read(`${installPath}/package.json`);
                        if (!packageBytes) continue;
                        const packageManifest = validatePackageManifest(json(packageBytes));
                        const manifest = json(await storage.read(`${installPath}/${packageManifest.contents.manifest}`));
                        const key = packageKey(packageType, packageManifest.packageId, packageManifest.version);
                        const verdict = packageCompatibility(packageManifest, appVersion);
                        entries.push({
                            packageType, packageId: packageManifest.packageId, name: packageManifest.name, version: packageManifest.version,
                            source: 'installed', minimumKonjugateVersion: packageManifest.minimumKonjugateVersion ?? null,
                            permissions: manifest.permissions ?? [], manifest, installPath, runnableRuntimes: webProviderRuntimes,
                            enabled: verdict.compatible && !disabled.includes(key),
                            ...(verdict.compatible ? {} : { incompatible: { required: verdict.required, running: verdict.running } })
                        });
                    } catch (error) {
                        console.warn(`Skipping installed package ${idEntry.name}/${versionEntry.name}: ${error.message}`);
                    }
                }
            }
        }
        return entries;
    }

    async function uninstall(packageType, packageId, version) {
        if (!await exists(packageType, packageId, version)) throw new PackageArchiveError('That package version is not installed.', 'NOT_INSTALLED');
        await storage.remove(directoryOf(packageType, packageId, version));
        // An add-on's settings are kept across updates and go with its last installed version, as on the desktop.
        if (packageType === 'addon' && !(await storage.list(`${packagesRoot}/addons/${packageId}`)).length) await storage.remove(settingsPath(packageId));
        await saveDisabledKeys((await disabledKeys()).filter((key) => key !== packageKey(packageType, packageId, version)));
    }

    async function setEnabled(packageType, packageId, version, enabled) {
        const key = packageKey(packageType, packageId, version);
        const others = (await disabledKeys()).filter((candidate) => candidate !== key);
        await saveDisabledKeys(enabled ? others : [...others, key]);
    }

    // A result visualizer's own settings (the settings.store permission), kept for the person across projects: any JSON value, or null.
    async function getAddonSettings(addonId) {
        try {
            const bytes = await storage.read(settingsPath(addonId));
            return bytes ? (json(bytes).settings ?? null) : null;
        } catch {
            return null;
        }
    }
    async function setAddonSettings(addonId, settings) {
        if (settings === null || settings === undefined) return storage.remove(settingsPath(addonId));
        const text = JSON.stringify({ version: 1, settings });
        if (text.length > maximumSettingsBytes) throw new PackageArchiveError(`An add-on's settings may be at most ${maximumSettingsBytes / 1024} KB.`, 'SETTINGS_TOO_LARGE');
        return storage.write(settingsPath(addonId), strToU8(text));
    }

    // The installed, enabled add-ons (result visualizers and launchers) that the web edition can run, as list() entries. One it cannot
    // run (installed by an older build) is left out.
    async function runnableAddons() {
        return (await list()).filter((item) => item.packageType === 'addon' && item.enabled && !webAddonRefusal(item.manifest));
    }

    async function readFile(entry, path) {
        return storage.read(`${entry.installPath}/${safeArchivePath(path)}`);
    }

    // What the enabled plugins add to the component library: [{ ...template, source: 'plugin', pluginId, pluginVersion }]. A template
    // that is invalid, or whose id repeats one already taken (`takenIds`, and each other), is skipped with a warning and the rest
    // still load, as on the desktop.
    async function pluginComponentTemplates(takenIds = new Set()) {
        const found = [];
        const taken = new Set(takenIds);
        for (const entry of (await list()).filter((item) => item.packageType === 'plugin' && item.enabled)) {
            for (const contribution of (entry.manifest.contributes ?? []).filter((item) => item.kind === 'component')) {
                try {
                    const template = validateComponentTemplate(json(await readFile(entry, contribution.entry)));
                    if (template.id !== contribution.componentId) throw new Error(`Component ID mismatch: ${contribution.componentId}.`);
                    if (taken.has(template.id)) throw new Error(`Duplicate template ID: ${template.id}.`);
                    taken.add(template.id);
                    found.push({ ...template, source: 'plugin', pluginId: entry.packageId, pluginVersion: entry.version });
                } catch (error) {
                    console.warn(`Skipping component ${contribution.componentId} from ${entry.packageId} ${entry.version}: ${error.message}`);
                }
            }
        }
        return found;
    }

    // The example models the enabled plugins add, keyed by the "<id>.kjt" name the bundled examples use: Map(id -> { id, name, domains,
    // description, entry, guide, thumbnail, pluginId, pluginVersion, packageEntry }). An id that repeats a bundled one (`takenIds`) or
    // another plugin's is skipped.
    async function pluginExamples(takenIds = new Set()) {
        const found = new Map();
        for (const entry of (await list()).filter((item) => item.packageType === 'plugin' && item.enabled)) {
            for (const contribution of (entry.manifest.contributes ?? []).filter((item) => item.kind === 'example')) {
                const id = `${contribution.exampleId}.kjt`;
                if (takenIds.has(id) || found.has(id)) {
                    console.warn(`Skipping example ${contribution.exampleId} from ${entry.packageId} ${entry.version}: duplicate example ID.`);
                    continue;
                }
                found.set(id, {
                    id, name: contribution.name, domains: contribution.domains ?? [], description: contribution.description ?? '',
                    entry: contribution.entry, guide: contribution.guide ?? null, thumbnail: contribution.thumbnail ?? null,
                    pluginId: entry.packageId, pluginVersion: entry.version, packageEntry: entry
                });
            }
        }
        return found;
    }

    // A model's reference to an installed plugin's provider, as the engine takes it: `kind` and the provider's source text inline (the
    // web engine passes source to Pyodide itself; there is no path to give it). Throws PluginResolutionError, in the desktop's words
    // and with its codes, for a plugin that is missing, disabled, for a newer Konjugate, lacks the provider, or provides it in a
    // runtime the web edition cannot run.
    async function resolveProvider(implementation) {
        const { pluginId, pluginVersion: pluginVersionOfReference, providerId } = implementation;
        if (typeof pluginId !== 'string' || typeof pluginVersionOfReference !== 'string' || !pluginIdPattern.test(pluginId) || !pluginVersionPattern.test(pluginVersionOfReference)) {
            throw new PluginResolutionError('A plugin implementation requires pluginId and pluginVersion.', 'PLUGIN_REFERENCE_INVALID');
        }
        const entry = (await list()).find((item) => item.packageType === 'plugin' && item.packageId === pluginId && item.version === pluginVersionOfReference);
        if (!entry) {
            throw new PluginResolutionError(`Plugin ${pluginId} ${pluginVersionOfReference} is not installed. Install it from Extensions before running this model.`, 'PLUGIN_NOT_INSTALLED');
        }
        if (entry.incompatible) {
            throw new PluginResolutionError(`Plugin ${pluginId} ${pluginVersionOfReference} needs Konjugate ${entry.incompatible.required} or later; this is Konjugate ${entry.incompatible.running}. Update or reinstall it from Extensions before running this model.`, 'PLUGIN_INCOMPATIBLE');
        }
        if (!entry.enabled) {
            throw new PluginResolutionError(`Plugin ${pluginId} is disabled. Enable it from Extensions before running this model.`, 'PLUGIN_DISABLED');
        }
        const contribution = (entry.manifest.contributes ?? []).find((item) => isProvider(item) && item.providerId === providerId);
        if (!contribution || contribution.apiVersion !== 1) {
            throw new PluginResolutionError(`Plugin ${pluginId} does not provide the requested provider.`, 'PLUGIN_PROVIDER_MISSING');
        }
        if (!webProviderRuntimes.includes(contribution.runtime)) {
            throw new PluginResolutionError(`Plugin ${pluginId} provides ${providerId} as ${contribution.runtime === 'cpp' ? 'C++' : contribution.runtime}, which the web edition cannot run yet. Run this model in the desktop app.`, 'PLUGIN_RUNTIME_UNSUPPORTED');
        }
        const bytes = await readFile(entry, contribution.entry);
        if (!bytes) throw new PluginResolutionError(`Plugin provider entry is missing: ${contribution.entry}.`, 'PLUGIN_ENTRY_MISSING');
        return { ...implementation, kind: contribution.runtime, providerApiVersion: contribution.apiVersion, source: strFromU8(bytes) };
    }

    // A model (JSON text or an object) with every plugin reference in it resolved: JSON text, the input itself when it names none.
    const resolveModel = (content) => resolveReferencesInDocument(content, resolveProvider);

    return { inspect, install, list, uninstall, setEnabled, readFile, runnableAddons, getAddonSettings, setAddonSettings, pluginComponentTemplates, pluginExamples, resolveProvider, resolveModel };
}
