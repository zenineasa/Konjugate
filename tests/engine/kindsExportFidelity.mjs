/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Export of a model that says its kinds (FMI review #3): a node that works its Updates out once per step (the default) and a
// relationship whose single equation sets a value, exported to C++, Python and an FMU (FMI 2.0 and 3.0, run by FMPy), each against the
// engine's own run of the same model, at every sample: the C++ and Python programs within the tolerance every export fidelity check uses
// (1e-6 absolute and relative; they write 15 and 10 significant digits), the FMUs (FMI 2.0 and 3.0, read by FMPy as doubles) bit for bit.
//
// The model: a Tank (a Rate filled at a constant rate and leaking); a Gauge whose Updates are worked out once per step: its reading set
// by a one-equation relationship from the Tank's level, a counter that reads itself, and a lagged copy of its reading (an Update reading
// another reads it a step back); a two-way relationship setting the Gauge's balance, whose far end, the Tank's level, takes the negated
// value as a rate; a Heater whose Rate reads the Gauge's reading; and a Mirror whose Updates settle within the step, beside them.
//
//   node tests/engine/kindsExportFidelity.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateStandaloneProgram } from '../../src/codeExport.mjs';
import { generateFmuPackage } from '../../src/fmiExport.mjs';
import { runRealEngine } from './fixtures/fmuFidelityFixture.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const cxx = process.env.CXX || 'c++';
const python = process.env.PYTHON || 'python3';
const tolerance = { absolute: 1e-6, relative: 1e-6 };
const execute = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
});

const equation = (latex, mathJson, bindings, output) => ({ latex, mathJson, bindings, output });
const state = (id, name, symbol, initialValue, kind) => ({ id, name, symbol, initialValue, unit: '', kind });
export const kindsDocument = {
    format: 'konjugate', version: 1, metadata: { projectName: 'Kinds' },
    runConfigurations: [{ id: 900, globalTimeStep: 0.1, outputInterval: 0.1 }], activeRunConfigurationId: 900,
    nodes: [
        { id: 1, name: 'Tank', states: [state(2, 'Level', 'level', 1, 'rate')], sourceTerms: [{
            id: 3, state: 'level', expression: '1 - 0.1 x',
            expressionModel: equation('1 - 0.1x', ['Add', 1, ['Multiply', -0.1, 'x']], [{ kind: 'state', nodeId: 1, stateId: 2, symbol: 'x' }], { stateId: 2 })
        }] },
        { id: 4, name: 'Gauge', states: [state(5, 'Reading', 'reading', 0, 'update'), state(6, 'Count', 'count', 0, 'update'), state(7, 'Lagged', 'lagged', 0, 'update'), state(8, 'Balance', 'balance', 0, 'update')], sourceTerms: [
            { id: 9, state: 'count', expression: 'n + 1', expressionModel: equation('n + 1', ['Add', 'n', 1], [{ kind: 'state', nodeId: 4, stateId: 6, symbol: 'n' }], { stateId: 6 }) },
            { id: 10, state: 'lagged', expression: 'r', expressionModel: equation('r', 'r', [{ kind: 'state', nodeId: 4, stateId: 5, symbol: 'r' }], { stateId: 7 }) }
        ] },
        { id: 11, name: 'Heater', states: [state(12, 'Heat', 'heat', 0, 'rate')], sourceTerms: [] },
        { id: 13, name: 'Mirror', updates: 'settle', states: [state(14, 'Spring', 'spring', 3, 'rate'), state(15, 'Echo', 'echo', 0, 'update')], sourceTerms: [
            { id: 16, state: 'spring', expression: '-0.5 s', expressionModel: equation('-0.5s', ['Multiply', -0.5, 's'], [{ kind: 'state', nodeId: 13, stateId: 14, symbol: 's' }], { stateId: 14 }) },
            { id: 17, state: 'echo', expression: '2 s', expressionModel: equation('2s', ['Multiply', 2, 's'], [{ kind: 'state', nodeId: 13, stateId: 14, symbol: 's' }], { stateId: 15 }) }
        ] }
    ],
    edges: [
        { id: 20, name: 'Gauge reads the tank', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 4, stateId: 5 }, directionality: 'directed', equation: '2 x', parameters: [],
            equationModel: equation('2x', ['Multiply', 2, 'x'], [{ kind: 'state', role: 'source', nodeId: 1, stateId: 2, symbol: 'x' }], { role: 'target', stateId: 5 }) },
        { id: 21, name: 'Balance', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 4, stateId: 8 }, directionality: 'bidirectional', equation: '0.05 x', parameters: [],
            equationModel: equation('0.05x', ['Multiply', 0.05, 'x'], [{ kind: 'state', role: 'source', nodeId: 1, stateId: 2, symbol: 'x' }], { role: 'target', stateId: 8 }) },
        { id: 22, name: 'Heats', source: { nodeId: 4, stateId: 5 }, target: { nodeId: 11, stateId: 12 }, directionality: 'directed', equation: '0.1 r', parameters: [],
            equationModel: equation('0.1r', ['Multiply', 0.1, 'r'], [{ kind: 'state', role: 'source', nodeId: 4, stateId: 5, symbol: 'r' }], { role: 'target', stateId: 12 }) }
    ],
    edgeGroups: []
};
const targetTime = 2;
const columns = ['Tank — Level', 'Gauge — Reading', 'Gauge — Count', 'Gauge — Lagged', 'Gauge — Balance', 'Heater — Heat', 'Mirror — Spring', 'Mirror — Echo'];
const stateOrder = [2, 5, 6, 7, 8, 12, 14, 15];

