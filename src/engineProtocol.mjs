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
            event.stateTable = fields(field.value).filter((item) => item.number === 1 && item.wireType === 2).map((item) => {
                const identifier = fields(item.value).find((value) => value.number === 1 && value.wireType === 2);
                return identifier?.value.toString('utf8') ?? '';
            });
        } else if (field.number === 4 && field.wireType === 2) {
            const batch = { times: [], stateCount: 0, values: [] };
            for (const item of fields(field.value)) {
                if (item.number === 1 && item.wireType === 2) batch.times.push(...packedDoubles(item.value));
                else if (item.number === 2 && item.wireType === 0) batch.stateCount = item.value;
                else if (item.number === 3 && item.wireType === 2) batch.values.push(...packedDoubles(item.value));
            }
            event.sampleBatch = batch;
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
