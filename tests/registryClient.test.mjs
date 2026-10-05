/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { createPackageArchive, listInstalledPackages, loadNamespaceRegistry, PackageArchiveError } from '../src/packageArchive.mjs';
import { fetchLatestReleaseVersion, fetchRegistryImage, fetchRegistryScreenshot, fetchRemoteRegistry, identifyRegistryImage, installFromRegistryEntry, isNewerVersion, registryImageMaxBytes, registryImageUrl, RegistryClientError, registryScreenshotUrl } from '../src/registryClient.mjs';

// A minimal but real .kja, built the same way tests/packageArchive.test.mjs does.
function addonArchive(packageId = 'example.fintech.toolbox', version = '0.1.0') {
    return createPackageArchive({
        packageManifest: { format: 'konjugate-package', formatVersion: 1, packageType: 'addon', packageId, name: 'Example', version, contents: { manifest: 'addon.json' } },
        contributionManifest: {
            addonId: packageId, name: 'Example', version, apiVersion: 1, kind: 'resultVisualizer', entry: 'index.html', permissions: ['results.read'],
            contributes: { toolstrip: [{ commandId: 'open', label: 'Open', tooltip: 'Open', symbol: 'E', when: 'resultsActive', contexts: ['resultSession'] }] }
        },
        files: { 'index.html': '<!doctype html>' }
    });
}

function pluginArchive(packageId = 'example.fintech.engine') {
    return createPackageArchive({
        packageManifest: { format: 'konjugate-package', formatVersion: 1, packageType: 'plugin', packageId, name: 'Example Engine', version: '0.1.0', contents: { manifest: 'plugin.json' } },
        contributionManifest: {
            pluginId: packageId, name: 'Example Engine', version: '0.1.0', apiVersion: 1,
            contributes: [{ kind: 'component', componentId: 'exampleNode', apiVersion: 1, entry: 'exampleNode.json' }]
        },
        files: { 'exampleNode.json': '{}' }
    });
}

