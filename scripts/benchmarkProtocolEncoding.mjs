/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { randomUUID } from 'node:crypto';

const stateCount = Number(process.env.KONJUGATE_PROTOCOL_BENCHMARK_STATES ?? 100);
const sampleCount = Number(process.env.KONJUGATE_PROTOCOL_BENCHMARK_SAMPLES ?? 1000);
if (!Number.isInteger(stateCount) || stateCount < 1 || !Number.isInteger(sampleCount) || sampleCount < 1) {
    throw new Error('Benchmark state and sample counts must be positive integers.');
}

const varintSize = (value) => {
    let size = 1;
    while (value >= 128) {
        value = Math.floor(value / 128);
        ++size;
    }
    return size;
};
const lengthDelimitedSize = (payload) => 1 + varintSize(payload) + payload;
const stateIds = Array.from({ length: stateCount }, () => randomUUID());
const values = Array.from({ length: stateCount }, (_unused, index) => index + 0.125);

let jsonBytes = 0;
for (let sample = 0; sample < sampleCount; ++sample) {
    jsonBytes += Buffer.byteLength(`${JSON.stringify({
        type: 'sample',
        time: sample * 0.01,
        states: stateIds.map((stateId, index) => ({ stateId, value: values[index] }))
    })}\n`);
}

const descriptorBytes = stateIds.reduce((total, stateId) => {
    const identifier = lengthDelimitedSize(Buffer.byteLength(stateId));
    return total + lengthDelimitedSize(identifier);
}, 0);
const stateTableEvent = 2 + lengthDelimitedSize(descriptorBytes);
const samplePayload = lengthDelimitedSize(8) + 1 + varintSize(stateCount) + lengthDelimitedSize(stateCount * 8);
const sampleEvent = 2 + lengthDelimitedSize(samplePayload);
const protobufBytes = 4 + stateTableEvent + sampleCount * (4 + sampleEvent);
const reduction = 1 - protobufBytes / jsonBytes;

console.log(JSON.stringify({
    stateCount,
    sampleCount,
    jsonBytes,
    protobufBytes,
    reductionPercent: Number((reduction * 100).toFixed(2)),
    bytesPerJsonSample: Number((jsonBytes / sampleCount).toFixed(2)),
    bytesPerProtobufSampleIncludingStateTable: Number((protobufBytes / sampleCount).toFixed(2))
}, null, 4));
