/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Drives waveform parameter schedules through the real engine, over the same control stream the app uses, and compares
// where a run ends with the integral worked out by hand. The model is one state that integrates a live parameter k
// (dx/dt = k), so x at the end is the area under k: what a waveform did to k shows up in x exactly, and nothing else is
// in the way.
//
// Each run is paced in real time and its waveform starts 0.2 s in, so the commands written the moment the engine is
// spawned have reached it long before the waveform begins; the run lasts under a second. Run it with
//   node tests/engine/parameterWaveforms.mjs [path/to/konjugateEngine]
// after `npm run build:engine`.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeResultFile, encodeEngineCommand, FramedEngineEventDecoder } from '../../src/engineProtocol.mjs';
import { waveformValue } from '../../src/parameterSchedule.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const parameterId = 4;
const start = 0.2;

const model = () => ({
    format: 'konjugate', version: 1,
    nodes: [{
        id: 1, name: 'Integrator', appearance: { type: 'primitive', shape: 'box', color: '#34727a' },
        states: [{ id: 2, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: 3, state: 'x', expression: 'k',
            parameters: [{ id: parameterId, name: 'k', symbol: 'k', value: 0, unit: '', mode: 'live', control: { minimum: -1000, maximum: 1000, step: 1 } }],
            expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId, symbol: 'k' }], output: { stateId: 2 }, mathJson: 'k' }
        }]
    }],
    edges: []
});

const directory = await mkdtemp(join(tmpdir(), 'konjugateWaveforms-'));
let runNumber = 0;

// Where x ends after the commands (written to the engine's control stream at once) have been applied.
async function finalX(targetTime, commands) {
    runNumber += 1;
    const input = join(directory, `run${runNumber}.kjt`);
    const configuration = join(directory, `run${runNumber}.json`);
    const output = join(directory, `run${runNumber}.bin`);
    await writeFile(input, await encodeProjectFile(`${JSON.stringify(model())}\n`));
    await writeFile(configuration, JSON.stringify({
        name: 'Waveform', targetTime, globalTimeStep: 0.001, outputInterval: targetTime / 5,
        pacing: { mode: 'realTime', simulationSecondsPerWallSecond: 1 }, execution: { backend: 'serial' }
    }));
    await new Promise((resolve, reject) => {
        const child = spawn(executable, ['run', input, '--configuration', configuration, '--output', output, '--control-stream', 'protobuf'], { stdio: ['pipe', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(diagnostics || `The engine exited with code ${code}.`))));
        commands.forEach((command, index) => child.stdin.write(encodeEngineCommand(index + 1, command)));
        child.stdin.end();
    });
    return decodeResultFile(await readFile(output)).states[0].value;
}

