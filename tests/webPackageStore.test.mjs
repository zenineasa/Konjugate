/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { strToU8 } from 'fflate';
import { missingPluginReferences, pluginReferencesIn } from '../src/pluginReferences.mjs';
import { createPackageArchive, PackageArchiveError } from '../src/packageArchive.mjs';
import { pluginProviderChoices } from '../src/pluginProviders.mjs';
import { createMemoryStorage, createPackageStore, webPackageRefusal } from '../src/webPackageStore.mjs';

const batteryTemplate = JSON.parse(await readFile(new URL('../assets/componentLibrary/battery.json', import.meta.url), 'utf8'));

function pluginPackage({ version = '1.0.0', contributes, files = {}, minimumKonjugateVersion } = {}) {
    return createPackageArchive({
        packageManifest: {
            format: 'konjugate-package', formatVersion: 1, packageType: 'plugin', packageId: 'example.parts', name: 'Parts', version,
            contents: { manifest: 'plugin.json' }, ...(minimumKonjugateVersion ? { minimumKonjugateVersion } : {})
        },
        contributionManifest: { pluginId: 'example.parts', name: 'Parts', version, apiVersion: 1, permissions: [], contributes },
        files
    });
}

const componentPlugin = (version = '1.0.0') => pluginPackage({
    version,
    contributes: [{ kind: 'component', componentId: batteryTemplate.id, apiVersion: 1, entry: 'battery.json' }],
    files: { 'battery.json': strToU8(JSON.stringify(batteryTemplate)) }
});

const store = (options = {}) => createPackageStore({ storage: createMemoryStorage(), appVersion: '1.3.4', ...options });

test('a plugin that contributes only components installs, lists as enabled, and its template reaches the library', async () => {
    const packages = store();
    const installed = await packages.install(componentPlugin(), '.kjp');
    assert.equal(installed.packageManifest.packageId, 'example.parts');
    const [entry] = await packages.list();
    assert.deepEqual([entry.packageType, entry.packageId, entry.version, entry.source, entry.enabled], ['plugin', 'example.parts', '1.0.0', 'installed', true]);
    const templates = await packages.pluginComponentTemplates();
    assert.equal(templates.length, 1);
    assert.deepEqual([templates[0].id, templates[0].source, templates[0].pluginId, templates[0].pluginVersion], [batteryTemplate.id, 'plugin', 'example.parts', '1.0.0']);
});

test('a template whose id a bundled one already has is skipped and the others still load', async () => {
    const packages = store();
    await packages.install(componentPlugin(), '.kjp');
    assert.deepEqual(await packages.pluginComponentTemplates(new Set([batteryTemplate.id])), []);
});

test('disabling a plugin takes its components out and enabling brings them back; uninstalling forgets the setting', async () => {
    const packages = store();
    await packages.install(componentPlugin(), '.kjp');
    await packages.setEnabled('plugin', 'example.parts', '1.0.0', false);
    assert.equal((await packages.list())[0].enabled, false);
    assert.deepEqual(await packages.pluginComponentTemplates(), []);
    await packages.setEnabled('plugin', 'example.parts', '1.0.0', true);
    assert.equal((await packages.pluginComponentTemplates()).length, 1);
    await packages.setEnabled('plugin', 'example.parts', '1.0.0', false);
    await packages.uninstall('plugin', 'example.parts', '1.0.0');
    assert.deepEqual(await packages.list(), []);
    await packages.install(componentPlugin(), '.kjp');
    assert.equal((await packages.list())[0].enabled, true);
});

test('installing a newer version replaces the older one, and installing the same version twice is refused', async () => {
    const packages = store();
    await packages.install(componentPlugin('1.0.0'), '.kjp');
    await assert.rejects(packages.install(componentPlugin('1.0.0'), '.kjp'), { code: 'ALREADY_INSTALLED' });
    await packages.install(componentPlugin('1.1.0'), '.kjp');
    assert.deepEqual((await packages.list()).map((entry) => entry.version), ['1.1.0']);
});

