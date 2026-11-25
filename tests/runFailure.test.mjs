/* Copyright © 2026 Zenin Easa Panthakkalakath */

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRunFailure } from '../src/runFailure.mjs';

// The springMassDamper FMU (Konjugate's own FMI 3.0 export of the shipped example) in a node whose parameters read
// states of the node, one of them left at 0: the failure the FMU round-trip walk met (docs/proposals/fmuImportWorkflow.md).
const springPorts = {
    name: 'springMassDamper', fmiVersion: '3.0',
    inputs: [
        { key: 'stiffness', name: 'stiffness', causality: 'parameter', variability: 'tunable' },
        { key: 'springForceMass', name: 'Spring force.mass', causality: 'parameter', variability: 'tunable' }
    ],
    outputs: [{ key: 'suspendedMassDisplacement', name: 'Suspended mass.Displacement' }]
};
const springDocument = {
    nodes: [{
        id: 2, name: 'Round trip',
        states: [
            { id: 10, symbol: 'suspendedMassDisplacement', initialValue: 0.1, unit: 'm' },
            { id: 11, symbol: 'stiffness', initialValue: 4, unit: 'N/m' },
            { id: 12, symbol: 'springForceMass', initialValue: 0, unit: 'kg' }
        ],
        implementation: {
            kind: 'fmi', fmuId: '{32b96ce7}', fmuVersion: '1.0.0',
            bindings: [{ key: 'stiffness', kind: 'state', stateId: 11 }, { key: 'springForceMass', kind: 'state', stateId: 12 }],
            outputs: [{ key: 'suspendedMassDisplacement', stateId: 10, setsValue: true }]
        }
    }]
};

test('an FMU that refused its step is named by its node, with its parameters at the start and the one at 0', () => {
    const message = 'ENGINE_FAILURE: A node program failed: The FMU \'springMassDamper\' refused fmi3DoStep (a step of 0.01) at t = 0: logStatusError: fmi3DoStep at t = 0: A contribution produced a non-finite derivative.';
    const failure = describeRunFailure(message, springDocument, { 2: springPorts });
    assert.equal(failure.title, 'The run stopped at t = 0 s: the FMU in \'Round trip\' refused its step (a step of 0.01 s).');
    assert.deepEqual(failure.lines, [
        'It said: fmi3DoStep at t = 0: A contribution produced a non-finite derivative.',
        'Its parameters at the start: stiffness = 4 N/m, Spring force.mass = 0 kg.',
        'A parameter at 0 is a common cause: check Spring force.mass.'
    ]);
    assert.deepEqual(failure.nodeIds, [2]);
    assert.equal(failure.message.startsWith('The FMU \'springMassDamper\' refused fmi3DoStep'), true, 'The code and the wrapper are taken off the engine\'s text.');
});

test('a value the FMU refuses is named with what it read and the value it started from', () => {
    const ports = { name: 'Feedthrough', inputs: [{ key: 'enumerationInput', name: 'Enumeration_input', causality: 'input' }], outputs: [] };
    const document = {
        nodes: [
            { id: 1, name: 'Source', states: [{ id: 5, symbol: 'level', initialValue: 0, unit: '' }] },
            { id: 3, name: 'Feedthrough', states: [], implementation: { kind: 'fmi', bindings: [{ key: 'enumerationInput', kind: 'state', nodeId: 1, stateId: 5 }], outputs: [] } }
        ]
    };
    const failure = describeRunFailure('ENGINE_FAILURE: A node program failed: The FMU \'Feedthrough\' refused fmi3SetInt64 (setting \'Enumeration_input\') at t = 0: logStatusError: 0 is not a legal value for Enumeration_input.', document, { 3: ports });
    assert.equal(failure.title, 'The run stopped at t = 0 s: the FMU in \'Feedthrough\' refused the value given to Enumeration_input.');
    assert.deepEqual(failure.lines, ['It said: 0 is not a legal value for Enumeration_input.', 'Enumeration_input was 0 at the start (it reads Source.level).']);
    assert.deepEqual(failure.nodeIds, [3]);
});

