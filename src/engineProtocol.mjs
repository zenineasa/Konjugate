/* Copyright © 2026 Zenin Easa Panthakkalakath */

function readVarint(buffer, offset) {
    let value = 0;
    let shift = 0;
    while (offset < buffer.length && shift <= 49) {
        const byte = buffer[offset++];
        value += (byte & 0x7f) * 2 ** shift;
        if (!(byte & 0x80)) return { value, offset };
        shift += 7;
    }
    throw new Error('Invalid Protobuf varint.');
}

function encodeVarint(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('A Protobuf varint must be a non-negative safe integer.');
    const bytes = [];
    do {
        const byte = value % 128;
        value = Math.floor(value / 128);
        bytes.push(byte | (value ? 0x80 : 0));
    } while (value);
    return Buffer.from(bytes);
}

function encodedField(number, wireType, payload) {
    return Buffer.concat([encodeVarint(number * 8 + wireType), payload]);
}

function encodedMessageField(number, payload) {
    return encodedField(number, 2, Buffer.concat([encodeVarint(payload.length), payload]));
}

function encodedDoubleField(number, value) {
    if (!Number.isFinite(value)) throw new Error('A Protobuf double must be finite.');
    const payload = Buffer.allocUnsafe(8);
    payload.writeDoubleLE(value);
    return encodedField(number, 1, payload);
}

export function encodeEngineCommand(sequence, command) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error('Engine command sequences must be positive safe integers.');
    let payload;
    let payloadField;
    if (command.type === 'setPacing') {
        const modes = { fastest: 1, realTime: 2, limitedRatio: 3 };
        const mode = modes[command.pacing?.mode];
        if (!mode) throw new Error('Unsupported simulation pacing mode.');
        const ratio = command.pacing.mode === 'realTime' ? 1 : Number(command.pacing.simulationSecondsPerWallSecond ?? 1);
        if (!(ratio > 0) || !Number.isFinite(ratio)) throw new Error('Simulation pacing requires a finite positive ratio.');
        payload = Buffer.concat([
            encodedField(1, 0, encodeVarint(mode)),
            encodedDoubleField(2, ratio)
        ]);
        payloadField = 3;
    } else if (command.type === 'setRunState') {
        const states = { running: 1, paused: 2, stopped: 3 };
        const state = states[command.state];
        if (!state) throw new Error('Unsupported execution state.');
        payload = encodedField(1, 0, encodeVarint(state));
        payloadField = 4;
    } else if (command.type === 'setParameterValue') {
        if (!Number.isSafeInteger(command.parameterId) || command.parameterId <= 0) {
            throw new Error('A live parameter requires a positive safe integer identifier.');
        }
        payload = Buffer.concat([
            encodedField(1, 0, encodeVarint(command.parameterId)),
            encodedDoubleField(2, Number(command.value))
        ]);
        payloadField = 5;
    } else {
        throw new Error('Unsupported engine command.');
    }
    const message = Buffer.concat([
        encodedField(1, 0, encodeVarint(1)),
        encodedField(2, 0, encodeVarint(sequence)),
        encodedMessageField(payloadField, payload)
    ]);
    if (message.length > 1024 * 1024) throw new Error('The engine command frame is too large.');
    const frame = Buffer.allocUnsafe(message.length + 4);
    frame.writeUInt32BE(message.length);
    message.copy(frame, 4);
    return frame;
}

function fields(buffer) {
    const result = [];
    let offset = 0;
    while (offset < buffer.length) {
        const key = readVarint(buffer, offset);
        offset = key.offset;
        const number = Math.floor(key.value / 8);
        const wireType = key.value % 8;
        if (wireType === 0) {
            const item = readVarint(buffer, offset);
            offset = item.offset;
            result.push({ number, wireType, value: item.value });
        } else if (wireType === 1) {
            if (offset + 8 > buffer.length) throw new Error('Truncated Protobuf fixed64 field.');
            result.push({ number, wireType, value: buffer.subarray(offset, offset + 8) });
            offset += 8;
        } else if (wireType === 2) {
            const length = readVarint(buffer, offset);
            offset = length.offset;
            if (offset + length.value > buffer.length) throw new Error('Truncated Protobuf length-delimited field.');
            result.push({ number, wireType, value: buffer.subarray(offset, offset + length.value) });
            offset += length.value;
        } else if (wireType === 5) {
            if (offset + 4 > buffer.length) throw new Error('Truncated Protobuf fixed32 field.');
            result.push({ number, wireType, value: buffer.subarray(offset, offset + 4) });
            offset += 4;
        } else {
            throw new Error(`Unsupported Protobuf wire type ${wireType}.`);
        }
    }
    return result;
}

