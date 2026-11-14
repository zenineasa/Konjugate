/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { executionProjectDocument, hydrateSubsystems, subsystemBoundaryCrossings, subsystemContains } from '../src/subsystems.mjs';

// Model ─ Plant (20) ─ Pump (21)
//       └ Controls (30)
const subsystems = [
    { id: 20, parentSubsystemId: null },
    { id: 21, parentSubsystemId: 20 },
    { id: 30, parentSubsystemId: null }
];
const nodes = [
    { id: 1, subsystemId: 20 }, { id: 2, subsystemId: 20 }, { id: 3, subsystemId: null },
    { id: 4, subsystemId: null }, { id: 5, subsystemId: 21 }, { id: 6, subsystemId: 30 }
];
const crossings = (subsystemId, edges, extra = {}) => subsystemBoundaryCrossings({ subsystemId, subsystems, nodes, edges, ...extra });

test('derives one crossing for each relationship with exactly one endpoint inside, with its direction', () => {
    const edges = [
        { id: 10, source: 1, target: 2 },
        { id: 11, source: 1, target: 3 },
        { id: 12, source: 4, target: 2 },
        { id: 13, source: 3, target: 4 }
    ];
    assert.deepEqual(crossings(20, edges), [
        { edgeId: 11, internalNodeId: 1, externalNodeId: 3, role: 'source', direction: 'outgoing' },
        { edgeId: 12, internalNodeId: 2, externalNodeId: 4, role: 'target', direction: 'incoming' }
    ]);
});

test('accepts project-document endpoints and reports a bidirectional edge as such', () => {
    const edges = [{ id: 11, source: { nodeId: 3 }, target: { nodeId: 1 }, directionality: 'bidirectional' }];
    assert.deepEqual(crossings(20, edges), [
        { edgeId: 11, internalNodeId: 1, externalNodeId: 3, role: 'target', direction: 'bidirectional' }
    ]);
});

test('counts nested members as inside, and parents and siblings as outside', () => {
    const edges = [
        { id: 40, source: 5, target: 1 }, // Pump to Plant: internal to Plant, crosses Pump
        { id: 41, source: 5, target: 6 }, // Pump to the sibling Controls: crosses Pump, Plant and Controls
        { id: 42, source: 3, target: 5 } // top level into Pump
    ];
    assert.deepEqual(crossings(20, edges).map((crossing) => crossing.edgeId), [41, 42]);
    assert.deepEqual(crossings(21, edges), [
        { edgeId: 40, internalNodeId: 5, externalNodeId: 1, role: 'source', direction: 'outgoing' },
        { edgeId: 41, internalNodeId: 5, externalNodeId: 6, role: 'source', direction: 'outgoing' },
        { edgeId: 42, internalNodeId: 5, externalNodeId: 3, role: 'target', direction: 'incoming' }
    ]);
    assert.deepEqual(crossings(30, edges).map((crossing) => [crossing.edgeId, crossing.direction]), [[41, 'incoming']]);
    assert.equal(subsystemContains({ subsystems, subsystemId: 20, nodeSubsystemId: 21 }), true);
    assert.equal(subsystemContains({ subsystems, subsystemId: 21, nodeSubsystemId: 20 }), false);
    assert.equal(subsystemContains({ subsystems, subsystemId: 20, nodeSubsystemId: null }), false);
});

test('follows edges as they are added and deleted, rather than a snapshot', () => {
    const edges = [{ id: 11, source: 1, target: 3 }];
    assert.equal(crossings(20, edges).length, 1);
    edges.push({ id: 12, source: 4, target: 2 });
    assert.equal(crossings(20, edges).length, 2);
    edges[0].deleted = true;
    assert.deepEqual(crossings(20, edges).map((crossing) => crossing.edgeId), [12]);
});

test('leaves out deleted nodes, missing nodes and deleted subsystems', () => {
    const edges = [{ id: 11, source: 1, target: 3 }, { id: 12, source: 1, target: 99 }];
    assert.deepEqual(crossings(20, edges, { nodes: nodes.map((node) => (node.id === 3 ? { ...node, deleted: true } : node)) }), []);
    assert.deepEqual(crossings(20, edges, { subsystems: subsystems.map((item) => (item.id === 20 ? { ...item, deleted: true } : item)) }), []);
    assert.deepEqual(crossings(77, edges), []);
});

test('treats each edge-group member crossing the boundary as its own crossing, both ways', () => {
    // A group of nodes 1 (inside) and 3 (outside) meshes into one directed edge each way.
    const edges = [
        { id: 50, groupId: 60, source: 1, target: 3 },
        { id: 51, groupId: 60, source: 3, target: 1 },
        { id: 52, groupId: 60, source: 1, target: 2 },
        { id: 53, groupId: 60, source: 2, target: 1 }
    ];
    assert.deepEqual(crossings(20, edges).map((crossing) => [crossing.edgeId, crossing.direction]), [[50, 'outgoing'], [51, 'incoming']]);
});

test('opens a document whose subsystems still carry stored ports, and does not keep them', () => {
    const ids = new Set();
    const registerId = (id) => { if (ids.has(id)) throw new Error('duplicate'); ids.add(id); };
    const document = {
        nodes: [{ id: 1, subsystemId: 9 }, { id: 2 }],
        edges: [{ id: 3, source: { nodeId: 1 }, target: { nodeId: 2 } }],
        // The second port names an edge deleted since it was written, which such a file could hold.
        subsystems: [{ id: 9, name: 'Plant', position: [1, 2, 3], ports: [
            { id: 4, edgeId: 3, internalNodeId: 1, externalNodeId: 2, role: 'source' },
            { id: 5, edgeId: 77, internalNodeId: 1, externalNodeId: 2, role: 'source' }
        ] }]
    };
    assert.deepEqual(hydrateSubsystems(document, registerId), [
        { id: 9, name: 'Plant', parentSubsystemId: null, position: [1, 2, 3], deleted: false }
    ]);
    assert.deepEqual(subsystemBoundaryCrossings({ subsystemId: 9, subsystems: [{ id: 9 }], nodes: document.nodes, edges: document.edges }),
        [{ edgeId: 3, internalNodeId: 1, externalNodeId: 2, role: 'source', direction: 'outgoing' }]);
});

test('flattens hierarchy metadata without changing graph entities', () => {
    const document = { format: 'konjugate', version: 1,
        nodes: [{ id: 1, subsystemId: 9 }, { id: 2 }],
        edges: [{ id: 3, source: { nodeId: 1 }, target: { nodeId: 2 } }],
        subsystems: [{ id: 9, name: 'Plant', ports: [] }] };
    assert.deepEqual(executionProjectDocument(document), { format: 'konjugate', version: 1,
        nodes: [{ id: 1 }, { id: 2 }], edges: document.edges });
    assert.equal(document.nodes[0].subsystemId, 9);
});
