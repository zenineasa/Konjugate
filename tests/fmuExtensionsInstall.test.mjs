/* Copyright © 2026 Zenin Easa Panthakkalakath */

// FMUs are added to a model in one way, Add › FMU… or a .fmu dropped on the canvas (the single FMU workflow, stage 2): Extensions ›
// Install… no longer takes one, desktop or web. Picked anyway, or dropped on the Extensions dialog, it says "FMUs are added to a model:
// use Add › FMU…", with a button that does so, and installs nothing. The handlers run in the Electron main process and the browser shim,
// which a unit test cannot start, so this reads the sources and checks the pieces agree.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const block = (source, start, next) => {
    const from = source.indexOf(start);
    assert.ok(from >= 0, `${start} not found.`);
    const to = source.indexOf(next, from + start.length);
    return source.slice(from, to < 0 ? undefined : to);
};

test('desktop: Install… offers no .fmu, and one picked anyway is not installed but said to go through Add › FMU…', async () => {
    const install = block(await read('src/main.mjs'), "ipcMain.handle('packageInstall'", 'ipcMain.handle(');
    assert.doesNotMatch(install, /extensions: \[[^\]]*'fmu'/, 'The file picker does not offer FMUs.');
    assert.doesNotMatch(install, /installOrReuseFmu\(|installFmuArchive\(/, 'Nothing installs an FMU here.');
    assert.match(install, /\.endsWith\('\.fmu'\)\) return \{ fmu: true \}/, 'A picked .fmu is answered with { fmu: true }.');
});

test('web: Install… offers no .fmu, and one picked anyway is answered the same way', async () => {
    const install = block(await read('src/renderer/webShims/packages.mjs'), 'install: async () => {', '    uninstall:');
    assert.match(install, /\.endsWith\('\.fmu'\)\) return \{ fmu: true \}/, 'A picked .fmu is answered with { fmu: true }.');
});

test('the Extensions dialog says FMUs are added to a model, with a button that opens Add › FMU…, for one picked or dropped', async () => {
    const [html, renderer] = await Promise.all([read('src/renderer/index.html'), read('src/renderer/renderer.mjs')]);
    const notice = block(html, 'id="extensionsFmuNotice"', '</p>');
    assert.match(notice, /FMUs are added to a model: use Add › FMU…/);
    assert.match(notice, /id="extensionsOpenAddFmu"/);
    // The web edition has no FMUs: it says they run in the desktop app, with the link its Add › FMU… gives, and offers no Add › FMU….
    const web = block(notice, 'id="extensionsFmuNoticeWeb"', '</span>');
    assert.match(web, /FMUs run in the desktop app\. <a id="extensionsFmuDownload" href="https:\/\/github\.com\/zenineasa\/Konjugate\/releases\/latest"/);
    assert.doesNotMatch(web, /Add › FMU/);
    assert.match(block(renderer, 'function showExtensionsFmuNotice()', '\n}'), /data-web-edition/, 'Which text shows depends on the edition.');
    const listener = block(renderer, "$('#extensionsInstall').addEventListener('click'", "$('#extensionsDiscoverInstall')");
    assert.match(listener, /installed\.fmu\) \{\s*showExtensionsFmuNotice\(\)/, 'A picked .fmu shows the notice.');
    assert.match(renderer, /\$\('#extensionsDialog'\)\.addEventListener\('drop'/, 'A file dropped on the dialog is handled there.');
    const button = block(renderer, "$('#extensionsOpenAddFmu').addEventListener('click'", '});');
    assert.match(button, /addFmuToModel\(\)/, 'The button is Add › FMU…: it picks a file and adds it to the model.');
});
