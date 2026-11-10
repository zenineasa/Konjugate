/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs live twins for the app (docs/proposals/digitalTwinConnections.md): the main process holds one per window, and the window sees
// only the events. A live twin is a WindowSession (src/windowSession.mjs) fed from one of these sources:
//
//   { kind: 'file', path }               a data log followed while a logger writes it (src/dataLogFollower.mjs)
//   { kind: 'recording', content, speed } a finished log played back as if it were arriving, `speed` model seconds a wall second
//                                         (Infinity for as fast as it can go)
//   { kind: 'mqtt', url, signals, recordTo } topics on an MQTT broker, each a signal (src/mqttSource.mjs); since a broker keeps no
//                                         history, what arrives is also written to a data log at `recordTo`, to replay later
//   { kind: 'opcua', url, signals, security, pkiFolder, trustServer, recordTo }  tags on an OPC UA server (src/opcuaSource.mjs),
//                                         recorded the same way
//   { kind: 'push', hub, signals, recordTo } readings a lab's own script sends to Konjugate's push service (src/pushSource.mjs,
//                                         docs/proposals/pushService.md), from the service's PushHub, recorded the same way
//
// Events, each { type, ... }: 'cycle' with what a cycle found and the session's figures, 'ended' when a recording has been played
// through or the twin was stopped, 'error' with the reason it stopped. A detached sandbox is reached through the same host.

import { readDataLog } from './dataLog.mjs';
import { LoggerCsvReader, readLoggerCsv } from './loggerCsv.mjs';
import { followDataLog } from './dataLogFollower.mjs';
import { DataLogWriter } from './dataLogWriter.mjs';
import { followMqtt } from './mqttSource.mjs';
import { followOpcUa } from './opcuaSource.mjs';
import { followPush } from './pushSource.mjs';
import { WindowSession } from './windowSession.mjs';

// What a window needs of a cycle, kept small: the jumps, the comparison in the window, the forecast and the trend.
// A series cut down to at most `most` points, its first and last kept: enough to draw, light enough to send at every move.
export function thinned(series, most = 80) {
    if (series.length <= most) return series;
    const step = (series.length - 1) / (most - 1);
    return Array.from({ length: most }, (_, index) => series[Math.round(index * step)]);
}

// An input's readings where its value changes (what was done, and when), each step's first reading kept; at most `most` of them.
export function inputChanges(readings, most = 400) {
    const changes = readings.filter((reading, index) => index === 0 || reading.value !== readings[index - 1].value);
    return thinned(changes, most);
}

export function cycleEvent(cycle, stats) {
    return {
        type: 'cycle',
        cycle: {
            index: cycle.index, anchor: cycle.anchor, now: cycle.now, jumps: cycle.jumps, window: cycle.window, forecast: cycle.forecast, trend: cycle.trend, trends: cycle.trends, wallSeconds: cycle.wallSeconds,
            corrections: cycle.corrections, observed: cycle.observed, unobserved: cycle.unobserved, refit: cycle.refit ?? null, estimate: cycle.estimate ?? null,
            // Each input's last reading up to now, for a sandbox to start its controls from.
            inputs: Object.fromEntries(Object.entries(cycle.inputs).map(([signal, readings]) => [signal, readings.at(-1)?.value ?? null])),
            // What was done over the move's window, for the control room's timeline of the inputs.
            inputChanges: Object.fromEntries(Object.entries(cycle.inputs).map(([signal, readings]) => [signal, inputChanges(readings.filter((reading) => reading.time >= cycle.anchor - 1e-9))])),
            // What the twin infers of the states no sensor measures: each one's course from the anchor to the horizon, thinned, the
            // window and the forecast each on its own so the value at now is sent exactly, not read between two points either side of a
            // step.
            inferred: Object.fromEntries(Object.entries(cycle.inferred ?? {}).map(([stateId, series]) => [stateId, [
                ...thinned(series.filter((point) => point.time <= cycle.now + 1e-9), 50),
                ...thinned(series.filter((point) => point.time > cycle.now + 1e-9), 30)
            ]]))
        },
        stats
    };
}

