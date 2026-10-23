/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { encodeEngineCommand } from '../src/engineProtocol.mjs';
import { parseScheduleText, scheduleError, scheduleModeNumbers, scheduleSummary, scheduleText, waveformPreview, waveformProblem, waveformShapes, waveformValue } from '../src/parameterSchedule.mjs';

test('a schedule is typed or pasted as time and value per line, a header line skipped', () => {
    assert.deepEqual(parseScheduleText('time,price\n0, 1.5\n\n10\t2\n20 2.5\r\n30;3').samples, [[0, 1.5], [10, 2], [20, 2.5], [30, 3]]);
    assert.deepEqual(parseScheduleText(scheduleText([[0, 1], [5, -2e-3]])).samples, [[0, 1], [5, -0.002]]);
    assert.match(parseScheduleText('0, 1\n5, x').error, /Line 2 is not a time and a value/);
    assert.match(parseScheduleText('0, 1\nheader, later').error, /Line 2/, 'only the first line may be a header');
});

test('a schedule is refused for the engine\'s own reasons, and summarised in a line', () => {
    assert.equal(scheduleError({ interpolation: 'hold', samples: [[0, 1], [1, 2]] }), '');
    assert.match(scheduleError({ interpolation: 'cubic', samples: [[0, 1]] }), /Choose how the value goes/);
    assert.match(scheduleError({ interpolation: 'linear', samples: [] }), /at least one sample/);
    assert.match(scheduleError({ interpolation: 'linear', samples: [[0, 1], [0, 2]] }), /times must increase: sample 2/);
    assert.match(scheduleSummary({ interpolation: 'hold', samples: [[0, 1], [10, 3]] }), /2 samples, each value held until the next sample, from t = 0 to 10, values 1 to 3/);
});

// ---- waveforms and the schedule modes the engine is told about ------------------------------------------------------

