/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeFromDocument, nodeToDocument, relationshipFromDocument, relationshipToDocument, subsystemFromDocument, subsystemToDocument } from '../src/modelCodec.mjs';

// The canvas and the editor's normalisers, replaced by stand-ins that change nothing, so what these tests see is the codec.
const context = {
    geometryFromDocument: (mesh) => ({ mesh }),
    serializeGeometry: (geometry) => geometry.mesh,
    stateValueText: (value) => ({ text: String(value), exact: true }),
    transformOf: (definition) => ({ position: definition.position, rotation: definition.rotation, scale: definition.scale }),
    newId: () => 9999,
    sourceTermExpressionModel: (definition, term) => term.expressionModel ?? { latex: term.expression },
    relationshipEquationModel: (definition) => definition.equationModel
};

// A node with every field the schema gives one, including a C++ program, a source term with its own program, and the
// fields a newer Konjugate might add.
const node = {
    id: 1, name: 'Motor', type: 'Actuator', description: 'Turns current into torque.', subsystemId: 20, enabled: false,
    numerics: { substepsPerGlobalStep: 4, integration: 'semiImplicit' },
    position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2],
    states: [{ id: 2, name: 'Current', symbol: 'current', initialValue: 1.5, unit: 'A' }, { id: 11, name: 'Torque', symbol: 'torque', initialValue: 0, unit: 'N m', changes: 'atEachInstant' }],
    sourceTerms: [{
        id: 3, state: 'current', expression: 'gain', parameters: [{ id: 4, name: 'Gain', symbol: 'gain', value: 2, mode: 'live', control: { minimum: 0, maximum: 5, step: 0.1 } }],
        expressionModel: { latex: 'gain', bindings: [], mathJson: 'gain' }
    }, {
        id: 5, state: 'current', expression: '', parameters: [],
        implementation: { kind: 'cpp', providerApiVersion: 1, source: 'int main() {}', bindings: [], output: { key: 'out' } }
    }],
    implementation: { kind: 'cpp', providerApiVersion: 1, source: 'struct Node {};', bindings: [{ key: 'setpoint', kind: 'parameter', sharedParameterId: 30 }], outputs: [{ key: 'u', stateId: 2, setsValue: true }] },
    appearance: { type: 'primitive', shape: 'cylinder', color: '#112233', parts: [{ name: 'link', mesh: {} }] },
    futureNodeField: { added: 'later' }
};

const edge = {
    id: 6, groupId: 7, name: 'Drive', description: 'Torque into the shaft.',
    source: { nodeId: 1, stateId: 2 }, target: { nodeId: 8, stateId: 9 },
    directionality: 'bidirectional', enabled: false,
    equation: 'k x', equationModel: { latex: 'k x', output: { role: 'target', stateId: 9 }, bindings: [], mathJson: ['Multiply', 'k', 'x'] },
    implementation: { kind: 'python', source: 'pass' },
    parameters: [{ id: 10, name: 'k', symbol: 'k', value: 3, mode: 'constant' }],
    appearance: { color: '#abcdef', offset: 0.3, waypoints: [[0, 1, 2]] },
    futureEdgeField: [1, 2, 3]
};

test('a node written to a document and read back is the same node, whatever the schema gave it', () => {
    const definition = nodeFromDocument(node, context);
    assert.deepEqual(nodeToDocument(definition, context), node);
});

test('a node with only the required fields comes back with nothing invented', () => {
    const plain = { id: 1, name: 'Plain', type: 'Custom node', enabled: true, numerics: { substepsPerGlobalStep: 1 }, position: [0, 0, 0], states: [], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#34727a' } };
    assert.deepEqual(nodeToDocument(nodeFromDocument(plain, context), context), plain);
});

test('a node dropped somewhere else takes the place it is given and keeps its description', () => {
    const definition = nodeFromDocument(node, context, { subsystemId: null });
    assert.equal(definition.subsystemId, null);
    assert.equal(definition.description, 'Turns current into torque.');
    assert.equal(nodeToDocument(definition, context).subsystemId, undefined);
});

test('a relationship written to a document and read back is the same relationship', () => {
    assert.deepEqual(relationshipToDocument(relationshipFromDocument(edge), context), edge);
});

test('a pasted relationship keeps its program and its description but not its group or its waypoints', () => {
    const pasted = relationshipFromDocument(edge, { pasted: true });
    assert.deepEqual(pasted.implementation, edge.implementation, 'Pasting dropped the relationship\'s program.');
    assert.equal(pasted.description, edge.description);
    assert.equal(pasted.groupId, null);
    assert.deepEqual(pasted.waypoints, []);
});

test('fields the codec has never heard of survive and are not shared with the live definition', () => {
    const definition = nodeFromDocument(node, context);
    assert.deepEqual(definition.extraFields, { futureNodeField: { added: 'later' } });
    const written = nodeToDocument(definition, context);
    written.futureNodeField.added = 'changed';
    assert.equal(definition.extraFields.futureNodeField.added, 'later');
});

// A subsystem with every field the schema gives one, and one a newer Konjugate might add.
const subsystem = {
    id: 20, name: 'Plant', parentSubsystemId: 19, position: [1, 2, 3],
    terminalPositions: [{ edgeId: 6, position: [-4, 0.5, 0] }, { edgeId: 11, position: [5, 1, 0] }],
    futureSubsystemField: { added: 'later' }
};

test('a subsystem written to a document and read back is the same subsystem, its terminal positions included', () => {
    const definition = subsystemFromDocument(subsystem);
    assert.deepEqual(subsystemToDocument(definition), subsystem);
    definition.terminalPositions[0].position[0] = 99;
    assert.equal(subsystem.terminalPositions[0].position[0], -4, 'The definition shares its positions with the document.');
});

test('a subsystem drops the terminal positions of edges that no longer cross it, and the ports of earlier versions', () => {
    const definition = subsystemFromDocument({ ...subsystem, ports: [{ id: 50, edgeId: 6, internalNodeId: 1, externalNodeId: 2, role: 'source' }] });
    const saved = subsystemToDocument(definition, { position: [7, 8, 9], crossingEdgeIds: new Set([11]) });
    assert.deepEqual(saved.terminalPositions, [{ edgeId: 11, position: [5, 1, 0] }]);
    assert.deepEqual(saved.position, [7, 8, 9]);
    assert.equal('ports' in saved, false);
    assert.equal('terminalPositions' in subsystemToDocument(definition, { crossingEdgeIds: new Set() }), false, 'An empty list is not written.');
});

test('a subsystem with only the required fields comes back with nothing invented, and unusable terminal positions are dropped', () => {
    assert.deepEqual(subsystemToDocument(subsystemFromDocument({ id: 3, name: 'Box', parentSubsystemId: null, position: [0, 0, 0] })),
        { id: 3, name: 'Box', parentSubsystemId: null, position: [0, 0, 0] });
    const definition = subsystemFromDocument({ id: 3, name: 'Box', position: [0, 0, 0], terminalPositions: [{ edgeId: 'x', position: [0, 0, 0] }, { edgeId: 4, position: [1, 2] }, { edgeId: 5, position: ['1', 2, 3] }] });
    assert.deepEqual(definition.terminalPositions, [{ edgeId: 5, position: [1, 2, 3] }]);
});
