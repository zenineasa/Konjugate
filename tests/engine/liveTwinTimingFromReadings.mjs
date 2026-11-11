/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A live twin whose source says nothing of how often its readings come (a broker, an OPC UA server, the push service), with no timing
// kept: it waits for its first few readings and chooses its timing from their spacing, as it does from a log's (src/liveTwinHost.mjs,
// src/twinSetup.mjs timingFromReadings). The motor's readings, pushed at 20 a second as its controller would, give a six-second window
// moving every second on the model's millisecond step, not an hour's window that would leave the room waiting an hour for its first
// move. And the same motor stepped every 50 ms runs away, which the move says (`runaway`), where a millisecond step does not.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/liveTwinTimingFromReadings.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { LiveTwin } from '../../src/liveTwinHost.mjs';
import { PushHub } from '../../src/pushSource.mjs';
import { normalizeTwinSetup } from '../../src/twinSetup.mjs';
import { WindowSession } from '../../src/windowSession.mjs';
import { motor, motorProject, motorRun } from '../../scripts/generateMotorTwin.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

const document = motorProject();
delete document.twin; // a model brought without the demonstration's timing
const setup = normalizeTwinSetup(motorProject().twin);
const mapping = [
    { signal: 'motorVoltage', role: 'input', unit: 'V', parameterId: setup.mapping[0].target.id },
    { signal: 'motorSpeed', role: 'output', unit: 'rad/s', stateId: setup.mapping[1].target.id }
];
const run = motorRun();
const first = (seconds) => run.observations.filter((observation) => observation.time <= seconds + 1e-9);

// Pushed: the hour placeholder given, to be replaced by what the readings say.
const hub = new PushHub();
const events = [];
const twin = new LiveTwin({ document, mapping, window: 3600, stride: 600, horizon: 3600, timeStep: motor.timeStep, tolerances: { motorSpeed: 0.5 }, keepUp: false, timingFromReadings: { step: true } },
    { kind: 'push', hub, signals: mapping.map((entry) => ({ signal: entry.signal, name: entry.signal, role: entry.role, unit: entry.unit })) }, engineOptions, (event) => events.push(event));
const base = Math.floor(Date.now() / 1000) + 1;
const readings = first(12).map((observation) => ({ signal: observation.signal, value: observation.value, time: base + observation.time, quality: observation.quality ?? 'good' }));
for (let start = 0; start < readings.length; start += 10) hub.publish(readings.slice(start, start + 10));
for (let waited = 0; waited < 60000 && events.filter((event) => event.type === 'cycle').length < 5 && !events.some((event) => event.type === 'error'); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
await twin.stop();
assert.equal(events.find((event) => event.type === 'error'), undefined);
const timing = events.find((event) => event.type === 'timing');
assert.ok(timing, 'The twin said the timing it chose.');
assert.deepEqual([timing.window, timing.stride, timing.horizon, timing.timeStep], [6, 1, 6, motor.timeStep], `Chosen from readings every ${timing.spacing} s.`);
assert.equal(timing.spacing, 0.05);
assert.ok(events.indexOf(timing) < events.findIndex((event) => event.type === 'cycle'), 'The timing is said before the first move.');
const cycles = events.filter((event) => event.type === 'cycle').map((event) => event.cycle);
assert.equal(cycles[0].now, 6, 'The first move once six seconds of readings are in, not an hour.');
assert.ok(cycles.every((cycle) => cycle.now - cycle.anchor === 6 && cycle.runaway.length === 0));

// Stepped every 50 ms, the motor's current, which settles in milliseconds, grows without end: the move says so.
const coarse = new WindowSession({ document, mapping, window: 6, stride: 1, horizon: 6, timeStep: 0.05, tolerances: { motorSpeed: 0.5 }, header: run.header, engineOptions });
let ranAway = null;
try {
    coarse.push(first(10));
    await coarse.end();
    ranAway = coarse.cycles.find((cycle) => cycle.runaway.length)?.runaway[0] ?? null;
} catch (error) {
    ranAway = { error: error.message };
} finally {
    await coarse.close();
}
assert.ok(ranAway && ranAway.signal === 'motorSpeed', `A 50 ms step ran the motor away, and the move said so: ${JSON.stringify(ranAway)}.`);

console.log(`Timing from readings: ${timing.spacing} s between readings gave a ${timing.window} s window moving every ${timing.stride} s, first move at ${cycles[0].now} s; a 50 ms step ran away (${ranAway.value} rad/s against ${ranAway.reading}).`);
