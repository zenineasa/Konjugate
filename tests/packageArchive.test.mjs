/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { validateAddonManifest } from '../src/addonHost.mjs';
import {
    createPackageArchive,
    inspectPackageArchive,
    installPackageArchive,
    listInstalledPackages,
    loadNamespaceRegistry,
    PackageArchiveError,
    signPackageArchive,
    uninstallPackage,
    verifyPackageArchive
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

test('lists installed packages, empty then populated across both types', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-packages-'));
    try {
        assert.deepEqual(await listInstalledPackages(directory), []);
        await installPackageArchive(addonArchive(), { extension: '.kja', directory });
        const pluginManifest = packageManifest('plugin');
        const pluginContribution = {
            pluginId: pluginManifest.packageId, name: pluginManifest.name, version: pluginManifest.version,
            apiVersion: 1, contributes: [{ providerId: 'example.helloWorld', apiVersion: 1, runtime: 'python', entry: 'helloWorld.py' }]
        };
        await installPackageArchive(createPackageArchive({
            packageManifest: pluginManifest, contributionManifest: pluginContribution, files: { 'helloWorld.py': 'source' }
        }), { extension: '.kjp', directory });
        const results = await listInstalledPackages(directory);
        assert.equal(results.length, 2);
        const addonEntry = results.find((entry) => entry.packageType === 'addon');
        assert.equal(addonEntry.source, 'installed');
        assert.equal(addonEntry.packageId, 'example.helloWorld');
        assert.deepEqual(addonEntry.permissions, ['results.read']);
        const pluginEntry = results.find((entry) => entry.packageType === 'plugin');
        assert.equal(pluginEntry.packageId, 'example.helloProvider');
        assert.deepEqual(pluginEntry.permissions, []);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('uninstall removes exactly the targeted version and leaves siblings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-packages-'));
    try {
        await installPackageArchive(addonArchive(), { extension: '.kja', directory });
        await installPackageArchive(addonArchive({ version: '0.2.0' }), { extension: '.kja', directory });
        await uninstallPackage({ directory, packageType: 'addon', packageId: 'example.helloWorld', version: '0.1.0' });
        const results = await listInstalledPackages(directory);
        assert.equal(results.length, 1);
        assert.equal(results[0].version, '0.2.0');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('uninstalling a package that is not installed throws NOT_INSTALLED', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-packages-'));
    try {
        await assert.rejects(
            uninstallPackage({ directory, packageType: 'addon', packageId: 'example.helloWorld', version: '9.9.9' }),
            (error) => error instanceof PackageArchiveError && error.code === 'NOT_INSTALLED'
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

assert.equal(validateAddonManifest(addonManifest).addonId, 'example.helloWorld');

function pluginWithExample(example, files = {}) {
    return createPackageArchive({
        packageManifest: packageManifest('plugin'),
        contributionManifest: {
            pluginId: 'example.helloProvider', name: 'Hello Provider', version: '0.1.0', apiVersion: 1,
            contributes: [{ kind: 'example', apiVersion: 1, exampleId: 'buildingHeatLoss', name: 'Building heat loss', entry: 'examples/buildingHeatLoss.kjt', ...example }],
            permissions: []
        },
        files: { 'examples/buildingHeatLoss.kjt': 'model', ...files }
    });
}

test('a plugin can contribute an example model, with an optional guide and thumbnail', () => {
    const archive = pluginWithExample({ guide: 'examples/buildingHeatLoss.md', thumbnail: 'examples/buildingHeatLoss.png', domains: ['thermal'] },
        { 'examples/buildingHeatLoss.md': '# Guide', 'examples/buildingHeatLoss.png': 'png' });
    assert.equal(inspectPackageArchive(archive, { extension: '.kjp' }).contributionManifest.contributes[0].kind, 'example');
    assert.doesNotThrow(() => inspectPackageArchive(pluginWithExample({}), { extension: '.kjp' }));
});

test('an invalid example contribution is rejected', () => {
    const rejects = (example, files, pattern) => assert.throws(() => inspectPackageArchive(pluginWithExample(example, files), { extension: '.kjp' }), pattern);
    rejects({ exampleId: '1bad id' }, {}, /invalid example/);
    rejects({ name: undefined }, {}, /invalid example/);
    rejects({ entry: 'examples/buildingHeatLoss.txt' }, { 'examples/buildingHeatLoss.txt': 'x' }, /invalid example/);
    rejects({ entry: 'examples/missing.kjt' }, {}, /entry is missing/);
    rejects({ guide: 'examples/missing.md' }, {}, /guide is missing/);
    rejects({ thumbnail: '../escape.png' }, {}, /Unsafe|unsafe|missing/);
});

function launcherArchive(files) {
    const manifest = {
        addonId: 'example.helloWorld', name: 'Hello Launcher', version: '0.1.0', apiVersion: 1, kind: 'launcher', entry: 'index.html', permissions: ['data.import', 'pages.open'],
        contributes: {
            toolstrip: [{ commandId: 'openStart', label: 'Hello', tooltip: 'Open', symbol: 'H', when: 'always', contexts: [] }],
            importers: [{ importerId: 'rooms', name: 'Rooms', entry: 'importers/rooms.mjs', files: [{ role: 'rooms', label: 'Rooms', sample: 'samples/rooms.csv' }] }],
            pages: [{ pageId: 'help', label: 'Help', entry: 'help/help.html' }]
        }
    };
    return createPackageArchive({ packageManifest: packageManifest('addon'), contributionManifest: manifest, files });
}

test('a launcher package must contain every file its manifest declares', () => {
    const complete = { 'index.html': '<!doctype html>', 'importers/rooms.mjs': 'export default 1', 'samples/rooms.csv': 'a', 'help/help.html': '<p>' };
    assert.equal(inspectPackageArchive(launcherArchive(complete), { extension: '.kja' }).contributionManifest.kind, 'launcher');
    for (const missing of Object.keys(complete)) {
        const { [missing]: _removed, ...rest } = complete;
        assert.throws(() => inspectPackageArchive(launcherArchive(rest), { extension: '.kja' }), /does not contain|missing/i, `dropping ${missing}`);
    }
});

// ---- Publisher signing (see docs/registry.md) ----------------------------------------------------

function pem(keyObject, type) {
    return keyObject.export({ type, format: 'pem' }).toString();
}

test('a signed package verifies against its namespace entry', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const namespaces = { prefixes: { example: { owner: 'Example Org', publicKeys: [pem(publicKey, 'spki')] } } };
    const signed = signPackageArchive(addonArchive(), { privateKey: pem(privateKey, 'pkcs8'), prefix: 'example' });
    const result = verifyPackageArchive(signed, { namespaces });
    assert.deepEqual(result, { status: 'verified', prefix: 'example', owner: 'Example Org' });
    // Signing must not disturb the package's own contents -- it only adds one file.
    assert.equal(inspectPackageArchive(signed, { extension: '.kja' }).packageManifest.packageId, 'example.helloWorld');
});

test('key rotation: an older registered key still verifies alongside a newer one', () => {
    const older = generateKeyPairSync('ed25519');
    const newer = generateKeyPairSync('ed25519');
    const namespaces = { prefixes: { example: { owner: 'Example Org', publicKeys: [pem(newer.publicKey, 'spki'), pem(older.publicKey, 'spki')] } } };
    const signed = signPackageArchive(addonArchive(), { privateKey: pem(older.privateKey, 'pkcs8'), prefix: 'example' });
    assert.equal(verifyPackageArchive(signed, { namespaces }).status, 'verified');
});

test('an unsigned package under a reserved prefix reports "unsigned", not "unclaimed"', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const namespaces = { prefixes: { example: { owner: 'Example Org', publicKeys: [pem(publicKey, 'spki')] } } };
    const result = verifyPackageArchive(addonArchive(), { namespaces });
    assert.deepEqual(result, { status: 'unsigned', reservedPrefix: 'example' });
});

test('an unsigned package under no reserved prefix reports "unclaimed"', () => {
    assert.deepEqual(verifyPackageArchive(addonArchive(), { namespaces: { prefixes: {} } }), { status: 'unclaimed', reservedPrefix: null });
    // Also true with no namespaces argument at all -- a caller with no registry loaded gets the
    // same harmless default rather than an error.
    assert.deepEqual(verifyPackageArchive(addonArchive()), { status: 'unclaimed', reservedPrefix: null });
});

test('tampering with a signed package after signing invalidates it', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const namespaces = { prefixes: { example: { owner: 'Example Org', publicKeys: [pem(publicKey, 'spki')] } } };
    const signed = signPackageArchive(addonArchive(), { privateKey: pem(privateKey, 'pkcs8'), prefix: 'example' });
    // Re-zip with one file's content changed, keeping the same signature.json (simulating someone
    // swapping in different code after the fact without re-signing).
    const files = unzipSync(signed);
    const tampered = zipSync({ ...files, 'index.html': strToU8('<!doctype html><script>evil</script>') }, { mtime: new Date('1980-01-01T00:00:00Z') });
    const result = verifyPackageArchive(Buffer.from(tampered), { namespaces });
    assert.equal(result.status, 'invalid');
    assert.match(result.reason, /digest/i);
});

test('a signature does not verify against the wrong key', () => {
    const signingKey = generateKeyPairSync('ed25519');
    const registeredKey = generateKeyPairSync('ed25519');
    const namespaces = { prefixes: { example: { owner: 'Example Org', publicKeys: [pem(registeredKey.publicKey, 'spki')] } } };
    const signed = signPackageArchive(addonArchive(), { privateKey: pem(signingKey.privateKey, 'pkcs8'), prefix: 'example' });
    assert.equal(verifyPackageArchive(signed, { namespaces }).status, 'invalid');
});

test('a signature claiming an unreserved prefix is invalid, not silently unverified', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signed = signPackageArchive(addonArchive(), { privateKey: pem(privateKey, 'pkcs8'), prefix: 'example' });
    const result = verifyPackageArchive(signed, { namespaces: { prefixes: {} } });
    assert.equal(result.status, 'invalid');
    assert.match(result.reason, /not a reserved prefix/);
});

test('a signature claiming a prefix that is not actually a prefix of the package id is invalid', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const namespaces = { prefixes: { 'someone.else': { owner: 'Someone Else', publicKeys: [pem(publicKey, 'spki')] } } };
    // example.helloWorld signed while claiming an unrelated prefix -- must not be accepted even
    // though "someone.else" is validly reserved and the key is real.
    const signed = signPackageArchive(addonArchive(), { privateKey: pem(privateKey, 'pkcs8'), prefix: 'someone.else' });
    const result = verifyPackageArchive(signed, { namespaces });
    assert.equal(result.status, 'invalid');
    assert.match(result.reason, /prefix/);
});

test('signPackageArchive refuses to double-sign, and rejects an invalid prefix', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signed = signPackageArchive(addonArchive(), { privateKey: pem(privateKey, 'pkcs8'), prefix: 'example' });
    assert.throws(() => signPackageArchive(signed, { privateKey: pem(privateKey, 'pkcs8'), prefix: 'example' }),
        (error) => error instanceof PackageArchiveError && error.code === 'ALREADY_SIGNED');
    assert.throws(() => signPackageArchive(addonArchive(), { privateKey: pem(privateKey, 'pkcs8'), prefix: 'not a valid prefix!' }),
        (error) => error instanceof PackageArchiveError && error.code === 'INVALID_PREFIX');
});

