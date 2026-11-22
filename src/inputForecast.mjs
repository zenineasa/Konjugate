/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How an input is carried past now in a live twin's forecast (docs/proposals/predictionActualWindow.md, "The inputs in the forecast").
// An input has no readings past now, so the forecast assumes something about it: by default that it holds its last reading. The other
// choices read the input's own past, as the engine holds it: each reading held until the next, which is also how a controller logs
// an input that changes in steps (a reading at each change). So an average and a trend are taken over that held signal, weighted by
// time, never over the readings as points.
//
//   hold        its last reading, as the forecast always did
//   mean        its average over the span: a thermostat's heater, switched back and forth, at about the power it draws over an hour
//   trend       a line fitted over the span, carried on from the last reading, damped (it levels off) and clamped to the input's limits
//   trend2      the same with a parabola: an input rising and levelling off
//   day         what it did one period ago (a day by default), moved to start from where it is now
//   automatic   hold, mean or trend, by what the span shows: steps, a back-and-forth, or a ramp; then by the score
//   plan        a programme in clock time, repeated daily or weekly: a thermostat's setpoints, a shift pattern
//   model       a state of the model the input follows past now: a controller in the model taking over from the readings (the
//               engine follows it, src/windowSession.mjs; nothing is projected here)
//
// A projection is the samples to give the engine past now ([{ time, value }], held between them, as its input schedules are); none
// means the last reading holds.

export const forecastChoices = Object.freeze(['hold', 'mean', 'trend', 'trend2', 'day', 'automatic', 'plan', 'model']);
export const forecastLabels = Object.freeze({
    hold: 'Hold', mean: 'Hold the average', trend: 'Follow the trend', trend2: 'Follow the trend, second order', day: 'Repeat the last day', automatic: 'Automatic',
    plan: 'From a plan', model: 'From the model'
});
// The choices made from the input's own past, which Automatic chooses among and every move scores; a plan and the model need more
// than the past, and are scored only where they are set up.
export const pastChoices = Object.freeze(['hold', 'mean', 'trend', 'trend2', 'day']);

const gridPoints = 100; // points the held signal is read at over a span, for an average or a fit
const mostSamples = 200; // samples a projection gives the engine over the horizon

// The value held at a time: the last reading at or before it (readings in time order), or null before the first.
export function heldAt(readings, time) {
    let low = 0;
    let high = readings.length - 1;
    if (high < 0 || readings[0].time > time + 1e-9) return null;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (readings[middle].time <= time + 1e-9) low = middle;
        else high = middle - 1;
    }
    return readings[low].value;
}

// The held signal over [from, to], at the middles of `count` equal parts: [[time, value]].
function heldGrid(readings, from, to, count = gridPoints) {
    const step = (to - from) / count;
    return Array.from({ length: count }, (_, index) => {
        const time = from + (index + 0.5) * step;
        return [time, heldAt(readings, time)];
    }).filter(([, value]) => value !== null);
}

