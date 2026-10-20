/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A shared parameter's stored schedule, `{ interpolation: "linear" | "hold", samples: [[time, value], ...] }` (see
// docs/projectSchema.md), as the canvas edits it: written as text, one sample per line, so a column pair pasted from a
// spreadsheet or a CSV file is a schedule as it stands. Pure functions.

export const scheduleInterpolations = Object.freeze(['linear', 'hold']);

// "time, value" per line; a comma, semicolon, tab or spaces between the two. Blank lines are skipped, and so is a first
// line that is not two numbers (a header). Returns { samples } or { error, line }.
export function parseScheduleText(text) {
    const samples = [];
    const lines = String(text ?? '').split(/\r?\n/);
    for (const [index, raw] of lines.entries()) {
        const line = raw.trim();
        if (!line) continue;
        const parts = line.split(/\s*[,;\t]\s*|\s+/).filter(Boolean);
        const numbers = parts.map(Number);
        const isSample = parts.length === 2 && numbers.every(Number.isFinite);
        if (!isSample) {
            if (!samples.length && index === lines.findIndex((candidate) => candidate.trim())) continue;
            return { error: `Line ${index + 1} is not a time and a value: "${line}".`, line: index + 1 };
        }
        samples.push(numbers);
    }
    return { samples };
}

export function scheduleText(samples = []) {
    return samples.map(([time, value]) => `${time}, ${value}`).join('\n');
}

// Why a schedule cannot be stored, or '' when it can: the engine's own rules (parameterScheduleInvalid).
export function scheduleError(schedule) {
    if (!scheduleInterpolations.includes(schedule?.interpolation)) return 'Choose how the value goes between samples.';
    const samples = schedule.samples ?? [];
    if (!samples.length) return 'Add at least one sample: a time and a value.';
    for (const [index, sample] of samples.entries()) {
        if (!Array.isArray(sample) || sample.length !== 2 || !sample.every(Number.isFinite)) return `Sample ${index + 1} is not a time and a value.`;
        if (index && !(sample[0] > samples[index - 1][0])) return `The times must increase: sample ${index + 1} (t = ${sample[0]}) is not after sample ${index} (t = ${samples[index - 1][0]}).`;
    }
    return '';
}

// One line saying what a schedule does, for showing beside it.
export function scheduleSummary(schedule) {
    const samples = schedule?.samples ?? [];
    if (!samples.length) return 'No samples yet.';
    const values = samples.map((sample) => sample[1]);
    const how = schedule.interpolation === 'hold' ? 'each value held until the next sample' : 'linearly interpolated';
    return `${samples.length} sample${samples.length === 1 ? '' : 's'}, ${how}, from t = ${samples[0][0]} to ${samples.at(-1)[0]}, values ${Math.min(...values)} to ${Math.max(...values)}; before the first and after the last, the nearest sample's value holds.`;
}
