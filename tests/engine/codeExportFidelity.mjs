/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Confirms src/codeExport.mjs's standalone C++ and Python output is not just internally
// consistent (tests/codeExport.test.mjs, structural assertions only) but numerically matches the
// REAL Konjugate engine on the same model -- the actual claim the feature makes. Needs a C++
// compiler (CXX env var, default "c++") and python3 (PYTHON env var, default "python3") in
// addition to the built engine binary, so this is a separate, explicitly-invoked script rather
// than part of the npm run test:engine chain.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { generateStandaloneProgram } from '../../src/codeExport.mjs';
import { decodeValidationReport } from '../../src/reportProtocol.mjs';

function execute(executable, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options });
        let stdout = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, stdout }));
    });
}

function closeEnough(actual, expected, absoluteTolerance, relativeTolerance) {
    return Math.abs(actual - expected) <= absoluteTolerance + relativeTolerance * Math.max(Math.abs(actual), Math.abs(expected));
}

function parseCsv(text) {
    const rows = text.trim().split('\n').map((line) => line.split(',').map(Number));
    return rows.slice(1); // drop the header row
}

// A 5-node model deliberately touching most of what the generator has to reproduce: a plain decay
// (Multiply/Negate), a cross-node edge combining Sqrt/Abs/Multiply, an Add-based forced term, a
// self-referential Power term, a bidirectional edge (tested against the same node pair's "other
// side" local/snapshot reclassification), a multi-substep node, and a live parameter resolved to
// its baked default (no runtime override is sent to any of the three engines being compared).
const nodeIds = { source: 1, squarer: 2, adder: 3, power: 4, coupled: 5 };
const stateIds = { source: 11, squarer: 12, adder: 13, power: 14, coupled: 15 };
const paramIds = { k: 21, growth: 22, coupling: 23 };