// Least squares of a polynomial of `degree` (1 or 2) through [[x, y]]: its coefficients [a, b, c] (c = 0 for a line), and the root
// mean square of what it leaves.
export function fitPolynomial(points, degree) {
    const size = degree + 1;
    const matrix = Array.from({ length: size }, () => new Array(size + 1).fill(0));
    for (const [x, y] of points) {
        const powers = [1, x, x * x].slice(0, size);
        for (let row = 0; row < size; row += 1) {
            for (let column = 0; column < size; column += 1) matrix[row][column] += powers[row] * powers[column];
            matrix[row][size] += powers[row] * y;
        }
    }
    // Gaussian elimination with partial pivoting; a singular system (every x the same) leaves the higher terms at 0.
    for (let column = 0; column < size; column += 1) {
        let pivot = column;
        for (let row = column + 1; row < size; row += 1) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
        [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
        if (Math.abs(matrix[column][column]) < 1e-12) continue;
        for (let row = 0; row < size; row += 1) {
            if (row === column) continue;
            const factor = matrix[row][column] / matrix[column][column];
            for (let entry = column; entry <= size; entry += 1) matrix[row][entry] -= factor * matrix[column][entry];
        }
    }
    const coefficients = matrix.map((row, index) => (Math.abs(row[index]) < 1e-12 ? 0 : row[size] / row[index]));
    while (coefficients.length < 3) coefficients.push(0);
    const residual = points.length ? Math.sqrt(points.reduce((sum, [x, y]) => sum + (y - coefficients[0] - coefficients[1] * x - coefficients[2] * x * x) ** 2, 0) / points.length) : 0;
    return { coefficients, residual };
}

const clamp = (value, limits) => Math.min(limits?.maximum ?? Infinity, Math.max(limits?.minimum ?? -Infinity, value));

// The times a projection gives samples at past now: a time step apart, or further when that would be more than `mostSamples`.
function sampleTimes(now, horizon, timeStep) {
    const every = Math.max(1, Math.ceil(horizon / mostSamples / timeStep - 1e-9)) * timeStep;
    const count = Math.max(1, Math.ceil(horizon / every - 1e-9));
    return { every, times: Array.from({ length: count }, (_, index) => now + (index + 1) * every).filter((time) => time <= now + horizon + 1e-9) };
}

// What the span shows of an input: its changes (readings that differ from the value before them by more than the resolution), how
// often they turned back, the share of them going the way a fitted line goes, and how far that line moves over the span against
// the scatter about it. Automatic chooses from these.
export function describeSpan(readings, { now, span, resolution }) {
    const from = Math.max(now - span, readings[0]?.time ?? now);
    let previous = heldAt(readings, from);
    const directions = [];
    for (const reading of readings) {
        if (reading.time <= from + 1e-9 || reading.time > now + 1e-9) continue;
        if (previous !== null && Math.abs(reading.value - previous) > resolution) directions.push(Math.sign(reading.value - previous));
        previous = reading.value;
    }
    const reversals = directions.slice(1).filter((direction, index) => direction !== directions[index]).length;
    const length = now - from;
    const fit = length > 0 ? fitPolynomial(heldGrid(readings, from, now).map(([time, value]) => [(time - now) / length, value]), 1) : { coefficients: [0, 0, 0], residual: 0 };
    const rise = fit.coefficients[1]; // over the whole span, since time is in spans
    const along = directions.length ? directions.filter((direction) => direction === Math.sign(rise)).length / directions.length : 0;
    return { changes: directions.length, reversals, along, rise, residual: fit.residual, length };
}

// Automatic, with why in a person's words: an input that has not changed, or has changed only one way in a step or three, is held; a
// ramp (four changes or more, two in three of them one way, moving further than it scatters) is followed; one that has gone back to
// where it was is held at its average, since it may well go back again within the horizon: a thermostat switching a heater on and off
// once or twice an hour is that, as is an operator who raised a setting and lowered it again.
export function automaticChoice(readings, options) {
    const seen = describeSpan(readings, options);
    if (!seen.changes) return { using: 'hold', reason: 'steady: no change in the span' };
    if (seen.changes >= 4 && Math.abs(seen.rise) > 2 * seen.residual && seen.along >= 2 / 3) return { using: 'trend', reason: `ramping: ${seen.changes} changes, ${Math.round(seen.along * 100)}% of them one way` };
    if (seen.reversals >= 1) return { using: 'mean', reason: `cycling: ${seen.changes} change${seen.changes === 1 ? '' : 's'}, back and forth` };
    return { using: 'hold', reason: `stepping: ${seen.changes} change${seen.changes === 1 ? '' : 's'} in the span, one way, held between` };
}

// Projections scored before Automatic goes by the score rather than by what the span shows.
export const scoredAfter = 6;

// Automatic, once its input's projections have been scored often enough: the choice whose projections came closest to what arrived
// (Hold on a tie), with the figures that say so. The rules above are only for the start, before there is a score: on the house they
// held a heater that had just switched on for the whole hour, and came out no better than holding (tests/engine/twinInputForecast.mjs).
export function scoredChoice(score) {
    if (!(score?.projections >= scoredAfter)) return null;
    let best = 'hold';
    for (const choice of forecastChoices) {
        if (!pastChoices.includes(choice) || !Number.isFinite(score.error[choice])) continue;
        if (score.error[choice] < score.error[best] - 1e-12 * Math.abs(score.error[best])) best = choice;
    }
    const figure = (value) => Number(value.toPrecision(3));
    return {
        using: best,
        reason: best === 'hold' ? `holding has been closest over ${score.projections} forecasts (missed by ${figure(score.error.hold)})`
            : `${forecastLabels[best].toLowerCase()} has been closest over ${score.projections} forecasts (missed by ${figure(score.error[best])}, holding by ${figure(score.error.hold)})`
    };
}

// The score beside an input in the Engineer view, in words: over how many forecasts, the choice that came closest to what then arrived,
// against holding. A choice within rounding of holding is no closer (a flat signal's second-order trend, off by 1e-13, is not "1×
// closer"), and one that missed by nothing beside holding (a plan that is the operator's own, exactly) matched what arrived, said with no
// ratio (not "410000000000000× closer"). score: { projections, error: { choice: root mean square } }; figure: a value with its unit.
export function scoreSentence(score, figure = (value) => String(Number(value.toPrecision(3)))) {
    const over = `Over ${score.projections} forecast${score.projections === 1 ? '' : 's'}`;
    const hold = score.error.hold;
    const [best, error] = Object.entries(score.error).filter(([choice, value]) => choice !== 'hold' && choice !== 'automatic' && Number.isFinite(value))
        .sort((a, b) => a[1] - b[1])[0] ?? [];
    if (!best || !(error < hold * (1 - 1e-3))) return `${over}, holding has been closest (missed by ${figure(hold)}).`;
    const name = forecastLabels[best].toLowerCase();
    if (error <= 1e-3 * hold) return `${over}, ${name} matched what arrived (missed by ${figure(0)}, against ${figure(hold)} for holding).`;
    const ratio = hold / error;
    return `${over}, ${name} would have been ${ratio < 1.1 ? ratio.toFixed(2) : Number(ratio.toPrecision(2))}× closer than holding (${figure(error)} against ${figure(hold)}).`;
}

// The projection of one input past now. readings: its good readings up to now, in time order. settings: { choice, span, damping,
// period }; context: { now, horizon, timeStep, limits: { minimum, maximum } | null, resolution, score: how each choice has done for
// this input so far ({ projections, error: { choice: root mean square } }) }. Returns { choice, using, reason, samples }: `using` the
// choice that made the samples (Automatic's pick, or Hold where a choice cannot be made yet, with why).
export function projectInput(readings, settings, context) {
    const { now, horizon, timeStep, limits = null } = context;
    const choice = settings.choice ?? 'hold';
    const span = settings.span > 0 ? settings.span : horizon;
    const last = readings.at(-1);
    const result = (using, samples = [], reason = '') => ({ choice, using, reason, samples });
    if (!last) return result('hold', [], 'no reading yet');
    let using = choice;
    let reason = '';
    if (choice === 'automatic') {
        const resolution = context.resolution > 0 ? context.resolution : 1e-9 * Math.max(1, Math.abs(last.value));
        ({ using, reason } = scoredChoice(context.score) ?? automaticChoice(readings, { now, span, resolution }));
    }
    if (using === 'hold') return result('hold', [], reason);
    if (using === 'plan') {
        const plan = settings.plan;
        if (!plan?.points?.length) return result('hold', [], 'no plan given');
        if (context.clock === null || context.clock === undefined) return result('hold', [], 'the source gives no clock time to follow a plan by');
        return result('plan', planSamples(plan, { now, horizon, timeStep, clock: context.clock, limits }), reason);
    }
    const from = Math.max(now - span, readings[0].time);
    if (!(now - from > 0)) return result('hold', [], 'not enough of its past yet');
    if (using === 'mean') {
        const grid = heldGrid(readings, from, now);
        const mean = grid.reduce((sum, [, value]) => sum + value, 0) / grid.length;
        return result('mean', [{ time: now + timeStep, value: mean }], reason);
    }
    const { every, times } = sampleTimes(now, horizon, timeStep);
    if (using === 'trend' || using === 'trend2') {
        const length = now - from;
        const { coefficients } = fitPolynomial(heldGrid(readings, from, now).map(([time, value]) => [(time - now) / length, value]), using === 'trend2' ? 2 : 1);
        // Per second and per second squared, from the fit in spans.
        const slope = coefficients[1] / length;
        const curvature = coefficients[2] / (length * length);
        const damping = settings.damping > 0 ? settings.damping : horizon;
        const value = (time) => {
            const ahead = time - now + every / 2;
            const shortened = damping * (1 - Math.exp(-ahead / damping));
            return clamp(last.value + slope * shortened + curvature * shortened * shortened, limits);
        };
        return result(using, times.map((time) => ({ time, value: value(time) })), reason);
    }
    if (using === 'day') {
        const period = settings.period > 0 ? settings.period : 86400;
        const then = heldAt(readings, now - period);
        if (then === null) return result('hold', [], `holding until it has a period (${period / 3600} h) of readings`);
        const offset = last.value - then;
        // The readings a period back, moved on by the period and up by how far the input now stands from where it stood then: the
        // value held at the first step, then each change as it came.
        const samples = [{ time: now + timeStep, value: clamp(heldAt(readings, now + timeStep - period) + offset, limits) }];
        for (const reading of readings) {
            const time = reading.time + period;
            if (time <= samples.at(-1).time + 1e-9 || time > now + horizon + 1e-9) continue;
            samples.push({ time, value: clamp(reading.value + offset, limits) });
        }
        return result('day', samples, reason);
    }
    return result('hold', [], `"${choice}" is not a forecast choice`);
}

// ---- Plans --------------------------------------------------------------------------------------------------------------------
// A plan: { repeat: 'daily' | 'weekly', timeZone, points: [{ day (0 Monday to 6 Sunday, weekly only), at (seconds into the day),
// value }] }, each value held from its time until the next point's, round the day or the week. Times are the plant's clock in its
// time zone (an IANA name; the computer's when the plan was written, kept with it so the plan means the same anywhere).

const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// How far a time zone's clock is ahead of UTC at an instant, in seconds.
export function zoneOffset(epochSeconds, timeZone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(Math.floor(epochSeconds) * 1000)).map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) / 1000;
    return asUtc - Math.floor(epochSeconds);
}

