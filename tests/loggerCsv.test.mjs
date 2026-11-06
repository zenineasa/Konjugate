/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Reading a lab logger's own CSV (src/loggerCsv.mjs): the things real loggers do, one test each.

import assert from 'node:assert/strict';
import test from 'node:test';
import { describeLoggerCsv, LoggerCsvError, LoggerCsvReader, readLoggerCsv } from '../src/loggerCsv.mjs';

const berlin = {
    delimiter: ';', decimal: ',', missing: ['ERR'],
    time: { columns: ['Datum', 'Uhrzeit'], format: 'DD.MM.YYYY HH:mm:ss', zone: 'Europe/Berlin' },
    signals: [{ column: 'T (°C)', name: 'temperature', role: 'output', unit: 'K', offset: 273.15 }, { column: 'Ventil', name: 'valve', role: 'input', unit: '-', values: { OPEN: 1, CLOSED: 0 } }]
};
const file = (...rows) => ['Datum;Uhrzeit;T (°C);Ventil', ...rows].join('\r\n') + '\r\n';

test('local time is put on UTC, and the hour the clocks go back is put in order, not folded on itself', () => {
    // 02:30 happens twice in Berlin on 25 October 2026: first in summer time (00:30 UTC), then in winter time (01:30 UTC).
    const { header, observations, notes } = readLoggerCsv(file(
        '25.10.2026;02:00:00;20,0;CLOSED', '25.10.2026;02:30:00;20,5;CLOSED', '25.10.2026;02:59:59;21,0;CLOSED',
        '25.10.2026;02:00:00;21,5;CLOSED', '25.10.2026;02:30:00;22,0;CLOSED'
    ), berlin);
    assert.equal(header.epoch, Date.parse('2026-10-25T00:00:00Z'));
    assert.deepEqual(observations.filter((o) => o.signal === 'temperature').map((o) => o.time), [0, 1800, 3599, 3600, 5400]);
    assert.equal(notes.clockChanges, 1);
});

test('the hour the clocks go forward has no readings to put anywhere, and one written in it is left out and counted', () => {
    const { observations, notes } = readLoggerCsv(file('29.03.2026;01:59:00;20,0;CLOSED', '29.03.2026;02:30:00;20,5;CLOSED', '29.03.2026;03:01:00;21,0;CLOSED'), berlin);
    assert.deepEqual(observations.filter((o) => o.signal === 'temperature').map((o) => o.time), [0, 120]);
    assert.equal(notes.skippedClockGap, 1);
});

test('decimal commas, units converted, words given values, and an input passed on only when it changes', () => {
    const { observations } = readLoggerCsv(file('01.06.2026;12:00:00;20,25;CLOSED', '01.06.2026;12:00:05;20,30;CLOSED', '01.06.2026;12:00:10;20,35;OPEN'), berlin);
    assert.deepEqual(observations.map(({ time, signal, value }) => [time, signal, Number(value.toFixed(2))]), [
        [0, 'temperature', 293.4], [0, 'valve', 0], [5, 'temperature', 293.45], [10, 'temperature', 293.5], [10, 'valve', 1]
    ]);
});

test('a failed reading is left out and counted; a header written again after a restart is skipped; a gap is noted', () => {
    const rows = [];
    for (let second = 0; second < 120; second += 5) rows.push(`01.06.2026;12:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')};${second === 30 ? 'ERR' : '20,0'};CLOSED`);
    rows.push('Datum;Uhrzeit;T (°C);Ventil', '01.06.2026;12:10:00;20,0;CLOSED');
    const { notes, observations } = readLoggerCsv(file(...rows), berlin);
    assert.equal(notes.missing, 1);
    assert.equal(notes.repeatedHeaders, 1);
    assert.deepEqual(notes.gaps, [{ from: 115, to: 600 }]);
    assert.equal(observations.filter((o) => o.signal === 'temperature').length, rows.length - 2);
});

