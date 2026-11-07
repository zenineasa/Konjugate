/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The two encodings of the push service's message (docs/proposals/pushService.md, "What a script sends"): JSON, and protobuf as
// protocol/pushReadings.proto defines it. Each turns a body into readings as the gate takes them ({ signal, value, time, quality },
// time in seconds since 1970 or null) and an answer into a body. What is wrong with a body's shape is refused here, with 400; what is
// wrong with a reading's content (a signal not granted, a value that is not finite) is the gate's to say, the same for both.

import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { PushRefusal } from './pushGate.mjs';

export const pushProtoPath = fileURLToPath(new URL('../protocol/pushReadings.proto', import.meta.url));

const isoWithZone = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

// A JSON reading's time: seconds since 1970, an ISO 8601 date and time with its zone, or none.
function jsonTime(time, which) {
    if (time === undefined || time === null) return null;
    if (typeof time === 'number') return time;
    if (typeof time === 'string' && isoWithZone.test(time.trim())) {
        const parsed = Date.parse(time.trim());
        if (Number.isFinite(parsed)) return parsed / 1000;
    }
    if (typeof time === 'string' && Number.isFinite(Date.parse(time))) {
        throw new PushRefusal(400, `${which} has the time "${time}" with no time zone: end it with Z for UTC, or an offset like +01:00.`);
    }
    throw new PushRefusal(400, `${which} has a time that is not a time: ${JSON.stringify(time)}.`);
}

const describeReading = (readings, index) => (readings.length === 1 ? 'The reading' : `Reading ${index + 1}`);

export const jsonPushCodec = Object.freeze({
    name: 'json',
    contentType: 'application/json',
    decode(body) {
        let parsed;
        try {
            parsed = JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
        } catch (error) {
            throw new PushRefusal(400, `The message is not JSON: ${error.message}`);
        }
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.readings)) throw new PushRefusal(400, 'A message is { "readings": [ ... ] }.');
        return parsed.readings.map((reading, index) => {
            if (!reading || typeof reading !== 'object' || Array.isArray(reading)) return reading;
            const which = describeReading(parsed.readings, index);
            return { signal: reading.signal, value: reading.value, time: jsonTime(reading.time, which), quality: reading.quality ?? 'good' };
        });
    },
    encodeAnswer(answer) {
        return JSON.stringify(answer);
    }
});

let protobufRoot = null;
const root = () => (protobufRoot ??= protobuf.loadSync(pushProtoPath));

// The readings of a PushReadings message as plain objects (as protobufjs's toObject or gRPC's proto loader give it, with longs as
// numbers and enums as names, and fields left out when unset): used by the protobuf codec and by the gRPC front end alike.
export function readingsFromPushMessage(message) {
    const readings = message?.readings ?? [];
    return readings.map((reading) => ({
        signal: reading.signal ?? '',
        value: reading.value ?? undefined,
        time: reading.time ? Number(reading.time.seconds ?? 0) + Number(reading.time.nanos ?? 0) / 1e9 : null,
        quality: String(reading.quality ?? 'GOOD').toLowerCase()
    }));
}

export const protobufPushCodec = Object.freeze({
    name: 'protobuf',
    contentType: 'application/x-protobuf',
    decode(body) {
        const type = root().lookupType('konjugate.push.v1.PushReadings');
        let message;
        try {
            message = type.decode(body instanceof Uint8Array ? body : Buffer.from(body));
        } catch (error) {
            throw new PushRefusal(400, `The message is not a PushReadings message (protocol/pushReadings.proto): ${error.message}`);
        }
        return readingsFromPushMessage(type.toObject(message, { longs: Number, enums: String, defaults: false }));
    },
    encodeAnswer(answer) {
        const type = root().lookupType('konjugate.push.v1.PushAnswer');
        return Buffer.from(type.encode(type.fromObject(answer)).finish());
    }
});

// The codec for a Content-Type header, or null for one the service does not take.
export function codecForContentType(header) {
    const type = String(header ?? '').split(';')[0].trim().toLowerCase();
    if (type === 'application/json') return jsonPushCodec;
    if (type === 'application/x-protobuf' || type === 'application/protobuf') return protobufPushCodec;
    return null;
}
