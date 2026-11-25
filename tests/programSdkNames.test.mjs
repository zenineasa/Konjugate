/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { generatedProgramSdkNamesModule } from '../scripts/generateProgramSdkNames.mjs';
import { programSdkNames } from '../src/programSdkNames.mjs';

const root = join(import.meta.dirname, '..');

test('the code editor\'s SDK names are the SDK\'s, as scripts/generateProgramSdkNames.mjs reads them (run it after changing the SDK)', async () => {
    assert.equal(await readFile(join(root, 'src', 'programSdkNames.mjs'), 'utf8'), await generatedProgramSdkNamesModule());
});

test('every public name a program uses is there, each with a line of documentation', () => {
    const names = (language) => programSdkNames[language].map((entry) => entry.name);
    for (const name of ['Input', 'Parameter', 'Constant', 'Output', 'Memory', 'Clock', 'Random', 'OutOfDomain', 'Node', 'Relationship', 'Step', 'Setup',
        'Inputs', 'Outputs', 'MemoryWriter', 'Jacobian', 'optional', 'dependsOn', 'fail']) {
        assert.ok(names('cpp').includes(name), `k::${name} is missing`);
    }
    for (const name of ['Input', 'Parameter', 'Constant', 'Output', 'Memory', 'Clock', 'Random', 'OutOfDomain', 'Node', 'Relationship', 'Step', 'Setup']) {
        assert.ok(names('python').includes(name), `konjugate.v2.${name} is missing`);
    }
    assert.ok(!names('cpp').some((name) => /Record|Registry|Traits|mixBits|nameHash/.test(name)), 'Nothing of konjugate::sdk::v2::detail.');
    for (const entry of [...programSdkNames.cpp, ...programSdkNames.python]) assert.ok(entry.doc.length > 5, `${entry.name} has no documentation`);
});

test('each name\'s section is a heading of Writing a program', async () => {
    const page = await readFile(join(root, 'docs', 'programs.md'), 'utf8');
    const anchors = new Set([...page.matchAll(/^#{2,3} (.+)$/gm)].map(([, heading]) => heading.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-')));
    for (const entry of [...programSdkNames.cpp, ...programSdkNames.python]) {
        if (entry.section) assert.ok(anchors.has(entry.section), `${entry.name}'s section #${entry.section} is not a heading of docs/programs.md`);
    }
});
