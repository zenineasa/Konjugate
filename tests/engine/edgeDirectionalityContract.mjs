/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Regression test for a fixed modeling bug: an edge's "Bidirectional" directionality used to be
// cosmetic only (it just hid the arrowhead marker in the 3D view -- see createDirectionMarker()
// in src/renderer/renderer.mjs). Every edge, directed or bidirectional, compiled to exactly one
// contribution writing to exactly one state, so a "bidirectional" convective heat-transfer edge
// only ever updated its chosen target -- the source node's state never moved, and thermal energy
// was not conserved.
//
// Fixed in engine/src/executionPlan.cpp: a bidirectional edge now also applies the same computed
// value, sign-flipped, to its other endpoint's designated state (edge.source.stateId /
// edge.target.stateId, falling back to that node's first state) -- see the buildContribution
// lambda in compileExecutionPlan()'s edge loop, and ContributionTask::negateOutput.
//
// This test builds the smallest possible repro (two thermal masses, one bidirectional edge) and
// asserts both temperatures now move, reciprocally: this fixture's equation and both nodes share
// the same capacitance parameter, so the source's change is exactly the negative of the target's.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';

function execute(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

function model() {
    const hotNode = { id: 1, name: 'Node A', type: 'Thermal mass', position: [-2, 0, 0],
        states: [{ id: 2, name: 'Temperature', symbol: 'temperature', initialValue: 353.2, unit: 'K' }],
        sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#2f6970' } };
    const coldNode = { id: 4, name: 'Node B', type: 'Thermal mass', position: [2, 0, 0],
        states: [{ id: 5, name: 'Temperature', symbol: 'temperature', initialValue: 293.15, unit: 'K' }],
        sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#2e7591' } };

    // Deliberately built the way the UI produces a "Bidirectional" edge: one equation, one
    // chosen output ("Updates: target.x" in the editor), driven by both nodes' temperatures.
    const edge = {
        id: 8, name: 'Heat transfer', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 4, stateId: 5 },
        directionality: 'bidirectional',
        equation: '\\frac{\\mathrm{heatTransferCoefficient}\\cdot(\\mathrm{sourceTemperature}-\\mathrm{targetTemperature})}{\\mathrm{targetThermalCapacitance}}',
        equationModel: {
            latex: '\\frac{\\mathrm{heatTransferCoefficient}\\cdot(\\mathrm{sourceTemperature}-\\mathrm{targetTemperature})}{\\mathrm{targetThermalCapacitance}}',
            output: { role: 'target', stateId: 5 },
            bindings: [
                { kind: 'state', role: 'source', nodeId: 1, stateId: 2, symbol: 'sourceTemperature' },
                { kind: 'state', role: 'target', nodeId: 4, stateId: 5, symbol: 'targetTemperature' },
                { kind: 'parameter', parameterId: 9, symbol: 'heatTransferCoefficient' },
                { kind: 'parameter', parameterId: 10, symbol: 'targetThermalCapacitance' }
            ],
            mathJson: ['Divide',
                ['Multiply', 'heatTransferCoefficient', ['Add', 'sourceTemperature', ['Negate', 'targetTemperature']]],
                'targetThermalCapacitance']
        },
        parameters: [
            { id: 9, name: 'Heat transfer coefficient', symbol: 'heatTransferCoefficient', value: 8, unit: 'W/K', mode: 'constant' },
            { id: 10, name: 'Target thermal capacitance', symbol: 'targetThermalCapacitance', value: 5025, unit: 'J/K', mode: 'constant' }
        ],
        appearance: { color: '#e6a15b', offset: 0 }
    };

    return {
        format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
        metadata: { units: 'SI' }, nodes: [hotNode, coldNode], edges: [edge]
    };
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const directory = await mkdtemp(join(tmpdir(), 'konjugateEdgeDirectionality-'));

try {
    const inputPath = join(directory, 'bidirectionalEdge.kjt');
    const configurationPath = join(directory, 'configuration.json');
    const outputPath = join(directory, 'result.bin');
    const validationPath = join(directory, 'validation.bin');
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(model())));
    await writeFile(configurationPath, JSON.stringify({ name: 'edgeDirectionalityContract', targetTime: 5, globalTimeStep: 0.01, outputInterval: 5 }, null, 4));

    assert.equal(await execute(executable, ['validate', inputPath, '--report', validationPath]), 0, 'The bidirectional-edge repro model must validate.');
    assert.equal(await execute(executable, ['run', inputPath, '--configuration', configurationPath, '--output', outputPath]), 0, 'The bidirectional-edge repro model must run.');

    const result = decodeResultFile(await readFile(outputPath));
    const final = result.samples.at(-1);
    const sourceTemperature = final.states.find((state) => state.stateId === 2).value;
    const targetTemperature = final.states.find((state) => state.stateId === 5).value;

    // Both temperatures move now: the hot source (id 1) cools, the cold target (id 5) warms.
    assert.ok(sourceTemperature < 353.2, 'The bidirectional edge should cool its source node.');
    assert.ok(targetTemperature > 293.15, 'The bidirectional edge should warm its target node.');

    // This fixture's equation divides by the same targetThermalCapacitance parameter for both
    // the primary and the sign-flipped complementary contribution, so the two temperature
    // changes should be exact negatives of each other (reciprocal, not just "both moved").
    const sourceChange = sourceTemperature - 353.2;
    const targetChange = targetTemperature - 293.15;
    assert.ok(Math.abs(sourceChange + targetChange) < 1e-9,
        `Expected the source and target temperature changes to be equal and opposite; got ${sourceChange} and ${targetChange}.`);

    console.log('✓ edge directionality contract: "bidirectional" edges apply a reciprocal contribution to both endpoints.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
