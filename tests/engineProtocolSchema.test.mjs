/* Copyright © 2026 Zenin Easa Panthakkalakath */

// src/engineProtocol.mjs encodes and decodes the engine's protobuf messages by hand, so a mistake there (a wrong field number, a
// wire type, a packed field read as unpacked) fails quietly as wrong numbers rather than an error. These tests hold it to the schema
// itself, protocol/engineProtocol.proto, through protobufjs: every command it encodes is read back by protobufjs, and every event,
// session reply and result file protobufjs writes is read back by it, field for field.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    decodeEngineEvent, decodeResultFile, decodeResultHeaderPayload, decodeResultIndexPayload, decodeSampleBatchPayload, encodeEngineCommand
} from '../src/engineProtocol.mjs';
import { concat, decodeMessage, encodeMessage as encoded, resultFile, uint32BigEndian as uint32 } from './fixtures/engineMessages.mjs';

const json = (value) => Array.from(new TextEncoder().encode(JSON.stringify(value)));

// What protobufjs reads from a command frame (after its 4-byte length).
function readCommand(frame) {
    const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
    assert.equal(length, frame.length - 4, 'The frame starts with its own length.');
    return decodeMessage('EngineCommand', frame.subarray(4));
}

test('every command reads back from the schema as what was sent', () => {
    const cases = [
        [{ type: 'setPacing', pacing: { mode: 'fastest' } }, { setPacing: { mode: 'PACING_MODE_FASTEST', simulationSecondsPerWallSecond: 1 } }],
        [{ type: 'setPacing', pacing: { mode: 'realTime', simulationSecondsPerWallSecond: 7 } }, { setPacing: { mode: 'PACING_MODE_REAL_TIME', simulationSecondsPerWallSecond: 1 } }],
        [{ type: 'setPacing', pacing: { mode: 'limitedRatio', simulationSecondsPerWallSecond: 2.5 } }, { setPacing: { mode: 'PACING_MODE_LIMITED_RATIO', simulationSecondsPerWallSecond: 2.5 } }],
        [{ type: 'setRunState', state: 'stopped' }, { setRunState: { state: 'RUN_STATE_STOPPED' } }],
        [{ type: 'setParameterValue', parameterId: 2 ** 40, value: -3.25 }, { setParameterValue: { parameterId: 2 ** 40, value: -3.25 } }],
        [{ type: 'scheduleParameterValue', parameterId: 9, mode: 'ramp', startTime: 1, duration: 2, targetValue: 3, baseValue: 4 },
            { scheduleParameterValue: { parameterId: 9, mode: 'PARAMETER_SCHEDULE_MODE_RAMP', startTime: 1, duration: 2, targetValue: 3, baseValue: 4 } }],
        [{ type: 'scheduleParameterValue', parameterId: 9, mode: 'piecewise', samples: [{ time: 0, value: 1 }, { time: 5, value: 2 }] },
            { scheduleParameterValue: { parameterId: 9, mode: 'PARAMETER_SCHEDULE_MODE_PIECEWISE', startTime: 0, duration: 0, targetValue: 0, baseValue: 0, samples: [{ time: 0, value: 1 }, { time: 5, value: 2 }] } }],
        [{ type: 'scheduleParameterValue', parameterId: 9, mode: 'waveform', baseValue: 1, waveform: { shape: 'square', amplitude: 2, frequency: 0.5, phaseDegrees: 90, dutyCycle: 0.25, seed: 7 } },
            { scheduleParameterValue: { parameterId: 9, mode: 'PARAMETER_SCHEDULE_MODE_WAVEFORM', startTime: 0, duration: 0, targetValue: 0, baseValue: 1, waveformShape: 'WAVEFORM_SHAPE_SQUARE', amplitude: 2, frequency: 0.5, phaseDegrees: 90, dutyCycle: 0.25, seed: 7 } }],
        [{ type: 'advanceTo', time: 12.5 }, { advanceTo: { time: 12.5 } }],
        [{ type: 'advanceTo', time: 12.5, takeCheckpoints: true }, { advanceTo: { time: 12.5, takeCheckpoints: true } }],
        [{ type: 'appendInputSamples', parameterId: 4, samples: [{ time: 1, value: 10 }, { time: 2, value: 20 }] },
            { appendInputSamples: { parameterId: 4, samples: [{ time: 1, value: 10 }, { time: 2, value: 20 }] } }],
        [{ type: 'appendInputSamples', parameterId: 4, samples: [], replaceFrom: 3 }, { appendInputSamples: { parameterId: 4, replace: true, replaceFrom: 3 } }],
        [{ type: 'restoreCheckpoint', time: 600, overrides: [{ stateId: 2, value: 21.5 }, { stateId: 3, value: -1 }] },
            { restoreCheckpoint: { time: 600, overrides: [{ stateId: 2, value: 21.5 }, { stateId: 3, value: -1 }] } }],
        [{ type: 'restoreState', time: 60, values: [1, 2.5, -3], providerStates: [{ nodeId: 8, payload: new Uint8Array([0, 255, 7]) }] },
            { restoreState: { time: 60, values: [1, 2.5, -3], providerStates: [{ nodeId: 8, payload: [0, 255, 7] }] } }],
        [{ type: 'retainCheckpointsFrom', time: 1200 }, { retainCheckpointsFrom: { time: 1200 } }]
    ];
    cases.forEach(([command, payload], index) => {
        assert.deepEqual(readCommand(encodeEngineCommand(index + 1, command)), { protocolVersion: 1, sequence: index + 1, ...payload }, command.type);
    });
    assert.deepEqual(readCommand(encodeEngineCommand(5, { type: 'advanceTo', time: 1, batch: 3, applyAt: 0.75 })), { protocolVersion: 1, sequence: 5, advanceTo: { time: 1 }, batch: 3, applyAt: 0.75 });
});

