/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { captureProgramWarnings, programWarningIssues } from '../src/programWarnings.mjs';

const documentWith = (heaterSource = 'class A: pass') => ({
    nodes: [
        { id: 1, name: 'Heater', implementation: { kind: 'python', source: heaterSource, bindings: [] }, sourceTerms: [] },
        { id: 2, name: 'Room', sourceTerms: [{ id: 5, implementation: { kind: 'cpp', source: 'x', bindings: [] } }] },
        { id: 3, name: 'Cooler', implementation: { kind: 'python', source: heaterSource, bindings: [] }, sourceTerms: [] }
    ],
    edges: [{ id: 10, name: 'Wall → Room', implementation: { kind: 'python', source: 'y', bindings: [] } }]
});

const result = {
    programWarnings: [
        { code: 'inputUnbound', language: 'python', entityIds: [1], port: 'setpoint' },
        { code: 'inputUnbound', language: 'cpp', entityIds: [5], port: 'hot' },
        { code: 'inputUnbound', language: 'python', entityIds: [10], port: 'cold' },
        { code: 'sharedCheckpoint', language: 'python', entityIds: [1, 3] }
    ]
};

test('each warning names the program, where it is used and the port, as a validation warning at its node or relationship', () => {
    const issues = programWarningIssues(captureProgramWarnings(result, documentWith()), documentWith());
    assert.deepEqual(issues.map((issue) => [issue.code, issue.severity, issue.location]), [
        ['programInputUnbound', 'warning', { kind: 'node', entityId: '1', field: '' }],
        ['programInputUnbound', 'warning', { kind: 'node', entityId: '2', field: 'sourceTerms' }],
        ['programInputUnbound', 'warning', { kind: 'edge', entityId: '10', field: '' }],
        ['programSharedCheckpoint', 'warning', { kind: 'node', entityId: '1', field: '' }]
    ]);
    assert.equal(issues[0].message, 'The Python program on the node Heater declares the input ‘setpoint’, but nothing is bound to it, so it reads 0. Bind it among the program\'s inputs, or take it out of describe().');
    assert.match(issues[1].message, /^The C\+\+ program on a term of Room declares the input ‘hot’/);
    assert.match(issues[2].message, /on the relationship Wall → Room declares the input ‘cold’/);
    assert.match(issues[3].message, /^The nodes Heater and Cooler run the same Python program, which runs as one object for all of them/);
});

test('a warning is dropped once the program it was found against changes, or is gone', () => {
    const captured = captureProgramWarnings(result, documentWith());
    const edited = programWarningIssues(captured, documentWith('class B: pass'));
    assert.deepEqual(edited.map((issue) => issue.location.entityId), ['2', '10']);
    assert.deepEqual(programWarningIssues(captured, { nodes: [], edges: [] }), []);
});

test('a result without warnings captures none', () => {
    assert.deepEqual(captureProgramWarnings({}, documentWith()), []);
    assert.deepEqual(programWarningIssues([], documentWith()), []);
});
