/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The live twin's estimator (docs/proposals/stateEstimator.md, src/stateEstimator.mjs through src/windowSession.mjs) with the real
// engine. A tank's level is read; its inflow, which nobody measures, is wrong in the model (1.0 against a true 1.25). Checked:
//
//   - Reset leaves the inflow where it was, so the jumps lean to one side for good.
//   - Estimated, the level's readings reach the inflow: it is found, within its spread, and the jumps shrink.
//   - The same readings and seed give the same estimates to the bit.
//   - The forecast carries a band, and about one reading in five falls outside its 10th to 90th percentile.
//   - A parameter estimated with the states: the simulated rig's heat loss, growing 10% an hour in the drifting recording shipped
//     with the app, is followed up as it grows, from the tank's temperature alone, where reset leaves the jumps leaning.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/windowEstimator.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readDataLog } from '../../src/dataLog.mjs';
import { guessReplayMapping, replayTargets } from '../../src/dataLogReplay.mjs';
import { seededNormal } from '../../src/stateEstimator.mjs';
import { heatLossParameterId, tankRigProject } from '../../scripts/generateTankRigModel.mjs';
import { WindowSession } from '../../src/windowSession.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

// level' = inflow - k level, inflow' = 0, with a time constant of nearly three hours: the model believes the inflow is 1.0.
const k = 1e-4;
const tank = {
    format: 'konjugate', version: 1,
    runConfigurations: [{ id: 30, name: 'Run', globalTimeStep: 60, outputInterval: 60 }], activeRunConfigurationId: 30,
    nodes: [{
        id: 1, name: 'Tank', position: [0, 0, 0], appearance: { type: 'primitive', shape: 'cylinder', color: '#34727a' },
        states: [{ id: 2, name: 'Level', symbol: 'level', initialValue: 10000, unit: 'cm' }, { id: 3, name: 'Inflow', symbol: 'inflow', initialValue: 1, unit: 'cm/s' }],
        sourceTerms: [
            { id: 4, state: 'level', expression: 'inflow - 0.0001 level', parameters: [], expressionModel: {
                latex: 'inflow-0.0001\\,level', output: { stateId: 2 }, mathJson: ['Add', 'inflow', ['Multiply', -k, 'level']],
                bindings: [{ kind: 'state', nodeId: 1, stateId: 3, symbol: 'inflow' }, { kind: 'state', nodeId: 1, stateId: 2, symbol: 'level' }]
            } },
            { id: 5, state: 'inflow', expression: '0', parameters: [], expressionModel: { latex: '0', output: { stateId: 3 }, mathJson: 0, bindings: [] } }
        ]
    }],
    edges: []
};

// The real tank, whose inflow is 1.25, read every minute for six hours with a noise of 0.2 cm.
const trueInflow = 1.25;
const noise = 0.2;
const normal = seededNormal(2026);
const observations = Array.from({ length: 361 }, (_, minute) => {
    const time = minute * 60;
    const level = trueInflow / k + (10000 - trueInflow / k) * Math.exp(-k * time);
    return { time, signal: 'level', value: level + noise * normal(), quality: 'good', revision: 0 };
});
const header = { version: 1, source: 'invented tank', epoch: Date.parse('2026-11-07T09:00:00Z'), signals: [{ name: 'level', unit: 'cm', role: 'output' }] };
const mapping = [{ signal: 'level', role: 'output', stateId: 2, parameterId: null }];

// The real tank's level and inflow follow the model's equation exactly, with nothing wandering of its own, so both are said to drift
// little (the defaults are cautious, and the share of readings outside the band says so).
const run = async (corrections, estimator = { drift: { 2: 0.02, 3: 0.0002 } }) => {
    const session = new WindowSession({ document: tank, header, mapping, window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances: { level: 0.5 }, engineOptions, corrections, estimator });
    session.push(observations);
    await session.end();
    await session.close();
    return session.cycles;
};
const meanJump = (cycles) => cycles.slice(-10).reduce((sum, cycle) => sum + cycle.jumps.level.jump, 0) / 10;

const reset = await run({});
const estimated = await run({ level: { estimate: true } });
assert.equal(estimated.length, 31, 'Every move is made with the estimator.');
const last = estimated.at(-1).estimate;
const inflow = last.states.find((state) => state.stateId === 3);
assert.ok(Math.abs(inflow.mean - trueInflow) < Math.max(3 * inflow.spread, 0.03), `The unmeasured inflow is found: ${inflow.mean.toFixed(3)} ± ${inflow.spread.toFixed(3)} against ${trueInflow}.`);
assert.ok(Math.abs(inflow.mean - trueInflow) < 0.25 / 4, 'It has come most of the way from the model\'s 1.0.');
// While the inflow is being found, the level's readings reach it; once it is known they hardly change it, and only the level is said to
// be reached.
assert.ok(estimated.slice(1, 4).every((cycle) => cycle.estimate.through[3]?.includes('level')), 'The readings reached the inflow through the level while it was found.');
assert.deepEqual(estimated.at(-1).estimate.through[2], ['level']);
assert.ok(Math.abs(meanJump(estimated)) < Math.abs(meanJump(reset)) / 3, `Estimated, the jumps shrink (mean ${meanJump(estimated).toFixed(3)} cm) where reset keeps leaning (${meanJump(reset).toFixed(3)} cm).`);
assert.ok(Math.abs(last.noise.level / noise - 1) < 0.2, `The level's noise was read from its readings: ${last.noise.level.toFixed(3)} cm.`);
assert.equal(estimated.at(-1).corrections.level.estimate, true);