test('a plugin none of whose parts can run here is refused at install, with the reason, and nothing is written', async () => {
    const packages = store();
    const cppOnly = pluginPackage({ contributes: [{ providerId: 'example.q', apiVersion: 1, runtime: 'cpp', entry: 'q.cpp' }], files: { 'q.cpp': strToU8('int x;') } });
    await assert.rejects(packages.install(cppOnly, '.kjp'), (error) => error instanceof PackageArchiveError && error.code === 'UNSUPPORTED_IN_WEB' && /C\+\+/.test(error.message));
    assert.deepEqual(await packages.list(), []);
    assert.match(webPackageRefusal({ packageType: 'addon' }, { kind: 'launcher', addonId: 'example.l', name: 'L', version: '1.0.0', apiVersion: 1, entry: 'i.html', requires: ['pythonCheck'], contributes: { toolstrip: [{ commandId: 'open', label: 'L', tooltip: 'L', when: 'always' }] } }), /pythonCheck/);
    assert.equal(webPackageRefusal({ packageType: 'plugin' }, { contributes: [{ kind: 'example' }] }), null);
    assert.equal(webPackageRefusal({ packageType: 'plugin' }, { contributes: [{ providerId: 'p', runtime: 'python' }] }), null);
});

test('a plugin with Python and C++ providers installs for the first, and the review is told of the rest', async () => {
    const packages = store();
    const mixed = pluginPackage({
        contributes: [
            { providerId: 'example.py', apiVersion: 1, runtime: 'python', entry: 'p.py' },
            { providerId: 'example.cc', apiVersion: 1, runtime: 'cpp', entry: 'q.cpp' }
        ],
        files: { 'p.py': strToU8('x = 1'), 'q.cpp': strToU8('int x;') }
    });
    const inspected = packages.inspect(mixed, '.kjp');
    assert.equal(inspected.refusal, null);
    assert.match(inspected.notes[0], /1 of its providers \(C\+\+\)/);
    await packages.install(mixed, '.kjp');
    const [entry] = await packages.list();
    assert.deepEqual(entry.runnableRuntimes, ['python']);
    assert.deepEqual(pluginProviderChoices([entry]).map((choice) => choice.reference.providerId), ['example.py']);
});

test('a package that needs a newer Konjugate is refused as the desktop refuses it', async () => {
    const packages = store();
    const archive = pluginPackage({ minimumKonjugateVersion: '9.0.0', contributes: [{ kind: 'component', componentId: batteryTemplate.id, apiVersion: 1, entry: 'battery.json' }], files: { 'battery.json': strToU8(JSON.stringify(batteryTemplate)) } });
    await assert.rejects(packages.install(archive, '.kjp'), { code: 'INCOMPATIBLE_APP_VERSION' });
});

test('a broken archive and the wrong extension are refused before anything is stored', async () => {
    const packages = store();
    await assert.rejects(packages.install(strToU8('not a zip'), '.kjp'), PackageArchiveError);
    await assert.rejects(packages.install(componentPlugin(), '.kja'), { code: 'PACKAGE_TYPE_MISMATCH' });
    assert.deepEqual(await packages.list(), []);
});

test('example models a plugin contributes are listed under their .kjt names, and one that repeats a bundled name is skipped', async () => {
    const packages = store();
    await packages.install(pluginPackage({
        contributes: [
            { kind: 'example', exampleId: 'springDemo', apiVersion: 1, name: 'Spring demo', entry: 'springDemo.kjt', guide: 'springDemo.md', domains: ['mechanical'], description: 'A spring.' },
            { kind: 'example', exampleId: 'fourBarLinkage', apiVersion: 1, name: 'Clash', entry: 'clash.kjt' }
        ],
        files: { 'springDemo.kjt': strToU8('project'), 'springDemo.md': strToU8('# Guide'), 'clash.kjt': strToU8('project') }
    }), '.kjp');
    const examples = await packages.pluginExamples(new Set(['fourBarLinkage.kjt']));
    assert.deepEqual([...examples.keys()], ['springDemo.kjt']);
    const example = examples.get('springDemo.kjt');
    assert.deepEqual([example.name, example.domains, example.pluginId], ['Spring demo', ['mechanical'], 'example.parts']);
    assert.equal(new TextDecoder().decode(await packages.readFile(example.packageEntry, example.entry)), 'project');
    assert.equal(new TextDecoder().decode(await packages.readFile(example.packageEntry, example.guide)), '# Guide');
});

test('a path that leaves the package is never read', async () => {
    const packages = store();
    await packages.install(componentPlugin(), '.kjp');
    const [entry] = await packages.list();
    await assert.rejects(packages.readFile(entry, '../../state.json'), { code: 'UNSAFE_PATH' });
});

