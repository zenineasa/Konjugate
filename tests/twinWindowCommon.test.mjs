/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ago, dataClock, dataTime, stepOf, trendOf } from '../src/twinWindow/common.mjs';

// A point a minute, for `hours` hours, valued by `at(time)`.
const series = (hours, at) => Array.from({ length: hours * 60 + 1 }, (_, minute) => [minute * 60, at(minute * 60)]);

test('a change made at once is a step, said as one, even at the very edge of the last hour', () => {
    // A heater's heat flow: 1000 W, off at 5 h; looked at 6 h later, exactly an hour after.
    const heater = series(6, (time) => (time < 5 * 3600 ? 1000 : 0));
    assert.deepEqual(stepOf(heater), { time: 5 * 3600, from: 1000, to: 0, change: -1000 });
    assert.equal(trendOf(heater).word, 'steady', 'A rate alone reads the hour after a step as steady, which is why a step is said instead.');
    // Twenty minutes after the step.
    assert.equal(stepOf(series(5.5, (time) => (time < 5 * 3600 ? 0 : 1000))).change, 1000);
});

test('a gradual change, a small wobble, and a step more than an hour ago are not steps', () => {
    assert.equal(stepOf(series(3, (time) => 290 + time / 3600)), null, 'A steady rise is a rate.');
    assert.equal(stepOf(series(3, (time) => 1000 + (Math.round(time / 60) % 2))), null, 'A wobble far smaller than the value is not a step.');
    assert.equal(stepOf(series(6, (time) => (time < 3 * 3600 ? 1000 : 0))), null, 'A step three hours ago is old news.');
    assert.equal(stepOf([[0, 1]]), null);
});

test('a trend is read at the twin\'s own time scale: a motor settled a minute ago is steady over its five seconds', () => {
    // A current rising to 0.69 A over the first ten seconds, then flat: over an hour, everything since the start is one span.
    const current = Array.from({ length: 181 }, (_, second) => [second, 0.69 * Math.min(1, second / 10)]);
    assert.equal(trendOf(current).word, 'rising', 'Over an hour, the start is in the span.');
    assert.equal(trendOf(current, 5).word, 'steady');
    assert.equal(trendOf(current.slice(0, 8), 5).word, 'rising');
    assert.equal(stepOf(current, 5), null);
});

test('a slow change in kelvin, and an estimate that scatters, are read by where they go', () => {
    // Outdoors, in kelvin, falling from 8 °C to -0.5 °C over a day: a third of a kelvin an hour, a tiny share of 280 K.
    const outdoor = series(24, (time) => 273.15 + 8 - 8.5 * (time / (24 * 3600)));
    assert.equal(trendOf(outdoor, 3 * 3600).word, 'falling');
    // An estimate rising from 20 °C to 22.5 °C over twelve hours, scattering by a tenth of a kelvin from one point to the next.
    const estimate = series(12, (time) => 293.15 + 2.5 * (time / (12 * 3600)) + (Math.round(time / 60) % 2 ? 0.1 : -0.1));
    assert.equal(trendOf(estimate, 3 * 3600).word, 'rising');
    // Settled, scattering about the same value: steady, however large the scatter is beside the slope.
    const settled = series(12, (time) => 293.15 + (Math.round(time / 60) % 2 ? 0.1 : -0.1));
    assert.equal(trendOf(settled, 3 * 3600).word, 'steady');
    // A level settled to within a millimetre of a metre.
    assert.equal(trendOf(series(3, (time) => 1 + 0.0002 * Math.sin(time / 600)), 3600).word, 'steady');
});

test('how long ago, in words', () => {
    assert.equal(ago(20), 'just now');
    // At a motor's scale (a five-second window), seconds.
    assert.equal(ago(20, 5), '20 s ago');
    assert.equal(ago(0.05, 5), 'just now');
    assert.equal(ago(12 * 60), '12 min ago');
    assert.equal(ago(40 * 60), '40 min ago');
    assert.equal(ago(3600), '1 h ago');
    assert.equal(ago(1.5 * 3600), '1.5 h ago');
});

test('a time in the data is read in the unit that suits it: a motor in seconds, a tank in hours', () => {
    assert.equal(dataClock(16), '16 s');
    assert.equal(dataClock(2.25), '2.3 s');
    assert.equal(dataClock(750), '12.5 min');
    assert.equal(dataClock(3600), '1 h');
    assert.equal(dataClock(9600), '2.67 h');
    assert.equal(dataTime(5), 'at 5 s of data');
});
