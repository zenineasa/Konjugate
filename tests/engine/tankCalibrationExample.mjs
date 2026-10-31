/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Tank Calibration example does what its guide says: Parameter tuning, started from the saved model's wrong guesses and given the
// measurements the guide shows, finds the values the measurements were made with, within what the noise allows.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/tankCalibrationExample.mjs [path/to/konjugateEngine]

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

const events = [];
const { report } = await fitWithEngine(project, csv, { backend: 'nlopt-bobyqa', maxIterations: 300 }, { ...engineOptions, onProgress: (event) => events.push(event) });
const value = (parameterId) => report.finalParameters.find((entry) => entry.parameterId === parameterId).value;
const capacitance = value(20); // the shared parameter: one value for both relationships that use it
const heatLoss = value(10);
assert.equal(report.finalParameters.length, 2, 'Two unknowns: the shared capacitance and the heat loss coefficient.');
assert.ok(Math.abs(capacitance / tankCalibration.truth.capacitance - 1) < 0.02, `Capacitance ${capacitance}, truth ${tankCalibration.truth.capacitance}.`);
assert.ok(Math.abs(heatLoss / tankCalibration.truth.heatLoss - 1) < 0.02, `Heat loss ${heatLoss}, truth ${tankCalibration.truth.heatLoss}.`);
// What is left is the measurement noise: 49 readings of 0.15 K is a sum of squares near 1.1, and the starting guesses are far worse.
assert.ok(report.finalLoss < 2, `Final loss ${report.finalLoss}.`);
assert.ok(events[0].loss > 100 * report.finalLoss, `The starting guesses should be far from the data: ${events[0].loss} against ${report.finalLoss}.`);
assert.equal(report.failedTrials, 0);
console.log(`Tank Calibration recovers ${capacitance.toFixed(0)} J/K and ${heatLoss.toFixed(2)} W/K (truth ${tankCalibration.truth.capacitance} and ${tankCalibration.truth.heatLoss}) in ${report.evaluations} simulations.`);
