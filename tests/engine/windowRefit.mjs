/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Refitting the model over the comparison window (docs/proposals/predictionActualWindow.md, step 5), through the real engine:
//
//   - A state's initial value can be a fitting target: the room's temperature, which no reading reaches, is fitted with the
//     parameters, as its value at the window's anchor.
//   - The twin is run with the wrong parameters and the wrong room for three hours, its latest window is refitted, and what the fit
//     found is applied to the running twin: the parameters, and the room at the anchor. The next move is made with them, says so,
//     and from then on the model follows the rig over each window, on the inputs really applied, to within the rig's noise, where
//     the same twin left alone is off by several times that. (The jumps alone do not show it: a reset every ten minutes keeps even
//     a wrong model's jumps small, which is why they are watched for a trend rather than a size.)
//   - A refit for a move the twin never made is refused, and the twin carries on unharmed; one for an earlier move than the latest
//     is taken from that move (the app's fit takes seconds, and a twin played back fast moves on meanwhile).
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/windowRefit.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readDataLog } from '../../src/dataLog.mjs';
import { guessReplayMapping, replayTargets } from '../../src/dataLogReplay.mjs';
import { fitWithEngine } from '../../src/engineAdapter.mjs';
import { WindowSession } from '../../src/windowSession.mjs';
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
    console.log('Window refit skipped: no Python on this computer to run the simulated rig.');
    process.exit(0);
}
const truth = { capacitance: 209000, heatLoss: 20, room: 293.15 };

// The rig's model with the first guesses, the room 10 K off, and the three marked as fitting targets.
function wrongModel() {
    const document = tankRigProject();
    const capacitance = document.sharedParameters.find((parameter) => parameter.id === 20);
    capacitance.value = tankCalibration.start.capacitance;
    capacitance.tuning = { minimum: 50000, maximum: 1000000 };
    const heatLoss = document.edges.find((edge) => edge.name === 'Ambient heat loss').parameters.find((parameter) => parameter.id === 10);
    heatLoss.value = tankCalibration.start.heatLoss;
    heatLoss.tuning = { minimum: 1, maximum: 100 };
    const room = document.nodes.find((node) => node.name === 'Ambient air').states[0];
    room.initialValue = 283.15;
    room.tuning = { minimum: 270, maximum: 310 };
    return document;
}

const directory = await mkdtemp(join(tmpdir(), 'konjugateRefit-'));
try {
    const path = join(directory, 'rig.csv');
    const rig = spawnSync(python, [join(root, 'examples', 'dataSources', 'simulatedTankRig.py'), path, '--speed', '1e9', '--start', '2026-11-06T09:00:00Z'], { encoding: 'utf8' });
    assert.equal(rig.status, 0, rig.stderr);
    const log = readDataLog(await readFile(path, 'utf8'));
    const origin = Math.min(...log.observations.map((observation) => observation.time));
    const between = (from, to) => log.observations.filter((observation) => observation.time - origin > from && observation.time - origin <= to);
    const [firstHours, whileFitting, rest] = [between(-1, 3 * 3600), between(3 * 3600, 3.5 * 3600), between(3.5 * 3600, Infinity)];
    const open = (document) => new WindowSession({ document, header: log.header, mapping: guessReplayMapping(log.header, replayTargets(document)), window: 7200, stride: 600, horizon: 3600, timeStep: 60, tolerances: { tankTemperature: 0.5 }, engineOptions });
    // How far the model is from the readings over the last ten windows, each run from its anchor on the inputs really applied.
    const windowError = (cycles) => {
        const rows = cycles.slice(-10).flatMap((cycle) => cycle.window.tankTemperature);
        return Math.sqrt(rows.reduce((sum, row) => sum + row.error ** 2, 0) / rows.length);
    };

    // Left alone: the wrong model, reset at every move, over the whole log.
    const alone = open(wrongModel());
    alone.push(log.observations);
    await alone.end();
    const aloneError = windowError(alone.cycles);
    await alone.close();

    // Refitted after three hours.
    const session = open(wrongModel());
    session.push(firstHours);
    await session.idle();
    const plan = session.refitPlan();
    assert.deepEqual(plan.tunable.map(({ kind, id }) => `${kind} ${id}`).sort(), ['parameter 10', 'parameter 20', 'state 6']);
    assert.equal(plan.document.nodes.find((node) => node.name === 'Ambient air').states[0].initialValue, 283.15, 'The room starts where the last move left it.');
    assert.equal(plan.document.nodes.find((node) => node.name === 'Water tank').states[0].tuning, undefined, 'A measured state starts at its reading and is not fitted.');
    const { report } = await fitWithEngine(plan.document, plan.csv, { backend: 'nlopt-bobyqa', maxIterations: 600 }, engineOptions);
    const fitted = Object.fromEntries(report.finalParameters.map((entry) => [entry.parameterId, entry.value]));
    const relative = (value, expected) => Math.abs(value - expected) / expected;
    assert.ok(relative(fitted[20], truth.capacitance) < 0.05, `The capacitance is found from the window: ${fitted[20]}.`);
    assert.ok(relative(fitted[10], truth.heatLoss) < 0.05, `The heat loss is found from the window: ${fitted[10]}.`);
    assert.ok(Math.abs(fitted[6] - truth.room) < 0.5, `The room, which no reading reaches, is found from the window: ${fitted[6]} K.`);

    // A refit for a window the twin has moved on from is refused, and the twin goes on as it was.
    await assert.rejects(session.applyRefit({ values: report.finalParameters, cycle: 999 }), /not one this twin made/);

    // The twin moves on while the fit runs: the refit is taken from the move it was planned on.
    session.push(whileFitting);
    await session.idle();
    assert.equal(session.cycles.at(-1).index, plan.cycle + 3);
    const before = session.cycles.length;
    await session.applyRefit({ values: report.finalParameters, cycle: plan.cycle });
    assert.equal(session.document.sharedParameters.find((parameter) => parameter.id === 20).value, fitted[20], 'The twin runs on the fitted parameters.');
    session.push(rest);
    await session.end();
    const next = session.cycles[before];
    assert.deepEqual(next.refit, { fromCycle: plan.cycle, anchor: plan.anchor, states: { 6: fitted[6] } }, 'The next move says a refit was applied.');
    assert.equal(next.restored.values[session.engine.stateIds.indexOf(6)], fitted[6], 'The room carries the fitted value on.');
    assert.equal(session.cycles.filter((cycle) => cycle.refit).length, 1);
    const refitError = windowError(session.cycles);
    await session.close();
    assert.ok(refitError < aloneError / 3, `After the refit the model follows each window to ${refitError.toFixed(3)} K, against ${aloneError.toFixed(3)} K left alone.`);
    console.log(`Window refit: from one two-hour window, capacitance ${fitted[20].toFixed(0)} J/K, heat loss ${fitted[10].toFixed(2)} W/K and the unmeasured room ${fitted[6].toFixed(2)} K (truth ${truth.capacitance}, ${truth.heatLoss}, ${truth.room}); after it each window followed to ${refitError.toFixed(2)} K RMS, against ${aloneError.toFixed(2)} K left alone.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