// Plays a finished log's observations as if they were arriving: those whose time has come, every tick.
// `logger`: the settings for reading another logger's file (src/loggerCsv.mjs), when it is not a Konjugate data log.
export function playRecording(content, speed, { onHeader, onObservations, onEnd, tickMilliseconds = 50, now = () => performance.now(), logger = null }) {
    const { header, observations } = logger ? readLoggerCsv(content, logger) : readDataLog(content);
    onHeader(header);
    const ordered = [...observations].sort((a, b) => a.time - b.time);
    if (!ordered.length) {
        onEnd();
        return { stop() {} };
    }
    const first = ordered[0].time;
    const started = now();
    let next = 0;
    let timer = null;
    let stopped = false;
    const tick = () => {
        if (stopped) return;
        const reached = Number.isFinite(speed) ? first + ((now() - started) / 1000) * speed : Infinity;
        let end = next;
        while (end < ordered.length && ordered[end].time <= reached) end += 1;
        if (end > next) {
            onObservations(ordered.slice(next, end));
            next = end;
        }
        if (next >= ordered.length) {
            stopped = true;
            onEnd();
            return;
        }
        timer = setTimeout(tick, tickMilliseconds);
    };
    tick();
    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
        }
    };
}

export class LiveTwin {
    #session = null;
    #source = null;
    #sandbox = null;
    #recording = null;
    #onEvent;
    #stopped = false;