// The band: as many points as the forecast's samples over the window and the horizon, the low under the high.
const band = last.band.level;
assert.equal(band.length, (3600 + 3600) / 60);
assert.ok(band.every((point) => point.low <= point.high));
const outside = estimated.slice(10).reduce((sum, cycle) => sum + cycle.estimate.outside.level.outside, 0);
const total = estimated.slice(10).reduce((sum, cycle) => sum + cycle.estimate.outside.level.total, 0);
assert.ok(outside / total > 0.05 && outside / total < 0.45, `About one reading in five falls outside the band: ${outside} of ${total}.`);

// With the cautious default, the band is wider than the truth needs, and far fewer readings fall outside it.
const cautious = await run({ level: { estimate: true } }, {});
const cautiousOutside = cautious.slice(10).reduce((sum, cycle) => sum + cycle.estimate.outside.level.outside, 0);
assert.ok(cautiousOutside < outside, `The cautious default leaves fewer readings outside: ${cautiousOutside} against ${outside}.`);

const again = await run({ level: { estimate: true } });
assert.deepEqual(again.map((cycle) => cycle.estimate.states), estimated.map((cycle) => cycle.estimate.states), 'The same readings and seed give the same estimates.');
console.log(`Window estimator: the unmeasured inflow found (${inflow.mean.toFixed(3)} ± ${inflow.spread.toFixed(3)} against ${trueInflow}), the jumps ${meanJump(estimated).toFixed(3)} cm against ${meanJump(reset).toFixed(3)} reset, ${outside} of ${total} readings outside the band, repeatable.`);

// The drifting rig: its heat loss grows from 20 W/K by 10% an hour; the model believes it stays at 20.
const drifting = readDataLog(await readFile(join(root, 'examples', 'dataSources', 'simulatedTankRigDrifting.csv'), 'utf8'));
const rig = tankRigProject();
const rigMapping = guessReplayMapping(drifting.header, replayTargets(rig));
const runRig = async (corrections, estimator = {}) => {
    const session = new WindowSession({ document: rig, header: drifting.header, mapping: rigMapping, window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances: { tankTemperature: 0.5 }, engineOptions, corrections, estimator });
    session.push(drifting.observations);
    await session.end();
    await session.close();
    return session.cycles;
};
const rigReset = await runRig({});
const trueLoss = (anchor) => 20 * (1 + 0.1 * anchor / 3600);
const lossAt = (cycle) => cycle.estimate.parameters.find((parameter) => parameter.parameterId === heatLossParameterId);
// A filter follows a drifting quantity with a lag set by how far it may wander (20% an hour by default), and with 32 members its
// estimate of one parameter differs noticeably from one seed to another (by five hours, anywhere from 24 to 30 W/K against a true 30
// on this recording). So it is judged over several seeds: every one follows the heat loss up from the model's 20, and on average by
// more than 4 W/K, ending within a fifth of the truth; a refit gives the value over a window exactly.
const seeds = [1, 2, 3, 4];
const runs = [];
for (const seed of seeds) runs.push(await runRig({ tankTemperature: { estimate: true } }, { parameters: [heatLossParameterId], seed }));
const rises = runs.map((cycles) => lossAt(cycles.at(-1)).mean - lossAt(cycles.find((cycle) => cycle.anchor >= 3600)).mean);
const finals = runs.map((cycles) => lossAt(cycles.at(-1)).mean);
const truthAtEnd = trueLoss(runs[0].at(-1).anchor);
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
assert.ok(rises.every((rise) => rise > 2), `Every seed follows the heat loss up: ${rises.map((rise) => rise.toFixed(2)).join(', ')} W/K from an hour to the end.`);
assert.ok(mean(rises) > 4, `On average by more than 4 W/K: ${mean(rises).toFixed(2)}.`);
assert.ok(Math.abs(mean(finals) - truthAtEnd) / truthAtEnd < 0.2, `It ends near the truth: ${mean(finals).toFixed(2)} W/K on average against ${truthAtEnd.toFixed(2)} (${finals.map((value) => value.toFixed(1)).join(', ')}).`);
const tracked = runs[0];
assert.ok(tracked.slice(1, 8).some((cycle) => cycle.estimate.throughParameters[heatLossParameterId]?.includes('tankTemperature')), 'The tank\'s readings reached the heat loss.');
const meanAbsJump = (cycles) => cycles.slice(-10).reduce((sum, cycle) => sum + Math.abs(cycle.jumps.tankTemperature.jump), 0) / 10;
const trackedJumps = mean(runs.map(meanAbsJump));
assert.ok(trackedJumps < meanAbsJump(rigReset) / 1.5, `Tracking it, the jumps shrink (${trackedJumps.toFixed(3)} K on average) where reset keeps leaning (${meanAbsJump(rigReset).toFixed(3)} K).`);
console.log(`Window estimator, a parameter: the drifting rig's heat loss tracked to ${mean(finals).toFixed(2)} W/K on average over ${seeds.length} seeds (${finals.map((value) => value.toFixed(1)).join(', ')}) against a true ${truthAtEnd.toFixed(2)}, the jumps ${trackedJumps.toFixed(3)} K against ${meanAbsJump(rigReset).toFixed(3)} reset.`);
