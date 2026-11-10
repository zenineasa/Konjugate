/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The comparison window kept by a long-lived engine session (docs/proposals/predictionActualWindow.md and
// docs/proposals/liveEngineSession.md): fed the observations of a data log as they arrive, it repeats the default cycle every
// time the data has advanced by a stride S:
//
//   1. at the new anchor (now minus the window W), compare the model's prediction with the measurement there: the jump;
//   2. go back to the checkpoint at the anchor, set each measured state to its measurement, keep the model's own value elsewhere;
//   3. run the window to now on the inputs that were really applied, and compare with what was measured;
//   4. at now, set each measured state toward its latest reading as at the anchor, and run on to the horizon H from there for the
//      forecast, with the inputs held at their last value: the forecast starts where the system is, not where the window's run,
//      corrected only at its anchor, has drifted to by now.
//
// One cycle is one batch of commands to one engine process that stays running, so a cycle costs no start-up. Log times are counted
// from the log's first reading, which is time 0 of the session. Each cycle sees only the readings up to its own now, so what a
// cycle computes depends on the data and not on when it arrived, and a cycle can be checked on its own with a fresh run
// (freshRunFor). If the engine dies, a new one is given the last logged state and the cycles go on as if nothing happened.
//
// Detaching (detach) starts a separate engine, a sandbox, from the live state at the last cycle's now: whatever is tried there
// reaches neither the live session nor its record.

import { EngineSession, EngineSessionError } from './engineSession.mjs';
import { timingProblem } from './twinSetup.mjs';
import { interpolate, replayTargets, ReplayError } from './dataLogReplay.mjs';
import { fitPlanFromLog } from './dataLogFit.mjs';
import { analyse, ensembleStatistics, explainedShareTogether, initialEnsemble, perturb, quantile, readingNoise, seededNormal } from './stateEstimator.mjs';

// The states a source term sets outright (`setsValue`) to an input's value, as it is (the outdoor air's temperature, the weather
// station's reading; the heater's heat flow, its power): their ids. A term's bindings list every symbol it may use (its own state, the
// time), so it is its expression that says what it reads: here, one symbol, bound to a parameter an input drives (the shared parameter,
// or the term's own copy of it).
function statesSetByInputs(document, inputParameterIds) {
    const set = new Set();
    for (const node of document.nodes ?? []) {
        for (const term of node.sourceTerms ?? []) {
            const stateId = term.expressionModel?.output?.stateId;
            const symbol = term.expressionModel?.mathJson;
            if (!term.setsValue || !Number.isSafeInteger(stateId) || typeof symbol !== 'string') continue;
            const binding = (term.expressionModel?.bindings ?? []).find((candidate) => candidate.kind === 'parameter' && candidate.symbol === symbol);
            if (!binding) continue;
            const local = (term.parameters ?? []).find((parameter) => parameter.id === binding.parameterId);
            if (inputParameterIds.has(binding.parameterId) || (local?.sharedParameterId !== undefined && inputParameterIds.has(local.sharedParameterId))) set.add(stateId);
        }
    }
    return set;
}

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
    #passedOver = 0; // moves passed over before the first, in data that was already there when the twin started
    #ended = false;
    #closed = false;
    #failure = null;
    #refit = null; // what was last applied by a refit, to be recorded on the next move
    #restartFrom = null; // the state a refit restarted the twin from, for a restart before the next move
    #ensemble = null; // the estimator's members at the last move's anchor: { anchor, members }, each member in stateIds order
    #noise = {}; // signal -> the standard deviation of an estimated signal's readings
    #drift = []; // per state position: how far the model may drift from the truth in an hour, beyond what it says
    #normal = null;
    cycles = [];

    // document: the model; header and mapping: the log's description and how its signals map to the model (as replay maps them);
    // window, stride, horizon, timeStep in seconds; tolerances: { signal: tolerance } for the comparison; engineOptions: how to find
    // the engine. onCycle(cycle, index) is awaited after each cycle. trendCycles: how many jumps the trend is read over; alertAt:
    // a multiple of the tolerance the jumps' recent mean must pass to raise the alarm, or null for no alarm. keepUp: when the data
    // is arriving in real time and the twin falls `maxBehind` strides or more behind it, skip to the newest anchor instead of
    // working through the backlog (the first rung of the window document's degrade ladder: a longer stride, said so in stats()).
    // corrections: { signal: { gain } } (docs/proposals/predictionActualWindow.md, "Other ways to bring the model back in step"): at
    // each move the measured state at the anchor is set to the prediction plus `gain` times the gap to the measurement. 1 (the
    // default) resets it to the measurement; 0 corrects nothing, and the model runs on unaided from the first move (the hold policy,
    // to see how long it stays right on its own); between, it is nudged part of the way, which is gentler on noisy readings and on a
    // state a sudden change would put out of balance with the rest. A state the model computes from others is compared, never set.
    // A correction may instead be { estimate: true, noise } (docs/proposals/stateEstimator.md): the signal's readings, with that
    // noise (a standard deviation; by default read from the readings' own scatter), go to an ensemble Kalman filter, which moves
    // every state that moves with it, measured or not. estimator: { members (32), seed (1), drift: { stateId: how far the model
    // may drift from the truth in an hour, beyond what it says (an estimated measured state: as far over a stride as its readings'
    // noise; any other: 1% of its value at the first move) }, spread: { stateId:
    // how unsure its value is at the first move (10% of it; an estimated measured state, its reading's noise) }, parameters: [the ids
    // of tunable parameters to estimate with the states, as a slowly changing quantity found from the readings: a heat loss that
    // grows, say] }. A parameter estimated is made live in this twin's copy of the model, within its tuning bounds, so each member can
    // run with its own value; its drift defaults to 20% of its value an hour, its spread at the first move to 10% of it.
    constructor({ document, header, mapping, window, stride, horizon, timeStep, tolerances = {}, engineOptions, onCycle = null, trendCycles = 6, alertAt = null, keepUp = false, maxBehind = 3, corrections = {}, estimator = {} }) {
        const timing = timingProblem({ window, stride, horizon, timeStep });
        if (timing) throw new Error(timing);
        this.document = document;
        this.header = header;
        this.mapping = mapping;
        this.inputs = mapping.filter((entry) => entry.role === 'input' && entry.parameterId !== null);
        this.outputs = mapping.filter((entry) => entry.role === 'output' && entry.stateId !== null);
        if (!this.outputs.length) throw new Error('Map at least one measured signal to a state, so there is something to compare.');
        for (const [signal, correction] of Object.entries(corrections)) {
            if (correction?.estimate) {
                if (correction.noise !== undefined && correction.noise !== null && !(correction.noise > 0)) throw new Error(`The noise of ${signal}'s readings is a positive standard deviation.`);
                continue;
            }
            if (!(correction?.gain >= 0 && correction.gain <= 1)) throw new Error(`The correction for ${signal} is a gain from 0 (none) to 1 (reset to the measurement), or an estimate.`);
        }
        const members = estimator.members ?? 32;
        if (!(Number.isInteger(members) && members >= 4 && members <= 1000)) throw new Error('The estimator\'s ensemble has from 4 to 1000 members.');
        this.estimator = { members, seed: estimator.seed ?? 1, drift: estimator.drift ?? {}, spread: estimator.spread ?? {}, parameters: [...new Set(estimator.parameters ?? [])] };
        Object.assign(this, { window, stride, horizon, timeStep, tolerances, engineOptions, onCycle, trendCycles, alertAt, keepUp, maxBehind, corrections });
        this.estimated = this.outputs.filter((entry) => corrections[entry.signal]?.estimate);
        if (this.estimator.parameters.length && !this.estimated.length) throw new Error('A parameter is estimated from readings: choose "estimate" for at least one measured signal.');
        this.#useModel(document);
        for (const entry of [...this.inputs, ...this.outputs]) this.#readings.set(entry.signal, new Map());
    }

    // The model this twin runs: its own copy when parameters are estimated with the states, those made live within their tuning
    // bounds so each member of the ensemble can be given its own value; and the states no sensor measures, reported after the
    // measured ones, so a move says what the twin infers of them.
    #useModel(document) {
        const prepared = this.estimator.parameters.length ? structuredClone(document) : document;
        const estimatedParameters = [];
        const parameters = [
            ...(prepared.sharedParameters ?? []),
            ...prepared.edges.flatMap((edge) => edge.parameters ?? []),
            ...prepared.nodes.flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => term.parameters ?? []))
        ];
        for (const parameterId of this.estimator.parameters) {
            const parameter = parameters.find((candidate) => candidate.id === parameterId);
            if (!parameter) throw new Error(`Parameter ${parameterId} is not in the model.`);
            if (parameter.sharedParameterId) throw new Error(`${parameter.name} takes its value from a shared parameter: estimate that one.`);
            if (!parameter.tuning) throw new Error(`Mark ${parameter.name} tunable, with bounds, to estimate it.`);
            parameter.mode = 'live';
            parameter.control = { minimum: parameter.tuning.minimum, maximum: parameter.tuning.maximum, step: (parameter.tuning.maximum - parameter.tuning.minimum) / 1000 };
            estimatedParameters.push({ parameterId, name: parameter.name, value: parameter.value, bounds: { ...parameter.tuning } });
        }
        this.document = prepared;
        this.estimatedParameters = estimatedParameters;
        // What the twin infers: every state no sensor measures, except one an input sets outright (the outdoor air's temperature, set
        // at every instant from the weather station's reading), which is that input again, shown with the inputs.
        const givenByInputs = statesSetByInputs(prepared, new Set(this.inputs.map((entry) => entry.parameterId)));
        this.inferredStateIds = replayTargets(prepared).states.map((state) => state.stateId).filter((stateId) => !this.outputs.some((entry) => entry.stateId === stateId) && !givenByInputs.has(stateId));
    }

    // The warning, changed while the twin runs: from the next move on (a multiple of the first measured signal's tolerance, or null).
    setAlert(alertAt) {
        if (alertAt !== null && !(alertAt > 0)) throw new Error('The warning is a positive multiple of the tolerance, or none.');
        this.alertAt = alertAt;
    }

    get engine() { return this.#engine; }

    #engineConfiguration() {
        return {
            globalTimeStep: this.timeStep, outputInterval: this.timeStep, checkpointInterval: this.stride,
            reportedStateIds: [...this.outputs.map((entry) => entry.stateId), ...this.inferredStateIds], execution: { backend: 'serial' }
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

    // The time of the latest reading, counted from the first.
    get latestTime() { return this.#latest; }

    // The data is complete (a recording played through, a log finished): the last move, whose now is the last reading's time, is
    // made too. Resolves when every move is made.
    async end() {
        this.#ended = true;
        this.#queue = this.#queue.then(() => this.#runDueCycles()).catch((error) => { this.#failure ??= error; });
        return this.idle();
    }

    // Resolves when every cycle the data so far makes due has run; rejects if the session failed.
    async idle() {
        await this.#queue;
        if (this.#failure) throw this.#failure;
    }

    #anchor(index) { return index * this.stride; }

    // A move is due once the data has gone past its now, not merely reached it: several signals' readings for the same instant can
    // arrive one after another (an OPC UA server's tags, separate MQTT topics), and a later reading of any signal is what says all
    // of them up to now are in, each source handing its readings on in time order. When the data has ended, reaching it is enough.
    #due(index) {
        const now = this.#anchor(index) + this.window;
        return this.#ended ? now <= this.#latest + 1e-9 : now < this.#latest - 1e-9;
    }

    async #runDueCycles() {
        while (!this.#closed && this.#due(this.#nextCycle)) {
            if (this.keepUp) {
                let newest = Math.floor((this.#latest - this.window) / this.stride + 1e-9);
                if (!this.#due(newest)) newest -= 1;
                if (newest - this.#nextCycle >= this.maxBehind) {
                    // Before the first move the twin has not fallen behind: it starts at the latest of what was already there.
                    if (this.cycles.length) this.#skipped += newest - this.#nextCycle;
                    else this.#passedOver += newest - this.#nextCycle;
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
    // The latest good reading at or before `now`, if one is within a stride of it: what the forecast starts from.
    #latestReading(signal, now) {
        const reading = this.#goodReadings(signal, now).filter((candidate) => candidate.time <= now + 1e-9).at(-1);
        return reading && now - reading.time <= this.stride + 1e-9 ? reading : null;
    }

    #measurementAt(signal, time, upTo) {
        const readings = this.#goodReadings(signal, upTo);
        const exact = readings.find((reading) => Math.abs(reading.time - time) < 1e-9);
        if (exact) return exact.value;
        const after = readings.findIndex((reading) => reading.time > time);
        if (after <= 0) return null;
        const value = interpolate(readings.slice(after - 1, after + 1), time);
        return Number.isFinite(value) ? value : null;
    }

    // How each measured state is set at now for the forecast, as at the anchor: toward its latest reading by the signal's gain, from the
    // model's own value at now (the last sample of the run to now). Not for a signal estimated (the estimator's band is its forecast),
    // watched only, computed by the model, or with no reading within a stride of now.
    #correctionsAtNow(replies, now, computed) {
        const samples = replies.flatMap((reply) => reply.samples);
        const atNow = [...samples].reverse().find((sample) => Math.abs(sample.time - now) < 1e-9);
        const result = {};
        this.outputs.forEach((entry, outputIndex) => {
            const model = atNow ? atNow.values[outputIndex] : NaN;
            const reading = this.#latestReading(entry.signal, now);
            const gain = this.corrections[entry.signal]?.gain ?? 1;
            const skip = this.corrections[entry.signal]?.estimate || computed.has(entry.stateId) || gain === 0 || !reading || !Number.isFinite(model);
            result[entry.signal] = { stateId: entry.stateId, model, reading: reading?.value ?? null, applied: skip ? null : model + gain * (reading.value - model) };
        });
        return result;
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
        if (!this.#engine) await this.#startEngine();
        const computed = new Set(this.#engine.algebraicStateIds);
        const overrides = [];
        const jumps = {};
        const corrections = {};
        for (const entry of this.outputs) {
            const measured = this.#measurementAt(entry.signal, anchor, now);
            if (measured === null) {
                corrections[entry.signal] = { applied: null, reason: 'no reading at the anchor' };
                continue;
            }
            const predicted = previous ? interpolate(this.#modelSeries(previous, entry.signal), anchor) : NaN;
            if (Number.isFinite(predicted)) jumps[entry.signal] = { predicted, measured, jump: predicted - measured };
            const gain = this.corrections[entry.signal]?.gain ?? 1;
            if (computed.has(entry.stateId)) {
                corrections[entry.signal] = { applied: null, reason: 'computed by the model from other states: compared, not set' };
                continue;
            }
            // The first move starts every measured state at its reading, whatever the gain: there is no prediction yet to correct.
            const value = !Number.isFinite(predicted) ? measured : predicted + gain * (measured - predicted);
            if (Number.isFinite(predicted) && gain === 0) {
                corrections[entry.signal] = { gain, applied: null, reason: 'watched only' };
                continue;
            }
            overrides.push({ stateId: entry.stateId, value });
            corrections[entry.signal] = { gain: Number.isFinite(predicted) ? gain : 1, applied: value };
        }
        const started = performance.now();
        const estimating = this.estimated.length > 0 && this.#ensemble !== null && previous !== null;
        let replies;
        let analysis = null;
        let forecastFrom = {};
        for (let attempt = 0; ; attempt += 1) {
            try {
                if (!this.#engine) await this.#startEngine();
                // An estimated move starts from the analysis (every state, measured or not), the others from the checkpoint with the
                // measured states replaced.
                if (estimating) analysis = await this.#analyse(anchor, now, previous, corrections);
                const start = estimating
                    ? [...this.#parameterCommands(analysis.mean), { type: 'restoreState', time: anchor, values: analysis.mean.slice(0, this.#engine.stateIds.length), providerStates: previous.restored.providerStates }]
                    : [...this.#catchUp(index, previous), { type: 'restoreCheckpoint', time: anchor, overrides }];
                // Two checkpoints are taken: the next anchor's, for the next move, and now's, for the forecast to start from.
                const nextAnchor = anchor + this.stride;
                const toNow = await this.#engine.run([
                    ...this.#inputCommands(now),
                    ...start,
                    { type: 'advanceTo', time: nextAnchor, takeCheckpoints: true },
                    ...(now > nextAnchor + 1e-9 ? [{ type: 'advanceTo', time: now - this.timeStep }, { type: 'advanceTo', time: now, takeCheckpoints: true }] : [])
                ]);
                forecastFrom = this.#correctionsAtNow(toNow, now, computed);
                const onward = await this.#engine.run([
                    { type: 'restoreCheckpoint', time: now, overrides: Object.values(forecastFrom).filter((entry) => entry.applied !== null).map((entry) => ({ stateId: entry.stateId, value: entry.applied })) },
                    { type: 'advanceTo', time: end },
                    // The estimator's members run the next stride again from this anchor, so they need its input readings.
                    { type: 'retainCheckpointsFrom', time: this.estimated.length ? anchor : nextAnchor }
                ]);
                // The restore at now is not the move's: the move's is the anchor's, the first one.
                replies = [...toNow, { ...onward[0], values: [] }, ...onward.slice(1)];
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
        const model = {};
        this.outputs.forEach((entry, outputIndex) => {
            const series = samples.map((sample) => ({ time: sample.time, value: sample.values[outputIndex] }));
            const inWindow = [{ time: anchor, value: restored.values[this.#engine.stateIds.indexOf(entry.stateId)] }, ...series.filter((sample) => sample.time <= now + 1e-9)];
            window[entry.signal] = this.#goodReadings(entry.signal, now).filter((reading) => reading.time >= anchor - 1e-9).map((reading) => {
                const simulated = interpolate(inWindow, reading.time);
                return { time: reading.time, measured: reading.value, simulated, error: simulated - reading.value };
            });
            forecast[entry.signal] = series.filter((sample) => sample.time > now + 1e-9);
            model[entry.signal] = [...inWindow, ...forecast[entry.signal]].filter((sample, position, all) => position === 0 || sample.time > all[position - 1].time);
        });
        // Each unmeasured state's course over the move, from its anchor to the horizon: what the twin infers of it.
        const inferred = Object.fromEntries(this.inferredStateIds.map((stateId, position) => [stateId, [
            { time: anchor, value: restored.values[this.#engine.stateIds.indexOf(stateId)] },
            ...samples.map((sample) => ({ time: sample.time, value: sample.values[this.outputs.length + position] }))
        ].filter((sample, index, all) => index === 0 || sample.time > all[index - 1].time)]));
        const cycle = {
            index, anchor, now, jumps, window, forecast, model, inferred,
            restored: { time: restored.time, values: restored.values, providerStates: restored.providerStates },
            inputs: Object.fromEntries(this.inputs.map((entry) => [entry.signal, this.#goodReadings(entry.signal, now).map(({ time, value }) => ({ time, value }))])),
            wallSeconds, computeSeconds, checkpointsTaken, corrections,
            // Where the forecast starts, for each measured signal: the model at now, the latest reading, and the value set (null when
            // the signal is watched, estimated, computed or has no recent reading, and the forecast runs on from the model).
            forecastFrom: Object.fromEntries(Object.entries(forecastFrom).map(([signal, { stateId, ...entry }]) => [signal, entry])),
            // A refit applied since the last move: the parameters it changed, and the states it set at that move's anchor.
            ...(this.#refit ? { refit: this.#refit } : {}),
            // Which states the data reaches: those compared with a measurement, and those the model carries alone, unchecked.
            observed: this.outputs.map((entry) => entry.stateId),
            unobserved: this.#engine.stateIds.filter((stateId) => !this.outputs.some((entry) => entry.stateId === stateId))
        };
        if (this.estimated.length) {
            if (!estimating) this.#startEnsemble(cycle);
            cycle.estimate = await this.#estimateFigures(cycle, analysis);
        }
        // Every measured signal's trend, and the one that matters most on the move itself: one past the warning, else the one
        // leaning furthest for its tolerance, else the first signal's (a twin with one sensor reads as it always has).
        cycle.trends = Object.fromEntries(this.outputs.map((entry) => [entry.signal, this.#trend([...this.cycles, cycle], entry.signal)]));
        const share = (trend) => Math.abs(trend.mean) / (this.tolerances[trend.signal] > 0 ? this.tolerances[trend.signal] : 1);
        const ranked = Object.values(cycle.trends).sort((a, b) => (b.alarm - a.alarm) || ((b.direction !== 'none') - (a.direction !== 'none')) || share(b) - share(a));
        cycle.trend = ranked[0].alarm || ranked[0].direction !== 'none' ? ranked[0] : cycle.trends[this.outputs[0].signal];
        this.#refit = null;
        this.#restartFrom = null;
        this.cycles.push(cycle);
        if (this.onCycle) await this.onCycle(cycle, index);
    }

    // The estimator's first move: its members are spread about the state the move started from, each by how unsure it is, and the
    // readings' noise and the model's drift are settled from what is known by then.
    #startEnsemble(cycle) {
        const stateIds = this.#engine.stateIds;
        const computed = new Set(this.#engine.algebraicStateIds);
        if (cycle.restored.providerStates.length) throw new ReplayError('A node program here keeps a state of its own, which the estimator cannot spread into an ensemble yet.');
        for (const entry of this.estimated) {
            const given = this.corrections[entry.signal].noise;
            const read = readingNoise(this.#goodReadings(entry.signal, cycle.now).map((reading) => reading.value));
            const noise = given ?? (read > 0 ? read : (this.tolerances[entry.signal] > 0 ? this.tolerances[entry.signal] / 2 : null));
            if (!(noise > 0)) throw new ReplayError(`The noise of ${entry.signal}'s readings could not be read from them: say what it is.`);
            this.#noise[entry.signal] = noise;
        }
        const values = [...cycle.restored.values, ...this.estimatedParameters.map((parameter) => parameter.value)];
        const scale = (value) => Math.max(Math.abs(value), 1e-6);
        // By default a measured state is trusted over one stride about as much as its sensor (whatever its units or offset), and a
        // state nobody measures to 1% of its value an hour. When parameters are estimated too, the model's errors are theirs to
        // explain, so a measured state is trusted ten times more: left as free as its sensor, it would take every disagreement as
        // its own wandering, and a parameter would learn nothing (a drifting heat loss stayed at the model's value for six hours).
        // A parameter may wander 20% of its value an hour, enough to follow a real drift (a heat loss growing 10% an hour) closely.
        const freedom = this.estimatedParameters.length ? 0.1 : 1;
        this.#drift = stateIds.map((stateId, position) => {
            if (computed.has(stateId)) return 0;
            if (this.estimator.drift[stateId] !== undefined) return this.estimator.drift[stateId];
            const measured = this.estimated.find((entry) => entry.stateId === stateId);
            return measured ? freedom * this.#noise[measured.signal] * Math.sqrt(3600 / this.stride) : 0.01 * scale(values[position]);
        }).concat(this.estimatedParameters.map((parameter) => this.estimator.drift[parameter.parameterId] ?? 0.2 * scale(parameter.value)));
        const spread = stateIds.map((stateId, position) => {
            if (computed.has(stateId)) return 0;
            if (this.estimator.spread[stateId] !== undefined) return this.estimator.spread[stateId];
            const measured = this.estimated.find((entry) => entry.stateId === stateId);
            return measured ? this.#noise[measured.signal] : 0.1 * scale(values[position]);
        }).concat(this.estimatedParameters.map((parameter) => this.estimator.spread[parameter.parameterId] ?? 0.1 * scale(parameter.value)));
        this.#normal = seededNormal(this.estimator.seed);
        this.#ensemble = { anchor: cycle.anchor, members: initialEnsemble(values, spread, this.estimator.members, this.#normal) };
    }

    // The analysis at a move's anchor (docs/proposals/stateEstimator.md, "How it fits the window"): each member runs from the last
    // anchor to this one on the real inputs, is pushed by the model's own uncertainty over that stretch, and is then moved toward
    // the estimated readings by the gain the members' spread implies. Signals left on reset, nudge or watch do that to every member.
    // Answers the members' mean, which the move starts from.
    async #analyse(anchor, now, previous, corrections) {
        const stateIds = this.#engine.stateIds;
        const computed = new Set(this.#engine.algebraicStateIds);
        const from = this.#ensemble.anchor;
        const commands = [...this.#inputCommands(now)];
        const offset = commands.length;
        const each = 3 + this.estimatedParameters.length;
        for (const member of this.#ensemble.members) {
            commands.push(
                ...this.#parameterCommands(member),
                { type: 'restoreState', time: from, values: member.slice(0, stateIds.length), providerStates: previous.restored.providerStates },
                { type: 'advanceTo', time: anchor, takeCheckpoints: true },
                { type: 'restoreCheckpoint', time: anchor, overrides: [] }
            );
        }
        const replies = await this.#engine.run(commands);
        // Each member's states where the run left them, with the parameter values it ran with.
        const forecast = this.#ensemble.members.map((member, index) => [...replies[offset + each * index + each - 1].values, ...member.slice(stateIds.length)]);
        const hours = (anchor - from) / 3600;
        const pushed = perturb(forecast, this.#drift.map((drift) => drift * Math.sqrt(hours)), this.#normal);
        // Every good reading of an estimated signal since the last anchor, up to this one, each with what every member predicted it
        // would be, read off the member's own run there (its output samples, from its state at the last anchor): a slowly changing
        // quantity, such as a parameter, shows in a stretch of readings far more than in the one at its end.
        const runs = this.#ensemble.members.map((member, index) => replies[offset + each * index + each - 2].samples);
        const observations = this.estimated.flatMap((entry) => {
            const position = stateIds.indexOf(entry.stateId);
            const output = this.outputs.indexOf(entry);
            const series = runs.map((samples, index) => [{ time: from, value: this.#ensemble.members[index][position] }, ...samples.map((sample) => ({ time: sample.time, value: sample.values[output] }))]);
            return this.#goodReadings(entry.signal, now).filter((reading) => reading.time > from + 1e-9 && reading.time <= anchor + 1e-9).map((reading) => ({
                value: reading.value, noise: this.#noise[entry.signal], signal: entry.signal, time: reading.time,
                predictions: series.map((points) => interpolate(points, reading.time))
            }));
        });
        const bounds = stateIds.map((stateId) => {
            const state = this.document.nodes.flatMap((node) => node.states ?? []).find((candidate) => candidate.id === stateId);
            return state?.tuning ? { minimum: state.tuning.minimum, maximum: state.tuning.maximum } : null;
        }).concat(this.estimatedParameters.map((parameter) => parameter.bounds));
        const updatable = stateIds.map((stateId) => !computed.has(stateId)).concat(this.estimatedParameters.map(() => true));
        const { members: analysed } = analyse(pushed, observations, this.#normal, { updatable, bounds });
        // Which states the readings reached this move, and through which signals: those of whose uncertainty a reading removed more
        // than a twentieth.
        const through = {};
        // A signal reaches a quantity when its readings of the stretch, together, remove more than a twentieth of its uncertainty.
        const reaching = (position) => this.estimated.map((entry) => entry.signal)
            .filter((signal) => explainedShareTogether(pushed, position, observations.filter((observation) => observation.signal === signal)) > 0.05);
        stateIds.forEach((stateId, position) => {
            if (computed.has(stateId)) return;
            const signals = reaching(position);
            if (signals.length) through[stateId] = signals;
        });
        const throughParameters = {};
        this.estimatedParameters.forEach((parameter, index) => {
            const signals = reaching(stateIds.length + index);
            if (signals.length) throughParameters[parameter.parameterId] = signals;
        });
        // The signals not estimated are corrected in every member as in the twin.
        for (const entry of this.outputs.filter((candidate) => !this.estimated.includes(candidate))) {
            const correction = corrections[entry.signal];
            if (correction?.applied === null || correction?.applied === undefined) continue;
            const position = stateIds.indexOf(entry.stateId);
            const measured = this.#measurementAt(entry.signal, anchor, now);
            const gainFor = this.corrections[entry.signal]?.gain ?? 1;
            for (const member of analysed) member[position] += gainFor * (measured - member[position]);
        }
        this.#ensemble = { anchor, members: analysed };
        const { mean } = ensembleStatistics(analysed);
        for (const entry of this.estimated) {
            const readings = observations.filter((candidate) => candidate.signal === entry.signal).length;
            corrections[entry.signal] = readings
                ? { estimate: true, noise: this.#noise[entry.signal], readings, applied: mean[stateIds.indexOf(entry.stateId)] }
                : { estimate: true, applied: null, reason: 'no reading since the last move' };
        }
        return { mean, through, throughParameters };
    }

    // What a move says about the estimate: each state's mean and spread at the anchor; the forecast as a band, the members'
    // 10th to 90th percentile, from each member run on to the horizon; and how many of its last stride's readings fell outside the
    // 10th to 90th percentile of the readings the twin expected (each member's value plus its sensor's noise), which for honest
    // noise and drift settings is about one in five: far fewer says they are too cautious, far more too sure.
    async #estimateFigures(cycle, analysis) {
        const stateIds = this.#engine.stateIds;
        const computed = new Set(this.#engine.algebraicStateIds);
        const members = this.#ensemble.members;
        const { mean, spread } = ensembleStatistics(members);
        const end = cycle.now + this.horizon;
        const each = 2 + this.estimatedParameters.length;
        const commands = members.flatMap((member) => [
            ...this.#parameterCommands(member),
            { type: 'restoreState', time: cycle.anchor, values: member.slice(0, stateIds.length), providerStates: cycle.restored.providerStates },
            { type: 'advanceTo', time: end }
        ]);
        const replies = await this.#engine.run(commands);
        const runs = members.map((_, member) => replies[each * member + each - 1].samples);
        // The twin goes on with the parameters at their estimate, not at the last member's values.
        await this.#engine.run(this.#parameterCommands(mean));
        const band = {};
        const outside = {};
        this.outputs.forEach((entry, outputIndex) => {
            band[entry.signal] = runs[0].map((sample, sampleIndex) => {
                const values = runs.map((samples) => samples[sampleIndex].values[outputIndex]).sort((a, b) => a - b);
                return { time: sample.time, low: quantile(values, 0.1), high: quantile(values, 0.9) };
            });
            // Each reading is judged once, at the move whose last stride it is in: against the band that move ran from its anchor.
            const readings = this.#goodReadings(entry.signal, cycle.now).filter((reading) => reading.time > cycle.now - this.stride + 1e-9);
            const readingNoiseOf = this.#noise[entry.signal] ?? 0;
            const count = readings.filter((reading) => {
                const expected = runs.map((samples) => interpolate(samples.map((sample) => ({ time: sample.time, value: sample.values[outputIndex] })), reading.time) + readingNoiseOf * this.#normal())
                    .sort((a, b) => a - b);
                return reading.value < quantile(expected, 0.1) || reading.value > quantile(expected, 0.9);
            }).length;
            outside[entry.signal] = { outside: count, total: readings.length };
        });
        return {
            members: members.length,
            states: stateIds.flatMap((stateId, position) => (computed.has(stateId) ? [] : [{ stateId, mean: mean[position], spread: spread[position], drift: this.#drift[position] }])),
            parameters: this.estimatedParameters.map((parameter, index) => ({
                parameterId: parameter.parameterId, name: parameter.name, mean: mean[stateIds.length + index], spread: spread[stateIds.length + index], drift: this.#drift[stateIds.length + index]
            })),
            throughParameters: analysis?.throughParameters ?? {},
            noise: { ...this.#noise },
            through: analysis?.through ?? {},
            band, outside
        };
    }

    // The commands giving the engine a member's (or the mean's) values of the estimated parameters, which follow its states in it.
    #parameterCommands(vector) {
        const offset = this.#engine.stateIds.length;
        return this.estimatedParameters.map((parameter, index) => ({
            type: 'setParameterValue', parameterId: parameter.parameterId,
            value: Math.min(Math.max(vector[offset + index], parameter.bounds.minimum), parameter.bounds.maximum)
        }));
    }

    // After skipping anchors, the checkpoint at this one was never kept: run to it from the last cycle's logged state (or from the
    // start), on the real inputs, keeping it.
    #catchUp(index, previous) {
        const expected = previous ? previous.index + 1 : 0;
        if (index === expected) return [];
        // A refit or a model change since that move restarted the twin from a state of its own, which is where to run from.
        const logged = this.#restartFrom ?? previous?.restored;
        const from = previous
            ? { type: 'restoreState', time: logged.time, values: logged.values, providerStates: logged.providerStates }
            : { type: 'restoreCheckpoint', time: 0, overrides: this.outputs.flatMap((entry) => {
                const measured = this.#measurementAt(entry.signal, 0, this.#anchor(index) + this.window);
                return measured === null ? [] : [{ stateId: entry.stateId, value: measured }];
            }) };
        // Only the state it reaches matters: its samples, at every step of what may be hours, are not kept.
        return [from, { type: 'advanceTo', time: this.#anchor(index), takeCheckpoints: true, discardSamples: true }];
    }

    // The model's own series for a signal in a cycle, from the restored value at the anchor through the window and the forecast, at
    // the engine's output samples (not at reading times: a bad reading at the next anchor must not move the prediction there).
    #modelSeries(cycle, signal) {
        return cycle.model[signal];
    }

    // What the jumps of the last few cycles say of one measured signal: their trend in units an hour, whether they lean to one side by
    // more than their own scatter allows, and the alarm.
    #trend(cycles, signal) {
        const recent = cycles.filter((cycle) => cycle.jumps[signal]).slice(-Math.max(3, this.trendCycles));
        if (recent.length < 3) return { signal, slopePerHour: 0, mean: 0, direction: 'none', alarm: false };
        const line = fitLine(recent.map((cycle) => [cycle.anchor / 3600, cycle.jumps[signal].jump]));
        const spread = Math.sqrt(recent.reduce((sum, cycle) => sum + (cycle.jumps[signal].jump - line.mean) ** 2, 0) / (recent.length - 1));
        // A lean must be clear of the jumps' own scatter, and big enough to matter: at least a fifth of the tolerance. Without the
        // second, a model whose every jump is a steady few thousandths (its own step error, with noise-free data) would be called
        // drifting.
        const tolerance = this.tolerances[signal];
        const floor = tolerance > 0 ? tolerance / 5 : 0;
        // The jumps' scatter is measured about their trend line, not about their mean: when the jumps are growing, the growth is the
        // drift, and counting it as scatter would hide the very thing being looked for.
        const threshold = Math.max(2 * line.residual / Math.sqrt(recent.length), floor);
        // Once a lean is called it stays called until the jumps' mean falls below half of what called it, or changes side: one jump
        // that happens to land near zero (a thermostat that was off for that stride, say) must not make the call flicker.
        // A new lean is called only when the move before leaned the same way too, by at least half of its own threshold (the margin
        // that holds a lean once called): the test is about two standard deviations, so on noisy readings one move in a few dozen passes
        // it by chance, and the call came and went (a motor's tachometer, every second). Not clear of it twice in a row: a drift growing
        // move after move raises the threshold with its own growth, and the move after a clear one can fall just short (the lab
        // vessel's heater, its call then never made).
        const side = line.mean > 0 ? 'above' : 'below';
        const previous = cycles.at(-2)?.trends?.[signal];
        const holding = previous?.direction === side && previous.threshold > 0 && Math.abs(line.mean) > previous.threshold / 2;
        const clear = Math.abs(line.mean) > threshold;
        const confirmed = previous?.mean !== undefined && (previous.mean > 0 ? 'above' : 'below') === side && Math.abs(previous.mean) > (previous.threshold ?? 0) / 2;
        const leaning = holding || (clear && confirmed);
        const direction = !leaning ? 'none' : side;
        // Past the warning means drifting past it: leaning to one side, not jumps that are large but scattered either side of nothing.
        // Once raised, the warning holds until the mean falls below half of it, as the lean does: a mean hovering at the warning must not
        // raise it and drop it move after move.
        const warnAt = this.alertAt !== null && tolerance > 0 ? this.alertAt * tolerance : Infinity;
        const alarm = leaning && (Math.abs(line.mean) > warnAt || (previous?.alarm === true && previous.direction === side && Math.abs(line.mean) > warnAt / 2));
        // The threshold kept is the one that called the lean, so holding it is judged against what called it.
        return { signal, slopePerHour: line.slope, mean: line.mean, direction, alarm, threshold: holding && !clear ? previous.threshold : threshold };
    }

    // After the engine died: a new one is given the state the last cycle restored, the inputs it ran on, and run up to the anchor
    // of the cycle that failed, which leaves it with the same checkpoint there the dead one had.
    async #recover(index) {
        this.#recoveries += 1;
        await this.#restart(index);
    }

    // A new engine for the current document, from a logged state (by default the one a refit last set, or else the last cycle's),
    // run on the real inputs up to the anchor of the cycle with this index.
    async #restart(index, from = null) {
        await this.#engine?.close().catch(() => {});
        await this.#startEngine();
        const last = this.cycles.at(-1);
        if (!last) return;
        const state = from ?? this.#restartFrom ?? last.restored;
        await this.#engine.run([
            ...this.#inputCommands(last.now),
            { type: 'restoreState', time: state.time, values: state.values, providerStates: state.providerStates },
            { type: 'advanceTo', time: this.#anchor(index), takeCheckpoints: true, discardSamples: true }
        ]);
    }

    // A refit over the latest window (docs/proposals/predictionActualWindow.md, step 5): the window as a small calibration, to find
    // the tunable parameters, and the tunable initial values at its anchor, that make the window's run match its readings. Returns
    // a plan for the engine's fit (src/dataLogFit.mjs), whose time 0 is the anchor: every state starts where the last move left
    // it there, a measured one at its reading, and the inputs are what was really done. A tunable state's bounds are widened to
    // take in where it starts, as nothing better is known. The fit is run by the caller; applyRefit takes what it found.
    refitPlan({ timeStep = this.timeStep } = {}) {
        const cycle = this.cycles.at(-1);
        if (!cycle) throw new ReplayError('There is no window to refit before the first move.');
        if (cycle.restored.providerStates.length) throw new ReplayError('A node program here keeps a state of its own, which a refit cannot start from yet.');
        const document = structuredClone(this.document);
        const stateIds = this.#engine.stateIds;
        for (const state of document.nodes.flatMap((node) => node.states ?? [])) {
            const position = stateIds.indexOf(state.id);
            if (position < 0) continue;
            state.initialValue = cycle.restored.values[position];
            if (state.tuning) state.tuning = { minimum: Math.min(state.tuning.minimum, state.initialValue), maximum: Math.max(state.tuning.maximum, state.initialValue) };
        }
        const observations = [...this.#readings].flatMap(([signal, readings]) => [...readings.values()].map((reading) => ({ signal, ...reading })));
        const plan = fitPlanFromLog(document, { header: this.header, observations }, this.mapping, { from: cycle.anchor, to: cycle.now, timeStep });
        const tunable = [
            ...(plan.document.sharedParameters ?? []).filter((parameter) => parameter.tuning).map((parameter) => ({ kind: 'parameter', id: parameter.id })),
            ...plan.document.edges.flatMap((edge) => (edge.parameters ?? []).filter((parameter) => parameter.tuning).map((parameter) => ({ kind: 'parameter', id: parameter.id }))),
            ...plan.document.nodes.flatMap((node) => [
                ...(node.states ?? []).filter((state) => state.tuning).map((state) => ({ kind: 'state', id: state.id })),
                ...(node.sourceTerms ?? []).flatMap((term) => (term.parameters ?? []).filter((parameter) => parameter.tuning).map((parameter) => ({ kind: 'parameter', id: parameter.id })))
            ])
        ];
        if (!tunable.length) throw new ReplayError('Mark the parameters, or the initial values of states the data does not reach, as tunable (with bounds) first.');
        return { ...plan, anchor: cycle.anchor, now: cycle.now, cycle: cycle.index, tunable };
    }

    // Takes what a refit found, as the fit reports it: [{ parameterId, value }], where an id is a tunable parameter's (its new value)
    // or a tunable state's (its value at the anchor of the window the fit was run on). `cycle` is the index of the move the refit was
    // planned on. The twin is started again from that move's anchor, with the new parameters and those states, and run on the real
    // inputs to where it has got to, so a twin that moved on while the fit ran takes it as well; the moves already made keep their
    // record as they were made.
    async applyRefit({ values: fitted, cycle }) {
        let refused = null;
        let takesEffect = null;
        this.#queue = this.#queue.then(async () => {
            const target = this.cycles.find((candidate) => candidate.index === cycle);
            if (!target) throw new ReplayError('The move this refit was planned on is not one this twin made.');
            const document = structuredClone(this.document);
            const parameters = [
                ...(document.sharedParameters ?? []),
                ...document.edges.flatMap((edge) => edge.parameters ?? []),
                ...document.nodes.flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => term.parameters ?? []))
            ];
            const stateIdsInModel = new Set(document.nodes.flatMap((node) => (node.states ?? []).map((state) => state.id)));
            const states = {};
            for (const { parameterId, value } of fitted) {
                if (!Number.isFinite(value)) throw new ReplayError(`The refit found no finite value for ${parameterId}.`);
                if (stateIdsInModel.has(parameterId)) {
                    states[parameterId] = value;
                    continue;
                }
                const parameter = parameters.find((candidate) => candidate.id === parameterId);
                if (!parameter) throw new ReplayError(`Parameter ${parameterId} is not in the twin.`);
                parameter.value = value;
            }
            const stateIds = this.#engine.stateIds;
            const values = [...target.restored.values];
            for (const [stateId, value] of Object.entries(states)) {
                const position = stateIds.indexOf(Number(stateId));
                if (position < 0) throw new ReplayError(`State ${stateId} is not in the twin.`);
                values[position] = value;
            }
            const before = this.document;
            this.document = document;
            const from = { time: target.restored.time, values, providerStates: target.restored.providerStates };
            try {
                await this.#restart(this.#nextCycle, from);
                if (JSON.stringify(this.#engine.stateIds) !== JSON.stringify(stateIds)) throw new ReplayError('A refit changes values only, not the model\'s states.');
            } catch (error) {
                // The twin goes on with the model it had.
                this.document = before;
                await this.#restart(this.#nextCycle);
                throw error;
            }
            this.#restartFrom = from;
            this.#refit = { fromCycle: target.index, anchor: target.anchor, states };
            // The next move is the first made with the new values; its stretch of the record starts where the latest move ended.
            takesEffect = this.cycles.at(-1).now;
        }).catch((error) => { refused = error; });
        await this.idle();
        if (refused) throw refused;
        return { takesEffect };
    }

    // A changed model (docs/proposals/controlRoom.md, "The engineer's view, and changing the model"), applied from the latest move:
    // the twin starts again from that move's anchor with it, each state that is still in the model carried across by its id, a new
    // one at its initial value, and runs on the real inputs to where it has got to. A mapped state or input parameter the change
    // removed, or a tracked parameter no longer tunable, is refused with the twin going on as it was: the mapping must be fixed
    // in the setup first, rather than part of the change applied. The estimator, if it runs, starts its ensemble again at the next
    // move, since the states it spreads may have changed. Returns what was carried: { carried, added, removed } state ids.
    async applyModel(document) {
        let refused = null;
        let outcome = null;
        this.#queue = this.#queue.then(async () => {
            const target = this.cycles.at(-1);
            if (!target) throw new ReplayError('The twin has made no move to apply a change from yet.');
            const states = new Map(document.nodes.flatMap((node) => (node.states ?? []).map((state) => [state.id, state])));
            const shared = new Set((document.sharedParameters ?? []).map((parameter) => parameter.id));
            const lost = [
                ...this.outputs.filter((entry) => !states.has(entry.stateId)).map((entry) => `${entry.signal} is compared with a state the change removes`),
                ...this.inputs.filter((entry) => !shared.has(entry.parameterId)).map((entry) => `${entry.signal} drives a shared parameter the change removes`)
            ];
            if (lost.length) throw new ReplayError(`The change was not applied: ${lost.join('; ')}. Fix the mapping in the setup first.`);
            const before = { document: this.document, estimatedParameters: this.estimatedParameters, inferredStateIds: this.inferredStateIds };
            const oldIds = this.#engine.stateIds;
            const providerStates = target.restored.providerStates.filter((entry) => document.nodes.some((node) => node.id === entry.nodeId));
            try {
                this.#useModel(document);
                await this.#engine?.close().catch(() => {});
                await this.#startEngine();
                const newIds = this.#engine.stateIds;
                const values = newIds.map((stateId) => {
                    const position = oldIds.indexOf(stateId);
                    return position >= 0 ? target.restored.values[position] : Number(states.get(stateId)?.initialValue ?? 0);
                });
                const from = { time: target.restored.time, values, providerStates };
                await this.#engine.run([
                    ...this.#inputCommands(target.now),
                    { type: 'restoreState', time: from.time, values, providerStates },
                    { type: 'advanceTo', time: this.#anchor(this.#nextCycle), takeCheckpoints: true, discardSamples: true }
                ]);
                this.#restartFrom = from;
                this.#ensemble = null;
                outcome = { carried: newIds.filter((stateId) => oldIds.includes(stateId)), added: newIds.filter((stateId) => !oldIds.includes(stateId)), removed: oldIds.filter((stateId) => !newIds.includes(stateId)) };
                // Where the twin's record starts with it, as for a refit.
                outcome = { ...outcome, takesEffect: target.now };
                this.#refit = { fromCycle: target.index, anchor: target.anchor, states: {}, model: outcome };
            } catch (error) {
                // The twin goes on with the model it had.
                Object.assign(this, before);
                await this.#restart(this.#nextCycle).catch(() => {});
                throw error instanceof ReplayError ? error : new ReplayError(`The change was not applied: ${error.message}`);
            }
        }).catch((error) => { refused = error; });
        await this.idle();
        if (refused) throw refused;
        return outcome;
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
            skipped: this.#skipped,
            passedOver: this.#passedOver
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
            { type: 'advanceTo', time: cycle.now, discardSamples: true }
        ]);
        sandbox.time = cycle.now;
        sandbox.tried = [];
        // Each input's value at now, as the sandbox starts from it: what its fields show.
        sandbox.startInputs = Object.fromEntries(session.inputs.map((entry) => [entry.signal, cycle.inputs[entry.signal].at(-1)?.value ?? null]));
        return sandbox;
    }

    // Sets an input from now on, in the sandbox only.
    async setInput(signal, value) {
        const entry = this.#session.inputs.find((candidate) => candidate.signal === signal);
        if (!entry) throw new Error(`${signal} is not an input of this twin.`);
        await this.#engine.appendInputs(entry.parameterId, [{ time: this.time, value }], this.time);
        this.tried.push({ time: this.time, signal, value });
    }

    // Runs ahead, and returns each measured signal's predicted series: at most about two thousand points of it, however far and however
    // fine the step (every step is computed; every n-th is kept, and the last). An hour of a motor at a millisecond is 3.6 million steps,
    // and keeping them all, then drawing them, froze the app.
    static drawnPoints = 2000;
    async runFor(seconds) {
        const keepEvery = Math.max(1, Math.ceil(seconds / this.#session.timeStep / Sandbox.drawnPoints));
        const reply = await this.#engine.advanceTo(this.time + seconds, { keepEvery });
        this.time = reply.time;
        return Object.fromEntries(this.#session.outputs.map((entry, position) => [entry.signal, reply.samples.map((sample) => ({ time: sample.time, value: sample.values[position] }))]));
    }

    async close() {
        await this.#engine.close();
    }
}
