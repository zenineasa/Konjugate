/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A forked run's parameter changes, written into the model instead of sent to the engine (docs/proposals/webEditionPackages.md, stage 5).
// The desktop starts the fork paused and sends each change as a live command (launcherHost.mjs, runScenarioBranches). A web page can send
// commands only when it is cross-origin isolated, which the default web build is not; but the engine also follows a shared parameter's
// stored schedule, so the same changes can be put in the model as one. This turns a parameter's changes into the stored schedule that
// gives it the same value at every time: it evaluates the changes as the engine does (executionPlan.cpp, resolveParameterValue and
// evaluateParameterSchedule: of the changes that have started, the one that started last governs; a step holds, a pulse returns to its base
// value, a path is followed linearly and then held) and writes the result as linear samples. A jump is written as two samples one step of
// floating point apart (the value just before it, then the value at it), so a time on or after the jump gets the new value, as it does from
// the engine, and no time between them exists to be given a value in between.
// No Node, no DOM.

const scratch = new DataView(new ArrayBuffer(8));
// The double next above (direction 1) or below (-1) a finite one.
function neighbour(value, direction) {
    if (value === 0) return direction * Number.MIN_VALUE;
    scratch.setFloat64(0, value);
    const bits = scratch.getBigUint64(0);
    scratch.setBigUint64(0, (value > 0) === (direction > 0) ? bits + 1n : bits - 1n);
    return scratch.getFloat64(0);
}

const evaluateStored = (schedule, time) => {
    const samples = schedule.samples;
    if (time <= samples[0][0]) return samples[0][1];
    if (time >= samples.at(-1)[0]) return samples.at(-1)[1];
    let low = 0;
    let high = samples.length - 1;
    while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (samples[middle][0] <= time) low = middle; else high = middle;
    }
    if (schedule.interpolation === 'hold') return samples[low][1];
    const [lowerTime, lowerValue] = samples[low];
    const [upperTime, upperValue] = samples[high];
    return lowerValue + (upperTime > lowerTime ? (time - lowerTime) / (upperTime - lowerTime) : 0) * (upperValue - lowerValue);
};

// A change as the engine holds it once the fork has sent it: { startTime, evaluate(time), times } (times: where its value changes
// direction or jumps).
function engineSchedule(change, forkTime) {
    if (change.samples) {
        const samples = change.samples.map((sample) => [forkTime + sample.time, sample.value]);
        // The desktop sends a path without a start time, so it counts from time zero: any change that starts at the fork governs over it.
        return { startTime: 0, times: samples.map((sample) => sample[0]), evaluate: (time) => evaluateStored({ interpolation: 'linear', samples }, time) };
    }
    const start = forkTime + change.at;
    if (change.duration > 0) {
        // The engine ends a pulse at the first time whose distance from its start reaches the duration; start + duration can be a hair off that.
        let end = start + change.duration;
        while (end - start >= change.duration) end = neighbour(end, -1);
        while (!(end - start >= change.duration)) end = neighbour(end, 1);
        return {
            startTime: start, times: [start, end],
            evaluate: (time) => (time - start >= 0 && time - start < change.duration ? change.value : (change.baseValue ?? 0))
        };
    }
    return { startTime: start, times: [start], evaluate: () => change.value };
}

// The stored schedule that gives `parameter` (a model's shared parameter) the value `changes` give it from the fork on, or throws.
export function scheduleForChanges(parameter, changes, forkTime) {
    const schedules = changes.map((change) => engineSchedule(change, forkTime));
    const own = parameter.schedule?.samples?.length ? parameter.schedule : null;
    const valueAt = (time) => {
        let active = null;
        for (const schedule of schedules) if (schedule.startTime <= time && (!active || schedule.startTime > active.startTime)) active = schedule;
        if (active) return active.evaluate(time);
        return own ? evaluateStored(own, time) : parameter.value;
    };
    const breakpoints = new Set([forkTime]);
    for (const schedule of schedules) for (const time of schedule.times) if (time >= forkTime) breakpoints.add(time);
    for (const [time] of own?.samples ?? []) if (time >= forkTime) breakpoints.add(time);
    const samples = [];
    for (const time of [...breakpoints].sort((a, b) => a - b)) {
        const before = neighbour(time, -1);
        const previous = samples.at(-1)?.[0];
        if (previous !== undefined && before > previous) {
            const value = valueAt(before);
            if (value !== samples.at(-1)[1] || value !== valueAt(time)) samples.push([before, value]);
        }
        samples.push([time, valueAt(time)]);
    }
    if (!samples.every(([time, value]) => Number.isFinite(time) && Number.isFinite(value))) throw new Error(`The changes to ${parameter.name ?? 'a parameter'} do not give it finite values.`);
    return { interpolation: 'linear', samples };
}

// A copy of the model whose shared parameters named in `interventions` follow the schedules that carry those changes from `forkTime`.
// Throws a message a user can act on when a change names a parameter the model does not have.
export function applyInterventionSchedules(document, interventions, forkTime) {
    const copy = structuredClone(document);
    const byParameter = Map.groupBy(interventions, (change) => change.sharedParameterId);
    for (const [id, changes] of byParameter) {
        const parameter = (copy.sharedParameters ?? []).find((candidate) => candidate.id === id);
        if (!parameter) throw new Error(`${changes[0].name ?? 'A parameter'} is not a shared parameter of this model, so the web edition cannot change it during a run.`);
        parameter.schedule = scheduleForChanges(parameter, changes, forkTime);
        // A parameter that follows a schedule cannot also be a fitting target (modelValidator.cpp); a run has no use for the bounds.
        delete parameter.tuning;
    }
    return copy;
}
