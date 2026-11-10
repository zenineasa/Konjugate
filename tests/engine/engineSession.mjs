/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The engine session (docs/proposals/liveEngineSession.md, "How it is proved"), with the engine's ordinary run as the reference:
//
//   - A session cycle (go back to a checkpoint with some states replaced, then advance) gives exactly the numbers a fresh run from
//     the same state gives, on every execution backend, and with a Python node provider whose own saved state must come back too.
//   - Going back to the same checkpoint a thousand times gives the same samples every time, and the process does not grow.
//   - A corrected input reading gives the same run as if the right value had arrived in the first place.
//   - A command that cannot be carried out says why, changes nothing, and stops the rest of its batch.
//   - A state the model computes from others cannot be set.
//   - A cycle in the session costs less than a fresh run per cycle (printed, and asserted with a wide margin).
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/engineSession.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { runWithEngine } from '../../src/engineAdapter.mjs';
import { EngineSession } from '../../src/engineSession.mjs';
import { decodeProjectFile } from '../../src/projectFile.mjs';
import { heaterPowerParameterId, tankRigProject } from '../../scripts/generateTankRigModel.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

const base64 = (bytes) => Buffer.from(bytes).toString('base64');

// A fresh run from what a restore reported, to the same end, sampled at every step: what a session cycle must equal.
async function freshRun(document, restored, stateIds, { timeStep, end, backend, schedules = {} }) {
    const copy = structuredClone(document);
    for (const [parameterId, samples] of Object.entries(schedules)) {
        copy.sharedParameters.find((parameter) => parameter.id === Number(parameterId)).schedule = { interpolation: 'hold', samples: samples.map(({ time, value }) => [time, value]) };
    }
    const run = await runWithEngine(JSON.stringify(copy), {
        globalTimeStep: timeStep, outputInterval: timeStep, targetTime: end, execution: { backend, workerThreads: 4, partitionCount: 2 },
        startCheckpoint: {
            time: restored.time,
            states: stateIds.map((stateId, position) => ({ stateId, value: restored.values[position] })),
            providerStates: restored.providerStates.map(({ nodeId, payload }) => ({ nodeId, payload: base64(payload) }))
        }
    }, engineOptions);
    return run.result.samples.slice(1).map((sample) => ({ time: sample.time, values: stateIds.map((stateId) => sample.states.find((state) => state.stateId === stateId).value) }));
}

// One session cycle against a fresh run, on one backend: advance keeping checkpoints, go back to one with a state replaced,
// advance again, and compare every sample of every state.
async function cycleEqualsFreshRun({ name, document, timeStep, checkpointInterval, firstAdvance, restoreAt, override, end, backend, inputs = {} }) {
    const session = await EngineSession.start(JSON.stringify(document), { globalTimeStep: timeStep, outputInterval: timeStep, checkpointInterval, execution: { backend, workerThreads: 4, partitionCount: 2 } }, engineOptions);
    try {
        await session.run(Object.entries(inputs).map(([parameterId, samples]) => ({ type: 'appendInputSamples', parameterId: Number(parameterId), samples })));
        await session.advanceTo(firstAdvance, { takeCheckpoints: true });
        const restored = await session.restoreCheckpoint(restoreAt, override ? [override] : []);
        if (override) assert.equal(restored.values[session.stateIds.indexOf(override.stateId)], override.value, `${name}: the replaced state starts at its new value.`);
        const advanced = await session.advanceTo(end);
        const fresh = await freshRun(document, restored, session.stateIds, { timeStep, end, backend, schedules: inputs });
        assert.equal(advanced.samples.length, fresh.length, `${name} on ${backend}: as many samples as the fresh run.`);
        advanced.samples.forEach((sample, index) => {
            assert.equal(sample.time, fresh[index].time, `${name} on ${backend}: sample ${index} at the same time.`);
            assert.deepEqual(sample.values, fresh[index].values, `${name} on ${backend}: at ${sample.time} s the session and the fresh run differ.`);
        });
        return advanced.samples.length;
    } finally {
        await session.close();
    }
}

