/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A twin's setup as a project keeps it (src/twinSetup.mjs): what is usable kept, what is not dropped, and the live twin's mapping and
// conversions made from it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTiming, modelTimeStep, normalizeTwinSetup, timingFromReadings, timingProblem, twinSessionMapping } from '../src/twinSetup.mjs';

test('a setup keeps its source, its usable mapping entries and its settings, and drops the rest', () => {
    const setup = normalizeTwinSetup({
        source: { kind: 'opcua', url: 'opc.tcp://plc:4840', security: 'signAndEncrypt' },
        mapping: [
            { source: 'ns=2;s=TT101', name: 'TT101', role: 'output', target: { kind: 'state', id: 2 }, unit: '°C', conversion: { scale: 1, offset: 273.15 } },
            { source: 'ns=2;s=JI101', name: 'JI101', role: 'input', target: { kind: 'parameter', id: 40 }, unit: 'kW', conversion: { scale: 1000, offset: 0 } },
            { source: 'ns=2;s=Note', name: 'note', role: null, target: null, unit: '' },
            { source: 'ns=2;s=Wrong', name: 'wrong', role: 'output', target: { kind: 'parameter', id: 40 } },
            { source: 'ns=2;s=TT101', name: 'TT101', role: 'output', target: { kind: 'state', id: 3 } },
            { source: 'x', name: '1bad', role: null },
            { source: 'y', name: 'zero', role: 'output', target: { kind: 'state', id: 5 }, conversion: { scale: 0, offset: 1 } }
        ],
        live: { window: 3600, stride: 600, horizon: -1, speed: '600', alert: 0.3 }
    });
    assert.deepEqual(setup.source, { kind: 'opcua', url: 'opc.tcp://plc:4840', security: 'signAndEncrypt' });
    assert.deepEqual(setup.mapping.map((entry) => entry.name), ['TT101', 'JI101', 'note', 'wrong', 'zero'], 'A repeated name and a name that is not an identifier are dropped.');
    assert.deepEqual(setup.mapping[3], { source: 'ns=2;s=Wrong', name: 'wrong', role: null, target: null, unit: '', conversion: null }, 'A measured signal cannot map to a parameter: kept, unmapped.');
    assert.equal(setup.mapping[4].conversion, null, 'A scale of zero is no conversion.');
    assert.deepEqual(setup.live, { window: 3600, stride: 600, speed: '600', alert: 0.3 });
    assert.equal(normalizeTwinSetup({ source: { kind: 'ftp' } }), null);
    assert.equal(normalizeTwinSetup('nonsense'), null);

    const { mapping, conversions } = twinSessionMapping(setup);
    assert.deepEqual(mapping, [
        { signal: 'TT101', role: 'output', unit: '°C', stateId: 2 },
        { signal: 'JI101', role: 'input', unit: 'kW', parameterId: 40 },
        { signal: 'zero', role: 'output', unit: '', stateId: 5 }
    ]);
    assert.deepEqual(conversions, { TT101: { scale: 1, offset: 273.15 }, JI101: { scale: 1000, offset: 0 } });
});

test('the engineer\'s settings, the room\'s layout and the last run\'s events are kept, what is unusable dropped', () => {
    const setup = normalizeTwinSetup({
        source: { kind: 'push' },
        mapping: [
            { source: 'a', name: 'tankT', role: 'output', target: { kind: 'state', id: 3 } },
            { source: 'b', name: 'power', role: 'input', target: { kind: 'parameter', id: 9 } }
        ],
        live: { timeStep: 30, members: 64, corrections: { tankT: { estimate: true }, power: { gain: 2 }, ghost: { gain: 0.5 } }, untracked: [10, 10, -1, 'x'] },
        layout: { order: ['tankT', 'ghost'], tall: ['tankT'], pinned: [], hidden: 'tankT', bounds: { x: 1920, y: 0, width: 1600, height: 900, maximized: true } },
        record: { startedAt: '2026-11-07T10:00:00Z', events: [{ at: '2026-11-07T10:05:00Z', kind: 'bad', text: 'Drifting', detail: 'past the warning' }, { at: 'x', kind: 'nonsense', text: 'dropped' }] }
    });
    assert.deepEqual(setup.live, { timeStep: 30, members: 64, corrections: { tankT: { estimate: true } }, untracked: [10] });
    assert.deepEqual(setup.layout, { order: ['tankT'], tall: ['tankT'], bounds: { x: 1920, y: 0, width: 1600, height: 900, maximized: true } });
    assert.deepEqual(setup.record, { startedAt: '2026-11-07T10:00:00Z', events: [{ at: '2026-11-07T10:05:00Z', kind: 'bad', text: 'Drifting', detail: 'past the warning' }] });
    assert.equal(normalizeTwinSetup({ source: { kind: 'push' }, mapping: [], layout: { bounds: { x: 0, y: 0, width: 10, height: 10 } } }).layout, undefined, 'A window too small to use is not kept.');
});

