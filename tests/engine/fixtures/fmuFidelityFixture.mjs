/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Shared fixture for both FMU fidelity checks (tests/engine/fmiExportFidelity.mjs, the FMPy-based
// independent check, and tests/engine/fmiRoundTrip.mjs, the dependency-free dlopen-based one) --
// kept in one place so the two checks can't silently drift apart. A 4-node model with a live
// parameter, a tunable constant parameter, a cross-node edge, a bidirectional edge, and a
// multi-substep node -- enough to exercise the same graph shapes codeExportFidelity.mjs already
// covers for the plain export, plus fmi2SetReal. A fifth node adds algebraic (setsValue) states,
// declared out of dependency order and read by an ordinary differential term.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { encodeProjectFile } from '../../../src/projectFile.mjs';
import { decodeResultFile } from '../../../src/engineProtocol.mjs';
import { decodeValidationReport } from '../../../src/reportProtocol.mjs';
import { addScheduledNode } from './scheduledNodeFixture.mjs';

export function execute(executable, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options });
        let stdout = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, stdout }));
    });
}

export function closeEnough(actual, expected, absoluteTolerance, relativeTolerance) {
    return Math.abs(actual - expected) <= absoluteTolerance + relativeTolerance * Math.max(Math.abs(actual), Math.abs(expected));
}

export const nodeIds = { source: 1, squarer: 2, adder: 3, coupled: 4, algebraic: 5 };
export const stateIds = { source: 11, squarer: 12, adder: 13, coupled: 14, driver: 15, doubled: 16, shifted: 17, follower: 18 };
export const paramIds = { k: 21, growth: 22, coupling: 23 };

export const document = {
    format: 'konjugate', version: 1, metadata: { projectName: 'FMU fidelity fixture' },
    nodes: [
        {
            id: nodeIds.source, name: 'Source',
            states: [{ id: stateIds.source, name: 'Level', symbol: 'level', initialValue: 9, unit: '' }],
            numerics: { substepsPerGlobalStep: 1 },
            sourceTerms: [{
                id: 101, state: 'level', expression: '-k level',
                expressionModel: {
                    latex: '-k x', bindings: [
                        { kind: 'state', nodeId: nodeIds.source, stateId: stateIds.source, symbol: 'x' },
                        { kind: 'parameter', parameterId: paramIds.k, symbol: 'k' }
                    ],
                    output: { stateId: stateIds.source }, mathJson: ['Multiply', ['Negate', 'k'], 'x']
                },
                parameters: [{ id: paramIds.k, name: 'Decay rate', symbol: 'k', value: 0.2, mode: 'live', control: { minimum: 0, maximum: 1, step: 0.01 } }]
            }]
        },
        {
            id: nodeIds.squarer, name: 'Squarer',
            states: [{ id: stateIds.squarer, name: 'Value', symbol: 'value', initialValue: 1, unit: '' }],
            numerics: { substepsPerGlobalStep: 3 },
            sourceTerms: []
        },
        {
            id: nodeIds.adder, name: 'Adder',
            states: [{ id: stateIds.adder, name: 'Value', symbol: 'value', initialValue: 0, unit: '' }],
            numerics: { substepsPerGlobalStep: 1 },
            sourceTerms: [{
                id: 102, state: 'value', expression: '-0.05 value + growth',
                expressionModel: {
                    latex: '-0.05 x + g', bindings: [
                        { kind: 'state', nodeId: nodeIds.adder, stateId: stateIds.adder, symbol: 'x' },
                        { kind: 'parameter', parameterId: paramIds.growth, symbol: 'g' }
                    ],
                    output: { stateId: stateIds.adder }, mathJson: ['Add', ['Multiply', '-0.05', 'x'], 'g']
                },
                parameters: [{ id: paramIds.growth, name: 'Growth', symbol: 'g', value: 0.3, mode: 'constant' }]
            }]
        },
        {
            id: nodeIds.coupled, name: 'Coupled',
            states: [{ id: stateIds.coupled, name: 'Value', symbol: 'value', initialValue: 2, unit: '' }],
            numerics: { substepsPerGlobalStep: 1 },
            sourceTerms: []
        },
        {
            id: nodeIds.algebraic, name: 'Algebraic',
            states: [
                { id: stateIds.driver, name: 'Driver', symbol: 'driver', initialValue: 1, unit: '' },
                { id: stateIds.doubled, name: 'Doubled', symbol: 'doubled', initialValue: 0, unit: '' },
                { id: stateIds.shifted, name: 'Shifted', symbol: 'shifted', initialValue: 0, unit: '' },
                { id: stateIds.follower, name: 'Follower', symbol: 'follower', initialValue: 0, unit: '' }
            ],
            numerics: { substepsPerGlobalStep: 2 },
            sourceTerms: [
                {
                    id: 103, state: 'driver', expression: '0.5 + 0.2 t',
                    expressionModel: {
                        latex: '0.5 + 0.2 t', bindings: [{ kind: 'time', symbol: 't' }],
                        output: { stateId: stateIds.driver }, mathJson: ['Add', '0.5', ['Multiply', '0.2', 't']]
                    }
                },
                {
                    id: 104, state: 'shifted', expression: 'doubled + 1 + t', setsValue: true,
                    expressionModel: {
                        latex: 'y + 1 + t', bindings: [{ kind: 'state', nodeId: nodeIds.algebraic, stateId: stateIds.doubled, symbol: 'y' }, { kind: 'time', symbol: 't' }],
                        output: { stateId: stateIds.shifted }, mathJson: ['Add', 'y', '1', 't']
                    }
                },
                {
                    id: 105, state: 'doubled', expression: '2 driver', setsValue: true,
                    expressionModel: {
                        latex: '2 x', bindings: [{ kind: 'state', nodeId: nodeIds.algebraic, stateId: stateIds.driver, symbol: 'x' }],
                        output: { stateId: stateIds.doubled }, mathJson: ['Multiply', '2', 'x']
                    }
                },
                {
                    id: 106, state: 'follower', expression: '0.8 (shifted - follower)',
                    expressionModel: {
                        latex: '0.8 (s - f)', bindings: [
                            { kind: 'state', nodeId: nodeIds.algebraic, stateId: stateIds.shifted, symbol: 's' },
                            { kind: 'state', nodeId: nodeIds.algebraic, stateId: stateIds.follower, symbol: 'f' }
                        ],
                        output: { stateId: stateIds.follower }, mathJson: ['Multiply', '0.8', ['Add', 's', ['Negate', 'f']]]
                    }
                }
            ]
        }
    ],
    edges: [
        {
            id: 201, name: 'Source to Squarer', source: { nodeId: nodeIds.source, stateId: stateIds.source }, target: { nodeId: nodeIds.squarer, stateId: stateIds.squarer },
            directionality: 'directed',
            equationModel: {
                latex: '0.4 \\sqrt{|x|}', bindings: [
                    { kind: 'state', role: 'source', nodeId: nodeIds.source, stateId: stateIds.source, symbol: 'x' }
                ],
                output: { role: 'target', stateId: stateIds.squarer }, mathJson: ['Multiply', '0.4', ['Sqrt', ['Abs', 'x']]]
            },
            parameters: []
        },
        {
            id: 202, name: 'Adder-Coupled coupling', source: { nodeId: nodeIds.adder, stateId: stateIds.adder }, target: { nodeId: nodeIds.coupled, stateId: stateIds.coupled },
            directionality: 'bidirectional',
            equationModel: {
                latex: 'c \\cdot x', bindings: [
                    { kind: 'state', role: 'source', nodeId: nodeIds.adder, stateId: stateIds.adder, symbol: 'x' },
                    { kind: 'parameter', parameterId: paramIds.coupling, symbol: 'c' }
                ],
                output: { role: 'target', stateId: stateIds.coupled }, mathJson: ['Multiply', 'c', 'x']
            },
            parameters: [{ id: paramIds.coupling, name: 'Coupling', symbol: 'c', value: 0.15, mode: 'constant' }]
        }
    ]
};

