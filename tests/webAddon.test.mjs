/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8 } from 'fflate';
import { createPackageArchive } from '../src/packageArchive.mjs';
import { createVisualizerSession } from '../src/addonHost.mjs';
import { createVisualizerBridge, webAddonRefusal } from '../src/webAddonBridge.mjs';
import { buildAddonDocument, frameApiSource, packagePath } from '../src/webAddonDocument.mjs';
import { createMemoryStorage, createPackageStore } from '../src/webPackageStore.mjs';

const visualizerManifest = (overrides = {}) => ({
    kind: 'resultVisualizer', addonId: 'example.viewer', name: 'Viewer', version: '1.0.0', apiVersion: 1, entry: 'index.html',
    permissions: ['results.read', 'timeline.read', 'timeline.seek', 'selection.read', 'results.export'],
    contributes: { toolstrip: [{ commandId: 'open', label: 'Viewer', tooltip: 'Open the viewer', when: 'resultsActive', contexts: ['resultSession'] }] },
    ...overrides
});

const viewerPackage = (manifest = visualizerManifest(), files = { 'index.html': strToU8('<html><head></head><body>hi</body></html>') }) => createPackageArchive({
    packageManifest: { format: 'konjugate-package', formatVersion: 1, packageType: 'addon', packageId: manifest.addonId, name: manifest.name, version: manifest.version, contents: { manifest: 'addon.json' } },
    contributionManifest: manifest,
    files
});

const session = () => createVisualizerSession({
    sessionId: 's1', projectName: 'Tank', engineJobId: 'j1', selectedNodeId: null,
    result: { configurationName: 'run', targetTime: 4, outputInterval: 1, lifecycle: 'completed', availableResultTime: 4, samples: [0, 1, 2, 3, 4].map((time) => ({ time, states: [{ stateId: 'tank.level', value: time * 2 }] })) },
    nodes: [{ id: 'tank', title: 'Tank', states: [{ id: 'tank.level', label: 'Level', symbol: 'h', unit: 'm' }] }]
});

function bridgeFor(permissions, extra = {}) {
    const stored = new Map();
    const seeks = [];
    const saved = [];
    const bridge = createVisualizerBridge({
        manifest: visualizerManifest({ permissions }), session: session(),
        settings: { get: async (id) => stored.get(id) ?? null, set: async (id, value) => { value === null ? stored.delete(id) : stored.set(id, value); } },
        saveCsv: async (name, text) => saved.push([name, text]),
        requestSeek: (time) => seeks.push(time),
        ...extra
    });
    return { bridge, stored, seeks, saved };
}

test('a visualizer that needs nothing the web lacks is accepted, and what it cannot have is turned away saying why', () => {
    assert.equal(webAddonRefusal(visualizerManifest()), null);
    assert.match(webAddonRefusal(visualizerManifest({ permissions: ['results.read', 'simulation.pacing.control'] })), /simulation\.pacing\.control/);
    assert.match(webAddonRefusal(visualizerManifest({ permissions: ['project.data'], requires: ['projectData'] })), /project\.data/);
    assert.match(webAddonRefusal(visualizerManifest({ requires: ['projectData'] })), /projectData/);
    assert.match(webAddonRefusal({ kind: 'somethingElse' }), /neither a result visualizer nor a launcher/);
    assert.match(webAddonRefusal(visualizerManifest({ entry: '../x.html' })), /entry/);
});

test('an add-on installs from a file, lists as a visualizer, can be disabled, and takes its settings with its last version', async () => {
    const packages = createPackageStore({ storage: createMemoryStorage(), appVersion: '1.3.4' });
    await packages.install(viewerPackage(), '.kja');
    assert.equal((await packages.runnableAddons()).length, 1);
    await packages.setEnabled('addon', 'example.viewer', '1.0.0', false);
    assert.equal((await packages.runnableAddons()).length, 0);
    await packages.setEnabled('addon', 'example.viewer', '1.0.0', true);
    await packages.setAddonSettings('example.viewer', { theme: 'dark' });
    await packages.install(viewerPackage(visualizerManifest({ version: '1.1.0' })), '.kja');
    assert.deepEqual(await packages.getAddonSettings('example.viewer'), { theme: 'dark' });
    await packages.uninstall('addon', 'example.viewer', '1.1.0');
    assert.equal(await packages.getAddonSettings('example.viewer'), null);
    await assert.rejects(packages.install(viewerPackage(visualizerManifest({ permissions: ['project.data'] })), '.kja'), /project\.data/);
});

