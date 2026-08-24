/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { latexForBinding, reconcileEquationBindings } from '../src/equationModel.mjs';
import {
    expandEdgeGroup, hydrateEdgeGroups, memberPairs, resolveGroupEdgeForPair,
    stripEdgeGroups, unresolvedGroupSymbols
} from '../src/edgeGroups.mjs';

const nodeA = { id: 1, states: [{ id: 10, symbol: 'temperature' }] };
const nodeB = { id: 2, states: [{ id: 20, symbol: 'temperature' }] };
const nodeC = { id: 3, states: [] };
const parameter = { id: 900, name: 'Coefficient', symbol: 'conductance', value: 2, unit: 'W/K', mode: 'constant' };

function makeGroup() {
    const bindings = reconcileEquationBindings([], nodeA, nodeB, [parameter]);
    const equation = `${latexForBinding(bindings[2])}\\cdot(${latexForBinding(bindings[0])}-${latexForBinding(bindings[1])})`;
    return {
        id: 100,
        name: 'Coolant loop',
        color: '#2fb8a4',
        memberNodeIds: [1, 2, 3],
        definition: { parameters: [parameter], output: { symbol: 'temperature' }, equation, implementation: null }
    };
}

test('enumerates every ordered member pair, sorted by node id', () => {
    assert.deepEqual(memberPairs([3, 1, 2]), [
        { sourceNodeId: 1, targetNodeId: 2 },
        { sourceNodeId: 1, targetNodeId: 3 },
        { sourceNodeId: 2, targetNodeId: 1 },
        { sourceNodeId: 2, targetNodeId: 3 },
        { sourceNodeId: 3, targetNodeId: 1 },
        { sourceNodeId: 3, targetNodeId: 2 }
    ]);
    assert.deepEqual(memberPairs([1]), []);
    assert.deepEqual(memberPairs([]), []);
});

test('resolves one directed edge per ordered pair, bound like a hand-authored edge', () => {
    const group = makeGroup();
    let nextId = 500;
    const edge = resolveGroupEdgeForPair({ group, sourceNode: nodeA, targetNode: nodeB, allocateId: () => nextId++ });
    assert.equal(edge.id, 500);
    assert.equal(edge.groupId, 100);
    assert.equal(edge.color, '#2fb8a4');
    assert.equal(edge.directionality, 'directed');
    assert.equal(edge.source, 1);
    assert.equal(edge.target, 2);
    assert.equal(edge.sourceStateId, null);
    assert.equal(edge.targetStateId, 20);
    assert.deepEqual(edge.equationModel.output, { role: 'target', stateId: 20 });
    assert.deepEqual(edge.equationModel.mathJson, ['Multiply', 'conductance', ['Add', 'sourceTemperature', ['Negate', 'targetTemperature']]]);
    assert.deepEqual(edge.parameters, [parameter]);
});

test('the reverse-direction edge for the same pair contributes to the other node instead', () => {
    const group = makeGroup();
    let nextId = 500;
    const edge = resolveGroupEdgeForPair({ group, sourceNode: nodeB, targetNode: nodeA, allocateId: () => nextId++ });
    assert.equal(edge.source, 2);
    assert.equal(edge.target, 1);
    assert.deepEqual(edge.equationModel.output, { role: 'target', stateId: 10 });
});

test('expands a group into exactly N(N-1) edges, one per ordered pair', () => {
    const group = makeGroup();
    const nodesById = new Map([[1, nodeA], [2, nodeB], [3, { id: 3, states: [{ id: 30, symbol: 'temperature' }] }]]);
    let nextId = 1;
    const edges = expandEdgeGroup({ group, nodesById, allocateId: () => nextId++ });
    assert.equal(edges.length, 6);
    assert.deepEqual(edges.map((edge) => [edge.source, edge.target]), [
        [1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2]
    ]);
    assert.equal(new Set(edges.map((edge) => edge.id)).size, 6);
    assert.ok(edges.every((edge) => edge.directionality === 'directed'));
});

test('reports the output symbol as unresolved only when a member node lacks it', () => {
    const group = makeGroup();
    assert.deepEqual(unresolvedGroupSymbols({ group, node: nodeA }), []);
    assert.deepEqual(unresolvedGroupSymbols({ group, node: nodeC }), ['temperature']);
});

test('hydrates edge groups and rejects a group referencing a missing node', () => {
    const registered = [];
    const registerId = (id) => registered.push(id);
    const document = {
        nodes: [{ id: 1 }, { id: 2 }],
        edges: [],
        edgeGroups: [{
            id: 100, name: 'Coolant loop', memberNodeIds: [1, 2], color: '#2fb8a4',
            definition: { parameters: [parameter], output: { symbol: 'temperature' }, equation: 'x', implementation: null }
        }]
    };
    const groups = hydrateEdgeGroups(document, registerId);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].memberNodeIds, [1, 2]);
    assert.equal(groups[0].color, 0x2fb8a4);
    assert.deepEqual(groups[0].definition.output, { symbol: 'temperature' });
    assert.deepEqual(registered, [100, 900]);

    const badNodeDocument = {
        ...document,
        edgeGroups: [{
            id: 101, name: 'Bad', memberNodeIds: [1, 99], color: '#2fb8a4',
            definition: { parameters: [], output: { symbol: 'x' }, equation: '', implementation: null }
        }]
    };
    assert.throws(() => hydrateEdgeGroups(badNodeDocument, () => {}), /missing node/);

    const badGroupReferenceDocument = {
        nodes: [{ id: 1 }, { id: 2 }],
        edges: [{ id: 5, groupId: 999 }],
        edgeGroups: []
    };
    assert.throws(() => hydrateEdgeGroups(badGroupReferenceDocument, () => {}), /missing edge group/);
});

test('strips edge groups and member tags without mutating the input document', () => {
    const document = {
        format: 'konjugate', version: 1,
        nodes: [{ id: 1 }, { id: 2 }],
        edges: [{ id: 3, source: { nodeId: 1 }, target: { nodeId: 2 }, groupId: 100 }],
        edgeGroups: [{ id: 100, name: 'Coolant loop' }]
    };
    assert.deepEqual(stripEdgeGroups(document), {
        format: 'konjugate', version: 1,
        nodes: [{ id: 1 }, { id: 2 }],
        edges: [{ id: 3, source: { nodeId: 1 }, target: { nodeId: 2 } }]
    });
    assert.equal(document.edges[0].groupId, 100);
});
