/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The engine's protobuf messages and KJR result files, written through protobufjs from protocol/engineProtocol.proto itself, for
// tests that read them back through src/engineProtocol.mjs (or anything built on it) and for fakes that answer as the engine does.

import { join } from 'node:path';
import protobuf from 'protobufjs';

const root = protobuf.loadSync(join(import.meta.dirname, '..', '..', 'protocol', 'engineProtocol.proto'));

export const messageType = (name) => root.lookupType(`konjugate.protocol.${name}`);

// A message as protobufjs encodes it, from a plain object (camelCase field names, enums by name).
export const encodeMessage = (name, object) => messageType(name).encode(messageType(name).fromObject(object)).finish();

// A message protobufjs decodes, as a plain object (longs as numbers, enums by name, bytes as arrays, unset fields left out).
export const decodeMessage = (name, bytes) => messageType(name).toObject(messageType(name).decode(bytes), { longs: Number, enums: String, bytes: Array, defaults: false });

const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
};
export const uint32BigEndian = (value) => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, false); return bytes; };
const jsonBytes = (value) => Array.from(new TextEncoder().encode(JSON.stringify(value)));

// An engine event as the engine frames it on its event stream: its length, then the EngineEvent.
export const framedEvent = (payload) => {
    const message = encodeMessage('EngineEvent', { protocolVersion: 1, ...payload });
    return concat(uint32BigEndian(message.length), message);
};

// A KJR v2 file as the engine writes it: magic, the header's length and the header (ResultFile), each sample batch with its length,
// then the index (ResultIndex), its length and the footer. `batches` are lists of times; each sample's values are `values(time)`, one
// per state. `metadata` is spread into the header's JSON (resultVersion is always there); `tamper` may change the index before it is
// written, to make a file whose parts disagree.
export function resultFile({ stateIds = [2, 3], batches = [[0, 1, 2], [3, 4, 5]], values = (time) => [10 * time, time], metadata = {}, header = {}, version = 2, tamper = (index) => index } = {}) {
    const headerBytes = encodeMessage('ResultFile', {
        resultVersion: version, metadataJson: jsonBytes({ resultVersion: version, ...metadata }), stateTable: { states: stateIds.map((stateId) => ({ stateId })) }, ...header
    });
    let offset = 8 + headerBytes.length;
    const sections = [];
    const entries = [];
    for (const times of batches) {
        const batch = encodeMessage('SampleBatch', { times, stateCount: stateIds.length, values: times.flatMap(values) });
        sections.push(uint32BigEndian(batch.length), batch);
        entries.push({ startTime: times[0], endTime: times.at(-1), offset, length: batch.length, sampleCount: times.length });
        offset += 4 + batch.length;
    }
    const index = encodeMessage('ResultIndex', tamper({ resultVersion: version, sampleCount: batches.flat().length, batches: entries }));
    return concat(new Uint8Array([0x4b, 0x4a, 0x52, 0x02]), uint32BigEndian(headerBytes.length), headerBytes, ...sections, index, uint32BigEndian(index.length), new TextEncoder().encode('KJIX'));
}

export { concat };