const rig = tankRigProject();
const heaterInputs = { [heaterPowerParameterId]: [{ time: 0, value: 1000 }, { time: 1800, value: 0 }, { time: 2700, value: 1000 }] };
for (const backend of ['serial', 'threadPool', 'partitioned']) {
    await cycleEqualsFreshRun({ name: 'The rig', document: rig, timeStep: 60, checkpointInterval: 600, firstAdvance: 3600, restoreAt: 1200, override: { stateId: 2, value: 305 }, end: 4800, backend, inputs: heaterInputs });
}
// A model with more nodes, so the partitioned backend has partitions to split it into.
const building = JSON.parse(await decodeProjectFile(await readFile(join(root, 'examples', 'thermalManagement.kjt'))));
const buildingStep = (building.runConfigurations ?? []).find((item) => item.id === building.activeRunConfigurationId)?.globalTimeStep ?? 0.01;
const buildingState = building.nodes.flatMap((node) => node.states).find((state) => true);
for (const backend of ['serial', 'threadPool', 'partitioned']) {
    await cycleEqualsFreshRun({ name: 'Thermal management', document: building, timeStep: buildingStep, checkpointInterval: 20 * buildingStep, firstAdvance: 100 * buildingStep, restoreAt: 40 * buildingStep, override: { stateId: buildingState.id, value: buildingState.initialValue + 1 }, end: 140 * buildingStep, backend });
}
// A Python node provider (a PI controller whose integral term lives only in the provider): rewinding must bring its state back.
const controlled = JSON.parse(await readFile(join(root, 'examples', 'providers', 'piControlledTankProject.json'), 'utf8'));
await cycleEqualsFreshRun({ name: 'The PI-controlled tank', document: controlled, timeStep: 1, checkpointInterval: 20, firstAdvance: 200, restoreAt: 100, override: { stateId: 11, value: 0.4 }, end: 260, backend: 'serial' });

// A thousand rewinds to the same checkpoint: the same samples every time, and no growth.
{
    const session = await EngineSession.start(JSON.stringify(rig), { globalTimeStep: 60, outputInterval: 60, checkpointInterval: 600, reportedStateIds: [2] }, engineOptions);
    const rss = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(session.pid)], { encoding: 'utf8' }).trim());
    await session.appendInputs(heaterPowerParameterId, heaterInputs[heaterPowerParameterId]);
    await session.advanceTo(3600, { takeCheckpoints: true });
    const once = async () => (await session.run([{ type: 'restoreCheckpoint', time: 1200, overrides: [{ stateId: 2, value: 301 }] }, { type: 'advanceTo', time: 7200 }]))[1].samples;
    const first = await once();
    // An advance that asks not to keep its samples (a catch-up: only the state it reaches matters) is answered with none, and the next
    // advance's samples are its own, complete.
    const [, discarded, kept] = await session.run([
        { type: 'restoreCheckpoint', time: 1200, overrides: [{ stateId: 2, value: 301 }] },
        { type: 'advanceTo', time: 3600, discardSamples: true },
        { type: 'advanceTo', time: 7200 }
    ]);
    assert.deepEqual(discarded.samples, [], 'A catch-up keeps no samples.');
    // Thinned to every 7th as they arrive, an advance keeps those and its last, and nothing else: what a sandbox's run ahead draws.
    const [, thinned] = await session.run([
        { type: 'restoreCheckpoint', time: 1200, overrides: [{ stateId: 2, value: 301 }] },
        { type: 'advanceTo', time: 7200, keepEvery: 7 }
    ]);
    const expected = first.filter((sample, index) => index % 7 === 0);
    if (expected.at(-1).time !== first.at(-1).time) expected.push(first.at(-1));
    assert.deepEqual(thinned.samples, expected, 'Every 7th sample, and the last.');
    assert.deepEqual(kept.samples, first.filter((sample) => sample.time > 3600), 'The advance after it has its own samples, as without the catch-up.');
    for (let index = 0; index < 100; index += 1) await once();
    const before = rss();
    for (let index = 0; index < 1000; index += 1) assert.deepEqual(await once(), first, `Rewind ${index} gave different samples.`);
    const grown = rss() - before;
    assert.ok(grown < 2048, `The engine grew by ${grown} kB over a thousand rewinds.`);
    // Many cycles that keep a checkpoint and let the old ones go: the kept set stays bounded.
    await session.restoreCheckpoint(0);
    const cyclesBefore = rss();
    for (let anchor = 0; anchor < 600 * 2000; anchor += 600) {
        await session.run([
            { type: 'appendInputSamples', parameterId: heaterPowerParameterId, samples: [{ time: anchor + 3600, value: anchor % 1200 ? 1000 : 0 }] },
            { type: 'restoreCheckpoint', time: anchor },
            { type: 'advanceTo', time: anchor + 600, takeCheckpoints: true },
            { type: 'advanceTo', time: anchor + 3600 },
            { type: 'retainCheckpointsFrom', time: anchor + 600 }
        ]);
    }
    const cyclesGrown = rss() - cyclesBefore;
    assert.ok(cyclesGrown < 4096, `The engine grew by ${cyclesGrown} kB over two thousand cycles that let their old checkpoints go.`);
    await session.close();
}

