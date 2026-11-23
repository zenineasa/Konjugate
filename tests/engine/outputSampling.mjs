/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Contract for a run's samples: one at its start and one after every outputInterval / globalTimeStep global steps, counted from the
// run's start, however long it runs:
//   - 600 s at a global step and output interval of 0.1 s gives 6001 samples and 6001 checkpoints, one every 0.1 s, under Euler, node
//     by node, and every whole-model method (a time accumulated interval by interval drifted from the steps' own times and, after
//     305.9 s, skipped a sample);
//   - a run forked from a checkpoint late in it samples every interval from there to its end;
//   - an exported program writes the same sample times.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { generateStandaloneProgram } from '../../src/codeExport.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');

function execute(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, diagnostics }));
    });
}

const directory = await mkdtemp(join(tmpdir(), 'konjugateOutputSampling-'));
let runs = 0;
async function run(model, configuration) {
    const index = runs++;
    const configurationPath = join(directory, `run${index}.json`);
    const outputPath = join(directory, `run${index}.kjr`);
    await writeFile(configurationPath, JSON.stringify({ name: `run${index}`, ...configuration }));
    const { code, diagnostics } = await execute(executable, ['run', model, '--configuration', configurationPath, '--output', outputPath]);
    assert.equal(code, 0, `The run must succeed: ${diagnostics}`);
    return decodeResultFile(await readFile(outputPath));
}

// Every sample on its interval: k interval after the start, to rounding.
function assertEveryInterval(times, start, interval, count, label) {
    assert.equal(times.length, count, `${label}: ${count} samples, not ${times.length}.`);
    times.forEach((time, index) => assert.ok(Math.abs(time - (start + index * interval)) <= 1e-9, `${label}: sample ${index} at ${time} s.`));
}

const document = {
    format: 'konjugate', version: 1, metadata: { units: 'SI' },
    nodes: [{ id: 1, name: 'Decay', position: [0, 0, 0], states: [{ id: 11, name: 'Y', symbol: 'y', initialValue: 1, unit: '' }],
        sourceTerms: [{ id: 101, state: 'y', expression: '-0.001 y', expressionModel: { latex: '-0.001 y', bindings: [{ kind: 'state', nodeId: 1, stateId: 11, symbol: 'y' }],
            output: { stateId: 11 }, mathJson: ['Multiply', '-0.001', 'y'] } }],
        appearance: { type: 'primitive', shape: 'box', color: '#2f6970' } }],
    edges: []
};

try {
    const model = join(directory, 'decay.kjt');
    await writeFile(model, await encodeProjectFile(JSON.stringify(document)));
    const timing = { targetTime: 600, globalTimeStep: 0.1, outputInterval: 0.1 };
    let euler = null;
    for (const method of [{}, { method: 'rungeKutta4' }, { method: 'dormandPrince54' }, { method: 'rodas4' }]) {
        const result = await run(model, { ...timing, ...method });
        const label = method.method ?? 'Euler, node by node';
        assertEveryInterval(result.samples.map((sample) => sample.time), 0, 0.1, 6001, label);
        assertEveryInterval(result.checkpoints.map((checkpoint) => checkpoint.time), 0, 0.1, 6001, `${label}, checkpoints`);
        if (!method.method) euler = result;
    }

    // Forked from a checkpoint late in the run: every interval from there to the end, on the uninterrupted run's bits.
    const checkpoint = euler.checkpoints.find((entry) => Math.abs(entry.time - 123.4) <= 1e-9);
    const forked = await run(model, { ...timing, startCheckpoint: checkpoint });
    assertEveryInterval(forked.samples.map((sample) => sample.time), checkpoint.time, 0.1, 4767, 'Forked at 123.4 s');
    assert.ok(Object.is(forked.samples.at(-1).states[0].value, euler.samples.at(-1).states[0].value), 'The fork ends on the uninterrupted run\'s bits.');

    // An exported program writes a row at the same times (its own counter of global steps).
    const exported = { ...document, runConfigurations: [{ id: 900, ...timing }], activeRunConfigurationId: 900 };
    const pythonPath = join(directory, 'decay.py');
    await writeFile(pythonPath, generateStandaloneProgram(exported, 'python'));
    const csvPath = join(directory, 'decay.csv');
    const python = await execute('python3', [pythonPath, '--target-time', '600', '--output', csvPath]);
    assert.equal(python.code, 0, `The exported program must run: ${python.diagnostics}`);
    const rows = (await readFile(csvPath, 'utf8')).trim().split('\n').slice(1).map((line) => Number(line.split(',')[0]));
    assertEveryInterval(rows, 0, 0.1, 6001, 'Exported Python');

    console.log('✓ output sampling: 600 s at 0.1 s gives 6001 samples and checkpoints under every method, a fork samples every interval to its end, '
        + 'and an exported program writes the same times.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