    // settings: { document, mapping, window, stride, horizon, timeStep, tolerances, alertAt, corrections, conversions }; source as
    // above. conversions: { signal: { scale, offset, unit } }, a mapping's unit conversions (docs/proposals/controlRoom.md), applied to
    // each reading as it reaches the twin, so the twin works in the model's units; a recording keeps what the source sent.
    constructor(settings, source, engineOptions, onEvent) {
        this.settings = settings;
        this.engineOptions = engineOptions;
        this.#onEvent = onEvent;
        const conversions = settings.conversions ?? {};
        const converting = Object.keys(conversions).length > 0;
        const onHeader = (header) => {
            const converted = converting
                ? { ...header, signals: header.signals.map((signal) => (conversions[signal.name]?.unit !== undefined ? { ...signal, unit: conversions[signal.name].unit } : signal)) }
                : header;
            this.#session = new WindowSession({
                // Data that arrives in real time is kept up with; a recording played as fast as it can go gets every move.
                ...settings, header: converted, engineOptions, keepUp: settings.keepUp ?? (source.kind !== 'recording' || Number.isFinite(source.speed ?? Infinity)),
                onCycle: (cycle) => { this.#onEvent(cycleEvent(cycle, this.#session.stats())); }
            });
        };
        const onObservations = (observations) => {
            try {
                this.#session?.push(converting ? observations.map((observation) => {
                    const conversion = conversions[observation.signal];
                    return conversion ? { ...observation, value: observation.value * conversion.scale + conversion.offset } : observation;
                }) : observations);
            } catch (error) {
                this.#fail(error);
            }
        };
        if (source.kind === 'file') {
            this.#source = followDataLog(source.path, { onHeader, onObservations, onError: (error) => this.#fail(error), ...(source.logger ? { reader: new LoggerCsvReader(source.logger) } : {}) });
        } else if (source.kind === 'recording') {
            this.#source = playRecording(source.content, source.speed ?? Infinity, {
                onHeader, onObservations, logger: source.logger ?? null,
                onEnd: () => {
                    this.#session?.end().then(() => { if (!this.#stopped) this.#onEvent({ type: 'ended', stats: this.#session.stats(), reason: 'played' }); })
                        .catch((error) => this.#fail(error));
                }
            });
        } else if (source.kind === 'mqtt' || source.kind === 'opcua' || source.kind === 'push') {
            // A broker, an OPC UA server and the push service keep no history: what arrives is also written to a data log, to replay
            // later.
            let recording = null;
            const follow = { mqtt: followMqtt, opcua: followOpcUa, push: (_url, options) => followPush(source.hub, options) }[source.kind];
            const label = { mqtt: `MQTT ${source.url}`, opcua: `OPC UA ${source.url}`, push: 'Konjugate push service' }[source.kind];
            this.#source = follow(source.url, {
                signals: source.signals, options: source.options, security: source.security, pkiFolder: source.pkiFolder, trustServer: source.trustServer,
                onHeader: (header) => {
                    onHeader(header);
                    if (source.recordTo) {
                        recording = DataLogWriter.create(source.recordTo, { source: label, epoch: header.epoch, signals: header.signals }).catch((error) => { this.#fail(error); return null; });
                        this.#recording = recording;
                    }
                },
                onObservations: (observations) => {
                    recording?.then((writer) => writer?.append(observations)).catch((error) => this.#fail(error));
                    onObservations(observations);
                },
                onError: (error) => this.#fail(error)
            });
            this.recordedTo = source.recordTo ?? null;
            // What an OPC UA server granted: the limit on how fast a change can be seen, said once the server has answered.
            this.#source.sampling?.then((intervals) => {
                const slowest = Math.max(...Object.values(intervals).filter((interval) => interval > 0));
                if (!this.#stopped && Number.isFinite(slowest)) {
                    this.#onEvent({ type: 'note', message: `The server samples these tags every ${slowest} ms or faster: a change quicker than that is not seen by any client.` });
                }
            });
        } else {
            throw new Error('A live twin reads a followed file, a recording, an MQTT broker, an OPC UA server or the push service.');
        }
    }

    get session() { return this.#session; }

    #fail(error) {
        if (this.#stopped) return;
        this.#onEvent({ type: 'error', message: error.message });
        this.stop().catch(() => {});
    }

    async stop() {
        if (this.#stopped) return;
        this.#stopped = true;
        try {
            await this.#source?.stop();
        } catch {
            // a source that fails while stopping has nothing more to say
        }
        await this.closeSandbox();
        const writer = await this.#recording;
        await writer?.close().catch(() => {});
        const stats = this.#session?.stats() ?? null;
        await this.#session?.close();
        // Readings that came after a later one (a source sending what it buffered) reached the twin, but a log's rows only go
        // forward, so the recording could not hold them: said, not lost in silence.
        this.#onEvent({ type: 'ended', stats, reason: 'stopped', recordedTo: this.recordedTo ?? null, recordingLate: writer?.late ?? 0 });
    }

    // A refit over the latest window (src/windowSession.mjs, refitPlan): the plan for the engine's fit, which the window runs.
    refitPlan() {
        if (!this.#session) throw new Error('The live twin has not started yet.');
        const { document, csv, anchor, now, cycle, tunable } = this.#session.refitPlan();
        return { document, csv, anchor, now, cycle, tunable };
    }

    // What the fit found, for the twin to run on from the move the refit was planned on.
    async applyRefit(values, cycle) {
        if (!this.#session) throw new Error('The live twin has not started yet.');
        // When the twin takes the new values: where its record starts with them.
        return this.#session.applyRefit({ values, cycle });
    }

    // A changed model, applied from the latest move (src/windowSession.mjs, applyModel): what was carried across, added, removed.
    async applyModel(document) {
        if (!this.#session) throw new Error('The live twin has not started yet.');
        return this.#session.applyModel(document);
    }

    // The warning changed while the twin runs: a multiple of the first measured signal's tolerance, or null for none.
    setAlert(alertAt) {
        if (!this.#session) throw new Error('The live twin has not started yet.');
        this.#session.setAlert(alertAt);
        return true;
    }

    // A sandbox from the last cycle's now; one at a time.
    async detach() {
        if (!this.#session) throw new Error('The live twin has not started yet.');
        await this.closeSandbox();
        this.#sandbox = await this.#session.detach();
        return { time: this.#sandbox.time, inputs: this.#session.inputs.map((entry) => entry.signal), startInputs: this.#sandbox.startInputs };
    }

    async sandboxSetInput(signal, value) {
        if (!this.#sandbox) throw new Error('There is no sandbox open.');
        await this.#sandbox.setInput(signal, value);
        return { time: this.#sandbox.time };
    }

    async sandboxRunFor(seconds) {
        if (!this.#sandbox) throw new Error('There is no sandbox open.');
        const series = await this.#sandbox.runFor(seconds);
        return { time: this.#sandbox.time, series, tried: this.#sandbox.tried };
    }

    // Ends the sandbox and returns what was tried in it, for a draft scenario; nothing of it reaches the live twin.
    async closeSandbox() {
        if (!this.#sandbox) return null;
        const sandbox = this.#sandbox;
        this.#sandbox = null;
        const tried = sandbox.tried;
        await sandbox.close();
        return { tried };
    }
}
