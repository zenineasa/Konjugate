/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A run configured with `startPaused` is held before its first step, so values set while it is held apply from step zero:
// no race with a pause command sent after the start, and the result is the exact integral, not a close one. The model
// is one state that integrates a live parameter (dx/dt = k), so where it ends is the area under k.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/startPaused.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeResultFile, encodeEngineCommand } from '../../src/engineProtocol.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const model = {
    format: 'konjugate', version: 1,
    nodes: [{
        id: 1, name: 'Integrator', appearance: { type: 'primitive', shape: 'box', color: '#34727a' },
        states: [{ id: 2, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: 3, state: 'x', expression: 'k',
            parameters: [{ id: 4, name: 'k', symbol: 'k', value: 0, unit: '', mode: 'live', control: { minimum: -100, maximum: 100, step: 1 } }],
            expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId: 4, symbol: 'k' }], output: { stateId: 2 }, mathJson: 'k' }
        }]
    }],
    edges: []
};

const directory = await mkdtemp(join(tmpdir(), 'konjugateStartPaused-'));
let runNumber = 0;
async function run(configuration, commands) {
    runNumber += 1;
    const input = join(directory, `run${runNumber}.kjt`);
    const settings = join(directory, `run${runNumber}.json`);
    const output = join(directory, `run${runNumber}.bin`);
    await writeFile(input, await encodeProjectFile(`${JSON.stringify(model)}\n`));
    await writeFile(settings, JSON.stringify({ name: 'Start paused', targetTime: 0.3, globalTimeStep: 0.001, outputInterval: 0.05, pacing: { mode: 'fastest', simulationSecondsPerWallSecond: 1 }, execution: { backend: 'serial' }, ...configuration }));
    await new Promise((resolve, reject) => {
        const child = spawn(executable, ['run', input, '--configuration', settings, '--output', output, '--control-stream', 'protobuf'], { stdio: ['pipe', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(diagnostics || `The engine exited with code ${code}.`))));
        commands.forEach((command, index) => child.stdin.write(encodeEngineCommand(index + 1, command)));
        child.stdin.end();
    });
    return decodeResultFile(await readFile(output));
}
const x = (sample) => sample.states.find((state) => state.stateId === 2).value;

try {
    // Held at the first step: told to stop before it is ever resumed, it has written the starting state and gone no further.
    const held = await run({ startPaused: true }, [{ type: 'setRunState', state: 'stopped' }]);
    assert.equal(held.samples.at(-1).time, 0, 'A run started paused went on before it was resumed.');
    assert.equal(x(held.samples.at(-1)), 0);

    // A value set while held applies from the very first step, at full speed (no pacing to hide a race): the area is exact.
    const set = await run({ startPaused: true }, [{ type: 'setParameterValue', parameterId: 4, value: 3 }, { type: 'setRunState', state: 'running' }]);
    assert.ok(Math.abs(x(set.samples.at(-1)) - 0.9) < 1e-9, `Expected 3 x 0.3 = 0.9 exactly, got ${x(set.samples.at(-1))}.`);
    assert.equal(x(set.samples[0]), 0);

    // Without the setting, the same commands are a race with the run, and a fast run is over before they are read.
    const ordinary = await run({}, []);
    assert.ok(Math.abs(x(ordinary.samples.at(-1))) < 1e-12, 'A run not started paused should integrate k = 0.');

    console.log('A run started paused is held before its first step and applies values set while held from step zero.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
