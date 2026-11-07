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

test('a limit on a number the objective program reports is kept by its name', () => {
    const setup = normalizeTuningSetup({ goal: 'objective', objective: { expression: '', direction: 'minimise', program: { language: 'python', source: 'x', bindings: [] }, constraints: [{ report: ' peak ', relation: '<=', limit: '3' }, { report: '', limit: 1 }] } });
    assert.deepEqual(setup.objective.constraints, [{ report: 'peak', relation: '<=', limit: 3 }], 'a limit with no name is dropped');
});

test('a live twin\'s estimate is kept with its noise, and the estimator\'s size and drifts with the live settings', () => {
    const setup = normalizeTuningSetup({ goal: 'replay', replay: {
        logFileName: 'rig.csv', mapping: [{ signal: 'level', role: 'output', target: 2 }],
        corrections: { level: { estimate: true, noise: 0.2 }, flow: { estimate: true, noise: -1 }, other: 0.3, wrong: { estimate: 'yes' } },
        live: { window: 3600, members: 12, drift: { 3: 0.001, x: 2, 4: -1 } }
    } });
    assert.deepEqual(setup.replay.corrections, { level: { estimate: true, noise: 0.2 }, flow: { estimate: true }, other: 0.3 });
    assert.equal(setup.replay.live.members, 12);
    assert.deepEqual(setup.replay.live.drift, { 3: 0.001 });
    assert.equal(normalizeTuningSetup({ goal: 'replay', replay: { logFileName: 'a', mapping: [], live: { members: 2 } } }).replay.live.members, undefined, 'An ensemble too small to estimate with is dropped.');
});
