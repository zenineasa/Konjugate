/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Replaying a data log through a model: the first step of docs/proposals/digitalTwinConnections.md, and the comparison window's hold
// policy over a recording (docs/proposals/predictionActualWindow.md). Nothing here runs the engine; it turns a log and a model into
// the run to make, and the run's result into how well the model agreed with what was measured.
//
// - The log's inputs (what was done to the system) drive the model: each is mapped to a shared parameter, which follows the readings
//   as a schedule held between them, from the log's first time on.
// - The log's outputs (what was measured) are compared: each is mapped to a state, the state starts at its first good reading (the
//   anchor), and the model then runs unaided for the whole recording. Bad readings are left out of the comparison.
// - A reading agrees when the model is within a tolerance of it. The model is out of step from the first of a run of readings that
//   do not agree, long enough not to be noise, until it agrees again.
//
// Log times are seconds on the log's clock; the run starts at the log's first time, so simulation time is log time minus that start.

import { formatDuration } from './renderer/tuningProgress.mjs';

export class ReplayError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReplayError';
    }
}

const normalized = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// What a log's signals can be mapped to: shared parameters for inputs (only a shared parameter can follow a schedule), states for outputs.
export function replayTargets(document) {
    const parameters = (document.sharedParameters ?? []).map((parameter) => ({
        parameterId: parameter.id, name: parameter.name, symbol: parameter.symbol, unit: parameter.unit ?? '', label: `Shared · ${parameter.name}`
    }));
    const states = (document.nodes ?? []).flatMap((node) => (node.states ?? []).map((state) => ({
        nodeId: node.id, stateId: state.id, name: state.name, symbol: state.symbol, nodeName: node.name, unit: state.unit ?? '', label: `${node.name} · ${state.name}`
    })));
    return { parameters, states };
}

// The first guess at which signal goes where: the same name, ignoring case, spaces and punctuation, as a symbol, a name, or a node's
// name followed by its state's (`waterTankTemperature` for the Water tank's Temperature).
export function guessReplayMapping(header, targets) {
    return header.signals.map((signal) => {
        const wanted = normalized(signal.name);
        if (signal.role === 'input') {
            const parameter = targets.parameters.find((candidate) => normalized(candidate.symbol) === wanted || normalized(candidate.name) === wanted);
            return { signal: signal.name, role: 'input', unit: signal.unit, parameterId: parameter?.parameterId ?? null };
        }
        const state = targets.states.find((candidate) => normalized(candidate.symbol) === wanted || normalized(candidate.name) === wanted
            || normalized(`${candidate.nodeName}${candidate.name}`) === wanted);
        return { signal: signal.name, role: 'output', unit: signal.unit, stateId: state?.stateId ?? null };
    });
}

// One signal's readings, in time order, with each time's latest revision in place of the earlier ones.
export function latestReadings(observations, signal) {
    const byTime = new Map();
    for (const observation of observations) {
        if (observation.signal !== signal) continue;
        const known = byTime.get(observation.time);
        if (!known || observation.revision >= known.revision) byTime.set(observation.time, observation);
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time).map(({ time, value, quality }) => ({ time, value, quality }));
}

// A time step that resolves the readings: the model's own step, or the shortest gap between two readings of a mapped output if that is
// shorter, so the comparison is not made against a model sampled more coarsely than the data.
export function suggestedReplayTimeStep(document, observations, mapping) {
    const configuration = (document.runConfigurations ?? []).find((item) => item.id === document.activeRunConfigurationId) ?? document.runConfigurations?.[0];
    let step = Number(configuration?.globalTimeStep) > 0 ? Number(configuration.globalTimeStep) : Infinity;
    for (const entry of mapping) {
        if (entry.role !== 'output' || entry.stateId === null) continue;
        const times = latestReadings(observations, entry.signal).map((reading) => reading.time);
        for (let index = 1; index < times.length; index += 1) step = Math.min(step, times[index] - times[index - 1]);
    }
    return Number.isFinite(step) ? step : 1;
}

