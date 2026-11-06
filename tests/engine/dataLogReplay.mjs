/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Replaying a data log through the real engine: the simulated rig (examples/dataSources/simulatedTankRig.py) writes six hours of a
// heated tank, and the rig's model (examples/dataSources/simulatedTankRig.kjt) is driven by the log's heater power and compared with
// its thermometer. With the rig's true values the model stays in step for the whole recording, missing by about the thermometer's
// noise; with the Tank Calibration example's wrong starting guesses it leaves the tolerance within the first hour. This is the
// test of docs/proposals/digitalTwinConnections.md step 1: a recording, a model, and whether they agree.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/dataLogReplay.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readDataLog } from '../../src/dataLog.mjs';
import { compareReplay, guessReplayMapping, replayPlan, replayTargets, suggestedReplayTimeStep } from '../../src/dataLogReplay.mjs';
import { runWithEngine } from '../../src/engineAdapter.mjs';
import { decodeProjectFile } from '../../src/projectFile.mjs';
import { resultSeriesForStateIds } from '../../src/renderer/resultPlot.mjs';
import { tankCalibration } from '../../scripts/generateTankCalibrationExample.mjs';
import { tankRigProject } from '../../scripts/generateTankRigModel.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

const python = (process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']).find((candidate) => spawnSync(candidate, ['--version']).status === 0);
if (!python) {
    console.log('Data log replay skipped: no Python on this computer to run the simulated rig.');
    process.exit(0);
}

// The shipped model file is what the generator writes.
const shipped = JSON.parse(await decodeProjectFile(await readFile(join(root, 'examples', 'dataSources', 'simulatedTankRig.kjt'))));
assert.deepEqual(shipped, tankRigProject(), 'examples/dataSources/simulatedTankRig.kjt is out of date: run node scripts/generateTankRigModel.mjs.');

const directory = await mkdtemp(join(tmpdir(), 'konjugateReplay-'));
try {
    const path = join(directory, 'tankRun.csv');
    const rig = spawnSync(python, [join(root, 'examples', 'dataSources', 'simulatedTankRig.py'), path, '--speed', '1e9', '--start', '2026-11-06T09:00:00Z'], { encoding: 'utf8' });
    assert.equal(rig.status, 0, rig.stderr);
    const log = readDataLog(await readFile(path, 'utf8'));

    const replay = async (document) => {
        const mapping = guessReplayMapping(log.header, replayTargets(document));
        const plan = replayPlan(document, log, mapping, { timeStep: suggestedReplayTimeStep(document, log.observations, mapping) });
        const run = await runWithEngine(JSON.stringify(plan.document), plan.configuration, engineOptions);
        assert.equal(run.available, true);
        const [output] = plan.outputs;
        return { mapping, plan, comparison: compareReplay(output.readings, resultSeriesForStateIds(run.result, [output.stateId]).get(output.stateId), { tolerance: 0.5 }) };
    };

    const truth = await replay(tankRigProject());
    assert.deepEqual(truth.mapping.map((entry) => [entry.signal, entry.parameterId ?? entry.stateId]), [['heaterPower', 40], ['tankTemperature', 2]], 'Both signals match by name.');
    assert.equal(truth.plan.configuration.globalTimeStep, 60);
    assert.equal(truth.plan.configuration.targetTime, 21600);
    assert.equal(truth.plan.outputs[0].leftOut, 1, 'The glitch the logger marked bad is left out.');
    assert.deepEqual(truth.comparison.stretches, [], 'With the true values the model stays in step for the whole recording.');
    assert.ok(truth.comparison.rms < 0.25, `With the true values the model misses by about the noise (0.15 K), not ${truth.comparison.rms.toFixed(3)} K.`);
    // The heater went off at two hours and back on at three: the model only follows that if the log's input drove it.
    const atThreeHours = truth.comparison.rows.find((row) => row.time === 10800);
    assert.ok(Math.abs(atThreeHours.error) < 0.5, 'The model cooled when the log says the heater was off.');

    const wrong = tankRigProject();
    wrong.sharedParameters.find((parameter) => parameter.id === 20).value = tankCalibration.start.capacitance;
    wrong.edges.find((edge) => edge.name === 'Ambient heat loss').parameters.find((parameter) => parameter.id === 10).value = tankCalibration.start.heatLoss;
    const guessed = await replay(wrong);
    assert.ok(guessed.comparison.inStepUntil !== null && guessed.comparison.inStepUntil < 3600, `With the wrong values the model leaves the tolerance within the hour, not at ${guessed.comparison.inStepUntil} s.`);
    assert.ok(guessed.comparison.rms > 5 * truth.comparison.rms);
    console.log(`Data log replay: the true model misses by ${truth.comparison.rms.toFixed(2)} K and stays in step; the starting guesses leave it after ${guessed.comparison.inStepUntil / 60} min and miss by ${guessed.comparison.rms.toFixed(2)} K.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