function packedDoubles(buffer) {
    if (buffer.length % 8) throw new Error('A packed double field has an invalid length.');
    const values = [];
    for (let offset = 0; offset < buffer.length; offset += 8) values.push(buffer.readDoubleLE(offset));
    return values;
}

function decodedStateTable(buffer) {
    return fields(buffer).filter((item) => item.number === 1 && item.wireType === 2).map((item) => {
        const identifier = fields(item.value).find((value) => value.number === 1 && value.wireType === 0);
        if (!Number.isSafeInteger(identifier?.value) || identifier.value <= 0) {
            throw new Error('The engine returned an invalid state identifier.');
        }
        return identifier.value;
    });
}

function decodedSampleBatch(buffer) {
    const batch = { times: [], stateCount: 0, values: [] };
    for (const item of fields(buffer)) {
        if (item.number === 1 && item.wireType === 2) batch.times = batch.times.concat(packedDoubles(item.value));
        else if (item.number === 2 && item.wireType === 0) batch.stateCount = item.value;
        else if (item.number === 3 && item.wireType === 2) batch.values = batch.values.concat(packedDoubles(item.value));
    }
    return batch;
}

export function decodeResultIndexPayload(buffer) {
    const index = { resultVersion: 0, sampleCount: 0, batches: [] };
    for (const field of fields(buffer)) {
        if (field.number === 1 && field.wireType === 0) index.resultVersion = field.value;
        else if (field.number === 2 && field.wireType === 0) index.sampleCount = field.value;
        else if (field.number === 3 && field.wireType === 2) {
            const entry = { startTime: 0, endTime: 0, offset: 0, length: 0, sampleCount: 0 };
            for (const item of fields(field.value)) {
                if (item.number === 1 && item.wireType === 1) entry.startTime = item.value.readDoubleLE();
                else if (item.number === 2 && item.wireType === 1) entry.endTime = item.value.readDoubleLE();
                else if (item.number === 3 && item.wireType === 0) entry.offset = item.value;
                else if (item.number === 4 && item.wireType === 0) entry.length = item.value;
                else if (item.number === 5 && item.wireType === 0) entry.sampleCount = item.value;
            }
            index.batches.push(entry);
        }
    }
    return index;
}

export function decodeResultHeaderPayload(buffer) {
    const header = { resultVersion: 0, metadata: null, stateIds: [], checkpoints: [] };
    for (const field of fields(buffer)) {
        if (field.number === 1 && field.wireType === 0) header.resultVersion = field.value;
        else if (field.number === 2 && field.wireType === 2) header.metadata = JSON.parse(field.value.toString('utf8'));
        else if (field.number === 3 && field.wireType === 2) header.stateIds = decodedStateTable(field.value);
        else if (field.number === 5 && field.wireType === 2) {
            const checkpoint = { uuid: '', time: 0, values: [], solver: { kind: '', version: 0 }, providerStates: [] };
            for (const item of fields(field.value)) {
                if (item.number === 1 && item.wireType === 2) checkpoint.uuid = item.value.toString('utf8');
                else if (item.number === 2 && item.wireType === 1) checkpoint.time = item.value.readDoubleLE();
                else if (item.number === 3 && item.wireType === 2) checkpoint.values = checkpoint.values.concat(packedDoubles(item.value));
                else if (item.number === 4 && item.wireType === 2) checkpoint.solver.kind = item.value.toString('utf8');
                else if (item.number === 5 && item.wireType === 0) checkpoint.solver.version = item.value;
                else if (item.number === 6 && item.wireType === 2) {
                    // Base64, not a raw Buffer: this shape is meant to be reused verbatim as a
                    // startCheckpoint.providerStates entry on restart (mirroring how a decoded
                    // checkpoint's `values` already matches startCheckpoint.states' shape), and
                    // a restart configuration is plain JSON with no native bytes type.
                    let nodeId = 0;
                    let payload = '';
                    for (const providerItem of fields(item.value)) {
                        if (providerItem.number === 1 && providerItem.wireType === 0) nodeId = providerItem.value;
                        else if (providerItem.number === 2 && providerItem.wireType === 2) payload = Buffer.from(providerItem.value).toString('base64');
                    }
                    checkpoint.providerStates.push({ nodeId, payload });
                }
            }
            header.checkpoints.push(checkpoint);
        }
    }
    return header;
}

export function decodeSampleBatchPayload(buffer, stateIds) {
    const batch = decodedSampleBatch(buffer);
    if (batch.stateCount !== stateIds.length || batch.values.length !== batch.times.length * stateIds.length) {
        throw new Error('A KJR sample batch has inconsistent dimensions.');
    }
    return batch.times.map((time, sampleIndex) => ({
        time,
        states: stateIds.map((stateId, stateIndex) => ({
            stateId,
            value: batch.values[sampleIndex * stateIds.length + stateIndex]
        }))
    }));
}

