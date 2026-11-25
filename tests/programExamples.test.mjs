/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { generatedProgramExamplesModule } from '../scripts/generateProgramExamples.mjs';
import { programExamples } from '../src/programExamples.mjs';
import { programSourceVersion } from '../src/providerTemplate.mjs';

test('the code editor\'s examples are examples/providers as it is (run scripts/generateProgramExamples.mjs after changing one)', async () => {
    assert.equal(await readFile(join(import.meta.dirname, '..', 'src', 'programExamples.mjs'), 'utf8'), await generatedProgramExamplesModule());
});

test('each example is a version 2 program of its kind, in C++ and Python', () => {
    assert.deepEqual(programExamples.map((example) => example.label), ['PID controller', 'Conduction', 'Lookup table', 'CSV replay']);
    for (const example of programExamples) {
        for (const kind of ['cpp', 'python']) {
            const source = example.sources[kind];
            assert.equal(programSourceVersion(kind, source), 2, `${example.label} (${kind}) is in the current format`);
            const base = example.kind === 'node' ? 'Node' : 'Relationship';
            assert.match(source, kind === 'cpp' ? new RegExp(`public k::${base}\\b`) : new RegExp(`\\(${base}\\):`), `${example.label} (${kind}) is a ${example.kind} program`);
        }
    }
    assert.match(programExamples.find((example) => example.id === 'lookupTable').sources.python, /raise OutOfDomain/);
    assert.match(programExamples.find((example) => example.id === 'csvReplay').sources.cpp, /void initialize\(/);
});
