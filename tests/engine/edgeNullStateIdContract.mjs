/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Regression test for a fixed bug: edges with an unset top-level source/target stateId used to
// serialize that as JSON `null` (see the old `?? null` fallbacks in src/renderer/renderer.mjs's
// serializeProjectDocument() and assistantOperations.mjs's addEdge operation).
//
// JSON.stringify preserves a JS `null` as the JSON literal `null` (unlike `undefined`, which is
// dropped). Boost.PropertyTree's JSON parser has no native null type, so `"stateId": null`
// became the four-character STRING "null" once read into the property_tree -- which is
// non-empty, so engine/src/modelValidator.cpp's `!sourceState.empty()` guard treated it as "a
// state was chosen" and then correctly reported that no state with id "null" exists. The result:
// any fully-configured, otherwise-valid edge failed validation with "Relationship source/target
// state no longer exists."
//
// The fix serializes an unset stateId as `''` instead, which the same `!sourceState.empty()`
// guard correctly treats as "no state chosen" -- skipping the check rather than false-positiving
// on it. This test builds exactly what serializeProjectDocument() now emits for a complete,
// fully-authored edge (real equation, real output) whose top-level source/target stateId is
// unset, and asserts it validates cleanly.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';

function execute(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

function model() {
    const nodeA = { id: 1, name: 'Node A', type: 'Generic', position: [-1, 0, 0],
        states: [{ id: 2, name: 'x', symbol: 'x', initialValue: 1, unit: '' }],
        sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#2f6970' } };
    const nodeB = { id: 3, name: 'Node B', type: 'Generic', position: [1, 0, 0],
        states: [{ id: 4, name: 'x', symbol: 'x', initialValue: 1, unit: '' }],
        sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#2e7591' } };

    // Mirrors what serializeProjectDocument() emits for a complete, fully-authored edge (real
    // equation, real bindings, real output) whose top-level source/target stateId is unset.
    const edge = {
        id: 5, name: 'Relation', source: { nodeId: 1, stateId: '' }, target: { nodeId: 3, stateId: '' },
        directionality: 'directed', equation: '0.01',
        equationModel: { latex: '0.01', output: { role: 'target', stateId: 4 }, bindings: [], mathJson: 0.01 },
        parameters: []
    };

    return {
        format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
        metadata: { units: 'SI' }, nodes: [nodeA, nodeB], edges: [edge]
    };
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const directory = await mkdtemp(join(tmpdir(), 'konjugateEdgeNullStateId-'));

try {
    const inputPath = join(directory, 'nullStateId.kjt');
    const reportPath = join(directory, 'report.json');
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(model())));

    const exitCode = await execute(executable, ['validate', inputPath, '--report', reportPath]);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));

    assert.equal(exitCode, 0, 'A fully-configured edge with an unset source/target stateId should validate.');
    assert.equal(report.valid, true, 'The validation report should report the model as valid.');
    const codes = report.issues.map((issue) => issue.code);
    assert.ok(!codes.includes('edgeSourceStateMissing'), 'Did not expect a false-positive edgeSourceStateMissing issue.');
    assert.ok(!codes.includes('edgeTargetStateMissing'), 'Did not expect a false-positive edgeTargetStateMissing issue.');

    console.log('✓ edge null-stateId contract: unset source/target stateId no longer false-positives validation.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