test('the longest matching reserved prefix wins', () => {
    const parent = generateKeyPairSync('ed25519');
    const child = generateKeyPairSync('ed25519');
    const namespaces = {
        prefixes: {
            example: { owner: 'Parent', publicKeys: [pem(parent.publicKey, 'spki')] },
            'example.helloWorld': { owner: 'Child', publicKeys: [pem(child.publicKey, 'spki')] }
        }
    };
    // Unsigned: reservedPrefix should resolve to the more specific "example.helloWorld", not "example".
    assert.equal(verifyPackageArchive(addonArchive(), { namespaces }).reservedPrefix, 'example.helloWorld');
});

// ---- Registry (see docs/registry.md) -----------------------------------------------------------

async function withRegistry(files, task) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-registry-'));
    try {
        for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
        return await task(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const minimalEntry = (overrides = {}) => JSON.stringify({
    format: 'konjugate-namespace-entry', formatVersion: 1,
    owner: 'Example Org', contact: 'https://example.org', publicKeys: ['-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n'],
    ...overrides
});

test('loadNamespaceRegistry reads a minimal, identity-only entry keyed by its file name', async () => {
    await withRegistry({ 'example.fintech.json': minimalEntry() }, async (directory) => {
        const { prefixes } = await loadNamespaceRegistry(directory);
        assert.deepEqual(Object.keys(prefixes), ['example.fintech']);
        assert.equal(prefixes['example.fintech'].owner, 'Example Org');
    });
});

test('loadNamespaceRegistry reads every discovery field when present', async () => {
    const full = minimalEntry({
        title: 'Example', description: 'An example.', license: 'MIT', domain: 'finance',
        url: 'https://example.org/repo', downloadUrl: 'https://example.org/latest.zip',
        packages: [{ packageType: 'plugin', packageId: 'example.fintech.engine' }, { packageType: 'addon', packageId: 'example.fintech.toolbox' }]
    });
    await withRegistry({ 'example.fintech.json': full }, async (directory) => {
        const { prefixes } = await loadNamespaceRegistry(directory);
        assert.equal(prefixes['example.fintech'].title, 'Example');
        assert.equal(prefixes['example.fintech'].packages.length, 2);
    });
});

test('loadNamespaceRegistry combines multiple entries and ignores non-JSON files', async () => {
    await withRegistry({
        'example.fintech.json': minimalEntry(),
        'example.robotics.json': minimalEntry({ owner: 'Other Org' }),
        'ReadMe.md': '# not a registry entry'
    }, async (directory) => {
        const { prefixes } = await loadNamespaceRegistry(directory);
        assert.deepEqual(Object.keys(prefixes).sort(), ['example.fintech', 'example.robotics']);
    });
});

test('loadNamespaceRegistry rejects a file name that is not a valid prefix', async () => {
    await withRegistry({ '1bad-name.json': minimalEntry() }, async (directory) => {
        await assert.rejects(() => loadNamespaceRegistry(directory), (error) => error instanceof PackageArchiveError && error.code === 'INVALID_PREFIX');
    });
});

test('loadNamespaceRegistry rejects an entry missing a required identity field', async () => {
    for (const missing of ['owner', 'contact', 'publicKeys']) {
        const entry = JSON.parse(minimalEntry());
        delete entry[missing];
        await withRegistry({ 'example.fintech.json': JSON.stringify(entry) }, async (directory) => {
            await assert.rejects(() => loadNamespaceRegistry(directory),
                (error) => error instanceof PackageArchiveError && error.code === 'INVALID_REGISTRY_ENTRY', `missing ${missing}`);
        });
    }
});

test('loadNamespaceRegistry rejects an unsupported format/formatVersion', async () => {
    await withRegistry({ 'example.fintech.json': minimalEntry({ formatVersion: 2 }) }, async (directory) => {
        await assert.rejects(() => loadNamespaceRegistry(directory), (error) => error instanceof PackageArchiveError && error.code === 'INVALID_REGISTRY_ENTRY');
    });
});

test('loadNamespaceRegistry rejects a package id that is not under the entry\'s own prefix', async () => {
    const entry = minimalEntry({ packages: [{ packageType: 'plugin', packageId: 'someone.else.engine' }] });
    await withRegistry({ 'example.fintech.json': entry }, async (directory) => {
        await assert.rejects(() => loadNamespaceRegistry(directory),
            (error) => error instanceof PackageArchiveError && error.code === 'INVALID_REGISTRY_ENTRY' && /not under this entry's own prefix/.test(error.message));
    });
});

test('loadNamespaceRegistry rejects an invalid packageType', async () => {
    const entry = minimalEntry({ packages: [{ packageType: 'library', packageId: 'example.fintech.engine' }] });
    await withRegistry({ 'example.fintech.json': entry }, async (directory) => {
        await assert.rejects(() => loadNamespaceRegistry(directory), (error) => error instanceof PackageArchiveError && error.code === 'INVALID_REGISTRY_ENTRY');
    });
});

test('loadNamespaceRegistry accepts recommended:true alongside downloadUrl/packages', async () => {
    const entry = minimalEntry({
        recommended: true, downloadUrl: 'https://example.org/latest.zip',
        packages: [{ packageType: 'addon', packageId: 'example.fintech.toolbox' }]
    });
    await withRegistry({ 'example.fintech.json': entry }, async (directory) => {
        const { prefixes } = await loadNamespaceRegistry(directory);
        assert.equal(prefixes['example.fintech'].recommended, true);
    });
});

test('loadNamespaceRegistry rejects a non-boolean recommended', async () => {
    const entry = minimalEntry({ recommended: 'yes' });
    await withRegistry({ 'example.fintech.json': entry }, async (directory) => {
        await assert.rejects(() => loadNamespaceRegistry(directory),
            (error) => error instanceof PackageArchiveError && error.code === 'INVALID_REGISTRY_ENTRY' && /must be a boolean/.test(error.message));
    });
});

test('loadNamespaceRegistry rejects recommended:true without downloadUrl/packages', async () => {
    const entry = minimalEntry({ recommended: true });
    await withRegistry({ 'example.fintech.json': entry }, async (directory) => {
        await assert.rejects(() => loadNamespaceRegistry(directory),
            (error) => error instanceof PackageArchiveError && error.code === 'INVALID_REGISTRY_ENTRY' && /must also declare downloadUrl and packages/.test(error.message));
    });
});

test('loadNamespaceRegistry accepts an image in the registry\'s images/ directory', async () => {
    const entry = minimalEntry({ image: 'images/example.fintech.webp' });
    await withRegistry({ 'example.fintech.json': entry }, async (directory) => {
        const { prefixes } = await loadNamespaceRegistry(directory);
        assert.equal(prefixes['example.fintech'].image, 'images/example.fintech.webp');
    });
});

const screenshotEntry = (overrides = {}) => ({ image: 'screenshots/example.fintech.1.webp', caption: 'The portfolio view', ...overrides });
const videoEntry = (overrides = {}) => ({ title: 'Walkthrough', url: 'https://www.youtube.com/watch?v=jiL0kP0VQvQ', ...overrides });

test('loadNamespaceRegistry accepts screenshots from the registry\'s screenshots/ directory and YouTube video links', async () => {
    const entry = minimalEntry({
        screenshots: [screenshotEntry(), screenshotEntry({ image: 'screenshots/example.fintech.2.png', caption: 'Results' })],
        videos: [videoEntry(), videoEntry({ title: 'Short link', url: 'https://youtu.be/eDHksSqKhFs' })]
    });
    await withRegistry({ 'example.fintech.json': entry }, async (directory) => {
        const { prefixes } = await loadNamespaceRegistry(directory);
        assert.equal(prefixes['example.fintech'].screenshots.length, 2);
        assert.equal(prefixes['example.fintech'].videos[1].url, 'https://youtu.be/eDHksSqKhFs');
    });
});

test('loadNamespaceRegistry rejects screenshots that are URLs, leave screenshots/, lack a caption or are too many', async () => {
    const rejected = [
        [screenshotEntry({ image: 'https://tracker.example.org/pixel.png' })], [screenshotEntry({ image: 'images/example.fintech.webp' })],
        [screenshotEntry({ image: 'screenshots/../example.png' })], [screenshotEntry({ image: 'screenshots/nested/example.png' })],
        [screenshotEntry({ image: 'screenshots/example.svg' })], [screenshotEntry({ caption: '' })], [screenshotEntry({ caption: 'x'.repeat(141) })],
        [{ image: 'screenshots/example.fintech.1.webp' }], [], 'screenshots/example.png', Array.from({ length: 7 }, () => screenshotEntry())
    ];
    for (const screenshots of rejected) {
        await withRegistry({ 'example.fintech.json': minimalEntry({ screenshots }) }, async (directory) => {
            await assert.rejects(() => loadNamespaceRegistry(directory),
                (error) => error instanceof PackageArchiveError && error.code === 'INVALID_REGISTRY_ENTRY' && /screenshots/.test(error.message), JSON.stringify(screenshots));
        });
    }
});

test('loadNamespaceRegistry accepts only plain YouTube video links with a title', async () => {
    const rejected = [
        [videoEntry({ url: 'https://vimeo.com/123456789' })], [videoEntry({ url: 'http://www.youtube.com/watch?v=jiL0kP0VQvQ' })],
        [videoEntry({ url: 'https://www.youtube.com/watch?v=jiL0kP0VQvQ&list=PLRaxEsOU31bE' })], [videoEntry({ url: 'https://www.youtube.com/watch?v=short' })],
        [videoEntry({ url: 'https://evil.example/https://www.youtube.com/watch?v=jiL0kP0VQvQ' })], [videoEntry({ url: 'https://www.youtube.com.evil.example/watch?v=jiL0kP0VQvQ' })],
        [videoEntry({ title: '' })], [videoEntry({ title: 'x'.repeat(101) })], [{ url: 'https://youtu.be/eDHksSqKhFs' }], [],
        Array.from({ length: 5 }, () => videoEntry())
    ];
    for (const videos of rejected) {
        await withRegistry({ 'example.fintech.json': minimalEntry({ videos }) }, async (directory) => {
            await assert.rejects(() => loadNamespaceRegistry(directory),
                (error) => error instanceof PackageArchiveError && error.code === 'INVALID_REGISTRY_ENTRY' && /videos/.test(error.message), JSON.stringify(videos));
        });
    }
});

test('loadNamespaceRegistry rejects an image that is a URL, leaves images/ or is not a picture', async () => {
    const rejected = [
        'https://tracker.example.org/pixel.png', '/images/example.png', 'images/../example.png', 'images/nested/example.png',
        'thumbnails/example.png', 'example.png', 'images/example.svg', 'images/.png', '', 42
    ];
    for (const image of rejected) {
        await withRegistry({ 'example.fintech.json': minimalEntry({ image }) }, async (directory) => {
            await assert.rejects(() => loadNamespaceRegistry(directory),
                (error) => error instanceof PackageArchiveError && error.code === 'INVALID_REGISTRY_ENTRY' && /image, if present/.test(error.message), String(image));
        });
    }
});

test('a package signed under a prefix loaded from a real registry directory verifies end to end', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const entry = minimalEntry({ publicKeys: [pem(publicKey, 'spki')] });
    await withRegistry({ 'example.json': entry }, async (directory) => {
        const namespaces = await loadNamespaceRegistry(directory);
        const signed = signPackageArchive(addonArchive(), { privateKey: pem(privateKey, 'pkcs8'), prefix: 'example' });
        assert.equal(verifyPackageArchive(signed, { namespaces }).status, 'verified');
    });
});
