/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes a Konjugate data log (docs/connectingADataSource.md) from JavaScript, as the simulated rig's DataLog class does from Python:
// the description and headings first, then one whole line per row, appended and flushed, never rewritten. Konjugate uses it to keep
// what a source with no history of its own sent (an MQTT broker forgets each reading once it is passed on), so a live twin's data
// can be replayed later like any other log.

import { open } from 'node:fs/promises';

const number = (value) => String(Number(value.toPrecision(12)));

// The description and headings of a log with these signals.
function headingLines({ source = '', epoch, signals }) {
    return [
        '# konjugate data log: 1',
        ...(source ? [`# source: ${source.replace(/[\r\n]/g, ' ')}`] : []),
        `# time: seconds since ${epoch === null || epoch === undefined ? 'start' : new Date(epoch).toISOString()}`,
        `# inputs: ${signals.filter((signal) => signal.role === 'input').map((signal) => signal.name).join(', ')}`,
        `# outputs: ${signals.filter((signal) => signal.role === 'output').map((signal) => signal.name).join(', ')}`,
        ['time', ...signals.map((signal) => `${signal.name} [${signal.unit ?? ''}]`), ...signals.map((signal) => `${signal.name} quality`)].join(',')
    ];
}

// One row per time, in the order the times first appear.
function rowLines(signals, observations) {
    const byTime = new Map();
    for (const observation of observations) {
        if (!byTime.has(observation.time)) byTime.set(observation.time, new Map());
        byTime.get(observation.time).set(observation.signal, observation);
    }
    return [...byTime].map(([time, readings]) => [
        number(time),
        ...signals.map((signal) => (readings.has(signal.name) ? number(readings.get(signal.name).value) : '')),
        ...signals.map((signal) => { const quality = readings.get(signal.name)?.quality; return quality && quality !== 'good' ? quality : ''; })
    ].join(','));
}

// A whole log, header and observations, as the text of a Konjugate data log: to keep what another logger's file said in
// Konjugate's own form, or to check it with scripts/checkDataLog.mjs.
export function formatDataLog({ header, observations }) {
    const ordered = [...observations].sort((a, b) => a.time - b.time);
    return `${[...headingLines(header), ...rowLines(header.signals, ordered)].join('\n')}\n`;
}

export class DataLogWriter {
    #handle;
    #signals;
    #queue = Promise.resolve();
    #lastTime = -Infinity;
    // Readings that came too late to be written in order (a data log's rows only go forward), counted rather than written out of
    // order, which would make the log unreadable.
    late = 0;

    // signals: [{ name, unit, role }] with role 'input' or 'output'; epoch: the wall-clock time (ms) row times count from.
    static async create(path, { source = '', epoch, signals }) {
        const writer = new DataLogWriter();
        writer.#handle = await open(path, 'wx');
        writer.#signals = signals;
        await writer.#handle.appendFile(`${headingLines({ source, epoch, signals }).join('\n')}\n`);
        return writer;
    }

    // Appends observations ({ time, signal, value, quality }), one row per time, in the order given; writes are queued, so rows
    // land in the order they were handed over.
    append(observations) {
        const inOrder = [...observations].sort((a, b) => a.time - b.time).filter((observation) => {
            if (observation.time < this.#lastTime) {
                this.late += 1;
                return false;
            }
            this.#lastTime = observation.time;
            return true;
        });
        const text = rowLines(this.#signals, inOrder).join('\n');
        if (!text) return this.#queue;
        this.#queue = this.#queue.then(() => this.#handle.appendFile(`${text}\n`));
        return this.#queue;
    }

    async close() {
        await this.#queue;
        await this.#handle.close();
    }
}