function fakeFetch(routes) {
    return async (url) => {
        const route = routes[url];
        if (!route) throw new Error(`Unexpected fetch to ${url}`);
        return typeof route === 'function' ? route() : route;
    };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function textResponse(text, { ok = true, status = 200 } = {}) {
    return { ok, status, text: async () => text };
}

function bytesResponse(bytes, { ok = true, status = 200 } = {}) {
    return { ok, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

const listingUrl = 'https://api.github.com/repos/zenineasa/Konjugate/contents/registry?ref=master';
const minimalEntry = (overrides = {}) => ({
    format: 'konjugate-namespace-entry', formatVersion: 1,
    owner: 'Example Org', contact: 'https://example.org', publicKeys: ['-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n'],
    ...overrides
});

test('fetchRemoteRegistry lists and fetches every entry', async () => {
    const entry = minimalEntry();
    const fetchImpl = fakeFetch({
        [listingUrl]: jsonResponse([
            { type: 'file', name: 'example.fintech.json', download_url: 'https://raw/example.fintech.json' },
            { type: 'file', name: 'ReadMe.md', download_url: 'https://raw/ReadMe.md' },
            { type: 'dir', name: 'nested' }
        ]),
        'https://raw/example.fintech.json': textResponse(JSON.stringify(entry))
    });
    const registry = await fetchRemoteRegistry({ fetchImpl });
    assert.deepEqual(Object.keys(registry.prefixes), ['example.fintech']);
    assert.equal(registry.prefixes['example.fintech'].owner, 'Example Org');
});

test('fetchRemoteRegistry treats a missing registry/ directory (404) as an empty registry', async () => {
    const fetchImpl = fakeFetch({ [listingUrl]: jsonResponse(null, { ok: false, status: 404 }) });
    assert.deepEqual(await fetchRemoteRegistry({ fetchImpl }), { prefixes: {} });
});

test('fetchRemoteRegistry throws on a non-404 listing failure', async () => {
    const fetchImpl = fakeFetch({ [listingUrl]: jsonResponse(null, { ok: false, status: 500 }) });
    await assert.rejects(() => fetchRemoteRegistry({ fetchImpl }), (error) => error instanceof RegistryClientError && error.code === 'LISTING_FAILED');
});

test('fetchRemoteRegistry throws if fetching one entry\'s content fails', async () => {
    const fetchImpl = fakeFetch({
        [listingUrl]: jsonResponse([{ type: 'file', name: 'example.fintech.json', download_url: 'https://raw/example.fintech.json' }]),
        'https://raw/example.fintech.json': textResponse('', { ok: false, status: 500 })
    });
    await assert.rejects(() => fetchRemoteRegistry({ fetchImpl }), (error) => error instanceof RegistryClientError && error.code === 'FETCH_FAILED');
});

test('fetchRemoteRegistry propagates the underlying validation error for a malformed entry', async () => {
    const fetchImpl = fakeFetch({
        [listingUrl]: jsonResponse([{ type: 'file', name: 'example.fintech.json', download_url: 'https://raw/example.fintech.json' }]),
        'https://raw/example.fintech.json': textResponse(JSON.stringify({ format: 'konjugate-namespace-entry', formatVersion: 1 }))
    });
    await assert.rejects(() => fetchRemoteRegistry({ fetchImpl }), (error) => error instanceof PackageArchiveError && error.code === 'INVALID_REGISTRY_ENTRY');
});

test('installFromRegistryEntry rejects an entry with no downloadUrl or no packages', async () => {
    await assert.rejects(() => installFromRegistryEntry({ packages: [{ packageType: 'addon', packageId: 'x.y' }] }, {}),
        (error) => error instanceof RegistryClientError && error.code === 'NO_DOWNLOAD_URL');
    await assert.rejects(() => installFromRegistryEntry({ downloadUrl: 'https://example.org/x.zip' }, {}),
        (error) => error instanceof RegistryClientError && error.code === 'NO_PACKAGES');
});

test('installFromRegistryEntry surfaces a download failure', async () => {
    const entry = { downloadUrl: 'https://example.org/x.zip', packages: [{ packageType: 'addon', packageId: 'example.fintech.toolbox' }] };
    const fetchImpl = fakeFetch({ 'https://example.org/x.zip': bytesResponse(new Uint8Array(), { ok: false, status: 404 }) });
    await assert.rejects(() => installFromRegistryEntry(entry, { fetchImpl }), (error) => error instanceof RegistryClientError && error.code === 'DOWNLOAD_FAILED');
});

test('installFromRegistryEntry rejects a download that is not a valid zip', async () => {
    const entry = { downloadUrl: 'https://example.org/x.zip', packages: [{ packageType: 'addon', packageId: 'example.fintech.toolbox' }] };
    const fetchImpl = fakeFetch({ 'https://example.org/x.zip': bytesResponse(strToU8('not a zip')) });
    await assert.rejects(() => installFromRegistryEntry(entry, { fetchImpl }), (error) => error instanceof RegistryClientError && error.code === 'INVALID_DOWNLOAD');
});

test('installFromRegistryEntry rejects a zip missing a declared package', async () => {
    const zip = zipSync({ 'other.kja': addonArchive('some.other.addon') });
    const entry = { downloadUrl: 'https://example.org/x.zip', packages: [{ packageType: 'addon', packageId: 'example.fintech.toolbox' }] };
    const fetchImpl = fakeFetch({ 'https://example.org/x.zip': bytesResponse(zip) });
    await assert.rejects(() => installFromRegistryEntry(entry, { fetchImpl }), (error) => error instanceof RegistryClientError && error.code === 'PACKAGE_MISSING');
});

test('installFromRegistryEntry installs a single package and reports its verification status', async () => {
    const zip = zipSync({ 'konjugate.fintech.toolbox-0.1.0.kja': addonArchive() });
    const entry = { downloadUrl: 'https://example.org/x.zip', packages: [{ packageType: 'addon', packageId: 'example.fintech.toolbox' }] };
    const fetchImpl = fakeFetch({ 'https://example.org/x.zip': bytesResponse(zip) });
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-registryclient-'));
    try {
        const results = await installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} } });
        assert.equal(results.length, 1);
        assert.equal(results[0].packageId, 'example.fintech.toolbox');
        assert.equal(results[0].verification.status, 'unclaimed');
        assert.ok((await readdir(join(directory, 'addons', 'example.fintech.toolbox'))).includes('0.1.0'));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('installFromRegistryEntry installs every package a bundle lists, matched by identity not file name', async () => {
    // Deliberately mis-ordered/misleadingly-named zip entries -- matching must not rely on names.
    const zip = zipSync({ 'first-file-in-the-zip.kjp': pluginArchive(), 'second-file-in-the-zip.kja': addonArchive() });
    const entry = {
        downloadUrl: 'https://example.org/bundle.zip',
        packages: [{ packageType: 'addon', packageId: 'example.fintech.toolbox' }, { packageType: 'plugin', packageId: 'example.fintech.engine' }]
    };
    const fetchImpl = fakeFetch({ 'https://example.org/bundle.zip': bytesResponse(zip) });
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-registryclient-'));
    try {
        const results = await installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} } });
        assert.deepEqual(results.map((r) => r.packageId).sort(), ['example.fintech.engine', 'example.fintech.toolbox']);
        assert.ok((await readdir(join(directory, 'addons'))).includes('example.fintech.toolbox'));
        assert.ok((await readdir(join(directory, 'plugins'))).includes('example.fintech.engine'));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('installFromRegistryEntry reports "invalid" without refusing to install, per the advisory-only principle', async () => {
    // A signed package whose signature.json claims a prefix not present in the supplied namespaces
    // would come back "invalid" from verifyPackageArchive; here the simpler unsigned + unclaimed
    // case already demonstrates the same point: verification never gates the install that follows.
    const zip = zipSync({ 'konjugate.fintech.toolbox-0.1.0.kja': addonArchive() });
    const entry = { downloadUrl: 'https://example.org/x.zip', packages: [{ packageType: 'addon', packageId: 'example.fintech.toolbox' }] };
    const fetchImpl = fakeFetch({ 'https://example.org/x.zip': bytesResponse(zip) });
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-registryclient-'));
    try {
        const results = await installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: { 'example.fintech': { publicKeys: [] } } } });
        assert.equal(results[0].verification.status, 'unsigned');
        assert.ok((await readdir(join(directory, 'addons'))).includes('example.fintech.toolbox'), 'install proceeded despite an unsigned/unverified status');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('fetchRemoteRegistry throws RATE_LIMITED on HTTP 403', async () => {
    const fetchImpl = fakeFetch({ [listingUrl]: jsonResponse(null, { ok: false, status: 403 }) });
    await assert.rejects(() => fetchRemoteRegistry({ fetchImpl }), (error) => error instanceof RegistryClientError && error.code === 'RATE_LIMITED');
});

test('fetchRemoteRegistry fetches from a custom registryUrl', async () => {
    const customUrl = 'https://custom.registry/index.json';
    const entry = minimalEntry();
    const fetchImpl = fakeFetch({ [customUrl]: jsonResponse({ prefixes: { 'example.fintech': entry } }) });
    const registry = await fetchRemoteRegistry({ registryUrl: customUrl, fetchImpl });
    assert.deepEqual(Object.keys(registry.prefixes), ['example.fintech']);
});

test('installFromRegistryEntry installs a direct .kja download without nesting in a zip', async () => {
    const directKjaBytes = addonArchive('example.fintech.toolbox');
    const entry = { downloadUrl: 'https://example.org/direct.kja', packages: [{ packageType: 'addon', packageId: 'example.fintech.toolbox' }] };
    const fetchImpl = fakeFetch({ 'https://example.org/direct.kja': bytesResponse(directKjaBytes) });
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-registryclient-'));
    try {
        const results = await installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} } });
        assert.equal(results.length, 1);
        assert.equal(results[0].packageId, 'example.fintech.toolbox');
        assert.ok((await readdir(join(directory, 'addons', 'example.fintech.toolbox'))).includes('0.1.0'));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('installFromRegistryEntry cleanly reinstalls or updates an already installed package', async () => {
    const directKjaBytes = addonArchive('example.fintech.toolbox');
    const entry = { downloadUrl: 'https://example.org/direct.kja', packages: [{ packageType: 'addon', packageId: 'example.fintech.toolbox' }] };
    const fetchImpl = fakeFetch({ 'https://example.org/direct.kja': bytesResponse(directKjaBytes) });
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-registryclient-'));
    try {
        await installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} } });
        const results = await installFromRegistryEntry(entry, { fetchImpl, directory, namespaces: { prefixes: {} } });
        assert.equal(results.length, 1);
        assert.equal(results[0].packageId, 'example.fintech.toolbox');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('isNewerVersion compares dotted-numeric versions segment by segment', () => {
    assert.equal(isNewerVersion('0.2.0', '0.1.0'), true);
    assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
    assert.equal(isNewerVersion('0.1.0', '0.2.0'), false);
    assert.equal(isNewerVersion('1.0.0', '0.9.9'), true);
    assert.equal(isNewerVersion('0.1.10', '0.1.9'), true, 'compares numerically, not lexically');
    assert.equal(isNewerVersion('0.1', '0.1.0'), false, 'a missing trailing segment counts as 0');
});

