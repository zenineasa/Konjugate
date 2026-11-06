/* Copyright © 2026 Zenin Easa Panthakkalakath */

// An external data stream, end to end on the sending side: the simulated rig (examples/dataSources/simulatedTankRig.py) runs as its
// own process, sped up, and this test follows its log while it is still being written, the way Konjugate's file adapter will
// (docs/connectingADataSource.md). It checks that what was read while the file grew is exactly what the finished file holds, that
// the file really did grow over the run rather than appear at the end, that the operator's heater changes are where the rig's
// schedule puts them, and that the temperatures are the Tank Calibration example's true tank plus thermometer noise, so a model
// calibrated in that example can be compared against this rig.
//
// Nothing in Konjugate reads a live log yet. When it does, the receiving side joins this test: the same rig, followed by a session.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DataLogReader, readDataLog } from '../src/dataLog.mjs';
import { tankCalibration } from '../scripts/generateTankCalibrationExample.mjs';

const rigScript = join(import.meta.dirname, '..', 'examples', 'dataSources', 'simulatedTankRig.py');
const python = (process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'])
    .find((candidate) => spawnSync(candidate, ['--version']).status === 0);

const duration = 21600; // six hours of rig time
const speed = 15000; // in about a second and a half
const glitch = 5400;

// The tank the rig pretends to be: the exact answer of C dT/dt = P + h (T_room - T) with the heater held between changes.
function trueTemperatures(heaterChanges, times) {
    const { capacitance, heatLoss } = tankCalibration.truth;
    const { ambient } = tankCalibration;
    let temperature = ambient;
    let now = 0;
    let power = 0;
    const changes = [...heaterChanges];
    return times.map((time) => {
        while (changes.length && changes[0].time <= time) {
            const change = changes.shift();
            temperature = step(temperature, change.time - now, power);
            now = change.time;
            power = change.value;
        }
        temperature = step(temperature, time - now, power);
        now = time;
        return temperature;
    });
    function step(from, seconds, watts) {
        const settled = ambient + watts / heatLoss;
        return settled + (from - settled) * Math.exp(-heatLoss * seconds / capacitance);
    }
}

test('the simulated rig writes a data log that can be followed while it grows', { skip: !python && 'no Python on this computer' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateRig-'));
    const path = join(directory, 'tankRun.csv');
    try {
        const rig = spawn(python, [rigScript, path, '--duration', String(duration), '--speed', String(speed), '--start', '2026-11-06T09:00:00Z'], { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        rig.stderr.on('data', (chunk) => { diagnostics += chunk; });
        const finished = new Promise((resolve) => rig.once('exit', resolve));
        let running = true;
        finished.then(() => { running = false; });

        // Follow the file the way a reader of a live log must: open it once it exists, read only what is new since last time, hand
        // the bytes to the reader, and note when each observation was first seen.
        const reader = new DataLogReader();
        const followed = [];
        const arrivals = [];
        let handle = null;
        let offset = 0;
        const readNew = async () => {
            if (!handle) {
                try { handle = await open(path, 'r'); } catch { return; }
            }
            const { size } = await handle.stat();
            if (size <= offset) return;
            const buffer = Buffer.alloc(size - offset);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            offset += bytesRead;
            const fresh = reader.push(buffer.subarray(0, bytesRead));
            followed.push(...fresh);
            if (fresh.length) arrivals.push(performance.now());
        };
        while (running) {
            await readNew();
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(await finished, 0, diagnostics);
        await readNew();
        reader.end();
        await handle?.close();

        // What was followed is exactly what the finished file holds.
        const { header, observations } = readDataLog(await readFile(path));
        assert.deepEqual(followed, observations);
        assert.equal(header.epoch, Date.parse('2026-11-06T09:00:00Z'));
        assert.deepEqual(header.signals, [{ name: 'heaterPower', unit: 'W', role: 'input' }, { name: 'tankTemperature', unit: 'K', role: 'output' }]);

        // It arrived over the run, as a stream, not all at the end. The run lasts duration / speed seconds of wall time.
        assert.ok(arrivals.length > 20, `The log was seen growing ${arrivals.length} times.`);
        const spread = (arrivals.at(-1) - arrivals[0]) / 1000;
        assert.ok(spread > 0.5 * duration / speed, `Readings arrived over ${spread.toFixed(2)} s; the run should take ${(duration / speed).toFixed(2)} s.`);

        // The operator's actions are inputs, written when they change: on, off after two hours, on after three, off after five.
        const heater = observations.filter((observation) => observation.signal === 'heaterPower');
        assert.deepEqual(heater.map(({ time, value }) => [time, value]), [[0, 1000], [7200, 0], [10800, 1000], [18000, 0]]);

        // A thermometer reading every minute, the tank's true temperature plus noise, and the one glitch marked bad.
        const readings = observations.filter((observation) => observation.signal === 'tankTemperature');
        assert.equal(readings.length, duration / 60 + 1);
        const truth = trueTemperatures(heater, readings.map((reading) => reading.time));
        const errors = readings.map((reading, index) => reading.value - truth[index]);
        const bad = readings.filter((reading) => reading.quality === 'bad');
        assert.deepEqual(bad.map((reading) => reading.time), [glitch]);
        assert.ok(errors[readings.indexOf(bad[0])] > 20, 'The glitch is a reading far from the truth.');
        const good = errors.filter((_, index) => readings[index].quality === 'good');
        const rms = Math.sqrt(good.reduce((sum, error) => sum + error * error, 0) / good.length);
        assert.ok(rms > 0.1 && rms < 0.2, `The thermometer noise is ${rms.toFixed(3)} K; the rig's is 0.15 K.`);
        assert.ok(good.every((error) => Math.abs(error) < 0.8), 'Every good reading is within about five standard deviations of the truth.');
        assert.equal(readings.every((reading) => reading.revision === 0), true, 'The rig corrects nothing.');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('the rig, given the same seed and start, writes the same log', { skip: !python && 'no Python on this computer' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateRig-'));
    try {
        const run = async (name) => {
            const path = join(directory, name);
            const result = spawnSync(python, [rigScript, path, '--duration', '3600', '--speed', '1e9', '--start', '2026-11-06T09:00:00Z', '--seed', '7'], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            return readFile(path, 'utf8');
        };
        assert.equal(await run('first.csv'), await run('second.csv'));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
