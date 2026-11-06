/* Copyright © 2026 Zenin Easa Panthakkalakath */

// An invented lab trial, worked through as a lab would (examples/dataSources/labVessel.py): a vessel whose logger is not Konjugate's
// writes its own CSV (semicolons, decimal commas, local time across the night the clocks go back, °C, the heater as a percentage,
// the valve as OPEN or CLOSED, ERR for a failed reading, a restart that repeats the header and leaves a gap), and the model of it
// (examples/dataSources/labVessel.kjt) starts from first guesses. Step by step:
//
//   1. Read the logger's file as it is, with settings a person fills in once: every row in, the repeated hour put in order, the
//      header the restart repeated skipped, the failed readings and the gap counted, and the result a valid data log.
//   2. Replay the first guesses: out of step within the first half hour.
//   3. Calibrate on a clean stretch (the first three and a half hours): the vessel's capacitance and heat loss found.
//   4. Validate on a stretch it was not calibrated on: in step.
//   5. Run it live while the logger writes, following the logger's own file: in step until the heater starts scaling up, and the
//      drift found after that, not before.
//   6. Try something in a sandbox: the heater off, and the vessel colder than the live forecast.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/labTrial.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readDataLog } from '../../src/dataLog.mjs';
import { fitPlanFromLog } from '../../src/dataLogFit.mjs';
import { followDataLog } from '../../src/dataLogFollower.mjs';
import { compareReplay, guessReplayMapping, replayPlan, replayTargets } from '../../src/dataLogReplay.mjs';
import { formatDataLog } from '../../src/dataLogWriter.mjs';
import { fitWithEngine, runWithEngine } from '../../src/engineAdapter.mjs';
import { describeLoggerCsv, LoggerCsvReader, readLoggerCsv } from '../../src/loggerCsv.mjs';
import { resultSeriesForStateIds } from '../../src/renderer/resultPlot.mjs';
import { WindowSession } from '../../src/windowSession.mjs';
import { labVessel, labVesselProject } from '../../scripts/generateLabVesselModel.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };
const python = (process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']).find((candidate) => spawnSync(candidate, ['--version']).status === 0);
if (!python) {
    console.log('The lab trial was skipped: no Python on this computer to run the invented lab.');
    process.exit(0);
}
const lab = join(root, 'examples', 'dataSources', 'labVessel.py');
const hour = 3600;
const water = labVessel.ids.water;

// What a person fills in once for this logger (the card's "Read another logger's file", saved with the project).
const settings = {
    delimiter: ';', decimal: ',', missing: ['ERR'],
    time: { columns: ['Datum', 'Uhrzeit'], format: 'DD.MM.YYYY HH:mm:ss', zone: 'Europe/Berlin' },
    signals: [
        { column: 'TC1 (°C)', name: 'waterTemperature', role: 'output', unit: 'K', offset: 273.15 },
        { column: 'TC2 (°C)', name: 'pocketTemperature', role: 'output', unit: 'K', offset: 273.15 },
        { column: 'Heizung (%)', name: 'heaterPower', role: 'input', unit: 'W', scale: 30 },
        { column: 'Ventil', name: 'inflowRate', role: 'input', unit: 'kg/s', values: { OPEN: 0.015, CLOSED: 0 } },
        { column: 'Raum (°C)', name: 'roomTemperature', role: 'input', unit: 'K', offset: 273.15 }
    ]
};

const directory = await mkdtemp(join(tmpdir(), 'konjugateLabTrial-'));
try {
    // 1. The logger's file, read as it is.
    const path = join(directory, 'vessel.csv');
    const made = spawnSync(python, [lab, path, '--speed', '1e9'], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const text = await readFile(path, 'utf8');
    const described = describeLoggerCsv(text);
    assert.equal(described.delimiter, ';', 'The separator is found.');
    assert.equal(described.decimal, ',', 'The decimal comma is found.');
    assert.deepEqual(described.columns.map((column) => column.name), ['Datum', 'Uhrzeit', 'TC1 (°C)', 'TC2 (°C)', 'Heizung (%)', 'Ventil', 'Raum (°C)']);
    assert.deepEqual(described.columns.find((column) => column.name === 'Ventil').texts, ['CLOSED', 'OPEN'], 'A column of words is offered as words to give values.');
    assert.equal(described.time.format, 'DD.MM.YYYY HH:mm:ss', 'The date and time format is guessed.');
    const log = readLoggerCsv(text, settings);
    assert.equal(log.header.epoch, Date.parse('2026-10-24T22:30:00Z'), 'Local Berlin time, then in summer time, is put on UTC.');
    const times = log.observations.filter((observation) => observation.signal === 'waterTemperature').map((observation) => observation.time);
    assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]), 'The hour the clocks went back is put in order, not folded on itself.');
    assert.equal(times.at(-1), 8 * hour, 'Eight hours, from first reading to last, across the change of clocks.');
    assert.equal(log.notes.repeatedHeaders, 1, 'The header the restart repeated is skipped and counted.');
    assert.equal(log.notes.missing, (text.match(/ERR/g) ?? []).length, 'Every failed reading is counted and left out.');
    assert.deepEqual(log.notes.gaps.map(({ from, to }) => [Math.round(from / 60), Math.round(to / 60)]), [[250, 257]], 'The restart\'s gap is found.');
    assert.equal(log.notes.clockChanges, 1, 'The change of clocks is noticed.');
    const asDataLog = readDataLog(formatDataLog(log));
    assert.deepEqual(asDataLog.header.signals, log.header.signals);
    assert.equal(asDataLog.observations.length, log.observations.length, 'Written as a Konjugate data log, it reads back whole.');

    // 2. The first guesses, replayed: out of step soon.
    const firstGuess = labVesselProject();
    const mapping = guessReplayMapping(log.header, replayTargets(firstGuess));
    assert.deepEqual(mapping.map((entry) => [entry.signal, entry.stateId ?? entry.parameterId ?? null]),
        [['waterTemperature', water], ['pocketTemperature', null], ['heaterPower', 40], ['inflowRate', 41], ['roomTemperature', 42]],
        'The signals named as the model names them are matched; the pocket the model does not have is left out.');
    const replayOver = async (document, from, to) => {
        const plan = replayPlan(document, log, mapping, { timeStep: 5, from, to });
        const run = await runWithEngine(JSON.stringify(plan.document), plan.configuration, engineOptions);
        const [output] = plan.outputs;
        return compareReplay(output.readings, resultSeriesForStateIds(run.result, [output.stateId]).get(output.stateId), { tolerance: 0.5 });
    };
    const guessed = await replayOver(firstGuess, 0, 3.5 * hour);
    assert.ok(guessed.inStepUntil !== null && guessed.inStepUntil < 0.5 * hour, `The first guesses leave the tolerance at ${guessed.inStepUntil} s.`);

    // 3. Calibrated on the first three and a half hours.
    const plan = fitPlanFromLog(firstGuess, log, mapping, { from: 0, to: 3.5 * hour, timeStep: 30 });
    const { report } = await fitWithEngine(plan.document, plan.csv, { backend: 'nlopt-bobyqa', maxIterations: 400 }, engineOptions);
    const fitted = (id) => report.finalParameters.find((entry) => entry.parameterId === id).value;
    const capacitance = fitted(labVessel.ids.capacitance);
    const heatLoss = fitted(labVessel.ids.heatLoss);
    assert.ok(Math.abs(capacitance / labVessel.truth.capacitance - 1) < 0.03, `Capacitance ${capacitance.toFixed(0)} J/K, truth ${labVessel.truth.capacitance}.`);
    assert.ok(Math.abs(heatLoss / labVessel.truth.heatLoss - 1) < 0.15, `Heat loss ${heatLoss.toFixed(2)} W/K, truth ${labVessel.truth.heatLoss}.`);
    const calibrated = labVesselProject({ capacitance, heatLoss });

    // 4. Validated on what it was not calibrated on: from three and a half hours to five, the restart's gap included.
    const validated = await replayOver(calibrated, 3.5 * hour, 5 * hour);
    assert.deepEqual(validated.stretches, [], `The calibrated model stays in step where it was not calibrated (typical miss ${validated.rms.toFixed(3)} K).`);

    // 5. Live, following the logger's own file while it writes eight hours in eight seconds.
    const livePath = join(directory, 'live.csv');
    const writer = spawn(python, [lab, livePath, '--speed', '3600'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let writerErrors = '';
    writer.stderr.on('data', (chunk) => { writerErrors += chunk; });
    const writerDone = new Promise((resolve) => writer.once('exit', resolve));
    let session = null;
    let sandbox = null;
    const follower = followDataLog(livePath, {
        reader: new LoggerCsvReader(settings),
        onHeader: (header) => {
            session = new WindowSession({
                document: calibrated, header, mapping: guessReplayMapping(header, replayTargets(calibrated)),
                window: hour, stride: 600, horizon: hour, timeStep: 5, tolerances: { waterTemperature: 0.5 }, engineOptions,
                onCycle: async (cycle) => {
                    // 6. At six and a half hours, the heater off for an hour, in a sandbox.
                    if (cycle.now === 6.5 * hour && !sandbox) {
                        const tried = await session.detach();
                        await tried.setInput('heaterPower', 0);
                        sandbox = { run: await tried.runFor(hour), live: cycle.forecast.waterTemperature };
                        await tried.close();
                    }
                }
            });
        },
        onObservations: (observations) => session.push(observations)
    });
    assert.equal(await writerDone, 0, writerErrors);
    await follower.stop();
    await session.end();
    const cycles = session.cycles;
    await session.close();
    assert.equal(cycles.length, Math.floor((8 * hour - hour) / 600) + 1, 'Every move was made from the logger\'s file as it grew.');
    // The heater loses a tenth of its heat an hour, and the thermostat hides much of that by keeping it on longer: a single ten-minute
    // jump goes up or down with how long the heater happened to be on in that stretch. Measured on this trial, the jumps rise clear of
    // that scatter around 6.5 h, when the heater has lost some fifteen per cent, whatever the trend is read over (6, 9 or 12 moves),
    // so the call is due within three hours of the scaling starting, never before it, and once made it is kept.
    const firstCalled = cycles.find((cycle) => cycle.trend.direction !== 'none');
    assert.ok(firstCalled, 'The heater scaling up is found.');
    assert.equal(firstCalled.trend.direction, 'above', 'The model runs warmer than the vessel, whose heater gives less than the model thinks.');
    assert.ok(firstCalled.now > labVessel.scalingStarts, `Nothing is called before the heater starts scaling: the first call is at ${firstCalled.now / hour} h.`);
    assert.ok(firstCalled.now <= labVessel.scalingStarts + 3 * hour, `It is called within three hours of starting: at ${firstCalled.now / hour} h.`);
    const afterCall = cycles.filter((cycle) => cycle.now >= firstCalled.now);
    assert.ok(afterCall.every((cycle) => cycle.trend.direction === 'above'), `Once called it is kept: ${afterCall.map((cycle) => cycle.trend.direction)}.`);
    const sandboxEnd = sandbox.run.waterTemperature.at(-1);
    const liveThen = sandbox.live.findLast((sample) => sample.time <= sandboxEnd.time);
    assert.ok(sandboxEnd.value < liveThen.value - 3, `With the heater off the water ends at ${sandboxEnd.value.toFixed(1)} K, against ${liveThen.value.toFixed(1)} K live.`);

    console.log(`Lab trial: ${log.observations.length} readings read from the logger's own file, through the change of clocks and a restart; `
        + `the first guesses out of step after ${(guessed.inStepUntil / 60).toFixed(0)} min; calibrated to ${capacitance.toFixed(0)} J/K and ${heatLoss.toFixed(2)} W/K `
        + `(truth ${labVessel.truth.capacitance} and ${labVessel.truth.heatLoss}); in step on the stretch it was not calibrated on; live, the heater's scaling `
        + `called at ${(firstCalled.now / hour).toFixed(2)} h, after it began at ${labVessel.scalingStarts / hour} h, never before, and kept.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