// The numbers in protocol/engineProtocol.proto are the truth; the JavaScript list is a copy of them for building a
// command, so this reads the .proto and fails the day the two disagree.
test('the schedule modes and waveform shapes carry the numbers the protocol file gives them', async () => {
    const proto = await readFile(new URL('../protocol/engineProtocol.proto', import.meta.url), 'utf8');
    const enumValues = (name, prefix) => Object.fromEntries([...proto.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\n\\}`))[1].matchAll(new RegExp(`${prefix}([A-Z]+) = (\\d+);`, 'g'))]
        .map(([, key, number]) => [key.toLowerCase(), Number(number)]));
    const { unspecified, ...modes } = enumValues('ParameterScheduleMode', 'PARAMETER_SCHEDULE_MODE_');
    assert.deepEqual(scheduleModeNumbers, modes);
    const { unspecified: noShape, ...shapes } = enumValues('WaveformShape', 'WAVEFORM_SHAPE_');
    assert.deepEqual(Object.fromEntries(Object.entries(waveformShapes).map(([name, { number }]) => [name, number])), shapes);
});

test('a waveform is accepted when it is sound and refused with a reason when it is not', () => {
    const sound = { shape: 'sine', amplitude: 2, frequency: 0.5, phaseDegrees: 90, dutyCycle: 0, seed: 0, duration: 0 };
    assert.equal(waveformProblem(sound), null);
    assert.match(waveformProblem({ ...sound, shape: 'wobble' }), /shape/);
    assert.match(waveformProblem({ ...sound, amplitude: -1 }), /amplitude/);
    assert.match(waveformProblem({ ...sound, frequency: Number.NaN }), /frequency/);
    assert.match(waveformProblem({ ...sound, phaseDegrees: Infinity }), /phase/);
    assert.match(waveformProblem({ ...sound, dutyCycle: 1 }), /duty cycle/);
    assert.match(waveformProblem({ ...sound, seed: 1.5 }), /seed/);
    assert.match(waveformProblem({ ...sound, duration: -1 }), /duration/);
    assert.equal(waveformProblem({ ...sound, frequency: 0 }), null, 'A sine at zero frequency is a constant, which is allowed.');
    assert.match(waveformProblem({ ...sound, shape: 'noise', frequency: 0 }), /Noise needs a frequency/);
    assert.equal(waveformProblem({ ...sound, shape: 'square', dutyCycle: 0.25 }), null);
});

// Reads the fields of one Protobuf message: { number: value } for a varint, a double or a nested message's bytes.
function readFields(bytes) {
    const fields = new Map();
    let at = 0;
    const varint = () => { let value = 0; let shift = 1; for (;;) { const byte = bytes[at++]; value += (byte & 0x7f) * shift; if (!(byte & 0x80)) return value; shift *= 128; } };
    while (at < bytes.length) {
        const key = varint();
        const [number, wireType] = [Math.floor(key / 8), key % 8];
        if (wireType === 0) fields.set(number, varint());
        else if (wireType === 1) { fields.set(number, new DataView(bytes.buffer, bytes.byteOffset + at, 8).getFloat64(0, true)); at += 8; }
        else { const length = varint(); fields.set(number, bytes.subarray(at, at + length)); at += length; }
    }
    return fields;
}

test('a waveform command carries its mode, shape and every number that shapes it', () => {
    const frame = encodeEngineCommand(3, {
        type: 'scheduleParameterValue', parameterId: 11, mode: 'waveform', startTime: 2, duration: 5, baseValue: 10,
        waveform: { shape: 'square', amplitude: 1.5, frequency: 4, phaseDegrees: 45, dutyCycle: 0.25, seed: 99 }
    });
    const message = readFields(frame.subarray(4));
    const schedule = readFields(message.get(6));
    assert.deepEqual([...schedule].filter(([number]) => number !== 7),
        [[1, 11], [2, 5], [3, 2], [4, 5], [5, 0], [6, 10], [8, 2], [9, 1.5], [10, 4], [11, 45], [12, 0.25], [13, 99]]);
});

test('a waveform command with something wrong in it is not sent', () => {
    const command = (waveform) => ({ type: 'scheduleParameterValue', parameterId: 11, mode: 'waveform', waveform });
    assert.throws(() => encodeEngineCommand(1, command({ shape: 'sine', amplitude: -1, frequency: 1 })), /amplitude/);
    assert.throws(() => encodeEngineCommand(1, command(undefined)), /shape/);
    assert.throws(() => encodeEngineCommand(1, { type: 'scheduleParameterValue', parameterId: 11, mode: 'wiggle' }), /Unsupported parameter schedule mode/);
});

test('a command that is not a waveform carries none of its fields', () => {
    const frame = encodeEngineCommand(1, { type: 'scheduleParameterValue', parameterId: 11, mode: 'pulse', startTime: 1, duration: 2, targetValue: 3, baseValue: 4 });
    const schedule = readFields(readFields(frame.subarray(4)).get(6));
    assert.deepEqual([...schedule.keys()], [1, 2, 3, 4, 5, 6]);
});

// ---- the preview: the same values the engine's own tests expect (engine/tests/executionPlanTests.cpp) -------------------

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);

test('each shape passes through the points the engine is tested to pass through', () => {
    const wave = (shape, fields = {}) => ({ shape, amplitude: 3, frequency: 0.5, ...fields });  // a 2 s period around 10
    const at = (shape, elapsed, fields) => waveformValue(wave(shape, fields), 10, elapsed);
    near(at('sine', 0), 10); near(at('sine', 0.5), 13); near(at('sine', 1), 10); near(at('sine', 1.5), 7);
    near(at('sine', 0, { phaseDegrees: 90 }), 13);
    near(at('square', 0), 13); near(at('square', 0.99), 13); near(at('square', 1), 7); near(at('square', 1.99), 7);
    near(at('square', 0.4, { dutyCycle: 0.25 }), 13); near(at('square', 0.6, { dutyCycle: 0.25 }), 7);
    near(at('triangle', 0), 10); near(at('triangle', 0.25), 11.5); near(at('triangle', 0.5), 13); near(at('triangle', 1), 10); near(at('triangle', 1.5), 7); near(at('triangle', 2), 10);
    near(at('sawtooth', 0), 10); near(at('sawtooth', 0.5), 11.5); near(at('sawtooth', 1), 7); near(at('sawtooth', 1.5), 8.5); near(at('sawtooth', 2), 10);
});

test('a waveform reads its centre before it starts and after its window ends', () => {
    const sine = { shape: 'sine', amplitude: 3, frequency: 0.5, duration: 1 };
    near(waveformValue(sine, 10, -0.1), 10);
    near(waveformValue(sine, 10, 0.5), 13);
    near(waveformValue(sine, 10, 1), 10);
    near(waveformValue({ ...sine, duration: 0 }, 10, 4004.5), 13);
});

test('noise is held between draws, stays within its bounds, repeats for a seed and differs for another', () => {
    const noise = { shape: 'noise', amplitude: 5, frequency: 10, seed: 42 };
    assert.equal(waveformValue(noise, 100, 0), waveformValue(noise, 100, 0.099));
    assert.notEqual(waveformValue(noise, 100, 0.05), waveformValue(noise, 100, 0.15));
    let sum = 0;
    for (let draw = 0; draw < 5000; draw += 1) {
        const value = waveformValue(noise, 100, draw * 0.1 + 0.05);
        assert.ok(value >= 95 && value < 105);
        sum += value;
    }
    assert.ok(Math.abs(sum / 5000 - 100) < 0.2);
    assert.equal(waveformValue(noise, 100, 123.456), waveformValue({ ...noise }, 100, 123.456));
    assert.notEqual(waveformValue(noise, 100, 123.456), waveformValue({ ...noise, seed: 43 }, 100, 123.456));
    // A seed past 32 bits is a seed, not the same one as its low bits.
    assert.notEqual(waveformValue({ ...noise, seed: 123456789 }, 0, 1), waveformValue({ ...noise, seed: 123456789 + 2 ** 32 }, 0, 1));
});

test('the preview shows a couple of periods, or the duration, or a few dozen draws of noise, and the range it reaches', () => {
    const sine = { shape: 'sine', amplitude: 3, frequency: 0.5 };
    const periods = waveformPreview(sine, 10);
    assert.equal(periods.values.length, 240);
    assert.equal(periods.window, 4);
    assert.deepEqual([periods.low, periods.high], [7, 13]);
    near(periods.values[0], 10);
    // The last point sits a hair inside the end of the window, which is drawn right up to it.
    assert.ok(Math.abs(periods.values.at(-1) - 10) < 1e-6);
    assert.equal(waveformPreview({ ...sine, duration: 3 }, 10).window, 3);
    assert.equal(waveformPreview({ shape: 'noise', amplitude: 1, frequency: 4, seed: 1 }, 0).window, 6);
    assert.equal(waveformPreview({ ...sine, frequency: 0 }, 10).window, 1);
});

test('there is no preview of a waveform that cannot be started', () => {
    assert.equal(waveformPreview({ shape: 'sine', amplitude: -1, frequency: 1 }, 0), null);
    assert.equal(waveformPreview({ shape: 'noise', amplitude: 1, frequency: 0 }, 0), null);
});
