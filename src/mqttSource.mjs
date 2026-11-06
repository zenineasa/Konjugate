/* Copyright © 2026 Zenin Easa Panthakkalakath */

// An MQTT broker as a source for a live twin (docs/proposals/digitalTwinConnections.md, "Adapters"): Konjugate connects out to the
// lab's broker and subscribes, as every other client of it does, so several people can follow one rig from their own computers.
//
//   listenToBroker(url, { seconds })   what the broker says in a few seconds of listening: each topic heard, its last value and
//                                      how often it came (the adapter's `describe`)
//   followMqtt(url, { signals, ... })  follows the chosen topics, each as one signal with its role and unit, and hands on
//                                      observations as a data log's would be, times counted from when following began
//
// A payload is a number ("301.2"), or JSON: a number, or an object with `value` and, optionally, `time` (seconds or milliseconds
// since 1970, or an ISO 8601 date and time) and `quality` (good, uncertain or bad). A reading with no time of its own is stamped
// when it arrives. A payload that is none of these is skipped, and counted.

import mqtt from 'mqtt';

const qualities = ['good', 'uncertain', 'bad'];

// A reading from a payload, or null; `arrived` is when it came, in seconds since 1970.
export function parseMqttPayload(payload, arrived) {
    const text = (typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8')).trim();
    if (!text) return null;
    const plain = Number(text);
    if (Number.isFinite(plain)) return { value: plain, time: arrived, quality: 'good' };
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return { value: parsed, time: arrived, quality: 'good' };
    if (!parsed || typeof parsed !== 'object') return null;
    const value = Number(parsed.value ?? parsed.v);
    if (!Number.isFinite(value)) return null;
    let time = arrived;
    const stamp = parsed.time ?? parsed.t ?? parsed.timestamp;
    if (typeof stamp === 'number' && Number.isFinite(stamp)) time = stamp > 1e11 ? stamp / 1000 : stamp;
    else if (typeof stamp === 'string' && Number.isFinite(Date.parse(stamp))) time = Date.parse(stamp) / 1000;
    const quality = qualities.includes(parsed.quality) ? parsed.quality : 'good';
    return { value, time, quality };
}

// Listens to every topic (or those under `filter`) for a few seconds and says what it heard.
export async function listenToBroker(url, { seconds = 3, filter = '#', options = {}, connect = mqtt.connectAsync } = {}) {
    const client = await connect(url, { connectTimeout: 5000, reconnectPeriod: 0, ...options });
    const heard = new Map();
    client.on('message', (topic, payload) => {
        const reading = parseMqttPayload(payload, Date.now() / 1000);
        const known = heard.get(topic) ?? { topic, count: 0, value: null, numeric: false };
        known.count += 1;
        known.last = Buffer.from(payload).toString('utf8').slice(0, 80);
        if (reading) {
            known.value = reading.value;
            known.numeric = true;
        }
        heard.set(topic, known);
    });
    try {
        await client.subscribeAsync(filter);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    } finally {
        await client.endAsync();
    }
    return [...heard.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}

// Follows topics as signals. signals: [{ topic, name, role, unit }]. onHeader(header) is called once, at once; onObservations
// with each batch of readings (gathered for `batchMilliseconds`, so a burst becomes one batch); onError if the connection fails.
export function followMqtt(url, { signals, options = {}, onHeader = () => {}, onObservations = () => {}, onError = () => {}, batchMilliseconds = 20, now = () => Date.now(), connect = mqtt.connectAsync }) {
    const epoch = now();
    const byTopic = new Map(signals.map((signal) => [signal.topic, signal]));
    const header = Object.freeze({
        version: 1, source: url, epoch,
        signals: Object.freeze(signals.map(({ name, unit = '', role }) => ({ name, unit, role })))
    });
    onHeader(header);
    let pending = [];
    let timer = null;
    let skipped = 0;
    const flush = () => {
        timer = null;
        if (!pending.length) return;
        const batch = pending;
        pending = [];
        onObservations(batch, now());
    };
    let client = null;
    const connected = (async () => {
        client = await connect(url, { connectTimeout: 5000, ...options });
        client.on('message', (topic, payload) => {
            const signal = byTopic.get(topic);
            if (!signal) return;
            const reading = parseMqttPayload(payload, now() / 1000);
            if (!reading) {
                skipped += 1;
                return;
            }
            pending.push({ time: reading.time - epoch / 1000, signal: signal.name, value: reading.value, quality: reading.quality, revision: 0 });
            timer ??= setTimeout(flush, batchMilliseconds);
        });
        client.on('error', (error) => onError(error));
        await client.subscribeAsync([...byTopic.keys()]);
    })().catch((error) => { onError(error); });
    return {
        header,
        ready: connected,
        get skipped() { return skipped; },
        async stop() {
            await connected;
            if (timer) clearTimeout(timer);
            flush();
            await client?.endAsync();
        }
    };
}