test('a title above the headings, quoted cells and a last line with no newline are all read', () => {
    const text = 'Logger 7 export\r\n"Datum";"Uhrzeit";"T (°C)";"Ventil"\r\n"01.06.2026";"12:00:00";"20,0";"CLOSED"\r\n01.06.2026;12:00:05;20,5;OPEN';
    assert.equal(readLoggerCsv(text, berlin).observations.length, 4);
});

test('read a piece at a time, as while following, it gives what reading it whole gives, a character split between pieces included', () => {
    const text = file('01.06.2026;12:00:00;20,0;CLOSED', '01.06.2026;12:00:05;20,5;OPEN', '01.06.2026;12:00:10;21,0;OPEN');
    const whole = readLoggerCsv(text, berlin).observations;
    const bytes = new TextEncoder().encode(text);
    const reader = new LoggerCsvReader(berlin);
    const pieces = [];
    for (let at = 0; at < bytes.length; at += 3) pieces.push(...reader.push(bytes.slice(at, at + 3)));
    pieces.push(...reader.end());
    assert.deepEqual(pieces, whole);
});

test('what cannot be read is refused with the line and the reason', () => {
    assert.throws(() => readLoggerCsv(file('01.06.2026;12:00:00;warm;CLOSED'), berlin), (error) => error instanceof LoggerCsvError && error.line === 2 && /"warm" in T \(°C\) is not a number/.test(error.message));
    assert.throws(() => readLoggerCsv(file('01.06.2026;12:00:00;20;AJAR'), berlin), /"AJAR" in Ventil is not a number or one of the words given values/);
    assert.throws(() => readLoggerCsv(file('2026-06-01;12:00:00;20;CLOSED'), berlin), /is not a time written as DD\.MM\.YYYY HH:mm:ss/);
    assert.throws(() => readLoggerCsv(file('01.06.2026;12:00:05;20;CLOSED', '01.06.2026;12:00:00;20;CLOSED'), berlin), /earlier than the row before it/);
    assert.throws(() => new LoggerCsvReader({ ...berlin, time: { ...berlin.time, zone: 'Mars/Olympus' } }), /is not a time zone/);
    assert.throws(() => new LoggerCsvReader({ ...berlin, signals: [{ ...berlin.signals[0], name: 'T (°C)' }] }), /cannot name a signal/);
});

test('a file is described: its separator, decimal mark, columns, the words a column uses anywhere in it, and its time format', () => {
    const rows = Array.from({ length: 500 }, (_, index) => `0${1 + Math.floor(index / 300)}.06.2026;12:${String(Math.floor(index / 12) % 60).padStart(2, '0')}:${String((index * 5) % 60).padStart(2, '0')};20,${index % 10};${index > 450 ? 'OPEN' : 'CLOSED'}`);
    const described = describeLoggerCsv(file(...rows));
    assert.equal(described.delimiter, ';');
    assert.equal(described.decimal, ',');
    assert.deepEqual(described.time, { columns: ['Datum', 'Uhrzeit'], format: 'DD.MM.YYYY HH:mm:ss' });
    assert.deepEqual(described.columns.find((column) => column.name === 'Ventil').texts, ['CLOSED', 'OPEN'], 'A word that first appears late in the file is still offered.');
    assert.equal(described.columns.find((column) => column.name === 'T (°C)').numeric, true);
    // Month first when a second part above twelve says so; one column holding both date and time; commas and points.
    const american = describeLoggerCsv('Time,Level\n06/13/2026 08:00:00,1.5\n06/14/2026 08:00:00,1.6\n');
    assert.deepEqual(american.time, { columns: ['Time'], format: 'MM/DD/YYYY HH:mm:ss' });
    assert.equal(american.decimal, '.');
    assert.deepEqual(describeLoggerCsv('Stamp\tP\n2026-06-01T08:00:00\t3\n2026-06-01T08:00:01\t4\n').time, { columns: ['Stamp'], format: 'YYYY-MM-DDTHH:mm:ss' });
});
