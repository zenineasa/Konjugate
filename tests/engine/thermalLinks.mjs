/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs the Thermal link bundle and the One-way conduction edge from the component library through the real engine and
// compares them with the physics worked out by hand. Two bodies of very different thermal capacitance are the case the
// old bidirectional Conduction got wrong (it applied the target's temperature rate to both ends, so heat leaving one body
// did not equal heat entering the other); a Temperature boundary is the case it could not do at all (it drifted).
//
// Each node has no capacitance of its own: it lives on the edge that warms it, as the "thermal capacitance" parameter.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/thermalLinks.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateComponentTemplate } from '../../src/componentTemplate.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const template = async (id) => validateComponentTemplate(JSON.parse(await readFile(join(root, 'assets', 'componentLibrary', `${id}.json`), 'utf8')));

const node = (id, name, temperature) => ({
    id, name, appearance: { type: 'primitive', shape: 'box', color: '#888888' },
    states: [{ id: id + 1, name: 'Temperature', symbol: 'temperature', initialValue: temperature, unit: 'K' }], sourceTerms: []
});

// The edge a template describes, between two of these nodes, with its parameters set to the given values. The equation is
// the template's own; its compiled form is written out here, since compiling LaTeX is the canvas's job.
function edgeFrom(templateEdge, { id, from, to, directed = true, parameterValues, sharedIds = {} }) {
    return {
        id, name: templateEdge.name, source: { nodeId: from.id, stateId: from.id + 1 }, target: { nodeId: to.id, stateId: to.id + 1 },
        directionality: directed ? 'directed' : 'bidirectional', equation: templateEdge.latex,
        parameters: templateEdge.parameters.map((parameter, index) => ({
            id: id + 1 + index, name: parameter.name, symbol: parameter.symbol, value: parameterValues[parameter.symbol], unit: parameter.unit ?? 'W/K', mode: 'constant',
            ...(parameter.shared ? { sharedParameterId: sharedIds[parameter.shared] } : {})
        })),
        equationModel: {
            latex: templateEdge.latex, output: { role: 'target', stateId: to.id + 1 },
            mathJson: ['Divide', ['Multiply', 'conductance', ['Add', 'sourceTemperature', ['Negate', 'targetTemperature']]], 'thermalCapacitance'],
            bindings: [
                { kind: 'state', role: 'source', nodeId: from.id, stateId: from.id + 1, symbol: 'sourceTemperature' },
                { kind: 'state', role: 'target', nodeId: to.id, stateId: to.id + 1, symbol: 'targetTemperature' },
                { kind: 'parameter', parameterId: id + 1, symbol: 'conductance' },
                { kind: 'parameter', parameterId: id + 2, symbol: 'thermalCapacitance' }
            ]
        }
    };
}

