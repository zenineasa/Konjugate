/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A run steered by hand repeats to the bit from its record (docs/proposals/humanInputBinding.md): the values and schedules the
// engine recorded while the run went, sent by recordAsCommands to a fresh run before its first step, each held until the time it was
// recorded at, give every sample of every state the same bits, an algebraic state that reads the parameter included, and the same
// record. The record holds values set mid-run (two of them at one step, of which the last took effect), a ramp and a waveform sent
// with a start a little before they reached the engine (as the live controls send them), and a value that ends the waveform. Run manually (after `npm run build:engine`):
//   node tests/engine/handSteeredReplay.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { recordAsCommands } from '../../src/interventionSchedules.mjs';
import { parameterScheduleCommand } from '../../src/parameterSchedule.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { runWithLiveCommands } from './liveRun.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const use = (id) => ({ id, name: 'Drive', symbol: 'k', value: 0, unit: '', mode: 'live', sharedParameterId: 100 });
const model = {
    format: 'konjugate', version: 1,
    sharedParameters: [{ id: 100, name: 'Drive', symbol: 'k', value: 0, unit: '', mode: 'live', control: { minimum: -100, maximum: 100, step: 0.01 } }],
    nodes: [{
        id: 1, name: 'Integrator', appearance: { type: 'primitive', shape: 'box', color: '#34727a' },
        states: [{ id: 2, name: 'X', symbol: 'x', initialValue: 0, unit: '' }, { id: 5, name: 'Y', symbol: 'y', initialValue: 0, unit: '' }],
        sourceTerms: [
            { id: 3, state: 'x', expression: 'k', parameters: [use(4)],
                expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId: 4, symbol: 'k' }], output: { stateId: 2 }, mathJson: 'k' } },
            { id: 6, state: 'y', expression: '3 k + x', setsValue: true, parameters: [use(7)],
                expressionModel: { latex: '3k+x', output: { stateId: 5 }, mathJson: ['Add', ['Multiply', 3, 'k'], 'x'],
                    bindings: [{ kind: 'parameter', parameterId: 7, symbol: 'k' }, { kind: 'state', nodeId: 1, stateId: 2, symbol: 'x' }] } }
        ]
    }],
    edges: []
};

const directory = await mkdtemp(join(tmpdir(), 'konjugateHandSteered-'));
let runNumber = 0;
async function run(configuration, commands, later = []) {
    runNumber += 1;
    const input = join(directory, `run${runNumber}.kjt`);
    const settings = join(directory, `run${runNumber}.json`);
    const output = join(directory, `run${runNumber}.bin`);
    await writeFile(input, await encodeProjectFile(`${JSON.stringify(model)}\n`));
    await writeFile(settings, JSON.stringify({ name: 'Steered', targetTime: 1.4, globalTimeStep: 0.001, outputInterval: 0.001,
        pacing: { mode: 'realTime', simulationSecondsPerWallSecond: 1 }, execution: { backend: 'serial' }, ...configuration }));
    await runWithLiveCommands({ executable, input, settings, output, commands, later });
    return decodeResultFile(await readFile(output));
}
const set = (value) => ({ type: 'setParameterValue', parameterId: 100, value });
// The commands that repeat a record, sent to a run held before its first step, then let go.
const repeatOf = (record) => [
    ...recordAsCommands(record).map((command) => (command.type === 'scheduleParameterValue'
        ? { ...parameterScheduleCommand(command.parameterId, command.schedule), applyAt: command.applyAt } : command)),
    { type: 'setRunState', state: 'running' }
];
const bits = (value) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    return view.getBigUint64(0);
};

try {
    // Steered as a person with a stick would: values as it moves, two at once at one step, then a ramp and a waveform from the panel.
    const steered = await run({}, [], [
        { after: 0.1, command: set(2.5) },
        { after: 0.3, command: set(-1.25) },
        { after: 0.5, command: set(7) }, { after: 0.5, command: set(7.5) },
        { after: 0.7, command: { type: 'scheduleParameterValue', parameterId: 100, mode: 'ramp', startTime: 0.7, duration: 0.2, baseValue: 7.5, targetValue: -3 } },
        { after: 1.0, command: { type: 'scheduleParameterValue', parameterId: 100, mode: 'waveform', startTime: 1.0, duration: 0, baseValue: 1,
            waveform: { shape: 'noise', amplitude: 2, frequency: 40, phaseDegrees: 0, dutyCycle: 0, seed: 42 } } },
        { after: 1.2, command: set(4) }
    ]);
    assert.ok(steered.interventions.length >= 6, `Only ${steered.interventions.length} changes were recorded.`);

    const fastest = { startPaused: true, pacing: { mode: 'fastest', simulationSecondsPerWallSecond: 1 } };
    const repeated = await run(fastest, repeatOf(steered.interventions));
    assert.deepEqual(repeated.interventions, steered.interventions, 'The repeat did not go through the same changes at the same steps.');

    assert.equal(repeated.samples.length, steered.samples.length);
    const differences = [];
    steered.samples.forEach((sample, index) => {
        const other = repeated.samples[index];
        assert.equal(other.time, sample.time);
        sample.states.forEach(({ stateId, value }, position) => {
            if (bits(value) !== bits(other.states[position].value)) differences.push(`${stateId} at ${sample.time}: ${value} against ${other.states[position].value}`);
        });
    });
    assert.deepEqual(differences, [], 'The repeated run differs from the run steered by hand.');

    // Repeated again from the repeat's own record, the result is the same once more.
    const again = await run(fastest, repeatOf(repeated.interventions));
    assert.ok(again.samples.every((sample, index) => sample.states.every(({ value }, position) => bits(value) === bits(steered.samples[index].states[position].value))),
        'A repeat of the repeat differs.');

    console.log('A run steered by hand repeats to the bit from its record.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
