/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A parameter fit through the real engine reports every simulation as it finishes, can be told to stop and then still
// reports the best values it found, and can be limited in time. The model is one state that integrates a tuned gain
// (dx/dt = gain), measured from a run with gain 3, so a fit that is allowed to finish recovers 3.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/fitProgress.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { fitWithEngine } from '../../src/engineAdapter.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

const project = () => ({
    format: 'konjugate', version: 1, metadata: { units: 'SI' },
    nodes: [
        { id: 1, name: 'Source', position: [0, 0, 0], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#888888' }, states: [{ id: 2, name: 'Source', symbol: 'source', initialValue: 0 }] },
        { id: 3, name: 'X', position: [0, 0, 0], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#888888' }, states: [{ id: 4, name: 'X', symbol: 'x', initialValue: 0 }] }
    ],
    edges: [{
        id: 7, name: 'Feed', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 3, stateId: 4 }, directionality: 'directed',
        equation: '\\mathrm{gain}',
        equationModel: { latex: '\\mathrm{gain}', output: { role: 'target', stateId: 4 }, bindings: [{ kind: 'parameter', parameterId: 8, symbol: 'gain' }], mathJson: 'gain' },
        parameters: [{ id: 8, name: 'Gain', symbol: 'gain', value: 1, mode: 'constant', tuning: { minimum: 0, maximum: 10 } }],
        appearance: { color: '#888888', offset: 0 }
    }],
    runConfigurations: [{ id: 200, name: 'Default', globalTimeStep: 0.1, outputInterval: 0.1 }],
    activeRunConfigurationId: 200
});
// x grows at the gain, so with gain 3 it is 3t: the same grid the fit simulates on (every 0.1 s, to 1 s).
const csv = ['time,x', ...Array.from({ length: 11 }, (_, row) => `${(row * 0.1).toFixed(1)},${(3 * row * 0.1).toFixed(6)}`)].join('\n');
const fit = (config, hooks = {}) => fitWithEngine(JSON.stringify(project()), csv, config, { ...engineOptions, ...hooks });

// ---- A fit left alone: every simulation is reported, first the starting values, and the best never gets worse ----------------
const events = [];
const finished = await fit({ backend: 'nlopt-bobyqa', maxIterations: 200 }, { onProgress: (event) => events.push(event) });
assert.equal(finished.available, true);
assert.ok(events.length > 3, `Expected a progress event for each simulation, got ${events.length}.`);
assert.equal(events[0].baseline, true, 'The first event must be the starting values.');
assert.equal(events[0].iteration, 1);
assert.deepEqual(events[0].parameterValues, [1]);
assert.deepEqual(events[0].parameterIds, [8], 'The starting event says which parameter each value is.');
assert.ok(events.slice(1).every((event) => event.parameterIds.length === 0), 'Only the starting event carries the ids.');
assert.equal(events.filter((event) => event.baseline).length, 1);
assert.ok(events[0].elapsedSeconds > 0, 'The first event carries what one simulation cost.');
for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index].iteration, events[index - 1].iteration + 1, 'Events are numbered one after another.');
    assert.ok(events[index].bestLoss <= events[index - 1].bestLoss + 1e-12, 'The best loss never gets worse.');
    assert.ok(events[index].elapsedSeconds >= events[index - 1].elapsedSeconds);
}
assert.equal(finished.report.evaluations, events.at(-1).iteration, 'The report counts the simulations the events counted.');
assert.equal(finished.report.failedTrials, 0);
assert.equal(finished.report.stopped, false);
assert.equal(finished.report.finalLoss, events.at(-1).bestLoss);
assert.ok(Math.abs(finished.report.finalParameters[0].value - 3) < 0.05, `The fit should recover 3, got ${finished.report.finalParameters[0].value}.`);
assert.ok(finished.report.elapsedSeconds > 0);

// ---- Told to stop: it ends at once, and still reports the best values it simulated --------------------------------------------
const stopEvents = [];
let requestStop = null;
const stopped = await fit({ backend: 'nlopt-isres', maxIterations: 100000 }, {
    onStart: (control) => { requestStop = control.requestStop; },
    onProgress: (event) => {
        stopEvents.push(event);
        if (stopEvents.length === 8) requestStop();
    }
});
assert.equal(stopped.report.stopped, true);
assert.equal(stopped.report.converged, false);
assert.equal(stopped.report.terminationReason, 'stoppedByUser');
assert.ok(stopped.report.evaluations < 200, `A stop must end the search, not let it run on: ${stopped.report.evaluations} simulations.`);
assert.equal(stopped.report.evaluations, stopEvents.length, 'Every simulation that ran was reported.');
assert.equal(stopped.report.finalLoss, stopEvents.at(-1).bestLoss, 'The report is the best found before the stop.');
assert.deepEqual(stopped.report.finalParameters.map((entry) => entry.value), stopEvents.at(-1).bestParameterValues);
assert.equal(stopped.report.finalParameters.length, 1);

// ---- A time limit ends it the same way ------------------------------------------------------------------------------------
const limited = await fit({ backend: 'nlopt-isres', maxIterations: 100000, maxSeconds: 1 });
assert.equal(limited.report.stopped, true);
assert.equal(limited.report.terminationReason, 'maxTimeReached');
assert.ok(limited.report.elapsedSeconds >= 1 && limited.report.elapsedSeconds < 15, `Stopped after ${limited.report.elapsedSeconds} s.`);
assert.ok(limited.report.evaluations > 0 && Number.isFinite(limited.report.finalLoss));

console.log('A fit reports every simulation, stops on request keeping the best, and honours a time limit.');