const directory = await mkdtemp(join(tmpdir(), 'konjugateThermal-'));
let runNumber = 0;
async function run(document, targetTime) {
    runNumber += 1;
    const input = join(directory, `run${runNumber}.kjt`);
    const configuration = join(directory, `run${runNumber}.json`);
    const output = join(directory, `run${runNumber}.bin`);
    await writeFile(input, await encodeProjectFile(`${JSON.stringify(document)}\n`));
    await writeFile(configuration, JSON.stringify({ name: 'Thermal', targetTime, globalTimeStep: 0.001, outputInterval: 0.5, execution: { backend: 'serial' } }));
    await new Promise((resolve, reject) => {
        const child = spawn(executable, ['run', input, '--configuration', configuration, '--output', output], { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(diagnostics || `The engine exited with code ${code}.`))));
    });
    return decodeResultFile(await readFile(output)).samples;
}
const temperatureAt = (sample, nodeId) => sample.states.find((state) => state.stateId === nodeId + 1).value;
const near = (actual, expected, tolerance, what) => assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: expected ${expected} within ${tolerance}, got ${actual}.`);

try {
    // ---- Thermal link: a 1000 J/K battery pack at 350 K next to a 50 J/K housing at 300 K, 10 W/K between them ----------
    const link = await template('thermalLink');
    assert.deepEqual(link.edges.map((edge) => [edge.from, edge.to, Boolean(edge.bidirectional)]), [['first', 'second', false], ['second', 'first', false]],
        'The Thermal link must be two directed edges, one each way.');
    const pack = node(1, 'Pack', 350);
    const housing = node(10, 'Housing', 300);
    const [intoSecond, intoFirst] = link.edges;
    const packCapacity = 1000;
    const housingCapacity = 50;
    const conductance = 10;
    const linked = {
        format: 'konjugate', version: 1,
        sharedParameters: [{ id: 100, name: 'Conductance', symbol: 'conductance', value: conductance, unit: 'W/K', mode: 'constant' }],
        nodes: [pack, housing],
        edges: [
            edgeFrom(intoSecond, { id: 20, from: pack, to: housing, parameterValues: { conductance, thermalCapacitance: housingCapacity }, sharedIds: { conductance: 100 } }),
            edgeFrom(intoFirst, { id: 30, from: housing, to: pack, parameterValues: { conductance, thermalCapacitance: packCapacity }, sharedIds: { conductance: 100 } })
        ]
    };
    const samples = await run(linked, 5);
    const energy = (sample) => packCapacity * temperatureAt(sample, 1) + housingCapacity * temperatureAt(sample, 10);
    const equilibrium = (packCapacity * 350 + housingCapacity * 300) / (packCapacity + housingCapacity);
    const rate = conductance * (1 / packCapacity + 1 / housingCapacity);
    for (const sample of samples) {
        // Heat leaving the pack is heat entering the housing, to rounding, at every sample.
        near(energy(sample), energy(samples[0]), 1e-6, `energy at ${sample.time} s`);
        // And both bodies follow the exact exponential of the two-body problem (Euler error at 1 ms steps is far below this).
        const decay = Math.exp(-rate * sample.time);
        near(temperatureAt(sample, 10), equilibrium + (300 - equilibrium) * decay, 0.01, `housing at ${sample.time} s`);
        near(temperatureAt(sample, 1), equilibrium + (350 - equilibrium) * decay, 0.001, `pack at ${sample.time} s`);
    }
    // The pack barely moves while the housing swings, in exactly the ratio of their capacitances, which the old edge got wrong.
    const last = samples.at(-1);
    near((temperatureAt(last, 10) - 300) / (350 - temperatureAt(last, 1)), packCapacity / housingCapacity, 0.05, 'ratio of the temperature changes');

    // ---- One-way conduction: a 350 K boundary warming a 1000 J/K mass at 300 K through 50 W/K ---------------------------
    const oneWay = await template('oneWayConduction');
    assert.equal(oneWay.bidirectional, undefined, 'One-way conduction must not be bidirectional.');
    const boundary = node(1, 'Boundary', 350);
    const mass = node(10, 'Mass', 300);
    const heated = {
        format: 'konjugate', version: 1, nodes: [boundary, mass],
        edges: [edgeFrom(oneWay, { id: 20, from: boundary, to: mass, parameterValues: { conductance: 50, thermalCapacitance: 1000 } })]
    };
    const heatedSamples = await run(heated, 5);
    for (const sample of heatedSamples) {
        assert.equal(temperatureAt(sample, 1), 350, `The boundary moved at ${sample.time} s.`);
        near(temperatureAt(sample, 10), 350 - 50 * Math.exp(-(50 / 1000) * sample.time), 0.01, `mass at ${sample.time} s`);
    }

    // ---- And the library's old bidirectional Conduction, for the record, does not do this -----------------------------
    const conduction = await template('conduction');
    assert.equal(conduction.bidirectional, true);
    const old = {
        format: 'konjugate', version: 1, nodes: [node(1, 'Pack', 350), node(10, 'Housing', 300)],
        edges: [edgeFrom(conduction, { id: 20, from: node(1, 'Pack', 350), to: node(10, 'Housing', 300), directed: false, parameterValues: { conductance, thermalCapacitance: housingCapacity } })]
    };
    const oldSamples = await run(old, 0.5);
    const drift = Math.abs(energy(oldSamples.at(-1)) - energy(oldSamples[0]));
    assert.ok(drift > 100, `Expected the bidirectional Conduction to lose energy between unequal bodies, drift was ${drift}.`);

    console.log('Thermal link and One-way conduction give the right heat flow through the real engine.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
