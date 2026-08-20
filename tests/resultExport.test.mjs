/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { csvField, projectDocumentSignals, resultSignalsToCsv, seriesToCsv } from '../src/resultExport.mjs';

test('projectDocumentSignals derives signal id/header pairs from raw project JSON', () => {
    const document = {
        nodes: [
            { id: 1, name: 'Tank', states: [{ id: 2, name: 'Surface pressure', symbol: 'pressure', unit: 'Pa' }] },
            { id: 3, name: 'Pump', deleted: true, states: [{ id: 4, name: 'Flow', symbol: 'flow', unit: '' }] },
            { id: 5, name: 'Node without unit', states: [{ id: 6, name: 'Count', symbol: 'count', unit: '' }] }
        ]
    };
    assert.deepEqual(projectDocumentSignals(document), [
        { signalId: 2, header: 'Tank — Surface pressure (Pa)' },
        { signalId: 6, header: 'Node without unit — Count' }
    ]);
});

test('csvField quotes and escapes values containing commas, quotes or newlines', () => {
    assert.equal(csvField(42), '42');
    assert.equal(csvField('plain'), 'plain');
    assert.equal(csvField('a,b'), '"a,b"');
    assert.equal(csvField('has "quotes"'), '"has ""quotes"""');
    assert.equal(csvField('multi\nline'), '"multi\nline"');
});

test('seriesToCsv builds a header row plus one row per sample, aligned by time', () => {
    const series = [
        { signalId: 1, samples: [{ time: 0, value: 100 }, { time: 1, value: 101 }] },
        { signalId: 2, samples: [{ time: 0, value: 5 }, { time: 1, value: 6 }] }
    ];
    const signals = [{ signalId: 1, header: 'Tank — Pressure (Pa)' }, { signalId: 2, header: 'Pump — Flow' }];
    const csv = seriesToCsv(series, signals);
    assert.equal(csv, 'time (s),Tank — Pressure (Pa),Pump — Flow\n0,100,5\n1,101,6');
});

test('seriesToCsv handles signals with no samples at all', () => {
    const csv = seriesToCsv([{ signalId: 1, samples: [] }], [{ signalId: 1, header: 'Empty' }]);
    assert.equal(csv, 'time (s),Empty');
});

test('resultSignalsToCsv reads samples straight from a decoded engine result', () => {
    const result = {
        samples: [
            { time: 0, states: [{ stateId: 2, value: 99973.98 }] },
            { time: 0.5, states: [{ stateId: 2, value: 99500.12 }] }
        ]
    };
    const csv = resultSignalsToCsv(result, [{ signalId: 2, header: 'Tank — Surface pressure (Pa)' }]);
    assert.equal(csv, 'time (s),Tank — Surface pressure (Pa)\n0,99973.98\n0.5,99500.12');
});
