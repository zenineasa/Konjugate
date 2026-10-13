/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The provider editor window loads CodeMirror straight from node_modules through an import map, with no
// bundler in between. A package update that makes one of those modules import a package the map does not
// list (this happened when @codemirror/language began importing @codemirror/streamparser) leaves the
// editor window blank, and nothing in the unit tests or the build notices. This follows every module the
// map can reach and checks each bare import in them is in the map.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const editorDirectory = join(root, 'src', 'providerEditor');
const html = await readFile(join(editorDirectory, 'index.html'), 'utf8');
const importMap = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports;

const importSpecifiers = (source) => [
    ...source.matchAll(/\b(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)
].map((match) => match[1]);

test('every module the provider editor can load resolves all of its imports through the import map', async () => {
    const queue = [join(editorDirectory, 'renderer.mjs'), join(editorDirectory, 'themes.mjs')];
    const seen = new Set();
    const problems = [];
    while (queue.length) {
        const file = queue.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        const source = await readFile(file, 'utf8');
        for (const specifier of importSpecifiers(source)) {
            if (specifier.startsWith('.')) {
                queue.push(normalize(join(dirname(file), specifier)));
            } else if (specifier in importMap) {
                queue.push(normalize(join(editorDirectory, importMap[specifier])));
            } else if (!specifier.startsWith('node:')) {
                problems.push(`${file.replace(root + '/', '')} imports "${specifier}", which the import map does not list`);
            }
        }
    }
    assert.deepEqual(problems, []);
    assert.ok(seen.size > 10, 'the walk reached the CodeMirror packages');
});

test('every entry in the import map points at a file that exists', async () => {
    for (const [name, path] of Object.entries(importMap)) {
        await readFile(join(editorDirectory, path), 'utf8').catch(() => assert.fail(`"${name}" maps to ${path}, which is missing`));
    }
});

test('the window\'s Content-Security-Policy allows exactly this import map, by its hash', () => {
    // An inline script is allowed only by the SHA-256 of its exact text, so any edit to the map (adding a
    // package, even a space) changes the hash, and a stale one makes the browser refuse the whole map: every
    // CodeMirror import then fails to resolve and the editor window stays blank.
    const mapSource = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1];
    const hash = `sha256-${createHash('sha256').update(mapSource).digest('base64')}`;
    const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
    assert.ok(policy.includes(`'${hash}'`), `the policy's script-src must contain '${hash}' (update it after changing the import map)`);
});