const parseCsv = (text) => text.trim().split('\n').slice(1).map((line) => line.split(',').map(Number));
const close = (actual, expected) => Math.abs(actual - expected) <= tolerance.absolute + tolerance.relative * Math.max(Math.abs(actual), Math.abs(expected));

const directory = await mkdtemp(join(tmpdir(), 'konjugateKindsExport-'));
try {
    const engine = await runRealEngine(executable, directory, kindsDocument, 'kinds', { targetTime, globalTimeStep: 0.1, outputInterval: 0.1 });
    const engineRows = engine.samples.map((sample) => [sample.time, ...stateOrder.map((id) => sample.states.find((item) => item.stateId === id).value)]);
    // The counter shows the model is what it says: worked out once per step, it counts the steps.
    assert.equal(engineRows.at(-1)[3], 20, `The engine's counter is ${engineRows.at(-1)[3]}, not 20 steps.`);
    const compare = (rows, what) => {
        assert.equal(rows.length, engineRows.length, `${what}: ${rows.length} rows, not ${engineRows.length}.`);
        let largest = 0;
        rows.forEach((row, index) => row.forEach((value, column) => {
            const expected = engineRows[index][column];
            assert.ok(close(value, expected), `${what}: ${column ? columns[column - 1] : 'time'} at t=${engineRows[index][0]} is ${value}, the engine's ${expected}.`);
            largest = Math.max(largest, Math.abs(value - expected));
        }));
        return largest;
    };
    const lines = [];

    // C++ (serial, and the threaded modes), compiled and run.
    for (const parallelism of ['serial', 'stdThread']) {
        const source = join(directory, `kinds_${parallelism}.cpp`);
        const binary = join(directory, `kinds_${parallelism}`);
        await writeFile(source, generateStandaloneProgram(kindsDocument, 'cpp', { parallelism }));
        const built = await execute(cxx, ['-std=c++20', '-O1', '-pthread', source, '-o', binary]);
        assert.equal(built.code, 0, `The C++ (${parallelism}) export did not compile:\n${built.stderr}`);
        const csv = join(directory, `kinds_${parallelism}.csv`);
        assert.equal((await execute(binary, ['--target-time', String(targetTime), '--output', csv])).code, 0);
        lines.push(`C++ ${parallelism} (largest difference ${compare(parseCsv(await readFile(csv, 'utf8')), `C++ ${parallelism}`)})`);
    }

    // Python.
    const pythonSource = join(directory, 'kinds.py');
    await writeFile(pythonSource, generateStandaloneProgram(kindsDocument, 'python'));
    const pythonCsv = join(directory, 'kinds_python.csv');
    const ran = await execute(python, [pythonSource, '--target-time', String(targetTime), '--output', pythonCsv]);
    assert.equal(ran.code, 0, `The Python export did not run:\n${ran.stderr}`);
    lines.push(`Python (largest difference ${compare(parseCsv(await readFile(pythonCsv, 'utf8')), 'Python')})`);

    // FMI 2.0 and 3.0, run by FMPy at the global step.
    if ((await execute(python, ['-c', 'import fmpy'])).code !== 0) {
        console.log('  (skipping the FMU part: fmpy not importable -- pip install fmpy)');
    } else {
        const script = join(directory, 'simulate.py');
        await writeFile(script, `
import json, sys
from fmpy import simulate_fmu, read_model_description
names = json.loads(sys.argv[2])
result = simulate_fmu(sys.argv[1], stop_time=${targetTime}, step_size=0.1, output_interval=0.1, output=names)
print(json.dumps([[float(row[0])] + [float(row[name]) for name in names] for row in result]))
`);
        const names = ['Tank.Level', 'Gauge.Reading', 'Gauge.Count', 'Gauge.Lagged', 'Gauge.Balance', 'Heater.Heat', 'Mirror.Spring', 'Mirror.Echo'];
        const runs = {};
        for (const fmiVersion of ['2.0', '3.0']) {
            const path = join(directory, `kinds${fmiVersion}.fmu`);
            await writeFile(path, await generateFmuPackage(kindsDocument, { modelName: 'Kinds', fmiVersion, engineOptions: { applicationPath: root, resourcesPath: '', packaged: false } }));
            const outcome = await execute(python, [script, path, JSON.stringify(names)]);
            assert.equal(outcome.code, 0, `FMPy could not run the FMI ${fmiVersion} export:\n${outcome.stderr}`);
            runs[fmiVersion] = JSON.parse(outcome.stdout.trim().split('\n').at(-1));
            // FMPy reads the FMU's doubles as they are: the export runs the engine's arithmetic, so they are the engine's, bit for bit.
            const largest = compare(runs[fmiVersion], `FMI ${fmiVersion}`);
            assert.equal(largest, 0, `FMI ${fmiVersion}: the FMU's values are not the engine's bit for bit (largest difference ${largest}).`);
            lines.push(`FMI ${fmiVersion} in FMPy bit for bit`);
        }
        assert.ok(runs['2.0'].every((row, index) => row.every((value, column) => Object.is(value, runs['3.0'][index][column]))), 'The FMI 3.0 export equals the FMI 2.0 export bit for bit.');
        lines.push('FMI 3.0 equal to FMI 2.0 bit for bit');
    }
    console.log(`✓ Kinds export: once-per-step Updates and value-setting relationships match the engine within 1e-6: ${lines.join('; ')}.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
