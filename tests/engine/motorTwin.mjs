/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The motor demonstration (scripts/generateMotorTwin.mjs): a twin of a DC motor run on three minutes of its recording, with the timing
// its project keeps (a five-second window moving every second), as the twin's window runs it. The engine's model is the generator's to
// the reading: in step while the bearing is as the model has it, then, as its friction grows from 90 s, the motor runs slower than the
// model says and the twin warns of the drift; and the current, which nothing measures, is followed among what the twin infers.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/motorTwin.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readDataLog } from '../../src/dataLog.mjs';
import { formatDataLog } from '../../src/dataLogFormat.mjs';
import { defaultTolerance } from '../../src/dataLogReplay.mjs';
import { LiveTwin } from '../../src/liveTwinHost.mjs';
import { readingNoise } from '../../src/stateEstimator.mjs';
import { normalizeTwinSetup } from '../../src/twinSetup.mjs';
import { motor, motorProject, motorRun } from '../../scripts/generateMotorTwin.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

// The example shipped is the one the generator writes, and its twin is set up with the project.
const content = await readFile(join(root, 'examples', 'dataSources', 'dcMotor.csv'), 'utf8');
assert.equal(content, formatDataLog(motorRun()), 'examples/dataSources/dcMotor.csv is as scripts/generateMotorTwin.mjs writes it.');
const document = motorProject();
const setup = normalizeTwinSetup(document.twin);
assert.deepEqual([setup.live.window, setup.live.stride, setup.live.horizon, setup.live.timeStep, setup.live.speed], [5, 1, 5, 0.001, '1']);
assert.deepEqual(setup.mapping.map((entry) => [entry.name, entry.role]), [['motorVoltage', 'input'], ['motorSpeed', 'output']]);

// The twin, as the window sets it up from the project's setup: a tolerance above the tachometer's noise, the warning at a quarter of it.
const log = readDataLog(content);
const mapping = [
    { signal: 'motorVoltage', role: 'input', unit: 'V', parameterId: setup.mapping[0].target.id },
    { signal: 'motorSpeed', role: 'output', unit: 'rad/s', stateId: setup.mapping[1].target.id }
];
const firstWindow = log.observations.filter((observation) => observation.signal === 'motorSpeed' && observation.time <= 5).map((observation) => ({ value: observation.value }));
const tolerance = Number(Math.max(defaultTolerance(firstWindow), 4 * readingNoise(firstWindow.map((reading) => reading.value))).toPrecision(2));
const events = [];
const twin = new LiveTwin({ document, mapping, window: 5, stride: 1, horizon: 5, timeStep: motor.timeStep, tolerances: { motorSpeed: tolerance }, alertAt: 0.25, keepUp: false },
    { kind: 'recording', content, speed: Infinity }, engineOptions, (event) => events.push(event));
for (let waited = 0; waited < 120000 && !events.some((event) => event.type === 'ended' || event.type === 'error'); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
await twin.stop();
assert.equal(events.find((event) => event.type === 'error'), undefined);
const cycles = events.filter((event) => event.type === 'cycle').map((event) => event.cycle);
assert.equal(cycles.length, 176, 'A move every second from the end of the first five seconds to the end of the three minutes.');

// In step before the bearing warms: each move's jump within the tachometer's noise, the model the generator's own.
// (The first move has none: nothing came before it to correct.)
const before = cycles.filter((cycle) => cycle.now < motor.warming.from && cycle.jumps.motorSpeed);
const worstJump = Math.max(...before.map((cycle) => Math.abs(cycle.jumps.motorSpeed.jump)));
assert.ok(worstJump < tolerance, `In step before the bearing warms: the largest jump ${worstJump.toFixed(3)} rad/s, the tolerance ${tolerance}.`);
assert.ok(before.every((cycle) => !cycle.trends.motorSpeed.alarm), 'No warning before the bearing warms.');

// The bearing warming: the motor slower than the model says, move after move, and the twin warns.
const alarmed = cycles.filter((cycle) => cycle.trends.motorSpeed.alarm).map((cycle) => cycle.now);
assert.ok(alarmed.length >= 5 && alarmed[0] > motor.warming.from, `The twin warns of the drift once the bearing warms: at ${alarmed.slice(0, 5).join(', ')} s.`);
const jumpsAfter = cycles.filter((cycle) => cycle.now > motor.warming.to && cycle.now < 150).map((cycle) => cycle.jumps.motorSpeed.jump);
// A jump is what the model said less what was measured: above the slower motor, move after move.
assert.ok(jumpsAfter.filter((jump) => jump > 0).length > jumpsAfter.length * 0.8, 'Each move puts the model down to the slower motor.');

// The current, which nothing measures, followed: near what the motor draws at 12 V once the speed has settled.
const currentId = document.nodes[0].states.find((state) => state.symbol === 'current').id;
const at = (time) => cycles.find((cycle) => Math.abs(cycle.now - time) < 1e-9);
const current = at(35).inferred[currentId].find((point) => Math.abs(point.time - 35) < 1e-9).value;
const settled = (12 * motor.friction) / (motor.torqueConstant ** 2 + motor.friction * motor.resistance);
assert.ok(Math.abs(current - settled) < 0.1, `The current at 35 s is what the motor draws at 12 V: ${current.toFixed(3)} A, about ${settled.toFixed(3)} A.`);

console.log(`Motor twin: ${cycles.length} moves; in step before the bearing warms (largest jump ${worstJump.toFixed(3)} rad/s); warned from ${alarmed[0]} s; the current followed (${current.toFixed(2)} A at 12 V).`);