test('a command the engine could not carry out is refused before it is sent', () => {
    const refuses = (command, pattern) => assert.throws(() => encodeEngineCommand(1, command), pattern);
    refuses({ type: 'setPacing', pacing: { mode: 'slowest' } }, /Unsupported simulation pacing mode/);
    refuses({ type: 'setPacing', pacing: { mode: 'limitedRatio', simulationSecondsPerWallSecond: 0 } }, /finite positive ratio/);
    refuses({ type: 'setRunState', state: 'sleeping' }, /Unsupported execution state/);
    refuses({ type: 'setParameterValue', parameterId: 3, value: Infinity }, /double must be finite/);
    refuses({ type: 'scheduleParameterValue', parameterId: -1, mode: 'step' }, /positive safe integer/);
    refuses({ type: 'scheduleParameterValue', parameterId: 1, mode: 'zigzag' }, /Unsupported parameter schedule mode/);
    refuses({ type: 'scheduleParameterValue', parameterId: 1, mode: 'piecewise', samples: [{ time: 0, value: 1 }] }, /at least two samples/);
    refuses({ type: 'scheduleParameterValue', parameterId: 1, mode: 'waveform', waveform: { shape: 'noise', amplitude: 1, frequency: 0 } }, /Noise needs a frequency/);
    refuses({ type: 'appendInputSamples', parameterId: 1.5, samples: [] }, /positive safe integer parameter identifier/);
    refuses({ type: 'restoreState', time: 0, values: [1, NaN] }, /state to restore must be finite/);
    refuses({ type: 'restoreCheckpoint', time: 0, overrides: [{ stateId: -2, value: 1 }] }, /non-negative safe integer/);
    refuses({ type: 'explode' }, /Unsupported engine command/);
    const samples = Array.from({ length: 60000 }, (_, index) => ({ time: index, value: index }));
    refuses({ type: 'appendInputSamples', parameterId: 1, samples }, /frame is too large/);
});

