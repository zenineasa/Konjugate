/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Reading a lab logger's own CSV, as it is (docs/connectingADataSource.md, "Reading another logger's file"): most loggers cannot be
// made to write a Konjugate data log, and should not have to. A person describes the file once (which column holds what, in which
// unit, what the time column looks like and which time zone it was written in), and this reads it into the same observations a data
// log gives, so replay, calibration and the live twin take it unchanged. What it has to cope with is what real loggers do:
//
//   - semicolons or tabs between cells and a decimal comma, or commas and a decimal point;
//   - a date and a time in one column or two, in the local time of the lab with no zone, so that the night the clocks go back an
//     hour of timestamps repeats (the second pass is put after the first, as time only goes forward) and the night they go forward
//     an hour is missing;
//   - readings that failed (ERR, NaN, a blank), which are left out and counted;
//   - words for an input's states (OPEN, CLOSED), given values;
//   - units to convert (a scale and an offset: °C to K, a percentage to watts);
//   - the header written again after a restart, skipped and counted; and the gap the restart left, noted.
//
// describeLoggerCsv(text) guesses the separator, decimal mark, columns and time format, for the card to offer as a first guess.
// new LoggerCsvReader(settings) reads a file a piece at a time (as DataLogReader does, so a file a logger is still writing can be
// followed); readLoggerCsv(text, settings) reads one whole. Settings:
//
//   { delimiter, decimal, missing: ['ERR'], source,
//     time: { columns: ['Date', 'Time'], format: 'DD.MM.YYYY HH:mm:ss', zone: 'Europe/Berlin' | 'UTC' | '+01:00' },
//     signals: [{ column, name, role: 'input' | 'output', unit, scale = 1, offset = 0, values: { OPEN: 1, CLOSED: 0 } }] }
//
// An input is passed on only when its value changes (a logger writes it on every row); a measured signal at every reading.

export class LoggerCsvError extends Error {
    constructor(line, message) {
        super(line ? `Line ${line}: ${message}` : message);
        this.name = 'LoggerCsvError';
        this.line = line;
    }
}

const defaultMissing = ['', 'ERR', 'ERROR', 'NAN', 'NaN', 'nan', 'N/A', 'NA', '-', '--', '#N/A', 'null', 'NULL', 'OVR', 'UNDER', 'OVER'];

// ---- Time formats: DD, MM, YYYY, YY, HH, mm, ss, SSS, with any separators between.

const tokenPatterns = { YYYY: '(\\d{4})', YY: '(\\d{2})', MM: '(\\d{1,2})', DD: '(\\d{1,2})', HH: '(\\d{1,2})', mm: '(\\d{2})', ss: '(\\d{2})', SSS: '(\\d{1,6})' };

function timePattern(format) {
    const order = [];
    let pattern = '';
    for (let index = 0; index < format.length;) {
        const token = ['YYYY', 'SSS', 'YY', 'MM', 'DD', 'HH', 'mm', 'ss'].find((candidate) => format.startsWith(candidate, index));
        if (token) {
            order.push(token);
            pattern += tokenPatterns[token];
            index += token.length;
        } else {
            pattern += format[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            index += 1;
        }
    }
    if (!order.includes('HH') || !(order.includes('YYYY') || order.includes('YY')) || !order.includes('MM') || !order.includes('DD')) {
        throw new LoggerCsvError(0, `The time format "${format}" needs a day, a month, a year and an hour.`);
    }
    return { regex: new RegExp(`^${pattern}$`), order };
}

function parseWallClock(text, compiled) {
    const match = compiled.regex.exec(text.trim());
    if (!match) return null;
    const parts = { YYYY: 0, MM: 1, DD: 1, HH: 0, mm: 0, ss: 0, SSS: 0 };
    compiled.order.forEach((token, index) => { parts[token === 'YY' ? 'YYYY' : token] = token === 'YY' ? 2000 + Number(match[index + 1]) : token === 'SSS' ? Number(`0.${match[index + 1]}`) * 1000 : Number(match[index + 1]); });
    if (parts.MM < 1 || parts.MM > 12 || parts.DD < 1 || parts.DD > 31 || parts.HH > 23 || parts.mm > 59 || parts.ss > 60) return null;
    return parts;
}

// ---- Time zones, from the platform's own zone data (Intl), so no table of rules is kept here.

const formatters = new Map();
function zoneFormatter(zone) {
    if (!formatters.has(zone)) {
        formatters.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
    }
    return formatters.get(zone);
}

// How far ahead of UTC a zone's wall clock is at an instant, in milliseconds.
function zoneOffset(zone, instant) {
    const fixed = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (fixed) return (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3])) * 60000;
    if (zone === 'UTC' || zone === 'Z') return 0;
    const parts = Object.fromEntries(zoneFormatter(zone).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    return asUtc - Math.floor(instant / 1000) * 1000;
}

