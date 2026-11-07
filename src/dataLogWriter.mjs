/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes a Konjugate data log (docs/connectingADataSource.md) from JavaScript, as the simulated rig's DataLog class does from Python:
// the description and headings first, then one whole line per row, appended and flushed, never rewritten. Konjugate uses it to keep
// what a source with no history of its own sent (an MQTT broker forgets each reading once it is passed on), so a live twin's data
// can be replayed later like any other log.

import { open } from 'node:fs/promises';
import { formatDataLog, headingLines, rowLines } from './dataLogFormat.mjs';

export { formatDataLog };

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