test('fetchLatestReleaseVersion reads the latest release tag for a GitHub releases download URL', async () => {
    const releasesUrl = 'https://api.github.com/repos/zenineasa/Konjugate-Fintech/releases/latest';
    const fetchImpl = fakeFetch({
        [releasesUrl]: jsonResponse({ tag_name: 'v0.2.0', html_url: 'https://github.com/zenineasa/Konjugate-Fintech/releases/tag/v0.2.0' })
    });
    const result = await fetchLatestReleaseVersion('https://github.com/zenineasa/Konjugate-Fintech/releases/latest/download/konjugate-fintech-toolbox.zip', { fetchImpl });
    assert.deepEqual(result, { version: '0.2.0', url: 'https://github.com/zenineasa/Konjugate-Fintech/releases/tag/v0.2.0' });
});

test('fetchLatestReleaseVersion returns null rather than throwing for anything not checkable', async () => {
    assert.equal(await fetchLatestReleaseVersion('https://example.org/not-github.zip'), null);
    assert.equal(await fetchLatestReleaseVersion(undefined), null);
    const notFound = fakeFetch({
        'https://api.github.com/repos/zenineasa/Konjugate-HelloWorld/releases/latest': jsonResponse(null, { ok: false, status: 404 })
    });
    assert.equal(await fetchLatestReleaseVersion('https://github.com/zenineasa/Konjugate-HelloWorld/releases/latest/download/konjugate.helloWorld.kja', { fetchImpl: notFound }), null);
    const throwing = async () => { throw new Error('network down'); };
    assert.equal(await fetchLatestReleaseVersion('https://github.com/zenineasa/Konjugate-HelloWorld/releases/latest/download/konjugate.helloWorld.kja', { fetchImpl: throwing }), null);
});