// Every instant whose wall clock in the zone reads `parts`: one usually, two in the hour the clocks go back, none in the hour they
// go forward.
function instantsFor(parts, zone) {
    const naive = Date.UTC(parts.YYYY, parts.MM - 1, parts.DD, parts.HH, parts.mm, parts.ss) + parts.SSS;
    const offsets = new Set([zoneOffset(zone, naive - 86400000), zoneOffset(zone, naive), zoneOffset(zone, naive + 86400000)]);
    return [...offsets].map((offset) => naive - offset).filter((instant) => zoneOffset(zone, instant) === naive - instant).sort((a, b) => a - b);
}

function checkZone(zone) {
    if (/^([+-])(\d{2}):?(\d{2})$/.test(zone) || zone === 'UTC' || zone === 'Z') return;
    try {
        zoneFormatter(zone);
    } catch {
        throw new LoggerCsvError(0, `"${zone}" is not a time zone: use a name such as Europe/Berlin, UTC, or an offset such as +01:00.`);
    }
}

// ---- Cells.

function splitLine(line, delimiter) {
    // Quoted cells are rare in loggers' files but do occur; a quote doubled inside one is a quote.
    if (!line.includes('"')) return line.split(delimiter).map((cell) => cell.trim());
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quoted) {
            if (character === '"' && line[index + 1] === '"') { cell += '"'; index += 1; } else if (character === '"') quoted = false;
            else cell += character;
        } else if (character === '"') quoted = true;
        else if (character === delimiter) { cells.push(cell.trim()); cell = ''; } else cell += character;
    }
    cells.push(cell.trim());
    return cells;
}

function parseNumber(text, decimal) {
    let cleaned = text.replace(/\s/g, '');
    if (decimal === ',') cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return null;
    return Number(cleaned);
}

// ---- Guessing what a file is.

const datePatterns = [
    { regex: /^\d{4}-\d{2}-\d{2}$/, format: 'YYYY-MM-DD' }, { regex: /^\d{1,2}\.\d{1,2}\.\d{4}$/, format: 'DD.MM.YYYY' },
    { regex: /^\d{1,2}\/\d{1,2}\/\d{4}$/, format: 'DD/MM/YYYY' }, { regex: /^\d{4}\/\d{2}\/\d{2}$/, format: 'YYYY/MM/DD' }
];
const clockPatterns = [{ regex: /^\d{1,2}:\d{2}:\d{2}\.\d+$/, format: 'HH:mm:ss.SSS' }, { regex: /^\d{1,2}:\d{2}:\d{2}$/, format: 'HH:mm:ss' }, { regex: /^\d{1,2}:\d{2}$/, format: 'HH:mm' }];

function guessDate(values) {
    for (const { regex, format } of datePatterns) {
        if (!values.every((value) => regex.test(value))) continue;
        // Day and month written with slashes are told apart by a first part above 12, which only a day can be.
        if (format === 'DD/MM/YYYY' && !values.some((value) => Number(value.split('/')[0]) > 12) && values.some((value) => Number(value.split('/')[1]) > 12)) return 'MM/DD/YYYY';
        return format;
    }
    return null;
}

function guessClock(values) {
    return clockPatterns.find(({ regex }) => values.every((value) => regex.test(value)))?.format ?? null;
}

