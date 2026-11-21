/* Copyright © 2026 Zenin Easa Panthakkalakath */

import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeUpdates, sayKinds, sayKindsAlike, saysKinds, stateKinds, termsReachingStates, withoutKinds } from '../src/ratesAndUpdates.mjs';
import { nodeFromDocument, nodeToDocument } from '../src/modelCodec.mjs';

// A tank whose level is a rate (an inflow term, and a bidirectional pipe to a second tank), a level gauge whose reading is set
// from the level (a setsValue source term), and a joint relationship setting the second tank's pressure with its equations.
function model() {
    const term = (id, state, stateId, setsValue, bindings = []) => ({
        id, state, expression: 'e', parameters: [], ...(setsValue ? { setsValue: true } : {}),
        expressionModel: { latex: 'e', mathJson: 1, bindings, output: { stateId } }
    });
    return {
        nodes: [
            { id: 1, name: 'Tank', states: [{ id: 11, name: 'Level', symbol: 'level' }], sourceTerms: [term(12, 'level', 11, false)] },
            { id: 2, name: 'Gauge', states: [{ id: 21, name: 'Reading', symbol: 'reading' }],
              sourceTerms: [term(22, 'reading', 21, true, [{ kind: 'state', nodeId: 1, stateId: 11, symbol: 'level' }])] },
            { id: 3, name: 'Other tank', states: [{ id: 31, name: 'Level', symbol: 'level' }, { id: 32, name: 'Pressure', symbol: 'pressure' }], sourceTerms: [] }
        ],
        edges: [
            { id: 4, name: 'Pipe', directionality: 'bidirectional', source: { nodeId: 1, stateId: 11 }, target: { nodeId: 3, stateId: 31 },
              equationModel: { output: { role: 'target', stateId: 31 }, bindings: [], mathJson: 1 } },
            { id: 5, name: 'Joint', directionality: 'directed', source: { nodeId: 1 }, target: { nodeId: 3 },
              equationModel: { bindings: [], outputs: [{ role: 'target', stateId: 32, mathJson: 1, setsValue: true }] } }
        ]
    };
}

test('every term reaching a state is found, a bidirectional relationship at both ends', () => {
    const { nodes, edges } = model();
    const reaching = termsReachingStates(nodes, edges);
    assert.deepEqual(reaching.get(11).map((term) => [term.type, term.termId ?? term.edgeId, term.reciprocal ?? false]),
        [['sourceTerm', 12, false], ['relationship', 4, true]]);
    assert.deepEqual(reaching.get(31).map((term) => [term.type, term.edgeId, term.role]), [['relationship', 4, 'target']]);
    assert.deepEqual(reaching.get(32).map((term) => [term.type, term.edgeId, term.outputIndex, term.setsValue]), [['relationship', 5, 0, true]]);
    assert.equal(reaching.get(21)[0].setsValue, true);
});

test('a file that says no kind is read as the engine reads it, and every node settles', () => {
    const { nodes, edges } = model();
    assert.equal(saysKinds(nodes), false);
    const kinds = stateKinds(nodes, edges);
    assert.deepEqual([11, 21, 31, 32].map((id) => kinds.get(id).kind), ['rate', 'update', 'rate', 'update']);
    assert.ok([...kinds.values()].every((kind) => !kind.said));
    assert.deepEqual(nodeUpdates(nodes[0], false), { updates: 'settle', limit: 1000 });
});

test('saying the kinds keeps the numbers, and the file says none again as it was', () => {
    const original = model();
    const { nodes, edges } = model();
    sayKinds(nodes, edges);
    assert.ok(saysKinds(nodes));
    assert.deepEqual(nodes.flatMap((node) => node.states.map((state) => state.kind)), ['rate', 'update', 'rate', 'update']);
    // The nodes holding an Update settle; the gauge's term no longer says setsValue: being an Update's term says it.
    assert.deepEqual(nodes.map((node) => node.updates), [undefined, 'settle', 'settle']);
    assert.equal(nodes[1].sourceTerms[0].setsValue, undefined);
    const kinds = stateKinds(nodes, edges);
    assert.ok([...kinds.values()].every((kind) => kind.said));
    assert.deepEqual(nodeUpdates(nodes[0], true).updates, 'oncePerStep');

    const back = withoutKinds(nodes, edges);
    assert.equal(back.reason, undefined);
    assert.deepEqual(back.nodes, original.nodes, 'Without its kinds, the file is the one it was.');
});

test('a state placed into a file that says its kinds, saying none, is what its terms make it', () => {
    const { nodes, edges } = model();
    nodes[0].states[0].kind = 'rate';
    const kinds = stateKinds(nodes, edges);
    assert.deepEqual(kinds.get(11), { kind: 'rate', said: true });
    assert.deepEqual(kinds.get(21), { kind: 'update', said: false }, 'A setsValue term still makes its state an Update.');
    assert.deepEqual(kinds.get(31), { kind: 'rate', said: false });
});

