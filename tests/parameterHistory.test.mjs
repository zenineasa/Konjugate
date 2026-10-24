/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { changedParameterIds, describeIntervention, parameterChangeEntries, parameterSeries, parameterValueAt } from '../src/parameterHistory.mjs';

const value = (time, parameterId, setTo) => ({ time, kind: 'value', parameterId, value: setTo });
const schedule = (time, parameterId, fields) => ({ time, kind: 'schedule', parameterId, mode: 'step', startTime: time, duration: 0, targetValue: 0, baseValue: 0, ...fields });
const near = (actual, expected, what = '') => assert.ok(Math.abs(actual - expected) < 1e-9, `${what} expected ${expected}, got ${actual}`);

test('a parameter has its own value until a change takes effect, and the value set after', () => {
    const changes = [value(2, 7, 5)];
    near(parameterValueAt(changes, 7, 1.5, 0), 1.5);
    near(parameterValueAt(changes, 7, 1.5, 1.999), 1.5);
    near(parameterValueAt(changes, 7, 1.5, 2), 5, 'at the moment it was applied');
    near(parameterValueAt(changes, 7, 1.5, 100), 5);
    near(parameterValueAt(changes, 8, 9, 100), 9, 'another parameter is not touched');
});

test('a ramp, a pulse and a step follow the engine\'s own rules', () => {
    const ramp = [schedule(1, 7, { mode: 'ramp', startTime: 1, duration: 4, baseValue: 0, targetValue: 8 })];
    near(parameterValueAt(ramp, 7, 3, 0.5), 3); near(parameterValueAt(ramp, 7, 3, 1), 0); near(parameterValueAt(ramp, 7, 3, 3), 4); near(parameterValueAt(ramp, 7, 3, 5), 8); near(parameterValueAt(ramp, 7, 3, 99), 8);
    const pulse = [schedule(5, 7, { mode: 'pulse', startTime: 5, duration: 2, baseValue: 1, targetValue: 9 })];
    near(parameterValueAt(pulse, 7, 0, 4), 0); near(parameterValueAt(pulse, 7, 0, 5), 9); near(parameterValueAt(pulse, 7, 0, 6.9), 9); near(parameterValueAt(pulse, 7, 0, 7), 1);
    near(parameterValueAt([schedule(2, 7, { mode: 'step', targetValue: 42 })], 7, 0, 3), 42);
});

test('a waveform swings around the base value from its start, and returns to it when its window ends', () => {
    const wave = [schedule(1, 7, { mode: 'waveform', startTime: 1, duration: 1, baseValue: 10, waveform: { shape: 'sine', amplitude: 3, frequency: 0.25, phaseDegrees: 0, dutyCycle: 0, seed: 0 } })];
    near(parameterValueAt(wave, 7, 0, 0.5), 0, 'before it applies'); near(parameterValueAt(wave, 7, 0, 1), 10); near(parameterValueAt(wave, 7, 0, 2 - 1e-9), 10 + 3 * Math.sin(2 * Math.PI * 0.25), 'a quarter period in'); near(parameterValueAt(wave, 7, 0, 2), 10, 'after its window');
});

test('a value set outright ends the schedules before it, and a later schedule is not affected by it', () => {
    const changes = [schedule(1, 7, { mode: 'waveform', startTime: 1, duration: 0, baseValue: 0, waveform: { shape: 'square', amplitude: 2, frequency: 1, phaseDegrees: 0, dutyCycle: 0, seed: 0 } }), value(4, 7, 3), schedule(6, 7, { mode: 'step', targetValue: 8 })];
    near(parameterValueAt(changes, 7, 0, 1.2), 2); near(parameterValueAt(changes, 7, 0, 3.9), parameterValueAt(changes.slice(0, 1), 7, 0, 3.9));
    near(parameterValueAt(changes, 7, 0, 4.2), 3, 'the value set drops the waveform'); near(parameterValueAt(changes, 7, 0, 7), 8);
});

test('of schedules that have begun, the latest start governs, and the earliest recorded wins a tie', () => {
    const changes = [schedule(1, 7, { startTime: 0, targetValue: 100 }), schedule(2, 7, { startTime: 5, targetValue: 200 }), schedule(3, 7, { startTime: 5, targetValue: 300 })];
    near(parameterValueAt(changes, 7, 0, 4), 100); near(parameterValueAt(changes, 7, 0, 6), 200, 'a tie goes to the first recorded');
});

test('a restart forgets every change, as a continued run starts from the model\'s values', () => {
    const changes = [value(1, 7, 5), schedule(2, 8, { targetValue: 6 }), { time: 3, kind: 'restart' }, value(4, 7, 9)];
    near(parameterValueAt(changes, 7, 1, 2.5), 5); near(parameterValueAt(changes, 7, 1, 3.5), 1); near(parameterValueAt(changes, 8, 2, 3.5), 2); near(parameterValueAt(changes, 7, 1, 4.5), 9);
});

