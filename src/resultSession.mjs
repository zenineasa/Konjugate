/* Copyright © 2026 Zenin Easa Panthakkalakath */

export const defaultPlaybackSampleLimit = 4000;
const defaultPlaybackValueLimit = 250000;

export function suggestedPlaybackRate(duration) {
    const seconds = Number(duration);
    if (seconds <= 300) return 1;
    if (seconds <= 600) return 2;
    if (seconds <= 1800) return 5;
    return 10;
}

export function downsampleSamples(samples, maximumSamples = defaultPlaybackSampleLimit) {
    if (!Array.isArray(samples) || samples.length <= maximumSamples) return samples ?? [];
    const selected = [];
    let previousIndex = -1;
    for (let outputIndex = 0; outputIndex < maximumSamples; ++outputIndex) {
        const index = Math.round(outputIndex * (samples.length - 1) / (maximumSamples - 1));
        if (index !== previousIndex) selected.push(samples[index]);
        previousIndex = index;
    }
    return selected;
}

export function rendererResultProjection(result, maximumSamples = defaultPlaybackSampleLimit) {
    const stateCount = result.samples?.[0]?.states?.length ?? 0;
    const valueBoundedLimit = Math.max(2, Math.floor(defaultPlaybackValueLimit / Math.max(1, stateCount)));
    const samples = downsampleSamples(result.samples, Math.min(maximumSamples, valueBoundedLimit));
    return {
        ...result,
        sampleCount: result.sampleCount ?? result.samples?.length ?? 0,
        samples,
        checkpoints: result.checkpoints?.length ? [result.checkpoints.at(-1)] : []
    };
}

export function resultSignalSeries(result, signalIds, { startTime = 0, endTime = Infinity, maxPoints = 4000 } = {}) {
    const valuesBySignal = new Map(signalIds.map((signalId) => [signalId, []]));
    const samples = downsampleSamples((result.samples ?? [])
        .filter((sample) => sample.time >= startTime && sample.time <= endTime), Math.max(2, maxPoints));
    samples.forEach((sample) => sample.states.forEach((state) => {
        valuesBySignal.get(state.stateId)?.push({ time: Number(sample.time), value: Number(state.value) });
    }));
    return signalIds.map((signalId) => ({ signalId, samples: valuesBySignal.get(signalId) }));
}

export function nearestResultSample(result, time) {
    const samples = result?.samples ?? [];
    if (!samples.length) return null;
    let low = 0;
    let high = samples.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (Number(samples[middle].time) < time) low = middle + 1;
        else high = middle;
    }
    if (low === 0) return samples[0];
    return Math.abs(Number(samples[low].time) - time) < Math.abs(Number(samples[low - 1].time) - time)
        ? samples[low] : samples[low - 1];
}
