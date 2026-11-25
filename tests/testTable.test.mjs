/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCell, plotPath, tableText, testInputs, testSummary, traceTable } from '../src/providerEditor/testTable.mjs';

// The engine's Test of the PID example, three steps (testProgram's answer, as the engine gave it).
const answer = {
    available: true, ok: true, program: 'PidController', problems: [], problemDetails: [],
    checks: [{ name: 'ports', passed: true }, { name: 'outputs', passed: true }, { name: 'purity', passed: true }, { name: 'memory', passed: true }, { name: 'jacobian', passed: null }],
    trace: {
        stepSize: 0.01, clocked: true, rows: [
            { step: 0, time: 0, outputs: { power: 0 }, memory: { integral: [0], held: [0], noise: [15103848575745722000, 0] } },
            { step: 1, time: 0, outputs: { power: 157.65749999999886 }, memory: { integral: [0.03149999999999977], held: [157.65749999999886], noise: [15103848575745722000, 2] } },
            { step: 2, time: 0.01, outputs: { power: 157.81499999999886 }, memory: { integral: [0.06299999999999954], held: [157.81499999999886], noise: [15103848575745722000, 4] } }
        ]
    }
};

test('Test runs at the model\'s values, else each input\'s default, else 0', () => {
    const rows = testInputs([
        { key: 'measurement', kind: 'input', unit: 'K' },
        { key: 'kp', kind: 'constant', unit: 'W/K' },
        { key: 'sensorNoise', kind: 'constant', unit: 'K', default: 0.5 }
    ], { measurement: 290, kp: null });
    assert.deepEqual(rows, [
        { key: 'measurement', kind: 'input', unit: 'K', value: 290, fromModel: true },
        { key: 'kp', kind: 'constant', unit: 'W/K', value: 0, fromModel: false },
        { key: 'sensorNoise', kind: 'constant', unit: 'K', value: 0.5, fromModel: false }
    ]);
});

test('the checks that ran, each a line; problems with their lines and steps', () => {
    const passed = testSummary(answer);
    assert.equal(passed.passed, true);
    assert.deepEqual(passed.checks.map((check) => [check.label, check.passed]), [['ports', true], ['outputs', true], ['purity', true], ['memory round trip', true]],
        'A check that did not run (no Jacobian) is left out.');
    const failed = testSummary({
        ok: false, checks: [{ name: 'ports', passed: true }, { name: 'outputs', passed: false }],
        problems: ['Output ‘power’ is not a number.', 'No line known.'],
        problemDetails: [{ message: 'Output ‘power’ is not a number at step 4.', line: 22, check: null, step: 4, time: 0.04 }, { message: 'No line known.', line: null, check: 'ports', step: null, time: null }]
    });
    assert.equal(failed.passed, false);
    assert.deepEqual(failed.problems, [
        { message: 'Output ‘power’ is not a number at step 4.', line: 22, step: 4, time: 0.04 },
        { message: 'No line known.', line: null, step: null, time: null }
    ]);
    assert.equal(testSummary({ ok: true, problems: ['x'] }).passed, false, 'A problem fails it whatever ok says.');
});

test('the trace as a table: step, time, outputs, then memory, a random stream left out', () => {
    const table = traceTable(answer.trace, { hiddenMemory: ['noise'] });
    assert.deepEqual(table.columns.map((column) => [column.label, column.kind]), [['step', 'step'], ['t', 'time'], ['power', 'output'], ['integral', 'memory'], ['held', 'memory']]);
    assert.deepEqual(table.rows[1], [1, 0, 157.65749999999886, 0.03149999999999977, 157.65749999999886]);
    const withNoise = traceTable(answer.trace);
    assert.deepEqual(withNoise.columns.slice(-2).map((column) => column.label), ['noise[0]', 'noise[1]'], 'A value with several entries is a column each.');
});

test('six significant figures shown, every digit copied', () => {
    assert.equal(formatCell(157.65749999999886), '157.657');
    assert.equal(formatCell(0.03149999999999977), '0.0315');
    assert.equal(formatCell(NaN), 'NaN');
    assert.equal(formatCell(null), '');
    const text = tableText(traceTable(answer.trace, { hiddenMemory: ['noise'] }));
    assert.equal(text.split('\n')[0], 'step\tt\tpower\tintegral\theld');
    assert.equal(text.split('\n')[2], '1\t0\t157.65749999999886\t0.03149999999999977\t157.65749999999886');
});

test('the small plot spans its box, keeps a flat line in the middle, and breaks at a value that is not a number', () => {
    assert.equal(plotPath([0, 1, 2], 100, 20, 0), 'M0.0 20.0 L50.0 10.0 L100.0 0.0');
    assert.equal(plotPath([5, 5], 100, 20, 0), 'M0.0 10.0 L100.0 10.0');
    assert.equal(plotPath([0, NaN, 2, 3], 90, 20, 0), 'M0.0 20.0 M60.0 6.7 L90.0 0.0');
    assert.equal(plotPath([], 100, 20), '');
});
