/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeSnapshotExcludedKeys, relationshipSnapshotExcludedKeys, snapshotDefinition, snapshotFields } from '../src/modelDefinition.mjs';

test('a snapshot keeps a field nobody listed, so a new field is saved and undone by default', () => {
    const definition = { id: 1, title: 'Tank', description: 'Holds water.', futureField: { nested: [1, 2] }, deleted: false };
    const snapshot = snapshotDefinition(definition, nodeSnapshotExcludedKeys);
    assert.deepEqual(snapshot, { title: 'Tank', description: 'Holds water.', futureField: { nested: [1, 2] } });
    assert.notEqual(snapshot.futureField, definition.futureField, 'The snapshot shares a value with the live definition.');
});

test('a snapshot leaves out what the editor does not own', () => {
    const definition = { id: 1, title: 'Tank', position: [0, 0, 0], shape: 'box', color: 1, importedGeometry: { not: 'cloneable' }, subsystemId: 3, deleted: false, enabled: true };
    assert.deepEqual(snapshotDefinition(definition, nodeSnapshotExcludedKeys), { title: 'Tank' });
    const edge = { id: 2, groupId: 4, offset: 0.3, deleted: false, enabled: true, title: 'Flow', directionality: 'directed' };
    assert.deepEqual(snapshotDefinition(edge, relationshipSnapshotExcludedKeys), { title: 'Flow', directionality: 'directed' });
});

test('restoring copies the fields back and ignores what rides along with a snapshot', () => {
    const snapshot = { title: 'Before', states: [{ id: 5 }], sharedParameters: [{ id: 9 }], bindings: [{ id: 7 }], id: 99 };
    const fields = snapshotFields(snapshot, nodeSnapshotExcludedKeys);
    assert.deepEqual(fields, { title: 'Before', states: [{ id: 5 }] });
    assert.notEqual(fields.states, snapshot.states);
});

test('a definition field that a snapshot reserves for itself is refused, not silently overwritten', () => {
    assert.throws(() => snapshotDefinition({ title: 'x', bindings: [] }, nodeSnapshotExcludedKeys), /reserves it/);
});
