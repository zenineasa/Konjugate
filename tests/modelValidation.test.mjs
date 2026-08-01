/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { validateModel } from '../src/modelValidation.mjs';

const ids = {
    source: '11111111-1111-4111-8111-111111111111', target: '22222222-2222-4222-8222-222222222222',
    sourceState: '33333333-3333-4333-8333-333333333333', targetState: '44444444-4444-4444-8444-444444444444',
    edge: '55555555-5555-4555-8555-555555555555', parameter: '66666666-6666-4666-8666-666666666666'
};

function validModel() {
    const nodes = [
        { id: ids.source, title: 'Source', states: [{ id: ids.sourceState, label: 'Temperature', symbol: 'temperature' }], sourceTerms: [] },
        { id: ids.target, title: 'Target', states: [{ id: ids.targetState, label: 'Temperature', symbol: 'temperature' }], sourceTerms: [] }
    ];
    return { nodes, relationships: [{
        id: ids.edge, title: 'Transfer', source: ids.source, target: ids.target,
        equation: '\\mathrm{coefficient}\\cdot\\mathrm{sourceTemperature}',
        equationModel: { latex: '\\mathrm{coefficient}\\cdot\\mathrm{sourceTemperature}', output: { role: 'target', stateId: ids.targetState }, bindings: [] },
        parameters: [{ id: ids.parameter, name: 'Coefficient', symbol: 'coefficient', value: 1 }]
    }] };
}

test('returns an executable model when validation succeeds', () => {
    const result = validateModel(validModel());
    assert.equal(result.valid, true);
    assert.equal(result.issues.length, 0);
    assert.ok(result.executableModel.relationships[0].mathJson);
});

test('reports stable locations for graph and equation errors', () => {
    const model = validModel();
    model.relationships[0].target = '77777777-7777-4777-8777-777777777777';
    const result = validateModel(model);
    assert.equal(result.valid, false);
    assert.deepEqual(result.issues.find((item) => item.code === 'edgeTargetMissing').location, {
        kind: 'edge', entityId: ids.edge, field: 'target'
    });
});

test('reports duplicate symbols and missing equation outputs', () => {
    const model = validModel();
    model.nodes[0].states.push({ id: '88888888-8888-4888-8888-888888888888', label: 'Other', symbol: 'temperature' });
    model.relationships[0].equationModel.output.stateId = null;
    const codes = validateModel(model).issues.map((item) => item.code);
    assert.ok(codes.includes('stateSymbolDuplicate'));
    assert.ok(codes.includes('edgeOutputMissing'));
});
