/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { decodeProjectFile } from '../src/projectFile.mjs';
import { normalizeOwnership } from '../src/ownership.mjs';
import { exampleOwnership, exampleTitle } from '../scripts/exampleOwnership.mjs';

const examples = join(import.meta.dirname, '..', 'examples');
const exampleFiles = (await readdir(examples)).filter((file) => file.endsWith('.kjt')).sort();

test('every shipped example names its owner, copyright, license and contact, titled as its guide is', async () => {
    assert.ok(exampleFiles.length > 0);
    for (const file of exampleFiles) {
        const document = JSON.parse(await decodeProjectFile(await readFile(join(examples, file))));
        const guide = await readFile(join(examples, file.replace(/\.kjt$/, '.md')), 'utf8');
        assert.deepEqual(document.ownership, exampleOwnership(exampleTitle(guide)), `${file} should carry the ownership block (run node scripts/stampExampleOwnership.mjs).`);
        assert.equal(document.copyright, undefined, `${file} should not carry the notice the application used to write into every project.`);
    }
});

test('the block is one that Konjugate reads back unchanged, with a license the picker offers', () => {
    const block = exampleOwnership('Example');
    assert.deepEqual(normalizeOwnership(block), block);
    assert.equal(block.license.id, '0BSD');
    assert.equal(block.owner, 'Zenin Easa Panthakkalakath');
    assert.equal(block.firstSavedAt, block.lastSavedAt);
});

test('the plugin example project carries the block too, without save times since it was never saved by the application', async () => {
    const project = JSON.parse(await readFile(join(examples, 'providers', 'piControlledTankProject.json'), 'utf8'));
    assert.equal(project.ownership.license.id, '0BSD');
    assert.equal(project.ownership.owner, 'Zenin Easa Panthakkalakath');
    assert.equal(project.ownership.firstSavedAt, undefined);
});
