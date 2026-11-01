/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTuningSetup, sameTuningSetup, tuningSetupFromRun } from '../src/tuningSetup.mjs';

test('a project without a setup, or with something that is not one, has none', () => {
    for (const raw of [undefined, null, 'x', 4, [], [{ goal: 'data' }]]) assert.equal(normalizeTuningSetup(raw), null);
});

test('a saved objective setup keeps what it needs and drops what is unusable', () => {
    const setup = normalizeTuningSetup({
        goal: 'objective', backend: 'nlopt-bobyqa', maxSimulations: 40.4, maxMinutes: -3, csvFileName: 'plant.csv', extra: true,
        objective: { expression: 'final(a)', direction: 'sideways', targetTime: 10, timeStep: 'soon' }
    });
    assert.deepEqual(setup, {
        version: 1, goal: 'objective', backend: 'nlopt-bobyqa', maxSimulations: 40, csvFileName: 'plant.csv',
        objective: { expression: 'final(a)', direction: 'minimise', targetTime: 10 }
    });
});

test('an unknown goal is the measured-data goal, which carries no objective', () => {
    assert.deepEqual(normalizeTuningSetup({ goal: 'surprise', objective: { expression: 'x' } }), { version: 1, goal: 'data' });
});

test('what a run records round-trips, and an unchanged setup is recognised', () => {
    const run = { goal: 'objective', backend: 'nlopt-isres', maxSimulations: 200, maxMinutes: 5, csvFileName: null, objective: { expression: 'max(a)', direction: 'maximise', targetTime: 20, timeStep: 0.5 } };
    const setup = tuningSetupFromRun(run);
    assert.deepEqual(normalizeTuningSetup(JSON.parse(JSON.stringify(setup))), setup);
    assert.ok(sameTuningSetup(setup, tuningSetupFromRun(run)));
    assert.ok(!sameTuningSetup(setup, tuningSetupFromRun({ ...run, maxSimulations: 201 })));
    assert.ok(sameTuningSetup(null, undefined));
});

test('saved limits keep their relation and number, and a limit without a usable number is dropped', () => {
    const setup = normalizeTuningSetup({ goal: 'objective', objective: { expression: 'a', direction: 'minimise', constraints: [{ expression: 'max(a)', relation: '>=', limit: '2' }, { expression: 'min(a)', limit: 'many' }, { expression: '  ', limit: 1 }] } });
    assert.deepEqual(setup.objective.constraints, [{ expression: 'max(a)', relation: '>=', limit: 2 }]);
    assert.equal(normalizeTuningSetup({ goal: 'objective', objective: { expression: 'a', latex: '\\mathrm{a}', constraints: [{ expression: 'b', latex: 'b', limit: 1 }] } }).objective.latex, '\\mathrm{a}', 'the LaTeX the objective was written in is kept to show it again');
});
