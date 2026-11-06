/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Replaying a data log through a model (src/dataLogReplay.mjs): matching signals, building the run, and judging how long the model
// stayed in step. tests/engine/dataLogReplay.mjs does the same through the real engine with the simulated rig's log.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readDataLog } from '../src/dataLog.mjs';
import {
    compareReplay, defaultTolerance, guessReplayMapping, interpolate, latestReadings, replayPlan, ReplayError, replaySentence, replayTargets, suggestedReplayTimeStep
} from '../src/dataLogReplay.mjs';
import { tankRigProject } from '../scripts/generateTankRigModel.mjs';

const log = (...rows) => readDataLog([
    '# konjugate data log: 1',
    '# time: seconds since 2026-11-06T09:00:00Z',
    '# inputs: heaterPower, valveOpen',
    '# outputs: tankTemperature, flow',
    'time,heaterPower [W],valveOpen [-],tankTemperature [K],flow [m^3/s],tankTemperature quality',
    ...rows
].join('\n') + '\n');

test('signals are matched to the model by name: inputs to shared parameters, measured signals to states', () => {
    const document = tankRigProject();
    const mapping = guessReplayMapping(log('0,1000,1,293.2,,').header, replayTargets(document));
    assert.deepEqual(mapping, [
        { signal: 'heaterPower', role: 'input', unit: 'W', parameterId: 40 },
        { signal: 'valveOpen', role: 'input', unit: '-', parameterId: null },
        { signal: 'tankTemperature', role: 'output', unit: 'K', stateId: 2 },
        { signal: 'flow', role: 'output', unit: 'm^3/s', stateId: null }
    ]);
});

test('a state is also found by its node name and state name run together', () => {
    const targets = replayTargets(tankRigProject());
    const header = { signals: [{ name: 'Water_tank_Water_temperature', unit: 'K', role: 'output' }] };
    assert.equal(guessReplayMapping(header, targets)[0].stateId, 2);
});

test('a reading corrected later is replaced by its correction', () => {
    const { observations } = log('0,,,293.0,,', '60,,,299.0,,', '120,,,294.0,,', '60,,,293.5,,');
    assert.deepEqual(latestReadings(observations, 'tankTemperature').map((reading) => [reading.time, reading.value]), [[0, 293], [60, 293.5], [120, 294]]);
});

test('the plan drives a shared parameter with a held schedule, anchors the state, and starts at the log\'s first time', () => {
    const document = tankRigProject();
    document.sharedParameters.find((parameter) => parameter.id === 40).tuning = { minimum: 0, maximum: 2000 };
    const recording = log('600,1000,,293.30,,', '660,,,293.61,,', '720,,,500,,bad', '780,0,,294.10,,');
    const mapping = guessReplayMapping(recording.header, replayTargets(document));
    const plan = replayPlan(document, recording, mapping, { timeStep: 60 });
    const heater = plan.document.sharedParameters.find((parameter) => parameter.id === 40);
    assert.deepEqual(heater.schedule, { interpolation: 'hold', samples: [[0, 1000], [180, 0]] });
    assert.equal(heater.tuning, undefined, 'A scheduled parameter cannot also be tuned.');
    assert.equal(plan.document.nodes[0].states[0].initialValue, 293.3);
    assert.equal(document.nodes[0].states[0].initialValue, 293.15, 'The model itself is not changed.');
    assert.equal(document.sharedParameters.find((parameter) => parameter.id === 40).schedule, undefined);
    assert.deepEqual(plan.configuration, { globalTimeStep: 60, outputInterval: 60, targetTime: 180 });
    assert.equal(plan.start, 600);
    assert.deepEqual(plan.outputs, [{
        signal: 'tankTemperature', stateId: 2, unit: 'K', leftOut: 1,
        readings: [{ time: 0, value: 293.3, quality: 'good' }, { time: 60, value: 293.61, quality: 'good' }, { time: 180, value: 294.1, quality: 'good' }]
    }]);
    assert.equal(replayPlan(document, recording, mapping, { timeStep: 60, anchor: false }).document.nodes[0].states[0].initialValue, 293.15);
});

