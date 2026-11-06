/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Reads a Konjugate data log: the CSV file a lab's logger, or any script, appends to while an experiment runs
// (docs/connectingADataSource.md says what the format is and why). This is where the rules of the format are checked, and it is
// the start of the file adapter in docs/proposals/digitalTwinConnections.md: the same reader takes a finished file at once, or a
// growing one a piece at a time, so replaying a recording and following a live rig are one code path.
//
// What it produces is the Observation of that proposal, less the arrival time, which only the caller knows:
//   { time, signal, value, quality, revision }
// `time` is seconds on the log's own clock (see `header.epoch`), `quality` is good, uncertain or bad, and `revision` is 0 for a
// reading as first written and counts up each time the source repeats an earlier row's time to correct it.

export const dataLogVersion = 1;
export const qualities = Object.freeze(['good', 'uncertain', 'bad']);

export class DataLogError extends Error {
    constructor(line, message) {
        super(`Line ${line}: ${message}`);
        this.name = 'DataLogError';
        this.line = line;
    }
}

const metadataLine = /^#\s*([^:]+?)\s*:\s*(.*?)\s*$/;
const signalColumn = /^([A-Za-z][A-Za-z0-9_]*)\s*\[([^\]]*)\]$/;
const qualityColumn = /^([A-Za-z][A-Za-z0-9_]*) quality$/;
const zonedTime = /(Z|[+-]\d\d:?\d\d)$/;

function names(text) {
    return text.split(',').map((name) => name.trim()).filter(Boolean);
}

// `# time: seconds since start` or `# time: seconds since <ISO 8601 time with its zone>`.
function parseClock(value, line) {
    const match = /^seconds since (.+)$/.exec(value);
    if (!match) throw new DataLogError(line, `The time line must read "seconds since start" or "seconds since" a date and time with its zone, not "${value}".`);
    if (match[1] === 'start') return null;
    const epoch = Date.parse(match[1]);
    if (!zonedTime.test(match[1]) || !Number.isFinite(epoch)) {
        throw new DataLogError(line, `"${match[1]}" is not a date and time with its zone, such as 2026-11-06T09:00:00Z or 2026-11-06T10:00:00+01:00.`);
    }
    return epoch;
}

export class DataLogReader {
    #decoder = new TextDecoder('utf-8', { fatal: true });
    #pending = '';
    #line = 0;
    #metadata = new Map();
    #header = null;
    #columns = null;
    #lastTime = -Infinity;
    #revisions = new Map(); // a row's time -> how many times it has been written

    // What the log says about itself, once its column headings have been read; null before.
    get header() {
        return this.#header;
    }