test('events written to the schema are read back field for field', () => {
    const event = (payload) => decodeEngineEvent(encoded('EngineEvent', { protocolVersion: 1, ...payload }));
    assert.deepEqual(event({ capabilities: { metisAvailable: true, metisVersion: '5.2', parameterScheduleModes: ['step', 'waveform'], heldCommands: true } }).capabilities,
        { metisAvailable: true, metisVersion: '5.2', parameterScheduleModes: ['step', 'waveform'], heldCommands: true });
    assert.deepEqual(event({ capabilities: {} }).capabilities, { metisAvailable: false, metisVersion: '' }, 'An old engine says nothing of schedules or held commands.');
    assert.deepEqual(event({ stateTable: { states: [{ stateId: 2 }, { stateId: 2 ** 33 }] } }).stateTable, [2, 2 ** 33]);
    assert.deepEqual(event({ sessionInfo: { algebraicStateIds: [3, 300, 2 ** 35] } }).sessionInfo, { algebraicStateIds: [3, 300, 2 ** 35] }, 'Packed, as proto3 writes it.');
    assert.deepEqual(event({ sessionInfo: {} }).sessionInfo, { algebraicStateIds: [] });
    const { providerStates, ...reply } = event({
        sessionReply: { sequence: 41, ok: true, time: 600, values: [20, 5.5], providerStates: [{ nodeId: 8, payload: [1, 2, 3] }], computeNanoseconds: 2 ** 36, checkpointsTaken: 2 }
    }).sessionReply;
    assert.deepEqual(reply, { sequence: 41, ok: true, message: '', time: 600, values: [20, 5.5], computeNanoseconds: 2 ** 36, checkpointsTaken: 2 });
    assert.deepEqual(providerStates.map(({ nodeId, payload }) => ({ nodeId, payload: [...payload] })), [{ nodeId: 8, payload: [1, 2, 3] }], 'A provider\'s saved state stays as bytes.');
    assert.deepEqual(event({ sessionReply: { sequence: 42, message: 'No checkpoint at 5 s.' } }).sessionReply,
        { sequence: 42, ok: false, message: 'No checkpoint at 5 s.', time: 0, values: [], providerStates: [], computeNanoseconds: 0, checkpointsTaken: 0 });
});

test('fields written unpacked, or unknown to this reader, are still read', () => {
    // A repeated varint written one by one (as an older writer may) rather than packed; a reply's single value as a fixed64.
    const info = new Uint8Array([8, 1, 50, 4, 8, 3, 8, 4]);
    assert.deepEqual(decodeEngineEvent(info).sessionInfo, { algebraicStateIds: [3, 4] });
    const value = new Float64Array([2.5]);
    const reply = new Uint8Array([8, 1, 42, 11, 8, 7, 41, ...new Uint8Array(value.buffer)]);
    assert.deepEqual(decodeEngineEvent(reply).sessionReply.values, [2.5]);
    // A fixed32 field this reader does not know is passed over.
    assert.deepEqual(decodeEngineEvent(new Uint8Array([8, 1, 0x7d, 1, 2, 3, 4])), { protocolVersion: 1 });
});

test('malformed protobuf is refused with what is wrong with it', () => {
    assert.throws(() => decodeEngineEvent(new Uint8Array([8, 1, 0x7b])), /Unsupported Protobuf wire type 3/);
    assert.throws(() => decodeEngineEvent(new Uint8Array([8, 1, 0x79, 1, 2])), /Truncated Protobuf fixed64 field/);
    assert.throws(() => decodeEngineEvent(new Uint8Array([8, 1, 0x7d, 1])), /Truncated Protobuf fixed32 field/);
    assert.throws(() => decodeEngineEvent(new Uint8Array([8, 1, 26, 9, 1])), /Truncated Protobuf length-delimited field/);
    assert.throws(() => decodeEngineEvent(new Uint8Array([8, 0x80, 0x80])), /Invalid Protobuf varint/);
    assert.throws(() => decodeEngineEvent(encoded('EngineEvent', { protocolVersion: 1, stateTable: { states: [{ stateId: 0 }] } })), /invalid state identifier/);
    assert.throws(() => decodeEngineEvent(new Uint8Array([8, 1, 34, 3, 10, 1, 0])), /packed double field has an invalid length/);
});

