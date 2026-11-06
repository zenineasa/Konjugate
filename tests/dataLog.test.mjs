/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The rules of a Konjugate data log (docs/connectingADataSource.md), one test each, as the reader enforces them. The simulated rig in
// tests/simulatedTankRig.test.mjs shows a whole, growing log; these cover what a rig there does not do, such as a correction.

import assert from 'node:assert/strict';
import test from 'node:test';
import { DataLogError, DataLogReader, readDataLog } from '../src/dataLog.mjs';

const head = [
    '# konjugate data log: 1',
    '# source: Bench rig 2',
    '# time: seconds since 2026-11-06T10:00:00+01:00',
    '# inputs: valveOpen',
    '# outputs: level, flow',
    'time,valveOpen [-],level [m],flow [m^3/s],level quality'
].join('\n');
const log = (...rows) => `${head}\n${rows.join('\n')}\n`;

test('a log says where its time starts, what each signal is, and its unit', () => {
    const { header, observations } = readDataLog(log('0,1,0.50,0.010,'));
    assert.equal(header.source, 'Bench rig 2');
    assert.equal(header.epoch, Date.parse('2026-11-06T09:00:00Z'));
    assert.deepEqual(header.signals, [
        { name: 'valveOpen', unit: '-', role: 'input' },
        { name: 'level', unit: 'm', role: 'output' },
        { name: 'flow', unit: 'm^3/s', role: 'output' }
    ]);
    assert.deepEqual(observations, [
        { time: 0, signal: 'valveOpen', value: 1, quality: 'good', revision: 0 },
        { time: 0, signal: 'level', value: 0.5, quality: 'good', revision: 0 },
        { time: 0, signal: 'flow', value: 0.01, quality: 'good', revision: 0 }
    ]);
});

test('"seconds since start" is a log with no wall-clock anchor', () => {
    const { header } = readDataLog(log('0,1,0.5,0.01,').replace(/# time: .*/, '# time: seconds since start'));
    assert.equal(header.epoch, null);
});

test('an empty cell is no reading, so signals at different rates share one file', () => {
    const { observations } = readDataLog(log('0,1,0.50,,', '1,,0.52,0.011,', '2,0,,,'));
    assert.deepEqual(observations.map((observation) => `${observation.time} ${observation.signal}`), ['0 valveOpen', '0 level', '1 level', '1 flow', '2 valveOpen']);
});

test('a quality marks a reading, and empty is good', () => {
    const { observations } = readDataLog(log('0,,0.50,,uncertain', '1,,9.99,,bad', '2,,0.51,,'));
    assert.deepEqual(observations.map((observation) => observation.quality), ['uncertain', 'bad', 'good']);
    assert.throws(() => readDataLog(log('0,,0.5,,poor')), /"poor" is not a quality/);
    assert.throws(() => readDataLog(log('0,,,,bad')), /level is marked bad but has no reading/);
});

test('a correction repeats the time of the row it corrects, and is kept beside it as a revision', () => {
    const { observations } = readDataLog(log('0,1,0.50,,', '1,,0.90,,', '2,,0.54,,', '1,,0.52,,', '1,,0.53,,'));
    const atOne = observations.filter((observation) => observation.time === 1);
    assert.deepEqual(atOne.map((observation) => [observation.value, observation.revision]), [[0.9, 0], [0.52, 1], [0.53, 2]]);
});

test('rows go forward in time, and a time between two rows is not a correction', () => {
    assert.throws(() => readDataLog(log('0,1,0.5,,', '2,,0.5,,', '1.5,,0.5,,')), (error) => error instanceof DataLogError && error.line === 9 && /earlier than the row before it/.test(error.message));
});

test('a line counts only once its newline has arrived, however the file is cut into pieces', () => {
    const text = log('0,1,0.50,0.010,', '60,,0.52,0.011,', '120,0,0.55,,bad', '60,,0.53,,');
    const whole = readDataLog(text).observations;
    // Every way of cutting the file in two, and a cut every few bytes, must give the same observations as reading it whole.
    for (let cut = 0; cut <= text.length; cut += 1) {
        const reader = new DataLogReader();
        const pieces = [...reader.push(text.slice(0, cut)), ...reader.push(text.slice(cut))];
        reader.end();
        assert.deepEqual(pieces, whole, `cut at ${cut}`);
    }
    const reader = new DataLogReader();
    const seen = [];
    for (let at = 0; at < text.length; at += 7) seen.push(...reader.push(text.slice(at, at + 7)));
    assert.deepEqual(seen, whole);
});

test('bytes are read as UTF-8 even when a character is split between two pieces', () => {
    const text = log('0,1,0.5,,').replace('Bench rig 2', 'Prüfstand 2');
    const bytes = new TextEncoder().encode(text);
    const split = bytes.indexOf(0xc3) + 1; // between the two bytes of ü
    const reader = new DataLogReader();
    reader.push(bytes.slice(0, split));
    reader.push(bytes.slice(split));
    reader.end();
    assert.equal(reader.header.source, 'Prüfstand 2');
});

test('a half-written last line is waited for while the file grows, and refused once it is said to be finished', () => {
    const reader = new DataLogReader();
    assert.equal(reader.push(`${head}\n0,1,0.5`).length, 0);
    assert.throws(() => reader.end(), /no newline at its end/);
});

test('Windows line endings are read the same', () => {
    assert.deepEqual(readDataLog(log('0,1,0.5,,').replaceAll('\n', '\r\n')).observations, readDataLog(log('0,1,0.5,,')).observations);
});

test('a # line after the headings is a note and is skipped', () => {
    assert.equal(readDataLog(log('0,1,0.5,,', '# operator: refilled the tank', '1,,0.4,,')).observations.length, 3);
});

test('what is not a data log is refused with the line and the reason', () => {
    const refused = (text, pattern) => assert.throws(() => readDataLog(text), (error) => error instanceof DataLogError && pattern.test(error.message));
    refused('time,tankTemperature\n0,293\n', /^Line 1: A Konjugate data log starts with/);
    refused(log().replace('data log: 1', 'data log: 2'), /knows version 1 of the format, not "2"/);
    refused(log().replace(/# time: .*\n/, ''), /must say what its time column counts from/);
    refused(log().replace('seconds since 2026-11-06T10:00:00+01:00', 'seconds since 2026-11-06 10:00'), /is not a date and time with its zone/);
    refused(log().replace('time,', 'seconds,'), /first column must be "time"/);
    refused(log().replace('level [m]', 'level'), /"level" is neither "name \[unit\]" nor "name quality"/);
    refused(log().replace('# outputs: level, flow', '# outputs: level'), /"flow" is in neither/);
    refused(log().replace('# outputs: level, flow', '# outputs: level, flow, pressure'), /"pressure" is declared but has no column/);
    refused(log().replace('level quality', 'height quality'), /"height quality" has no "height \[unit\]" column/);
    refused(log('0,1,0.5,'), /The row has 4 cells and the headings have 5/);
    refused(log('0,1,high,,'), /"high" for level is not a number/);
    refused(log(',1,0.5,,'), /"" is not a time/);
});

test('a log with headings and no rows yet is valid and empty, as a logger that has just started', () => {
    const { header, observations } = readDataLog(`${head}\n`);
    assert.equal(header.signals.length, 3);
    assert.deepEqual(observations, []);
});
