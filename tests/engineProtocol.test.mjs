/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeEngineEvent, decodeResultFile, encodeEngineCommand, FramedEngineEventDecoder } from '../src/engineProtocol.mjs';

function varint(value) {
    const bytes = [];
    do {
        const next = value & 0x7f;
        value = Math.floor(value / 128);
        bytes.push(next | (value ? 0x80 : 0));
    } while (value);
    return Buffer.from(bytes);
}

function bytesField(number, value) {
    return Buffer.concat([varint(number * 8 + 2), varint(value.length), value]);
}

function varintField(number, value) {
    return Buffer.concat([varint(number * 8), varint(value)]);
}

function stateTable(ids) {
    const table = Buffer.concat(ids.map((id) => bytesField(1, varintField(1, id))));
    return Buffer.concat([Buffer.from([8, 1]), bytesField(3, table)]);
}

function sampleBatch(times, values, stateCount) {
    const doubleBuffer = (items) => {
        const result = Buffer.alloc(items.length * 8);
        items.forEach((value, index) => result.writeDoubleLE(value, index * 8));
        return result;
    };
    const batch = Buffer.concat([
        bytesField(1, doubleBuffer(times)),
        Buffer.from([16]), varint(stateCount),
        bytesField(3, doubleBuffer(values))
    ]);
    return Buffer.concat([Buffer.from([8, 1]), bytesField(4, batch)]);
}

test('decodes stable state tables and packed sample values', () => {
    assert.deepEqual(decodeEngineEvent(stateTable([11, 12])).stateTable, [11, 12]);
    assert.deepEqual(decodeEngineEvent(sampleBatch([0, 0.1], [1, 2, 3, 4], 2)).sampleBatch, {
        times: [0, 0.1], stateCount: 2, values: [1, 2, 3, 4]
    });
});

test('decodes packed numerical arrays beyond the JavaScript argument limit', () => {
    const times = Array.from({ length: 70000 }, (_value, index) => index * 0.1);
    const values = times.flatMap((time) => [time, time * 2]);
    const decoded = decodeEngineEvent(sampleBatch(times, values, 2)).sampleBatch;
    assert.equal(decoded.times.length, times.length);
    assert.equal(decoded.values.length, values.length);
    assert.equal(decoded.times.at(-1), times.at(-1));
    assert.equal(decoded.values.at(-1), values.at(-1));
});

test('decodes fragmented and combined length-prefixed frames', () => {
    const messages = [stateTable([11]), sampleBatch([0], [42], 1)];
    const framed = Buffer.concat(messages.map((message) => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(message.length);
        return Buffer.concat([header, message]);
    }));
    const decoder = new FramedEngineEventDecoder();
    assert.deepEqual(decoder.append(framed.subarray(0, 7)), []);
    const events = decoder.append(framed.subarray(7));
    assert.equal(events.length, 2);
    assert.deepEqual(events[0].stateTable, [11]);
    assert.deepEqual(events[1].sampleBatch.values, [42]);
});

test('rejects unsupported versions and oversized frames', () => {
    assert.throws(() => decodeEngineEvent(Buffer.from([8, 2])), /Unsupported engine protocol version/);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(64 * 1024 * 1024 + 1);
    assert.throws(() => new FramedEngineEventDecoder().append(oversized), /too large/);
});

test('encodes ordered framed engine commands without JSON conversion', () => {
    assert.equal(encodeEngineCommand(1, { type: 'setRunState', state: 'paused' }).toString('hex'),
        '000000080801100122020802');
    const parameter = encodeEngineCommand(2, { type: 'setParameterValue', parameterId: 11, value: 2 });
    assert.equal(parameter.readUInt32BE(0), parameter.length - 4);
    assert.equal(parameter.subarray(4).toString('hex'), '080110022a0b080b110000000000000040');
    assert.throws(() => encodeEngineCommand(0, { type: 'setRunState', state: 'running' }), /sequences/);
    assert.throws(() => encodeEngineCommand(1, { type: 'setParameterValue', parameterId: 0, value: 1 }), /identifier/);
});

test('rejects legacy JSON and truncated binary result containers', () => {
    assert.throws(() => decodeResultFile(Buffer.from('{}')), /Unsupported KJR/);
    const truncated = Buffer.from([0x4b, 0x4a, 0x52, 0x01, 0, 0, 0, 4, 8, 1]);
    assert.throws(() => decodeResultFile(truncated), /payload length/);
});
