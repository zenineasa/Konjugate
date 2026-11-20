/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Contract for the cross-model algebraic pass, run end to end:
//   - a chain clock -> relationship -> setsValue source term -> relationship settles within each instant: with a = t,
//     y = 2a, s = y + 1 and v = 3s, every sample has v = 6t + 3 exactly (the source term joins the pass because it
//     reads y, which a relationship sets; before it did, v was a step late)
//   - a node reading v through an ordinary edge integrates the value at each step's start (a left Riemann sum)
//   - a Python computational-node provider reading s keeps its co-simulation meaning: its output at t + h is from the
//     inputs it read at t, so it is exactly one step behind and starts at the output's initial value

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

const providerSource = `from konjugate import NodeProvider, NodeProviderDescription, ScalarPort


class Triple(NodeProvider):
    def describe(self):
        return NodeProviderDescription("test.triple", "Triple", [ScalarPort("s", "S", "")], [ScalarPort("out", "Out", "")])

    def evaluate(self, context, inputs, outputs):
        outputs.add_gradient("out", 3 * inputs["s"])

    def checkpoint(self):
        return b""

    def restore(self, payload):
        pass
`;

const appearance = { type: 'primitive', shape: 'sphere', color: '#2f6970' };
const sets = (id, name, from, fromState, to, toState, mathJson) => ({
    id, name, directionality: 'directed', source: { nodeId: from }, target: { nodeId: to }, parameters: [],
    equationModel: {
        bindings: [{ symbol: 'x', kind: 'state', role: 'source', nodeId: from, stateId: fromState }],
        outputs: [{ role: 'target', stateId: toState, mathJson, setsValue: true }]
    }
});
const document = {
    format: 'konjugate', version: 1, metadata: { units: 'SI' },
    nodes: [
        {
            id: 1, name: 'Clock', position: [0, 0, 0], appearance,
            states: [{ id: 11, name: 'a', symbol: 'a', initialValue: 0, unit: '' }],
            sourceTerms: [{
                id: 12, state: 'a', expression: 't', setsValue: true,
                expressionModel: { latex: 't', output: { stateId: 11 }, mathJson: 't', bindings: [{ kind: 'time', symbol: 't' }] }
            }]
        },
        {
            id: 2, name: 'B', position: [3, 0, 0], appearance,
            states: [{ id: 21, name: 'y', symbol: 'y', initialValue: 0, unit: '' }, { id: 22, name: 's', symbol: 's', initialValue: 0, unit: '' }],
            sourceTerms: [{
                id: 23, state: 's', expression: 'y + 1', setsValue: true,
                expressionModel: { latex: 'y + 1', output: { stateId: 22 }, mathJson: ['Add', 'y', 1], bindings: [{ kind: 'state', nodeId: 2, stateId: 21, symbol: 'y' }] }
            }]
        },
        { id: 4, name: 'D', position: [6, 0, 0], appearance, sourceTerms: [], states: [{ id: 41, name: 'v', symbol: 'v', initialValue: 0, unit: '' }] },
        { id: 5, name: 'Reader', position: [9, 0, 0], appearance, sourceTerms: [], states: [{ id: 51, name: 'Integral', symbol: 'integral', initialValue: 0, unit: '' }] },
        {
            id: 3, name: 'Program', position: [6, 3, 0], appearance, sourceTerms: [],
            states: [{ id: 31, name: 'o', symbol: 'o', initialValue: 0, unit: '' }],
            implementation: {
                kind: 'python', providerApiVersion: 1, source: providerSource,
                bindings: [{ key: 's', kind: 'state', nodeId: 2, stateId: 22 }],
                outputs: [{ key: 'out', stateId: 31, setsValue: true }]
            }
        }
    ],
    edges: [
        sets(6, 'Clock to B', 1, 11, 2, 21, ['Multiply', 2, 'x']),
        sets(7, 'B to D', 2, 22, 4, 41, ['Multiply', 3, 'x']),
        {
            id: 8, name: 'Read v', source: { nodeId: 4, stateId: 41 }, target: { nodeId: 5, stateId: 51 }, directionality: 'directed', equation: 'sourceV', parameters: [],
            equationModel: { latex: '\\mathrm{sourceV}', output: { role: 'target', stateId: 51 }, mathJson: 'sourceV', bindings: [{ kind: 'state', role: 'source', nodeId: 4, stateId: 41, symbol: 'sourceV' }] }
        }
    ]
};

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const sdkPath = join(import.meta.dirname, '..', '..', 'engine', 'sdk', 'python');
const directory = await mkdtemp(join(tmpdir(), 'konjugateAlgebraicPass-'));

