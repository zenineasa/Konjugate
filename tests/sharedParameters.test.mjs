/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModel } from '../src/codeExport.mjs';
import { controlParameterId, liveControlParameterIds, resolveSharedParameters } from '../src/sharedParameters.mjs';

function project() {
    const node = (id, stateId) => ({ id, name: `Node ${id}`, states: [{ id: stateId, symbol: 'level', initialValue: 0 }], sourceTerms: [] });
    const edge = (id, targetNodeId, targetStateId, parameter) => ({
        id, source: { nodeId: 1, stateId: 2 }, target: { nodeId: targetNodeId, stateId: targetStateId },
        equationModel: { output: { role: 'target', stateId: targetStateId }, bindings: [{ kind: 'parameter', parameterId: parameter.id, symbol: 'gain' }], mathJson: 'gain' },
        parameters: [parameter]
    });
    return {
        sharedParameters: [{ id: 100, name: 'Shared gain', symbol: 'gain', value: 2, unit: 'x', mode: 'live', control: { minimum: 0, maximum: 10, step: 1 } }],
        nodes: [node(1, 2), node(3, 4), node(5, 6)],
        edges: [
            edge(7, 3, 4, { id: 8, name: 'Gain', symbol: 'gain', value: 5, mode: 'constant', sharedParameterId: 100 }),
            edge(9, 5, 6, { id: 10, name: 'Gain', symbol: 'gain', value: 5, mode: 'constant', sharedParameterId: 100 }),
            { ...edge(11, 5, 6, { id: 12, name: 'Own', symbol: 'gain', value: 1, mode: 'live' }) }
        ]
    };
}

test('a linked parameter is controlled through its shared id, an unlinked one through its own', () => {
    assert.equal(controlParameterId({ id: 8, sharedParameterId: 100 }), 100);
    assert.equal(controlParameterId({ id: 12 }), 12);
});

test('live control ids are live shared parameters plus unlinked live parameters', () => {
    assert.deepEqual([...liveControlParameterIds(project())].sort((left, right) => left - right), [12, 100]);
});

test('resolving shared parameters bakes each link and removes the definitions without mutating the input', () => {
    const original = project();
    const resolved = resolveSharedParameters(original);
    assert.equal(resolved.sharedParameters, undefined);
    for (const edge of resolved.edges.slice(0, 2)) {
        assert.deepEqual(edge.parameters[0], {
            id: edge.parameters[0].id, name: 'Gain', symbol: 'gain', value: 2, unit: 'x', mode: 'live',
            control: { minimum: 0, maximum: 10, step: 1 }
        });
    }
    assert.equal(original.edges[0].parameters[0].sharedParameterId, 100);
    assert.equal(original.sharedParameters.length, 1);
});

test('resolving rejects a link to a missing shared parameter', () => {
    const broken = project();
    broken.edges[0].parameters[0].sharedParameterId = 999;
    assert.throws(() => resolveSharedParameters(broken), /does not exist/);
});

test('code export sees the shared value, not the linked parameter\'s own', () => {
    const model = buildModel(project());
    const values = model.nodePlans.flatMap((plan) => plan.contributions)
        .flatMap((contribution) => [...contribution.symbols.values()]).filter((entry) => entry.parameter)
        .map((entry) => entry.parameter.value);
    assert.deepEqual(values, [2, 2, 1]);
});