test('the suggested step is the model\'s, or the readings\' spacing when that is finer', () => {
    const document = tankRigProject(); // a 60 s step
    const mapping = [{ signal: 'tankTemperature', role: 'output', stateId: 2 }];
    assert.equal(suggestedReplayTimeStep(document, log('0,,,293,,', '10,,,293,,', '30,,,293,,').observations, mapping), 10);
    assert.equal(suggestedReplayTimeStep(document, log('0,,,293,,', '600,,,293,,').observations, mapping), 60);
});

test('a plan that cannot be made says why', () => {
    const document = tankRigProject();
    const recording = log('0,1000,,293,,', '60,,,293.5,,');
    const mapping = guessReplayMapping(recording.header, replayTargets(document));
    const refused = (overrides, pattern, options = { timeStep: 60 }) => assert.throws(() => replayPlan(document, overrides.log ?? recording, overrides.mapping ?? mapping, options), (error) => error instanceof ReplayError && pattern.test(error.message));
    refused({ mapping: mapping.map((entry) => ({ ...entry, stateId: null })) }, /Map at least one measured signal/);
    refused({}, /time step must be a positive/, { timeStep: 0 });
    refused({ log: log('0,1000,,293,,') }, /covers no time yet/);
    refused({ log: log('0,1000,,293,,bad', '60,,,293,,bad') }, /tankTemperature has no good readings/);
});

test('the model is read between its samples in a straight line, and not outside them', () => {
    const samples = [{ time: 0, value: 0 }, { time: 10, value: 10 }, { time: 20, value: 0 }];
    assert.equal(interpolate(samples, 5), 5);
    assert.equal(interpolate(samples, 15), 5);
    assert.equal(interpolate(samples, 20), 0);
    assert.ok(Number.isNaN(interpolate(samples, 21)));
});

const readingsOf = (values) => values.map((value, index) => ({ time: index * 60, value }));
const flat = (value, count) => readingsOf(Array(count).fill(value)).map((reading) => ({ time: reading.time, value }));

test('a model that stays within the tolerance is in step for the whole recording', () => {
    const comparison = compareReplay(readingsOf([20, 20.1, 19.9, 20, 20.2]), flat(20, 5), { tolerance: 0.5 });
    assert.deepEqual(comparison.stretches, []);
    assert.equal(comparison.inStepUntil, null);
    assert.equal(comparison.within, 1);
    assert.ok(Math.abs(comparison.largest.error + 0.2) < 1e-9);
});

test('a few readings outside in a row put the model out of step; one on its own is noise', () => {
    const comparison = compareReplay(readingsOf([20, 21, 20, 20, 21, 21, 21, 21, 20]), flat(20, 9), { tolerance: 0.5 });
    assert.deepEqual(comparison.stretches, [{ from: 240, to: 420, readings: 4 }]);
    assert.equal(comparison.inStepUntil, 240);
    assert.equal(comparison.stray, 1);
    assert.equal(compareReplay(readingsOf([20, 21, 21, 20]), flat(20, 4), { tolerance: 0.5, minimumOut: 2 }).stretches.length, 1);
});

test('the sentence says how long the model stayed in step and by how much it missed', () => {
    const inStep = compareReplay(readingsOf([20, 20.1, 20.9, 20]), flat(20, 4), { tolerance: 0.5 });
    assert.equal(replaySentence('Tank · Temperature', 'K', inStep, { duration: 7200, leftOut: 1 }),
        'Tank · Temperature stayed within 0.5 K for the whole 2 h 00 min. Typical miss 0.453 K, largest 0.9 K at 2 min 00 s. 1 reading outside it on its own was taken as noise. 1 bad reading was left out.');
    const drifting = compareReplay(readingsOf([20, 20, 21, 22, 23]), flat(20, 5), { tolerance: 0.5 });
    assert.match(replaySentence('Level', 'm', drifting, { duration: 240 }), /^Level stayed within 0\.5 m for 2 min 00 s, then left it \(out of step for 2 min 00 s\)\./);
    const wrong = compareReplay(readingsOf([25, 25, 25]), flat(20, 3), { tolerance: 0.5 });
    assert.match(replaySentence('Level', '', wrong, { duration: 120 }), /^Level was not within 0\.5 from the start/);
});

test('the first guess at a tolerance is a twentieth of the range covered', () => {
    assert.equal(defaultTolerance(readingsOf([293.15, 318.2])), 1.3);
    assert.equal(defaultTolerance(readingsOf([5, 5])), 0.05);
});