test('every read answers as the desktop does, and with no results.read gives nothing away', async () => {
    const { bridge } = bridgeFor(['results.read']);
    assert.equal((await bridge.call('getContext')).projectName, 'Tank');
    assert.equal((await bridge.call('listSignals'))[0].signalId, 'tank.level');
    const [series] = await bridge.call('readSeries', { signalIds: ['tank.level'] });
    assert.equal(series.points?.length ?? series.samples?.length ?? series.values?.length, 5);
    const none = bridgeFor([]).bridge;
    assert.equal(await none.call('getContext'), null);
    assert.deepEqual(await none.call('listSignals'), []);
    assert.deepEqual(await none.call('readSeries', { signalIds: ['tank.level'] }), []);
    assert.deepEqual(await none.call('getParameterChanges'), []);
});

test('a call without its permission is refused and does nothing', async () => {
    const { bridge, seeks, saved, stored } = bridgeFor(['results.read']);
    await bridge.call('seek', { time: 2 });
    assert.deepEqual(seeks, []);
    await assert.rejects(bridge.call('exportCsv', { suggestedFilename: 'a.csv', csv: 'x' }), /permission/);
    assert.deepEqual(saved, []);
    await assert.rejects(bridge.call('setSettings', { settings: { a: 1 } }), /settings\.store/);
    await assert.rejects(bridge.call('getSettings'), /settings\.store/);
    assert.equal(stored.size, 0);
    await assert.rejects(bridge.call('requestPacing', { pacing: { mode: 'fastest' } }), /pacing/);
    await assert.rejects(bridge.call('getProjectData'), /project\.data/);
    await assert.rejects(bridge.call('setProjectData', { data: {} }), /project\.data/);
});

test('seek stays inside the result, export takes a safe file name, settings are size limited', async () => {
    const { bridge, seeks, saved } = bridgeFor(['results.read', 'timeline.seek', 'results.export', 'settings.store']);
    await bridge.call('seek', { time: 99 });
    await bridge.call('seek', { time: -5 });
    await bridge.call('seek', { time: 'abc' });
    assert.deepEqual(seeks, [4, 0]);
    assert.deepEqual(await bridge.call('exportCsv', { suggestedFilename: '../../etc/pass:wd', csv: 'a,b' }), { path: null, fileName: '.._.._etc_pass_wd.csv' });
    assert.equal(saved[0][1], 'a,b');
    await assert.rejects(bridge.call('exportCsv', { csv: 5 }), /file text/);
    await assert.rejects(bridge.call('setSettings', { settings: { big: 'x'.repeat(300 * 1024) } }), /at most/);
    await bridge.call('setSettings', { settings: { ok: true } });
    assert.deepEqual(await bridge.call('getSettings'), { ok: true });
});

test('only the named methods can be reached, whatever the frame sends', async () => {
    const { bridge } = bridgeFor(['results.read']);
    for (const method of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'handlers', undefined, 5, '']) {
        await assert.rejects(bridge.call(method, {}), /Unknown method/);
    }
    await bridge.call('readSeries', { signalIds: [3] });
    await assert.rejects(bridge.call('readSeries', { signalIds: 'tank.level' }), /list of signal ids/);
    await assert.rejects(bridge.call('readSeries', { signalIds: [NaN] }), /list of signal ids/);
    await assert.rejects(bridge.call('readSeries', { signalIds: [{ toString() { return 'x'; } }] }), /list of signal ids/);
});