// A node that follows stored parameter schedules (held and linear, one live and linked twice). A
// scheduled parameter is computed inside the FMU, so it is not an FMI variable.
addScheduledNode(document, {
    nodeId: 6, stateIds: { inflow: 31, level: 32, drift: 33 }, termIds: { inflow: 131, level: 132, drift: 133 },
    parameterIds: { rate: 141, ramp: 142, rampAgain: 143 }
});

// Order matches document.nodes' flattened states -- the same convention codeExportFidelity.mjs
// and fmiCodeGen.mjs's assignValueReferences() both already rely on (states get value references
// 0..stateCount-1 in this exact order).
export const orderedStateNames = [
    'Source.Level', 'Squarer.Value', 'Adder.Value', 'Coupled.Value',
    'Algebraic.Driver', 'Algebraic.Doubled', 'Algebraic.Shifted', 'Algebraic.Follower',
    'Scheduled.Inflow', 'Scheduled.Level', 'Scheduled.Drift'
];
export const stateNameByStateId = {
    [stateIds.source]: 'Source.Level', [stateIds.squarer]: 'Squarer.Value',
    [stateIds.adder]: 'Adder.Value', [stateIds.coupled]: 'Coupled.Value',
    [stateIds.driver]: 'Algebraic.Driver', [stateIds.doubled]: 'Algebraic.Doubled',
    [stateIds.shifted]: 'Algebraic.Shifted', [stateIds.follower]: 'Algebraic.Follower',
    31: 'Scheduled.Inflow', 32: 'Scheduled.Level', 33: 'Scheduled.Drift'
};

export const globalTimeStep = 0.1;
export const communicationStepSize = 0.2; // 2x globalTimeStep, exercising fmi2DoStep's internal sub-loop.
export const targetTime = 2;
export const absoluteTolerance = 1e-6;
export const relativeTolerance = 1e-6;

// `run`: anything more the run configuration says (a method, its tolerances).
export async function runRealEngine(executable, directory, doc, label, run = {}) {
    const inputPath = join(directory, `${label}.kjt`);
    const configurationPath = join(directory, `${label}Configuration.json`);
    const enginePath = join(directory, `${label}Result.bin`);
    const validationPath = join(directory, `${label}Validation.bin`);
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(doc)));
    await writeFile(configurationPath, JSON.stringify({ name: label, targetTime, globalTimeStep, outputInterval: communicationStepSize, ...run }));
    const validateExitCode = (await execute(executable, ['validate', inputPath, '--report', validationPath])).code;
    if (validateExitCode !== 0) {
        const report = decodeValidationReport(await readFile(validationPath));
        throw new Error(`The ${label} model must validate: ${JSON.stringify(report.errors ?? report)}`);
    }
    assert.equal((await execute(executable, ['run', inputPath, '--configuration', configurationPath, '--output', enginePath])).code, 0, `The engine must run the ${label} model.`);
    return decodeResultFile(await readFile(enginePath));
}