// The separator, the decimal mark, the columns with a few of their values (numeric or words), and the time columns and format.
export function describeLoggerCsv(text) {
    // The whole file (up to a limit) is looked through, not its first lines: a valve that first opens two hours in must still be
    // offered as a word to give a value.
    const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 200000);
    if (lines.length < 2) throw new LoggerCsvError(0, 'The file has fewer than two lines.');
    const counts = (line, character) => line.split(character).length - 1;
    const delimiter = ['\t', ';', ','].map((character) => ({ character, score: Math.min(...lines.slice(0, 20).map((line) => counts(line, character))) }))
        .sort((a, b) => b.score - a.score)[0];
    if (!delimiter.score) throw new LoggerCsvError(0, 'No separator between cells was found: tabs, semicolons or commas.');
    const separator = delimiter.character;
    const rows = lines.map((line) => splitLine(line, separator));
    const headerIndex = rows.findIndex((row) => row.filter((cell) => /[A-Za-z]/.test(cell) && !/^[-+]?\d/.test(cell)).length >= Math.ceil(row.length / 2));
    const header = rows[Math.max(0, headerIndex)];
    const data = rows.slice(headerIndex + 1).filter((row) => row.join(separator) !== header.join(separator) && row.length === header.length);
    const decimal = separator !== ',' && data.some((row) => row.some((cell) => /^[+-]?\d+,\d+$/.test(cell))) ? ',' : '.';
    const columns = header.map((name, index) => {
        const values = data.map((row) => row[index]);
        const present = values.filter((value) => !defaultMissing.includes(value));
        const numeric = present.filter((value) => parseNumber(value, decimal) !== null);
        const words = [...new Set(present.filter((value) => parseNumber(value, decimal) === null))].sort();
        return { name, samples: values.slice(0, 3), numeric: present.length > 0 && numeric.length === present.length, texts: words.length && words.length <= 8 && numeric.length === 0 ? words : [], missing: values.length - present.length };
    });
    let time = null;
    for (const [index, column] of columns.entries()) {
        const values = data.map((row) => row[index]).filter(Boolean);
        const date = guessDate(values);
        const next = columns[index + 1];
        const clock = next ? guessClock(data.map((row) => row[index + 1]).filter(Boolean)) : null;
        if (date && clock) { time = { columns: [column.name, next.name], format: `${date} ${clock}` }; break; }
        const combined = values.length && values.every((value) => value.includes(' ') || value.includes('T')) ? values.map((value) => value.split(/[ T]/)) : null;
        if (combined && guessDate(combined.map((parts) => parts[0])) && guessClock(combined.map((parts) => parts[1]))) {
            time = { columns: [column.name], format: `${guessDate(combined.map((parts) => parts[0]))}${values[0].includes('T') ? 'T' : ' '}${guessClock(combined.map((parts) => parts[1]))}` };
            break;
        }
    }
    return { delimiter: separator, decimal, headerLine: headerIndex + 1, columns, time };
}

// ---- Reading.

export class LoggerCsvReader {
    #settings;
    #pattern;
    #missing;
    #pending = '';
    #decoder = new TextDecoder('utf-8');
    #line = 0;
    #headings = null;
    #headingText = '';
    #columnIndex = new Map();
    #timeIndexes = [];
    #header = null;
    #epoch = null;
    #lastInstant = -Infinity;
    #lastOffset = null;
    #lastInput = new Map();
    #intervals = [];
    notes = { rows: 0, repeatedHeaders: 0, missing: 0, gaps: [], clockChanges: 0, skippedClockGap: 0 };