const period = (plan) => (plan.repeat === 'weekly' ? 7 * 86400 : 86400);
const placeOf = (plan, point) => (plan.repeat === 'weekly' ? (point.day ?? 0) * 86400 : 0) + point.at;
// Where in its day (or week, from Monday) a clock time falls. 1 January 1970 was a Thursday.
const phaseOf = (plan, wallSeconds) => {
    const length = period(plan);
    const shifted = plan.repeat === 'weekly' ? wallSeconds + 3 * 86400 : wallSeconds;
    return ((shifted % length) + length) % length;
};

// The plan's value at a point of its day or week: the last point at or before it, round from the end.
function planValueAt(plan, phase) {
    const sorted = [...plan.points].sort((a, b) => placeOf(plan, a) - placeOf(plan, b));
    return (sorted.filter((point) => placeOf(plan, point) <= phase + 1e-9).at(-1) ?? sorted.at(-1)).value;
}

// The samples a plan gives past now: its value a step after now, then each of its changes within the horizon. `clock(time)` is the
// twin's time as seconds since 1970 (UTC); the zone's offset is taken at now and held over the horizon.
export function planSamples(plan, { now, horizon, timeStep, clock, limits = null }) {
    const offset = zoneOffset(clock(now), plan.timeZone ?? 'UTC');
    const phaseAt = (time) => phaseOf(plan, clock(time) + offset);
    const first = now + timeStep;
    const samples = [{ time: first, value: clamp(planValueAt(plan, phaseAt(first)), limits) }];
    const length = period(plan);
    const changes = [];
    for (const point of plan.points) {
        let time = first + ((placeOf(plan, point) - phaseAt(first)) % length + length) % length;
        for (; time <= now + horizon + 1e-9; time += length) if (time > first + 1e-9) changes.push(time);
    }
    for (const time of [...new Set(changes.map((change) => Number(change.toFixed(6))))].sort((a, b) => a - b)) {
        samples.push({ time, value: clamp(planValueAt(plan, phaseAt(time)), limits) });
    }
    return samples;
}