test('a copy an earlier attempt left half written is not listed and is cleared by the next install', async () => {
    const storage = createMemoryStorage();
    await storage.write('packages/plugins/example.parts/1.0.0/battery.json', strToU8('{}'));
    const packages = createPackageStore({ storage, appVersion: '1.3.4' });
    assert.deepEqual(await packages.list(), []);
    await packages.install(componentPlugin(), '.kjp');
    assert.equal((await packages.list()).length, 1);
    assert.equal((await packages.pluginComponentTemplates()).length, 1);
});

const providerPlugin = (version = '1.0.0', providers = [{ providerId: 'example.py', apiVersion: 1, runtime: 'python', entry: 'p.py' }]) => pluginPackage({
    version, contributes: providers, files: { 'p.py': strToU8('PYTHON SOURCE'), 'q.cpp': strToU8('int x;') }
});

const reference = (overrides = {}) => ({ kind: 'plugin', pluginId: 'example.parts', pluginVersion: '1.0.0', providerId: 'example.py', providerApiVersion: 1, bindings: [], ...overrides });
const model = (implementation) => ({ nodes: [{ id: 1, sourceTerms: [{ id: 2, implementation }] }], edges: [{ id: 3, implementation }] });

test('a reference to an installed Python provider resolves to its source text, inline, in a node\'s source terms and in edges', async () => {
    const packages = store();
    await packages.install(providerPlugin(), '.kjp');
    const resolved = JSON.parse(await packages.resolveModel(model(reference())));
    for (const implementation of [resolved.nodes[0].sourceTerms[0].implementation, resolved.edges[0].implementation]) {
        assert.deepEqual([implementation.kind, implementation.source, implementation.providerApiVersion, implementation.pluginId], ['python', 'PYTHON SOURCE', 1, 'example.parts']);
    }
});

test('a model that names no plugin comes back as it was', async () => {
    const packages = store();
    const text = JSON.stringify({ nodes: [], edges: [] });
    assert.equal(await packages.resolveModel(text), text);
});

test('a reference that cannot be resolved says why, with the desktop\'s codes', async () => {
    const packages = store();
    const code = (implementation) => packages.resolveProvider(implementation).then(() => null, (error) => error.code);
    assert.equal(await code(reference()), 'PLUGIN_NOT_INSTALLED');
    assert.equal(await code({ kind: 'plugin' }), 'PLUGIN_REFERENCE_INVALID');
    await packages.install(providerPlugin('1.0.0', [
        { providerId: 'example.py', apiVersion: 1, runtime: 'python', entry: 'p.py' },
        { providerId: 'example.cc', apiVersion: 1, runtime: 'cpp', entry: 'q.cpp' }
    ]), '.kjp');
    assert.equal(await code(reference({ pluginVersion: '2.0.0' })), 'PLUGIN_NOT_INSTALLED');
    assert.equal(await code(reference({ providerId: 'example.nope' })), 'PLUGIN_PROVIDER_MISSING');
    assert.equal(await code(reference({ providerId: 'example.cc' })), 'PLUGIN_RUNTIME_UNSUPPORTED');
    await packages.setEnabled('plugin', 'example.parts', '1.0.0', false);
    assert.equal(await code(reference()), 'PLUGIN_DISABLED');
});

test('which plugins a model needs that are not usable, and why', () => {
    const installed = [
        { packageType: 'plugin', packageId: 'example.here', version: '1.0.0', enabled: true },
        { packageType: 'plugin', packageId: 'example.off', version: '1.0.0', enabled: false },
        { packageType: 'plugin', packageId: 'example.old', version: '1.0.0', enabled: true },
        { packageType: 'plugin', packageId: 'example.new', version: '1.0.0', enabled: false, incompatible: { required: '9.0.0', running: '1.3.4' } }
    ];
    const use = (pluginId, pluginVersion) => ({ id: pluginId, sourceTerms: [{ implementation: reference({ pluginId, pluginVersion }) }] });
    const document = { nodes: [use('example.here', '1.0.0'), use('example.off', '1.0.0'), use('example.old', '2.0.0'), use('example.gone', '1.0.0'), use('example.new', '1.0.0')], edges: [] };
    const missing = missingPluginReferences(document, installed);
    assert.deepEqual(missing.map((item) => [item.pluginId, item.reason]), [['example.off', 'disabled'], ['example.old', 'other-version'], ['example.gone', 'not-installed'], ['example.new', 'incompatible']]);
    assert.deepEqual(missing[1].installedVersions, ['1.0.0']);
    assert.deepEqual(pluginReferencesIn(document).length, 5);
    assert.deepEqual(missingPluginReferences({ nodes: [], edges: [] }, installed), []);
});
