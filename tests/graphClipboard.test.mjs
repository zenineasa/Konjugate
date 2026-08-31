/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createGraphFragment, remapGraphFragment, validateGraphFragment } from '../src/graphClipboard.mjs';

const document = {
    nodes: [
        { id: 1, name: 'One', position: [0, 0, 0], states: [{ id: 2, name: 'A' }], sourceTerms: [{
            id: 10, state: 'a', expression: 'gain', parameters: [{ id: 11, name: 'Gain', symbol: 'gain', value: 2, mode: 'constant' }],
            expressionModel: { bindings: [{ kind: 'parameter', parameterId: 11, symbol: 'gain' }], output: { stateId: 2 }, mathJson: 'gain' }
        }] },
        { id: 3, name: 'Two', position: [2, 0, 0], states: [{ id: 4, name: 'B' }], sourceTerms: [] },
        { id: 5, name: 'Outside', position: [4, 0, 0], states: [{ id: 6, name: 'C' }], sourceTerms: [] }
    ],
    edges: [{
        id: 7,
        name: 'Transfer',
        source: { nodeId: 1, stateId: 2 },
        target: { nodeId: 3, stateId: 4 },
        parameters: [{ id: 8, name: 'Gain' }],
        equationModel: {
            bindings: [
                { kind: 'state', nodeId: 1, stateId: 2 },
                { kind: 'state', nodeId: 3, stateId: 4 },
                { kind: 'parameter', parameterId: 8 }
            ],
            output: { role: 'target', stateId: 4 }
        }
    }, {
        id: 9, name: 'External', source: { nodeId: 3, stateId: 4 }, target: { nodeId: 5, stateId: 6 }, parameters: []
    }]
};

test('copies only relationships fully contained by the selected nodes', () => {
    const fragment = createGraphFragment(document, [1, 3]);
    assert.equal(validateGraphFragment(fragment), true);
    assert.deepEqual(fragment.nodes.map((node) => node.id), [1, 3]);
    assert.deepEqual(fragment.edges.map((edge) => edge.id), [7]);
});

test('regenerates every entity ID and equation binding while retaining layout', () => {
    const pasted = remapGraphFragment(createGraphFragment(document, [1, 3]), 20, [1, 0, 2]);
    assert.deepEqual(pasted.nodes.map((node) => node.id), [20, 24]);
    assert.deepEqual(pasted.nodes.map((node) => node.position), [[1, 0, 2], [3, 0, 2]]);
    assert.deepEqual(pasted.nodes.flatMap((node) => node.states.map((state) => state.id)), [21, 25]);
    assert.equal(pasted.nodes[0].sourceTerms[0].id, 22);
    assert.equal(pasted.nodes[0].sourceTerms[0].parameters[0].id, 23);
    assert.equal(pasted.nodes[0].sourceTerms[0].expressionModel.bindings[0].parameterId, 23);
    assert.equal(pasted.edges[0].id, 26);
    assert.deepEqual(pasted.edges[0].source, { nodeId: 20, stateId: 21 });
    assert.deepEqual(pasted.edges[0].target, { nodeId: 24, stateId: 25 });
    assert.equal(pasted.edges[0].parameters[0].id, 27);
    assert.deepEqual(pasted.edges[0].equationModel.bindings.map((binding) => (
        binding.nodeId ?? binding.stateId ?? binding.parameterId
    )), [20, 24, 27]);
    assert.equal(pasted.edges[0].equationModel.output.stateId, 25);
    assert.equal(pasted.nextId, 28);
});
