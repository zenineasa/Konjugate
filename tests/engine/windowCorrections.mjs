/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How the comparison window brings the model back in step (docs/proposals/predictionActualWindow.md, step 4), through the real engine:
//
//   - Nudged with a gain, the measured state at each anchor is the prediction moved that fraction of the way to the measurement.
//   - Watched only (a gain of 0), nothing is corrected after the first move: the model runs on unaided, and a wrong model's jumps
//     grow where a reset would have kept them small.
//   - A measured state the model computes from others is compared at every move and never set, and the cycle does not fail.
//   - Every move says which states the data reaches and which the model carries alone.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/windowCorrections.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readDataLog } from '../../src/dataLog.mjs';
import { guessReplayMapping, replayTargets } from '../../src/dataLogReplay.mjs';
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
    console.log('Window corrections skipped: no Python on this computer to run the simulated rig.');
    process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), 'konjugateCorrections-'));
try {
    const path = join(directory, 'rig.csv');
    const rig = spawnSync(python, [join(root, 'examples', 'dataSources', 'simulatedTankRig.py'), path, '--speed', '1e9', '--start', '2026-11-06T09:00:00Z'], { encoding: 'utf8' });
    assert.equal(rig.status, 0, rig.stderr);
    const log = readDataLog(await readFile(path, 'utf8'));
    const run = async (document, corrections) => {
        const session = new WindowSession({ document, header: log.header, mapping: guessReplayMapping(log.header, replayTargets(document)), window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances: { tankTemperature: 0.5 }, engineOptions, corrections });
        session.push(log.observations);
        await session.end();
        const stateIndex = session.engine.stateIds.indexOf(2);
        const cycles = session.cycles.map((cycle) => ({ ...cycle, anchorValue: cycle.restored.values[stateIndex] }));
        await session.close();
        return cycles;
    };

    // Nudged: the anchor value is the prediction moved three tenths of the way to the measurement.
    const nudged = await run(tankRigProject(), { tankTemperature: { gain: 0.3 } });
    for (const cycle of nudged.slice(1)) {
        const { predicted, measured } = cycle.jumps.tankTemperature;
        assert.equal(cycle.anchorValue, predicted + 0.3 * (measured - predicted), `At ${cycle.anchor} s the state is nudged, not reset.`);
        assert.equal(cycle.corrections.tankTemperature.gain, 0.3);
    }
    assert.equal(nudged[0].anchorValue, nudged[0].corrections.tankTemperature.applied, 'The first move starts at the reading.');

    // Watched only, with the wrong parameters: after the first move nothing is corrected, and the jumps grow.
    const wrong = tankRigProject();
    wrong.sharedParameters.find((parameter) => parameter.id === 20).value = tankCalibration.start.capacitance;
    wrong.edges.find((edge) => edge.name === 'Ambient heat loss').parameters.find((parameter) => parameter.id === 10).value = tankCalibration.start.heatLoss;
    const watched = await run(wrong, { tankTemperature: { gain: 0 } });
    for (const cycle of watched.slice(1)) {
        assert.equal(cycle.anchorValue, cycle.jumps.tankTemperature.predicted, `At ${cycle.anchor} s the model carries its own state.`);
        assert.equal(cycle.corrections.tankTemperature.reason, 'watched only');
    }
    const reset = await run(wrong, {});
    const meanJump = (cycles) => cycles.slice(-10).reduce((sum, cycle) => sum + Math.abs(cycle.jumps.tankTemperature.jump), 0) / 10;
    assert.ok(meanJump(watched) > 2 * meanJump(reset), `Unaided, the wrong model drifts away (mean jump ${meanJump(watched).toFixed(2)} K) where reset keeps it close (${meanJump(reset).toFixed(2)} K).`);

    // A measured state the model computes: y is set from x every instant, so it is compared, and x is carried by the model alone.
    const computed = {
        format: 'konjugate', version: 1,
        runConfigurations: [{ id: 30, name: 'Run', globalTimeStep: 60, outputInterval: 60 }], activeRunConfigurationId: 30,
        nodes: [{
            id: 1, name: 'Gauge', position: [0, 0, 0], appearance: { type: 'primitive', shape: 'box', color: '#34727a' },
            states: [{ id: 2, name: 'X', symbol: 'x', initialValue: 293, unit: 'K' }, { id: 3, name: 'Y', symbol: 'tankTemperature', initialValue: 0, unit: 'K' }],
            sourceTerms: [
                { id: 4, state: 'x', expression: '0', parameters: [], expressionModel: { latex: '0', output: { stateId: 2 }, mathJson: 0, bindings: [] } },
                { id: 5, state: 'tankTemperature', expression: 'x', setsValue: true, parameters: [], expressionModel: { latex: 'x', output: { stateId: 3 }, mathJson: 'x', bindings: [{ kind: 'state', nodeId: 1, stateId: 2, symbol: 'x' }] } }
            ]
        }],
        edges: []
    };
    const header = { ...log.header, signals: log.header.signals.filter((signal) => signal.role === 'output') };
    const session = new WindowSession({ document: computed, header, mapping: guessReplayMapping(header, replayTargets(computed)), window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances: { tankTemperature: 0.5 }, engineOptions });
    session.push(log.observations.filter((observation) => observation.signal === 'tankTemperature'));
    await session.end();
    const [first, second] = session.cycles;
    await session.close();
    assert.equal(session.cycles.length, 31, 'Every move is made with a computed state measured.');
    assert.match(first.corrections.tankTemperature.reason, /computed by the model/);
    assert.ok(first.window.tankTemperature.length > 0 && second.jumps.tankTemperature, 'It is still compared at every move.');
    assert.deepEqual(first.observed, [3]);
    assert.deepEqual(first.unobserved, [2], 'The state the data does not reach is said to be unobserved.');
    console.log(`Window corrections: nudged by a gain, watched only (the wrong model's jumps ${meanJump(watched).toFixed(2)} K against ${meanJump(reset).toFixed(2)} K reset), and a computed state compared without being set.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