const waveform = (shape, fields = {}, schedule = {}) => ({
    type: 'scheduleParameterValue', parameterId, mode: 'waveform', startTime: start, duration: schedule.duration ?? 0, baseValue: schedule.baseValue ?? 0,
    waveform: { shape, amplitude: 1, frequency: 1, ...fields }
});
const near = (actual, expected, tolerance, what) => assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: expected ${expected} within ${tolerance}, got ${actual}.`);

// One state per shape, each set directly to its own live parameter (an algebraic state, so the recorded value is the
// parameter's value at that time), so a single run records what the engine computes for every shape at once.
const parityShapes = [
    ['sine', { amplitude: 3, frequency: 1.3, phaseDegrees: 40 }],
    ['square', { amplitude: 2, frequency: 2, dutyCycle: 0.3 }],
    ['triangle', { amplitude: 4, frequency: 0.9, phaseDegrees: 200 }],
    ['sawtooth', { amplitude: 1.5, frequency: 1.7, phaseDegrees: 15 }],
    ['noise', { amplitude: 5, frequency: 12, seed: 123456789 }]
];
const parityBase = 10;
const parityModel = () => ({
    format: 'konjugate', version: 1,
    nodes: parityShapes.map(([shape], index) => ({
        id: 100 + index * 10, name: `Probe ${shape}`, appearance: { type: 'primitive', shape: 'box', color: '#34727a' },
        states: [{ id: 101 + index * 10, name: 'Y', symbol: 'y', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: 102 + index * 10, state: 'y', expression: 'k', setsValue: true,
            parameters: [{ id: 103 + index * 10, name: 'k', symbol: 'k', value: 0, unit: '', mode: 'live', control: { minimum: -1000, maximum: 1000, step: 1 } }],
            expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId: 103 + index * 10, symbol: 'k' }], output: { stateId: 101 + index * 10 }, mathJson: 'k' }
        }]
    })),
    edges: []
});

async function recordedWaveforms() {
    const input = join(directory, 'parity.kjt');
    const configuration = join(directory, 'parity.json');
    const output = join(directory, 'parity.bin');
    await writeFile(input, await encodeProjectFile(`${JSON.stringify(parityModel())}\n`));
    await writeFile(configuration, JSON.stringify({
        name: 'Parity', targetTime: 1.6, globalTimeStep: 0.01, outputInterval: 0.01,
        pacing: { mode: 'realTime', simulationSecondsPerWallSecond: 1 }, execution: { backend: 'serial' }
    }));
    await new Promise((resolve, reject) => {
        const child = spawn(executable, ['run', input, '--configuration', configuration, '--output', output, '--control-stream', 'protobuf'], { stdio: ['pipe', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(diagnostics || `The engine exited with code ${code}.`))));
        parityShapes.forEach(([shape, fields], index) => child.stdin.write(encodeEngineCommand(index + 1, {
            type: 'scheduleParameterValue', parameterId: 103 + index * 10, mode: 'waveform', startTime: start, duration: 0, baseValue: parityBase,
            waveform: { shape, ...fields }
        })));
        child.stdin.end();
    });
    return decodeResultFile(await readFile(output)).samples;
}

try {
    // The engine says it has them: the app offers waveforms only to an engine that does.
    const capabilities = await new Promise((resolve, reject) => {
        const child = spawn(executable, ['capabilities', '--protobuf'], { stdio: ['ignore', 'pipe', 'inherit'] });
        const decoder = new FramedEngineEventDecoder();
        const events = [];
        child.stdout.on('data', (chunk) => events.push(...decoder.append(chunk)));
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve(events[0].capabilities) : reject(new Error(`capabilities exited with ${code}`))));
    });
    assert.deepEqual(capabilities.parameterScheduleModes, ['step', 'ramp', 'pulse', 'piecewise', 'waveform']);

    // Sine around 0 with amplitude 2*pi at 1 Hz integrates to 1 - cos(2*pi*t'), t' since the start: a quarter period in, 1.
    near(await finalX(0.45, [waveform('sine', { amplitude: 2 * Math.PI })]), 1, 0.02, 'a sine a quarter period in');

    // Square at 1 Hz, amplitude 1: high for the first half period, so 0.25 s in the area is 0.25.
    near(await finalX(0.45, [waveform('square')]), 0.25, 0.01, 'a square wave a quarter period in');

    // A waveform around a base value rides on it: base 3 adds 3 * 0.25 to the same sine's integral.
    near(await finalX(0.45, [waveform('sine', { amplitude: 2 * Math.PI }, { baseValue: 3 })]), 1 + 3 * 0.25, 0.03, 'a sine around a base value');

    // Its window ends: a sine lasting a quarter period reads its base value (0) afterwards and x stops at 1, where
    // one that goes on is at 1 - cos(2*pi*0.4) = 1.809 at 0.6 s.
    near(await finalX(0.6, [waveform('sine', { amplitude: 2 * Math.PI }, { duration: 0.25 })]), 1, 0.03, 'a sine with a duration, after it ends');
    near(await finalX(0.6, [waveform('sine', { amplitude: 2 * Math.PI })]), 1 - Math.cos(2 * Math.PI * 0.4), 0.03, 'a sine with no duration, still going');

    // Setting a value is the newest decision: it clears a waveform sent before it, but a waveform sent after it governs.
    near(await finalX(0.45, [waveform('sine', { amplitude: 2 * Math.PI }), { type: 'setParameterValue', parameterId, value: 0 }]), 0, 1e-9, 'a value set after a waveform');
    near(await finalX(0.45, [{ type: 'setParameterValue', parameterId, value: 0 }, waveform('sine', { amplitude: 2 * Math.PI })]), 1, 0.02, 'a waveform sent after a value set');

    // Noise: the same seed gives the same run to the last digit, another seed another run, and it stays inside its bounds
    // (|x| <= amplitude * the 0.25 s it has run).
    const noise = (seed) => waveform('noise', { amplitude: 10, frequency: 20, seed });
    const first = await finalX(0.45, [noise(7)]);
    assert.equal(await finalX(0.45, [noise(7)]), first, 'The same seed gave a different run.');
    assert.notEqual(await finalX(0.45, [noise(8)]), first, 'Another seed gave the same run.');
    assert.ok(Math.abs(first) <= 10 * 0.25 + 1e-9, `Noise left its bounds: ${first}.`);

    // The JavaScript copy that draws a waveform before it is started gives, to rounding, what the engine computes, for every
    // shape, from the moment the waveform starts: so what the preview shows is what the run does.
    const samples = await recordedWaveforms();
    assert.ok(samples.length > 100, 'The parity run recorded too few samples.');
    for (const [index, [shape, fields]] of parityShapes.entries()) {
        let compared = 0;
        let worst = 0;
        // From the moment it starts: before that the parameter simply reads its own value, as the engine has not begun the schedule.
        for (const sample of samples.filter((candidate) => candidate.time >= start)) {
            const recorded = sample.states.find((state) => state.stateId === 101 + index * 10).value;
            const expected = waveformValue({ shape, ...fields }, parityBase, sample.time - start);
            worst = Math.max(worst, Math.abs(recorded - expected));
            compared += 1;
        }
        assert.ok(worst < 1e-6, `The preview of a ${shape} wave differs from the engine by up to ${worst} over ${compared} samples.`);
    }
    const distinct = new Set(samples.map((sample) => sample.states.find((state) => state.stateId === 141).value));
    assert.ok(distinct.size > 5, 'The noise in the parity run did not vary, so the comparison proved nothing.');

    console.log('Parameter waveforms behave as designed through the real engine.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
