/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { createPackageArchive, registryImagePathPattern, registryScreenshotPathPattern, registryVideoUrlPattern, signPackageArchive, verifyPackageArchive } from '../src/packageArchive.mjs';
import { verifyPackageArchiveAsync } from '../src/packageSignature.mjs';
import { buildRegistryMirror } from '../src/webRegistryMirror.mjs';
import { fetchMirrorIndex, fetchMirroredImage, fetchMirroredPackages, mirrorUpdates } from '../src/webRegistry.mjs';
import { registryImagePathPatternForWeb, registryScreenshotPathPatternForWeb, registryVideoUrlPatternForWeb } from '../src/webRegistryPaths.mjs';

const base = 'https://web.example/registry/';
const pem = (key, type) => key.export({ type, format: 'pem' }).toString();
const pluginArchive = (version = '1.0.0', packageId = 'example.parts') => createPackageArchive({
    packageManifest: { format: 'konjugate-package', formatVersion: 1, packageType: 'plugin', packageId, name: 'Parts', version, contents: { manifest: 'plugin.json' } },
    contributionManifest: { pluginId: packageId, name: 'Parts', version, apiVersion: 1, permissions: [], contributes: [{ kind: 'example', exampleId: 'parts', apiVersion: 1, name: 'Parts', entry: 'parts.kjt' }] },
    files: { 'parts.kjt': strToU8('{}') }
});

test('the web check of a signature agrees with the desktop\'s on every status', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const namespaces = { prefixes: { example: { owner: 'Example Org', publicKeys: [pem(publicKey, 'spki')] } } };
    const signed = signPackageArchive(pluginArchive(), { privateKey: pem(privateKey, 'pkcs8'), prefix: 'example' });
    const wrongKey = signPackageArchive(pluginArchive(), { privateKey: pem(other.privateKey, 'pkcs8'), prefix: 'example' });
    const cases = [
        [signed, namespaces], [wrongKey, namespaces], [pluginArchive(), namespaces], [pluginArchive(), { prefixes: {} }], [signed, { prefixes: {} }],
        [signed, { prefixes: { example: { owner: 'X', publicKeys: [pem(other.publicKey, 'spki'), pem(publicKey, 'spki')] } } }]
    ];
    for (const [archive, registry] of cases) assert.deepEqual(await verifyPackageArchiveAsync(archive, { namespaces: registry }), verifyPackageArchive(archive, { namespaces: registry }));
    assert.equal((await verifyPackageArchiveAsync(signed, { namespaces })).status, 'verified');
});

test('a changed file, a changed signature and a browser without Ed25519 are each reported, not trusted', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const namespaces = { prefixes: { example: { owner: 'Example Org', publicKeys: [pem(publicKey, 'spki')] } } };
    const signed = signPackageArchive(pluginArchive(), { privateKey: pem(privateKey, 'pkcs8'), prefix: 'example' });
    const { unzipSync } = await import('fflate');
    const files = unzipSync(signed);
    const tampered = zipSync({ ...files, 'plugin.json': strToU8(JSON.stringify({ pluginId: 'example.parts', name: 'Evil', version: '1.0.0', apiVersion: 1, permissions: [], contributes: [{ kind: 'example', exampleId: 'parts', apiVersion: 1, name: 'Parts', entry: 'parts.kjt' }] })) });
    assert.match((await verifyPackageArchiveAsync(tampered, { namespaces })).reason, /digest does not match/);
    const broken = { ...JSON.parse(new TextDecoder().decode(files['signature.json'])) };
    broken.signature = Buffer.alloc(64).toString('base64');
    const resigned = zipSync({ ...files, 'signature.json': strToU8(JSON.stringify(broken)) });
    assert.match((await verifyPackageArchiveAsync(resigned, { namespaces })).reason, /does not verify/);
    const noEd25519 = { generateKey: async () => { throw new Error('unsupported'); }, digest: async () => new ArrayBuffer(0) };
    const result = await verifyPackageArchiveAsync(signed, { namespaces, subtle: noEd25519 });
    assert.equal(result.status, 'unverifiable');
});

test('path shapes the page checks are the ones the desktop checks', () => {
    for (const [web, desktop] of [[registryImagePathPatternForWeb, registryImagePathPattern], [registryScreenshotPathPatternForWeb, registryScreenshotPathPattern], [registryVideoUrlPatternForWeb, registryVideoUrlPattern]]) {
        assert.equal(web.source, desktop.source);
        assert.equal(web.flags, desktop.flags);
    }
});

const entry = (overrides = {}) => ({
    format: 'konjugate-namespace-entry', formatVersion: 1, owner: 'Example Org', publicKeys: [], title: 'Example', description: 'd',
    downloadUrl: 'https://github.com/example/parts/releases/latest/download/parts.kjp', packages: [{ packageType: 'plugin', packageId: 'example.parts' }], image: 'images/example.png', ...overrides
});

