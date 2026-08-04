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
        if (item.number === 1 && item.wireType === 2) batch.times.push(...packedDoubles(item.value));
        else if (item.number === 2 && item.wireType === 0) batch.stateCount = item.value;
        else if (item.number === 3 && item.wireType === 2) batch.values.push(...packedDoubles(item.value));
    }
    return batch;
}

export function decodeResultFile(buffer) {
    if (buffer.length < 8 || !buffer.subarray(0, 4).equals(Buffer.from([0x4b, 0x4a, 0x52, 0x01]))) {
        throw new Error('Unsupported KJR result format.');
    }
    const payloadLength = buffer.readUInt32BE(4);
    if (payloadLength !== buffer.length - 8) throw new Error('The KJR result payload length is invalid.');
    let resultVersion = 0;
    let metadata = null;
    let stateIds = [];
    let samples = { times: [], stateCount: 0, values: [] };
    const checkpoints = [];
    for (const field of fields(buffer.subarray(8))) {
        if (field.number === 1 && field.wireType === 0) resultVersion = field.value;
        else if (field.number === 2 && field.wireType === 2) metadata = JSON.parse(field.value.toString('utf8'));
        else if (field.number === 3 && field.wireType === 2) stateIds = decodedStateTable(field.value);
        else if (field.number === 4 && field.wireType === 2) samples = decodedSampleBatch(field.value);
        else if (field.number === 5 && field.wireType === 2) {
            const checkpoint = { uuid: '', time: 0, values: [], solver: { kind: '', version: 0 } };
            for (const item of fields(field.value)) {
                if (item.number === 1 && item.wireType === 2) checkpoint.uuid = item.value.toString('utf8');
                else if (item.number === 2 && item.wireType === 1) checkpoint.time = item.value.readDoubleLE();
                else if (item.number === 3 && item.wireType === 2) checkpoint.values.push(...packedDoubles(item.value));
                else if (item.number === 4 && item.wireType === 2) checkpoint.solver.kind = item.value.toString('utf8');
                else if (item.number === 5 && item.wireType === 0) checkpoint.solver.version = item.value;
            }
            checkpoints.push(checkpoint);
        }
    }
    if (resultVersion !== 1 || metadata?.resultVersion !== 1) throw new Error(`Unsupported KJR result version ${resultVersion}.`);
    if (samples.stateCount !== stateIds.length || samples.values.length !== samples.times.length * stateIds.length) {
        throw new Error('The KJR sample columns are inconsistent with its state table.');
    }
    const materializeStates = (values, offset = 0) => stateIds.map((stateId, index) => ({ stateId, value: values[offset + index] }));
    return {
        ...metadata,
        samples: samples.times.map((time, index) => ({
            time,
            states: materializeStates(samples.values, index * stateIds.length)
        })),
        checkpoints: checkpoints.map((checkpoint) => {
            if (checkpoint.values.length !== stateIds.length) throw new Error('A KJR checkpoint has an inconsistent state vector.');
            return {
                uuid: checkpoint.uuid,
                time: checkpoint.time,
                solver: checkpoint.solver,
                states: materializeStates(checkpoint.values)
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
    #buffer = Buffer.alloc(0);

    append(chunk) {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        const events = [];
        while (this.#buffer.length >= 4) {
            const length = this.#buffer.readUInt32BE(0);
            if (length > 64 * 1024 * 1024) throw new Error('The engine protocol frame is too large.');
            if (this.#buffer.length < length + 4) break;
            events.push(decodeEngineEvent(this.#buffer.subarray(4, length + 4)));
            this.#buffer = this.#buffer.subarray(length + 4);
        }
        return events;
    }
}
