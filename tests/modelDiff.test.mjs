/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { describeModelDiff, diffIsEmpty, diffModels } from '../src/modelDiff.mjs';

const before = {
    nodes: [
        { id: 1, name: 'Battery', states: [{ id: 11, name: 'Temperature', symbol: 'temperature', initialValue: 300 }], position: [0, 0, 0] },
        { id: 2, name: 'Old sink', states: [] }
    ],
    edges: [{ id: 5, name: 'Loss', source: { nodeId: 1 }, target: { nodeId: 2 }, parameters: [{ id: 51, symbol: 'k', value: 1 }] }]
};
const after = {
    nodes: [
        { id: 3, name: 'Heat sink', states: [{ id: 31, symbol: 'temperature', initialValue: 293 }] },
        { id: 1, name: 'Battery', states: [{ id: 11, name: 'Temperature', symbol: 'temperature', initialValue: 310 }, { id: 12, name: 'Charge', symbol: 'charge', initialValue: 1 }], position: [1, 0, 0] }
    ],
    edges: [{ id: 5, name: 'Loss', source: { nodeId: 1 }, target: { nodeId: 3 }, parameters: [{ id: 52, symbol: 'ua', value: 2 }] }]
};

test('Entities are matched by id wherever they sit in their list, and a changed one says which fields changed', () => {
    const diff = diffModels(before, after);
    assert.deepEqual(diff.nodes.added, [{ id: 3, name: 'Heat sink' }]);
    assert.deepEqual(diff.nodes.removed, [{ id: 2, name: 'Old sink' }]);
    assert.deepEqual(diff.nodes.changed, [{ id: 1, name: 'Battery', fields: ['position', 'state Temperature changed', 'state Charge added'] }]);
    assert.deepEqual(diff.edges.changed, [{ id: 5, name: 'Loss', fields: ['parameter ua added', 'parameter k removed', 'target'] }]);
});

test('The diff reads as lines, nodes first, and two equal models have none', () => {
    assert.deepEqual(describeModelDiff(diffModels(before, after)), [
        'Added node “Heat sink”',
        'Changed node “Battery”: position, state Temperature changed, state Charge added',
        'Removed node “Old sink”',
        'Changed relationship “Loss”: parameter ua added, parameter k removed, target'
    ]);
    assert.equal(diffIsEmpty(diffModels(before, structuredClone(before))), true);
    assert.equal(diffIsEmpty(diffModels(before, after)), false);
    assert.equal(diffIsEmpty(diffModels({}, {})), true);
});