try {
    const inputPath = join(directory, 'model.kjt');
    const reportPath = join(directory, 'model.report');
    const outputPath = join(directory, 'model.kjr');
    const configurationPath = join(directory, 'run.json');
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(document)));
    await writeFile(configurationPath, JSON.stringify({ name: 'contract', targetTime: 4, globalTimeStep: 1, outputInterval: 1, providers: { python: { sdkPath } } }));
    assert.equal(await execute(executable, ['validate', inputPath, '--report', reportPath]), 0);
    const report = decodeValidationReport(await readFile(reportPath));
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.equal(await execute(executable, ['run', inputPath, '--configuration', configurationPath, '--output', outputPath]), 0);
    const samples = decodeResultFile(await readFile(outputPath)).samples.map((sample) => ({
        time: sample.time,
        value: Object.fromEntries(sample.states.map((state) => [state.stateId, state.value]))
    }));
    assert.equal(samples.length, 5);

    for (const { time, value } of samples) {
        assert.equal(value[11], time, `a = t at t=${time}`);
        assert.equal(value[22], 2 * time + 1, `s = 2t + 1 within the instant at t=${time}`);
        assert.equal(value[41], 6 * time + 3, `v = 3s within the instant at t=${time}`);
    }
    // The reader integrates v at each step's start: 0, 3, 3 + 9, 3 + 9 + 15, ...
    assert.deepEqual(samples.map(({ value }) => value[51]), [0, 3, 12, 27, 48], 'An ordinary edge reads v as it stood at each step\'s start.');
    // The program is a co-simulation step: o(t + h) = 3 s(t), from its initial value 0 at t = 0.
    assert.deepEqual(samples.map(({ value }) => value[31]), [0, 3, 9, 15, 21], 'A node program\'s output at t + h is from the inputs it read at t.');

    // A neuron written as the equation says: states marked worked out at each instant, ordinary relationships into them
    // and the bias as the neuron's own term. z = 2a + 1 and y = 3z, so y = 6t + 3 at every sample.
    const plain = (id, name, from, fromState, to, toState, mathJson) => ({
        id, name, directionality: 'directed', source: { nodeId: from, stateId: fromState }, target: { nodeId: to, stateId: toState }, equation: 'x', parameters: [],
        equationModel: { latex: 'x', output: { role: 'target', stateId: toState }, mathJson, bindings: [{ kind: 'state', role: 'source', nodeId: from, stateId: fromState, symbol: 'x' }] }
    });
    const neuron = {
        format: 'konjugate', version: 1, metadata: { units: 'SI' },
        nodes: [
            document.nodes[0],
            {
                id: 6, name: 'Neuron', position: [3, 0, 0], appearance,
                states: [{ id: 61, name: 'z', symbol: 'z', initialValue: 0, unit: '', changes: 'atEachInstant' }],
                sourceTerms: [{ id: 62, state: 'z', expression: '1', expressionModel: { latex: '1', output: { stateId: 61 }, mathJson: 1, bindings: [] } }]
            },
            { id: 7, name: 'Out', position: [6, 0, 0], appearance, sourceTerms: [], states: [{ id: 71, name: 'y', symbol: 'y', initialValue: 0, unit: '', changes: 'atEachInstant' }] }
        ],
        edges: [plain(8, 'Weight', 1, 11, 6, 61, ['Multiply', 2, 'x']), plain(9, 'Out', 6, 61, 7, 71, ['Multiply', 3, 'x'])]
    };
    const neuronPath = join(directory, 'neuron.kjt');
    await writeFile(neuronPath, await encodeProjectFile(JSON.stringify(neuron)));
    assert.equal(await execute(executable, ['validate', neuronPath, '--report', reportPath]), 0);
    const neuronReport = decodeValidationReport(await readFile(reportPath));
    assert.equal(neuronReport.valid, true, JSON.stringify(neuronReport.issues));
    assert.deepEqual(neuronReport.issues, [], 'A neuron written as the equation says has nothing to warn about.');
    assert.equal(await execute(executable, ['run', neuronPath, '--configuration', configurationPath, '--output', outputPath]), 0);
    for (const sample of decodeResultFile(await readFile(outputPath)).samples) {
        const value = Object.fromEntries(sample.states.map((state) => [state.stateId, state.value]));
        assert.equal(value[61], 2 * sample.time + 1, `z = 2a + 1 within the instant at t=${sample.time}`);
        assert.equal(value[71], 6 * sample.time + 3, `y = 3z within the instant at t=${sample.time}`);
    }

    // A program setting a state marked worked out is a term like any other: o = 3s at the instant, no step behind.
    const pure = structuredClone(document);
    const program = pure.nodes.find((node) => node.id === 3);
    program.states[0].changes = 'atEachInstant';
    delete program.implementation.outputs[0].setsValue;
    const purePath = join(directory, 'pure.kjt');
    await writeFile(purePath, await encodeProjectFile(JSON.stringify(pure)));
    assert.equal(await execute(executable, ['validate', purePath, '--report', reportPath]), 0);
    assert.equal(await execute(executable, ['run', purePath, '--configuration', configurationPath, '--output', outputPath]), 0);
    for (const sample of decodeResultFile(await readFile(outputPath)).samples) {
        const value = Object.fromEntries(sample.states.map((state) => [state.stateId, state.value]));
        assert.equal(value[31], 6 * sample.time + 3, `a program setting a worked-out state gives o = 3s at the instant, t=${sample.time}`);
    }
    // The same wiring with a program that keeps state (its checkpoint holds its running total) is stopped before the
    // first step, naming the node: worked out at each instant it may be asked more than once at one instant.
    const stateful = structuredClone(pure);
    stateful.nodes.find((node) => node.id === 3).implementation.source = providerSource
        .replace('    def evaluate(self, context, inputs, outputs):\n        outputs.add_gradient("out", 3 * inputs["s"])',
            '    total = 0.0\n\n    def evaluate(self, context, inputs, outputs):\n        self.total += inputs["s"]\n        outputs.add_gradient("out", self.total)')
        .replace('        return b""', '        import struct\n        return struct.pack("!d", self.total)');
    assert.match(stateful.nodes.find((node) => node.id === 3).implementation.source, /self\.total \+= inputs/, 'The stateful program was not written as meant.');
    const statefulPath = join(directory, 'stateful.kjt');
    await writeFile(statefulPath, await encodeProjectFile(JSON.stringify(stateful)));
    const failure = await new Promise((resolve, reject) => {
        const child = spawn(executable, ['run', statefulPath, '--configuration', configurationPath, '--output', outputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, stderr }));
    });
    assert.notEqual(failure.code, 0, 'A program keeping state, setting a worked-out state, should stop the run.');
    assert.match(failure.stderr, /The program of node 3 sets states worked out at each instant, so it must keep no state of its own, but its checkpoint holds 8 bytes/);

    console.log('✓ algebraic pass contract: a chain through a setsValue source term settles within each instant, an ordinary edge reads it at each step\'s start, a node program stays one co-simulation step behind its inputs, a neuron of ordinary terms into worked-out states is its equation at every instant, and a program setting a worked-out state is worked out at the instant, or stopped before the first step if it keeps state.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
