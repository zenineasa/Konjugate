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
    // Each sample's values: its states and, in a result that records them, its parts.
    const stateCount = (result.samples?.[0]?.states?.length ?? 0) + (result.samples?.[0]?.parts?.length ?? 0);
    const valueBoundedLimit = Math.max(2, Math.floor(defaultPlaybackValueLimit / Math.max(1, stateCount)));
    const samples = downsampleSamples(result.samples, Math.min(maximumSamples, valueBoundedLimit));
    return {
        ...result,
        sampleCount: result.sampleCount ?? result.samples?.length ?? 0,
        samples,
        checkpoints: result.checkpoints?.length ? [result.checkpoints.at(-1)] : []
    };
}

export function checkpointIndex(result) {
    return (result.checkpoints ?? []).map(({ uuid, time }) => ({ uuid, time }));
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

// ---- Recorded parts (docs/proposals/unifiedEntityEditors.md, decision 11): what each term written as an equation added to, or
// gave, a state at each sample, in a result that records them (result.parts, each sample's `parts` in that order).

// A part by what it is: the term's or relationship's id, the state it lands on, and whether it is a two-way relationship's
// negated term at its far end.
export const partKey = (sourceId, stateId, negated = false) => `${Number(sourceId)}:${Number(stateId)}:${negated ? 1 : 0}`;

// Each recorded part's value at `sample`, by partKey; empty for a result that records none, or a sample without them.
export function samplePartValues(result, sample) {
    const values = new Map();
    const parts = result?.parts ?? [];
    if (!parts.length || !Array.isArray(sample?.parts) || sample.parts.length !== parts.length) return values;
    parts.forEach((part, index) => {
        if (Number.isFinite(sample.parts[index])) values.set(partKey(part.sourceId, part.stateId, part.negated), sample.parts[index]);
    });
    return values;
}

// The series of a relationship's recorded parts over a run, one for each end it lands on; `describe(part)` names each.
export function relationshipPartSeries(result, relationshipId, describe) {
    return (result?.parts ?? [])
        .map((part, index) => ({ part, index }))
        .filter(({ part }) => Number(part.sourceId) === Number(relationshipId))
        .map(({ part, index }) => ({
            ...describe(part),
            samples: (result.samples ?? [])
                .filter((sample) => Number.isFinite(sample.parts?.[index]))
                .map((sample) => ({ time: Number(sample.time), value: sample.parts[index] }))
        }))
        .filter((series) => series.samples.length);
}
