/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The live digital twin, end to end (docs/proposals/digitalTwinConnections.md, docs/proposals/liveEngineSession.md and
// docs/proposals/predictionActualWindow.md): the simulated rig (examples/dataSources/simulatedTankRig.py) writes its data log as
// it runs, sped up; a follower reads the log while it grows; a window session keeps one long-lived engine in step with it, and
// every stride goes back to the anchor, sets the measured temperature to its reading, runs the window on what the operator really
// did, and runs on for the forecast. Checked here:
//
//   - The twin keeps up: every anchor gets its cycle, and the model runs far faster than the data arrives.
//   - With the rig's true, constant tank, the jumps (the model's prediction against the reading it is replaced by) stay at the
//     thermometer's noise with no trend, and the forecast an hour ahead agrees with what the log then says.
//   - With the tank drifting (its heat loss growing, as wet insulation would), the jumps grow in one direction and the session's
//     trend of them says so.
//   - Every cycle can be checked on its own: a fresh run from the state the session logged gives the same numbers, to the bit.
//   - Killing the engine mid-session is recovered from, and the cycles after it are the same as if it had never happened.
//   - Detaching into a sandbox, switching the heater off and running ahead, shows a colder future, and leaves the live twin's
//     cycles exactly as they would have been.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/liveTwin.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { followDataLog } from '../../src/dataLogFollower.mjs';
import { guessReplayMapping, replayTargets } from '../../src/dataLogReplay.mjs';
import { runWithEngine } from '../../src/engineAdapter.mjs';
import { resultSeriesForStateIds } from '../../src/renderer/resultPlot.mjs';
import { WindowSession } from '../../src/windowSession.mjs';
import { heaterPowerParameterId, tankRigProject } from '../../scripts/generateTankRigModel.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

const python = (process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']).find((candidate) => spawnSync(candidate, ['--version']).status === 0);
if (!python) {
    console.log('Live twin skipped: no Python on this computer to run the simulated rig.');
    process.exit(0);
}

const duration = 21600; // six hours of the rig
const speed = 3600; // an hour a second, so six seconds of wall time
const window = 3600;
const stride = 600;
const horizon = 3600;
const timeStep = 60;
const temperatureStateId = 2;

const directory = await mkdtemp(join(tmpdir(), 'konjugateLiveTwin-'));

// Runs the rig, follows its log into a window session, and does whatever the test asks at a given cycle. Resolves to the session's
// cycles and anything the test collected on the way.
async function liveTwin({ name, drift = 0, atCycle = {} }) {
    const path = join(directory, `${name}.csv`);
    const rig = spawn(python, [join(root, 'examples', 'dataSources', 'simulatedTankRig.py'), path,
        '--duration', String(duration), '--speed', String(speed), '--start', '2026-11-06T09:00:00Z', '--drift', String(drift)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let rigErrors = '';
    rig.stderr.on('data', (chunk) => { rigErrors += chunk; });
    const rigDone = new Promise((resolve) => rig.once('exit', resolve));

    const document = tankRigProject();
    let session = null;
    const collected = {};
    const follower = followDataLog(path, {
        onHeader: (header) => {
            session = new WindowSession({
                document, header, mapping: guessReplayMapping(header, replayTargets(document)),
                window, stride, horizon, timeStep, tolerances: { tankTemperature: 0.5 }, engineOptions,
                onCycle: async (cycle, index) => { if (atCycle[index]) await atCycle[index](session, cycle, collected); }
            });
        },
        onObservations: (observations) => session.push(observations)
    });
    assert.equal(await rigDone, 0, rigErrors);
    await follower.stop();
    await session.end();
    const cycles = session.cycles;
    const stats = session.stats();
    await session.close();
    return { cycles, stats, collected };
}

const slope = (points) => {
    const n = points.length;
    const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
    const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
    const numerator = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
    const denominator = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
    return numerator / denominator;
};
const jumpsOf = (cycles) => cycles.slice(1).map((cycle) => [cycle.anchor, cycle.jumps.tankTemperature.jump]);
const sameNumbers = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// What a cycle computed, without its timings, to compare one session with another.
const outcome = (cycles) => cycles.map(({ anchor, now, jumps, window: compared, forecast, restored }) => ({ anchor, now, jumps, compared, forecast, restored }));

try {
    // The true, constant tank.
    const steady = await liveTwin({
        name: 'steady',
        atCycle: {
            // Check one cycle on its own: a fresh run from the state the session logged, on the same inputs, gives the same numbers.
            8: async (session, cycle, collected) => {
                const plan = session.freshRunFor(cycle);
                const run = await runWithEngine(JSON.stringify(plan.document), plan.configuration, engineOptions);
                collected.fresh = { cycle, samples: resultSeriesForStateIds(run.result, [temperatureStateId]).get(temperatureStateId) };
            }
        }
    });
    const expectedCycles = Math.floor((duration - window) / stride) + 1;
    assert.equal(steady.cycles.length, expectedCycles, `Every anchor gets its cycle: ${steady.cycles.length} of ${expectedCycles}.`);
    assert.ok(steady.stats.realTimeFactor > 10 * speed, `The twin runs far faster than the data arrives: ${steady.stats.realTimeFactor} model seconds a wall second.`);
    assert.ok(steady.stats.cycleSeconds.median < 0.05, `A cycle takes ${steady.stats.cycleSeconds.median} s.`);
    assert.ok(steady.cycles.every((cycle) => cycle.checkpointsTaken === 1), 'Each cycle keeps one checkpoint, the next anchor\'s, and asks the providers for nothing more.');
    const steadyJumps = jumpsOf(steady.cycles);
    const largest = Math.max(...steadyJumps.map(([, jump]) => Math.abs(jump)));
    assert.ok(largest < 1, `With the true tank every jump is within the noise: the largest is ${largest.toFixed(3)} K.`);
    assert.ok(Math.abs(slope(steadyJumps)) * 3600 < 0.1, `With the true tank the jumps have no trend: ${(slope(steadyJumps) * 3600).toFixed(3)} K an hour.`);
    assert.equal(steady.cycles.at(-1).trend.alarm, false);
    // The forecast an hour ahead, made at one cycle, against what the log says an hour later.
    const early = steady.cycles[6];
    const later = steady.cycles.find((cycle) => cycle.now >= early.now + horizon);
    const predicted = early.forecast.tankTemperature.find((sample) => sample.time === early.now + horizon).value;
    const measured = later.window.tankTemperature.find((row) => row.time === early.now + horizon).measured;
    assert.ok(Math.abs(predicted - measured) < 0.6, `The forecast an hour ahead was ${predicted.toFixed(2)} K; the log then said ${measured.toFixed(2)} K.`);
    // The fresh run reproduces the session's cycle exactly.
    const { cycle: checked, samples: fresh } = steady.collected.fresh;
    const sessionSamples = [...checked.window.tankTemperature.map((row) => ({ time: row.time, value: row.simulated })), ...checked.forecast.tankTemperature];
    for (const sample of sessionSamples) {
        const match = fresh.find((candidate) => Math.abs(candidate.time - sample.time) < 1e-9);
        assert.ok(match && match.value === sample.value, `A fresh run from the logged state gives ${match?.value} at ${sample.time} s; the session gave ${sample.value}.`);
    }

    // The tank drifting: its heat loss grows by a tenth an hour.
    const drifting = await liveTwin({ name: 'drifting', drift: 0.1 });
    const driftingJumps = jumpsOf(drifting.cycles);
    assert.ok(slope(driftingJumps) * 3600 > 0.1, `With the tank drifting the jumps grow: ${(slope(driftingJumps) * 3600).toFixed(3)} K an hour.`);
    assert.equal(drifting.cycles.at(-1).trend.direction, 'above', 'The model predicts warmer than the drifting tank turns out.');

    // The engine killed mid-session: recovered, and the cycles are the same as without it.
    const crashed = await liveTwin({
        name: 'crashed',
        atCycle: { 10: async (session) => session.engine.kill() }
    });
    assert.ok(crashed.stats.recoveries === 1, 'The session recovered from the engine dying once.');
    assert.ok(sameNumbers(outcome(crashed.cycles), outcome(steady.cycles)), 'After recovering, every cycle is what it would have been.');

    // Detaching at a cycle: switch the heater off in a sandbox and run two hours ahead, while the live twin carries on.
    const detached = await liveTwin({
        name: 'detached',
        atCycle: {
            12: async (session, cycle, collected) => {
                const sandbox = await session.detach();
                assert.equal(sandbox.time, cycle.now, 'The sandbox starts from the live twin at now.');
                await sandbox.setInput('heaterPower', 0);
                collected.sandbox = await sandbox.runFor(7200);
                collected.live = cycle.forecast.tankTemperature;
                await sandbox.close();
            }
        }
    });
    const sandboxEnd = detached.collected.sandbox.tankTemperature.at(-1);
    const liveAtSameTime = detached.collected.live.findLast((sample) => sample.time <= sandboxEnd.time);
    assert.ok(sandboxEnd.value < liveAtSameTime.value - 5, `With the heater off the tank ends at ${sandboxEnd.value.toFixed(1)} K, against ${liveAtSameTime.value.toFixed(1)} K live.`);
    assert.ok(sameNumbers(outcome(detached.cycles), outcome(steady.cycles)), 'Nothing done in the sandbox reached the live twin.');
    assert.equal(heaterPowerParameterId, 40);

    // Falling behind: the whole log at once, to a twin that keeps up with live data, skips to the newest anchor, rebuilding the
    // checkpoint there from the start, and says how many moves it skipped.
    {
        const { readDataLog } = await import('../../src/dataLog.mjs');
        const { readFile } = await import('node:fs/promises');
        const path = join(directory, 'behind.csv');
        const made = spawnSync(python, [join(root, 'examples', 'dataSources', 'simulatedTankRig.py'), path, '--speed', '1e9', '--start', '2026-11-06T09:00:00Z'], { encoding: 'utf8' });
        assert.equal(made.status, 0, made.stderr);
        const log = readDataLog(await readFile(path, 'utf8'));
        const document = tankRigProject();
        const behind = new WindowSession({ document, header: log.header, mapping: guessReplayMapping(log.header, replayTargets(document)), window, stride, horizon, timeStep, tolerances: { tankTemperature: 0.5 }, engineOptions, keepUp: true });
        behind.push(log.observations);
        await behind.end();
        const stats = behind.stats();
        assert.equal(stats.skipped, expectedCycles - 1, `It skipped to the newest anchor: ${stats.skipped} moves skipped.`);
        assert.equal(behind.cycles.length, 1);
        assert.equal(behind.cycles[0].now, duration);
        const last = steady.cycles.at(-1);
        const error = Math.abs(behind.cycles[0].forecast.tankTemperature.at(-1).value - last.forecast.tankTemperature.at(-1).value);
        assert.ok(error < 0.5, `After skipping, its forecast is within ${error.toFixed(3)} K of the twin that made every move.`);
        await behind.close();
    }

    console.log(`Live twin: ${steady.cycles.length} cycles in step, the largest jump ${largest.toFixed(2)} K with the true tank; `
        + `drift found at ${(slope(driftingJumps) * 3600).toFixed(2)} K an hour; a cycle takes ${(steady.stats.cycleSeconds.median * 1000).toFixed(1)} ms; `
        + 'a crash recovered and a sandbox kept apart, with the live cycles unchanged.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
