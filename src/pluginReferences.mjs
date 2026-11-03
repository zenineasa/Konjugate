/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Where a model names an installed plugin's provider (`implementation.kind: "plugin"`, docs/projectSchema.md), without a disk: finding
// those references in a model, resolving each through a function the host supplies (the desktop reads the plugin's directory, the web
// edition its browser storage), and saying which plugins a model needs that are not available. pluginResolver.mjs (desktop) and
// webPackageStore.mjs (web) are the two hosts, so a reference means the same thing in both.

import { packageKey } from './packageInspection.mjs';

export class PluginResolutionError extends Error {
    constructor(message, code = 'PLUGIN_RESOLUTION_FAILED') {
        super(message);
        this.name = 'PluginResolutionError';
        this.code = code;
    }
}

export const pluginIdPattern = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
export const pluginVersionPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

// Every implementation in a model that may name a plugin: those of nodes' source terms and of edges.
function* implementationsOf(document) {
    for (const node of document.nodes ?? []) for (const term of node.sourceTerms ?? []) yield [term, term.implementation];
    for (const edge of document.edges ?? []) yield [edge, edge.implementation];
}

export const isPluginReference = (implementation) => implementation?.kind === 'plugin';

// Replaces each plugin reference in `content` (JSON text or an object) with what `resolveImplementation(reference)` returns, awaiting
// them in turn. Returns the model as JSON text, and the text unchanged when it holds no reference.
export async function resolveReferencesInDocument(content, resolveImplementation) {
    const document = typeof content === 'string' ? JSON.parse(content) : structuredClone(content);
    let changed = false;
    for (const [owner, implementation] of implementationsOf(document)) {
        if (!isPluginReference(implementation)) continue;
        changed = true;
        owner.implementation = await resolveImplementation(implementation);
    }
    return changed ? JSON.stringify(document) : (typeof content === 'string' ? content : JSON.stringify(document));
}

// The plugins a model names: [{ pluginId, pluginVersion, providerIds }], one per plugin and version.
export function pluginReferencesIn(document) {
    const found = new Map();
    for (const [, implementation] of implementationsOf(document)) {
        if (!isPluginReference(implementation)) continue;
        const key = packageKey('plugin', implementation.pluginId, implementation.pluginVersion);
        const entry = found.get(key) ?? { pluginId: implementation.pluginId, pluginVersion: implementation.pluginVersion, providerIds: [] };
        if (implementation.providerId && !entry.providerIds.includes(implementation.providerId)) entry.providerIds.push(implementation.providerId);
        found.set(key, entry);
    }
    return [...found.values()];
}

// Of the plugins a model names, those that cannot be used here, and why: `installed` is the Extensions list. `reason` is
// 'not-installed', 'other-version' (the plugin is installed, but not the version the model pins; `installedVersions` says which),
// 'disabled', or 'incompatible'.
export function missingPluginReferences(document, installed) {
    const plugins = installed.filter((entry) => entry.packageType === 'plugin');
    const missing = [];
    for (const reference of pluginReferencesIn(document)) {
        const sameVersion = plugins.find((entry) => entry.packageId === reference.pluginId && entry.version === reference.pluginVersion);
        if (sameVersion?.incompatible) missing.push({ ...reference, reason: 'incompatible' });
        else if (sameVersion && sameVersion.enabled === false) missing.push({ ...reference, reason: 'disabled' });
        else if (!sameVersion) {
            const installedVersions = plugins.filter((entry) => entry.packageId === reference.pluginId).map((entry) => entry.version);
            missing.push({ ...reference, reason: installedVersions.length ? 'other-version' : 'not-installed', installedVersions });
        }
    }
    return missing;
}
