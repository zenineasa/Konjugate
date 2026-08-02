/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
    applyAssistantProposal,
    AssistantProposalError,
    validateAssistantProposal
} from '../src/assistantOperations.mjs';

const emptyProject = () => ({
    format: 'konjugate', version: 1, metadata: { units: 'SI' },
    runConfigurations: [], nodes: [], edges: []
});
const uuidFactory = () => {
    let index = 1;
    return () => `00000000-0000-4000-8000-${String(index++).padStart(12, '0')}`;
};

test('assistant operation schema is valid JSON and describes proposal version 1', async () => {
    const schema = JSON.parse(await readFile(new URL('../schemas/assistantOperations.schema.json', import.meta.url), 'utf8'));
    assert.equal(schema.properties.proposalVersion.const, 1);
    assert.equal(schema.$defs.addNode.properties.kind.const, 'addNode');
});

test('builds a model from ordered temporary-reference operations without mutating the source', () => {
    const source = emptyProject();
    const proposal = {
        proposalVersion: 1,
        summary: 'Create a heated body and ambient environment.',
        operations: [
            { kind: 'addNode', ref: 'body', name: 'Heated body', type: 'Thermal mass', shape: 'box' },
            { kind: 'addState', ref: 'bodyTemperature', nodeRef: 'body', name: 'Temperature', symbol: 'temperature', initialValue: 320, unit: 'K' },
            { kind: 'addNode', ref: 'ambient', name: 'Ambient', type: 'Boundary', shape: 'sphere' },
            { kind: 'addState', ref: 'ambientTemperature', nodeRef: 'ambient', name: 'Temperature', symbol: 'temperature', initialValue: 293.15, unit: 'K' },
            { kind: 'addEdge', ref: 'heatLoss', name: 'Heat loss', sourceNodeRef: 'body', targetNodeRef: 'ambient', directionality: 'directed' },
            { kind: 'addParameter', ref: 'conductance', edgeRef: 'heatLoss', name: 'Conductance', symbol: 'conductance', value: 4, unit: 'W/K' },
            {
                kind: 'setEdgeEquation', edgeRef: 'heatLoss', outputStateRef: 'ambientTemperature',
                latex: '\\mathrm{conductance}\\cdot(\\mathrm{sourceTemperature}-\\mathrm{targetTemperature})'
            }
        ]
    };

    const result = applyAssistantProposal(source, proposal, { uuidFactory: uuidFactory() });
    assert.deepEqual(source.nodes, []);
    assert.equal(result.document.nodes.length, 2);
    assert.equal(result.document.edges.length, 1);
    assert.equal(result.document.edges[0].equationModel.output.role, 'target');
    assert.deepEqual(result.document.edges[0].equationModel.mathJson, [
        'Multiply', 'conductance', ['Add', 'sourceTemperature', ['Negate', 'targetTemperature']]
    ]);
    assert.equal(result.changes.length, proposal.operations.length);
    assert.equal(result.temporaryReferences.body, result.document.nodes[0].id);
});

test('creates a validated node-local source term', () => {
    const proposal = {
        proposalVersion: 1,
        operations: [
            { kind: 'addNode', ref: 'heater', name: 'Heater' },
            { kind: 'addState', ref: 'heatRate', nodeRef: 'heater', name: 'Heat rate', symbol: 'heatRate', initialValue: 10, unit: 'W' },
            { kind: 'addSourceTerm', ref: 'constantHeating', nodeRef: 'heater', outputStateRef: 'heatRate', latex: '\\mathrm{heatRate}' }
        ]
    };
    const { document } = applyAssistantProposal(emptyProject(), proposal, { uuidFactory: uuidFactory() });
    assert.equal(document.nodes[0].sourceTerms[0].expressionModel.output.stateId, document.nodes[0].states[0].id);
    assert.equal(document.nodes[0].sourceTerms[0].expressionModel.mathJson, 'heatRate');
});

test('rejects unresolved references and invalid equations without returning a partial model', () => {
    assert.throws(() => applyAssistantProposal(emptyProject(), {
        proposalVersion: 1,
        operations: [{ kind: 'addState', ref: 'temperature', nodeRef: 'missingNode', name: 'Temperature', symbol: 'temperature', initialValue: 0 }]
    }, { uuidFactory: uuidFactory() }), /does not exist or has not been created yet/);

    assert.throws(() => applyAssistantProposal(emptyProject(), {
        proposalVersion: 1,
        operations: [
            { kind: 'addNode', ref: 'nodeA', name: 'A' },
            { kind: 'addState', ref: 'stateA', nodeRef: 'nodeA', name: 'State', symbol: 'state', initialValue: 0 },
            { kind: 'addSourceTerm', ref: 'termA', nodeRef: 'nodeA', outputStateRef: 'stateA', latex: '\\mathrm{unknownValue}' }
        ]
    }, { uuidFactory: uuidFactory() }), /Unknown symbol/);
});

