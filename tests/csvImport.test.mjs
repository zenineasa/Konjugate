/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mapColumnsToNodes, parseCsv, suggestSymbol } from '../src/csvImport.mjs';

test('parses a header row and typed data rows', () => {
    const csv = 'time,temperature,flow\n0,20.5,1.2\n1,21.1,1.3\n';
    assert.deepEqual(parseCsv(csv), {
        columnNames: ['temperature', 'flow'],
        rows: [
            { time: 0, values: [20.5, 1.2] },
            { time: 1, values: [21.1, 1.3] }
        ]
    });
});

test('rejects a ragged row', () => {
    const csv = 'time,a,b\n0,1,2\n1,3\n';
    assert.throws(() => parseCsv(csv), /2 fields, expected 3/);
});

test('rejects a non-numeric cell', () => {
    const csv = 'time,a\n0,1\n1,two\n';
    assert.throws(() => parseCsv(csv), /is not a valid number/);
});

test('rejects a CSV with no data rows', () => {
    assert.throws(() => parseCsv('time,a\n'), /header row and at least one data row/);
});

test('rejects a CSV with only a time column', () => {
    assert.throws(() => parseCsv('time\n0\n1\n'), /time column and at least one variable column/);
});

test('suggestSymbol derives a lower-camel-case identifier from a column header', () => {
    assert.equal(suggestSymbol('Tank Temperature'), 'tankTemperature');
    assert.equal(suggestSymbol('flow_rate'), 'flowRate');
    assert.equal(suggestSymbol('x'), 'x');
    assert.equal(suggestSymbol('!!!'), 'value');
});

test('mapColumnsToNodes matches an existing state by exact symbol or name, case-insensitively', () => {
    const existingNodes = [
        { id: 1, states: [{ id: 10, symbol: 'temperature', name: 'Temperature' }] },
        { id: 2, states: [{ id: 20, symbol: 'flowRate', name: 'Flow Rate' }] }
    ];
    const mapping = mapColumnsToNodes(['Temperature', 'flowrate', 'pressure'], existingNodes);
    assert.deepEqual(mapping, [
        { columnName: 'Temperature', nodeId: 1, stateId: 10, createNew: false },
        { columnName: 'flowrate', nodeId: 2, stateId: 20, createNew: false },
        { columnName: 'pressure', nodeId: null, stateId: null, createNew: true, suggestedSymbol: 'pressure' }
    ]);
});

test('mapColumnsToNodes never picks a fuzzy/close match', () => {
    const existingNodes = [{ id: 1, states: [{ id: 10, symbol: 'temperature', name: 'Temperature' }] }];
    const mapping = mapColumnsToNodes(['temp'], existingNodes);
    assert.equal(mapping[0].createNew, true);
    assert.equal(mapping[0].nodeId, null);
});