export function decodeResultFile(buffer, { startTime = -Infinity, endTime = Infinity, maximumSamples = Infinity, nearestTime = null } = {}) {
    if (buffer.length < 16 || !buffer.subarray(0, 4).equals(Buffer.from([0x4b, 0x4a, 0x52, 0x02]))) {
        throw new Error('Unsupported KJR result format.');
    }
    if (!buffer.subarray(-4).equals(Buffer.from('KJIX'))) throw new Error('The KJR result index footer is missing.');
    const headerLength = buffer.readUInt32BE(4);
    const headerEnd = 8 + headerLength;
    const indexLength = buffer.readUInt32BE(buffer.length - 8);
    const indexStart = buffer.length - 8 - indexLength;
    if (headerEnd > indexStart) throw new Error('The KJR result section lengths are invalid.');
    let resultVersion = 0;
    let metadata = null;
    let stateIds = [];
    const checkpoints = [];
    for (const field of fields(buffer.subarray(8, headerEnd))) {
        if (field.number === 1 && field.wireType === 0) resultVersion = field.value;
        else if (field.number === 2 && field.wireType === 2) metadata = JSON.parse(field.value.toString('utf8'));
        else if (field.number === 3 && field.wireType === 2) stateIds = decodedStateTable(field.value);
        else if (field.number === 5 && field.wireType === 2) {
            const checkpoint = { uuid: '', time: 0, values: [], solver: { kind: '', version: 0 }, providerStates: [] };
            for (const item of fields(field.value)) {
                if (item.number === 1 && item.wireType === 2) checkpoint.uuid = item.value.toString('utf8');
                else if (item.number === 2 && item.wireType === 1) checkpoint.time = item.value.readDoubleLE();
                else if (item.number === 3 && item.wireType === 2) checkpoint.values = checkpoint.values.concat(packedDoubles(item.value));
                else if (item.number === 4 && item.wireType === 2) checkpoint.solver.kind = item.value.toString('utf8');
                else if (item.number === 5 && item.wireType === 0) checkpoint.solver.version = item.value;
                else if (item.number === 6 && item.wireType === 2) {
                    // Base64, not a raw Buffer: this shape is meant to be reused verbatim as a
                    // startCheckpoint.providerStates entry on restart (mirroring how a decoded
                    // checkpoint's `values` already matches startCheckpoint.states' shape), and
                    // a restart configuration is plain JSON with no native bytes type.
                    let nodeId = 0;
                    let payload = '';
                    for (const providerItem of fields(item.value)) {
                        if (providerItem.number === 1 && providerItem.wireType === 0) nodeId = providerItem.value;
                        else if (providerItem.number === 2 && providerItem.wireType === 2) payload = Buffer.from(providerItem.value).toString('base64');
                    }
                    checkpoint.providerStates.push({ nodeId, payload });
                }
            }
            checkpoints.push(checkpoint);
        }
    }
    let indexVersion = 0;
    let sampleCount = 0;
    const batches = [];
    for (const field of fields(buffer.subarray(indexStart, buffer.length - 8))) {
        if (field.number === 1 && field.wireType === 0) indexVersion = field.value;
        else if (field.number === 2 && field.wireType === 0) sampleCount = field.value;
        else if (field.number === 3 && field.wireType === 2) {
            const entry = { startTime: 0, endTime: 0, offset: 0, length: 0, sampleCount: 0 };
            for (const item of fields(field.value)) {
                if (item.number === 1 && item.wireType === 1) entry.startTime = item.value.readDoubleLE();
                else if (item.number === 2 && item.wireType === 1) entry.endTime = item.value.readDoubleLE();
                else if (item.number === 3 && item.wireType === 0) entry.offset = item.value;
                else if (item.number === 4 && item.wireType === 0) entry.length = item.value;
                else if (item.number === 5 && item.wireType === 0) entry.sampleCount = item.value;
            }
            batches.push(entry);
        }
    }
    if (resultVersion !== 2 || indexVersion !== 2 || metadata?.resultVersion !== 2) {
        throw new Error(`Unsupported KJR result version ${resultVersion}.`);
    }
    let expectedOffset = headerEnd;
    for (const entry of batches) {
        if (entry.offset !== expectedOffset || entry.offset + 4 + entry.length > indexStart ||
            buffer.readUInt32BE(entry.offset) !== entry.length) throw new Error('The KJR result batch index is invalid.');
        expectedOffset = entry.offset + 4 + entry.length;
    }
    if (expectedOffset !== indexStart || batches.reduce((total, entry) => total + entry.sampleCount, 0) !== sampleCount) {
        throw new Error('The KJR result sample index is incomplete.');
    }
    let selectedBatches = batches.filter((entry) => entry.endTime >= startTime && entry.startTime <= endTime);
    if (Number.isFinite(nearestTime) && batches.length) {
        selectedBatches = [batches.reduce((closest, entry) => {
            const distance = nearestTime < entry.startTime ? entry.startTime - nearestTime
                : nearestTime > entry.endTime ? nearestTime - entry.endTime : 0;
            const closestDistance = nearestTime < closest.startTime ? closest.startTime - nearestTime
                : nearestTime > closest.endTime ? nearestTime - closest.endTime : 0;
            return distance < closestDistance ? entry : closest;
        })];
    }
    const selectedCount = selectedBatches.reduce((total, entry) => total + entry.sampleCount, 0);
    const stride = Number.isFinite(maximumSamples) && maximumSamples > 0
        ? Math.max(1, Math.ceil(selectedCount / maximumSamples)) : 1;
    const samples = [];
    let selectedIndex = 0;
    for (const entry of selectedBatches) {
        const batch = decodedSampleBatch(buffer.subarray(entry.offset + 4, entry.offset + 4 + entry.length));
        if (batch.stateCount !== stateIds.length || batch.times.length !== entry.sampleCount ||
            batch.values.length !== batch.times.length * stateIds.length ||
            batch.times[0] !== entry.startTime || batch.times.at(-1) !== entry.endTime) {
            throw new Error('A KJR sample batch is inconsistent with its index.');
        }
        batch.times.forEach((time, sampleIndex) => {
            const inRange = Number.isFinite(nearestTime) || (time >= startTime && time <= endTime);
            const retain = selectedIndex % stride === 0 || selectedIndex === selectedCount - 1;
            if (inRange && retain) samples.push({
                time,
                states: stateIds.map((stateId, stateIndex) => ({
                    stateId,
                    value: batch.values[sampleIndex * stateIds.length + stateIndex]
                }))
            });
            selectedIndex += 1;
        });
    }
    const materializeStates = (values, offset = 0) => stateIds.map((stateId, index) => ({ stateId, value: values[offset + index] }));
    return {
        ...metadata,
        sampleCount,
        samples,
        checkpoints: checkpoints.map((checkpoint) => {
            if (checkpoint.values.length !== stateIds.length) throw new Error('A KJR checkpoint has an inconsistent state vector.');
            return {
                uuid: checkpoint.uuid,
                time: checkpoint.time,
                solver: checkpoint.solver,
                states: materializeStates(checkpoint.values),
                providerStates: checkpoint.providerStates
            };
        })
    };
}