test('rejects unsupported proposal versions and operation kinds', () => {
    assert.throws(() => validateAssistantProposal({ proposalVersion: 2, operations: [{}] }), AssistantProposalError);
    assert.throws(() => validateAssistantProposal({ proposalVersion: 1, operations: [{ kind: 'deleteEverything' }] }), /Unsupported operation/);
});

test('updates existing model entities and reports before and after fields', () => {
    const source = emptyProject();
    source.nodes.push({
        id: 'node-a', name: 'Body', type: 'Mass', numerics: { substepsPerGlobalStep: 1 }, position: [0, 0, 0],
        states: [{ id: 'state-a', name: 'Temperature', symbol: 'temperature', initialValue: 300, unit: 'K' }],
        sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#34727a' }
    });
    source.nodes.push({
        id: 'node-b', name: 'Ambient', type: 'Boundary', numerics: { substepsPerGlobalStep: 1 }, position: [3, 0, 0],
        states: [{ id: 'state-b', name: 'Temperature', symbol: 'temperature', initialValue: 290, unit: 'K' }],
        sourceTerms: [], appearance: { type: 'primitive', shape: 'sphere', color: '#34727a' }
    });
    source.edges.push({
        id: 'edge-a', name: 'Heat transfer', source: { nodeId: 'node-a', stateId: 'state-a' }, target: { nodeId: 'node-b', stateId: 'state-b' },
        directionality: 'directed', equation: '', equationModel: { latex: '', output: { role: 'target', stateId: 'state-b' }, bindings: [], mathJson: null },
        parameters: [{ id: 'parameter-a', name: 'Conductance', symbol: 'conductance', value: 10, unit: 'W/K', mode: 'constant' }],
        appearance: { color: '#9c83c4', offset: 0 }
    });
    const result = applyAssistantProposal(source, { proposalVersion: 1, operations: [
        { kind: 'updateNode', nodeRef: 'node-a', name: 'Battery body', substepsPerGlobalStep: 4 },
        { kind: 'updateState', stateRef: 'state-a', initialValue: 315 },
        { kind: 'updateEdge', edgeRef: 'edge-a', directionality: 'bidirectional' },
        { kind: 'updateParameter', parameterRef: 'parameter-a', value: 18, mode: 'live' }
    ] });
    assert.equal(result.document.nodes[0].name, 'Battery body');
    assert.equal(result.document.nodes[0].numerics.substepsPerGlobalStep, 4);
    assert.equal(result.document.nodes[0].states[0].initialValue, 315);
    assert.equal(result.document.edges[0].directionality, 'bidirectional');
    assert.equal(result.document.edges[0].parameters[0].value, 18);
    assert.equal(result.changes.every((change) => change.action === 'update' && change.fields.length), true);
    assert.equal(result.changes[1].focusEntityId, 'node-a');
});

test('removing a node cascades to connected edges and their parameters', () => {
    const proposal = {
        proposalVersion: 1,
        operations: [
            { kind: 'addNode', ref: 'firstNode', name: 'First' },
            { kind: 'addNode', ref: 'secondNode', name: 'Second' },
            { kind: 'addEdge', ref: 'connection', name: 'Connection', sourceNodeRef: 'firstNode', targetNodeRef: 'secondNode' },
            { kind: 'addParameter', ref: 'gain', edgeRef: 'connection', name: 'Gain', symbol: 'gain', value: 1 },
            { kind: 'removeEntity', entityRef: 'firstNode' }
        ]
    };
    const result = applyAssistantProposal(emptyProject(), proposal, { uuidFactory: uuidFactory() });
    assert.equal(result.document.nodes.length, 1);
    assert.equal(result.document.edges.length, 0);
    assert.equal(result.changes.at(-1).action, 'remove');
    assert.throws(() => applyAssistantProposal(result.document, {
        proposalVersion: 1, operations: [{ kind: 'updateParameter', parameterRef: result.temporaryReferences.gain, value: 2 }]
    }), /does not exist/);
});