test('a series shows a step as an edge, and reaches both ends of the run', () => {
    const series = parameterSeries([value(2, 7, 5)], 7, 1, 10);
    assert.equal(series.times[0], 0); assert.equal(series.times.at(-1), 10);
    assert.equal(series.times.length, series.values.length);
    assert.ok(series.times.every((time, index) => index === 0 || time > series.times[index - 1]), 'times are not strictly increasing');
    const before = series.times.findLast((time) => time < 2);
    const at = series.times.indexOf(2);
    assert.ok(at > 0 && 2 - before < 1e-6, 'no point just before the step');
    near(series.values[series.times.indexOf(before)], 1, 'just before'); near(series.values[at], 5, 'at the step');
});

test('a series draws a waveform finely enough and stays bounded for a long, fast one', () => {
    const wave = (frequency, shape) => schedule(0, 7, { mode: 'waveform', startTime: 0, duration: 0, baseValue: 0, waveform: { shape, amplitude: 1, frequency, phaseDegrees: 0, dutyCycle: 0, seed: 4 } });
    const sine = parameterSeries([wave(2, 'sine')], 7, 0, 3);
    assert.ok(sine.times.length >= 6 * 2 * 16, `only ${sine.times.length} points for 6 cycles`);
    const noise = parameterSeries([wave(5, 'noise')], 7, 0, 4);
    assert.ok(new Set(noise.values.map((point) => Math.round(point * 1e9))).size >= 19, 'noise should hold about twenty distinct values');
    assert.ok(parameterSeries([wave(10000, 'noise')], 7, 0, 1000).times.length < 30000, 'a long, fast wave is not bounded');
    // The jump of a square wave is an edge: the point before it still has the old value.
    const square = parameterSeries([wave(1, 'square')], 7, 0, 3);
    const jump = square.times.indexOf(0.5);
    assert.ok(jump > 0 && square.values[jump - 1] === 1 && square.values[jump] === -1, 'a square wave does not draw its edge');
});

test('a change is described in a line, with the unit where it has one', () => {
    assert.equal(describeIntervention(value(1, 7, 3.14159), 'rad/s'), 'Set to 3.142 rad/s');
    assert.equal(describeIntervention(schedule(1, 7, { mode: 'ramp', baseValue: 0, targetValue: 4, duration: 0.2 }), 'V'), 'Ramp from 0 V to 4 V over 0.2 s');
    assert.equal(describeIntervention(schedule(1, 7, { mode: 'pulse', baseValue: 1, targetValue: 9, duration: 2 })), 'Pulse to 9, back to 1, for 2 s');
    assert.equal(describeIntervention(schedule(1, 7, { mode: 'waveform', baseValue: 3, duration: 2.5, waveform: { shape: 'sine', amplitude: 1.5, frequency: 8, seed: 0 } }), 'm'), 'Sine around 3 m, ±1.5 at 8 Hz for 2.5 s');
    assert.equal(describeIntervention(schedule(1, 7, { mode: 'waveform', baseValue: 0, duration: 0, waveform: { shape: 'noise', amplitude: 2, frequency: 5, seed: 99 } })), 'Noise around 0, ±2, 5 draws per second, seed 99');
    assert.match(describeIntervention({ time: 3, kind: 'restart' }), /Run continued/);
});

test('the parameters a run\'s controls were used on come in the order they were first changed', () => {
    assert.deepEqual(changedParameterIds([value(1, 9, 1), schedule(2, 4, {}), { time: 3, kind: 'restart' }, value(4, 9, 2), value(5, 6, 0)]), [9, 4, 6]);
    assert.deepEqual(changedParameterIds([]), []);
});

test('the entries name each parameter that was changed and carry its series and its changes', () => {
    const parameters = [{ parameterId: 7, name: 'Drive', ownerLabel: 'Pump', unit: 'm/s', ownValue: 1 }, { parameterId: 8, name: 'Idle', ownerLabel: 'Pump', unit: '', ownValue: 2 }];
    const changes = [value(1, 7, 5), { time: 3, kind: 'restart' }, value(4, 7, 9), schedule(5, 99, { targetValue: 3 })];
    const entries = parameterChangeEntries(parameters, changes, 10);
    assert.deepEqual(entries.map((entry) => entry.parameterId), [7, 99], 'a parameter that was not changed has no entry');
    const [drive, unknown] = entries;
    assert.deepEqual([drive.name, drive.ownerLabel, drive.unit, drive.ownValue, drive.endTime], ['Drive', 'Pump', 'm/s', 1, 10]);
    assert.deepEqual(drive.changes.map((change) => change.kind), ['value', 'restart', 'value'], 'a restart belongs to every parameter\'s account');
    near(drive.series.values[drive.series.times.indexOf(2)], 5); near(drive.series.values[drive.series.times.indexOf(3.5) === -1 ? drive.series.times.findIndex((time) => time >= 3.5) : 0], 1, 'after the restart');
    assert.equal(unknown.name, 'Parameter 99', 'a parameter the model no longer has is still shown');
    assert.deepEqual(parameterChangeEntries(parameters, [], 10), []);
    // A run held before its first step has changes already, and a single point to show them at; the axis reaches the whole run.
    const held = parameterChangeEntries(parameters, [value(0, 7, 5)], 0, { axisEnd: 4 });
    assert.deepEqual([held[0].series.times, held[0].series.values, held[0].endTime, held[0].axisEnd], [[0], [5], 0, 4]);
    assert.equal(parameterChangeEntries(parameters, changes, 10, { axisEnd: 4 })[0].axisEnd, 10, 'the axis never ends before the data');
});
