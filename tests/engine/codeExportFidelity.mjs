/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Confirms src/codeExport.mjs's standalone C++ and Python output is not just internally
// consistent (tests/codeExport.test.mjs, structural assertions only) but numerically matches the
// REAL Konjugate engine on the same model -- the actual claim the feature makes. Covers every C++
// parallelism mode (serial, openmp, stdThread), since they should all reproduce identical math and
// only differ in dispatch. Needs a C++ compiler (CXX env var, default "c++") and python3 (PYTHON
// env var, default "python3") in addition to the built engine binary, so this is a separate,
// explicitly-invoked script rather than part of the npm run test:engine chain. Also checks the mpi
// mode when mpic++/mpirun (MPICXX/MPIRUN env vars) are found on PATH, but skips it (not a failure)
// otherwise -- MPI is a materially less universal dependency than a plain C++ compiler.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { generateStandaloneProgram } from '../../src/codeExport.mjs';
import { decodeValidationReport } from '../../src/reportProtocol.mjs';
import { addScheduledNode } from './fixtures/scheduledNodeFixture.mjs';

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

function commandExists(executable) {
    return execute(process.platform === 'win32' ? 'where' : 'which', [executable]).then(({ code }) => code === 0);
}

// A 5-node model deliberately touching most of what the generator has to reproduce: a plain decay
// (Multiply/Negate), a cross-node edge combining Sqrt/Abs/Multiply, an Add-based forced term, a
// self-referential Power term, a bidirectional edge (tested against the same node pair's "other
// side" local/snapshot reclassification), a multi-substep node, and a live parameter resolved to
// its baked default (no runtime override is sent to any of the three engines being compared).
// The sixth node covers algebraic (setsValue) states: two of them, declared out of dependency
// order, recomputed every substep and read by an ordinary differential term, plus a cases term.
// A seventh node reads one of them across a bidirectional edge, so it sees the value the algebraic
// node hands back after its step, which exports must recompute the same way the engine does.
const nodeIds = { source: 1, squarer: 2, adder: 3, power: 4, coupled: 5, algebraic: 6, tank: 7 };
const stateIds = { source: 11, squarer: 12, adder: 13, power: 14, coupled: 15, driver: 16, doubled: 17, shifted: 18, follower: 19, tank: 20 };
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
                    // driver' = 0.5 while driver < 1.4 and t < 1.23, otherwise 0.1
                    id: 104, state: 'driver', expression: 'cases',
                    expressionModel: {
                        latex: '', bindings: [{ kind: 'state', nodeId: nodeIds.algebraic, stateId: stateIds.driver, symbol: 'x' }, { kind: 'time', symbol: 't' }],
                        output: { stateId: stateIds.driver }, mathJson: ['Which', ['And', ['Less', 'x', '1.4'], ['Less', 't', '1.23']], '0.5', 'True', '0.1']
                    }
                },
                {
                    // shifted = doubled + 1 + t -- depends on doubled, which is declared after it,
                    // and reads the substep's end time
                    id: 105, state: 'shifted', expression: 'doubled + 1 + t', setsValue: true,
                    expressionModel: {
                        latex: '', bindings: [{ kind: 'state', nodeId: nodeIds.algebraic, stateId: stateIds.doubled, symbol: 'y' }, { kind: 'time', symbol: 't' }],
                        output: { stateId: stateIds.shifted }, mathJson: ['Add', 'y', '1', 't']
                    }
                },
                {
                    // doubled = 2 driver
                    id: 106, state: 'doubled', expression: '2 driver', setsValue: true,
                    expressionModel: {
                        latex: '', bindings: [{ kind: 'state', nodeId: nodeIds.algebraic, stateId: stateIds.driver, symbol: 'x' }],
                        output: { stateId: stateIds.doubled }, mathJson: ['Multiply', '2', 'x']
                    }
                },
                {
                    // follower' = 0.8 (shifted - follower), reading an algebraic state
                    id: 107, state: 'follower', expression: '0.8 (shifted - follower)',
                    expressionModel: {
                        latex: '', bindings: [
                            { kind: 'state', nodeId: nodeIds.algebraic, stateId: stateIds.shifted, symbol: 's' },
                            { kind: 'state', nodeId: nodeIds.algebraic, stateId: stateIds.follower, symbol: 'f' }
                        ],
                        output: { stateId: stateIds.follower }, mathJson: ['Multiply', '0.8', ['Add', 's', ['Negate', 'f']]]
                    }
                }
            ]
        },
        {
            id: nodeIds.tank, name: 'Tank',
            states: [{ id: stateIds.tank, name: 'Level', symbol: 'level', initialValue: 0, unit: '' }],
            numerics: { substepsPerGlobalStep: 1 },
            sourceTerms: []
        }
    ],
    edges: [
        {
            id: 201, name: 'Source to Squarer', source: { nodeId: nodeIds.source, stateId: stateIds.source }, target: { nodeId: nodeIds.squarer, stateId: stateIds.squarer },
            directionality: 'directed',
            equationModel: {
                latex: 'k \\sqrt{|x|} (1 + 0.1 t)', bindings: [
                    { kind: 'state', role: 'source', nodeId: nodeIds.source, stateId: stateIds.source, symbol: 'x' },
                    { kind: 'parameter', parameterId: paramIds.k, symbol: 'k' },
                    { kind: 'time', symbol: 't' }
                ],
                output: { role: 'target', stateId: stateIds.squarer }, mathJson: ['Multiply', 'k', ['Sqrt', ['Abs', 'x']], ['Add', '1', ['Multiply', '0.1', 't']]]
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
        },
        {
            // level' = 0.05 shifted, drawn from Algebraic's follower: the tank reads the algebraic
            // state through the snapshot, the algebraic node reads it locally
            id: 203, name: 'Algebraic to Tank', source: { nodeId: nodeIds.algebraic, stateId: stateIds.follower }, target: { nodeId: nodeIds.tank, stateId: stateIds.tank },
            directionality: 'bidirectional',
            equationModel: {
                latex: '0.05 s', bindings: [{ kind: 'state', role: 'source', nodeId: nodeIds.algebraic, stateId: stateIds.shifted, symbol: 's' }],
                output: { role: 'target', stateId: stateIds.tank }, mathJson: ['Multiply', '0.05', 's']
            },
            parameters: []
        }
    ]
};

