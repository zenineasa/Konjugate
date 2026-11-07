/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The text of a Konjugate data log (docs/connectingADataSource.md), with nothing that needs a file system: the description and
// headings, and one line per row. src/dataLogWriter.mjs appends these to a file; the project window uses them to hand another
// logger's table, as the tuning card read it, to the twin's window in Konjugate's own form.

const number = (value) => String(Number(value.toPrecision(12)));

// The description and headings of a log with these signals.
export function headingLines({ source = '', epoch, signals }) {
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
export function rowLines(signals, observations) {
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
