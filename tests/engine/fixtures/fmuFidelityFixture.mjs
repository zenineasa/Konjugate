/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Shared fixture for both FMU fidelity checks (tests/engine/fmiExportFidelity.mjs, the FMPy-based
// independent check, and tests/engine/fmiRoundTrip.mjs, the dependency-free dlopen-based one) --
// kept in one place so the two checks can't silently drift apart. A 4-node model with a live
// parameter, a tunable constant parameter, a cross-node edge, a bidirectional edge, and a
// multi-substep node -- enough to exercise the same graph shapes codeExportFidelity.mjs already
// covers for the plain export, plus fmi2SetReal.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { encodeProjectFile } from '../../../src/projectFile.mjs';
import { decodeResultFile } from '../../../src/engineProtocol.mjs';
import { decodeValidationReport } from '../../../src/reportProtocol.mjs';

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

export const nodeIds = { source: 1, squarer: 2, adder: 3, coupled: 4 };
export const stateIds = { source: 11, squarer: 12, adder: 13, coupled: 14 };
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

// Order matches document.nodes' flattened states -- the same convention codeExportFidelity.mjs
// and fmiCodeGen.mjs's assignValueReferences() both already rely on (states get value references
// 0..stateCount-1 in this exact order).
export const orderedStateNames = ['Source.Level', 'Squarer.Value', 'Adder.Value', 'Coupled.Value'];
export const stateNameByStateId = {
    [stateIds.source]: 'Source.Level', [stateIds.squarer]: 'Squarer.Value',
    [stateIds.adder]: 'Adder.Value', [stateIds.coupled]: 'Coupled.Value'
};

export const globalTimeStep = 0.1;
export const communicationStepSize = 0.2; // 2x globalTimeStep, exercising fmi2DoStep's internal sub-loop.
export const targetTime = 2;
export const absoluteTolerance = 1e-6;
export const relativeTolerance = 1e-6;

export async function runRealEngine(executable, directory, doc, label) {
    const inputPath = join(directory, `${label}.kjt`);
    const configurationPath = join(directory, `${label}Configuration.json`);
    const enginePath = join(directory, `${label}Result.bin`);
    const validationPath = join(directory, `${label}Validation.bin`);
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(doc)));
    await writeFile(configurationPath, JSON.stringify({ name: label, targetTime, globalTimeStep, outputInterval: communicationStepSize }));
    const validateExitCode = (await execute(executable, ['validate', inputPath, '--report', validationPath])).code;
    if (validateExitCode !== 0) {
        const report = decodeValidationReport(await readFile(validationPath));
        throw new Error(`The ${label} model must validate: ${JSON.stringify(report.errors ?? report)}`);
    }
    assert.equal((await execute(executable, ['run', inputPath, '--configuration', configurationPath, '--output', enginePath])).code, 0, `The engine must run the ${label} model.`);
    return decodeResultFile(await readFile(enginePath));
}
