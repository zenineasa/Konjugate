/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Contract for a chain of Updates that crosses nodes (docs/proposals/ratesAndUpdates.md, settling within the step), through
// the engine's own run. Three nodes in a row, each with one Update, set by relationships: First's a = t, Second's b = a,
// Third's c = b.
//   - every node settling: the chain settles within the step across both node boundaries -- a = b = c = t at every sample,
//     on the serial, thread-pool and partitioned backends alike, so a node boundary adds no step of lag
//   - no node settling (each works its Updates out once per step): each link reads the step before, so b = t - 1 and
//     c = t - 2 -- one step of lag per link, the "before" of settling
//   - only Second working once per step: the lag is where the once-per-step link is, b = t - 1 and c = b (c settles on it)
//   - the same chain as one file saying no kinds (every node settling, as an older file opens) gives the settling numbers
//   - over a subsystem: with no node saying it settles, the three nodes in a subsystem that settles -- or Second and Third
//     in one nested inside a subsystem that settles, First outside once per step -- settle as if each node said so, on every
//     backend, whether the engine reads the subsystems from the file (the command line) or the canvas flattens them first
//     (executionProjectDocument); a subsystem saying nothing leaves its nodes as they say

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { executionProjectDocument } from '../../src/subsystems.mjs';

function execute(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'ignore'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

const appearance = { type: 'primitive', shape: 'box', color: '#2f6970' };
// `settles` lists the nodes (1, 2, 3) that settle; `kinds` false writes a file that says no kind at all.
function chain({ settles = [1, 2, 3], kinds = true } = {}) {
    const node = (id, name, symbol, x) => ({
        id, name, position: [x, 0, 0], appearance, sourceTerms: [],
        states: [{ id: id * 10 + 1, name, symbol, initialValue: 0, unit: '', ...(kinds ? { kind: 'update' } : {}) }],
        ...(kinds && settles.includes(id) ? { updates: 'settle' } : {})
    });
    const edge = (id, from, to, bindings, mathJson) => ({
        id, name: `Link ${id}`, directionality: 'directed', source: { nodeId: from }, target: { nodeId: to }, parameters: [],
        equationModel: { bindings, outputs: [{ role: 'target', stateId: to * 10 + 1, mathJson, setsValue: true }] }
    });
    return {
        format: 'konjugate', version: 1, metadata: { units: 'SI' },
        nodes: [node(1, 'First', 'a', 0), node(2, 'Second', 'b', 3), node(3, 'Third', 'c', 6)],
        edges: [
            // First's a = t: a relationship into First, from Third, reading only the time.
            edge(4, 3, 1, [{ symbol: 't', kind: 'time' }], 't'),
            edge(5, 1, 2, [{ symbol: 'a', kind: 'state', role: 'source', nodeId: 1, stateId: 11 }], 'a'),
            edge(6, 2, 3, [{ symbol: 'b', kind: 'state', role: 'source', nodeId: 2, stateId: 21 }], 'b')
        ]
    };
}

// The chain with its nodes in subsystems, no node saying it settles: `memberOf` gives each node's subsystem, `subsystems`
// their records.
function inSubsystems(memberOf, subsystems) {
    const model = chain({ settles: [] });
    model.nodes.forEach((node) => { if (memberOf[node.id] !== undefined) node.subsystemId = memberOf[node.id]; });
    model.subsystems = subsystems.map((subsystem) => ({ parentSubsystemId: null, position: [0, 0, 0], ...subsystem }));
    return model;
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const directory = await mkdtemp(join(tmpdir(), 'konjugateUpdateChain-'));
let runs = 0;
// Runs `model` for 4 s in steps of 1 s and returns each sample's [t, a, b, c].
async function run(model, execution = null) {
    const name = `run${runs++}`;
    const inputPath = join(directory, `${name}.kjt`);
    const outputPath = join(directory, `${name}.kjr`);
    const configurationPath = join(directory, `${name}.json`);
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(model)));
    await writeFile(configurationPath, JSON.stringify({ name, targetTime: 4, globalTimeStep: 1, outputInterval: 1, ...(execution ? { execution } : {}) }));
    assert.equal(await execute(executable, ['run', inputPath, '--configuration', configurationPath, '--output', outputPath]), 0);
    const result = decodeResultFile(await readFile(outputPath));
    const value = (sample, stateId) => sample.states.find((state) => state.stateId === stateId).value;
    return result.samples.map((sample) => [sample.time, value(sample, 11), value(sample, 21), value(sample, 31)]);
}
// [t, a, b, c] expected from t at each sample, the lag of b and c behind t given, never below the initial value 0.
const expected = (samples, lagB, lagC) => samples.map(([time]) => [time, time, Math.max(0, time - lagB), Math.max(0, time - lagC)]);

try {
    const backends = [null, { backend: 'threadPool', workerThreads: 3 }, { backend: 'partitioned', partitionCount: 3, workerThreads: 3 }];
    for (const execution of backends) {
        const settled = await run(chain(), execution);
        assert.ok(settled.length >= 4, 'The run must record a sample a second.');
        assert.deepEqual(settled, expected(settled, 0, 0),
            `Every node settling, a chain of Updates across nodes settles within the step (${execution?.backend ?? 'serial'}).`);
    }
    const oncePerStep = await run(chain({ settles: [] }));
    assert.deepEqual(oncePerStep, expected(oncePerStep, 1, 2), 'Once per step, each link of the chain is a step late.');
    const middleOnce = await run(chain({ settles: [1, 3] }));
    assert.deepEqual(middleOnce, expected(middleOnce, 1, 1), 'The lag is only at the link worked out once per step.');
    const legacy = await run(chain({ kinds: false }));
    assert.deepEqual(legacy, expected(legacy, 0, 0), 'A file that says no kind settles every node, as it did.');
    const allIn = inSubsystems({ 1: 7, 2: 7, 3: 7 }, [{ id: 7, name: 'Chain', updates: 'settle' }]);
    const nested = inSubsystems({ 2: 9, 3: 9 }, [{ id: 7, name: 'Outer', updates: 'settle', updatesLimit: 50 }, { id: 9, name: 'Inner', parentSubsystemId: 7 }]);
    for (const execution of backends) {
        for (const read of [(model) => model, (model) => executionProjectDocument(model)]) {
            const whole = await run(read(allIn), execution);
            assert.deepEqual(whole, expected(whole, 0, 0), `A subsystem that settles settles its nodes' chain (${execution?.backend ?? 'serial'}).`);
            // First, outside, works its Update out once per step; Second reads it as set, and Third settles on Second.
            const inner = await run(read(nested), execution);
            assert.deepEqual(inner, expected(inner, 0, 0), `A subsystem settles the nodes of the subsystems inside it (${execution?.backend ?? 'serial'}).`);
        }
    }
    const flattened = executionProjectDocument(nested);
    assert.deepEqual(flattened.nodes.map((node) => [node.updates, node.updatesLimit]), [[undefined, undefined], ['settle', 50], ['settle', 50]],
        'Flattened, a node in a settling subsystem says it settles, with the subsystem\'s limit, and one outside is as it was.');
    const quiet = await run(inSubsystems({ 1: 7, 2: 7, 3: 7 }, [{ id: 7, name: 'Chain' }]));
    assert.deepEqual(quiet, expected(quiet, 1, 2), 'A subsystem saying nothing leaves its nodes as they say.');
    console.log('updateChainAcrossNodes: chains of Updates across settling nodes settle within the step on every backend.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