test('how much of the past the room\'s plots show is kept: everything, or a span in seconds', () => {
    const span = (value) => normalizeTwinSetup({ source: { kind: 'push' }, mapping: [], layout: { span: value } }).layout?.span;
    assert.equal(span('all'), 'all');
    assert.equal(span(3600), 3600);
    for (const unusable of [0, -60, Infinity, 'recent', '3600', null]) assert.equal(span(unusable), undefined, `${String(unusable)} is not a span.`);
});

test('timing the twin cannot run with is said in the engineer\'s terms', () => {
    assert.equal(timingProblem({ window: 3600, stride: 600, horizon: 3600, timeStep: 60 }), null);
    assert.equal(timingProblem({ window: 1200, stride: 1800, horizon: 3600, timeStep: 60 }), 'The twin moves at least once a window: with a 20 min window, move every 20 min or less (now every 30 min).');
    assert.equal(timingProblem({ window: 3000, stride: 1200, horizon: 3600, timeStep: 60 }), 'The window must hold a whole number of moves: 50 min is not a multiple of 20 min (try 60 min).');
    assert.equal(timingProblem({ window: 3600, stride: 600, horizon: 90, timeStep: 60 }), 'The forecast (90 s) must be a whole number of time steps (1 min each).');
    assert.equal(timingProblem({ window: 5, stride: 0.5, horizon: 5, timeStep: 0.001 }), null, 'A motor\'s five seconds at a millisecond.');
    assert.match(timingProblem({ window: 3600, stride: 600, horizon: 3600, timeStep: 0 }), /time step must be a positive/);
});

test('timing not kept with a setup follows how often the readings come, and can always run', () => {
    // Readings a minute apart, or none known: the usual hour's window moving every ten minutes.
    assert.deepEqual(defaultTiming({ spacing: 60, timeStep: 60 }), { window: 3600, stride: 600, horizon: 3600 });
    assert.deepEqual(defaultTiming({ timeStep: 60 }), { window: 3600, stride: 600, horizon: 3600 });
    // A motor read every 50 ms on a millisecond step: a move a second, six seconds of window and of forecast.
    assert.deepEqual(defaultTiming({ spacing: 0.05, timeStep: 0.001 }), { window: 6, stride: 1, horizon: 6 });
    // Readings every ten seconds: a round five minutes between moves.
    assert.deepEqual(defaultTiming({ spacing: 10, timeStep: 1 }), { window: 1800, stride: 300, horizon: 1800 });
    for (const [spacing, timeStep] of [[0.05, 0.001], [2, 0.01], [5, 0.5], [7, 3], [0.001, 0.001], [3600, 60]]) {
        assert.equal(timingProblem({ ...defaultTiming({ spacing, timeStep }), timeStep }), null, `${spacing} s readings on a ${timeStep} s step`);
    }
});

test('a live source\'s timing is chosen once a measured signal has enough readings, from their spacing', () => {
    const every = (step, count) => Array.from({ length: count }, (_, index) => 100 + index * step + (index % 2 ? 1e-7 : 0));
    assert.equal(timingFromReadings({ motorSpeed: every(0.05, 5) }, { timeStep: 0.001 }), null, 'Not before six readings.');
    assert.deepEqual(timingFromReadings({ motorSpeed: every(0.05, 6), slow: every(1, 6) }, { timeStep: 0.001 }), { window: 6, stride: 1, horizon: 6, timeStep: 0.001, spacing: 0.05 });
    // The step follows the readings when it was not kept: a model stepped every minute, read every 50 ms, is stepped every 50 ms.
    assert.equal(timingFromReadings({ motorSpeed: every(0.05, 6) }, { timeStep: 60, step: true }).timeStep, 0.05);
    assert.equal(timingFromReadings({ motorSpeed: every(0.05, 6) }, { timeStep: 60 }).timeStep, 60);
    assert.deepEqual(timingFromReadings({ tank: every(60, 6) }, { timeStep: 60, step: true }), { window: 3600, stride: 600, horizon: 3600, timeStep: 60, spacing: 60 });
});

test('a model\'s own step is its active run configuration\'s', () => {
    assert.equal(modelTimeStep({ activeRunConfigurationId: 2, runConfigurations: [{ id: 1, globalTimeStep: 1 }, { id: 2, globalTimeStep: 0.001 }] }), 0.001);
    assert.equal(modelTimeStep({ runConfigurations: [{ id: 1, globalTimeStep: 60 }] }), 60);
    assert.equal(modelTimeStep({}), null);
});
