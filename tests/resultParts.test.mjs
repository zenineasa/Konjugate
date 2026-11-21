/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The parts a result records (docs/proposals/unifiedEntityEditors.md, decision 11): what each term written as an equation added
// to, or gave, a state at each sample, read back by part, and the series a relationship's Results tab draws.

import assert from 'node:assert/strict';
import test from 'node:test';
import { partKey, relationshipPartSeries, samplePartValues } from '../src/resultSession.mjs';

const result = {
    parts: [
        { sourceId: 30, stateId: 2, negated: false },
        { sourceId: 30, stateId: 5, negated: true },
        { sourceId: 41, stateId: 2, negated: false }
    ],
    samples: [
        { time: 0, states: [], parts: [1, -1, 0.5] },
        { time: 1, states: [], parts: [2, -2, Number.NaN] },
        { time: 2, states: [] }
    ]
};

test('a part is known by its term or relationship, the state it lands on, and whether it is the far end negated', () => {
    assert.equal(partKey(30, 2), '30:2:0');
    assert.equal(partKey('30', '5', true), '30:5:1');
});

test('a sample gives each recorded part its value, and none it could not work out or does not have', () => {
    assert.deepEqual([...samplePartValues(result, result.samples[0])], [['30:2:0', 1], ['30:5:1', -1], ['41:2:0', 0.5]]);
    assert.deepEqual([...samplePartValues(result, result.samples[1])], [['30:2:0', 2], ['30:5:1', -2]], 'A part that is NaN is unknown, not a value.');
    assert.equal(samplePartValues(result, result.samples[2]).size, 0, 'A sample without parts gives none.');
    assert.equal(samplePartValues({ samples: result.samples }, result.samples[0]).size, 0, 'A result made before parts were recorded gives none.');
});

test('a relationship\'s series is one line for each end it lands on, over the samples that recorded it', () => {
    const series = relationshipPartSeries(result, 30, (part) => ({ name: part.negated ? 'other end' : 'target' }));
    assert.deepEqual(series, [
        { name: 'target', samples: [{ time: 0, value: 1 }, { time: 1, value: 2 }] },
        { name: 'other end', samples: [{ time: 0, value: -1 }, { time: 1, value: -2 }] }
    ]);
    assert.deepEqual(relationshipPartSeries(result, 99, () => ({})), [], 'A relationship with no recorded part has no series.');
    assert.deepEqual(relationshipPartSeries({ samples: result.samples }, 30, () => ({})), [], 'A result made before parts were recorded has none.');
});
