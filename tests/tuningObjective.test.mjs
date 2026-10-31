/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { constraintRows, insertName, objectivePayload, objectiveVocabulary, runSettingsError, wrapInSummary } from '../src/renderer/tuningObjective.mjs';

const document = {
    sharedParameters: [{ id: 20, name: 'Capacitance', symbol: 'capacitance', value: 3e5, tuning: { minimum: 1, maximum: 9 } }],
    nodes: [
        { id: 1, name: 'Water tank', states: [{ id: 2, name: 'Water temperature', symbol: 'tankTemperature' }], sourceTerms: [] },
        { id: 3, name: 'Ambient air', states: [{ id: 4, name: 'Temperature', symbol: 'temperature' }], sourceTerms: [] },
        { id: 5, name: 'Water tank', states: [{ id: 6, name: 'Temperature', symbol: 'temperature' }], sourceTerms: [] }
    ],
    edges: [
        { id: 7, name: 'Loss', parameters: [{ id: 8, name: 'Capacitance', symbol: 'capacitance', value: 1, sharedParameterId: 20 }, { id: 9, name: 'Loss', symbol: 'loss', value: 10 }, { id: 10, name: 'Gain', symbol: 'gain', value: 2, tuning: { minimum: 0, maximum: 4 } }] },
        { id: 11, name: 'Other', parameters: [{ id: 12, name: 'Gain', symbol: 'gain', value: 5 }] }
    ]
};

test('every state and parameter gets one name an expression can use, and names never repeat', () => {
    const { variables, states, parameters } = objectiveVocabulary(document, ['reading', 'reading']);
    const names = variables.map((variable) => variable.name);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(states.map((state) => state.name), ['waterTank_tankTemperature', 'ambientAir_temperature', 'waterTank_temperature']);
    assert.deepEqual(variables.find((variable) => variable.name === 'waterTank_temperature'), { name: 'waterTank_temperature', kind: 'state', id: 6 });
    // The linked parameter is left out (the shared one stands for it); tunable ones come first; a symbol used twice is told apart by its owner.
    assert.deepEqual(parameters.map((parameter) => [parameter.name, parameter.tunable]), [
        ['capacitance', true], ['loss_gain', true], ['loss', false], ['other_gain', false]
    ]);
    assert.deepEqual(variables.filter((variable) => variable.kind === 'measured').map((variable) => variable.name), ['measured_reading', 'measured_reading2']);
});

test('the summary buttons wrap the selection, the whole expression, or open an empty one', () => {
    assert.deepEqual(wrapInSummary('a + b', 0, 1, 'final'), { text: 'final(a) + b', selectionStart: 0, selectionEnd: 8 });
    assert.deepEqual(wrapInSummary('(a - b)^2', 4, 4, 'integral'), { text: 'integral((a - b)^2)', selectionStart: 0, selectionEnd: 19 });
    assert.deepEqual(wrapInSummary('', 0, 0, 'max'), { text: 'max()', selectionStart: 4, selectionEnd: 4 });
    assert.deepEqual(insertName('1 + ', 4, 4, 'k'), { text: '1 + k', selectionStart: 5, selectionEnd: 5 });
});

test('the payload and the run settings are checked before a run starts', () => {
    assert.deepEqual(objectivePayload({ expression: ' final(a) ', direction: 'maximise', targetTime: 10, timeStep: 1, variables: [] }), { expression: 'final(a)', direction: 'maximise', targetTime: 10, timeStep: 1, variables: [], constraints: [] });
    assert.equal(objectivePayload({ expression: 'x', direction: 'whatever', targetTime: 1, timeStep: 1, variables: [] }).direction, 'minimise');
    assert.equal(runSettingsError(10, 1), '');
    assert.match(runSettingsError(0, 1), /how long/);
    assert.match(runSettingsError(10, 0), /time step/);
    assert.match(runSettingsError(1, 10), /longer than the run/);
});

test('limit rows: empty ones are ignored, half-filled ones say what is missing', () => {
    assert.deepEqual(constraintRows([{ expression: '', limit: '' }]), { error: '', constraints: [] });
    assert.deepEqual(constraintRows([{ expression: ' max(a) ', relation: '>=', limit: '3.5' }, { expression: '', limit: '' }]), { error: '', constraints: [{ expression: 'max(a)', relation: '>=', limit: 3.5 }] });
    assert.match(constraintRows([{ expression: 'max(a)', limit: '' }]).error, /Limit 1 needs a number/);
    assert.match(constraintRows([{ expression: '', limit: '4' }]).error, /Limit 1 needs something to limit/);
    assert.deepEqual(objectivePayload({ expression: 'x', direction: 'minimise', targetTime: 1, timeStep: 1, variables: [], constraints: [{ expression: ' a ', relation: 'weird', limit: '2' }] }).constraints, [{ expression: 'a', relation: '<=', limit: 2 }]);
});
