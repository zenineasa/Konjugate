/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeEngineEvent, FramedEngineEventDecoder } from '../src/engineProtocol.mjs';

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

function stateTable(ids) {
    const table = Buffer.concat(ids.map((id) => bytesField(1, bytesField(1, Buffer.from(id)))));
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
    assert.deepEqual(decodeEngineEvent(stateTable(['state-a', 'state-b'])).stateTable, ['state-a', 'state-b']);
    assert.deepEqual(decodeEngineEvent(sampleBatch([0, 0.1], [1, 2, 3, 4], 2)).sampleBatch, {
        times: [0, 0.1], stateCount: 2, values: [1, 2, 3, 4]
    });
});

test('decodes fragmented and combined length-prefixed frames', () => {
    const messages = [stateTable(['state-a']), sampleBatch([0], [42], 1)];
    const framed = Buffer.concat(messages.map((message) => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(message.length);
        return Buffer.concat([header, message]);
    }));
    const decoder = new FramedEngineEventDecoder();
    assert.deepEqual(decoder.append(framed.subarray(0, 7)), []);
    const events = decoder.append(framed.subarray(7));
    assert.equal(events.length, 2);
    assert.deepEqual(events[0].stateTable, ['state-a']);
    assert.deepEqual(events[1].sampleBatch.values, [42]);
});

test('rejects unsupported versions and oversized frames', () => {
    assert.throws(() => decodeEngineEvent(Buffer.from([8, 2])), /Unsupported engine protocol version/);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(64 * 1024 * 1024 + 1);
    assert.throws(() => new FramedEngineEventDecoder().append(oversized), /too large/);
});
