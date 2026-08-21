/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveInstalledPlugins, PluginResolutionError } from '../src/pluginResolver.mjs';

const pluginManifest = {
    pluginId: 'example.helloProvider', name: 'Hello World Provider', version: '0.1.0', apiVersion: 1,
    contributes: [{ providerId: 'example.helloWorld', apiVersion: 1, runtime: 'python', entry: 'helloWorld.py' }]
};

async function installFixture(root) {
    const directory = join(root, 'plugins', pluginManifest.pluginId, pluginManifest.version);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'plugin.json'), JSON.stringify(pluginManifest));
    await writeFile(join(directory, 'helloWorld.py'), 'provider source');
    return directory;
}

const model = {
    format: 'konjugate', version: 1,
    nodes: [{ id: 1, sourceTerms: [{ id: 2, implementation: {
        kind: 'plugin', pluginId: 'example.helloProvider', pluginVersion: '0.1.0', providerId: 'example.helloWorld'
    } }] }],
    edges: []
};

test('resolves a version-pinned installed plugin to the provider runtime contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'konjugate-plugin-'));
    try {
        await installFixture(root);
        const resolved = JSON.parse(await resolveInstalledPlugins(model, { pluginDirectory: root }));
        assert.equal(resolved.nodes[0].sourceTerms[0].implementation.kind, 'python');
        assert.equal(resolved.nodes[0].sourceTerms[0].implementation.source, join(root, 'plugins', 'example.helloProvider', '0.1.0', 'helloWorld.py'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('rejects a plugin reference whose package key is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'konjugate-plugin-'));
    try {
        await installFixture(root);
        await assert.rejects(
            resolveInstalledPlugins(model, { pluginDirectory: root, disabledPluginKeys: ['plugin:example.helloProvider:0.1.0'] }),
            (error) => error instanceof PluginResolutionError && error.code === 'PLUGIN_DISABLED'
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('leaves models without plugin references unchanged', async () => {
    const content = JSON.stringify({ ...model, nodes: [], edges: [] });
    assert.equal(await resolveInstalledPlugins(content, { pluginDirectory: '/unused' }), content);
});

test('rejects an uninstalled or version-mismatched plugin', async () => {
    await assert.rejects(
        resolveInstalledPlugins(model, { pluginDirectory: '/missing' }),
        (error) => error instanceof PluginResolutionError && error.code === 'PLUGIN_MANIFEST_INVALID'
    );
});

test('rejects path-shaped plugin references', async () => {
    const unsafe = structuredClone(model);
    unsafe.nodes[0].sourceTerms[0].implementation.pluginId = '../outside';
    await assert.rejects(
        resolveInstalledPlugins(unsafe, { pluginDirectory: '/unused' }),
        (error) => error instanceof PluginResolutionError && error.code === 'PLUGIN_REFERENCE_INVALID'
    );
});

test('rejects a plugin provider with a missing entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'konjugate-plugin-'));
    try {
        await installFixture(root);
        await writeFile(join(root, 'plugins', pluginManifest.pluginId, pluginManifest.version, 'plugin.json'), JSON.stringify({
            ...pluginManifest, contributes: [{ ...pluginManifest.contributes[0], entry: 'missing.py' }]
        }));
        await assert.rejects(
            resolveInstalledPlugins(model, { pluginDirectory: root }),
            (error) => error instanceof PluginResolutionError && error.code === 'PLUGIN_ENTRY_MISSING'
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
