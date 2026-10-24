/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How a live parameter's value moved over a run, rebuilt from the record the engine keeps of the changes it applied
// (`interventions` on a result; see protocol/engineProtocol.proto). Pure functions, so the controls and the tests use the same code.
//
// This is a second copy of how the engine resolves a parameter's value (executionPlan.cpp's resolveParameterValue and
// evaluateParameterSchedule), because a plot needs the value at any time and the engine records only what was asked. The rules:
//   - a value set outright becomes the parameter's value and drops every schedule recorded for it before;
//   - a schedule (step, ramp, pulse, piecewise or waveform) is kept, and of those that have begun, the one with the latest start
//     time governs (the earliest recorded, when two start together), until a value set outright drops them;
//   - with nothing recorded the parameter has its own value from the model.
// A restart (the run was continued from a checkpoint) forgets all of it, because the continued run starts from the model's values.
// tests/engine/parameterHistory.mjs compares this with a real run, so the two cannot drift apart unnoticed.

import { waveformValue } from './parameterSchedule.mjs';

// The value a schedule gives at `time`, as evaluateParameterSchedule does.
export function scheduleValue(schedule, time) {
    switch (schedule.mode) {
    case 'step':
        return schedule.targetValue;
    case 'ramp': {
        const elapsed = time - schedule.startTime;
        if (schedule.duration <= 0 || elapsed >= schedule.duration) return schedule.targetValue;
        if (elapsed <= 0) return schedule.baseValue;
        return schedule.baseValue + (elapsed / schedule.duration) * (schedule.targetValue - schedule.baseValue);
    }
    case 'pulse': {
        const elapsed = time - schedule.startTime;
        return elapsed >= 0 && elapsed < schedule.duration ? schedule.targetValue : schedule.baseValue;
    }
    case 'piecewise': {
        const samples = schedule.samples ?? [];
        if (!samples.length) return schedule.baseValue;
        if (time <= samples[0].time) return samples[0].value;
        if (time >= samples.at(-1).time) return samples.at(-1).value;
        const upper = samples.findIndex((sample) => sample.time > time);
        const lower = samples[upper - 1];
        const next = samples[upper];
        return next.time > lower.time ? lower.value + ((time - lower.time) / (next.time - lower.time)) * (next.value - lower.value) : lower.value;
    }
    case 'waveform':
        return waveformValue({ ...schedule.waveform, duration: schedule.duration }, schedule.baseValue, time - schedule.startTime);
    default:
        return schedule.targetValue;
    }
}

// The parameter's value at `time`, given the changes recorded (all of them, in order) and the value it has without any.
export function parameterValueAt(interventions, parameterId, ownValue, time) {
    let override = null;
    let schedules = [];
    for (const change of interventions) {
        if (change.time > time) break;
        if (change.kind === 'restart') { override = null; schedules = []; continue; }
        if (change.parameterId !== parameterId) continue;
        if (change.kind === 'value') { override = change.value; schedules = []; } else schedules.push(change);
    }
    let governing = null;
    for (const schedule of schedules) {
        if (schedule.startTime > time) continue;
        if (!governing || schedule.startTime > governing.startTime) governing = schedule;
    }
    if (governing) return scheduleValue(governing, time);
    return override ?? ownValue;
}

// A one-line account of a change, for a tooltip or a list: "set to 3", "ramp to 4 over 0.2 s", "sine around 3, ±1.5 at 8 Hz for 2.5 s".
export function describeIntervention(change, unit = '') {
    const shown = (number) => `${Number(Number(number).toPrecision(4))}${unit ? ` ${unit}` : ''}`;
    if (change.kind === 'restart') return 'Run continued: controls back to the model’s values';
    if (change.kind === 'value') return `Set to ${shown(change.value)}`;
    const length = (seconds) => (seconds > 0 ? ` for ${Number(Number(seconds).toPrecision(4))} s` : '');
    switch (change.mode) {
    case 'step': return `Step to ${shown(change.targetValue)}`;
    case 'ramp': return `Ramp from ${shown(change.baseValue)} to ${shown(change.targetValue)} over ${Number(Number(change.duration).toPrecision(4))} s`;
    case 'pulse': return `Pulse to ${shown(change.targetValue)}, back to ${shown(change.baseValue)}, for ${Number(Number(change.duration).toPrecision(4))} s`;
    case 'piecewise': return `Follows ${change.samples?.length ?? 0} points`;
    case 'waveform': {
        const { shape, amplitude, frequency, seed } = change.waveform;
        return shape === 'noise'
            ? `Noise around ${shown(change.baseValue)}, ±${Number(Number(amplitude).toPrecision(4))}, ${Number(Number(frequency).toPrecision(4))} draws per second, seed ${seed}${length(change.duration)}`
            : `${shape[0].toUpperCase()}${shape.slice(1)} around ${shown(change.baseValue)}, ±${Number(Number(amplitude).toPrecision(4))} at ${Number(Number(frequency).toPrecision(4))} Hz${length(change.duration)}`;
    }
    default: return 'Changed';
    }
}

