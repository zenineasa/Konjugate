/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { validateAddonManifest } from '../src/addonHost.mjs';
import {
    createPackageArchive,
    inspectPackageArchive,
    installPackageArchive,
    PackageArchiveError
} from '../src/packageArchive.mjs';

const addonManifest = {
    addonId: 'example.helloWorld',
    name: 'Hello World',
    version: '0.1.0',
    apiVersion: 1,
    kind: 'resultVisualizer',
    entry: 'index.html',
    permissions: ['results.read'],
    contributes: {
        toolstrip: [{
            commandId: 'openHelloWorld', label: 'Hello', tooltip: 'Open Hello World', symbol: 'H',
            when: 'resultsActive', contexts: ['resultSession']
        }]
    }
};

function packageManifest(packageType = 'addon', version = '0.1.0') {
    return {
        format: 'konjugate-package', formatVersion: 1, packageType,
        packageId: packageType === 'addon' ? 'example.helloWorld' : 'example.helloProvider',
        name: packageType === 'addon' ? 'Hello World' : 'Hello Provider', version,
        contents: { manifest: packageType === 'addon' ? 'addon.json' : 'plugin.json' }
    };
}

function addonArchive(overrides = {}, files = {}) {
    return createPackageArchive({
        packageManifest: { ...packageManifest(), ...overrides },
        contributionManifest: addonManifest,
        files: { 'index.html': '<!doctype html>', ...files }
    });
}

test('creates and inspects a valid .kja archive', () => {
    const result = inspectPackageArchive(addonArchive(), { extension: '.kja' });
    assert.equal(result.packageManifest.packageId, 'example.helloWorld');
    assert.equal(result.contributionManifest.addonId, 'example.helloWorld');
    assert.equal(new TextDecoder().decode(result.files['index.html']), '<!doctype html>');
});

test('creates and inspects a valid .kjp plugin archive', () => {
    const manifest = packageManifest('plugin');
    const contribution = {
        pluginId: manifest.packageId,
        name: 'Hello Provider',
        version: manifest.version,
        apiVersion: 1,
        contributes: [
            { providerId: 'example.helloWorld', apiVersion: 1, runtime: 'python', entry: 'helloWorld.py' },
            { kind: 'component', componentId: 'helloComponent', apiVersion: 1, entry: 'helloComponent.json' }
        ]
    };
    const result = inspectPackageArchive(createPackageArchive({
        packageManifest: manifest,
        contributionManifest: contribution,
        files: { 'helloWorld.py': 'provider source', 'helloComponent.json': '{}' }
    }), { extension: '.kjp' });
    assert.equal(result.packageManifest.packageType, 'plugin');
    assert.equal(result.contributionManifest.contributes[0].runtime, 'python');
    assert.equal(result.contributionManifest.contributes[1].kind, 'component');
});

test('rejects a plugin that omits a declared provider artifact', () => {
    const manifest = packageManifest('plugin');
    const contribution = {
        pluginId: manifest.packageId, name: 'Hello Provider', version: manifest.version,
        apiVersion: 1,
        contributes: [{ providerId: 'example.helloWorld', apiVersion: 1, runtime: 'python', entry: 'missing.py' }]
    };
    assert.throws(
        () => inspectPackageArchive(createPackageArchive({ packageManifest: manifest, contributionManifest: contribution }), { extension: '.kjp' }),
        (error) => error instanceof PackageArchiveError && error.code === 'MISSING_ENTRY'
    );
});

test('rejects an extension whose package type does not match', () => {
    assert.throws(
        () => inspectPackageArchive(addonArchive(), { extension: '.kjp' }),
        (error) => error instanceof PackageArchiveError && error.code === 'PACKAGE_TYPE_MISMATCH'
    );
});

test('rejects a package and contribution manifest identity mismatch', () => {
    assert.throws(
        () => inspectPackageArchive(addonArchive({ packageId: 'example.otherAddon' }), { extension: '.kja' }),
        (error) => error instanceof PackageArchiveError && error.code === 'MANIFEST_MISMATCH'
    );
});

test('rejects payload entries that shadow package manifests', () => {
    assert.throws(
        () => addonArchive({}, { 'package.json': '{}' }),
        (error) => error instanceof PackageArchiveError && error.code === 'DUPLICATE_ENTRY'
    );
    assert.throws(
        () => addonArchive({}, { 'addon.json': '{}' }),
        (error) => error instanceof PackageArchiveError && error.code === 'DUPLICATE_ENTRY'
    );
});

test('rejects traversal and absolute archive paths', () => {
    for (const name of ['../escape.txt', '/absolute.txt', 'nested/../../escape.txt', 'nested\\escape.txt']) {
        const archive = zipSync({ 'package.json': strToU8('{}'), [name]: strToU8('unsafe') });
        assert.throws(
            () => inspectPackageArchive(archive, { extension: '.kja' }),
            (error) => error instanceof PackageArchiveError && error.code === 'UNSAFE_PATH'
        );
    }
});

test('rejects malformed archives and malformed package JSON', () => {
    assert.throws(
        () => inspectPackageArchive(Buffer.from('not a zip'), { extension: '.kja' }),
        (error) => error instanceof PackageArchiveError && error.code === 'INVALID_ARCHIVE'
    );
    const archive = zipSync({ 'package.json': strToU8('{') });
    assert.throws(
        () => inspectPackageArchive(archive, { extension: '.kja' }),
        (error) => error instanceof PackageArchiveError && error.code === 'INVALID_MANIFEST'
    );
});

test('rejects an expanded archive that exceeds limits', () => {
    const archive = zipSync({ 'package.json': strToU8('{}'), 'large.bin': new Uint8Array(65 * 1024 * 1024) });
    assert.throws(
        () => inspectPackageArchive(archive, { extension: '.kja' }),
        (error) => error instanceof PackageArchiveError && error.code === 'ARCHIVE_LIMIT'
    );
});

test('installs into a platform-neutral user package directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-packages-'));
    try {
        const result = await installPackageArchive(addonArchive(), { extension: '.kja', directory });
        assert.equal(result.installPath, join(directory, 'addons', 'example.helloWorld', '0.1.0'));
        assert.deepEqual(JSON.parse(await readFile(join(result.installPath, 'addon.json'), 'utf8')), addonManifest);
        assert.equal(await readFile(join(result.installPath, 'index.html'), 'utf8'), '<!doctype html>');
        await assert.rejects(
            installPackageArchive(addonArchive(), { extension: '.kja', directory }),
            (error) => error instanceof PackageArchiveError && error.code === 'ALREADY_INSTALLED'
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('cleans the temporary install after a write failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-packages-'));
    try {
        const result = await installPackageArchive(addonArchive(), { extension: '.kja', directory });
        await rm(result.installPath, { recursive: true, force: true });
        const installed = await installPackageArchive(addonArchive({ version: '0.1.1' }), { extension: '.kja', directory });
        assert.ok(installed.installPath.endsWith('/0.1.1'));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

assert.equal(validateAddonManifest(addonManifest).addonId, 'example.helloWorld');
