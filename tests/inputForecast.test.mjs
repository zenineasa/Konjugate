/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticChoice, fitPolynomial, heldAt, parsePlan, planText, projectInput, projectionError, scoredChoice } from '../src/inputForecast.mjs';

const context = { now: 3600, horizon: 3600, timeStep: 60 };
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ''} ${actual} is not within ${tolerance} of ${expected}`);
// A heater switched by a thermostat, logged at each change: on 5 minutes in every 20, so a quarter of the time, and off at now (3600 s).
const thermostatUntil = (end) => [{ time: 0, value: 0 }, ...Array.from({ length: Math.ceil(end / 1200) }, (_, cycle) => [
    { time: cycle * 1200 + 600, value: 2000 }, { time: cycle * 1200 + 900, value: 0 }
]).flat()].filter((reading) => reading.time <= end);
const thermostat = thermostatUntil(3600);
// A voltage raised by an operator, 0.5 V a minute, read every minute.
const ramp = Array.from({ length: 61 }, (_, index) => ({ time: index * 60, value: Math.min(12, 0.1 * index) }));

test('the held value is the last reading at or before a time, nothing before the first', () => {
    const readings = [{ time: 0, value: 1 }, { time: 10, value: 2 }, { time: 20, value: 3 }];
    assert.equal(heldAt(readings, -1), null);
    assert.equal(heldAt(readings, 0), 1);
    assert.equal(heldAt(readings, 15), 2);
    assert.equal(heldAt(readings, 99), 3);
});

test('a polynomial is fitted by least squares', () => {
    const points = Array.from({ length: 11 }, (_, index) => [index / 10, 2 + 3 * (index / 10) - 4 * (index / 10) ** 2]);
    const [a, b, c] = fitPolynomial(points, 2).coefficients;
    near(a, 2, 1e-9);
    near(b, 3, 1e-9);
    near(c, -4, 1e-9);
    assert.equal(fitPolynomial([[1, 5], [1, 7]], 1).coefficients[1], 0, 'A fit with every x the same has no slope.');
});

test('hold gives no samples: the last reading holds', () => {
    assert.deepEqual(projectInput(ramp, { choice: 'hold' }, context).samples, []);
});

test('the average is over the held signal, weighted by time, not over the readings as points', () => {
    const projection = projectInput(thermostat, { choice: 'mean', span: 3600 }, context);
    assert.equal(projection.using, 'mean');
    assert.equal(projection.samples.length, 1);
    near(projection.samples[0].value, 500, 1e-6, 'On a quarter of the time: 500 W.');
    assert.equal(projection.samples[0].time, 3660);
});

test('a trend is fitted over the span, carried on from the last reading, damped, and clamped to the input\'s limits', () => {
    const projection = projectInput(ramp, { choice: 'trend', span: 1800, damping: 1e9 }, context);
    assert.equal(projection.using, 'trend');
    assert.equal(projection.samples.length, 60);
    // Undamped (a very long damping), 0.1 V a minute on from 6 V: each sample at the value half way through its step.
    // (The fit is to the readings held between them, a staircase, so its slope is the ramp's to within a little.)
    near(projection.samples[0].value, 6 + 0.1 * 1.5, 1e-3);
    near(projection.samples.at(-1).value, 6 + 0.1 * 60.5, 0.05);
    const damped = projectInput(ramp, { choice: 'trend', span: 1800 }, context);
    near(damped.samples.at(-1).value, 6 + (0.1 / 60) * 3600 * (1 - Math.exp(-3630 / 3600)), 0.05, 'Damped over the horizon: about 63% of the way at the horizon.');
    const clamped = projectInput(ramp, { choice: 'trend', span: 1800, damping: 1e9 }, { ...context, limits: { minimum: 0, maximum: 9 } });
    assert.equal(Math.max(...clamped.samples.map((sample) => sample.value)), 9);
});

test('a second-order trend follows a curve that is levelling off', () => {
    // Rising and levelling: 10 (1 - e^(-t/1800)).
    const rising = Array.from({ length: 61 }, (_, index) => ({ time: index * 60, value: 10 * (1 - Math.exp(-index * 60 / 1800)) }));
    const line = projectInput(rising, { choice: 'trend', span: 3600, damping: 1e9 }, context);
    const curve = projectInput(rising, { choice: 'trend2', span: 3600, damping: 1e9 }, context);
    const truth = 10 * (1 - Math.exp(-(3600 + 1800) / 1800));
    const at = (projection) => projection.samples.find((sample) => sample.time === 5400).value;
    assert.ok(Math.abs(at(curve) - truth) < Math.abs(at(line) - truth), `Half an hour on, the curve (${at(curve)}) is nearer ${truth} than the line (${at(line)}).`);
});

test('the last day is repeated, moved to start from where the input now stands', () => {
    // Two days of a daily temperature, read hourly, a degree warmer on the second.
    const daily = (time) => 5 * Math.sin(2 * Math.PI * time / 86400) + (time >= 86400 ? 1 : 0);
    const readings = Array.from({ length: 49 }, (_, index) => ({ time: index * 3600, value: daily(index * 3600) }));
    const now = 36 * 3600;
    const projection = projectInput(readings.filter((reading) => reading.time <= now), { choice: 'day' }, { now, horizon: 6 * 3600, timeStep: 60 });
    assert.equal(projection.using, 'day');
    for (const sample of projection.samples.filter((entry) => entry.time % 3600 === 0)) near(sample.value, daily(sample.time), 1e-9, `At ${sample.time / 3600} h.`);
    const early = projectInput(readings.filter((reading) => reading.time <= 12 * 3600), { choice: 'day' }, { now: 12 * 3600, horizon: 3600, timeStep: 60 });
    assert.equal(early.using, 'hold', 'Without a day of readings it holds.');
    assert.match(early.reason, /until it has a period \(24 h\) of readings/);
});

test('automatic holds steps, averages a back-and-forth, and follows a ramp', () => {
    const options = { now: 3600, span: 3600, resolution: 1e-6 };
    assert.equal(automaticChoice([{ time: 0, value: 6 }, { time: 1200, value: 12 }], options).using, 'hold');
    assert.match(automaticChoice([{ time: 0, value: 6 }, { time: 1200, value: 12 }], options).reason, /^stepping: 1 change/);
    assert.equal(automaticChoice(thermostat, options).using, 'mean');
    assert.match(automaticChoice(thermostat, options).reason, /^cycling: 6 changes, back and forth$/);
    assert.equal(automaticChoice(ramp, options).using, 'trend');
    // An operator stepping a voltage up a volt every five minutes is ramping too.
    const staircase = Array.from({ length: 12 }, (_, index) => ({ time: index * 300, value: index }));
    assert.equal(automaticChoice(staircase, options).using, 'trend');
    // Raised and lowered again: averaged, since it may go back again; raised twice: held.
    assert.equal(automaticChoice([{ time: 0, value: 6 }, { time: 1200, value: 12 }, { time: 2400, value: 6 }], options).using, 'mean');
    assert.match(automaticChoice([{ time: 0, value: 6 }, { time: 1200, value: 9 }, { time: 2400, value: 12 }], options).reason, /^stepping: 2 changes in the span, one way/);
    // Noise about a level is not a ramp: it is averaged.
    const noisy = Array.from({ length: 60 }, (_, index) => ({ time: index * 60, value: 20 + 0.1 * Math.sin(index * 2.7) }));
    assert.equal(automaticChoice(noisy, options).using, 'mean');
    assert.equal(projectInput(thermostat, { choice: 'automatic', span: 3600 }, { ...context, resolution: 1 }).using, 'mean');
});

test('a projection is scored against what then arrived', () => {
    const later = thermostatUntil(7200);
    const hold = projectionError(later, [], { now: 3600, horizon: 3600, last: 0 });
    const mean = projectionError(later, projectInput(thermostat, { choice: 'mean', span: 3600 }, context).samples, { now: 3600, horizon: 3600, last: 0 });
    near(hold, Math.sqrt(0.25) * 2000, 50, 'Held off, it misses the quarter of the time it is on.');
    assert.ok(mean < hold, `The average (${mean}) is closer than holding (${hold}).`);
});

test('once scored often enough, automatic goes by the score: the closest choice, holding on a tie', () => {
    assert.equal(scoredChoice({ projections: 5, error: { hold: 9, mean: 1 } }), null, 'Not before six forecasts are scored.');
    const best = scoredChoice({ projections: 40, error: { hold: 1000, mean: 612, trend: 1400, trend2: 2100, day: 1000, automatic: 700 } });
    assert.deepEqual(best, { using: 'mean', reason: 'hold the average has been closest over 40 forecasts (missed by 612, holding by 1000)' });
    assert.equal(scoredChoice({ projections: 40, error: { hold: 3, mean: 3, day: 3 } }).using, 'hold');
    // Scored, a heater that has just switched once is averaged, not held: the rules alone would hold it.
    const switched = [{ time: 0, value: 0 }, { time: 3000, value: 2000 }];
    assert.equal(projectInput(switched, { choice: 'automatic', span: 3600 }, context).using, 'hold');
    assert.equal(projectInput(switched, { choice: 'automatic', span: 3600 }, { ...context, score: { projections: 40, error: { hold: 1000, mean: 612 } } }).using, 'mean');
});

test('a plan is followed by the plant\'s clock, repeated daily or weekly, from a step after now to the horizon', () => {
    const { points } = parsePlan('06:30 21\n23:00 17');
    assert.deepEqual(points, [{ at: 23400, value: 21 }, { at: 82800, value: 17 }]);
    const plan = { repeat: 'daily', timeZone: 'UTC', points };
    // The twin's time 0 is midnight UTC on a Monday (9 November 2026); now is 05:00, the horizon three hours.
    const clock = (time) => Date.parse('2026-11-09T00:00:00Z') / 1000 + time;
    const projection = projectInput([{ time: 0, value: 17 }], { choice: 'plan', plan }, { now: 5 * 3600, horizon: 3 * 3600, timeStep: 60, clock });
    assert.equal(projection.using, 'plan');
    assert.deepEqual(projection.samples, [{ time: 5 * 3600 + 60, value: 17 }, { time: 6.5 * 3600, value: 21 }]);
    // The same plan in Paris (an hour ahead of UTC in November): 06:30 there is 05:30 UTC.
    const paris = projectInput([{ time: 0, value: 17 }], { choice: 'plan', plan: { ...plan, timeZone: 'Europe/Paris' } }, { now: 5 * 3600, horizon: 3 * 3600, timeStep: 60, clock });
    assert.deepEqual(paris.samples.map((sample) => [sample.time / 3600, sample.value]), [[5 + 1 / 60, 17], [5.5, 21]]);
    // Round midnight: from 22:00 over four hours, 23:00 down to 17 and nothing more till morning.
    const late = projectInput([{ time: 0, value: 21 }], { choice: 'plan', plan }, { now: 22 * 3600, horizon: 4 * 3600, timeStep: 60, clock });
    assert.deepEqual(late.samples.map((sample) => [sample.time / 3600, sample.value]), [[22 + 1 / 60, 21], [23, 17]]);
    // Weekly: a Saturday lie-in.
    const weekly = { repeat: 'weekly', timeZone: 'UTC', points: parsePlan('Mon 06:30 21\nSat 09:00 21\nMon 23:00 17\nSat 23:00 17\nSun 23:00 17', 'weekly').points };
    const saturday = projectInput([{ time: 0, value: 17 }], { choice: 'plan', plan: weekly }, { now: 5 * 86400 + 6 * 3600, horizon: 4 * 3600, timeStep: 60, clock });
    assert.deepEqual(saturday.samples.map((sample) => [(sample.time - 5 * 86400) / 3600, sample.value]), [[6 + 1 / 60, 17], [9, 21]]);
    // Without a clock (a source that gives no time of day) it holds, and says why.
    assert.match(projectInput([{ time: 0, value: 17 }], { choice: 'plan', plan }, { now: 3600, horizon: 3600, timeStep: 60 }).reason, /no clock time/);
});

test('a plan is read as written, and written back the same', () => {
    assert.match(parsePlan('6:30').error, /is not a time and a value/);
    assert.match(parsePlan('Mon 06:30 21').error, /choose Weekly/);
    assert.match(parsePlan('06:30 21', 'weekly').error, /needs its day/);
    assert.match(parsePlan('25:00 3').error, /not a time of day/);
    assert.match(parsePlan('').error, /one to a line/);
    const plan = { repeat: 'weekly', timeZone: 'UTC', points: parsePlan('Sat 09:00 294.15, Mon 06:30 294.15', 'weekly').points };
    assert.equal(planText(plan, (kelvin) => kelvin - 273.15), 'Mon 06:30 21\nSat 09:00 21');
});

test('a plan and the model are never what Automatic picks, being set up rather than read from the past', () => {
    assert.equal(scoredChoice({ projections: 40, error: { hold: 9, plan: 1, model: 1, mean: 5 } }).using, 'mean');
});
