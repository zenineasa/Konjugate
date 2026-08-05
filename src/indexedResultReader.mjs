/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { open } from 'node:fs/promises';
import { decodeResultHeaderPayload, decodeResultIndexPayload, decodeSampleBatchPayload } from './engineProtocol.mjs';
import { nearestResultSample } from './resultSession.mjs';

async function readExactly(handle, length, position) {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new Error('The KJR result file is truncated.');
    return buffer;
}

export async function openIndexedResult(path) {
    const handle = await open(path, 'r');
    try {
        const { size } = await handle.stat();
        if (size < 16) throw new Error('Unsupported KJR result format.');
        const prefix = await readExactly(handle, 8, 0);
        if (!prefix.subarray(0, 4).equals(Buffer.from([0x4b, 0x4a, 0x52, 0x02]))) throw new Error('Unsupported KJR result format.');
        const footer = await readExactly(handle, 8, size - 8);
        if (!footer.subarray(4).equals(Buffer.from('KJIX'))) throw new Error('The KJR result index footer is missing.');
        const headerLength = prefix.readUInt32BE(4);
        const indexLength = footer.readUInt32BE(0);
        const indexStart = size - 8 - indexLength;
        const headerEnd = 8 + headerLength;
        if (headerEnd > indexStart) throw new Error('The KJR result section lengths are invalid.');
        const header = decodeResultHeaderPayload(await readExactly(handle, headerLength, 8));
        const index = decodeResultIndexPayload(await readExactly(handle, indexLength, indexStart));
        if (header.resultVersion !== 2 || header.metadata?.resultVersion !== 2 || index.resultVersion !== 2) {
            throw new Error(`Unsupported KJR result version ${header.resultVersion}.`);
        }
        let expectedOffset = headerEnd;
        for (const entry of index.batches) {
            if (entry.offset !== expectedOffset || entry.offset + 4 + entry.length > indexStart) throw new Error('The KJR result batch index is invalid.');
            expectedOffset = entry.offset + 4 + entry.length;
        }
        if (expectedOffset !== indexStart || index.batches.reduce((total, entry) => total + entry.sampleCount, 0) !== index.sampleCount) {
            throw new Error('The KJR result sample index is incomplete.');
        }
        const batchCache = new Map();
        const diagnostics = { batchReads: 0, cacheHits: 0 };
        const readEntry = async (entry) => {
            if (batchCache.has(entry.offset)) {
                const decoded = batchCache.get(entry.offset);
                batchCache.delete(entry.offset);
                batchCache.set(entry.offset, decoded);
                diagnostics.cacheHits += 1;
                return decoded;
            }
            const frame = await readExactly(handle, entry.length + 4, entry.offset);
            if (frame.readUInt32BE(0) !== entry.length) throw new Error('The KJR result batch length is invalid.');
            const decoded = decodeSampleBatchPayload(frame.subarray(4), header.stateIds);
            if (decoded.length !== entry.sampleCount || decoded[0]?.time !== entry.startTime || decoded.at(-1)?.time !== entry.endTime) {
                throw new Error('A KJR sample batch is inconsistent with its index.');
            }
            diagnostics.batchReads += 1;
            batchCache.set(entry.offset, decoded);
            if (batchCache.size > 4) batchCache.delete(batchCache.keys().next().value);
            return decoded;
        };
        return {
            stateIds: [...header.stateIds],
            metadata: {
                ...header.metadata,
                sampleCount: index.sampleCount,
                samples: [],
                checkpoints: header.checkpoints.map((checkpoint) => ({
                    uuid: checkpoint.uuid,
                    time: checkpoint.time,
                    solver: checkpoint.solver,
                    states: header.stateIds.map((stateId, stateIndex) => ({ stateId, value: checkpoint.values[stateIndex] }))
                }))
            },
            async readSamples({ startTime = -Infinity, endTime = Infinity, maximumSamples = Infinity } = {}) {
                const entries = index.batches.filter((entry) => entry.endTime >= startTime && entry.startTime <= endTime);
                if (!entries.length) return [];
                let matchingCount = entries.reduce((total, entry) => total + entry.sampleCount, 0);
                const boundaryEntries = entries.length === 1 ? entries : [entries[0], entries.at(-1)];
                for (const entry of boundaryEntries) {
                    const decoded = await readEntry(entry);
                    matchingCount -= entry.sampleCount;
                    matchingCount += decoded.filter((sample) => sample.time >= startTime && sample.time <= endTime).length;
                }
                const retainedCount = Number.isFinite(maximumSamples)
                    ? Math.min(matchingCount, Math.max(1, Math.floor(maximumSamples))) : matchingCount;
                const targetIndexes = retainedCount === matchingCount ? null : retainedCount === 1 ? [0] : Array.from(
                    { length: retainedCount }, (_value, outputIndex) => Math.round(outputIndex * (matchingCount - 1) / (retainedCount - 1)));
                const samples = [];
                let matchingIndex = 0;
                let targetIndex = 0;
                for (const entry of entries) {
                    for (const sample of await readEntry(entry)) {
                        if (sample.time < startTime || sample.time > endTime) continue;
                        if (!targetIndexes || matchingIndex === targetIndexes[targetIndex]) {
                            samples.push(sample);
                            targetIndex += 1;
                        }
                        matchingIndex += 1;
                    }
                }
                return samples;
            },
            async readNearestSample(time) {
                if (!index.batches.length) return null;
                const entry = index.batches.reduce((closest, candidate) => {
                    const distance = time < candidate.startTime ? candidate.startTime - time : time > candidate.endTime ? time - candidate.endTime : 0;
                    const closestDistance = time < closest.startTime ? closest.startTime - time : time > closest.endTime ? time - closest.endTime : 0;
                    return distance < closestDistance ? candidate : closest;
                });
                return nearestResultSample({ samples: await readEntry(entry) }, time);
            },
            diagnostics: () => ({ ...diagnostics, cachedBatches: batchCache.size }),
            async close() {
                batchCache.clear();
                await handle.close();
            }
        };
    } catch (error) {
        await handle.close().catch(() => {});
        throw error;
    }
}