// A plan as a person writes it, one point to a line or between commas: "06:30 21" for a day, "Mon 06:30 21" for a week. Returns
// { points } or { error }, in the order written; the values as written (the caller converts their unit).
export function parsePlan(text, repeat = 'daily') {
    const entries = String(text ?? '').split(/[\n,;]+/).map((entry) => entry.trim()).filter(Boolean);
    if (!entries.length) return { error: 'Write the plan as a time and a value, one to a line: 06:30 21.' };
    const points = [];
    for (const entry of entries) {
        const match = entry.match(/^(?:([A-Za-z]{3})[a-z]*\s+)?(\d{1,2}):(\d{2})\s+(-?\d+(?:\.\d+)?(?:e-?\d+)?)$/i);
        if (!match) return { error: `"${entry}" is not a time and a value${repeat === 'weekly' ? ' after a day (Mon 06:30 21)' : ' (06:30 21)'}.` };
        const [, dayText, hours, minutes, value] = match;
        const day = dayText ? dayNames.findIndex((name) => name.toLowerCase() === dayText.toLowerCase()) : null;
        if (repeat === 'weekly' && (day === null || day < 0)) return { error: `"${entry}" needs its day, as Mon 06:30 21.` };
        if (repeat !== 'weekly' && dayText) return { error: `"${entry}" has a day: choose Weekly to plan by the day of the week.` };
        if (Number(hours) > 23 || Number(minutes) > 59) return { error: `"${entry}" is not a time of day.` };
        points.push({ ...(repeat === 'weekly' ? { day } : {}), at: Number(hours) * 3600 + Number(minutes) * 60, value: Number(value) });
    }
    return { points };
}

