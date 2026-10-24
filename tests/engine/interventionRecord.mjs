/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The record the engine keeps of every parameter change it applies: what was asked, in order, and the simulation time of the
// step it took effect at, written into the result file and read back by decodeResultFile. Run manually (after
// `npm run build:engine`):
//   node tests/engine/interventionRecord.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { decodeProjectBundle, encodeProjectFile } from '../../src/projectFile.mjs';
import { runWithLiveCommands } from './liveRun.mjs';

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

const directory = await mkdtemp(join(tmpdir(), 'konjugateInterventions-'));
let runNumber = 0;
// `commands` are written at once; each of `later` ({ after, command }) once the run has reached `after` simulation seconds.
async function run(configuration, commands, later = []) {
    runNumber += 1;
    const input = join(directory, `run${runNumber}.kjt`);
    const settings = join(directory, `run${runNumber}.json`);
    const output = join(directory, `run${runNumber}.bin`);
    await writeFile(input, await encodeProjectFile(`${JSON.stringify(model)}\n`));
    await writeFile(settings, JSON.stringify({ name: 'Interventions', targetTime: 0.6, globalTimeStep: 0.001, outputInterval: 0.05, pacing: { mode: 'fastest', simulationSecondsPerWallSecond: 1 }, execution: { backend: 'serial' }, ...configuration }));
    await runWithLiveCommands({ executable, input, settings, output, commands, later });
    const bytes = await readFile(output);
    // The raw result, kept beside what is read from it, for saving.
    return Object.defineProperty(decodeResultFile(bytes), 'bytes', { value: bytes });
}
const set = (value) => ({ type: 'setParameterValue', parameterId: 4, value });
const waveform = { type: 'scheduleParameterValue', parameterId: 4, mode: 'waveform', startTime: 0, duration: 2.5, baseValue: 3, waveform: { shape: 'noise', amplitude: 1.5, frequency: 8, phaseDegrees: 0, dutyCycle: 0, seed: 123456789012 } };
const ramp = { type: 'scheduleParameterValue', parameterId: 4, mode: 'ramp', startTime: 0, duration: 0.2, baseValue: 0, targetValue: 4 };

try {
    // A run with no changes has an empty record.
    assert.deepEqual((await run({}, [])).interventions, []);

    // Changes made while the run is held are recorded in order, at the step they took effect at (the first), exactly as asked.
    const held = await run({ startPaused: true }, [set(3), ramp, waveform, { type: 'setRunState', state: 'running' }]);
    assert.equal(held.interventions.length, 3);
    assert.deepEqual(held.interventions.map((item) => [item.kind, item.time]), [['value', 0], ['schedule', 0], ['schedule', 0]]);
    assert.deepEqual(held.interventions[0], { time: 0, kind: 'value', parameterId: 4, value: 3 });
    assert.deepEqual(held.interventions[1], { time: 0, kind: 'schedule', parameterId: 4, mode: 'ramp', startTime: 0, duration: 0.2, targetValue: 4, baseValue: 0 });
    assert.deepEqual(held.interventions[2].waveform, { shape: 'noise', amplitude: 1.5, frequency: 8, phaseDegrees: 0, dutyCycle: 0, seed: 123456789012 });
    assert.equal(held.interventions[2].duration, 2.5);

    // A change made while the run is held is in the result even if it is never resumed, not only once it goes on.
    const neverResumed = await run({ startPaused: true }, [set(7), { type: 'setRunState', state: 'stopped' }]);
    assert.deepEqual(neverResumed.interventions.map((item) => [item.kind, item.value]), [['value', 7]]);

    // A change sent while the run is going is recorded at the simulation time of the step it was applied at: after the time the run had
    // reached when it was sent, a multiple of the timestep, and later changes are not earlier than earlier ones.
    const during = await run({ targetTime: 1.6, pacing: { mode: 'realTime', simulationSecondsPerWallSecond: 1 } }, [], [
        { after: 0.15, command: set(2) }, { after: 0.6, command: set(-2) }
    ]);
    assert.equal(during.interventions.length, 2);
    const [first, second] = during.interventions.map((item) => item.time);
    assert.ok(first >= 0.15 && second >= 0.6 && second > first && second < 1.6, `Applied at ${first} and ${second} s.`);
    for (const time of [first, second]) assert.ok(Math.abs(time * 1000 - Math.round(time * 1000)) < 1e-6, `${time} s is not a step boundary.`);

    // Saved with the project and opened again, the record comes back as it was: it is part of the result, not kept beside it.
    const saved = await encodeProjectFile(`${JSON.stringify(model)}\n`, { result: held.bytes });
    const reopened = decodeResultFile((await decodeProjectBundle(saved)).result);
    assert.deepEqual(reopened.interventions, held.interventions);

    console.log('The engine records every applied parameter change, in order, at the step it took effect.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
