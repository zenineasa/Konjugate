/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fitPlanFromLog } from '../src/dataLogFit.mjs';

// A motor's speed, read every 50 ms, against a model stepped every millisecond.
const document = {
    nodes: [{ id: 1, name: 'Motor', states: [{ id: 2, name: 'Speed', symbol: 'omega', initialValue: 0 }] }],
    edges: [], sharedParameters: [{ id: 3, name: 'Voltage', symbol: 'voltage', value: 0 }]
};
const mapping = [
    { signal: 'motorVoltage', role: 'input', unit: 'V', parameterId: 3 },
    { signal: 'motorSpeed', role: 'output', unit: 'rad/s', stateId: 2 }
];
const logOf = (times) => ({
    header: { signals: [] },
    observations: [
        { signal: 'motorVoltage', time: 0, value: 6, revision: 0 },
        ...times.map((time) => ({ signal: 'motorSpeed', time, value: 10 * time, revision: 0 }))
    ]
});
const every = (from, to, step) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, index) => Number((from + index * step).toFixed(6)));

test('readings coarser than the model\'s step are filled between, not taken for gaps', () => {
    const plan = fitPlanFromLog(document, logOf(every(0, 2, 0.05)), mapping, { from: 0, to: 2, timeStep: 0.001 });
    assert.equal(plan.steps, 2000);
    const rows = plan.csv.trim().split('\n').slice(1).map((row) => row.split(',').map(Number));
    assert.equal(rows.length, 2001);
    // Halfway between two readings, the straight line between them.
    const [time, speed] = rows[1025];
    assert.ok(Math.abs(time - 1.025) < 1e-9);
    assert.ok(Math.abs(speed - 10.25) < 1e-6, `${speed}`);
});

test('several readings missing in a row are a gap, said in the readings\' own time', () => {
    const times = every(0, 2, 0.05).filter((time) => time < 0.8 || time > 1.2);
    assert.throws(() => fitPlanFromLog(document, logOf(times), mapping, { from: 0, to: 2, timeStep: 0.001 }),
        /motorSpeed has no readings from 0\.75 s to 1\.25 s into the stretch/);
});
