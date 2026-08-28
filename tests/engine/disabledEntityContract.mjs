/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Regression/contract test for the disable/enable feature: a disabled node or edge stays fully
// present in the saved file (unlike a UI delete, which serializeProjectDocument() drops
// entirely -- see src/renderer/renderer.mjs), but the engine must treat it exactly as if it had
// been deleted: excluded from the state vector and from every contribution, and not validated.
// An edge is inert if it is disabled itself, or if either endpoint node is, even when the edge's
// own `enabled` stays true -- re-enabling the node alone should be enough to restore it.
//
// Model: A (enabled) --E1(enabled)--> B (disabled) : B and E1 must vanish from results, and E1
// must not be validated despite touching a disabled node's state.
// A (enabled) --E2(disabled)--> C (enabled) : C exists and keeps its initial value; E2 never
// contributes despite connecting two enabled nodes.
// C (enabled) --E3(enabled)--> D (enabled) : the one edge that should actually run, proving
// disabling elsewhere in the model doesn't suppress normal contributions.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { decodeValidationReport } from '../../src/reportProtocol.mjs';

function execute(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

function node({ id, stateId, initialValue, enabled }) {
    return {
        id, name: `Node ${id}`, type: 'Generic', position: [0, 0, 0],
        ...(enabled ? {} : { enabled: false }),
        states: [{ id: stateId, name: 'x', symbol: 'x', initialValue, unit: '' }],
        sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#2f6970' }
    };
}

function constantEdge({ id, sourceNodeId, sourceStateId, targetNodeId, targetStateId, enabled }) {
    return {
        id, name: `Edge ${id}`,
        source: { nodeId: sourceNodeId, stateId: sourceStateId },
        target: { nodeId: targetNodeId, stateId: targetStateId },
        directionality: 'directed',
        ...(enabled ? {} : { enabled: false }),
        equation: '5',
        equationModel: { latex: '5', output: { role: 'target', stateId: targetStateId }, bindings: [], mathJson: 5 },
        parameters: []
    };
}

function model() {
    const a = node({ id: 1, stateId: 2, initialValue: 10, enabled: true });
    const b = node({ id: 3, stateId: 4, initialValue: 5, enabled: false });
    const c = node({ id: 6, stateId: 7, initialValue: 20, enabled: true });
    const d = node({ id: 9, stateId: 10, initialValue: 0, enabled: true });
    const edgeToDisabledNode = constantEdge({ id: 11, sourceNodeId: 1, sourceStateId: 2, targetNodeId: 3, targetStateId: 4, enabled: true });
    const disabledEdge = constantEdge({ id: 12, sourceNodeId: 1, sourceStateId: 2, targetNodeId: 6, targetStateId: 7, enabled: false });
    const activeEdge = constantEdge({ id: 13, sourceNodeId: 6, sourceStateId: 7, targetNodeId: 9, targetStateId: 10, enabled: true });
    return {
        format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
        metadata: { units: 'SI' },
        nodes: [a, b, c, d],
        edges: [edgeToDisabledNode, disabledEdge, activeEdge]
    };
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const directory = await mkdtemp(join(tmpdir(), 'konjugateDisabledEntity-'));

try {
    const inputPath = join(directory, 'disabled.kjt');
    const configurationPath = join(directory, 'configuration.json');
    const reportPath = join(directory, 'report.bin');
    const outputPath = join(directory, 'result.bin');
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(model())));
    await writeFile(configurationPath, JSON.stringify({ name: 'disabledEntity', targetTime: 1, globalTimeStep: 0.1, outputInterval: 1 }));

    const validateExitCode = await execute(executable, ['validate', inputPath, '--report', reportPath]);
    const report = decodeValidationReport(await readFile(reportPath));
    assert.equal(validateExitCode, 0, 'A model with disabled entities should still validate.');
    assert.equal(report.valid, true, 'Disabled entities must not be deep-validated, even though an enabled edge references a disabled node\'s state.');

    const runExitCode = await execute(executable, ['run', inputPath, '--configuration', configurationPath, '--output', outputPath]);
    assert.equal(runExitCode, 0, 'A model with disabled entities should still run.');
    const result = decodeResultFile(await readFile(outputPath));
    const finalStates = new Map(result.samples.at(-1).states.map((state) => [state.stateId, state.value]));

    assert.ok(!finalStates.has(4), 'A disabled node\'s state must be entirely absent from results, exactly as if it had been deleted.');
    assert.equal(finalStates.get(2), 10, 'Node A receives no contribution and should stay at its initial value.');
    assert.equal(finalStates.get(7), 20, 'Node C\'s only inbound edge is disabled, so it must stay at its initial value.');
    assert.equal(finalStates.get(10), 5, 'Node D\'s inbound edge is enabled (both itself and its endpoints), so it must have accumulated the constant contribution (0 + 5 * 1s).');

    console.log('✓ disabled entity contract: a disabled node/edge (or an edge touching a disabled node) is excluded from validation and execution, exactly as if deleted.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
