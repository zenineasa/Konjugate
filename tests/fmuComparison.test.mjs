/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compareWithOriginal } from '../src/fmuComparison.mjs';

// The bug hunt's stale "Compare with original": the comparison stayed with the window, so another project's FMU, or a second FMU with
// the same output names, was compared with a run it did not come from.
const fmuNode = (id, stateId) => ({ id, implementation: { kind: 'fmi', outputs: [{ key: 'x', stateId }] }, states: [{ id: stateId }] });
const samples = [0, 1].map((time) => ({ time, states: [{ stateId: 2, value: time * 2 }, { stateId: 4, value: 99 }] }));
const original = { modelName: 'springMassDamper', times: [0, 1], outputs: { x: [0, 2] }, nodeId: 1 };
const outputName = (node, output) => output.key;

test('only the node the exported FMU was placed as is compared with the original run', () => {
    const outcome = compareWithOriginal({ original, nodes: [fmuNode(1, 2), fmuNode(3, 4)], samples, outputName });
    assert.equal(outcome.title, 'Identical to springMassDamper\'s run: largest difference 0 over 2 values.');
    assert.deepEqual(outcome.lines, ['x: 2 samples, largest difference 0 (identical).'], 'The second FMU with the same output names is not listed.');
});

test('no comparison when its node is gone, or in a project the FMU was never tried in', () => {
    assert.equal(compareWithOriginal({ original, nodes: [fmuNode(3, 4)], samples, outputName }), null, 'Another project\'s FMU with the same output name is not compared.');
    assert.equal(compareWithOriginal({ original, nodes: [{ ...fmuNode(1, 2), deleted: true }], samples, outputName }), null);
    assert.equal(compareWithOriginal({ original: null, nodes: [fmuNode(1, 2)], samples, outputName }), null);
    assert.equal(compareWithOriginal({ original: { ...original, nodeId: undefined }, nodes: [fmuNode(1, 2)], samples, outputName }), null);
});

test('opening or starting another project leaves its comparison behind', async () => {
    const renderer = await readFile(new URL('../src/renderer/renderer.mjs', import.meta.url), 'utf8');
    const load = renderer.slice(renderer.indexOf('async function loadProjectDocument('), renderer.indexOf('clearRenderedModel();', renderer.indexOf('async function loadProjectDocument(')));
    assert.match(load, /originalComparison = null;/);
    assert.match(load, /\$\('#compareOriginalPanel'\)\.hidden = true;/);
});
