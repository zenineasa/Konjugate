/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A pause held until a time (EngineCommand.apply_at on a run-state command) stops the run at exactly that step, however fast it
// goes, and it waits there for the next command. This is what lets a run be moved on by its own time rather than by the clock
// (the interaction tests' window.__debugRun.advanceTo): started paused, let go until 0.1 s, a value set while it is held there,
// then let go to its end. The model is one state that integrates a live parameter (dx/dt = k), so where it ends is the area
// under k: 3 x (0.3 - 0.1) = 0.6 exactly, which only a change made at the 0.1 s step gives.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/heldPause.mjs [path/to/konjugateEngine]

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

const directory = await mkdtemp(join(tmpdir(), 'konjugateHeldPause-'));
try {
    const input = join(directory, 'run.kjt');
    const settings = join(directory, 'run.json');
    const output = join(directory, 'run.bin');
    await writeFile(input, await encodeProjectFile(`${JSON.stringify(model)}\n`));
    await writeFile(settings, JSON.stringify({ name: 'Held pause', targetTime: 0.3, globalTimeStep: 0.001, outputInterval: 0.05, pacing: { mode: 'fastest', simulationSecondsPerWallSecond: 1 }, execution: { backend: 'serial' }, startPaused: true }));
    const child = spawn(executable, ['run', input, '--configuration', settings, '--output', output, '--control-stream', 'protobuf'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let diagnostics = '';
    child.stderr.on('data', (chunk) => { diagnostics += chunk; });
    const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(diagnostics || `The engine exited with code ${code}.`))));
    });
    let sequence = 0;
    const send = (command) => child.stdin.write(encodeEngineCommand(++sequence, command));
    // The result the run writes while it is held, once it says so; it is written whole (atomically), so it reads complete.
    const heldResult = async () => {
        for (let attempt = 0; attempt < 600; attempt += 1) {
            const result = await readFile(output).then(decodeResultFile, () => null);
            if (result?.lifecycle === 'paused' && result.simulationTime > 0) return result;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`The run was not held at the time it was told to stop at. ${diagnostics}`);
    };

    send({ type: 'setRunState', state: 'paused', applyAt: 0.1 });
    send({ type: 'setRunState', state: 'running' });
    const held = await heldResult();
    assert.ok(Math.abs(held.simulationTime - 0.1) < 1e-9, `The run was held at ${held.simulationTime} s, not at 0.1 s.`);

    send({ type: 'setParameterValue', parameterId: 4, value: 3 });
    send({ type: 'setRunState', state: 'running' });
    child.stdin.end();
    await exited;
    const result = decodeResultFile(await readFile(output));
    const x = result.samples.at(-1).states.find((state) => state.stateId === 2).value;
    assert.ok(Math.abs(x - 0.6) < 1e-9, `Expected 3 x (0.3 - 0.1) = 0.6 exactly, got ${x}.`);
    console.log('A pause held until a time stops a run at exactly that step, and it waits there for the next command.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
