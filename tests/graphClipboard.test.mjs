/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createGraphFragment, fragmentSharedParameterReferences, remapGraphFragment, validateGraphFragment } from '../src/graphClipboard.mjs';

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

// A computational-node provider drives its own node's states and may read another node's and shared parameters: a
// pasted copy drives the copy's states, and reads what was not copied, and shared parameters, as the original did.
test('a node provider is copied with its node, driving the copy\'s states', () => {
    const withProvider = {
        nodes: [
            { id: 1, name: 'Arm', position: [0, 0, 0], states: [{ id: 2, name: 'Angle' }, { id: 3, name: 'Speed' }], sourceTerms: [], implementation: {
                kind: 'python', providerApiVersion: 1, source: 'provider source',
                bindings: [
                    { key: 'speed', kind: 'state', nodeId: 1, stateId: 3 },
                    { key: 'torque', kind: 'state', nodeId: 5, stateId: 6 },
                    { key: 'payload', kind: 'parameter', sharedParameterId: 50 }
                ],
                outputs: [{ key: 'angle', stateId: 2, setsValue: true }, { key: 'speed', stateId: 3, setsValue: true }]
            } },
            { id: 5, name: 'Motor', position: [2, 0, 0], states: [{ id: 6, name: 'Torque' }], sourceTerms: [] }
        ],
        edges: []
    };
    const { nodes: [copy] } = remapGraphFragment(createGraphFragment(withProvider, [1]), 100);
    assert.deepEqual(copy.states.map(({ id }) => id), [101, 102]);
    assert.deepEqual(copy.implementation.bindings, [
        { key: 'speed', kind: 'state', nodeId: 100, stateId: 102 },
        { key: 'torque', kind: 'state', nodeId: 5, stateId: 6 },
        { key: 'payload', kind: 'parameter', sharedParameterId: 50 }
    ]);
    assert.deepEqual(copy.implementation.outputs, [{ key: 'angle', stateId: 101, setsValue: true }, { key: 'speed', stateId: 102, setsValue: true }]);
    assert.equal(copy.implementation.source, 'provider source');
});

// A relationship with several equations sets states of its two nodes: copied with both, it sets the copies' states.
test('a relationship with several equations is copied setting the copies\' states', () => {
    const graph = {
        nodes: [
            { id: 1, name: 'Parent', position: [0, 0, 0], states: [{ id: 2, name: 'X' }], sourceTerms: [] },
            { id: 3, name: 'Child', position: [1, 0, 0], states: [{ id: 4, name: 'Y' }, { id: 5, name: 'Z' }], sourceTerms: [] }
        ],
        edges: [{ id: 6, name: 'Joint', source: { nodeId: 1 }, target: { nodeId: 3 }, parameters: [], equationModel: {
            bindings: [{ symbol: 'x', kind: 'state', role: 'source', nodeId: 1, stateId: 2 }],
            definitions: [{ symbol: 'twice', mathJson: ['Multiply', 2, 'x'] }],
            outputs: [{ role: 'target', stateId: 4, mathJson: 'twice', setsValue: true }, { role: 'target', stateId: 5, mathJson: 'x', setsValue: true }]
        } }]
    };
    const pasted = remapGraphFragment(createGraphFragment(graph, [1, 3]), 100);
    const [parent, child] = pasted.nodes;
    const [joint] = pasted.edges;
    assert.deepEqual(joint.equationModel.outputs.map(({ stateId }) => stateId), child.states.map(({ id }) => id));
    assert.deepEqual(joint.equationModel.bindings.map(({ nodeId, stateId }) => [nodeId, stateId]), [[parent.id, parent.states[0].id]]);
    assert.deepEqual(joint.equationModel.definitions, graph.edges[0].equationModel.definitions);
});

// The remap finds ids by what they are (an `id`, or a field ending in `Id` or `Ids`), not by where the code knows to look,
// so a reference or an entity added to the schema later is renumbered with no change here.
test('renumbers an id-bearing entity and a reference that no code has ever listed', () => {
    const graph = {
        nodes: [{
            id: 1, name: 'Arm', position: [0, 0, 0], states: [{ id: 2, name: 'Angle' }], sourceTerms: [],
            futureEntities: [{ id: 3, label: 'part', owner: { nodeId: 1, stateId: 2 }, peerStateIds: [2, 77] }]
        }],
        edges: []
    };
    const { nodes: [copy] } = remapGraphFragment(createGraphFragment(graph, [1]), 100);
    assert.deepEqual(copy.futureEntities, [{ id: 102, label: 'part', owner: { nodeId: 100, stateId: 101 }, peerStateIds: [101, 77] }]);
});

