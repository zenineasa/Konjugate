/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The main window loads renderer.mjs as native modules through an import map, with no bundler. A source file that
// imports a package the map does not list (fflate, once, through the plugin chain) stops renderer.mjs at load
// with "Failed to resolve module specifier", and nothing in the unit tests or the web build notices, because the web
// build adds its own entries. This follows every relative import from renderer.mjs and checks each bare import is
// in the desktop page's map, and that the page's Content-Security-Policy allows exactly that map.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rendererDirectory = join(root, 'src', 'renderer');
const html = await readFile(join(rendererDirectory, 'index.html'), 'utf8');
const mapSource = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1];
const importMap = JSON.parse(mapSource).imports;
// Provided by the web edition's own build, never reached from the desktop page.
const webOnly = new Set(['protobufjs/minimal.js']);

const importSpecifiers = (source) => [
    ...source.matchAll(/\b(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)
].map((match) => match[1]);

test('every module renderer.mjs can load resolves its package imports through the desktop import map', async () => {
    const queue = [join(rendererDirectory, 'renderer.mjs')];
    const seen = new Set();
    const problems = [];
    while (queue.length) {
        const file = queue.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        const source = await readFile(file, 'utf8');
        for (const specifier of importSpecifiers(source)) {
            if (specifier.startsWith('.')) queue.push(normalize(join(dirname(file), specifier)));
            else if (!specifier.startsWith('node:') && !(specifier in importMap) && !webOnly.has(specifier) && !Object.keys(importMap).some((key) => key.endsWith('/') && specifier.startsWith(key))) {
                problems.push(`${file.replace(root + '/', '')} imports "${specifier}", which the import map does not list`);
            }
        }
    }
    assert.deepEqual(problems, []);
    assert.ok(seen.size > 20, 'the walk reached the renderer\'s modules');
});

test('every entry in the desktop import map points at a file that exists', async () => {
    for (const [name, path] of Object.entries(importMap)) {
        await stat(join(rendererDirectory, path)).catch(() => assert.fail(`"${name}" maps to ${path}, which is missing`));
    }
});

test('the page\'s Content-Security-Policy allows exactly this import map, by its hash', () => {
    const hash = `sha256-${createHash('sha256').update(mapSource).digest('base64')}`;
    const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
    assert.ok(policy.includes(`'${hash}'`), `the policy's script-src must contain '${hash}' (update it after changing the import map)`);
});