    // Takes the next piece of the file, as text or bytes, and returns the observations in the lines it completed. A line counts only
    // once its newline has arrived: a logger may be part way through writing one, and half a line is not a reading.
    push(chunk) {
        this.#pending += typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
        const lines = this.#pending.split('\n');
        this.#pending = lines.pop();
        return lines.flatMap((line) => this.#read(line.endsWith('\r') ? line.slice(0, -1) : line));
    }

    // Says the file is finished. A last line without its newline is an error here, since nothing more will complete it.
    end() {
        const rest = this.#pending + this.#decoder.decode();
        this.#pending = '';
        if (rest.trim()) throw new DataLogError(this.#line + 1, 'The last line has no newline at its end, so it may be only part of a row.');
        if (!this.#header) throw new DataLogError(this.#line, 'The log ended before its column headings.');
        return [];
    }

    #read(line) {
        this.#line += 1;
        if (!line.trim()) return [];
        if (!this.#metadata.size) this.#readMarker(line);
        if (line.startsWith('#')) {
            if (!this.#header) this.#readMetadata(line);
            return []; // after the headings, a # line is a note for people and is skipped
        }
        if (!this.#header) {
            this.#readHeadings(line);
            return [];
        }
        return this.#readRow(line);
    }

    // The first line that is not blank says what the file is, so a file that is not a data log is refused before anything is read.
    #readMarker(line) {
        const match = metadataLine.exec(line);
        if (match?.[1].toLowerCase() !== 'konjugate data log') {
            throw new DataLogError(this.#line, `A Konjugate data log starts with "# konjugate data log: ${dataLogVersion}".`);
        }
        if (match[2] !== String(dataLogVersion)) throw new DataLogError(this.#line, `This reader knows version ${dataLogVersion} of the format, not "${match[2]}".`);
    }

    #readMetadata(line) {
        const match = metadataLine.exec(line);
        if (!match) return; // a plain comment
        const key = match[1].toLowerCase();
        if (this.#metadata.has(key)) throw new DataLogError(this.#line, `"${match[1]}" is given twice.`);
        this.#metadata.set(key, { value: match[2], line: this.#line });
    }

    #readHeadings(line) {
        const headings = line.split(',').map((heading) => heading.trim());
        if (headings[0] !== 'time') throw new DataLogError(this.#line, 'The first column must be "time".');
        const clock = this.#metadata.get('time');
        if (!clock) throw new DataLogError(this.#line, 'The log must say what its time column counts from, in a "# time:" line before the headings.');
        const epoch = parseClock(clock.value, clock.line);
        const inputs = names(this.#metadata.get('inputs')?.value ?? '');
        const outputs = names(this.#metadata.get('outputs')?.value ?? '');
        const signals = [];
        const columns = [];
        const seen = new Set(['time']);
        for (const heading of headings.slice(1)) {
            if (seen.has(heading)) throw new DataLogError(this.#line, `The column "${heading}" appears twice.`);
            seen.add(heading);
            const signal = signalColumn.exec(heading);
            const quality = qualityColumn.exec(heading);
            if (signal) {
                const [, name, unit] = signal;
                const role = inputs.includes(name) ? 'input' : outputs.includes(name) ? 'output' : null;
                if (!role) throw new DataLogError(this.#line, `"${name}" is in neither the "# inputs:" nor the "# outputs:" line.`);
                if (inputs.includes(name) && outputs.includes(name)) throw new DataLogError(this.#line, `"${name}" is both an input and an output.`);
                signals.push({ name, unit: unit.trim(), role });
                columns.push({ kind: 'value', signal: name });
            } else if (quality) {
                columns.push({ kind: 'quality', signal: quality[1] });
            } else {
                throw new DataLogError(this.#line, `"${heading}" is neither "name [unit]" nor "name quality".`);
            }
        }
        for (const column of columns.filter((entry) => entry.kind === 'quality')) {
            if (!signals.some((signal) => signal.name === column.signal)) throw new DataLogError(this.#line, `"${column.signal} quality" has no "${column.signal} [unit]" column.`);
        }
        for (const name of [...inputs, ...outputs]) {
            if (!signals.some((signal) => signal.name === name)) throw new DataLogError(this.#line, `"${name}" is declared but has no column.`);
        }
        if (!signals.length) throw new DataLogError(this.#line, 'The log has no signal columns.');
        this.#columns = columns;
        this.#header = Object.freeze({ version: dataLogVersion, source: this.#metadata.get('source')?.value ?? '', epoch, signals: Object.freeze(signals) });
    }

    #readRow(line) {
        const cells = line.split(',').map((cell) => cell.trim());
        if (cells.length !== this.#columns.length + 1) {
            throw new DataLogError(this.#line, `The row has ${cells.length} cells and the headings have ${this.#columns.length + 1}.`);
        }
        const time = Number(cells[0]);
        if (cells[0] === '' || !Number.isFinite(time)) throw new DataLogError(this.#line, `"${cells[0]}" is not a time.`);
        let revision = 0;
        if (time > this.#lastTime) {
            this.#lastTime = time;
            this.#revisions.set(time, 0);
        } else if (this.#revisions.has(time)) {
            revision = this.#revisions.get(time) + 1;
            this.#revisions.set(time, revision);
        } else {
            throw new DataLogError(this.#line, `Time ${cells[0]} is earlier than the row before it. Rows go forward in time, and a correction repeats the time of the row it corrects.`);
        }
        const values = new Map();
        const flags = new Map();
        this.#columns.forEach((column, index) => {
            const cell = cells[index + 1];
            if (column.kind === 'quality') {
                if (cell && !qualities.includes(cell)) throw new DataLogError(this.#line, `"${cell}" is not a quality: use good, uncertain or bad, or leave it empty for good.`);
                flags.set(column.signal, cell || 'good');
            } else if (cell !== '') {
                const value = Number(cell);
                if (!Number.isFinite(value)) throw new DataLogError(this.#line, `"${cell}" for ${column.signal} is not a number.`);
                values.set(column.signal, value);
            }
        });
        for (const [signal, quality] of flags) {
            if (quality !== 'good' && !values.has(signal)) throw new DataLogError(this.#line, `${signal} is marked ${quality} but has no reading.`);
        }
        return [...values].map(([signal, value]) => ({ time, signal, value, quality: flags.get(signal) ?? 'good', revision }));
    }
}

// Reads a whole log at once: its header and every observation in it.
export function readDataLog(text) {
    const reader = new DataLogReader();
    const observations = reader.push(text);
    reader.end();
    return { header: reader.header, observations };
}
