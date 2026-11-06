/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The comparison window kept by a long-lived engine session (docs/proposals/predictionActualWindow.md and
// docs/proposals/liveEngineSession.md): fed the observations of a data log as they arrive, it repeats the default cycle every
// time the data has advanced by a stride S:
//
//   1. at the new anchor (now minus the window W), compare the model's prediction with the measurement there: the jump;
//   2. go back to the checkpoint at the anchor, set each measured state to its measurement, keep the model's own value elsewhere;
//   3. run the window to now on the inputs that were really applied, and compare with what was measured;
//   4. run on to the horizon H for the forecast, with the inputs held at their last value.
//
// One cycle is one batch of commands to one engine process that stays running, so a cycle costs no start-up. Log times are counted
// from the log's first reading, which is time 0 of the session. Each cycle sees only the readings up to its own now, so what a
// cycle computes depends on the data and not on when it arrived, and a cycle can be checked on its own with a fresh run
// (freshRunFor). If the engine dies, a new one is given the last logged state and the cycles go on as if nothing happened.
//
// Detaching (detach) starts a separate engine, a sandbox, from the live state at the last cycle's now: whatever is tried there
// reaches neither the live session nor its record.

import { EngineSession, EngineSessionError } from './engineSession.mjs';
import { interpolate } from './dataLogReplay.mjs';

const isWholeMultiple = (value, of) => Math.abs(value / of - Math.round(value / of)) <= 1e-9 * Math.max(1, Math.abs(value / of));
const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const base64 = (bytes) => Buffer.from(bytes).toString('base64');

// The straight line through (x, y) points, as its slope, and the spread of the points about it.
function fitLine(points) {
    const n = points.length;
    const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
    const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
    const sxx = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
    const slope = sxx > 0 ? points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0) / sxx : 0;
    const residual = n > 2 ? Math.sqrt(points.reduce((sum, [x, y]) => sum + (y - meanY - slope * (x - meanX)) ** 2, 0) / (n - 2)) : 0;
    return { slope, mean: meanY, residual, standardErrorOfSlope: sxx > 0 && n > 2 ? residual / Math.sqrt(sxx) : Infinity };
}

export class WindowSession {
    #engine = null;
    #queue = Promise.resolve();
    #readings = new Map(); // signal -> Map(time -> { time, value, quality, revision }), times counted from the first reading
    #origin = null;
    #latest = -Infinity;
    #nextCycle = 0;
    #inputsSent = new Map(); // parameterId -> the time of the last reading sent to the engine
    #recoveries = 0;
    #skipped = 0;
    #closed = false;
    #failure = null;
    cycles = [];

    // document: the model; header and mapping: the log's description and how its signals map to the model (as replay maps them);
    // window, stride, horizon, timeStep in seconds; tolerances: { signal: tolerance } for the comparison; engineOptions: how to find
    // the engine. onCycle(cycle, index) is awaited after each cycle. trendCycles: how many jumps the trend is read over; alertAt:
    // a multiple of the tolerance the jumps' recent mean must pass to raise the alarm, or null for no alarm. keepUp: when the data
    // is arriving in real time and the twin falls `maxBehind` strides or more behind it, skip to the newest anchor instead of
    // working through the backlog (the first rung of the window document's degrade ladder: a longer stride, said so in stats()).
    constructor({ document, header, mapping, window, stride, horizon, timeStep, tolerances = {}, engineOptions, onCycle = null, trendCycles = 6, alertAt = null, keepUp = false, maxBehind = 3 }) {
        if (!(timeStep > 0)) throw new Error('The time step must be a positive number of seconds.');
        for (const [name, value] of [['window', window], ['stride', stride], ['horizon', horizon]]) {
            if (!(value > 0) || !isWholeMultiple(value, timeStep)) throw new Error(`The ${name} must be a whole number of time steps.`);
        }
        if (stride > window) throw new Error('The stride can be at most the window, so every anchor is in a stretch run on real inputs.');
        if (!isWholeMultiple(window, stride)) throw new Error('The window must be a whole number of strides.');
        this.document = document;
        this.header = header;
        this.inputs = mapping.filter((entry) => entry.role === 'input' && entry.parameterId !== null);
        this.outputs = mapping.filter((entry) => entry.role === 'output' && entry.stateId !== null);
        if (!this.outputs.length) throw new Error('Map at least one measured signal to a state, so there is something to compare.');
        Object.assign(this, { window, stride, horizon, timeStep, tolerances, engineOptions, onCycle, trendCycles, alertAt, keepUp, maxBehind });
        for (const entry of [...this.inputs, ...this.outputs]) this.#readings.set(entry.signal, new Map());
    }

