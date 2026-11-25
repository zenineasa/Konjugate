/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The example FMUs in examples/fmi/ (the FMI compatibility page, examples/fmi/README.md): which Konjugate projects they are
// exported from, with which run configuration, and how their reference results are computed. Shared by
// scripts/generateFmiExamples.mjs, which writes them, tests/fmiExamples.test.mjs, which checks the files against each other and
// the exporter's code generation without a compiler, and tests/engine/fmiExamples.mjs, which reruns the engine and simulates the
// FMUs with FMPy (a release check).
//
// Each FMU is exported as the app's "Export simulation code" > FMU exports it (src/renderer/renderer.mjs, exportFmu): the project
// flattened with executionProjectDocument() and stripEdgeGroups(), its ownership kept, then generateFmuPackage(). Its reference
// result ({Model_Name}_ref.csv) is the Konjugate engine's own run of the same project with the same run configuration, sampled at
// the .opt file's StepSize, so it is "the reference solution as computed by the exporting tool" that the FMI tools page asks for.

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeResultFile } from '../src/engineProtocol.mjs';
import { binaryArchitectures } from '../src/fmiBinary.mjs';
import { decodeProjectFile, encodeProjectFile } from '../src/projectFile.mjs';
import { stripEdgeGroups } from '../src/edgeGroups.mjs';
import { executionProjectDocument } from '../src/subsystems.mjs';

export const repositoryRoot = join(import.meta.dirname, '..');
export const examplesDirectory = join(repositoryRoot, 'examples', 'fmi');
export const engineOptions = { applicationPath: repositoryRoot, resourcesPath: '', packaged: false };

// The communication step a host uses must be a whole number of the FMU's global steps (engine/src/fmiGlue.cpp, fmi2DoStep), so
// each StepSize below is one.
export const fmiExamples = [
    {
        name: 'ThermalEquilibrium',
        project: 'examples/thermalEquilibrium.kjt',
        run: { globalTimeStep: 0.1, method: 'nodeByNode' },
        startTime: 0, stopTime: 60, stepSize: 1, relTol: 1e-6,
        readme: [
            'A hot body (350 K) and a cold body (290 K), each a thermal mass of 1000 J/K, joined by a conductance of 50 W/K: the two',
            'temperatures meet at 320 K with a time constant of 10 s. It is the shipped example examples/thermalEquilibrium.kjt.',
            '',
            'FMI features it tests: FMI 2.0 Co-Simulation; two continuous outputs (the temperatures); two tunable real parameters',
            '("conductance", "thermalCapacitance"); fmi2DoStep over a communication step of 10 internal steps (Euler, 0.1 s);',
            'fmi2GetFMUstate/fmi2SetFMUstate and fmi2SerializeFMUstate (canGetAndSetFMUstate="true").'
        ]
    },
    {
        name: 'SpringMassDamper',
        project: 'examples/springMassDamper.kjt',
        run: { globalTimeStep: 0.01, method: 'nodeByNode' },
        startTime: 0, stopTime: 10, stepSize: 0.05, relTol: 1e-6,
        readme: [
            'A 1 kg mass on a spring (4 N/m) and a damper (0.4 N*s/m) to a fixed support, released from 0.1 m: a damped oscillation of',
            'period about 3.2 s. It is the shipped example examples/springMassDamper.kjt. The mass is integrated in four substeps of each',
            '0.01 s step.',
            '',
            'FMI features it tests: FMI 2.0 Co-Simulation; four continuous outputs (displacement and velocity of the mass and of the',
            'support); tunable real parameters; fmi2DoStep over a communication step of 5 internal steps; a node integrated in',
            'substeps inside each step; fmi2GetFMUstate/fmi2SetFMUstate (canGetAndSetFMUstate="true").'
        ]
    },
    {
        name: 'HeatedRoom',
        project: null, // built below: a room heated by a digital PID controller written as a C++ program (examples/providers/pidController.cpp)
        run: { globalTimeStep: 0.005, method: 'nodeByNode' },
        startTime: 0, stopTime: 60, stepSize: 0.5, relTol: 1e-6,
        readme: [
            'A room (heat capacity 1000 J/K, loss 50 W/K to 280 K outside) heated from 285 K towards a 293.15 K setpoint by a digital',
            'PID controller sampled every 10 ms, with a noisy temperature sensor (a random stream seeded from the model, so runs repeat) and its output',
            'limited to 0..2000 W. The controller is the C++ program examples/providers/pidController.cpp, compiled into the FMU.',
            '',
            'FMI features it tests: FMI 2.0 Co-Simulation; a continuous output (the temperature) and a discrete one held between the',
            "controller's samples (the heater power); six tunable real parameters (the controller's gains and limits); internal discrete",
            'state (the integral, the held command, the random stream) carried in fmi2GetFMUstate/fmi2SetFMUstate',
            '(canGetAndSetFMUstate="true"); fmi2DoStep over a communication step of 100 internal steps.'
        ]
    }
];