// The run to make: the model with its mapped parameters following the log and its mapped states starting at their first good reading,
// how long to run and at what step, and the readings each output is to be compared with.
// `from` and `to` (log seconds) replay a stretch of the log: the run starts at `from`, with each input at the last reading it had
// by then and each measured state at its first reading from then on.
export function replayPlan(document, log, mapping, { timeStep, anchor = true, from = null, to = null }) {
    if (!(timeStep > 0)) throw new ReplayError('The time step must be a positive number of seconds.');
    const inputs = mapping.filter((entry) => entry.role === 'input' && entry.parameterId !== null);
    const outputs = mapping.filter((entry) => entry.role === 'output' && entry.stateId !== null);
    if (!outputs.length) throw new ReplayError('Map at least one measured signal to a state, so there is something to compare.');
    const within = (list, role) => {
        if (from === null && to === null) return list;
        const upper = to ?? Infinity;
        const kept = list.filter((reading) => reading.time >= (from ?? -Infinity) && reading.time <= upper);
        // An input holds its last reading: the one before the stretch starts is where it stands at the start.
        const held = role === 'input' && from !== null ? list.filter((reading) => reading.time < from && reading.quality !== 'bad').at(-1) : null;
        return held && !kept.some((reading) => reading.time === from) ? [{ ...held, time: from }, ...kept] : kept;
    };
    const readings = new Map([...inputs, ...outputs].map((entry) => [entry.signal, within(latestReadings(log.observations, entry.signal), entry.role)]));
    let start = Infinity;
    let end = -Infinity;
    for (const list of readings.values()) {
        if (!list.length) continue;
        start = Math.min(start, list[0].time);
        end = Math.max(end, list.at(-1).time);
    }
    if (!Number.isFinite(start)) throw new ReplayError(from === null ? 'The mapped signals have no readings yet.' : 'The mapped signals have no readings in that stretch.');
    if (from !== null) start = from;
    if (to !== null) end = Math.min(end, to);
    if (!(end > start)) throw new ReplayError('The log covers no time yet: it needs readings at two different times.');

    const run = structuredClone(document);
    for (const entry of inputs) {
        const parameter = (run.sharedParameters ?? []).find((candidate) => candidate.id === entry.parameterId);
        if (!parameter) throw new ReplayError(`The shared parameter for ${entry.signal} is no longer in the model.`);
        const samples = readings.get(entry.signal).filter((reading) => reading.quality !== 'bad').map((reading) => [reading.time - start, reading.value]);
        if (!samples.length) throw new ReplayError(`${entry.signal} has no good readings to drive the model with.`);
        parameter.schedule = { interpolation: 'hold', samples };
        delete parameter.tuning; // a parameter that follows a schedule is not also fitted
    }
    const compared = outputs.map((entry) => {
        const all = readings.get(entry.signal);
        const good = all.filter((reading) => reading.quality !== 'bad');
        if (!good.length) throw new ReplayError(`${entry.signal} has no good readings to compare with.`);
        if (anchor) {
            const state = run.nodes.flatMap((node) => node.states ?? []).find((candidate) => candidate.id === entry.stateId);
            if (!state) throw new ReplayError(`The state for ${entry.signal} is no longer in the model.`);
            state.initialValue = good[0].value;
            // A measured state starts at its reading, so its initial value is not fitted: that is for the states the data does not reach.
            delete state.tuning;
        }
        return {
            signal: entry.signal, stateId: entry.stateId, unit: entry.unit,
            readings: good.map((reading) => ({ time: reading.time - start, value: reading.value, quality: reading.quality })),
            leftOut: all.length - good.length
        };
    });
    return {
        document: run,
        start,
        configuration: { globalTimeStep: timeStep, outputInterval: timeStep, targetTime: end - start },
        inputs: inputs.map((entry) => entry.signal),
        outputs: compared
    };
}

// The model's value at a time, from its samples: linear between them, and nothing outside them.
export function interpolate(samples, time) {
    if (!samples.length || time < samples[0].time - 1e-9 || time > samples.at(-1).time + 1e-9) return NaN;
    let low = 0;
    let high = samples.length - 1;
    while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (samples[middle].time <= time) low = middle;
        else high = middle;
    }
    const a = samples[low];
    const b = samples[high];
    if (b.time === a.time) return b.value;
    const fraction = Math.min(1, Math.max(0, (time - a.time) / (b.time - a.time)));
    return a.value + fraction * (b.value - a.value);
}