test('a relationship\'s own program is copied pointing at the copies, and what was not copied stays as it was', () => {
    const graph = {
        nodes: [
            { id: 1, name: 'A', position: [0, 0, 0], states: [{ id: 2, name: 'X' }], sourceTerms: [] },
            { id: 3, name: 'B', position: [1, 0, 0], states: [{ id: 4, name: 'Y' }], sourceTerms: [] }
        ],
        edges: [{
            id: 5, name: 'Link', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 3, stateId: 4 }, parameters: [{ id: 6, name: 'k' }],
            implementation: { kind: 'cpp', source: 'code', bindings: [
                { key: 'x', kind: 'state', nodeId: 1, stateId: 2 },
                { key: 'k', kind: 'parameter', parameterId: 6 },
                { key: 'shared', kind: 'parameter', sharedParameterId: 900 },
                { key: 'other', kind: 'state', nodeId: 50, stateId: 51 }
            ], output: { stateId: 4 } }
        }]
    };
    const { nodes, edges: [copy] } = remapGraphFragment(createGraphFragment(graph, [1, 3]), 100);
    assert.deepEqual(copy.implementation.bindings.map(({ nodeId, stateId, parameterId, sharedParameterId }) => [nodeId, stateId, parameterId, sharedParameterId]), [
        [nodes[0].id, nodes[0].states[0].id, undefined, undefined],
        [undefined, undefined, copy.parameters[0].id, undefined],
        [undefined, undefined, undefined, 900],
        [50, 51, undefined, undefined]
    ]);
    assert.equal(copy.implementation.output.stateId, nodes[1].states[0].id);
});

test('the copy shares nothing with the original', () => {
    const fragment = createGraphFragment(document, [1, 3]);
    const { nodes } = remapGraphFragment(fragment, 20);
    nodes[0].sourceTerms[0].parameters[0].value = 99;
    assert.equal(fragment.nodes[0].sourceTerms[0].parameters[0].value, 2);
});

test('a fragment that reuses an id is refused', () => {
    const graph = { nodes: [{ id: 1, name: 'A', position: [0, 0, 0], states: [{ id: 1, name: 'X' }], sourceTerms: [] }], edges: [] };
    assert.equal(validateGraphFragment(createGraphFragment(graph, [1])), false);
});

// A library template is a fragment that stands alone: it carries the shared parameters its nodes link to, and keeps its names.
const withShared = {
    format: 'konjugateGraphFragment', version: 1,
    nodes: [{
        id: 1, name: 'Controller', position: [0, 0, 0], states: [{ id: 2, name: 'Output' }], sourceTerms: [],
        implementation: { kind: 'cpp', source: 'code', bindings: [{ key: 'setpoint', kind: 'parameter', sharedParameterId: 10 }, { key: 'limit', kind: 'parameter', sharedParameterId: 11 }], outputs: [{ key: 'u', stateId: 2 }] }
    }],
    edges: [],
    sharedParameters: [{ id: 10, name: 'Setpoint', symbol: 'setpoint', value: 1 }, { id: 11, name: 'Limit', symbol: 'limit', value: 5 }]
};

test('shared parameters a fragment carries are renumbered along with every link to them', () => {
    const { nodes: [node], sharedParameters, nextId } = remapGraphFragment(withShared, 100, [0, 0, 0], { nameSuffix: '' });
    assert.equal(node.name, 'Controller', 'A placed template lost its own name.');
    assert.deepEqual(sharedParameters.map(({ id }) => id), [102, 103]);
    assert.deepEqual(node.implementation.bindings.map(({ sharedParameterId }) => sharedParameterId), [102, 103]);
    assert.equal(nextId, 104);
});

test('a shared parameter the project already has is linked to, not made again', () => {
    const { nodes: [node], sharedParameters } = remapGraphFragment(withShared, 100, [0, 0, 0], { nameSuffix: '', reuse: new Map([[10, 7]]) });
    assert.deepEqual(sharedParameters.map(({ symbol }) => symbol), ['limit']);
    assert.deepEqual(node.implementation.bindings.map(({ sharedParameterId }) => sharedParameterId), [7, 102]);
});

test('lists the shared parameters a fragment links to, whether or not it carries them', () => {
    assert.deepEqual(fragmentSharedParameterReferences(withShared), [10, 11]);
    assert.deepEqual(fragmentSharedParameterReferences({ nodes: [{ id: 1, implementation: { bindings: [{ sharedParameterId: 99 }] } }], edges: [] }), [99]);
});