test('a disabled node or relationship keeps its states\' kinds when the file is made to say them', () => {
    const { nodes, edges } = model();
    nodes[1].enabled = false;
    edges[1].enabled = false;
    // Off, they reach nothing in the run...
    assert.equal(termsReachingStates(nodes, edges).get(21), undefined);
    // ...but the gauge's reading is still set by its term and the pressure by the joint, as they are once switched back on.
    assert.deepEqual([21, 32].map((id) => stateKinds(nodes, edges).get(id).kind), ['update', 'update']);
    sayKinds(nodes, edges);
    assert.equal(nodes[1].states[0].kind, 'update', 'A disabled node\'s value set directly stays an Update.');
    assert.equal(nodes[1].updates, 'settle', 'And its node settles, as it did.');
    assert.equal(nodes[2].states[1].kind, 'update', 'A state a disabled relationship\'s equations set stays an Update.');
});

test('content put into a model says its kinds as the model does, whichever side said none being made to say them', () => {
    // A model that says none, and a node pasted into it that says its kind: the model is made to say them, as it is read now.
    const existing = model();
    const pasted = [{ id: 40, name: 'Pasted', states: [{ id: 41, name: 'Q', symbol: 'q', kind: 'rate' }], sourceTerms: [] }];
    assert.equal(sayKindsAlike(existing.nodes, pasted, existing.edges), 'existing');
    assert.deepEqual(existing.nodes.flatMap((node) => node.states.map((state) => state.kind)), ['rate', 'update', 'rate', 'update']);
    assert.deepEqual(existing.nodes.map((node) => node.updates), [undefined, 'settle', 'settle'], 'Its nodes holding an Update still settle.');
    assert.equal(pasted[0].states[0].kind, 'rate', 'What is pasted is left as it says.');

    // A model that says its kinds, and content that says none placed into it: the content is made to say them.
    const target = model();
    sayKinds(target.nodes, target.edges);
    const placed = model();
    assert.equal(sayKindsAlike(target.nodes, placed.nodes, [...target.edges, ...placed.edges]), 'incoming');
    assert.deepEqual(placed.nodes.flatMap((node) => node.states.map((state) => state.kind)), ['rate', 'update', 'rate', 'update']);
    assert.deepEqual(placed.nodes.map((node) => node.updates), [undefined, 'settle', 'settle']);

    // Alike already, or nothing there yet: nothing changes.
    const legacy = model();
    const before = structuredClone(legacy);
    assert.equal(sayKindsAlike(legacy.nodes, model().nodes, legacy.edges), null);
    assert.deepEqual(legacy, before);
    assert.equal(sayKindsAlike([], pasted, []), null);
});

test('a file that means something a file without kinds cannot say is refused, saying why', () => {
    const once = model();
    sayKinds(once.nodes, once.edges);
    delete once.nodes[1].updates;
    assert.match(withoutKinds(once.nodes, once.edges).reason, /Node "Gauge" works its updates out once per step/);

    const single = model();
    sayKinds(single.nodes, single.edges);
    single.nodes[2].states[0].kind = 'update';
    assert.match(withoutKinds(single.nodes, single.edges).reason, /Relationship "Pipe" sets the value of "Other tank · Level" with a single equation/);

    const itself = model();
    sayKinds(itself.nodes, itself.edges);
    itself.nodes[1].sourceTerms[0].expressionModel.bindings.push({ kind: 'state', nodeId: 2, stateId: 21, symbol: 'reading' });
    assert.match(withoutKinds(itself.nodes, itself.edges).reason, /State "Gauge · Reading" reads itself/);
});

test('a state\'s kind and a node\'s updates pass through the canvas unchanged', () => {
    const context = {
        geometryFromDocument: () => null, serializeGeometry: () => null, stateValueText: (value) => ({ text: String(value), exact: true }),
        transformOf: () => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }), newId: () => 99,
        sourceTermExpressionModel: (definition, term) => term.expressionModel
    };
    const document = {
        id: 1, name: 'Tank', updates: 'settle', updatesLimit: 50, position: [0, 0, 0],
        states: [{ id: 11, name: 'Level', symbol: 'level', initialValue: 0, unit: '', kind: 'update' }], sourceTerms: []
    };
    const definition = nodeFromDocument(document, context);
    assert.equal(definition.states[0].kind, 'update');
    assert.equal(definition.updates, 'settle');
    assert.equal(definition.states[0].extraFields, undefined, 'A kind is a field the canvas knows, not one it only carries.');
    const written = nodeToDocument(definition, context);
    assert.equal(written.states[0].kind, 'update');
    assert.equal(written.updates, 'settle');
    assert.equal(written.updatesLimit, 50);
    const unsaid = nodeToDocument(nodeFromDocument({ ...document, updates: undefined, updatesLimit: undefined, states: [{ ...document.states[0], kind: undefined }] }, context), context);
    assert.ok(!('kind' in unsaid.states[0]) && !('updates' in unsaid), 'A file that says nothing is written saying nothing.');
});