const document = {
    format: 'konjugate', version: 1, metadata: { projectName: 'Code export fidelity fixture' },
    nodes: [
        {
            id: nodeIds.source, name: 'Source',
            states: [{ id: stateIds.source, name: 'Level', symbol: 'level', initialValue: 9, unit: '' }],
            numerics: { substepsPerGlobalStep: 1 },
            sourceTerms: [{
                id: 101, state: 'level', expression: '-0.2 level',
                expressionModel: {
                    latex: '-0.2 x', bindings: [{ kind: 'state', nodeId: nodeIds.source, stateId: stateIds.source, symbol: 'x' }],
                    output: { stateId: stateIds.source }, mathJson: ['Multiply', '-0.2', 'x']
                }
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
                parameters: [{ id: paramIds.growth, name: 'Growth', symbol: 'g', value: 0.3, mode: 'live', control: { minimum: 0, maximum: 1, step: 0.05 } }]
            }]
        },
        {
            id: nodeIds.power, name: 'Power',
            states: [{ id: stateIds.power, name: 'Value', symbol: 'value', initialValue: 4, unit: '' }],
            numerics: { substepsPerGlobalStep: 1 },
            sourceTerms: [{
                id: 103, state: 'value', expression: '-0.01 value^2',
                expressionModel: {
                    latex: '-0.01 x^2', bindings: [{ kind: 'state', nodeId: nodeIds.power, stateId: stateIds.power, symbol: 'x' }],
                    output: { stateId: stateIds.power }, mathJson: ['Multiply', '-0.01', ['Power', 'x', '2']]
                }
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
                latex: 'k \\sqrt{|x|}', bindings: [
                    { kind: 'state', role: 'source', nodeId: nodeIds.source, stateId: stateIds.source, symbol: 'x' },
                    { kind: 'parameter', parameterId: paramIds.k, symbol: 'k' }
                ],
                output: { role: 'target', stateId: stateIds.squarer }, mathJson: ['Multiply', 'k', ['Sqrt', ['Abs', 'x']]]
            },
            parameters: [{ id: paramIds.k, name: 'Gain', symbol: 'k', value: 0.4, mode: 'constant' }]
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

const globalTimeStep = 0.1;
const outputInterval = 0.2;
const targetTime = 2;
const absoluteTolerance = 1e-6;
const relativeTolerance = 1e-6;

const executable = process.argv[2] ?? join(import.meta.dirname, '..', '..', 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const cxx = process.env.CXX || 'c++';
const python = process.env.PYTHON || 'python3';

const directory = await mkdtemp(join(tmpdir(), 'konjugateCodeExportFidelity-'));
try {
    // --- 1. run the real engine ---
    const inputPath = join(directory, 'fixture.kjt');
    const configurationPath = join(directory, 'configuration.json');
    const enginePath = join(directory, 'engineResult.bin');
    const validationPath = join(directory, 'validation.bin');
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(document)));
    await writeFile(configurationPath, JSON.stringify({ name: 'fidelity', targetTime, globalTimeStep, outputInterval }));
    const validateExitCode = (await execute(executable, ['validate', inputPath, '--report', validationPath])).code;
    if (validateExitCode !== 0) {
        const report = decodeValidationReport(await readFile(validationPath));
        throw new Error(`The fixture model must validate: ${JSON.stringify(report.errors ?? report)}`);
    }
    assert.equal((await execute(executable, ['run', inputPath, '--configuration', configurationPath, '--output', enginePath])).code, 0, 'The engine must run the fixture model.');
    const engineResult = decodeResultFile(await readFile(enginePath));

    // --- 2. generate, compile and run the standalone programs ---
    document.exportDefaultTargetTime = targetTime;
    document.runConfigurations = [{ id: 900, globalTimeStep, outputInterval }];
    document.activeRunConfigurationId = 900;

    const cppPath = join(directory, 'exported.cpp');
    const cppBinaryPath = join(directory, process.platform === 'win32' ? 'exported.exe' : 'exported');
    const cppCsvPath = join(directory, 'cpp.csv');
    await writeFile(cppPath, generateStandaloneProgram(document, 'cpp'));
    const compile = await execute(cxx, ['-std=c++20', '-O2', cppPath, '-o', cppBinaryPath]);
    assert.equal(compile.code, 0, 'The exported C++ program must compile.');
    assert.equal((await execute(cppBinaryPath, ['--target-time', String(targetTime), '--output', cppCsvPath])).code, 0, 'The exported C++ program must run.');
    const cppRows = parseCsv(await readFile(cppCsvPath, 'utf8'));

    const pythonPath = join(directory, 'exported.py');
    const pythonCsvPath = join(directory, 'python.csv');
    await writeFile(pythonPath, generateStandaloneProgram(document, 'python'));
    assert.equal((await execute(python, [pythonPath, '--target-time', String(targetTime), '--output', pythonCsvPath])).code, 0, 'The exported Python program must run.');
    const pythonRows = parseCsv(await readFile(pythonCsvPath, 'utf8'));

    // Column 0 is time; columns 1.. follow document.nodes/states order, which is exactly how
    // codeExport.mjs assigns its global state indices (buildModel walks the same document).
    const orderedStateIds = document.nodes.flatMap((node) => node.states.map((state) => state.id));

    // --- 3. compare all three at every output time ---
    const expectedTimes = [];
    for (let time = 0; time <= targetTime + 1e-9; time += outputInterval) expectedTimes.push(Number(time.toFixed(10)));

    let comparisons = 0;
    for (const time of expectedTimes) {
        const engineSample = engineResult.samples.find((sample) => Math.abs(sample.time - time) < 1e-6);
        assert.ok(engineSample, `The real engine did not emit a sample at ${time} s.`);
        const engineValues = new Map(engineSample.states.map((state) => [state.stateId, state.value]));

        const cppRow = cppRows.find((row) => Math.abs(row[0] - time) < 1e-6);
        const pythonRow = pythonRows.find((row) => Math.abs(row[0] - time) < 1e-6);
        assert.ok(cppRow, `The exported C++ program did not emit a row at ${time} s.`);
        assert.ok(pythonRow, `The exported Python program did not emit a row at ${time} s.`);

        orderedStateIds.forEach((stateId, index) => {
            const engineValue = engineValues.get(stateId);
            const cppValue = cppRow[index + 1];
            const pythonValue = pythonRow[index + 1];
            assert.ok(Number.isFinite(engineValue) && Number.isFinite(cppValue) && Number.isFinite(pythonValue),
                `Non-finite value for state ${stateId} at ${time} s (engine=${engineValue}, cpp=${cppValue}, python=${pythonValue}).`);
            assert.ok(closeEnough(cppValue, engineValue, absoluteTolerance, relativeTolerance),
                `C++ export diverges from the real engine for state ${stateId} at ${time} s: engine=${engineValue}, cpp=${cppValue}.`);
            assert.ok(closeEnough(pythonValue, engineValue, absoluteTolerance, relativeTolerance),
                `Python export diverges from the real engine for state ${stateId} at ${time} s: engine=${engineValue}, python=${pythonValue}.`);
            comparisons += 1;
        });
    }
    assert.ok(comparisons >= 5 * expectedTimes.length, 'Expected at least 5 states compared at every sampled time.');
    console.log(`✓ code export fidelity: C++ and Python standalone output matched the real engine across ${comparisons} state/time comparisons.`);
} finally {
    // Matches this project's other engine test scripts (see numericalRegression.mjs): always
    // remove the temp directory, even on failure. The exact generated .cpp/.py that failed can be
    // reproduced by rerunning this fixture rather than needing the leftover files.
    await rm(directory, { recursive: true, force: true });
}
