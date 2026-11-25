/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPortValue, portsTable, unboundInputSentence } from '../src/providerEditor/portsTable.mjs';

// The engine's description of a PID controller (describeProgram), as tests/engine/programDescription.mjs has it answer.
const pid = {
    ok: true, program: 'PidController', kind: 'node', language: 'python',
    inputs: [
        { key: 'measurement', kind: 'input', unit: 'K', line: 12 },
        { key: 'setpoint', kind: 'parameter', unit: 'K', line: 13 },
        { key: 'kp', kind: 'constant', unit: 'W/K', line: 14 },
        { key: 'sensorNoise', kind: 'constant', unit: 'K', default: 0, line: 18 }
    ],
    outputs: [{ key: 'power', unit: 'W', line: 19 }],
    memory: [{ name: 'integral', type: 'real', count: 1, unit: 'K*s', start: [0], line: 23 }, { name: 'noise', type: 'random', count: 1, unit: '', start: null, line: 26 }],
    clock: { period: 0.01, constant: null, line: 21 },
    problems: []
};

test('each port beside what it is bound to, with its value now and the conversion at the port', () => {
    const { rows, described } = portsTable(pid, {
        bindings: [
            { key: 'measurement', label: 'Room · Temperature', unit: '°C', value: 20 },
            { key: 'setpoint', label: 'Setpoint', unit: 'K', value: 293.15 },
            { key: 'kp', label: 'Kp', unit: 'm', value: 50 }
        ],
        outputs: [{ key: 'power', label: 'Heater · Power', unit: 'W', rate: false }]
    });
    assert.equal(described, true);
    const row = (key) => rows.find((candidate) => candidate.key === key);
    assert.deepEqual(row('measurement'), { group: 'input', tag: 'IN', key: 'measurement', unit: 'K', bound: 'Room · Temperature', value: 20, line: 12, note: '°C → K at the port', state: 'ok', choice: null });
    assert.equal(row('setpoint').tag, 'PAR');
    assert.equal(row('setpoint').note, '', 'Nothing is converted between equal units.');
    assert.equal(row('kp').state, 'problem', 'An incompatible unit is shown, with the reason.');
    assert.match(row('kp').note, /^Units do not match: m and W\/K measure different kinds of quantity/);
    assert.equal(row('sensorNoise').note, 'not bound: its default');
    assert.equal(row('sensorNoise').value, 0);
    assert.deepEqual(row('power'), { group: 'output', tag: 'OUT', key: 'power', unit: 'W', bound: 'Heater · Power', value: null, line: 19, part: 'a value', note: '', state: 'ok' });
    assert.deepEqual(rows.filter((candidate) => candidate.group === 'memory').map((candidate) => [candidate.key, candidate.value, candidate.unit]), [['integral', 0, 'K*s'], ['noise', null, '']]);
    assert.equal(row('every 0.01 s').group, 'clock');
    assert.deepEqual(rows.map((candidate) => candidate.group), ['input', 'input', 'input', 'input', 'output', 'memory', 'memory', 'clock'], 'In declaration order.');
});

test('a port bound to nothing with no default says so in the run\'s words; an output reaching no state too', () => {
    const { rows } = portsTable(pid, { bindings: [{ key: 'measurement', label: '', unit: null, value: null }], outputs: [] });
    const measurement = rows.find((row) => row.key === 'measurement');
    assert.equal(measurement.state, 'problem');
    assert.equal(measurement.note, unboundInputSentence('measurement'));
    assert.equal(measurement.note, 'Input ‘measurement’ is not bound to anything and has no default.');
    assert.equal(rows.find((row) => row.key === 'power').state, 'problem');
});

test('an output into a Rate state takes its unit per second; a binding to a key the program no longer declares stays in sight', () => {
    const { rows } = portsTable(
        { ...pid, inputs: [{ key: 'level', kind: 'input', unit: 'm', line: 3 }], outputs: [{ key: 'levelRate', unit: 'm/s', line: 4 }], memory: [], clock: null },
        {
            bindings: [{ key: 'level', label: 'Tank · level', unit: 'cm', value: 120 }, { key: 'flow', label: 'Pipe · flow', unit: 'm3/s', value: 1 }],
            outputs: [{ key: 'levelRate', label: 'Tank · level', unit: 'cm', rate: true }, { key: 'old', label: 'Tank · spare', unit: '', rate: true }]
        });
    assert.equal(rows.find((row) => row.key === 'level').note, 'cm → m at the port');
    const levelRate = rows.find((row) => row.key === 'levelRate');
    assert.equal(levelRate.note, 'm/s → cm/s at the port');
    assert.equal(levelRate.part, 'a rate');
    const stale = rows.filter((row) => row.state === 'stale');
    assert.deepEqual(stale.map((row) => [row.tag, row.key, row.bound, row.note]), [
        ['IN', 'flow', 'Pipe · flow', 'not a port of this program'], ['OUT', 'old', 'Tank · spare', 'not a port of this program']]);
});

test('an older program, or one with no description: its bindings only, without units', () => {
    const { rows, described } = portsTable(null, {
        bindings: [{ key: 'hot', label: 'Wall · T', unit: 'K', value: 300 }, { key: 'cold', label: '', unit: null, value: null }],
        outputs: [{ key: 'flow', label: 'Room · T', unit: 'K', rate: true }]
    });
    assert.equal(described, false);
    assert.deepEqual(rows.map((row) => [row.tag, row.key, row.unit, row.bound, row.state]), [
        ['IN', 'hot', '', 'Wall · T', 'ok'], ['IN', 'cold', '', null, 'problem'], ['OUT', 'flow', '', 'Room · T', 'ok']]);
});

test('values as the panel shows them', () => {
    assert.equal(formatPortValue(293.149999999), '293.15');
    assert.equal(formatPortValue([1, 2, 3, 4]), '1, 2, 3, …');
    assert.equal(formatPortValue(null), '');
    assert.equal(formatPortValue(true), 'true');
});