async function heatedRoomDocument() {
    const shared = [['setpoint', 293.15, 'K'], ['kp', 50, 'W/K'], ['ki', 5, 'W/(K*s)'], ['kd', 1, 'W*s/K'], ['maxPower', 2000, 'W'], ['sensorNoise', 0.1, 'K']]
        .map(([symbol, value, unit], index) => ({ id: 500 + index, name: symbol, symbol, value, unit, mode: 'constant' }));
    return {
        format: 'konjugate', version: 1, metadata: { projectName: 'Heated room' },
        ownership: { owner: 'Zenin Easa Panthakkalakath', copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath', license: { id: 'MPL-2.0' } },
        sharedParameters: shared,
        nodes: [{
            id: 1, name: 'Room', updates: 'settle',
            states: [
                { id: 11, name: 'Temperature', symbol: 'temperature', initialValue: 285, unit: 'K', kind: 'rate' },
                { id: 12, name: 'Power', symbol: 'power', initialValue: 0, unit: 'W', kind: 'update' }
            ],
            sourceTerms: [{
                id: 101, state: 'temperature', expression: '(power - 50 (temperature - 280)) / 1000',
                expressionModel: {
                    latex: '', output: { stateId: 11 },
                    mathJson: ['Divide', ['Add', 'power', ['Negate', ['Multiply', 50, ['Add', 'temperature', -280]]]], 1000],
                    bindings: [{ kind: 'state', nodeId: 1, stateId: 11, symbol: 'temperature' }, { kind: 'state', nodeId: 1, stateId: 12, symbol: 'power' }]
                }
            }],
            implementation: {
                // Line endings as committed, whatever the checkout made of them (Windows): the source is part of the FMU's guid.
                kind: 'cpp', providerApiVersion: 2, source: (await readFile(join(repositoryRoot, 'examples', 'providers', 'pidController.cpp'), 'utf8')).replace(/\r\n/g, '\n'),
                bindings: [{ key: 'measurement', kind: 'state', nodeId: 1, stateId: 11 }, ...shared.map((parameter) => ({ key: parameter.symbol, kind: 'parameter', sharedParameterId: parameter.id }))],
                outputs: [{ key: 'power', stateId: 12 }]
            }
        }],
        edges: []
    };
}

// The project as the app hands it to the FMU exporter: flattened, with this example's run configuration active.
export async function exportDocument(example) {
    const source = example.project
        ? JSON.parse(await decodeProjectFile(await readFile(join(repositoryRoot, example.project))))
        : await heatedRoomDocument();
    const document = stripEdgeGroups(executionProjectDocument(source));
    if (source.ownership) document.ownership = source.ownership;
    document.runConfigurations = [{ id: 900, name: 'FMI example', globalTimeStep: example.run.globalTimeStep, outputInterval: example.stepSize, method: example.run.method }];
    document.activeRunConfigurationId = 900;
    return document;
}

// The FMI variable name of every state, as src/fmiCodeGen.mjs names it ("Node.State"), in value-reference order.
export function outputNames(document) {
    return document.nodes.flatMap((node) => node.states.map((state) => ({ stateId: state.id, nodeId: node.id, name: `${node.name}.${state.name}` })));
}

export function enginePath() {
    return join(repositoryRoot, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
}

export function execute(executable, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

// The sample times of a run from startTime to stopTime every stepSize, written as decimals (the engine's own sample times carry
// the rounding of summing the step; the FMI rules ask for StartTime and StopTime themselves in the file).
export function sampleTimes(example) {
    const count = Math.round((example.stopTime - example.startTime) / example.stepSize);
    return Array.from({ length: count + 1 }, (_value, index) => Number((example.startTime + index * example.stepSize).toPrecision(12)));
}

// Runs the Konjugate engine on the example's project and returns { names, rows }: rows[i] = [time, ...values in names' order].
export async function engineReference(example, workDirectory, executable = enginePath()) {
    const document = await exportDocument(example);
    const outputs = outputNames(document);
    const modelPath = join(workDirectory, `${example.name}.kjt`);
    const configurationPath = join(workDirectory, `${example.name}Configuration.json`);
    const resultPath = join(workDirectory, `${example.name}Result.bin`);
    await writeFile(modelPath, await encodeProjectFile(JSON.stringify(document)));
    await writeFile(configurationPath, JSON.stringify({
        name: example.name, targetTime: example.stopTime, globalTimeStep: example.run.globalTimeStep, outputInterval: example.stepSize,
        method: example.run.method, execution: { backend: 'serial' }, providers: { cpp: { sdkPath: join(repositoryRoot, 'engine') } }
    }));
    const run = await execute(executable, ['run', modelPath, '--configuration', configurationPath, '--output', resultPath]);
    if (run.code !== 0) throw new Error(`The engine could not run ${example.name}: ${run.stderr || run.stdout}`);
    const result = decodeResultFile(await readFile(resultPath));
    const times = sampleTimes(example);
    if (result.samples.length !== times.length) throw new Error(`${example.name}: the engine gave ${result.samples.length} samples, not ${times.length}.`);
    const rows = result.samples.map((sample, index) => {
        if (Math.abs(sample.time - times[index]) > 1e-9 * Math.max(1, Math.abs(times[index]))) {
            throw new Error(`${example.name}: sample ${index} is at t = ${sample.time}, not ${times[index]}.`);
        }
        const valueOf = (output) => sample.states.find((state) => state.stateId === output.stateId && (state.nodeId === undefined || state.nodeId === output.nodeId))?.value;
        return [times[index], ...outputs.map((output) => {
            const value = valueOf(output);
            if (!Number.isFinite(value)) throw new Error(`${example.name}: no value for ${output.name} at t = ${times[index]}.`);
            return value;
        })];
    });
    return { names: outputs.map((output) => output.name), rows };
}

// A number as a C floating-point literal, shortest round trip: 350 -> 350.0, 1e-7 -> 1e-07 is not needed, "1e-7" is one.
export function csvNumber(value) {
    const text = String(value);
    return /[.eE]/.test(text) || !Number.isFinite(value) ? text : `${text}.0`;
}

// The reference CSV, by the FMI tools page's rules: comma separated, quoted names in the first line exactly as in
// modelDescription.xml, time first, numbers unquoted.
export function referenceCsv({ names, rows }) {
    return [['time', ...names].map((name) => `"${name}"`).join(','), ...rows.map((row) => row.map(csvNumber).join(','))].join('\n') + '\n';
}

export function parseReferenceCsv(text) {
    const lines = text.split('\n').filter((line) => line.length > 0);
    const names = lines[0].split(',').map((cell) => {
        const match = /^"([^"]*)"$/.exec(cell);
        if (!match) throw new Error(`The header cell ${cell} is not a quoted name.`);
        return match[1];
    });
    const rows = lines.slice(1).map((line) => line.split(',').map((cell) => {
        if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(cell)) throw new Error(`The cell ${cell} is not a C floating-point number.`);
        return Number(cell);
    }));
    return { names, rows };
}