    get engine() { return this.#engine; }

    #engineConfiguration() {
        return {
            globalTimeStep: this.timeStep, outputInterval: this.timeStep, checkpointInterval: this.stride,
            reportedStateIds: this.outputs.map((entry) => entry.stateId), execution: { backend: 'serial' }
        };
    }

    async #startEngine() {
        this.#engine = await EngineSession.start(JSON.stringify(this.document), this.#engineConfiguration(), this.engineOptions);
        this.#inputsSent.clear();
    }

    // Takes observations as they arrive; the cycles they make due are run in order, one after another.
    push(observations) {
        if (this.#closed) throw new Error('The session is closed.');
        for (const observation of observations) {
            const readings = this.#readings.get(observation.signal);
            if (!readings) continue;
            if (this.#origin === null) this.#origin = observation.time;
            const time = observation.time - this.#origin;
            const known = readings.get(time);
            if (!known || observation.revision >= known.revision) readings.set(time, { time, value: observation.value, quality: observation.quality, revision: observation.revision });
            this.#latest = Math.max(this.#latest, time);
        }
        this.#queue = this.#queue.then(() => this.#runDueCycles()).catch((error) => { this.#failure ??= error; });
    }

    // Resolves when every cycle the data so far makes due has run; rejects if the session failed.
    async idle() {
        await this.#queue;
        if (this.#failure) throw this.#failure;
    }

    #anchor(index) { return index * this.stride; }

    async #runDueCycles() {
        while (!this.#closed && this.#anchor(this.#nextCycle) + this.window <= this.#latest + 1e-9) {
            if (this.keepUp) {
                const newest = Math.floor((this.#latest - this.window) / this.stride + 1e-9);
                if (newest - this.#nextCycle >= this.maxBehind) {
                    this.#skipped += newest - this.#nextCycle;
                    this.#nextCycle = newest;
                }
            }
            await this.#runCycle(this.#nextCycle);
            this.#nextCycle += 1;
        }
    }

    // A signal's good readings in time order, up to a time.
    #goodReadings(signal, upTo = Infinity) {
        return [...this.#readings.get(signal).values()].filter((reading) => reading.quality !== 'bad' && reading.time <= upTo + 1e-9).sort((a, b) => a.time - b.time);
    }

    // The measurement at a time: the reading there, or between the readings either side of it; null with none on both sides.
    #measurementAt(signal, time, upTo) {
        const readings = this.#goodReadings(signal, upTo);
        const exact = readings.find((reading) => Math.abs(reading.time - time) < 1e-9);
        if (exact) return exact.value;
        const after = readings.findIndex((reading) => reading.time > time);
        if (after <= 0) return null;
        const value = interpolate(readings.slice(after - 1, after + 1), time);
        return Number.isFinite(value) ? value : null;
    }

    // The input readings a cycle with this now has not yet sent, as commands; a reading corrected after it was sent is sent again
    // with everything after it.
    #inputCommands(now) {
        const commands = [];
        for (const entry of this.inputs) {
            const readings = this.#goodReadings(entry.signal, now);
            const sentUpTo = this.#inputsSent.get(entry.parameterId) ?? -Infinity;
            const fresh = readings.filter((reading) => reading.time > sentUpTo);
            if (!fresh.length) continue;
            commands.push({ type: 'appendInputSamples', parameterId: entry.parameterId, samples: fresh.map(({ time, value }) => ({ time, value })) });
            this.#inputsSent.set(entry.parameterId, fresh.at(-1).time);
        }
        return commands;
    }

    async #runCycle(index) {
        const anchor = this.#anchor(index);
        const now = anchor + this.window;
        const end = now + this.horizon;
        const previous = this.cycles.at(-1) ?? null;
        const overrides = [];
        const jumps = {};
        for (const entry of this.outputs) {
            const measured = this.#measurementAt(entry.signal, anchor, now);
            if (measured === null) continue;
            overrides.push({ stateId: entry.stateId, value: measured });
            if (previous) {
                const predicted = interpolate(this.#modelSeries(previous, entry.signal), anchor);
                if (Number.isFinite(predicted)) jumps[entry.signal] = { predicted, measured, jump: predicted - measured };
            }
        }
        const started = performance.now();
        let replies;
        for (let attempt = 0; ; attempt += 1) {
            try {
                if (!this.#engine) await this.#startEngine();
                replies = await this.#engine.run([
                    ...this.#inputCommands(now),
                    ...this.#catchUp(index, previous),
                    { type: 'restoreCheckpoint', time: anchor, overrides },
                    // The only checkpoint a cycle needs is the next anchor's, so it is the only one taken.
                    { type: 'advanceTo', time: anchor + this.stride, takeCheckpoints: true },
                    { type: 'advanceTo', time: now },
                    { type: 'advanceTo', time: end },
                    { type: 'retainCheckpointsFrom', time: anchor + this.stride }
                ]);
                break;
            } catch (error) {
                if (!(error instanceof EngineSessionError) || this.#engine?.alive || attempt > 0) throw error;
                await this.#recover(index);
            }
        }
        const wallSeconds = (performance.now() - started) / 1000;
        const checkpointsTaken = replies.reduce((sum, reply) => sum + reply.checkpointsTaken, 0);
        const restored = replies.find((reply) => reply.values.length);
        const advances = replies.filter((reply) => reply.samples.length);
        const samples = advances.flatMap((reply) => reply.samples);
        const computeSeconds = replies.reduce((sum, reply) => sum + reply.computeNanoseconds, 0) / 1e9;
        const window = {};
        const forecast = {};
        this.outputs.forEach((entry, outputIndex) => {
            const series = samples.map((sample) => ({ time: sample.time, value: sample.values[outputIndex] }));
            const inWindow = [{ time: anchor, value: restored.values[this.#engine.stateIds.indexOf(entry.stateId)] }, ...series.filter((sample) => sample.time <= now + 1e-9)];
            window[entry.signal] = this.#goodReadings(entry.signal, now).filter((reading) => reading.time >= anchor - 1e-9).map((reading) => {
                const simulated = interpolate(inWindow, reading.time);
                return { time: reading.time, measured: reading.value, simulated, error: simulated - reading.value };
            });
            forecast[entry.signal] = series.filter((sample) => sample.time > now + 1e-9);
        });
        const cycle = {
            index, anchor, now, jumps, window, forecast,
            restored: { time: restored.time, values: restored.values, providerStates: restored.providerStates },
            inputs: Object.fromEntries(this.inputs.map((entry) => [entry.signal, this.#goodReadings(entry.signal, now).map(({ time, value }) => ({ time, value }))])),
            wallSeconds, computeSeconds, checkpointsTaken
        };
        cycle.trend = this.#trend([...this.cycles, cycle]);
        this.cycles.push(cycle);
        if (this.onCycle) await this.onCycle(cycle, index);
    }

    // After skipping anchors, the checkpoint at this one was never kept: run to it from the last cycle's logged state (or from the
    // start), on the real inputs, keeping it.
    #catchUp(index, previous) {
        const expected = previous ? previous.index + 1 : 0;
        if (index === expected) return [];
        const from = previous
            ? { type: 'restoreState', time: previous.restored.time, values: previous.restored.values, providerStates: previous.restored.providerStates }
            : { type: 'restoreCheckpoint', time: 0, overrides: this.outputs.flatMap((entry) => {
                const measured = this.#measurementAt(entry.signal, 0, this.#anchor(index) + this.window);
                return measured === null ? [] : [{ stateId: entry.stateId, value: measured }];
            }) };
        return [from, { type: 'advanceTo', time: this.#anchor(index), takeCheckpoints: true }];
    }

    // The model's series for a signal in a cycle: the restored value at the anchor, the window, then the forecast.
    #modelSeries(cycle, signal) {
        const entry = this.outputs.find((candidate) => candidate.signal === signal);
        const atAnchor = { time: cycle.anchor, value: cycle.restored.values[this.#engine.stateIds.indexOf(entry.stateId)] };
        return [atAnchor, ...cycle.window[signal].map((row) => ({ time: row.time, value: row.simulated })), ...cycle.forecast[signal]]
            .filter((sample, position, all) => position === 0 || sample.time > all[position - 1].time);
    }

    // What the jumps of the last few cycles say, per signal and for the first measured signal on the cycle itself: their trend in
    // units an hour, whether they lean to one side by more than their own scatter allows, and the alarm.
    #trend(cycles) {
        const signal = this.outputs[0].signal;
        const recent = cycles.filter((cycle) => cycle.jumps[signal]).slice(-Math.max(3, this.trendCycles));
        if (recent.length < 3) return { signal, slopePerHour: 0, mean: 0, direction: 'none', alarm: false };
        const line = fitLine(recent.map((cycle) => [cycle.anchor / 3600, cycle.jumps[signal].jump]));
        const spread = Math.sqrt(recent.reduce((sum, cycle) => sum + (cycle.jumps[signal].jump - line.mean) ** 2, 0) / (recent.length - 1));
        // A lean must be clear of the jumps' own scatter, and big enough to matter: at least a tenth of the tolerance. Without the
        // second, a model whose every jump is a steady few thousandths (its own step error, with noise-free data) would be called
        // drifting.
        const tolerance = this.tolerances[signal];
        const leaning = Math.abs(line.mean) > 2 * spread / Math.sqrt(recent.length) && !(tolerance > 0 && Math.abs(line.mean) < tolerance / 10);
        const direction = !leaning ? 'none' : line.mean > 0 ? 'above' : 'below';
        const alarm = this.alertAt !== null && tolerance > 0 && Math.abs(line.mean) > this.alertAt * tolerance;
        return { signal, slopePerHour: line.slope, mean: line.mean, direction, alarm };
    }

    // After the engine died: a new one is given the state the last cycle restored, the inputs it ran on, and run up to the anchor
    // of the cycle that failed, which leaves it with the same checkpoint there the dead one had.
    async #recover(index) {
        this.#recoveries += 1;
        await this.#engine?.close().catch(() => {});
        await this.#startEngine();
        const last = this.cycles.at(-1);
        if (!last) return;
        await this.#engine.run([
            ...this.#inputCommands(last.now),
            { type: 'restoreState', time: last.restored.time, values: last.restored.values, providerStates: last.restored.providerStates },
            { type: 'advanceTo', time: this.#anchor(index), takeCheckpoints: true }
        ]);
    }

    // A run, for the engine's ordinary `run`, that does exactly what a cycle did, from the state it logged: to check the cycle on
    // its own. The inputs become the shared parameters' stored schedules, held between readings.
    freshRunFor(cycle) {
        const document = structuredClone(this.document);
        for (const entry of this.inputs) {
            const parameter = document.sharedParameters.find((candidate) => candidate.id === entry.parameterId);
            parameter.schedule = { interpolation: 'hold', samples: cycle.inputs[entry.signal].map(({ time, value }) => [time, value]) };
            delete parameter.tuning;
        }
        const stateIds = this.#engine.stateIds;
        return {
            document,
            configuration: {
                globalTimeStep: this.timeStep, outputInterval: this.timeStep, targetTime: cycle.now + this.horizon, execution: { backend: 'serial' },
                startCheckpoint: {
                    time: cycle.restored.time,
                    states: stateIds.map((stateId, position) => ({ stateId, value: cycle.restored.values[position] })),
                    providerStates: cycle.restored.providerStates.map(({ nodeId, payload }) => ({ nodeId, payload: base64(payload) }))
                }
            }
        };
    }

    // Starts a sandbox from the live state at the last cycle's now, in an engine of its own: it is given the state that cycle
    // restored and the inputs it ran on, and runs its window again to reach now. The live engine is not asked for anything.
    async detach() {
        const last = this.cycles.at(-1);
        if (!last) throw new Error('There is nothing to detach from before the first cycle.');
        return Sandbox.start(this, last);
    }

    stats() {
        const modelSeconds = this.cycles.length * (this.window + this.horizon);
        const wallSeconds = this.cycles.reduce((sum, cycle) => sum + cycle.wallSeconds, 0);
        return {
            cycles: this.cycles.length,
            realTimeFactor: wallSeconds > 0 ? modelSeconds / wallSeconds : Infinity,
            cycleSeconds: { median: median(this.cycles.map((cycle) => cycle.wallSeconds)), max: Math.max(0, ...this.cycles.map((cycle) => cycle.wallSeconds)) },
            lagSeconds: this.cycles.length ? Math.max(0, this.#latest - this.cycles.at(-1).now) : null,
            recoveries: this.#recoveries,
            skipped: this.#skipped
        };
    }

    async close() {
        this.#closed = true;
        await this.#queue.catch(() => {});
        await this.#engine?.close();
    }
}

// A detached copy of the live twin: its own engine, started from the live state, with no way back into the live session. Inputs
// set here are what a person tries; they are kept apart from the readings and never reach the live record.
export class Sandbox {
    #engine;
    #session;

    static async start(session, cycle) {
        const sandbox = new Sandbox();
        sandbox.#session = session;
        sandbox.#engine = await EngineSession.start(JSON.stringify(session.document), {
            globalTimeStep: session.timeStep, outputInterval: session.timeStep, checkpointInterval: session.stride,
            reportedStateIds: session.outputs.map((entry) => entry.stateId), execution: { backend: 'serial' }
        }, session.engineOptions);
        await sandbox.#engine.run([
            ...session.inputs.filter((entry) => cycle.inputs[entry.signal].length).map((entry) => ({ type: 'appendInputSamples', parameterId: entry.parameterId, samples: cycle.inputs[entry.signal] })),
            { type: 'restoreState', time: cycle.restored.time, values: cycle.restored.values, providerStates: cycle.restored.providerStates },
            { type: 'advanceTo', time: cycle.now }
        ]);
        sandbox.time = cycle.now;
        sandbox.tried = [];
        return sandbox;
    }

    // Sets an input from now on, in the sandbox only.
    async setInput(signal, value) {
        const entry = this.#session.inputs.find((candidate) => candidate.signal === signal);
        if (!entry) throw new Error(`${signal} is not an input of this twin.`);
        await this.#engine.appendInputs(entry.parameterId, [{ time: this.time, value }], this.time);
        this.tried.push({ time: this.time, signal, value });
    }

    // Runs ahead, and returns each measured signal's predicted series.
    async runFor(seconds) {
        const reply = await this.#engine.advanceTo(this.time + seconds);
        this.time = reply.time;
        return Object.fromEntries(this.#session.outputs.map((entry, position) => [entry.signal, reply.samples.map((sample) => ({ time: sample.time, value: sample.values[position] }))]));
    }

    async close() {
        await this.#engine.close();
    }
}