    constructor(settings) {
        if (!settings?.time?.columns?.length || !settings.time.format) throw new LoggerCsvError(0, 'Say which column holds the time, and how it is written.');
        if (!settings.signals?.length) throw new LoggerCsvError(0, 'Choose at least one column to read as a signal.');
        const names = new Set();
        for (const signal of settings.signals) {
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(signal.name ?? '')) throw new LoggerCsvError(0, `"${signal.name}" cannot name a signal: use letters, digits and underscores, starting with a letter.`);
            if (names.has(signal.name)) throw new LoggerCsvError(0, `Two columns are both called "${signal.name}".`);
            if (signal.role !== 'input' && signal.role !== 'output') throw new LoggerCsvError(0, `Say whether "${signal.name}" is an input or a measured signal.`);
            names.add(signal.name);
        }
        checkZone(settings.time.zone ?? 'UTC');
        this.#settings = { delimiter: ';', decimal: '.', ...settings, time: { zone: 'UTC', ...settings.time } };
        this.#pattern = timePattern(this.#settings.time.format);
        this.#missing = new Set(settings.missing ?? defaultMissing);
    }

    // The data log header these readings have, once the first row has been read (its time is the epoch); null before.
    get header() {
        return this.#header;
    }

    push(chunk) {
        // One decoder for the whole file: a character of several bytes (°) can be split between two reads.
        this.#pending += typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
        const lines = this.#pending.split('\n');
        this.#pending = lines.pop();
        return lines.flatMap((line) => this.#read(line.replace(/\r$/, '')));
    }

    // The file is finished: a last line without its newline is read too, since loggers often leave it off.
    end() {
        const rest = (this.#pending + this.#decoder.decode()).replace(/\r$/, '');
        this.#pending = '';
        const last = rest.trim() ? this.#read(rest) : [];
        if (!this.#headings) throw new LoggerCsvError(this.#line, 'The file ended before its column headings.');
        return last;
    }

    #read(line) {
        this.#line += 1;
        if (!line.trim()) return [];
        const cells = splitLine(line, this.#settings.delimiter);
        if (!this.#headings) {
            const wanted = [...this.#settings.time.columns, ...this.#settings.signals.map((signal) => signal.column)];
            if (!wanted.every((name) => cells.includes(name))) return []; // a title or comment above the headings
            this.#headings = cells;
            this.#headingText = cells.join('\u0000');
            cells.forEach((name, index) => { if (!this.#columnIndex.has(name)) this.#columnIndex.set(name, index); });
            this.#timeIndexes = this.#settings.time.columns.map((name) => this.#columnIndex.get(name));
            return [];
        }
        if (cells.join('\u0000') === this.#headingText) {
            this.notes.repeatedHeaders += 1;
            return [];
        }
        if (cells.length < this.#headings.length) throw new LoggerCsvError(this.#line, `The row has ${cells.length} cells and the headings have ${this.#headings.length}.`);
        const instant = this.#instant(cells);
        if (instant === null) return [];
        this.notes.rows += 1;
        if (this.#epoch === null) {
            this.#epoch = instant;
            this.#header = Object.freeze({
                version: 1, source: this.#settings.source ?? 'Logger CSV', epoch: instant,
                signals: Object.freeze(this.#settings.signals.map(({ name, unit = '', role }) => ({ name, unit, role })))
            });
        }
        const time = (instant - this.#epoch) / 1000;
        const observations = [];
        for (const signal of this.#settings.signals) {
            const cell = cells[this.#columnIndex.get(signal.column)] ?? '';
            let value;
            if (signal.values && Object.hasOwn(signal.values, cell)) value = Number(signal.values[cell]);
            else if (this.#missing.has(cell)) {
                this.notes.missing += 1;
                continue;
            } else {
                value = parseNumber(cell, this.#settings.decimal);
                if (value === null) throw new LoggerCsvError(this.#line, `"${cell}" in ${signal.column} is not a number${signal.values ? ' or one of the words given values' : ''}.`);
            }
            value = value * (signal.scale ?? 1) + (signal.offset ?? 0);
            if (signal.role === 'input') {
                if (this.#lastInput.get(signal.name) === value) continue;
                this.#lastInput.set(signal.name, value);
            }
            observations.push({ time, signal: signal.name, value, quality: 'good', revision: 0 });
        }
        return observations;
    }

    // The row's instant in UTC milliseconds, from its local wall clock: in the hour the clocks go back, the pass that keeps time
    // moving forward; in the hour they go forward, which no clock shows, the reading is left out.
    #instant(cells) {
        const text = this.#timeIndexes.map((index) => cells[index] ?? '').join(' ');
        const parts = parseWallClock(text, this.#pattern);
        if (!parts) throw new LoggerCsvError(this.#line, `"${text}" is not a time written as ${this.#settings.time.format}.`);
        const zone = this.#settings.time.zone;
        const candidates = instantsFor(parts, zone);
        if (!candidates.length) {
            this.notes.skippedClockGap += 1;
            return null;
        }
        const instant = candidates.find((candidate) => candidate >= this.#lastInstant) ?? candidates.at(-1);
        if (instant < this.#lastInstant) throw new LoggerCsvError(this.#line, `${text} is earlier than the row before it: a logger's rows go forward in time.`);
        const offset = zoneOffset(zone, instant);
        if (this.#lastOffset !== null && offset !== this.#lastOffset) this.notes.clockChanges += 1;
        this.#lastOffset = offset;
        if (Number.isFinite(this.#lastInstant)) {
            const interval = (instant - this.#lastInstant) / 1000;
            const typical = this.#intervals.length >= 10 ? [...this.#intervals].sort((a, b) => a - b)[this.#intervals.length >> 1] : null;
            if (typical !== null && interval > Math.max(60, 10 * typical)) {
                this.notes.gaps.push({ from: (this.#lastInstant - this.#epoch) / 1000, to: (instant - this.#epoch) / 1000 });
            } else if (this.#intervals.length < 50) this.#intervals.push(interval);
        }
        this.#lastInstant = instant;
        return instant;
    }
}

// A whole file: its header, every observation, and what was noticed on the way (rows, repeated headers, missing readings, gaps,
// changes of clock).
export function readLoggerCsv(text, settings) {
    const reader = new LoggerCsvReader(settings);
    const observations = [...reader.push(text), ...reader.end()];
    if (!reader.header) throw new LoggerCsvError(0, 'No rows were read: check the columns chosen and the time format.');
    return { header: reader.header, observations, notes: reader.notes };
}