export function decodeEngineEvent(buffer) {
    const event = { protocolVersion: 0 };
    for (const field of fields(buffer)) {
        if (field.number === 1 && field.wireType === 0) event.protocolVersion = field.value;
        else if (field.number === 2 && field.wireType === 2) {
            const capabilities = { metisAvailable: false, metisVersion: '' };
            for (const item of fields(field.value)) {
                if (item.number === 1 && item.wireType === 0) capabilities.metisAvailable = Boolean(item.value);
                else if (item.number === 2 && item.wireType === 2) capabilities.metisVersion = item.value.toString('utf8');
            }
            event.capabilities = capabilities;
        } else if (field.number === 3 && field.wireType === 2) {
            event.stateTable = decodedStateTable(field.value);
        } else if (field.number === 4 && field.wireType === 2) {
            event.sampleBatch = decodedSampleBatch(field.value);
        }
    }
    if (event.protocolVersion !== 1) throw new Error(`Unsupported engine protocol version ${event.protocolVersion}.`);
    return event;
}

export class FramedEngineEventDecoder {
    #header = Buffer.alloc(4);
    #headerOffset = 0;
    #payload = null;
    #payloadOffset = 0;

    append(chunk) {
        const events = [];
        let offset = 0;
        while (offset < chunk.length) {
            if (!this.#payload) {
                const headerBytes = Math.min(4 - this.#headerOffset, chunk.length - offset);
                chunk.copy(this.#header, this.#headerOffset, offset, offset + headerBytes);
                this.#headerOffset += headerBytes;
                offset += headerBytes;
                if (this.#headerOffset < 4) break;
                const length = this.#header.readUInt32BE(0);
                if (length > 64 * 1024 * 1024) throw new Error('The engine protocol frame is too large.');
                this.#payload = Buffer.allocUnsafe(length);
                this.#payloadOffset = 0;
            }
            const payloadBytes = Math.min(this.#payload.length - this.#payloadOffset, chunk.length - offset);
            chunk.copy(this.#payload, this.#payloadOffset, offset, offset + payloadBytes);
            this.#payloadOffset += payloadBytes;
            offset += payloadBytes;
            if (this.#payloadOffset === this.#payload.length) {
                events.push(decodeEngineEvent(this.#payload));
                this.#headerOffset = 0;
                this.#payload = null;
                this.#payloadOffset = 0;
            }
        }
        return events;
    }
}
