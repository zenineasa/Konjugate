/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Parameter tuning with an objective written as an expression: what the engine does with `fit --objective-file`.
//   - the objective that spells out "squared error against measured data" finds what the CSV fit finds (the fitting preset is one);
//   - Maximise runs the search the other way and reports the value as written, rising;
//   - an objective that is not a number ends the fit before any simulation, with a sentence.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/objectiveFit.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fitWithEngine } from '../../src/engineAdapter.mjs';
import { decodeProjectFile } from '../../src/projectFile.mjs';
import { tankCalibration } from '../../scripts/generateTankCalibrationExample.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

const project = await decodeProjectFile(await readFile(join(root, 'examples', 'tankCalibration.kjt')));
const csv = await readFile(join(root, 'examples', 'tankCalibrationMeasured.csv'), 'utf8');
const tankStateId = 2;
const variables = [
    { name: 'tank', kind: 'state', id: tankStateId },
    { name: 'reading', kind: 'measured', column: 'tankTemperature' },
    { name: 'capacitance', kind: 'parameter', id: 20, value: 300000 }
];
const run = { targetTime: 48 * 600, timeStep: 600 };
const value = (report, parameterId) => report.finalParameters.find((entry) => entry.parameterId === parameterId).value;

// 1. The squared error written out, minimised.
{
    const objective = { expression: 'integral((tank - reading)^2)', direction: 'minimise', variables, ...run };
    const { report } = await fitWithEngine(project, csv, { backend: 'nlopt-bobyqa', maxIterations: 300, objective }, engineOptions);
    assert.ok(Math.abs(value(report, 20) / tankCalibration.truth.capacitance - 1) < 0.03, `Capacitance ${value(report, 20)}.`);
    assert.ok(Math.abs(value(report, 10) / tankCalibration.truth.heatLoss - 1) < 0.03, `Heat loss ${value(report, 10)}.`);
    assert.equal(report.failedTrials, 0);
    console.log(`Objective fit recovers ${value(report, 20).toFixed(0)} J/K and ${value(report, 10).toFixed(2)} W/K.`);
}

// 2. Maximise: the hottest the tank gets at the end is reached with the least thermal mass and the least heat loss, and it is reported as a
// temperature that rose from the start, not as a negative.
{
    const events = [];
    const objective = { expression: 'final(tank)', direction: 'maximise', variables, ...run };
    const { report } = await fitWithEngine(project, '', { backend: 'nlopt-bobyqa', maxIterations: 200, objective }, { ...engineOptions, onProgress: (event) => events.push(event) });
    assert.ok(report.finalLoss > events[0].loss, `Maximising should rise: started at ${events[0].loss}, ended at ${report.finalLoss}.`);
    assert.ok(report.finalLoss > 300, `A temperature in kelvin, not a negated one: ${report.finalLoss}.`);
    assert.ok(value(report, 20) < 110000, `Capacitance should go to its lower bound: ${value(report, 20)}.`);
    assert.ok(value(report, 10) < 2.5, `Heat loss should go to its lower bound: ${value(report, 10)}.`);
    console.log(`Maximise raises the final temperature from ${events[0].loss.toFixed(1)} K to ${report.finalLoss.toFixed(1)} K.`);
}

// 4. A constraint holds the search back: the same maximising, with the tank kept at or below 340 K, ends close to the limit and not far above it.
{
    const objective = { expression: 'final(tank)', direction: 'maximise', variables, ...run, constraints: [{ expression: 'max(tank)', relation: '<=', limit: 340 }] };
    const events = [];
    const { report } = await fitWithEngine(project, '', { backend: 'nlopt-cobyla', maxIterations: 300, objective }, { ...engineOptions, onProgress: (event) => events.push(event) });
    assert.ok(report.finalLoss > 330 && report.finalLoss < 340.5 * 1.0, `The constrained maximum should sit just under 340 K, not at the unconstrained 513 K: ${report.finalLoss}.`);
    assert.ok(report.finalViolation < 0.002, `The best values should keep to the limit: violation ${report.finalViolation}.`);
    assert.ok(events[0].violation > 0.04, `The starting values reach 355 K, 4.4% over the limit: ${events[0].violation}.`);
    console.log(`A 340 K limit holds the maximum to ${report.finalLoss.toFixed(1)} K (violation ${report.finalViolation.toExponential(1)}).`);
}

// 3. An objective that is not a number is refused up front, saying why.
{
    const objective = { expression: 'tank + capacitance', direction: 'minimise', variables, ...run };
    await assert.rejects(
        () => fitWithEngine(project, '', { objective }, engineOptions),
        (error) => /final\(tank\)|changes over the run/.test(error.message)
    );
    console.log('An objective with a bare state is refused with an explanation.');
}