test('a shared parameter is named, and a scheduled one is said to follow its schedule', () => {
    const ports = { name: 'Heater', inputs: [{ key: 'gain', name: 'gain', causality: 'parameter' }, { key: 'offset', name: 'offset', causality: 'parameter' }], outputs: [] };
    const document = {
        nodes: [{ id: 1, name: 'Heater', states: [], implementation: { kind: 'fmi', bindings: [{ key: 'gain', kind: 'parameter', sharedParameterId: 7 }, { key: 'offset', kind: 'parameter', sharedParameterId: 8 }], outputs: [] } }],
        sharedParameters: [{ id: 7, name: 'Gain', symbol: 'gain', value: 2.5, unit: 'W/K' }, { id: 8, name: 'Offset', symbol: 'offset', value: 1, schedule: { interpolation: 'hold', samples: [[0, 1]] } }]
    };
    const failure = describeRunFailure('The FMU \'Heater\' refused fmi2DoStep (a step of 0.1) at t = 3.2: it gave no reason.', document, { 1: ports });
    assert.equal(failure.title, 'The run stopped at t = 3.2 s: the FMU in \'Heater\' refused its step (a step of 0.1 s).');
    assert.deepEqual(failure.lines, ['Its parameters at the start: gain = 2.5 W/K, offset = follows a schedule (shared Offset).']);
});

test('an FMU whose ports could not be read is still named, by its node when it is the only FMU', () => {
    const document = { nodes: [{ id: 4, name: 'Plant', states: [], implementation: { kind: 'fmi', bindings: [], outputs: [] } }] };
    const failure = describeRunFailure('The FMU \'Plant\' failed fatally in fmi2Instantiate: it gave no reason.', document, {});
    assert.equal(failure.title, 'The run stopped: the FMU in \'Plant\' stopped with a fatal error on its start.');
    assert.deepEqual(failure.lines, []);
    const two = { nodes: [...document.nodes, { id: 5, name: 'Other', states: [], implementation: { kind: 'fmi' } }] };
    assert.equal(describeRunFailure('The FMU \'Plant\' refused fmi2ExitInitializationMode at t = 0: bad.', two, {}).title,
        'The run stopped at t = 0 s: the FMU \'Plant\' refused its start values.', 'With two FMU nodes and no ports, the FMU is named by its model.');
});

test('two nodes running one FMU are both named', () => {
    const document = { nodes: [1, 2].map((id) => ({ id, name: `Tank ${id}`, states: [], implementation: { kind: 'fmi', bindings: [], outputs: [] } })) };
    const ports = { name: 'Tank', inputs: [], outputs: [] };
    const failure = describeRunFailure('The FMU \'Tank\' refused fmi3DoStep (a step of 1) at t = 2: overflow', document, { 1: ports, 2: ports });
    assert.equal(failure.title, 'The run stopped at t = 2 s: the FMU in \'Tank 1\' and \'Tank 2\' refused its step (a step of 1 s).');
    assert.deepEqual(failure.lines, ['It said: overflow.']);
    assert.deepEqual(failure.nodeIds, [1, 2]);
});

test('a failure of the model\'s own equations is said as the engine says it, with a relationship by its name and a hint', () => {
    const document = { edges: [{ id: 12, name: 'Heat loss' }] };
    const failure = describeRunFailure('ENGINE_FAILURE: The relationship 12 produced a non-finite value for state 3 at t = 1.', document);
    assert.equal(failure.title, 'The run stopped: The relationship \'Heat loss\' produced a non-finite value for state 3 at t = 1.');
    assert.match(failure.lines[0], /division by zero/);
    assert.equal(describeRunFailure('Error: A contribution task produced a non-finite derivative.').title, 'The run stopped: A contribution task produced a non-finite derivative.');
    assert.deepEqual(describeRunFailure('').lines, []);
    assert.equal(describeRunFailure('').title, 'The run stopped, and the engine gave no reason.');
});

test('a parameter left to the FMU is given as its own start value, and one given in the file as that value', () => {
    const ports = { name: 'Spring', inputs: [{ key: 'mass', name: 'mass', causality: 'parameter', start: 0 }, { key: 'k', name: 'k', causality: 'parameter', start: 4 }], outputs: [] };
    const document = { nodes: [{ id: 1, name: 'Spring', states: [], implementation: { kind: 'fmi', bindings: [{ key: 'k', kind: 'value', value: 2.5 }], outputs: [] } }] };
    const failure = describeRunFailure('The FMU \'Spring\' refused fmi3DoStep (a step of 0.01) at t = 0: it gave no reason.', document, { 1: ports });
    assert.deepEqual(failure.lines, [
        'Its parameters at the start: mass = 0 (the FMU\'s own start value), k = 2.5.',
        'A parameter at 0 is a common cause: check mass.'
    ]);
});