// An eighth node follows stored parameter schedules (held and linear, one of them live and linked twice).
addScheduledNode(document, {
    nodeId: 8, stateIds: { inflow: 31, level: 32, drift: 33 }, termIds: { inflow: 131, level: 132, drift: 133 },
    parameterIds: { rate: 141, ramp: 142, rampAgain: 143 }
});

// Provider-based algebraic states. Providers can't be exported across languages, so these are
// separate one-language documents: a C++ relationship provider with setsValue (C++ export), and a
// Python relationship provider with setsValue plus a Python node provider with one derivative
// output and one setsValue output (Python export). Each provider reads simulationTime, which pins
// down the engine's timing rule (an algebraic provider is evaluated at the end of its substep).
const cppAlgebraicProvider = `#include <konjugate/relationshipProvider.hpp>
#include <memory>

class ScaledDriver final : public konjugate::sdk::v1::RelationshipProvider {
public:
    konjugate::sdk::v1::RelationshipDescription describe() const override {
        return {"fidelity.scaledDriver", "Scaled driver", {{"driver", "Driver", ""}}, {"value", "Value", ""}};
    }
    void evaluate(const konjugate::sdk::v1::EvaluationContext& context, konjugate::sdk::v1::OutputCollector& output) override {
        output.addGradient(2.0 * context.inputs.at("driver") + context.simulationTime);
    }
};

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider() {
    return std::make_unique<ScaledDriver>();
}
`;
const pythonAlgebraicProvider = `from konjugate import RelationshipDescription, RelationshipProvider, ScalarPort


class ScaledDriver(RelationshipProvider):
    def describe(self):
        return RelationshipDescription("fidelity.scaledDriver", "Scaled driver", [ScalarPort("driver", "Driver", "")], ScalarPort("value", "Value", ""))

    def evaluate(self, context, inputs, outputs):
        outputs.add_gradient(2.0 * inputs["driver"] + context.simulation_time)
`;
const pythonNodeProvider = `from konjugate import NodeProvider, NodeProviderDescription, ScalarPort


class LevelWithReading(NodeProvider):
    def describe(self):
        return NodeProviderDescription("fidelity.levelWithReading", "Level with reading", [ScalarPort("level", "Level", ""), ScalarPort("other", "Other node", "")],
                                       [ScalarPort("levelRate", "Level rate", ""), ScalarPort("reading", "Reading", "")])

    def evaluate(self, context, inputs, outputs):
        outputs.add_gradient("levelRate", 0.3 - 0.1 * inputs["level"])
        outputs.add_gradient("reading", 3.0 * inputs["level"] + context.simulation_time + 0.5 * inputs["other"])

    def checkpoint(self):
        return b""

    def restore(self, payload):
        pass
`;