// A plan written back as a person would write it, its values through `shown` (to the unit they are read in).
export function planText(plan, shown = (value) => value) {
    const clockText = (at) => `${String(Math.floor(at / 3600)).padStart(2, '0')}:${String(Math.floor((at % 3600) / 60)).padStart(2, '0')}`;
    return [...plan.points].sort((a, b) => placeOf(plan, a) - placeOf(plan, b))
        .map((point) => `${plan.repeat === 'weekly' ? `${dayNames[point.day]} ` : ''}${clockText(point.at)} ${Number(Number(shown(point.value)).toPrecision(6))}`).join('\n');
}

// How far a projection made at `now` was from what then arrived, over the horizon: the root mean square of the difference between
// the two held signals, read at the middles of equal parts. readings: the input's good readings, in time order, through now + horizon.
export function projectionError(readings, samples, { now, horizon, last }) {
    const projected = [{ time: now, value: last }, ...samples];
    const grid = heldGrid(readings, now, now + horizon, 50);
    if (!grid.length) return null;
    return Math.sqrt(grid.reduce((sum, [time, actual]) => sum + (heldAt(projected, time) - actual) ** 2, 0) / grid.length);
}

// The states of a model an input may follow past now with 'model' (a controller's output, docs/proposals/predictionActualWindow.md,
// "From the model"), each with why it may not, or null: one a signal measures (its readings say what it does, not the model), one an
// input sets (the input would only copy that input), and one in another unit than the input's parameter (the engine gives the input
// the state's value as it is: a floor's temperature in kelvin is no heater's watts). A state or an input with no unit is not refused
// for it (`stated` false: offered apart, as one whose unit is not stated). `parameterId` is the input's shared parameter;
// `inputParameters` every mapped input's.
export function followableStates(document, { parameterId, measured = [], inputParameters = [] }) {
    const unit = String((document.sharedParameters ?? []).find((parameter) => parameter.id === parameterId)?.unit ?? '').trim();
    const setByInputs = statesSetByInputs(document, new Set(inputParameters));
    const measuredStates = new Set(measured);
    return (document.nodes ?? []).flatMap((node) => (node.states ?? []).map((state) => {
        const stateUnit = String(state.unit ?? '').trim();
        const why = measuredStates.has(state.id) ? 'a signal measures it'
            : setByInputs.has(state.id) ? 'an input sets it'
            : unit && stateUnit && stateUnit !== unit ? `it is in ${stateUnit}, and the input in ${unit}` : null;
        return { id: state.id, label: `${node.name} · ${state.name}`, unit: stateUnit, stated: Boolean(unit && stateUnit), why };
    }));
}

// The states a source term sets outright (`setsValue`) to an input's value, as it is (the outdoor air's temperature, the weather
// station's reading; the heater's heat flow, its power): their ids. A term's bindings list every symbol it may use (its own state, the
// time), so it is its expression that says what it reads: here, one symbol, bound to a parameter an input drives (the shared parameter,
// or the term's own copy of it).
export function statesSetByInputs(document, inputParameterIds) {
    const set = new Set();
    for (const node of document.nodes ?? []) {
        for (const term of node.sourceTerms ?? []) {
            const stateId = term.expressionModel?.output?.stateId;
            const symbol = term.expressionModel?.mathJson;
            if (!term.setsValue || !Number.isSafeInteger(stateId) || typeof symbol !== 'string') continue;
            const binding = (term.expressionModel?.bindings ?? []).find((candidate) => candidate.kind === 'parameter' && candidate.symbol === symbol);
            if (!binding) continue;
            const local = (term.parameters ?? []).find((parameter) => parameter.id === binding.parameterId);
            if (inputParameterIds.has(binding.parameterId) || (local?.sharedParameterId !== undefined && inputParameterIds.has(local.sharedParameterId))) set.add(stateId);
        }
    }
    return set;
}