// Where a waveform jumps instead of bending, as offsets within a cycle: a square wave at the start of the cycle and at the end of its
// high part, a sawtooth half way through the cycle, noise at every new draw (a cycle being one draw).
function jumpOffsets(waveform) {
    if (waveform.shape === 'square') return [0, waveform.dutyCycle > 0 ? waveform.dutyCycle : 0.5];
    if (waveform.shape === 'sawtooth') return [0.5];
    if (waveform.shape === 'noise') return [0];
    return [];
}

// The times a plot has to place a point at to show the history faithfully. `jumps` are where the value changes abruptly, so the
// plot also puts a point just before each, which draws it as an edge; `bends` are where it changes direction or needs sampling.
function plotTimes(interventions, parameterId, endTime) {
    const jumps = new Set();
    const bends = new Set();
    const within = (set, time) => { if (time >= 0 && time <= endTime) set.add(time); };
    for (const change of interventions) {
        if (change.kind === 'restart') { within(jumps, change.time); continue; }
        if (change.parameterId !== parameterId) continue;
        within(jumps, change.time);
        if (change.kind !== 'schedule') continue;
        within(jumps, change.startTime);
        if (change.mode === 'ramp') within(bends, change.startTime + change.duration);
        if (change.mode === 'pulse') within(jumps, change.startTime + change.duration);
        if (change.mode === 'piecewise') (change.samples ?? []).forEach((sample) => within(bends, sample.time));
        if (change.mode !== 'waveform') continue;
        const { shape, frequency, phaseDegrees = 0 } = change.waveform;
        const stop = Math.min(endTime, change.duration > 0 ? change.startTime + change.duration : endTime);
        if (change.duration > 0) within(jumps, change.startTime + change.duration);
        if (!(frequency > 0) || stop <= change.startTime) continue;
        // Often enough to draw the curve (sixteen points a cycle), within a bound so a long, fast wave stays cheap to draw.
        const count = Math.min(4000, Math.ceil((stop - change.startTime) * frequency * 16));
        for (let index = 0; index <= count; index += 1) within(bends, change.startTime + (index * (stop - change.startTime)) / count);
        // The jumps, a cycle at a time, with the same bound.
        const phase = shape === 'noise' ? 0 : phaseDegrees / 360;
        let budget = 4000;
        for (const offset of jumpOffsets(change.waveform)) {
            for (let cycle = Math.floor(phase) - 1; budget > 0; cycle += 1) {
                const time = change.startTime + (cycle + offset - phase) / frequency;
                if (time > stop) break;
                if (time >= change.startTime) { within(jumps, time); budget -= 1; }
            }
        }
    }
    return { jumps, bends };
}

// The parameter's value from 0 to `endTime` as { times, values }: an even grid, plus the places the history bends or jumps, and a
// point just before each jump so it draws as an edge. `ownValue` is its value without any change.
export function parameterSeries(interventions, parameterId, ownValue, endTime, { gridPoints = 400 } = {}) {
    const { jumps, bends } = plotTimes(interventions, parameterId, endTime);
    const times = new Set([0, endTime, ...bends, ...jumps]);
    for (let index = 0; index <= gridPoints; index += 1) times.add((endTime * index) / gridPoints);
    // Just before a jump: close enough to read as the old value, far enough not to collide with the point before it.
    const hair = Math.max(endTime, 1e-9) * 1e-9;
    for (const time of jumps) if (time - hair > 0) times.add(time - hair);
    const ordered = [...times].sort((left, right) => left - right);
    return { times: ordered, values: ordered.map((time) => parameterValueAt(interventions, parameterId, ownValue, time)) };
}

// The parameters a run's controls were used on, in the order they were first changed.
export function changedParameterIds(interventions) {
    return [...new Set(interventions.filter((change) => change.kind !== 'restart').map((change) => change.parameterId))];
}

// How each parameter that was changed during a run moved, for the panel and for add-ons: its value over time, and the changes made
// to it (a restart is kept among them, since it is part of what happened). `parameters` says what each is called and what value it
// has without any change: [{ parameterId, name, ownerLabel, unit, ownValue }]. Empty when nothing was changed. The series runs to
// `endTime` (the run so far, which may be 0 for a run held before its first step); `axisEnd` is how far a plot of the whole run
// reaches (the run's target time), which an entry carries so the plot's axis does not move as the run goes on.
export function parameterChangeEntries(parameters, interventions, endTime, { axisEnd = endTime } = {}) {
    if (!interventions?.length || !(endTime >= 0)) return [];
    return changedParameterIds(interventions).map((parameterId) => {
        const known = parameters.find((parameter) => parameter.parameterId === parameterId);
        const ownValue = Number(known?.ownValue) || 0;
        return {
            parameterId, name: known?.name ?? `Parameter ${parameterId}`, ownerLabel: known?.ownerLabel ?? '', unit: known?.unit ?? '', ownValue, endTime, axisEnd: Math.max(axisEnd, endTime),
            changes: interventions.filter((change) => change.kind === 'restart' || change.parameterId === parameterId),
            series: parameterSeries(interventions, parameterId, ownValue, endTime)
        };
    });
}