function providerAlgebraicDocument(kind) {
    const node = {
        id: 1, name: 'Provider algebraic',
        states: [
            { id: 11, name: 'Driver', symbol: 'driver', initialValue: 1, unit: '' },
            { id: 12, name: 'Scaled', symbol: 'scaled', initialValue: 0, unit: '' },
            { id: 13, name: 'Follower', symbol: 'follower', initialValue: 0, unit: '' }
        ],
        numerics: { substepsPerGlobalStep: 2 },
        sourceTerms: [
            {
                id: 101, state: 'driver', expression: '0.5',
                expressionModel: { latex: '0.5', bindings: [], output: { stateId: 11 }, mathJson: '0.5' }
            },
            {
                id: 102, state: 'scaled', expression: '', setsValue: true,
                implementation: {
                    kind, providerApiVersion: 1, source: kind === 'cpp' ? cppAlgebraicProvider : pythonAlgebraicProvider,
                    bindings: [{ key: 'driver', kind: 'state', stateId: 11 }], output: { key: 'value', stateId: 12 }
                }
            },
            {
                id: 103, state: 'follower', expression: '0.8 (scaled - follower)',
                expressionModel: {
                    latex: '', bindings: [
                        { kind: 'state', nodeId: 1, stateId: 12, symbol: 's' },
                        { kind: 'state', nodeId: 1, stateId: 13, symbol: 'f' }
                    ],
                    output: { stateId: 13 }, mathJson: ['Multiply', '0.8', ['Add', 's', ['Negate', 'f']]]
                }
            }
        ]
    };
    const nodes = [node];
    if (kind === 'python') {
        nodes.push({
            id: 2, name: 'Node provider',
            states: [
                { id: 21, name: 'Level', symbol: 'level', initialValue: 1, unit: '' },
                { id: 22, name: 'Reading', symbol: 'reading', initialValue: 0, unit: '' },
                { id: 23, name: 'Tracker', symbol: 'tracker', initialValue: 0, unit: '' }
            ],
            numerics: { substepsPerGlobalStep: 3 },
            implementation: {
                kind: 'python', providerApiVersion: 1, source: pythonNodeProvider,
                // "other" is another node's state, which the engine reads from the step's snapshot.
                bindings: [{ key: 'level', kind: 'state', stateId: 21 }, { key: 'other', kind: 'state', nodeId: 1, stateId: 13 }],
                outputs: [{ key: 'levelRate', stateId: 21 }, { key: 'reading', stateId: 22, setsValue: true }]
            },
            sourceTerms: [{
                // Reads the node provider's algebraic output, which the engine writes only after
                // every contribution in the substep has been evaluated.
                id: 201, state: 'tracker', expression: 'reading - tracker',
                expressionModel: {
                    latex: '', bindings: [
                        { kind: 'state', nodeId: 2, stateId: 22, symbol: 'r' },
                        { kind: 'state', nodeId: 2, stateId: 23, symbol: 't' }
                    ],
                    output: { stateId: 23 }, mathJson: ['Add', 'r', ['Negate', 't']]
                }
            }]
        });
    }
    return {
        format: 'konjugate', version: 1, metadata: { projectName: `Provider algebraic fixture (${kind})` },
        nodes, edges: []
    };
}

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

    // Column 0 is time; columns 1.. follow document.nodes/states order, which is exactly how
    // codeExport.mjs assigns its global state indices (buildModel walks the same document).
    const orderedStateIds = document.nodes.flatMap((node) => node.states.map((state) => state.id));
    const expectedTimes = [];
    for (let time = 0; time <= targetTime + 1e-9; time += outputInterval) expectedTimes.push(Number(time.toFixed(10)));

    let comparisons = 0;
    const compareRowsAgainstEngine = (rows, label, reference = engineResult, stateOrder = orderedStateIds) => {
        for (const time of expectedTimes) {
            const engineSample = reference.samples.find((sample) => Math.abs(sample.time - time) < 1e-6);
            assert.ok(engineSample, `The real engine did not emit a sample at ${time} s.`);
            const engineValues = new Map(engineSample.states.map((state) => [state.stateId, state.value]));
            const row = rows.find((candidate) => Math.abs(candidate[0] - time) < 1e-6);
            assert.ok(row, `${label} did not emit a row at ${time} s.`);
            stateOrder.forEach((stateId, index) => {
                const engineValue = engineValues.get(stateId);
                const value = row[index + 1];
                assert.ok(Number.isFinite(engineValue) && Number.isFinite(value),
                    `Non-finite value for state ${stateId} at ${time} s (engine=${engineValue}, ${label}=${value}).`);
                assert.ok(closeEnough(value, engineValue, absoluteTolerance, relativeTolerance),
                    `${label} diverges from the real engine for state ${stateId} at ${time} s: engine=${engineValue}, ${label}=${value}.`);
                comparisons += 1;
            });
        }
    };

    // Every C++ parallelism mode reproduces the exact same math (only dispatch differs -- see
    // src/codeExport.mjs), so each is checked against the real engine the same way the plain
    // serial export always was.
    let variantIndex = 0;
    const verifyCppVariant = async (parallelism, { compilerArgs = [], runViaMpi = null } = {}) => {
        const cppPath = join(directory, `exported${variantIndex}.cpp`);
        const cppBinaryPath = join(directory, `exported${variantIndex}${process.platform === 'win32' ? '.exe' : ''}`);
        const cppCsvPath = join(directory, `cpp${variantIndex}.csv`);
        variantIndex += 1;
        await writeFile(cppPath, generateStandaloneProgram(document, 'cpp', { parallelism }));
        const compiler = runViaMpi ? (process.env.MPICXX || 'mpic++') : cxx;
        const compile = await execute(compiler, [...compilerArgs, '-std=c++20', '-O2', cppPath, '-o', cppBinaryPath]);
        assert.equal(compile.code, 0, `The exported C++ (${parallelism}) program must compile.`);
        const runArgs = ['--target-time', String(targetTime), '--output', cppCsvPath];
        const runResult = runViaMpi
            ? await execute(process.env.MPIRUN || 'mpirun', ['--oversubscribe', '-n', String(runViaMpi), cppBinaryPath, ...runArgs])
            : await execute(cppBinaryPath, runArgs);
        assert.equal(runResult.code, 0, `The exported C++ (${parallelism}) program must run.`);
        compareRowsAgainstEngine(parseCsv(await readFile(cppCsvPath, 'utf8')), `C++ (${parallelism})`);
    };

    // libomp is keg-only on macOS (not symlinked into the Homebrew prefix), so -I/-L must name its
    // keg path explicitly -- matches the exact flags documented in the generated header comment
    // (src/codeExport.mjs's cppRunInstructionLines).
    let openmpCompilerArgs = ['-fopenmp'];
    if (process.platform === 'darwin') {
        const libompPrefix = (await execute('brew', ['--prefix', 'libomp'])).stdout.trim();
        openmpCompilerArgs = ['-Xpreprocessor', '-fopenmp', '-I', `${libompPrefix}/include`, '-L', `${libompPrefix}/lib`, '-lomp'];
    }

    await verifyCppVariant('serial');
    await verifyCppVariant('openmp', { compilerArgs: openmpCompilerArgs });
    await verifyCppVariant('stdThread', { compilerArgs: process.platform === 'win32' ? [] : ['-pthread'] });

    if (await commandExists(process.env.MPICXX || 'mpic++') && await commandExists(process.env.MPIRUN || 'mpirun')) {
        // 5 ranks against a model with fewer nodes deliberately exercises the "this rank owns zero
        // nodes" edge case in the contiguous block partition (src/codeExport.mjs's mpiSetupLines).
        await verifyCppVariant('mpi', { runViaMpi: 5 });
    } else {
        console.log('  (skipping mpi variant: mpic++/mpirun not found on PATH)');
    }

    const pythonPath = join(directory, 'exported.py');
    const pythonCsvPath = join(directory, 'python.csv');
    await writeFile(pythonPath, generateStandaloneProgram(document, 'python'));
    assert.equal((await execute(python, [pythonPath, '--target-time', String(targetTime), '--output', pythonCsvPath])).code, 0, 'The exported Python program must run.');
    compareRowsAgainstEngine(parseCsv(await readFile(pythonCsvPath, 'utf8')), 'Python');

    if (await commandExists(process.env.MPIRUN || 'mpirun') && (await execute(python, ['-c', 'import mpi4py'])).code === 0) {
        const pythonMpiPath = join(directory, 'exportedMpi.py');
        const pythonMpiCsvPath = join(directory, 'pythonMpi.csv');
        await writeFile(pythonMpiPath, generateStandaloneProgram(document, 'python', { parallelism: 'mpi' }));
        // Same 5-ranks-against-4-nodes edge case as the C++ mpi variant.
        const runResult = await execute(process.env.MPIRUN || 'mpirun', ['--oversubscribe', '-n', '5', python, pythonMpiPath, '--target-time', String(targetTime), '--output', pythonMpiCsvPath]);
        assert.equal(runResult.code, 0, 'The exported Python (mpi) program must run.');
        compareRowsAgainstEngine(parseCsv(await readFile(pythonMpiCsvPath, 'utf8')), 'Python (mpi)');
    } else {
        console.log('  (skipping python mpi variant: mpirun/mpi4py not available)');
    }

    // --- 3. provider-based algebraic states, one language per document ---
    const runEngine = async (doc, label) => {
        const path = join(directory, `${label}.kjt`);
        const resultPath = join(directory, `${label}.bin`);
        const reportPath = join(directory, `${label}Validation.bin`);
        await writeFile(path, await encodeProjectFile(JSON.stringify(doc)));
        if ((await execute(executable, ['validate', path, '--report', reportPath])).code !== 0) {
            throw new Error(`The ${label} model must validate: ${JSON.stringify(decodeValidationReport(await readFile(reportPath)))}`);
        }
        // Providers need the SDKs from this checkout.
        const providerConfigurationPath = join(directory, `${label}Configuration.json`);
        await writeFile(providerConfigurationPath, JSON.stringify({
            name: label, targetTime, globalTimeStep, outputInterval,
            providers: {
                cpp: { sdkPath: join(import.meta.dirname, '..', '..', 'engine') },
                python: { sdkPath: join(import.meta.dirname, '..', '..', 'engine', 'sdk', 'python') }
            }
        }));
        assert.equal((await execute(executable, ['run', path, '--configuration', providerConfigurationPath, '--output', resultPath])).code, 0, `The engine must run the ${label} model.`);
        return decodeResultFile(await readFile(resultPath));
    };
    for (const kind of ['cpp', 'python']) {
        const providerDocument = providerAlgebraicDocument(kind);
        const reference = await runEngine(providerDocument, `${kind}ProviderAlgebraic`);
        providerDocument.exportDefaultTargetTime = targetTime;
        providerDocument.runConfigurations = [{ id: 900, globalTimeStep, outputInterval }];
        providerDocument.activeRunConfigurationId = 900;
        const stateOrder = providerDocument.nodes.flatMap((node) => node.states.map((state) => state.id));
        const label = `${kind === 'cpp' ? 'C++' : 'Python'} (provider algebraic)`;
        const csvPath = join(directory, `${kind}ProviderAlgebraic.csv`);
        if (kind === 'cpp') {
            const sourcePath = join(directory, 'providerAlgebraic.cpp');
            const binaryPath = join(directory, `providerAlgebraic${process.platform === 'win32' ? '.exe' : ''}`);
            await writeFile(sourcePath, generateStandaloneProgram(providerDocument, 'cpp'));
            assert.equal((await execute(cxx, ['-std=c++20', '-O2', sourcePath, '-o', binaryPath])).code, 0, `The ${label} program must compile.`);
            assert.equal((await execute(binaryPath, ['--target-time', String(targetTime), '--output', csvPath])).code, 0, `The ${label} program must run.`);
        } else {
            const sourcePath = join(directory, 'providerAlgebraic.py');
            await writeFile(sourcePath, generateStandaloneProgram(providerDocument, 'python'));
            assert.equal((await execute(python, [sourcePath, '--target-time', String(targetTime), '--output', csvPath])).code, 0, `The ${label} program must run.`);
        }
        compareRowsAgainstEngine(parseCsv(await readFile(csvPath, 'utf8')), label, reference, stateOrder);
    }

    assert.ok(comparisons >= 5 * expectedTimes.length * 3, 'Expected at least 5 states compared at every sampled time across several variants.');
    console.log(`✓ code export fidelity: every generated variant matched the real engine across ${comparisons} state/time comparisons.`);
} finally {
    // Matches this project's other engine test scripts (see numericalRegression.mjs): always
    // remove the temp directory, even on failure. The exact generated .cpp/.py that failed can be
    // reproduced by rerunning this fixture rather than needing the leftover files.
    await rm(directory, { recursive: true, force: true });
}
