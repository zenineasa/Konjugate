/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Code export of programs in the current format (version 2 of the program SDK): conduction written as a program, in C++ and in Python,
// with a room in °C (its input converted at the port, as the engine converts it), exported, compiled or run, and compared with the
// engine's run of the same model, at every digit each export writes.
//
//   node tests/engine/programExportFidelity.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateStandaloneProgram } from '../../src/codeExport.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', 'konjugateEngine');
const execute = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stderr.on('data', (chunk) => { diagnostics += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, diagnostics }));
});
const example = (name) => readFile(join(root, 'examples', 'providers', name), 'utf8');
const targetTime = 4;
const document = (kind, source, roomUnit, roomInitial) => ({
    format: 'konjugate', version: 1, metadata: { projectName: 'Conduction' },
    nodes: [
        { id: 1, name: 'Wall', states: [{ id: 11, name: 'Temperature', symbol: 'temperature', initialValue: 310, unit: 'K' }], sourceTerms: [] },
        { id: 2, name: 'Room', states: [{ id: 21, name: 'Temperature', symbol: 'temperature', initialValue: roomInitial, unit: roomUnit }], sourceTerms: [] }
    ],
    edges: [{
        id: 31, name: 'Conduction', source: { nodeId: 1, stateId: 11 }, target: { nodeId: 2, stateId: 21 }, directionality: 'directed', equation: '',
        parameters: [{ id: 41, name: 'Conductance', symbol: 'conductance', value: 4, unit: 'W/K', mode: 'constant' }, { id: 42, name: 'Capacity', symbol: 'capacity', value: 2, unit: 'J/K', mode: 'constant' }],
        implementation: {
            kind, providerApiVersion: 2, source,
            bindings: [
                { key: 'hot', kind: 'state', nodeId: 1, stateId: 11 }, { key: 'cold', kind: 'state', nodeId: 2, stateId: 21 },
                { key: 'conductance', kind: 'parameter', parameterId: 41 }, { key: 'capacity', kind: 'parameter', parameterId: 42 }
            ],
            output: { role: 'target', key: 'warming', stateId: 21 }
        }
    }],
    exportDefaultTargetTime: targetTime,
    runConfigurations: [{ id: 900, globalTimeStep: 0.01, outputInterval: 0.1 }],
    activeRunConfigurationId: 900
});

const directory = await mkdtemp(join(tmpdir(), 'konjugateProgramExport-'));
try {
    for (const [roomUnit, roomInitial] of [['K', 295], ['degC', 21.85]]) {
        for (const [kind, file] of [['cpp', 'conduction.cpp'], ['python', 'conduction.py']]) {
            const model = document(kind, await example(file), roomUnit, roomInitial);
            const label = `${kind}, room in ${roomUnit}`;
            const modelPath = join(directory, 'model.kjt');
            const configurationPath = join(directory, 'run.json');
            const resultPath = join(directory, 'run.kjr');
            await writeFile(modelPath, await encodeProjectFile(JSON.stringify(model)));
            await writeFile(configurationPath, JSON.stringify({ name: 'run', targetTime, globalTimeStep: 0.01, outputInterval: 0.1, execution: { backend: 'serial' },
                providers: { cpp: { sdkPath: join(root, 'engine') }, python: { sdkPath: join(root, 'engine', 'sdk', 'python') } } }));
            const engineRun = await execute(executable, ['run', modelPath, '--configuration', configurationPath, '--output', resultPath]);
            assert.equal(engineRun.code, 0, `${label}: the engine must run: ${engineRun.diagnostics}`);
            const engine = decodeResultFile(await readFile(resultPath)).samples.map((sample) => sample.states.find((state) => state.stateId === 21).value);
            const csvPath = join(directory, `${kind}.csv`);
            if (kind === 'cpp') {
                const sourcePath = join(directory, 'exported.cpp');
                const binaryPath = join(directory, 'exported');
                await writeFile(sourcePath, generateStandaloneProgram(model, 'cpp'));
                const compiled = await execute(process.env.CXX || 'c++', ['-std=c++20', '-O2', sourcePath, '-o', binaryPath]);
                assert.equal(compiled.code, 0, `${label}: the export must compile: ${compiled.diagnostics}`);
                assert.equal((await execute(binaryPath, ['--target-time', String(targetTime), '--output', csvPath])).code, 0, `${label}: the export must run.`);
            } else {
                const sourcePath = join(directory, 'exported.py');
                await writeFile(sourcePath, generateStandaloneProgram(model, 'python'));
                const ran = await execute(process.env.PYTHON || 'python3', [sourcePath, '--target-time', String(targetTime), '--output', csvPath]);
                assert.equal(ran.code, 0, `${label}: the export must run: ${ran.diagnostics}`);
            }
            const rows = (await readFile(csvPath, 'utf8')).trim().split('\n').slice(1).map((line) => line.split(',').map(Number));
            const exported = rows.map((row) => row[2]);
            assert.equal(exported.length, engine.length, `${label}: as many samples as the engine.`);
            // The C++ export writes 15 significant digits, the Python export 10: each is compared at the digits it writes.
            const digits = kind === 'cpp' ? 1e-14 : 1e-9;
            exported.forEach((value, index) => assert.ok(Math.abs(value - engine[index]) <= digits * Math.abs(engine[index]),
                `${label}: sample ${index} is ${value}, the engine ${engine[index]}.`));
        }
    }
    console.log('Programs in the current format export to C++ and Python with the engine\'s numbers.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