// A corrected input: the same run as if the right reading had come first.
{
    const start = async () => EngineSession.start(JSON.stringify(rig), { globalTimeStep: 60, outputInterval: 60, checkpointInterval: 600, reportedStateIds: [2] }, engineOptions);
    const corrected = await start();
    await corrected.appendInputs(heaterPowerParameterId, [{ time: 0, value: 1000 }, { time: 600, value: 1000 }, { time: 1200, value: 0 }]);
    await corrected.appendInputs(heaterPowerParameterId, [{ time: 600, value: 0 }, { time: 1200, value: 0 }], 600);
    const right = await start();
    await right.appendInputs(heaterPowerParameterId, [{ time: 0, value: 1000 }, { time: 600, value: 0 }, { time: 1200, value: 0 }]);
    const [a, b] = await Promise.all([corrected.advanceTo(3600), right.advanceTo(3600)]);
    assert.deepEqual(a.samples, b.samples, 'A corrected reading gives the run the right reading would have.');
    // Readings out of order, not marked as a correction, are refused.
    const refused = await corrected.send([{ type: 'appendInputSamples', parameterId: heaterPowerParameterId, samples: [{ time: 300, value: 5 }] }]);
    assert.equal(refused[0].ok, false);
    assert.match(refused[0].message, /time order/);
    await Promise.all([corrected.close(), right.close()]);
}

// A failed command changes nothing and stops its batch; a computed state cannot be set.
{
    const session = await EngineSession.start(JSON.stringify(rig), { globalTimeStep: 60, outputInterval: 60, checkpointInterval: 600 }, engineOptions);
    await session.advanceTo(1200, { takeCheckpoints: true });
    const replies = await session.send([{ type: 'restoreCheckpoint', time: 900 }, { type: 'advanceTo', time: 2400 }]);
    assert.equal(replies[0].ok, false);
    assert.equal(replies[0].message, 'No checkpoint is kept at 900 s.');
    assert.equal(replies[1].ok, false);
    assert.match(replies[1].message, /an earlier command in the same batch failed/);
    assert.equal(replies[1].time, 1200, 'The session is still where it was.');
    assert.equal((await session.advanceTo(1800)).time, 1800, 'A later batch is carried out.');
    await session.close();

    const algebraic = {
        format: 'konjugate', version: 1,
        nodes: [{
            id: 1, name: 'Probe', appearance: { type: 'primitive', shape: 'box', color: '#34727a' },
            states: [{ id: 2, name: 'Y', symbol: 'y', initialValue: 0, unit: '' }],
            sourceTerms: [{
                id: 3, state: 'y', expression: 'k', setsValue: true,
                parameters: [{ id: 4, name: 'k', symbol: 'k', value: 0.5, unit: '', mode: 'constant' }],
                expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId: 4, symbol: 'k' }], output: { stateId: 2 }, mathJson: 'k' }
            }]
        }],
        edges: []
    };
    const probe = await EngineSession.start(JSON.stringify(algebraic), { globalTimeStep: 1, outputInterval: 1 }, engineOptions);
    const [setComputed] = await probe.send([{ type: 'restoreCheckpoint', time: 0, overrides: [{ stateId: 2, value: 9 }] }]);
    assert.equal(setComputed.ok, false);
    assert.equal(setComputed.message, 'State 2 is computed by the model from other states, so it cannot be set.');
    await probe.close();
}

// What a cycle costs in the session against a fresh run per cycle, on the PI-controlled tank (its Python provider is started once
// in the session, and once per run otherwise).
{
    const session = await EngineSession.start(JSON.stringify(controlled), { globalTimeStep: 1, outputInterval: 1, checkpointInterval: 60, reportedStateIds: [11] }, engineOptions);
    await session.advanceTo(60, { takeCheckpoints: true });
    const cycles = 20;
    let started = performance.now();
    for (let index = 0; index < cycles; index += 1) {
        await session.run([{ type: 'restoreCheckpoint', time: 60, overrides: [{ stateId: 11, value: 0.5 }] }, { type: 'advanceTo', time: 120, takeCheckpoints: true }, { type: 'advanceTo', time: 660 }]);
    }
    const sessionMilliseconds = (performance.now() - started) / cycles;
    const restored = await session.restoreCheckpoint(60, [{ stateId: 11, value: 0.5 }]);
    started = performance.now();
    for (let index = 0; index < cycles; index += 1) await freshRun(controlled, restored, session.stateIds, { timeStep: 1, end: 660, backend: 'serial' });
    const freshMilliseconds = (performance.now() - started) / cycles;
    await session.close();
    assert.ok(sessionMilliseconds < freshMilliseconds, `A cycle took ${sessionMilliseconds.toFixed(1)} ms in the session and ${freshMilliseconds.toFixed(1)} ms as a fresh run.`);
    console.log(`Engine session: cycles equal fresh runs on every backend and with a Python provider; a thousand rewinds identical; `
        + `a PI-controlled tank cycle takes ${sessionMilliseconds.toFixed(1)} ms in the session against ${freshMilliseconds.toFixed(1)} ms as a fresh run.`);
}
