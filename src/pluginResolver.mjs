/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { access, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { packageKey } from './packageArchive.mjs';
import { PluginResolutionError, pluginIdPattern, pluginVersionPattern, resolveReferencesInDocument } from './pluginReferences.mjs';

export { PluginResolutionError };

function safeRelativePath(value, field) {
    if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.split('/').some((segment) => segment === '..' || segment === '.')) {
        throw new PluginResolutionError(`Plugin ${field} must be a safe relative path.`, 'PLUGIN_MANIFEST_INVALID');
    }
    return value;
}

async function readJson(path, description) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        throw new PluginResolutionError(`Could not read ${description}: ${error.message}`, 'PLUGIN_MANIFEST_INVALID');
    }
}

async function resolvePluginSource(implementation, pluginDirectory, disabledPluginKeys, incompatiblePluginKeys = {}) {
    if (!pluginDirectory) throw new PluginResolutionError('Plugin execution requires an installed plugin directory.', 'PLUGIN_DIRECTORY_MISSING');
    const pluginId = implementation.pluginId;
    const version = implementation.pluginVersion;
    if (typeof pluginId !== 'string' || typeof version !== 'string' || !pluginIdPattern.test(pluginId) || !pluginVersionPattern.test(version)) {
        throw new PluginResolutionError('A plugin implementation requires pluginId and pluginVersion.', 'PLUGIN_REFERENCE_INVALID');
    }
    if (disabledPluginKeys.includes(packageKey('plugin', pluginId, version))) {
        throw new PluginResolutionError(`Plugin ${pluginId} is disabled. Enable it from Extensions before running this model.`, 'PLUGIN_DISABLED');
    }
    // `incompatiblePluginKeys` maps a plugin's key to why this Konjugate cannot run it (docs/proposals/packageCompatibility.md).
    const incompatibility = incompatiblePluginKeys[packageKey('plugin', pluginId, version)];
    if (incompatibility) {
        throw new PluginResolutionError(`Plugin ${pluginId} ${version} ${incompatibility} Update or reinstall it from Extensions before running this model.`, 'PLUGIN_INCOMPATIBLE');
    }
    const pluginRoot = resolve(pluginDirectory, 'plugins', pluginId, version);
    if (!pluginRoot.startsWith(`${resolve(pluginDirectory, 'plugins')}${sep}`)) {
        throw new PluginResolutionError('The plugin reference path is unsafe.', 'PLUGIN_REFERENCE_INVALID');
    }
    const manifest = await readJson(resolve(pluginRoot, 'plugin.json'), `plugin ${pluginId} manifest`);
    if (manifest.pluginId !== pluginId || manifest.version !== version || manifest.apiVersion !== 1) {
        throw new PluginResolutionError('The installed plugin identity or API version does not match the model reference.', 'PLUGIN_REFERENCE_INVALID');
    }
    const contribution = (manifest.contributes ?? []).find((item) => item.providerId === implementation.providerId);
    if (!contribution || !['cpp', 'python'].includes(contribution.runtime) || contribution.apiVersion !== 1) {
        throw new PluginResolutionError(`Plugin ${pluginId} does not provide the requested provider.`, 'PLUGIN_PROVIDER_MISSING');
    }
    const entry = safeRelativePath(contribution.entry, 'entry');
    const sourcePath = resolve(pluginRoot, entry);
    if (!sourcePath.startsWith(`${pluginRoot}${sep}`)) throw new PluginResolutionError('The plugin entry path is unsafe.', 'PLUGIN_MANIFEST_INVALID');
    try {
        await access(sourcePath);
    } catch {
        throw new PluginResolutionError(`Plugin provider entry is missing: ${entry}.`, 'PLUGIN_ENTRY_MISSING');
    }
    return { ...implementation, kind: contribution.runtime, providerApiVersion: contribution.apiVersion, source: sourcePath };
}

export async function resolveInstalledPlugins(content, { pluginDirectory, disabledPluginKeys = [], incompatiblePluginKeys = {} } = {}) {
    return resolveReferencesInDocument(content, (implementation) => resolvePluginSource(implementation, pluginDirectory, disabledPluginKeys, incompatiblePluginKeys));
}