// ---- result files ---------------------------------------------------------------------------------------------------------

const times = (result) => result.samples.map((sample) => sample.time);

test('a result file is read whole: its samples, checkpoints, stability findings and interventions', () => {
    const file = resultFile({
        metadata: { solver: 'euler' },
        header: {
            checkpoints: [{ uuid: 'c-1', time: 3, values: [30, 3], solverKind: 'euler', solverVersion: 2, providerStates: [{ nodeId: 8, payload: [1, 2, 3, 4, 5] }] }],
            stabilityFindings: [{ nodeId: 1, stateId: 2, code: 'oscillation', message: 'It rings.', globalTime: Infinity }],
            interventions: [
                { appliedTime: 1, setValue: { parameterId: 20, value: 0.5 } },
                { appliedTime: 2, schedule: { parameterId: 20, mode: 'PARAMETER_SCHEDULE_MODE_PIECEWISE', samples: [{ time: 0, value: 1 }, { time: 1, value: 2 }] } },
                { appliedTime: 3, schedule: { parameterId: 21, mode: 'PARAMETER_SCHEDULE_MODE_WAVEFORM', baseValue: 1, waveformShape: 'WAVEFORM_SHAPE_TRIANGLE', amplitude: 2, frequency: 0.5, seed: 9 } },
                { appliedTime: 4, schedule: { parameterId: 22, mode: 'PARAMETER_SCHEDULE_MODE_STEP', targetValue: 5 } }
            ]
        }
    });
    const result = decodeResultFile(file);
    assert.equal(result.resultVersion, 2);
    assert.equal(result.solver, 'euler', 'The metadata is spread onto the result.');
    assert.equal(result.sampleCount, 6);
    assert.deepEqual(times(result), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(result.samples[4].states, [{ stateId: 2, value: 40 }, { stateId: 3, value: 4 }]);
    assert.deepEqual(result.checkpoints, [{ uuid: 'c-1', time: 3, solver: { kind: 'euler', version: 2 }, states: [{ stateId: 2, value: 30 }, { stateId: 3, value: 3 }], providerStates: [{ nodeId: 8, payload: 'AQIDBAU=' }] }]);
    assert.deepEqual(result.stabilityFindings, [{ nodeId: 1, stateId: 2, code: 'oscillation', message: 'It rings.', globalTime: Infinity }]);
    assert.deepEqual(result.interventions, [
        { time: 1, kind: 'value', parameterId: 20, value: 0.5 },
        { time: 2, kind: 'schedule', parameterId: 20, mode: 'piecewise', startTime: 0, duration: 0, targetValue: 0, baseValue: 0, samples: [{ time: 0, value: 1 }, { time: 1, value: 2 }] },
        { time: 3, kind: 'schedule', parameterId: 21, mode: 'waveform', startTime: 0, duration: 0, targetValue: 0, baseValue: 1, waveform: { shape: 'triangle', amplitude: 2, frequency: 0.5, phaseDegrees: 0, dutyCycle: 0, seed: 9 } },
        { time: 4, kind: 'schedule', parameterId: 22, mode: 'step', startTime: 0, duration: 0, targetValue: 5, baseValue: 0 }
    ]);
});

test('a provider\'s saved state is base64, padded as the standard has it, whatever its length', () => {
    for (let length = 0; length <= 7; length += 1) {
        const payload = Array.from({ length }, (_, index) => (index * 97 + 13) % 256);
        const result = decodeResultFile(resultFile({ header: { checkpoints: [{ time: 0, values: [0, 0], providerStates: [{ nodeId: 1, payload }] }] } }));
        assert.equal(result.checkpoints[0].providerStates[0].payload, Buffer.from(payload).toString('base64'), `${length} bytes`);
    }
});

test('a result is read in part: a time range, thinned to a number of samples, or the batch nearest a time', () => {
    const file = resultFile({ batches: [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]] });
    assert.deepEqual(times(decodeResultFile(file, { startTime: 3, endTime: 6 })), [3, 4, 5, 6]);
    assert.deepEqual(times(decodeResultFile(file, { maximumSamples: 4 })), [0, 3, 6, 9, 11], 'Every third, and always the last.');
    assert.deepEqual(times(decodeResultFile(file, { nearestTime: 5.5 })), [4, 5, 6, 7], 'The batch that holds it.');
    assert.deepEqual(times(decodeResultFile(file, { nearestTime: 100 })), [8, 9, 10, 11], 'Past the end, the last batch.');
    assert.deepEqual(times(decodeResultFile(file, { nearestTime: -100 })), [0, 1, 2, 3]);
    assert.equal(decodeResultFile(file, { startTime: 20 }).samples.length, 0);
});

