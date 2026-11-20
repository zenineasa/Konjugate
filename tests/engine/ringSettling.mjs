/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Contract for rings of Updates (docs/proposals/ratesAndUpdates.md), through the engine's own run:
//   - a ring of relationships setting values, in a file that says no kind, is valid and settles within the step: flow = head / 2 + 1
//     and head = flow give flow = head = 2 at every sample, with no finding
//     and validation warns, once, that the ring is swept
//   - a ring with no settled value (flow = head + 1, head = flow) is valid too: the run carries on and its result holds one
//     ringDidNotSettle finding for the ring, at its first failing instant, naming both states and counting every step it failed in
//   - the same ring with explicit kinds and no settling goes round once a step: its Updates start at their initial values and
//     each step reads the step before, so it grows by one every second step, and nothing is found

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
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'ignore'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

const appearance = { type: 'primitive', shape: 'box', color: '#2f6970' };
// Pump's flow is set from Tank's head (flow = gain head + 1), and Tank's head from Pump's flow (head = flow).
function ring(gain, { kinds = false, limit } = {}) {
    const state = (id, name, symbol) => ({ id, name, symbol, initialValue: 0, unit: '', ...(kinds ? { kind: 'update' } : {}) });
    const node = (id, name, states, x) => ({ id, name, position: [x, 0, 0], appearance, sourceTerms: [], states, ...(limit ? { updatesLimit: limit } : {}) });
    const edge = (id, name, from, to, symbol, readStateId, setStateId, mathJson) => ({
        id, name, directionality: 'directed', source: { nodeId: from }, target: { nodeId: to }, parameters: [],
        equationModel: {
            bindings: [{ symbol, kind: 'state', role: 'source', nodeId: from, stateId: readStateId }],
            outputs: [{ role: 'target', stateId: setStateId, mathJson, setsValue: true }]
        }
    });
    return {
        format: 'konjugate', version: 1, metadata: { units: 'SI' },
        nodes: [node(1, 'Pump', [state(11, 'Flow', 'flow')], 0), node(2, 'Tank', [state(21, 'Head', 'head')], 3)],
        edges: [
            edge(5, 'Pump to Tank', 1, 2, 'flow', 11, 21, 'flow'),
            edge(6, 'Tank to Pump', 2, 1, 'head', 21, 11, ['Add', ['Multiply', gain, 'head'], 1])
        ]
    };
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const directory = await mkdtemp(join(tmpdir(), 'konjugateRingSettling-'));
// Validates `model`, runs it for 3 s in steps of 1 s, and returns its result.
async function run(model, name) {
    const inputPath = join(directory, `${name}.kjt`);
    const reportPath = join(directory, `${name}.report`);
    const outputPath = join(directory, `${name}.kjr`);
    const configurationPath = join(directory, `${name}.json`);
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(model)));
    await writeFile(configurationPath, JSON.stringify({ name, targetTime: 3, globalTimeStep: 1, outputInterval: 1 }));
    assert.equal(await execute(executable, ['validate', inputPath, '--report', reportPath]), 0);
    const report = decodeValidationReport(await readFile(reportPath));
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.equal(await execute(executable, ['run', inputPath, '--configuration', configurationPath, '--output', outputPath]), 0);
    return { ...decodeResultFile(await readFile(outputPath)), issues: report.issues };
}
const value = (sample, stateId) => sample.states.find((state) => state.stateId === stateId).value;

try {
    const settling = await run(ring(0.5), 'settling');
    for (const sample of settling.samples) {
        assert.ok(Math.abs(value(sample, 11) - 2) < 1e-9 && Math.abs(value(sample, 21) - 2) < 1e-9,
            `A ring with a settled value must settle on it within the step (t=${sample.time}: flow=${value(sample, 11)}, head=${value(sample, 21)}).`);
    }
    assert.deepEqual(settling.stabilityFindings, [], 'A ring that settles is not a finding.');
    const ringWarnings = settling.issues.filter((issue) => issue.code === 'updatesRing');
    assert.equal(ringWarnings.length, 1, 'Validation says, once, that a ring in settling nodes is swept.');
    assert.equal(ringWarnings[0].severity, 'warning');
    assert.match(ringWarnings[0].message, /Pump · Flow/);
    assert.match(ringWarnings[0].message, /Tank · Head/);

    const unsettled = await run(ring(1, { limit: 20 }), 'unsettled');
    assert.equal(unsettled.stabilityFindings.length, 1, 'A ring that does not settle is one finding, however many steps it fails in.');
    const [finding] = unsettled.stabilityFindings;
    assert.equal(finding.code, 'ringDidNotSettle');
    assert.equal(finding.globalTime, 0, 'The finding is at the first instant the ring did not settle: the run\'s start.');
    assert.ok([11, 21].includes(finding.stateId) && finding.nodeId === (finding.stateId === 11 ? 1 : 2), 'The finding points at a state in the ring and its node.');
    assert.match(finding.message, /Pump's flow/);
    assert.match(finding.message, /Tank's head/);
    assert.match(finding.message, /after 20 sweeps/);
    // The run's start, then three steps.
    assert.match(finding.message, /in 4 steps of the run/);

    const oncePerStep = await run(ring(1, { kinds: true }), 'oncePerStep');
    // An Update worked out once per step starts at its initial value, and each step reads the step before: flow = head(t) + 1
    // and head = flow(t).
    assert.deepEqual(oncePerStep.samples.map((sample) => [value(sample, 11), value(sample, 21)]), [[0, 0], [1, 0], [1, 1], [2, 1]],
        'A ring updated once per step goes round once a step.');
    assert.deepEqual(oncePerStep.stabilityFindings, [], 'A ring updated once per step is not a finding.');
    assert.ok(!oncePerStep.issues.some((issue) => issue.code === 'updatesRing'), 'A ring updated once per step is not swept, so not warned of.');
    console.log('Rings of updates: settled on their value, found when they do not settle, and once a step without settling.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
