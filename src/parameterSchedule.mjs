/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A shared parameter's stored schedule, `{ interpolation: "linear" | "hold", samples: [[time, value], ...] }` (see
// docs/projectSchema.md), as the canvas edits it: written as text, one sample per line, so a column pair pasted from a
// spreadsheet or a CSV file is a schedule as it stands. Pure functions.

export const scheduleInterpolations = Object.freeze(['linear', 'hold']);

// The ways a live parameter can be scheduled, with the number each has in protocol/engineProtocol.proto
// (ParameterScheduleMode). The one list the command encoder, the adapter's checks and the controls read from.
export const scheduleModeNumbers = Object.freeze({ step: 1, ramp: 2, pulse: 3, piecewise: 4, waveform: 5 });

// What the engine could always do, for an engine that does not report its own list (one from before waveforms).
export const originalScheduleModes = Object.freeze(['step', 'ramp', 'pulse']);

// The waveform shapes, with their WaveformShape numbers in the same file, and what each is called on screen.
export const waveformShapes = Object.freeze({
    sine: { number: 1, label: 'Sine' },
    square: { number: 2, label: 'Square' },
    triangle: { number: 3, label: 'Triangle' },
    sawtooth: { number: 4, label: 'Sawtooth' },
    noise: { number: 5, label: 'Noise' }
});

// splitmix64 on BigInts, the same mixing as engine/src/executionPlan.cpp's mixBits(), so noise previews as the engine will draw it.
const bits64 = (1n << 64n) - 1n;
function mixBits(input) {
    let value = (input + 0x9E3779B97F4A7C15n) & bits64;
    value = ((value ^ (value >> 30n)) * 0xBF58476D1CE4E5B9n) & bits64;
    value = ((value ^ (value >> 27n)) * 0x94D049BB133111EBn) & bits64;
    return value ^ (value >> 31n);
}

// A waveform's value `elapsed` seconds after it starts, around `baseValue`. This is a second copy of the engine's
// evaluateParameterSchedule() (engine/src/executionPlan.cpp), which is the truth and is what a run uses: it exists so a
// control can draw the waveform before it is started, and tests/engine/parameterWaveforms.mjs compares the two against a
// real run for every shape, so they cannot drift apart unnoticed. `duration` is how long it lasts, 0 for the rest of the run.
export function waveformValue({ shape, amplitude, frequency, phaseDegrees = 0, dutyCycle = 0, seed = 0, duration = 0 }, baseValue, elapsed) {
    if (elapsed < 0 || (duration > 0 && elapsed >= duration)) return baseValue;
    let unit;
    if (shape === 'noise') {
        const index = BigInt(Math.floor(elapsed * frequency));
        unit = Number(mixBits(BigInt(seed) ^ mixBits(index)) >> 11n) * (2 / 9007199254740992) - 1;
    } else {
        const cycles = elapsed * frequency + phaseDegrees / 360;
        const fraction = cycles - Math.floor(cycles);
        if (shape === 'sine') unit = Math.sin(2 * Math.PI * cycles);
        else if (shape === 'square') unit = fraction < (dutyCycle > 0 ? dutyCycle : 0.5) ? 1 : -1;
        else if (shape === 'triangle') unit = fraction < 0.25 ? 4 * fraction : fraction < 0.75 ? 2 - 4 * fraction : 4 * fraction - 4;
        else unit = 2 * (fraction + 0.5 - Math.floor(fraction + 0.5)) - 1;
    }
    return baseValue + amplitude * unit;
}

// What to draw for a waveform before it is started: its values over the window that shows it best (the duration if it has
// one, otherwise a couple of periods, or a few dozen draws of noise), the same window for the time axis, and the lowest
// and highest the waveform can reach. Returns null while the waveform is not a sound one.
export function waveformPreview(waveform, baseValue, pointCount = 240) {
    if (waveformProblem(waveform)) return null;
    const { shape, frequency, duration = 0 } = waveform;
    const natural = shape === 'noise' ? 24 / frequency : frequency > 0 ? 2 / frequency : 1;
    const window = duration > 0 ? duration : natural;
    const values = Array.from({ length: pointCount }, (_, index) => {
        const time = (window * index) / (pointCount - 1);
        // Just inside the end of the window, which the waveform has already left by then.
        return waveformValue(waveform, baseValue, Math.min(time, window * (1 - 1e-9)));
    });
    return { window, values, low: baseValue - waveform.amplitude, high: baseValue + waveform.amplitude };
}

// A waveform as a person sets it: a shape, a peak deviation from the parameter's value, how often it repeats (Hz) and
// where in its cycle it starts (degrees); square also a duty cycle and noise a seed (so the same run can be repeated).
// Returns what is wrong with it, or null.
export function waveformProblem(schedule) {
    if (!(schedule?.shape in waveformShapes)) return 'Choose a waveform shape.';
    const { amplitude, frequency, phaseDegrees = 0, dutyCycle = 0, seed = 0, duration = 0 } = schedule;
    if (!Number.isFinite(amplitude) || amplitude < 0) return 'The amplitude must be a number, zero or more.';
    if (!Number.isFinite(frequency) || frequency < 0) return 'The frequency must be a number, zero or more.';
    if (schedule.shape === 'noise' && !(frequency > 0)) return 'Noise needs a frequency above zero: how many new values it draws each second.';
    if (!Number.isFinite(phaseDegrees)) return 'The phase must be a number of degrees.';
    if (!Number.isFinite(dutyCycle) || dutyCycle < 0 || dutyCycle >= 1) return 'The duty cycle must be at least 0 and below 1.';
    if (!Number.isSafeInteger(seed) || seed < 0) return 'The seed must be a whole number, zero or more.';
    if (!Number.isFinite(duration) || duration < 0) return 'The duration must be a number, zero or more.';
    return null;
}

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