test('a result file whose parts disagree is refused', () => {
    assert.throws(() => decodeResultFile(resultFile({ version: 1 })), /Unsupported KJR result version 1/);
    assert.throws(() => decodeResultFile(resultFile({ tamper: (index) => ({ ...index, sampleCount: index.sampleCount + 1 }) })), /sample index is incomplete/);
    assert.throws(() => decodeResultFile(resultFile({ tamper: (index) => ({ ...index, batches: index.batches.map((entry, position) => (position ? { ...entry, offset: entry.offset + 1 } : entry)) }) })), /batch index is invalid/);
    assert.throws(() => decodeResultFile(resultFile({ tamper: (index) => ({ ...index, batches: index.batches.slice(0, 1), sampleCount: 3 }) })), /sample index is incomplete/, 'A batch left out of the index.');
    assert.throws(() => decodeResultFile(resultFile({ tamper: (index) => ({ ...index, batches: index.batches.map((entry) => ({ ...entry, startTime: entry.startTime + 0.5 })) }) })), /inconsistent with its index/);
    assert.throws(() => decodeResultFile(resultFile({ header: { checkpoints: [{ time: 0, values: [1] }] } })), /inconsistent state vector/);
    const file = resultFile();
    const shortened = concat(file.subarray(0, file.length - 8), uint32(file.length), new TextEncoder().encode('KJIX'));
    assert.throws(() => decodeResultFile(shortened), /section lengths are invalid/);
});

test('a result\'s header, index and batches can be read one at a time, for a reader that seeks', () => {
    const header = decodeResultHeaderPayload(encoded('ResultFile', {
        resultVersion: 2, metadataJson: json({ resultVersion: 2 }), stateTable: { states: [{ stateId: 2 }, { stateId: 3 }] },
        checkpoints: [{ uuid: 'c', time: 1, values: [1, 2], solverKind: 'rk4', solverVersion: 1, providerStates: [{ nodeId: 4, payload: [255] }] }]
    }));
    assert.deepEqual(header, {
        resultVersion: 2, metadata: { resultVersion: 2 }, stateIds: [2, 3],
        checkpoints: [{ uuid: 'c', time: 1, values: [1, 2], solver: { kind: 'rk4', version: 1 }, providerStates: [{ nodeId: 4, payload: '/w==' }] }]
    });
    assert.deepEqual(decodeResultIndexPayload(encoded('ResultIndex', { resultVersion: 2, sampleCount: 3, batches: [{ startTime: 0, endTime: 2, offset: 40, length: 70, sampleCount: 3 }] })),
        { resultVersion: 2, sampleCount: 3, batches: [{ startTime: 0, endTime: 2, offset: 40, length: 70, sampleCount: 3 }] });
    const batch = encoded('SampleBatch', { times: [0, 1], stateCount: 2, values: [1, 2, 3, 4] });
    assert.deepEqual(decodeSampleBatchPayload(batch, [2, 3]), [
        { time: 0, states: [{ stateId: 2, value: 1 }, { stateId: 3, value: 2 }] },
        { time: 1, states: [{ stateId: 2, value: 3 }, { stateId: 3, value: 4 }] }
    ]);
    assert.throws(() => decodeSampleBatchPayload(batch, [2]), /inconsistent dimensions/);
});
