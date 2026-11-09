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

test('how long ago, in words', () => {
    assert.equal(ago(20), 'just now');
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
