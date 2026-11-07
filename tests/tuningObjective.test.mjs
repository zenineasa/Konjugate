/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { constraintRows, measuredDataObjectiveLatex, objectivePayload, objectiveVocabulary, reportedNames, runSettingsError } from '../src/renderer/tuningObjective.mjs';
import { latexToObjectiveText, objectiveNameLatex } from '../src/objectiveText.mjs';

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
    assert.deepEqual(states.map((state) => state.name), ['waterTankTankTemperature', 'ambientAirTemperature', 'waterTankTemperature']);
    assert.deepEqual(variables.find((variable) => variable.name === 'waterTankTemperature'), { name: 'waterTankTemperature', kind: 'state', id: 6 });
    // The linked parameter is left out (the shared one stands for it); tunable ones come first; a symbol used twice is told apart by its owner.
    assert.deepEqual(parameters.map((parameter) => [parameter.name, parameter.tunable]), [
        ['capacitance', true], ['lossGain', true], ['loss', false], ['otherGain', false]
    ]);
    assert.deepEqual(variables.filter((variable) => variable.kind === 'measured').map((variable) => variable.name), ['measuredReading', 'measuredReading2']);
});

test('the payload and the run settings are checked before a run starts', () => {
    assert.deepEqual(objectivePayload({ expression: ' final(a) ', direction: 'maximise', targetTime: 10, timeStep: 1, variables: [] }), { expression: 'final(a)', latex: '', direction: 'maximise', targetTime: 10, timeStep: 1, variables: [], constraints: [] });
    assert.equal(objectivePayload({ expression: 'x', direction: 'whatever', targetTime: 1, timeStep: 1, variables: [] }).direction, 'minimise');
    assert.equal(runSettingsError(10, 1), '');
    assert.match(runSettingsError(0, 1), /how long/);
    assert.match(runSettingsError(10, 0), /time step/);
    assert.match(runSettingsError(1, 10), /longer than the run/);
});

test('limit rows: empty ones are ignored, unreadable and half-filled ones say what is wrong', () => {
    assert.deepEqual(constraintRows([{ expression: '', latex: '', limit: '' }]), { error: '', constraints: [] });
    assert.deepEqual(constraintRows([{ expression: ' max(a) ', latex: '\\max(a)', relation: '>=', limit: '3.5' }, { expression: '', limit: '' }]), { error: '', constraints: [{ expression: 'max(a)', latex: '\\max(a)', relation: '>=', limit: 3.5 }] });
    assert.match(constraintRows([{ expression: 'max(a)', limit: '' }]).error, /Limit 1 needs a number/);
    assert.match(constraintRows([{ expression: '', latex: '', limit: '4' }]).error, /Limit 1 needs something to limit/);
    assert.match(constraintRows([{ expression: '', latex: 'k+', problem: 'It could not be parsed.', limit: '4' }]).error, /Limit 1: It could not be parsed/);
    assert.deepEqual(objectivePayload({ expression: 'x', direction: 'minimise', targetTime: 1, timeStep: 1, variables: [], constraints: [{ expression: ' a ', relation: 'weird', limit: '2' }] }).constraints, [{ expression: 'a', latex: '', relation: '<=', limit: 2 }]);
});

test('matching measured data is written as an objective: the mean squared difference of each matched state and its column, added up', () => {
    const vocabulary = objectiveVocabulary(document, ['tankTemperature', 'air']);
    const latex = measuredDataObjectiveLatex([{ columnName: 'tankTemperature', stateId: 2 }, { columnName: 'air', stateId: 4 }, { columnName: 'gone', stateId: 99 }], vocabulary, objectiveNameLatex);
    const result = latexToObjectiveText(latex, vocabulary.variables.map((variable) => variable.name));
    assert.ok(result.valid, result.errors.join(' '));
    assert.equal(result.text, 'mean(((ambientAirTemperature + (-measuredAir)) ^ 2)) + mean((((-measuredTankTemperature) + waterTankTankTemperature) ^ 2))', 'a pair that no longer exists is left out');
    assert.equal(result.sentence, 'the average of the squared difference between ambientAirTemperature and measuredAir over the run, plus the average of the squared difference between waterTankTankTemperature and measuredTankTemperature over the run');
    assert.equal(measuredDataObjectiveLatex([], vocabulary, objectiveNameLatex), null, 'nothing matched, nothing to write');
});

test('a limit can be a number the objective program reports, by its name', () => {
    assert.deepEqual(constraintRows([{ report: ' peak ', relation: '<=', limit: '3' }, { report: '', limit: '' }]), { error: '', constraints: [{ report: 'peak', relation: '<=', limit: 3 }] }, 'an empty reported row is ignored');
    assert.match(constraintRows([{ report: '', limit: '2' }]).error, /Limit 1 needs the name of a number the program reports/);
    assert.match(constraintRows([{ report: 'peak', limit: 'x' }]).error, /needs a number to stay within/);
    const payload = objectivePayload({ expression: '', direction: 'minimise', targetTime: 1, timeStep: 1, variables: [], constraints: [{ report: 'peak', relation: '>=', limit: 2 }, { expression: ' max(a) ', latex: 'L', relation: '<=', limit: 1 }] });
    assert.deepEqual(payload.constraints, [{ report: 'peak', relation: '>=', limit: 2 }, { expression: 'max(a)', latex: 'L', relation: '<=', limit: 1 }]);
    assert.deepEqual(reportedNames('run.report("peak", peak)\n    run.report( \'final\' , x);\nrun.report("peak", 2)\nreporter("no", 1)'), ['peak', 'final'], 'each name once, in either language, quotes of either kind');
});
