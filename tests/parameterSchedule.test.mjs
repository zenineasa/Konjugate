/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScheduleText, scheduleError, scheduleSummary, scheduleText } from '../src/parameterSchedule.mjs';

test('a schedule is typed or pasted as time and value per line, a header line skipped', () => {
    assert.deepEqual(parseScheduleText('time,price\n0, 1.5\n\n10\t2\n20 2.5\r\n30;3').samples, [[0, 1.5], [10, 2], [20, 2.5], [30, 3]]);
    assert.deepEqual(parseScheduleText(scheduleText([[0, 1], [5, -2e-3]])).samples, [[0, 1], [5, -0.002]]);
    assert.match(parseScheduleText('0, 1\n5, x').error, /Line 2 is not a time and a value/);
    assert.match(parseScheduleText('0, 1\nheader, later').error, /Line 2/, 'only the first line may be a header');
});

test('a schedule is refused for the engine\'s own reasons, and summarised in a line', () => {
    assert.equal(scheduleError({ interpolation: 'hold', samples: [[0, 1], [1, 2]] }), '');
    assert.match(scheduleError({ interpolation: 'cubic', samples: [[0, 1]] }), /Choose how the value goes/);
    assert.match(scheduleError({ interpolation: 'linear', samples: [] }), /at least one sample/);
    assert.match(scheduleError({ interpolation: 'linear', samples: [[0, 1], [0, 2]] }), /times must increase: sample 2/);
    assert.match(scheduleSummary({ interpolation: 'hold', samples: [[0, 1], [10, 3]] }), /2 samples, each value held until the next sample, from t = 0 to 10, values 1 to 3/);
});
