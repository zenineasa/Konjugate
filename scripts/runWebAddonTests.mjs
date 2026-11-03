/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Drives the web edition's add-on support in a real browser (docs/proposals/webEditionPackages.md, stage 5): installing launcher and
// visualizer packages, fetching from declared hosts, reloading, resumable downloads, kept sessions, inference and a visualizer hearing a
// run in progress. It is separate from runWebInteractionTests.mjs, whose tests share one long-lived page and know nothing of add-ons; here
// every scenario boots a fresh page.
//
// Needs out/webShell (npm run build:webShell) and openssl. A local HTTPS server stands in for the data hosts: two dotted names that the
// browser is told to resolve to this machine, as a launcher's host list takes exact dotted names and its fetches must be https.
// --headed (or KONJUGATE_HEADED=1) shows the browser window while the tests run.
// KONJUGATE_CHROMIUM_PATH points at a browser to use instead of Playwright's own.

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackageArchive } from '../src/packageArchive.mjs';

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'konjugate-addon-tests-'));
const shellPort = 4800 + Math.floor(Math.random() * 100);
const enc = (text) => new TextEncoder().encode(text);

// ---- the data hosts ----------------------------------------------------------------------------------------------------------------
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(work, 'k.pem'), '-out', join(work, 'c.pem'), '-days', '1', '-subj', '/CN=files.example.com'], { stdio: 'ignore' });
const bigSize = 3 * 1024 * 1024;
const big = Buffer.alloc(bigSize);
for (let index = 0; index < bigSize; index += 1) big[index] = (index * 31 + (index >> 8)) & 255;
const bigMd5 = createHash('md5').update(big).digest('hex');
const etag = '"big-v1"';
const modified = 'Mon, 02 Nov 2026 10:00:00 GMT';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range, If-Range', 'Access-Control-Expose-Headers': 'ETag, Content-Range, Content-Length, Accept-Ranges, Last-Modified' };
const dataServer = { port: 0, smallBody: 't,v\n1,2\n', log: [], cutsLeft: 0 };
const dataHttps = createServer({ key: readFileSync(join(work, 'k.pem')), cert: readFileSync(join(work, 'c.pem')) }, (request, response) => {
    const url = new URL(request.url, 'https://files.example.com');
    dataServer.log.push({ method: request.method, path: url.pathname, range: request.headers.range ?? null, ifRange: request.headers['if-range'] ?? null });
    if (request.method === 'OPTIONS') { response.writeHead(204, { ...cors, 'Access-Control-Max-Age': '60' }); return response.end(); }
    if (url.pathname === '/plain') { response.writeHead(200); return response.end('no cors here'); }
    if (url.pathname === '/small.csv') { response.writeHead(200, { ...cors, 'Content-Type': 'text/csv' }); return response.end(dataServer.smallBody); }
    if (url.pathname === '/redirect') { response.writeHead(302, { ...cors, Location: `https://other.example.com:${dataServer.port}/small.csv` }); return response.end(); }
    if (url.pathname === '/big.bin.md5') { response.writeHead(200, cors); return response.end(`${bigMd5}  big.bin\n`); }
    if (url.pathname === '/bad.md5') { response.writeHead(200, cors); return response.end(`${'0'.repeat(32)}  big.bin\n`); }
    if (url.pathname !== '/big.bin') { response.writeHead(404, cors); return response.end('nope'); }
    let start = 0;
    let status = 200;
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
    if (range && (request.headers['if-range'] === etag || request.headers['if-range'] === modified)) { start = Number(range[1]); status = 206; }
    const body = big.subarray(start);
    const headers = { ...cors, ETag: etag, 'Last-Modified': modified, 'Accept-Ranges': 'bytes', 'Content-Length': String(body.length), 'Content-Type': 'application/octet-stream' };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${bigSize - 1}/${bigSize}`;
    response.writeHead(status, headers);
    if (request.method === 'HEAD') return response.end();
    // The first download asked to stop part way has its connection dropped there.
    const cut = url.searchParams.has('cut') && dataServer.cutsLeft > 0 ? Number(url.searchParams.get('cut')) - start : null;
    if (cut !== null) dataServer.cutsLeft -= 1;
    let at = 0;
    const send = () => {
        if (response.destroyed) return;
        if (cut !== null && at >= cut) { response.socket.destroy(); return; }
        if (at >= body.length) return response.end();
        const end = Math.min(body.length, at + 256 * 1024, cut ?? Infinity);
        response.write(body.subarray(at, end));
        at = end;
        setImmediate(send);
    };
    send();
});
await new Promise((done) => dataHttps.listen(0, done));
dataServer.port = dataHttps.address().port;
const filesBase = `https://files.example.com:${dataServer.port}`;

// ---- the packages -----------------------------------------------------------------------------------------------------------------
const packageFile = (manifest, files) => {
    const path = join(work, `${manifest.addonId}.kja`);
    writeFileSync(path, createPackageArchive({
        packageManifest: { format: 'konjugate-package', formatVersion: 1, packageType: 'addon', packageId: manifest.addonId, name: manifest.name, version: '1.0.0', contents: { manifest: 'addon.json' } },
        contributionManifest: manifest, files
    }));
    return path;
};
// Every call the window makes goes through __run, which keeps the answer where the test can read it.
const launcherUi = '<!doctype html><html><body><pre id="out"></pre><script src="app.js"></script></body></html>';
const launcherApp = 'const k = window.konjugateLauncher; window.__run = async (name, ...a) => { window.__last = await k[name](...a); document.getElementById("out").textContent = JSON.stringify(window.__last); return window.__last; };';
// An importer that builds a two-node model with one shared parameter.
const importerFunction = async () => {
    const node = (id, name, stateId) => ({ id, name, position: [0, 0, 0], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#888888' }, states: [{ id: stateId, name: 'Level', symbol: 'level', initialValue: 0 }] });
    const document = {
        format: 'konjugate', version: 1, metadata: { units: 'SI' }, nodes: [node(1, 'Source', 2), node(3, 'Target', 4)],
        edges: [{
            id: 5, name: 'Feed', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 3, stateId: 4 }, directionality: 'directed', equation: '\\mathrm{gain}',
            equationModel: { latex: '\\mathrm{gain}', output: { role: 'target', stateId: 4 }, bindings: [{ kind: 'parameter', parameterId: 6, symbol: 'gain' }], mathJson: 'gain' },
            parameters: [{ id: 6, name: 'Gain', symbol: 'gain', value: 1, mode: 'live', control: { minimum: 0, maximum: 10, step: 1 }, sharedParameterId: 7 }], appearance: { color: '#888888', offset: 0 }
        }],
        sharedParameters: [{ id: 7, name: 'Shared gain', symbol: 'gain', value: 1, mode: 'live', control: { minimum: 0, maximum: 10, step: 1 } }],
        runConfigurations: [{ id: 8, name: 'Default', globalTimeStep: 0.1, outputInterval: 0.5, targetTime: 10 }], activeRunConfigurationId: 8
    };
    return { ok: true, report: {}, document, parameterIndex: [{ key: 'gain', scope: 'global', name: 'Gain', sharedParameterId: 7, live: true, value: 1, minimum: 0, maximum: 10 }] };
};
const launcherPackage = (addonId, name, permissions, extra = {}) => packageFile({
    kind: 'launcher', addonId, name, version: '1.0.0', apiVersion: 1, entry: 'ui/index.html', permissions, ...extra,
    contributes: {
        toolstrip: [{ commandId: 'open', label: name, tooltip: `Open ${name}`, symbol: '▦', when: 'always' }],
        importers: [{ importerId: 'csv', name: 'Gain', entry: 'importer.mjs', files: [{ role: 'data', label: 'Data', required: true, accept: ['csv'], sample: 'sample.csv' }] }],
        scenarios: []
    }
}, { 'ui/index.html': enc(launcherUi), 'ui/app.js': enc(launcherApp), 'importer.mjs': enc(`export default ${importerFunction.toString()}`), 'sample.csv': enc('x\n1\n') });
const visualizerPackage = () => {
    const app = `const v = window.konjugateVisualizer; window.__ev = [];
const log = (name, x) => window.__ev.push([name, x]);
v.onSamplesAvailable((x) => log('samples', x)); v.onRunStatusChange((x) => log('status', { lifecycle: x.lifecycle, sampleCount: x.sampleCount })); v.onPacingChange((x) => log('pacing', x));
window.__call = async (name, ...a) => { try { return { ok: true, value: await v[name](...a) }; } catch (e) { return { ok: false, message: e.message }; } };`;
    return packageFile({
        kind: 'resultVisualizer', addonId: 'example.live', name: 'Live viewer', version: '1.0.0', apiVersion: 1, entry: 'ui/index.html',
        permissions: ['results.read', 'timeline.read', 'results.live.read', 'simulation.status.read', 'simulation.pacing.read', 'simulation.pacing.control', 'project.data'], requires: ['projectData'],
        contributes: { toolstrip: [{ commandId: 'open', label: 'Live viewer', tooltip: 'Open Live viewer', symbol: '◈', when: 'resultsActive', contexts: ['resultSession'] }] }
    }, { 'ui/index.html': enc(launcherUi), 'ui/app.js': enc(app) });
};

// ---- the shell and the browser ----------------------------------------------------------------------------------------------------
const shell = spawn(process.execPath, ['scripts/serveWebShell.mjs'], { cwd: rootDirectory, env: { ...process.env, PORT: String(shellPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((done, fail) => {
    shell.stdout.on('data', (chunk) => { if (String(chunk).includes('Web shell served')) done(); });
    shell.stderr.on('data', (chunk) => process.stderr.write(chunk));
    shell.once('exit', (code) => fail(new Error(`serveWebShell.mjs exited with code ${code}. Run npm run build:webShell first.`)));
    setTimeout(() => fail(new Error('Timed out waiting for the web shell server.')), 15000);
});
const { chromium } = await import('playwright');
const browser = await chromium.launch({
    headless: !(process.env.KONJUGATE_HEADED || process.argv.includes('--headed')),
    ...(process.env.KONJUGATE_CHROMIUM_PATH ? { executablePath: process.env.KONJUGATE_CHROMIUM_PATH } : {}),
    args: ['--host-resolver-rules=MAP files.example.com 127.0.0.1, MAP other.example.com 127.0.0.1']
});
const shellUrl = `http://localhost:${shellPort}/renderer/index.html`;
const pageErrors = [];

async function bootPage() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, acceptDownloads: true });
    await context.addInitScript(() => { window.showSaveFilePicker = undefined; window.showOpenFilePicker = undefined; });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await open(page);
    return page;
}
async function open(page) {
    await page.goto(shellUrl);
    await page.waitForSelector('#extensionsButton', { timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.locator('text=Skip tour').first().click().catch(() => {});
}
async function install(page, file) {
    await page.click('#extensionsButton');
    const chooser = page.waitForEvent('filechooser');
    await page.click('#extensionsInstall');
    await (await chooser).setFiles(file);
    await page.waitForSelector('.webPackageReviewDialog button.doneButton');
    const review = await page.evaluate(() => document.querySelector('.webPackageReviewDialog').innerText);
    await page.click('.webPackageReviewDialog button.doneButton');
    await page.waitForTimeout(900);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    return review;
}
// Opens the launcher on the rail and answers a function that calls one of its methods and gives back the answer.
async function openLauncher(page) {
    await page.locator('#addonRailButtons button').first().click({ force: true });
    const frame = await waitForFrame(page);
    await frame.waitForFunction(() => typeof window.__run === 'function');
    return { frame, call: (...args) => frame.evaluate((a) => window.__run(...a), args) };
}
async function waitForFrame(page) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const frame = page.frames().find((candidate) => candidate.url().includes('addonFrame'));
        if (frame) return frame;
        await page.waitForTimeout(100);
    }
    throw new Error('The add-on frame did not open.');
}

// ---- the scenarios ----------------------------------------------------------------------------------------------------------------
const scenarios = [];
const scenario = (name, body) => scenarios.push({ name, body });

scenario('a launcher is reviewed, installed, imports its sample and opens the model', async () => {
    const page = await bootPage();
    const review = await install(page, launcherPackage('example.basic', 'Basic', ['data.import', 'model.open']));
    assert.match(review, /Import data files/);
    const { call } = await openLauncher(page);
    assert.equal((await call('useSample', 'csv')).ok, true);
    assert.equal((await call('runImport', 'csv')).ok, true);
    assert.equal((await call('openInCanvas', '')).ok, true);
    await page.waitForFunction(() => /Source|Target/.test(document.body.innerText) || document.querySelector('.documentTitle'), null, { timeout: 10000 });
    await page.context().close();
});

scenario('a launcher fetches from its declared host, is refused elsewhere, says why a server cannot be read, and reloads what changed', async () => {
    const page = await bootPage();
    await install(page, launcherPackage('example.fetch', 'Fetch', ['data.import', 'network.fetch'], { network: { hosts: ['files.example.com'] } }));
    const { call } = await openLauncher(page);
    dataServer.smallBody = 't,v\n1,2\n';
    assert.deepEqual([(await call('fetchText', `${filesBase}/small.csv`)).text], ['t,v\n1,2\n']);
    const unreadable = await call('fetchText', `${filesBase}/plain`);
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.message, /allow a web page|CORS/i, 'The window is told the server may not allow a page to read it.');
    for (const url of [`${filesBase}/redirect`, 'https://other.example.com/x', `http://files.example.com:${dataServer.port}/small.csv`]) assert.equal((await call('fetchText', url)).ok, false, url);
    const filed = await call('fetchFile', 'csv', 'data', `${filesBase}/small.csv`, 'Series');
    assert.equal(filed.ok, true);
    assert.deepEqual(await call('reloadFiles', 'csv'), { ok: true, changed: 0, missing: [], local: 0 });
    dataServer.smallBody = 't,v\n1,2\n2,3\n';
    assert.equal((await call('reloadFiles', 'csv')).changed, 1);
    assert.equal((await call('runImport', 'csv')).ok, true);
    await page.context().close();
});

scenario('a download that is cut off continues from where it stopped, is checked against its checksum, and a wrong checksum is refused', async () => {
    const page = await bootPage();
    await install(page, launcherPackage('example.files', 'Files', ['data.import', 'files.store', 'network.fetch'], { network: { hosts: ['files.example.com'] }, requires: ['storedFiles', 'resumableDownloads'] }));
    const { call } = await openLauncher(page);
    dataServer.cutsLeft = 1;
    dataServer.log.length = 0;
    const url = `${filesBase}/big.bin?cut=${1024 * 1024}`;
    const first = await call('downloadFile', url, { checksumUrl: `${filesBase}/big.bin.md5`, downloadId: 'one', server: 'Local' });
    assert.equal(first.ok, false, 'The first attempt is cut off.');
    assert.equal((await call('partialDownloads')).partials.length, 1, 'What arrived is kept.');
    const second = await call('downloadFile', url, { checksumUrl: `${filesBase}/big.bin.md5`, downloadId: 'two', server: 'Local' });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.file.bytes, bigSize);
    const resumed = dataServer.log.find((entry) => entry.range);
    assert.ok(resumed && resumed.ifRange, 'The second attempt asks for the rest, only if the file is unchanged.');
    assert.equal((await call('partialDownloads')).partials.length, 0);
    const wrong = await call('downloadFile', `${filesBase}/big.bin`, { checksumUrl: `${filesBase}/bad.md5`, downloadId: 'three', fresh: true });
    assert.equal(wrong.ok, false);
    assert.match(wrong.message, /checksum|does not match/i);
    await page.context().close();
});

scenario('a launcher\'s session is kept with the project, and comes back when the saved project is opened again', async () => {
    const page = await bootPage();
    await install(page, launcherPackage('example.sessions', 'Sessions', ['data.import', 'model.open', 'project.data'], { requires: ['projectSession', 'keepSession'] }));
    let { call } = await openLauncher(page);
    assert.equal((await call('restoreSession')).ok, true);
    await call('useSample', 'csv');
    assert.equal((await call('runImport', 'csv')).ok, true);
    assert.equal((await call('openInCanvas', '', { session: { picked: ['a', 'b'], note: 'hello' } })).ok, true);
    await page.waitForTimeout(2000);
    const download = page.waitForEvent('download');
    await page.click('#saveButton');
    const savedPath = join(work, 'session.kjt');
    await (await download).saveAs(savedPath);
    await open(page);
    const chooser = page.waitForEvent('filechooser');
    await page.click('#loadButton');
    await (await chooser).setFiles(savedPath);
    await page.waitForTimeout(2500);
    ({ call } = await openLauncher(page));
    const restored = await call('restoreSession');
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.deepEqual(restored.session, { picked: ['a', 'b'], note: 'hello' });
    assert.equal((await call('runImport', 'csv')).ok, true, 'The input files came back with it.');
    await page.context().close();
});

scenario('a launcher with analysis.infer gets the lagged link a table contains, and refusals for tables it cannot take', async () => {
    const page = await bootPage();
    await install(page, launcherPackage('example.infer', 'Infer', ['data.import', 'analysis.infer']));
    const { call } = await openLauncher(page);
    let seed = 7;
    const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
    const rows = ['t,a,b,c'];
    let a = 0;
    let b = 0;
    let c = 0;
    for (let t = 0; t < 300; t += 1) {
        const nextA = 0.5 * a + noise();
        b = 0.8 * a + 0.2 * b + 0.1 * noise();
        c = 0.3 * c + noise();
        a = nextA;
        rows.push(`${t},${a.toFixed(5)},${b.toFixed(5)},${c.toFixed(5)}`);
    }
    const answer = await call('infer', `${rows.join('\n')}\n`, {});
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const link = answer.edges.find((edge) => edge.sourceColumn === 'a' && edge.targetColumn === 'b' && edge.lag === 1);
    assert.ok(link, 'a drives b one step later');
    assert.ok(Math.abs(link.terms[0].coefficient - 0.8) < 0.1, `coefficient ${link.terms[0].coefficient}`);
    assert.equal((await call('infer', '')).ok, false);
    assert.match((await call('infer', 'x'.repeat(4 * 1024 * 1024 + 1))).message, /larger than/);
    await page.context().close();
});

scenario('a visualizer hears a run in progress, can change its pace until it ends, and keeps data with the project', async () => {
    const page = await bootPage();
    await page.click('#exampleButton');
    await page.locator('[data-example-id="springMassDamper.kjt"]').click();
    await page.click('#examplesExplorerLoad');
    await page.waitForTimeout(2500);
    assert.equal(await page.evaluate(() => crossOriginIsolated), true, 'A live run needs an isolated page.');
    await page.click('#runButton');
    await page.fill('#runTargetTime', '10');
    await page.locator('#runOnlineMode').check({ force: true });
    await page.selectOption('#runPacingMode', 'limitedRatio');
    await page.fill('#runPacingRatio', '1');
    await page.click('#startRun');
    await page.waitForTimeout(1500);
    await install(page, visualizerPackage());
    await page.locator('#addonRailButtons button').first().click({ force: true });
    const frame = await waitForFrame(page);
    await frame.waitForFunction(() => Array.isArray(window.__ev));
    const call = (...args) => frame.evaluate((a) => window.__call(...a), args);
    assert.equal((await call('requestPacing', { mode: 'fastest', simulationSecondsPerWallSecond: 1 })).ok, true, 'The pace of a run in progress can be changed.');
    await frame.waitForFunction(() => window.__ev.some(([name, x]) => name === 'status' && x.lifecycle === 'completed'), null, { timeout: 30000 });
    const kinds = await frame.evaluate(() => [...new Set(window.__ev.map(([name]) => name))].sort());
    assert.ok(['samples', 'status', 'pacing'].every((name) => kinds.includes(name)), `heard ${kinds}`);
    const late = await call('requestPacing', { mode: 'fastest', simulationSecondsPerWallSecond: 1 });
    assert.equal(late.ok, false, 'A run that is over cannot be paced.');
    assert.match(late.message, /no longer running/);
    assert.equal((await call('setProjectData', { zoom: 3 })).ok, true);
    assert.deepEqual((await call('getProjectData')).value.data, { zoom: 3 });
    await page.context().close();
});

// ---- running them ------------------------------------------------------------------------------------------------------------------
let failed = 0;
const only = process.env.KONJUGATE_INTERACTION_ONLY;
try {
    for (const { name, body } of scenarios) {
        if (only && !name.includes(only)) continue;
        try {
            await body();
            console.log(`✓ ${name}`);
        } catch (error) {
            failed += 1;
            console.log(`✗ ${name}: ${error?.message ?? error}`);
        }
    }
} finally {
    await browser.close();
    shell.kill();
    dataHttps.close();
    rmSync(work, { recursive: true, force: true });
}
if (pageErrors.length) {
    failed += 1;
    console.log(`✗ the page raised errors: ${[...new Set(pageErrors)].slice(0, 3).join(' | ')}`);
}
console.log(failed ? `${failed} failed.` : 'Add-on interaction tests passed.');
process.exit(failed ? 1 : 0);