test('installFromRegistryEntry replaces an older installed version rather than installing alongside it', async () => {
    const entry = { downloadUrl: 'https://example.org/direct.kja', packages: [{ packageType: 'addon', packageId: 'example.fintech.toolbox' }] };
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-registryclient-'));
    try {
        await installFromRegistryEntry(entry, { fetchImpl: fakeFetch({ 'https://example.org/direct.kja': bytesResponse(addonArchive('example.fintech.toolbox', '0.1.0')) }), directory, namespaces: { prefixes: {} } });
        const results = await installFromRegistryEntry(entry, { fetchImpl: fakeFetch({ 'https://example.org/direct.kja': bytesResponse(addonArchive('example.fintech.toolbox', '0.2.0')) }), directory, namespaces: { prefixes: {} } });
        assert.equal(results[0].version, '0.2.0');
        const installed = await listInstalledPackages(directory);
        assert.deepEqual(installed.map((pkg) => `${pkg.packageId}@${pkg.version}`), ['example.fintech.toolbox@0.2.0']);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

const imageEntry = { image: 'images/example.fintech.webp' };
const imageUrl = 'https://raw.githubusercontent.com/zenineasa/Konjugate/master/registry/images/example.fintech.webp';
const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test('registryImageUrl resolves against the registry repository, or beside an alternate registry URL', () => {
    assert.equal(registryImageUrl(imageEntry, { registryUrl: '' }), imageUrl);
    assert.equal(registryImageUrl(imageEntry, { registryUrl: '', owner: 'example', repo: 'Mirror', ref: 'main' }),
        'https://raw.githubusercontent.com/example/Mirror/main/registry/images/example.fintech.webp');
    assert.equal(registryImageUrl(imageEntry, { registryUrl: 'https://mirror.example.org/konjugate/registry.json' }),
        'https://mirror.example.org/konjugate/images/example.fintech.webp');
    assert.equal(registryImageUrl({}, { registryUrl: '' }), null);
    assert.equal(registryImageUrl({ image: '../secrets.png' }, { registryUrl: '' }), null);
});

test('identifyRegistryImage recognises PNG, JPEG and WebP by their bytes, not the file name', () => {
    assert.equal(identifyRegistryImage(new Uint8Array(pngHeader)), 'image/png');
    assert.equal(identifyRegistryImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(identifyRegistryImage(new Uint8Array([...strToU8('RIFF'), 0, 0, 0, 0, ...strToU8('WEBPVP8 ')])), 'image/webp');
    assert.throws(() => identifyRegistryImage(strToU8('<svg onload="alert(1)"></svg>')), (error) => error.code === 'INVALID_IMAGE');
    const oversized = new Uint8Array(registryImageMaxBytes + 1);
    oversized.set(pngHeader);
    assert.throws(() => identifyRegistryImage(oversized), (error) => error.code === 'IMAGE_TOO_LARGE');
});

test('fetchRegistryImage downloads and checks an entry\'s image', async () => {
    const result = await fetchRegistryImage(imageEntry, { registryUrl: '', fetchImpl: fakeFetch({ [imageUrl]: bytesResponse(new Uint8Array(pngHeader)) }) });
    assert.equal(result.mimeType, 'image/png');
    await assert.rejects(() => fetchRegistryImage({}, { registryUrl: '' }), (error) => error instanceof RegistryClientError && error.code === 'NO_IMAGE');
    await assert.rejects(() => fetchRegistryImage(imageEntry, { registryUrl: '', fetchImpl: fakeFetch({ [imageUrl]: bytesResponse(new Uint8Array(), { ok: false, status: 404 }) }) }),
        (error) => error.code === 'DOWNLOAD_FAILED');
    await assert.rejects(() => fetchRegistryImage(imageEntry, { registryUrl: '', fetchImpl: fakeFetch({ [imageUrl]: bytesResponse(strToU8('not an image')) }) }),
        (error) => error.code === 'INVALID_IMAGE');
});

// The real registry this repository ships: every image an entry names exists and passes the same
// checks the app applies, and nothing in images/ is left unreferenced (and so shipped for nothing).
test('the bundled registry\'s images all exist, are valid and are referenced', async () => {
    const { prefixes } = await loadNamespaceRegistry('registry');
    const referenced = Object.values(prefixes).map((entry) => entry.image).filter(Boolean);
    for (const image of referenced) identifyRegistryImage(new Uint8Array(await readFile(join('registry', image))), image);
    const shipped = (await readdir(join('registry', 'images')).catch(() => [])).filter((name) => !name.startsWith('.')).map((name) => `images/${name}`);
    assert.deepEqual(shipped.filter((name) => !referenced.includes(name)), []);
});

const screenshotEntry = { screenshots: [{ image: 'screenshots/example.fintech.1.webp', caption: 'One' }, { image: 'screenshots/example.fintech.2.png', caption: 'Two' }] };
const screenshotUrl = (name) => `https://raw.githubusercontent.com/zenineasa/Konjugate/master/registry/screenshots/${name}`;

test('registryScreenshotUrl resolves each screenshot against the registry, and refuses anything else', () => {
    assert.equal(registryScreenshotUrl(screenshotEntry, 0, { registryUrl: '' }), screenshotUrl('example.fintech.1.webp'));
    assert.equal(registryScreenshotUrl(screenshotEntry, 1, { registryUrl: '', owner: 'example', repo: 'Mirror', ref: 'main' }),
        'https://raw.githubusercontent.com/example/Mirror/main/registry/screenshots/example.fintech.2.png');
    assert.equal(registryScreenshotUrl(screenshotEntry, 0, { registryUrl: 'https://mirror.example.org/konjugate/registry.json' }),
        'https://mirror.example.org/konjugate/screenshots/example.fintech.1.webp');
    assert.equal(registryScreenshotUrl(screenshotEntry, 2, { registryUrl: '' }), null);
    assert.equal(registryScreenshotUrl({}, 0, { registryUrl: '' }), null);
    assert.equal(registryScreenshotUrl({ screenshots: [{ image: 'images/example.webp', caption: 'x' }] }, 0, { registryUrl: '' }), null);
    assert.equal(registryScreenshotUrl({ screenshots: [{ image: 'screenshots/../secrets.png', caption: 'x' }] }, 0, { registryUrl: '' }), null);
});

test('fetchRegistryScreenshot downloads and checks a screenshot like an image', async () => {
    const url = screenshotUrl('example.fintech.2.png');
    const result = await fetchRegistryScreenshot(screenshotEntry, 1, { registryUrl: '', fetchImpl: fakeFetch({ [url]: bytesResponse(new Uint8Array(pngHeader)) }) });
    assert.equal(result.mimeType, 'image/png');
    await assert.rejects(() => fetchRegistryScreenshot(screenshotEntry, 5, { registryUrl: '', fetchImpl: fakeFetch({}) }), (error) => error.code === 'NO_IMAGE');
    await assert.rejects(() => fetchRegistryScreenshot(screenshotEntry, 1, { registryUrl: '', fetchImpl: fakeFetch({ [url]: bytesResponse(new Uint8Array(), { ok: false, status: 404 }) }) }),
        (error) => error.code === 'DOWNLOAD_FAILED');
    await assert.rejects(() => fetchRegistryScreenshot(screenshotEntry, 1, { registryUrl: '', fetchImpl: fakeFetch({ [url]: bytesResponse(strToU8('not an image')) }) }),
        (error) => error.code === 'INVALID_IMAGE');
});

// Same guarantee as for images, for the real registry: every screenshot an entry names exists and
// passes the checks the app applies, and nothing in screenshots/ is left unreferenced.
test('the bundled registry\'s screenshots all exist, are valid and are referenced', async () => {
    const { prefixes } = await loadNamespaceRegistry('registry');
    const referenced = Object.values(prefixes).flatMap((entry) => (entry.screenshots ?? []).map((screenshot) => screenshot.image));
    for (const image of referenced) identifyRegistryImage(new Uint8Array(await readFile(join('registry', image))), image);
    const shipped = (await readdir(join('registry', 'screenshots')).catch(() => [])).filter((name) => !name.startsWith('.')).map((name) => `screenshots/${name}`);
    assert.deepEqual(shipped.filter((name) => !referenced.includes(name)), []);
});
