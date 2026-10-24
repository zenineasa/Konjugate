/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Compares how src/parameterHistory.mjs rebuilds a parameter's value from the engine's record of the changes it applied with
// the value the engine actually used, sample by sample. A state is set directly to the live parameter (an algebraic state), so the
// result records exactly what the parameter was at every sample, whatever was done to it. The sequence covers a ramp, a waveform
// that starts later than it is sent, a value set outright that ends it, and a pulse, with some changes sent while the run goes.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/parameterHistory.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { parameterValueAt } from '../../src/parameterHistory.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { runWithLiveCommands } from './liveRun.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const ownValue = 0.5;
const model = {
    format: 'konjugate', version: 1,
    nodes: [{
        id: 1, name: 'Probe', appearance: { type: 'primitive', shape: 'box', color: '#34727a' },
        states: [{ id: 2, name: 'Y', symbol: 'y', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: 3, state: 'y', expression: 'k', setsValue: true,
            parameters: [{ id: 4, name: 'k', symbol: 'k', value: ownValue, unit: '', mode: 'live', control: { minimum: -100, maximum: 100, step: 1 } }],
            expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId: 4, symbol: 'k' }], output: { stateId: 2 }, mathJson: 'k' }
        }]
    }],
    edges: []
};
const set = (value) => ({ type: 'setParameterValue', parameterId: 4, value });
const schedule = (fields) => ({ type: 'scheduleParameterValue', parameterId: 4, startTime: 0, duration: 0, targetValue: 0, baseValue: 0, ...fields });

const directory = await mkdtemp(join(tmpdir(), 'konjugateHistory-'));
try {
    const input = join(directory, 'run.kjt');
    const settings = join(directory, 'run.json');
    const output = join(directory, 'run.bin');
    await writeFile(input, await encodeProjectFile(`${JSON.stringify(model)}\n`));
    await writeFile(settings, JSON.stringify({ name: 'History', targetTime: 1.8, globalTimeStep: 0.001, outputInterval: 0.005, startPaused: true, pacing: { mode: 'realTime', simulationSecondsPerWallSecond: 1 }, execution: { backend: 'serial' } }));
    const held = [set(1.5), schedule({ mode: 'ramp', startTime: 0, duration: 0.1, baseValue: 1.5, targetValue: 4 }), { type: 'setRunState', state: 'running' }];
    // Then, as the run reaches each time: a waveform that is to start well after it is sent, a value set outright (which ends it, or
    // the ramp's hold, whichever is in force), a pulse, and a short burst of noise. Where each lands in the run varies a little from
    // one run to the next; the comparison holds for any order, and the engine's own record says what the order was.
    const later = [
        { after: 0.1, command: schedule({ mode: 'waveform', startTime: 0.7, duration: 0, baseValue: 4, waveform: { shape: 'sine', amplitude: 2, frequency: 5, phaseDegrees: 30, dutyCycle: 0, seed: 0 } }) },
        { after: 0.8, command: set(-1) },
        { after: 1.1, command: schedule({ mode: 'pulse', startTime: 1.1, duration: 0.1, baseValue: -1, targetValue: 3 }) },
        { after: 1.3, command: schedule({ mode: 'waveform', startTime: 1.3, duration: 0.15, baseValue: 0, waveform: { shape: 'noise', amplitude: 1, frequency: 40, phaseDegrees: 0, dutyCycle: 0, seed: 2025 } }) }
    ];
    await runWithLiveCommands({ executable, input, settings, output, commands: held, later });
    const result = decodeResultFile(await readFile(output));
    assert.equal(result.interventions.length, 6, 'The engine did not record the six changes that were made.');
    assert.ok(result.samples.length > 300);
    let worst = 0;
    // The first sample is the starting state, written before the engine applies any change that was waiting, so it shows the
    // parameter's own value; every sample after it is what the steps used.
    for (const sample of result.samples.slice(1)) {
        const recorded = sample.states.find((state) => state.stateId === 2).value;
        // A change takes effect from the step it was applied at. The state recorded in a sample that falls exactly on that step was
        // settled just before the change was applied, so it still shows the old value: compare it with the instant before.
        const onChange = result.interventions.some((change) => Math.abs(change.time - sample.time) < 1e-9);
        const rebuilt = parameterValueAt(result.interventions, 4, ownValue, onChange ? sample.time - 1e-9 : sample.time);
        worst = Math.max(worst, Math.abs(recorded - rebuilt));
        assert.ok(Math.abs(recorded - rebuilt) < 1e-6, `At ${sample.time} s the engine used ${recorded}, the rebuilt history says ${rebuilt}.`);
    }
    // The comparison would pass if nothing ever changed, so check that a good deal did.
    const used = new Set(result.samples.map((sample) => Math.round(sample.states.find((state) => state.stateId === 2).value * 1e6)));
    assert.ok(used.size > 60, `The parameter took only ${used.size} different values, so the comparison proves little.`);
    console.log(`The rebuilt parameter history matches what the engine used at ${result.samples.length} samples (worst difference ${worst.toExponential(1)}).`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
