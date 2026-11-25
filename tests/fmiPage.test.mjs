/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The FMI compatibility page published at web.konjugate.com/fmi/ (scripts/fmiPage.mjs), built from examples/fmi/README.md: every link
// on it leads somewhere that exists, every example file is published beside it, and it names Konjugate's home page and itself as
// Konjugate's own page, as the FMI tools page asks.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';
import { relativeLinks } from '../benchmarks/pages.mjs';
import { exampleFolders, parseMarkdown, writeFmiSite } from '../scripts/fmiPage.mjs';

test('the FMI page and every example file it offers are written, and its links resolve', (t) => {
    const site = mkdtempSync(join(tmpdir(), 'konjugate-fmi-page-'));
    t.after(() => rmSync(site, { recursive: true, force: true }));
    const files = writeFmiSite(site);
    const examples = exampleFolders();
    assert.ok(examples.length >= 3);
    assert.deepEqual(files.sort(), ['index.html', ...examples.flatMap(({ name, files: exampleFiles }) => exampleFiles.map(({ file }) => `${name}/${file}`))].sort());
    for (const { name, files: exampleFiles } of examples) {
        assert.equal(exampleFiles.length, 4, name);
        for (const { file } of exampleFiles) assert.deepEqual(readFileSync(join(site, name, file)), readFileSync(join(import.meta.dirname, '..', 'examples', 'fmi', name, file)));
    }

    const html = readFileSync(join(site, 'index.html'), 'utf8');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id));
    for (const link of relativeLinks(html)) {
        assert.ok(existsSync(join(site, posix.normalize(link))), `index.html links to ${link}, which is not on the site`);
    }
    for (const [, fragment] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(fragment), `index.html links to #${fragment}, which is not on the page`);
    for (const { name } of examples) assert.match(html, new RegExp(`<article class="card" id="example-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}">`));
    // The FMI 3.0 examples (examples/fmi/3.0/) are on it too, their files under 3.0/ as in the repository.
    for (const model of ['ThermalEquilibrium', 'SpringMassDamper', 'HeatedRoom']) {
        assert.ok(examples.some(({ name }) => name === `3.0/${model}`), `3.0/${model} is an example of the page.`);
        assert.ok(files.includes(`3.0/${model}/${model}.fmu`), `3.0/${model}/${model}.fmu is published.`);
    }
    // Every file of the repository it names is linked on GitHub, never relatively (the page is not served from a clone).
    assert.doesNotMatch(html, /href="\.\.\//);
    assert.match(html, /<a class="home" href="https:\/\/www\.konjugate\.com\/"/);
    assert.match(html, /<a href="https:\/\/www\.konjugate\.com\/">Home page<\/a>/);
    assert.match(html, /This page is provided by Konjugate, not by the Modelica Association or the FMI Project\./);
    assert.match(html, /<meta property="og:url" content="https:\/\/web\.konjugate\.com\/fmi\/">/);
    // The benchmarks' link-preview card describes the benchmarks, not this page.
    assert.doesNotMatch(html, /og:image/);
});

test('Markdown the page does not render stops the build rather than showing wrongly', () => {
    assert.deepEqual(parseMarkdown('# Title\n\nOne\nline.\n\n- a\n  b\n- c\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```sh\nrun\n```\n').map(({ type }) => type),
        ['heading', 'paragraph', 'list', 'table', 'code']);
    assert.throws(() => parseMarkdown('| x |\n| 1 |\n'), /separator row/);
    assert.throws(() => parseMarkdown('```\nopen'), /not closed/);
});