export function referenceOptions(example) {
    return [
        `StartTime, ${csvNumber(example.startTime)}`,
        `StopTime, ${csvNumber(example.stopTime)}`,
        `StepSize, ${csvNumber(example.stepSize)}`,
        `RelTol, ${example.relTol}`
    ].join('\n') + '\n';
}

export function parseReferenceOptions(text) {
    return Object.fromEntries(text.split('\n').filter((line) => line.trim() && !line.startsWith('//')).map((line) => {
        const [key, value] = line.split(',').map((part) => part.trim());
        return [key, Number(value)];
    }));
}

// The binaries an FMU carries, from its unzipped entries: each directory with the processors its binary is built for, read from the
// binary itself ("darwin64 (aarch64)"): FMI 2.0's directory names do not say.
export function fmuPlatforms(entries) {
    return Object.entries(entries).filter(([path]) => path.startsWith('binaries/') && !path.endsWith('/')).map(([path, bytes]) => {
        const architectures = binaryArchitectures(bytes);
        return `${path.split('/')[1]}${architectures ? ` (${architectures.join(', ')})` : ''}`;
    }).sort();
}

export function readmeText(example, platforms) {
    return [
        `${example.name}: an FMU exported by Konjugate (https://github.com/zenineasa/Konjugate)`,
        '',
        ...example.readme,
        '',
        `Files: ${example.name}.fmu (FMI 2.0 Co-Simulation, binaries for ${platforms.join(', ')} only; no source code FMU, which Konjugate`,
        `does not export), ${example.name}_ref.csv (the Konjugate engine's own run of the same project), ${example.name}_ref.opt.`,
        `Simulate it from ${csvNumber(example.startTime)} s to ${csvNumber(example.stopTime)} s with a communication step of ${csvNumber(example.stepSize)} s, or another whole multiple of`,
        `its internal step of ${csvNumber(example.run.globalTimeStep)} s: a step that is not one is refused (fmi2Error). The FMU has no inputs.`,
        '',
        'How it was made and checked, and how to regenerate it: examples/fmi/README.md.',
        ''
    ].join('\n');
}
