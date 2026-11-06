/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The starter objective programs (src/objectiveTemplates.mjs), a program's bindings, and the program kept with the project's tuning
// setup (src/tuningSetup.mjs).

import assert from 'node:assert/strict';
import test from 'node:test';
import { objectiveTemplate, objectiveTemplateIds, programBindingsProblem } from '../src/objectiveTemplates.mjs';
import { normalizeTuningSetup, tuningSetupFromRun } from '../src/tuningSetup.mjs';

test('every template exists in both languages and reads exactly the keys it declares', () => {
    assert.deepEqual(objectiveTemplateIds, ['squaredError', 'settlingTime', 'overshoot']);
    for (const id of objectiveTemplateIds) {
        for (const language of ['python', 'cpp']) {
            const { source, keys } = objectiveTemplate(id, language);
            const read = [...source.matchAll(/run\.series\("([A-Za-z_]\w*)"\)/g)].map((match) => match[1]);
            assert.deepEqual([...new Set(read)].sort(), keys.map((key) => key.key).sort(), `${id} in ${language}`);
            assert.match(source, language === 'cpp' ? /double objective\(const konjugate::Run& run\)/ : /def objective\(run\):/);
        }
    }
    assert.throws(() => objectiveTemplate('nothing', 'python'), /no objective template/);
});

test('bindings need a key each, used once, and something to read', () => {
    assert.equal(programBindingsProblem([{ key: 'simulated', kind: 'state', id: 2 }, { key: 'measured', kind: 'measured', column: 'T' }]), '');
    assert.match(programBindingsProblem([{ key: '', kind: 'state', id: 2 }]), /needs a key/);
    assert.match(programBindingsProblem([{ key: '1x', kind: 'state', id: 2 }]), /needs a key/);
    assert.match(programBindingsProblem([{ key: 'a', kind: 'state', id: 2 }, { key: 'a', kind: 'parameter', id: 3 }]), /used twice/);
    assert.match(programBindingsProblem([{ key: 'a', kind: 'state', id: null }]), /not bound/);
    assert.match(programBindingsProblem([{ key: 'a', kind: 'measured', column: '' }]), /not bound/);
});

test('an objective program is kept with the tuning setup and comes back as it was', () => {
    const program = { language: 'cpp', source: 'double objective(const konjugate::Run& run) { return 0; }', bindings: [{ key: 'response', kind: 'state', id: 2 }, { key: 'measured', kind: 'measured', column: 'T' }] };
    const setup = tuningSetupFromRun({ goal: 'objective', backend: 'nlopt-bobyqa', maxSimulations: 50, objective: { expression: '', latex: '', direction: 'maximise', targetTime: 600, timeStep: 60, constraints: [], program } });
    assert.deepEqual(setup.objective.program, program);
    assert.deepEqual(normalizeTuningSetup(JSON.parse(JSON.stringify(setup))), setup);
    // Something unusable in a hand-edited file is dropped, never thrown.
    assert.equal(normalizeTuningSetup({ goal: 'objective', objective: { program: { language: 'fortran', source: 'x' } } }).objective, undefined);
    assert.deepEqual(normalizeTuningSetup({ goal: 'objective', objective: { program: { language: 'python', source: 'x', bindings: [{ key: 'a', kind: 'node' }, { key: 'b', kind: 'state', id: 4 }] } } }).objective.program.bindings, [{ key: 'b', kind: 'state', id: 4 }]);
});
