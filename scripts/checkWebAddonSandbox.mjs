// Copyright © 2026 Zenin Easa Panthakkalakath

// Runs a deliberately hostile result visualizer in a real Chrome against a served web shell and fails if any of what it tries gets through
// (docs/proposals/webEditionPackages.md, stage 3). The add-on asks only for results.read; it tries to read this page's storage and DOM,
// to reach the network several ways, to open windows, and to call methods it was not granted. Usage: start `npm run serve:webShell`, then
// `node scripts/checkWebAddonSandbox.mjs [http://localhost:4173]`.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPackageArchive } from '../src/packageArchive.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const base = process.argv[2] ?? 'http://localhost:4173';
const encode = (text) => new TextEncoder().encode(text);

const script = `
    const report = { direct: {}, bridge: {} };
    const attempt = (name, action) => { try { report.direct[name] = action(); } catch (error) { report.direct[name] = 'threw ' + error.name; } };
    attempt('localStorage', () => String(localStorage.length));
    attempt('cookie', () => document.cookie);
    attempt('indexedDB', () => String(indexedDB.open('x')));
    attempt('parentDocument', () => parent.document.title);
    attempt('open', () => String(window.open('${base}/renderer/index.html')));
    const pending = [
        fetch('${base}/renderer/index.html').then(() => { report.direct.fetch = 'reached'; }, () => { report.direct.fetch = 'blocked'; }),
        new Promise((resolve) => { const image = new Image(); image.onload = () => { report.direct.image = 'loaded'; resolve(); }; image.onerror = () => { report.direct.image = 'blocked'; resolve(); }; image.src = '${base}/assets/icon.svg'; })
    ];
    const v = window.konjugateVisualizer;
    for (const [name, call] of Object.entries({
        requestPacing: () => v.requestPacing({ mode: 'fastest' }), getSettings: () => v.getSettings(), setSettings: () => v.setSettings({ a: 1 }),
        getProjectData: () => v.getProjectData(), setProjectData: () => v.setProjectData({ a: 1 }), exportCsv: () => v.exportCsv('x.csv', 'x')
    })) pending.push(call().then((value) => { report.bridge[name] = 'allowed'; }, () => { report.bridge[name] = 'refused'; }));
    Promise.all(pending).then(() => parent.postMessage({ sandboxReport: report }, '*'));
`;
const manifest = {
    kind: 'resultVisualizer', addonId: 'example.hostile', name: 'Hostile', version: '1.0.0', apiVersion: 1, entry: 'index.html', permissions: ['results.read'],
    contributes: { toolstrip: [{ commandId: 'open', label: 'Hostile', tooltip: 'Open', when: 'resultsActive', contexts: ['resultSession'] }] }
};
const archive = createPackageArchive({
    packageManifest: { format: 'konjugate-package', formatVersion: 1, packageType: 'addon', packageId: manifest.addonId, name: manifest.name, version: '1.0.0', contents: { manifest: 'addon.json' } },
    contributionManifest: manifest,
    files: { 'index.html': encode('<!doctype html><script src="a.js"></script>'), 'a.js': encode(script) }
});
const directory = await mkdtemp(join(tmpdir(), 'konjugate-sandbox-'));
const file = join(directory, 'hostile.kja');
await writeFile(file, archive);

const browser = await chromium.launch({ channel: 'chrome' });
let failures = [];
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${base}/renderer/index.html`);
    await page.waitForSelector('#extensionsButton');
    await page.evaluate(() => { window.__sandboxReports = []; addEventListener('message', (event) => { if (event.data?.sandboxReport) window.__sandboxReports.push(event.data.sandboxReport); }); });
    await page.locator('text=Skip tour').first().click({ timeout: 4000 }).catch(() => {});
    await page.click('#extensionsButton');
    const chooser = page.waitForEvent('filechooser');
    await page.click('#extensionsInstall');
    await (await chooser).setFiles(file);
    await page.click('.webPackageReviewDialog button.doneButton');
    await page.waitForTimeout(800);
    await page.evaluate(() => document.querySelector('#extensionsDialog')?.close());
    // A result to show it: the smallest model, run once.
    await page.click('#exampleButton');
    await page.locator('[data-example-id="springMassDamper.kjt"]').click();
    await page.click('#examplesExplorerLoad');
    await page.waitForTimeout(2000);
    await page.click('#runButton');
    await page.click('#startRun');
    await page.waitForFunction(() => /complete/i.test(document.querySelector('#statusText').textContent), null, { timeout: 60000 });
    await page.locator('#addonRailButtons button', { hasText: 'Hostile' }).click({ force: true });
    const report = await page.waitForFunction(() => window.__sandboxReports[0] ?? null, null, { timeout: 15000 }).then((handle) => handle.jsonValue());
    const expect = (group, name, wanted) => { if (!String(report[group][name]).startsWith(wanted)) failures.push(`${group}.${name}: ${report[group][name]} (wanted ${wanted})`); };
    for (const name of ['localStorage', 'cookie', 'indexedDB', 'parentDocument']) expect('direct', name, 'threw');
    expect('direct', 'open', 'null');
    expect('direct', 'fetch', 'blocked');
    expect('direct', 'image', 'blocked');
    for (const name of ['requestPacing', 'getSettings', 'setSettings', 'getProjectData', 'setProjectData', 'exportCsv']) expect('bridge', name, 'refused');
    console.log(JSON.stringify(report, null, 2));
} finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
}
if (failures.length) {
    console.error(`The sandbox let something through:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('The hostile add-on got nothing it was not given.');