test('the mirror holds an entry\'s image and, when asked, the package from its release, with the size and hash it was stored with', async () => {
    const archive = pluginArchive('1.2.0');
    const fetchImpl = async (url) => {
        const text = String(url);
        if (text.endsWith('parts.kjp')) return new Response(archive);
        if (text.includes('/releases')) return new Response(JSON.stringify([{ tag_name: 'v1.2.0', prerelease: false, assets: [{ name: 'parts.kjp', browser_download_url: 'https://github.com/example/parts/releases/download/v1.2.0/parts.kjp' }] }]));
        return new Response('', { status: 404 });
    };
    const readAsset = async (path) => (path === 'images/example.png' ? Uint8Array.of(0x89, 0x50, 0x4e, 0x47) : null);
    const offline = await buildRegistryMirror({ registry: { prefixes: { example: entry() } }, readAsset, appVersion: '1.3.4', fetchImpl: async () => { throw new Error('no network wanted'); } });
    assert.deepEqual(offline.index.mirror, {});
    assert.equal(offline.files.has('registry/images/example.png'), true);
    assert.equal(offline.problems.length, 0);
    const built = await buildRegistryMirror({ registry: { prefixes: { example: entry() } }, readAsset, appVersion: '1.3.4', fetchImpl, mirrorPackages: true });
    assert.deepEqual(built.problems, []);
    const [mirrored] = built.index.mirror.example.packages;
    assert.equal(mirrored.version, '1.2.0');
    assert.equal(mirrored.file, 'packages/example/example.parts-1.2.0.kjp');
    assert.equal(mirrored.sha256, createHash('sha256').update(archive).digest('hex'));
    assert.equal(built.files.get(`registry/${mirrored.file}`).length, mirrored.bytes);
    const failed = await buildRegistryMirror({ registry: { prefixes: { example: entry() } }, readAsset, appVersion: '1.3.4', fetchImpl: async () => new Response('', { status: 500 }), mirrorPackages: true });
    assert.match(failed.problems[0], /not mirrored/);
    assert.deepEqual(failed.index.mirror, {});
});

test('the page reads the index, downloads a package only if it is as recorded, and refuses what is not', async () => {
    const archive = pluginArchive();
    const mirrored = { packageType: 'plugin', packageId: 'example.parts', version: '1.0.0', file: 'packages/example/example.parts-1.0.0.kjp', bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') };
    const index = { format: 'konjugate-web-registry', formatVersion: 1, prefixes: { example: entry() }, mirror: { example: { packages: [mirrored] } } };
    const served = { 'index.json': JSON.stringify(index), [mirrored.file]: archive };
    const fetchImpl = async (url) => { const key = String(url).slice(base.length); return key in served ? new Response(served[key]) : new Response('', { status: 404 }); };
    const loaded = await fetchMirrorIndex({ fetchImpl, base });
    assert.equal(Object.keys(loaded.registry.prefixes).length, 1);
    const [download] = await fetchMirroredPackages('example', loaded, { fetchImpl, base });
    assert.equal(download.declared.packageId, 'example.parts');
    served[mirrored.file] = Buffer.from(archive);
    served[mirrored.file][10] ^= 0xff;
    await assert.rejects(fetchMirroredPackages('example', loaded, { fetchImpl, base }), /not downloaded intact/);
    await assert.rejects(fetchMirroredPackages('missing', loaded, { fetchImpl, base }), /not available from the web edition's registry/);
    const escaping = { ...loaded, mirror: { example: { packages: [{ ...mirrored, file: '../../app.js' }] } } };
    await assert.rejects(fetchMirroredPackages('example', escaping, { fetchImpl, base }), /outside itself/);
    assert.deepEqual((await fetchMirrorIndex({ fetchImpl: async () => new Response('', { status: 404 }), base })).registry.prefixes, {});
    await assert.rejects(fetchMirrorIndex({ fetchImpl: async () => new Response('{"prefixes":{}}'), base }), /not in a format/);
});

test('images come from the mirror only for a path the registry allows, and only if they are images', async () => {
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0);
    const fetchImpl = async () => new Response(png);
    assert.equal((await fetchMirroredImage({ image: 'images/a.png' }, null, { fetchImpl, base })).mimeType, 'image/png');
    assert.equal(await fetchMirroredImage({ image: '../secret.png' }, null, { fetchImpl, base }), null);
    assert.equal(await fetchMirroredImage({ image: 'images/../a.png' }, null, { fetchImpl, base }), null);
    assert.equal(await fetchMirroredImage({ screenshots: [{ image: 'screenshots/s.png' }] }, 0, { fetchImpl, base }).then((image) => image.mimeType), 'image/png');
    assert.equal(await fetchMirroredImage({ screenshots: [] }, 3, { fetchImpl, base }), null);
    assert.equal(await fetchMirroredImage({ image: 'images/a.png' }, null, { fetchImpl: async () => new Response('not an image at all') , base }), null);
});

test('an update is offered only for an installed package the mirror has a newer version of', () => {
    const index = { mirror: { example: { packages: [{ packageType: 'plugin', packageId: 'example.parts', version: '1.2.0' }, { packageType: 'plugin', packageId: 'example.other', version: '1.0.0' }] } } };
    const installed = [{ packageType: 'plugin', packageId: 'example.parts', version: '1.0.0' }, { packageType: 'plugin', packageId: 'example.other', version: '1.0.0' }, { packageType: 'addon', packageId: 'example.parts', version: '9.0.0' }];
    assert.deepEqual(mirrorUpdates(index, installed), [{ prefix: 'example', latestVersion: '1.2.0', releaseUrl: null, outdated: [{ packageId: 'example.parts', installedVersion: '1.0.0' }], heldBackPackages: [] }]);
    assert.deepEqual(mirrorUpdates(index, []), []);
    assert.deepEqual(mirrorUpdates({}, installed), []);
});
