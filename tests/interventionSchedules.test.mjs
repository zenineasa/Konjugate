/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyInterventionSchedules, scheduleForChanges } from '../src/interventionSchedules.mjs';
import { runScenarioFork } from '../src/webLauncherRuns.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// A level fed by a shared live gain, as launcherHost.test.mjs builds one.
const node = (id, name, stateId) => ({ id, name, position: [0, 0, 0], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#888888' }, states: [{ id: stateId, name: 'Level', symbol: 'level', initialValue: 0 }] });
const project = (sharedExtra = {}) => ({
    format: 'konjugate', version: 1, metadata: { units: 'SI' }, nodes: [node(1, 'Source', 2), node(3, 'Target', 4)],
    edges: [{
        id: 5, name: 'Feed', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 3, stateId: 4 }, directionality: 'directed', equation: '\\mathrm{gain}',
        equationModel: { latex: '\\mathrm{gain}', output: { role: 'target', stateId: 4 }, bindings: [{ kind: 'parameter', parameterId: 6, symbol: 'gain' }], mathJson: 'gain' },
        parameters: [{ id: 6, name: 'Gain', symbol: 'gain', value: 1, mode: 'live', control: { minimum: 0, maximum: 10, step: 1 }, sharedParameterId: 7 }],
        appearance: { color: '#888888', offset: 0 }
    }],
    sharedParameters: [{ id: 7, name: 'Shared gain', symbol: 'gain', value: 1, mode: 'live', control: { minimum: 0, maximum: 10, step: 1 }, ...sharedExtra }],
    runConfigurations: [{ id: 8, name: 'Default', globalTimeStep: 0.1, outputInterval: 0.5 }], activeRunConfigurationId: 8
});

test('a jump is written as the value before it and the value at it, so a time at the jump gets the new value', () => {
    const schedule = scheduleForChanges({ value: 1 }, [{ value: 3, at: 2, duration: 0 }], 5);
    assert.equal(schedule.interpolation, 'linear');
    assert.equal(schedule.samples[0][0], 5);
    const last = schedule.samples.at(-1);
    assert.deepEqual([last[0], last[1]], [7, 3]);
    assert.deepEqual(schedule.samples.at(-2)[1], 1, 'Just before the step the parameter is still at its own value.');
    assert.ok(schedule.samples.at(-2)[0] < 7 && schedule.samples.at(-2)[0] > 6.999999);
});

test('a change later than every other starts governing the instant it begins, and a pulse gives the base value back', () => {
    const schedule = scheduleForChanges({ value: 1 }, [{ value: 9, at: 0, duration: 2, baseValue: 4 }, { value: 6, at: 3, duration: 0 }], 0);
    const at = (time) => {
        const pairs = schedule.samples;
        if (time <= pairs[0][0]) return pairs[0][1];
        if (time >= pairs.at(-1)[0]) return pairs.at(-1)[1];
        const upper = pairs.findIndex((pair) => pair[0] > time);
        const [t0, v0] = pairs[upper - 1];
        const [t1, v1] = pairs[upper];
        return v0 + (time - t0) / (t1 - t0) * (v1 - v0);
    };
    assert.equal(at(0), 9);
    assert.equal(at(1.5), 9);
    assert.equal(at(2), 4, 'The pulse is over: back to its base value.');
    assert.equal(at(2.9), 4);
    assert.equal(at(3), 6);
    assert.equal(at(50), 6);
});

test('a parameter that follows a schedule keeps it until a change takes over, and loses its fitting bounds for the run', () => {
    const document = project({ value: 2, schedule: { interpolation: 'hold', samples: [[0, 2], [4, 5], [8, 7]] }, tuning: { minimum: 0, maximum: 10 } });
    const copy = applyInterventionSchedules(document, [{ sharedParameterId: 7, value: 1, at: 5, duration: 0 }], 3);
    assert.equal(copy.sharedParameters[0].tuning, undefined);
    assert.ok(document.sharedParameters[0].tuning, 'The original is untouched.');
    const samples = copy.sharedParameters[0].schedule.samples;
    assert.deepEqual(samples[0], [3, 2]);
    assert.ok(samples.some(([time, value]) => time === 4 && value === 5), 'The stored staircase steps up at 4.');
    assert.deepEqual(samples.at(-1), [8, 1], 'The change took over at 8 (fork 3 + 5) and holds.');
});

test('a change to something that is not a shared parameter is refused by name', () => {
    assert.throws(() => applyInterventionSchedules(project(), [{ sharedParameterId: 99, name: 'Mystery', value: 1, at: 0 }], 0), /Mystery.*not a shared parameter/);
});

// The reference: the desktop's own way (commands to a paused fork), against the same engine.
const enginePath = join(root, 'out', 'engine', 'konjugateEngine');
test('written into the model, the changes give the run the engine gives them as commands', { skip: !existsSync(enginePath) && 'the engine is not built' }, async () => {
    const { startEngineRun } = await import('../src/engineAdapter.mjs');
    const { runScenarioBranches } = await import('../src/launcherHost.mjs');
    const engineOptions = { applicationPath: root, resourcesPath: '', packaged: false };
    const finalLevel = (samples) => samples.at(-1).states.find((state) => state.stateId === 4).value;
    const cases = {
        'a step at the fork': [{ sharedParameterId: 7, value: 3, at: 0 }],
        'a step after the fork': [{ sharedParameterId: 7, value: 3, at: 1.3 }],
        'a pulse': [{ sharedParameterId: 7, value: 4, at: 0.7, duration: 1.6, baseValue: 1 }],
        'a path': [{ sharedParameterId: 7, samples: [{ time: 0, value: 1 }, { time: 2, value: 5 }, { time: 4, value: 2 }], at: 0, duration: 0, baseValue: 1 }],
        'a path with a later step over it': [{ sharedParameterId: 7, samples: [{ time: 0, value: 1 }, { time: 3, value: 6 }], at: 0, duration: 0, baseValue: 1 }, { sharedParameterId: 7, value: 2, at: 2, duration: 0 }],
        'a step then a pulse': [{ sharedParameterId: 7, value: 8, at: 0, duration: 0 }, { sharedParameterId: 7, value: 2, at: 1, duration: 0.5, baseValue: 1 }]
    };
    const content = JSON.stringify(project());
    const config = { name: 'Baseline', targetTime: 10, globalTimeStep: 0.1, outputInterval: 0.5 };
    const baselineRun = await startEngineRun(content, config, engineOptions, { retainResult: true });
    const baseline = { result: await baselineRun.completion, resultPath: baselineRun.resultPath, cleanup: baselineRun.cleanup };
    const scenario = { forkAt: 5, runTime: 10 };
    // A host whose "page" runs the native engine: with no commands it is the page that cannot send any.
    const host = {
        canSendCommands: false,
        runModel: async ({ content: text, config: runConfig }) => {
            const run = await startEngineRun(text, runConfig, engineOptions, { retainResult: true });
            const result = await run.completion;
            await run.cleanup?.();
            return result;
        }
    };
    for (const [name, interventions] of Object.entries(cases)) {
        const reference = await runScenarioBranches({ content, config, scenario, interventions, baseline, engineOptions });
        const written = await runScenarioFork({ host, document: JSON.parse(content), contentText: content, config, scenario, interventions, baseline });
        assert.equal(written.forkTime, reference.forkTime, name);
        assert.equal(written.child.result.samples.length, reference.child.result.samples.length, name);
        for (const [index, sample] of reference.child.result.samples.entries()) {
            const other = written.child.result.samples[index];
            assert.equal(other.time, sample.time, name);
            for (const state of sample.states) {
                const value = other.states.find((item) => item.stateId === state.stateId).value;
                assert.ok(Math.abs(value - state.value) <= 1e-6 * Math.max(1, Math.abs(state.value)), `${name}: at ${sample.time} state ${state.stateId} is ${value}, the engine's commands gave ${state.value}`);
            }
        }
        assert.ok(Number.isFinite(finalLevel(written.child.result.samples)), name);
        await reference.child.cleanup?.();
    }
    await baseline.cleanup?.();
});