// A starting tolerance for a signal: a twentieth of the range it covered, to two significant figures. The person changes it to what
// they know about the sensor and the model; it is only a first guess so that the comparison says something before they do.
export function defaultTolerance(readings) {
    let low = Infinity;
    let high = -Infinity;
    for (const reading of readings) {
        low = Math.min(low, reading.value);
        high = Math.max(high, reading.value);
    }
    const range = high - low;
    const raw = range > 0 ? range / 20 : Math.abs(readings[0]?.value ?? 1) * 0.01 || 1;
    return Number(raw.toPrecision(2));
}

// How the model agreed with one output's readings. `minimumOut` is how many readings in a row must disagree before the model counts
// as out of step, so that one stray reading within the noise does not.
export function compareReplay(readings, samples, { tolerance, minimumOut = 3 }) {
    if (!(tolerance > 0)) throw new ReplayError('The tolerance must be a positive number.');
    const rows = readings.map((reading) => {
        const simulated = interpolate(samples, reading.time);
        return { time: reading.time, measured: reading.value, simulated, error: simulated - reading.value };
    }).filter((row) => Number.isFinite(row.simulated));
    if (!rows.length) throw new ReplayError('The run produced no values at the times of the readings.');
    const outside = rows.map((row) => Math.abs(row.error) > tolerance);
    const stretches = [];
    let stray = 0; // readings outside the tolerance in runs too short to count, taken as noise
    let index = 0;
    while (index < rows.length) {
        if (!outside[index]) { index += 1; continue; }
        let last = index;
        while (last + 1 < rows.length && outside[last + 1]) last += 1;
        if (last - index + 1 >= Math.min(minimumOut, rows.length)) stretches.push({ from: rows[index].time, to: rows[last].time, readings: last - index + 1 });
        else stray += last - index + 1;
        index = last + 1;
    }
    let largest = rows[0];
    for (const row of rows) if (Math.abs(row.error) > Math.abs(largest.error)) largest = row;
    return {
        rows,
        tolerance,
        rms: Math.sqrt(rows.reduce((sum, row) => sum + row.error * row.error, 0) / rows.length),
        largest: { time: largest.time, error: largest.error },
        within: outside.filter((value) => !value).length / rows.length,
        inStepUntil: stretches.length ? stretches[0].from : null,
        stretches,
        stray
    };
}

const amount = (value, unit) => `${Number(value.toPrecision(3))}${unit ? ` ${unit}` : ''}`;

// One sentence for one output: whether the model stayed within the tolerance, for how long, and by how much it missed.
export function replaySentence(name, unit, comparison, { duration, leftOut = 0 }) {
    const { tolerance, stretches } = comparison;
    const within = `within ${amount(tolerance, unit)}`;
    let sentence;
    if (!stretches.length) sentence = `${name} stayed ${within} for the whole ${formatDuration(duration)}`;
    else if (stretches[0].from <= 0) sentence = `${name} was not ${within} from the start`;
    else sentence = `${name} stayed ${within} for ${formatDuration(stretches[0].from)}, then left it`;
    if (stretches.length) {
        const out = stretches.reduce((sum, stretch) => sum + (stretch.to - stretch.from), 0);
        sentence += stretches.length === 1 ? ` (out of step for ${formatDuration(out)})` : ` (out of step ${stretches.length} times, ${formatDuration(out)} in all)`;
    }
    sentence += `. Typical miss ${amount(comparison.rms, unit)}, largest ${amount(Math.abs(comparison.largest.error), unit)} at ${formatDuration(comparison.largest.time)}.`;
    if (comparison.stray) {
        sentence += ` ${comparison.stray} reading${comparison.stray === 1 ? '' : 's'} outside it on ${comparison.stray === 1 ? 'its' : 'their'} own ${comparison.stray === 1 ? 'was' : 'were'} taken as noise.`;
    }
    if (leftOut) sentence += ` ${leftOut} bad reading${leftOut === 1 ? ' was' : 's were'} left out.`;
    return sentence;
}
