/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveSubsystemPorts, executionProjectDocument } from '../src/subsystems.mjs';

test('derives one stable boundary port for each crossing relationship', () => {
    let id = 100;
    const ports = deriveSubsystemPorts({ subsystemId: 20, nodeIds: [1, 2], allocateId: () => id++, edges: [
        { id: 10, source: { nodeId: 1 }, target: { nodeId: 2 } },
        { id: 11, source: { nodeId: 1 }, target: { nodeId: 3 } },
        { id: 12, source: { nodeId: 4 }, target: { nodeId: 2 } }
    ] });
    assert.deepEqual(ports, [
        { id: 100, edgeId: 11, internalNodeId: 1, externalNodeId: 3, role: 'source' },
        { id: 101, edgeId: 12, internalNodeId: 2, externalNodeId: 4, role: 'target' }
    ]);
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
