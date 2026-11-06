/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes a Konjugate data log (docs/connectingADataSource.md) from JavaScript, as the simulated rig's DataLog class does from Python:
// the description and headings first, then one whole line per row, appended and flushed, never rewritten. Konjugate uses it to keep
// what a source with no history of its own sent (an MQTT broker forgets each reading once it is passed on), so a live twin's data
// can be replayed later like any other log.

import { open } from 'node:fs/promises';

const number = (value) => String(Number(value.toPrecision(12)));

export class DataLogWriter {
    #handle;
    #signals;
    #qualityFor;
    #queue = Promise.resolve();

    // signals: [{ name, unit, role }] with role 'input' or 'output'; epoch: the wall-clock time (ms) row times count from.
    static async create(path, { source = '', epoch, signals }) {
        const writer = new DataLogWriter();
        writer.#handle = await open(path, 'wx');
        writer.#signals = signals;
        writer.#qualityFor = signals.map((signal) => signal.name);
        const lines = [
            '# konjugate data log: 1',
            ...(source ? [`# source: ${source.replace(/[\r\n]/g, ' ')}`] : []),
            `# time: seconds since ${new Date(epoch).toISOString()}`,
            `# inputs: ${signals.filter((signal) => signal.role === 'input').map((signal) => signal.name).join(', ')}`,
            `# outputs: ${signals.filter((signal) => signal.role === 'output').map((signal) => signal.name).join(', ')}`,
            ['time', ...signals.map((signal) => `${signal.name} [${signal.unit ?? ''}]`), ...writer.#qualityFor.map((name) => `${name} quality`)].join(',')
        ];
        await writer.#handle.appendFile(`${lines.join('\n')}\n`);
        return writer;
    }

    // Appends observations ({ time, signal, value, quality }), one row per time, in the order given; writes are queued, so rows
    // land in the order they were handed over.
    append(observations) {
        const byTime = new Map();
        for (const observation of observations) {
            if (!byTime.has(observation.time)) byTime.set(observation.time, new Map());
            byTime.get(observation.time).set(observation.signal, observation);
        }
        const text = [...byTime].map(([time, readings]) => [
            number(time),
            ...this.#signals.map((signal) => (readings.has(signal.name) ? number(readings.get(signal.name).value) : '')),
            ...this.#qualityFor.map((name) => { const quality = readings.get(name)?.quality; return quality && quality !== 'good' ? quality : ''; })
        ].join(',')).join('\n');
        if (!text) return this.#queue;
        this.#queue = this.#queue.then(() => this.#handle.appendFile(`${text}\n`));
        return this.#queue;
    }

    async close() {
        await this.#queue;
        await this.#handle.close();
    }
}