test('the frame hears of a timeline or selection change only with the permission to read it', () => {
    const { bridge } = bridgeFor(['timeline.read']);
    assert.deepEqual(bridge.event('timeline.change', 3), { channel: 'timelineChange', payload: 3 });
    assert.equal(bridge.event('selection.change', 'tank'), null);
    assert.equal(bridge.event('unheard.of', 1), null);
    assert.equal(bridge.session.selectedNodeId, 'tank');
    assert.deepEqual(bridge.replaceSession(session()), { channel: 'sessionChange', payload: null });
});

test('package paths stay inside the package, and addresses elsewhere are left alone', () => {
    assert.equal(packagePath('app.js', ''), 'app.js');
    assert.equal(packagePath('./js/../app.js?x=1', 'ui/'), 'ui/app.js');
    assert.equal(packagePath('/lib/a.js', 'ui/'), 'lib/a.js');
    assert.equal(packagePath('https://elsewhere.example/a.js', ''), null);
    assert.equal(packagePath('//elsewhere.example/a.js', ''), null);
    assert.equal(packagePath('data:image/png;base64,AA', ''), null);
    assert.equal(packagePath('#top', ''), null);
    assert.throws(() => packagePath('../../outside.js', 'ui/'), /outside the package/);
});

test('the page is built from the package: scripts, styles and images placed in it, the API first, nothing left to fetch', async () => {
    const files = {
        'ui/index.html': '<!doctype html><html><head><link rel="stylesheet" href="style.css"><script src="app.js"></script></head><body><img src="logo.svg"><script src="https://evil.example/x.js"></script></body></html>',
        'ui/style.css': 'body{background:url(bg.png)}',
        'ui/app.js': 'document.title="</script><b>"; // <!--',
        'ui/logo.svg': '<svg/>',
        'ui/bg.png': 'PNG'
    };
    const built = await buildAddonDocument({ entry: 'ui/index.html', readFile: async (path) => (path in files ? strToU8(files[path]) : null) });
    assert.match(built, /<head><script>\(\(\) => \{/);
    assert.ok(built.indexOf('konjugateVisualizer') < built.indexOf('document.title'));
    assert.doesNotMatch(built, /src="app\.js"|href="style\.css"|src="logo\.svg"/);
    assert.match(built, /<style>body\{background:url\("data:image\/png;base64,/);
    assert.match(built, /<img src="data:image\/svg\+xml;base64,/);
    assert.match(built, /<\\\/script><b>/);
    assert.match(built, /src="https:\/\/evil\.example\/x\.js"/);
    await assert.rejects(buildAddonDocument({ entry: 'ui/index.html', readFile: async (path) => (path === 'ui/index.html' ? strToU8(files['ui/index.html']) : null) }), /not in the package/);
    await assert.rejects(buildAddonDocument({ entry: 'missing.html', readFile: async () => null }), /not in the package/);
});

test('the API an add-on sees has the desktop\'s names', () => {
    for (const name of ['getContext', 'listSignals', 'getParameterChanges', 'readSeries', 'seek', 'requestPacing', 'exportCsv', 'getProjectData', 'setProjectData', 'getSettings', 'setSettings', 'onTimelineChange', 'onSelectionChange', 'onSamplesAvailable', 'onRunStatusChange', 'onPacingChange', 'onSessionChange']) {
        assert.match(frameApiSource, new RegExp(`${name}:`));
    }
});

test('the frame is sandboxed with scripts alone and starts from a page whose policy lets nothing in or out', async () => {
    const { readFile } = await import('node:fs/promises');
    const runner = await readFile(new URL('../src/renderer/webShims/addons.mjs', import.meta.url), 'utf8');
    // allow-same-origin would give the add-on this page's origin and so its storage; popups, forms and top navigation are never wanted.
    assert.match(runner, /setAttribute\('sandbox', 'allow-scripts'\)/);
    const code = runner.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /allow-same-origin|allow-popups|allow-top-navigation|allow-forms|allow-modals/);
    const shell = await readFile(new URL('../src/renderer/addonFrame.html', import.meta.url), 'utf8');
    const policy = shell.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.match(policy, /^default-src 'none';/);
    assert.doesNotMatch(policy, /connect-src|frame-src|worker-src|child-src|object-src|https?:|\*/);
    assert.match(policy, /form-action 'none'/);
    assert.match(policy, /img-src data:;/);
});
