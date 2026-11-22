/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The comparison window's own logic (src/windowSession.mjs), against a fake engine (tests/fixtures/fakeEngineSession.mjs) running a
// model simple enough to work out by hand: when a move is due, what it corrects and compares, where its forecast starts, the
// trend and the warning, keeping up with a backlog, recovering from a dead engine, refits, model changes and the sandbox. What the
// real engine computes is checked against these same flows in tests/engine/ (window*.mjs, liveTwin*.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineSessionError } from '../src/engineSession.mjs';
import { Sandbox, WindowSession } from '../src/windowSession.mjs';
import { installFakeEngine } from './fixtures/fakeEngineSession.mjs';

// A tank whose temperature T (state 2) rises at the heater's input (shared parameter 20) less a heat loss k (parameter 10), and a
// wall (state 3) no sensor measures, warming 0.01 K a second. With the heater off and no loss, the model holds T where it is put.
function tankDocument() {
    return {
        format: 'konjugate', version: 1,
        runConfigurations: [{ id: 30, name: 'Run', globalTimeStep: 100, outputInterval: 100 }], activeRunConfigurationId: 30,
        sharedParameters: [{ id: 20, name: 'Heater', symbol: 'heater', value: 0, unit: 'K/s' }],
        nodes: [{
            id: 1, name: 'Tank', position: [0, 0, 0], appearance: { type: 'primitive', shape: 'box', color: '#34727a' },
            states: [{ id: 2, name: 'Temperature', symbol: 'T', initialValue: 20, unit: 'K' }, { id: 3, name: 'Wall', symbol: 'w', initialValue: 5, unit: 'K' }],
            sourceTerms: []
        }],
        edges: [{ id: 9, name: 'Loss', parameters: [{ id: 10, name: 'Heat loss', symbol: 'k', value: 0, unit: 'K/s', tuning: { minimum: 0, maximum: 1 } }] }]
    };
}
const tankModel = { derivatives: { 2: ({ input, parameter }) => input(20) - parameter(10), 3: () => 0.01 } };
const header = { signals: [{ name: 'heater', role: 'input', unit: 'K/s' }, { name: 'T', role: 'output', unit: 'K' }] };
const mapping = [{ signal: 'heater', role: 'input', unit: 'K/s', parameterId: 20 }, { signal: 'T', role: 'output', unit: 'K', stateId: 2 }];
const timing = { window: 600, stride: 200, horizon: 400, timeStep: 100 };

// Readings every 100 s, timed from an origin that is not zero (the session counts from its first reading).
const origin = 5000;
const reading = (signal, time, value, extra = {}) => ({ signal, time: origin + time, value, quality: 'good', revision: 0, ...extra });
const temperatures = (from, to, value = (time) => 20 + time / 100) => {
    const list = [];
    for (let time = from; time <= to + 1e-9; time += 100) list.push(reading('T', time, value(time)));
    return list;
};
const session = (options = {}) => new WindowSession({ document: tankDocument(), header, mapping, ...timing, tolerances: { T: 1 }, engineOptions: {}, ...options });
const valueAt = (series, time) => series.find((sample) => Math.abs(sample.time - time) < 1e-9)?.value;

test('refuses a setup it cannot run, saying why', () => {
    assert.throws(() => session({ stride: 700 }), /moves at least once a window/);
    assert.throws(() => session({ mapping: mapping.filter((entry) => entry.role === 'input') }), /Map at least one measured signal/);
    assert.throws(() => session({ corrections: { T: { gain: 1.5 } } }), /a gain from 0 \(none\) to 1/);
    assert.throws(() => session({ corrections: { T: { estimate: true, noise: 0 } } }), /positive standard deviation/);
    assert.throws(() => session({ estimator: { members: 2 } }), /from 4 to 1000 members/);
    assert.throws(() => session({ estimator: { parameters: [10] } }), /choose "estimate" for at least one measured signal/);
    assert.throws(() => session({ corrections: { T: { estimate: true } }, estimator: { parameters: [99] } }), /Parameter 99 is not in the model/);
    const untuned = tankDocument();
    delete untuned.edges[0].parameters[0].tuning;
    assert.throws(() => session({ document: untuned, corrections: { T: { estimate: true } }, estimator: { parameters: [10] } }), /Mark Heat loss tunable/);
    assert.throws(() => session().setAlert(0), /positive multiple of the tolerance/);
});

test('makes a move once the data has gone past its now, or reached it when the data has ended', async (t) => {
    installFakeEngine(t, tankModel);
    const twin = session();
    twin.push(temperatures(0, 600));
    await twin.idle();
    assert.equal(twin.cycles.length, 0, 'A reading at now itself may still have others for the same instant to come.');
    assert.equal(twin.latestTime, 600, 'Times are counted from the first reading.');
    twin.push(temperatures(700, 700));
    await twin.idle();
    assert.equal(twin.cycles.length, 1);

    const ended = session();
    ended.push(temperatures(0, 600));
    await ended.end();
    assert.equal(ended.cycles.length, 1, 'With the data complete, reaching now is enough.');
    await twin.close();
    await ended.close();
});

test('the first move starts the measured state at its reading and compares the window with what was measured', async (t) => {
    installFakeEngine(t, tankModel);
    const twin = session();
    twin.push(temperatures(0, 600));
    await twin.end();
    const [cycle] = twin.cycles;
    assert.equal(cycle.anchor, 0);
    assert.equal(cycle.now, 600);
    assert.deepEqual(cycle.corrections.T, { gain: 1, applied: 20 });
    assert.equal(cycle.restored.values[0], 20);
    // The model holds T at 20 while the readings rise 1 K every 100 s.
    assert.deepEqual(cycle.window.T.map((entry) => entry.error), [0, -1, -2, -3, -4, -5, -6]);
    assert.deepEqual(cycle.jumps, {}, 'There is no prediction to jump from on the first move.');
    // The forecast starts from the latest reading at now, not from where the window's run drifted to.
    assert.deepEqual(cycle.forecastFrom.T, { model: 20, reading: 26, applied: 26 });
    assert.deepEqual(cycle.forecast.T.map((sample) => [sample.time, sample.value]), [[700, 26], [800, 26], [900, 26], [1000, 26]]);
    // The wall, which no sensor measures, is what the twin infers.
    assert.deepEqual(cycle.observed, [2]);
    assert.deepEqual(cycle.unobserved, [3]);
    assert.equal(valueAt(cycle.inferred[3], 0), 5);
    assert.equal(valueAt(cycle.inferred[3], 1000), 15);
    assert.deepEqual(cycle.runaway, []);
    await twin.close();
});

test('each later move reads its jump off the move before and resets the measured state at the anchor', async (t) => {
    installFakeEngine(t, tankModel);
    const twin = session();
    twin.push(temperatures(0, 1200));
    await twin.end();
    assert.deepEqual(twin.cycles.map((cycle) => cycle.anchor), [0, 200, 400, 600]);
    for (const cycle of twin.cycles.slice(1)) {
        // The move before held T at its anchor's reading; the reading has risen 2 K over the stride since.
        const measured = 20 + cycle.anchor / 100;
        assert.deepEqual(cycle.jumps.T, { predicted: measured - 2, measured, jump: -2 });
        assert.equal(cycle.restored.values[0], measured);
    }
    await twin.close();
});

test('a gain nudges the measured state part of the way, and a gain of 0 only watches it', async (t) => {
    installFakeEngine(t, tankModel);
    const nudged = session({ corrections: { T: { gain: 0.5 } } });
    nudged.push(temperatures(0, 1000));
    await nudged.end();
    assert.equal(nudged.cycles[0].restored.values[0], 20, 'The first move starts at the reading whatever the gain.');
    assert.deepEqual(nudged.cycles[0].forecastFrom.T, { model: 20, reading: 26, applied: 23 });
    assert.deepEqual(nudged.cycles[1].corrections.T, { gain: 0.5, applied: 21 });
    assert.deepEqual(nudged.cycles[2].corrections.T, { gain: 0.5, applied: 22.5 }, 'The prediction is the nudged value, held.');

    const watched = session({ corrections: { T: { gain: 0 } } });
    watched.push(temperatures(0, 1000));
    await watched.end();
    for (const cycle of watched.cycles.slice(1)) {
        assert.deepEqual(cycle.corrections.T, { gain: 0, applied: null, reason: 'watched only' });
        assert.equal(cycle.restored.values[0], 20, 'The model carries its own state.');
        assert.equal(cycle.forecastFrom.T.applied, null);
    }
    await nudged.close();
    await watched.close();
});

test('a state the model computes from others is compared, never set', async (t) => {
    installFakeEngine(t, { ...tankModel, computed: { 3: (state) => 2 * state(2) } });
    const twin = session({ mapping: [{ signal: 'T', role: 'output', stateId: 3 }] });
    twin.push(temperatures(0, 800, () => 40));
    await twin.end();
    const [first, second] = twin.cycles;
    assert.match(first.corrections.T.reason, /computed by the model from other states/);
    assert.equal(first.restored.values[1], 40, 'Twice the temperature, left as the model has it.');
    assert.equal(first.forecastFrom.T.applied, null);
    assert.deepEqual(second.jumps.T, { predicted: 40, measured: 40, jump: 0 });
    await twin.close();
});

test('bad readings are passed over, a later revision replaces an earlier one, and a missing anchor reading is said', async (t) => {
    installFakeEngine(t, tankModel);
    const twin = session();
    twin.push([
        ...temperatures(0, 100),
        reading('T', 200, 999, { quality: 'bad' }),
        ...temperatures(300, 300),
        reading('T', 400, 999),
        reading('T', 400, 24, { revision: 1 }),
        reading('T', 400, 777, { revision: 0 }),
        ...temperatures(500, 1000)
    ]);
    await twin.end();
    const at200 = twin.cycles.find((cycle) => cycle.anchor === 200);
    const at400 = twin.cycles.find((cycle) => cycle.anchor === 400);
    assert.equal(at200.corrections.T.applied, 22, 'Between the good readings either side.');
    assert.ok(!at200.window.T.some((entry) => entry.time === 200), 'A bad reading is not compared.');
    assert.equal(at400.corrections.T.applied, 24, 'The latest revision, not the one that arrived last.');

    const late = session();
    late.push([reading('heater', 0, 0), ...temperatures(100, 700)]);
    await late.end();
    assert.deepEqual(late.cycles[0].corrections.T, { applied: null, reason: 'no reading at the anchor' });
    await twin.close();
    await late.close();
});

test('input readings are sent once each, up to the move\'s now, and drive the model', async (t) => {
    const engines = installFakeEngine(t, tankModel);
    const twin = session();
    // The heater comes on at 300 s, warming the tank 1 K every 100 s.
    const heater = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((time) => reading('heater', time, time >= 300 ? 0.01 : 0));
    twin.push([...heater, ...temperatures(0, 900, () => 20)]);
    await twin.end();
    const sent = engines[0].batches.flat().filter((command) => command.type === 'appendInputSamples');
    assert.deepEqual(sent.map((command) => command.samples.map((sample) => sample.time)), [[0, 100, 200, 300, 400, 500, 600], [700, 800]],
        'The first move sends what is there up to its now; the next only what is new up to its own.');
    const [first, second] = twin.cycles;
    assert.deepEqual(first.inputs.heater.map((entry) => entry.time), [0, 100, 200, 300, 400, 500, 600]);
    assert.equal(valueAt(first.model.T, 300), 20);
    assert.equal(valueAt(first.model.T, 600), 23);
    assert.equal(second.jumps.T.predicted, 20, 'At its anchor (200 s) the heater had not come on yet.');
    await twin.close();
});

// ---- input readings that change after they were sent ------------------------------------------------------------------------

// The heater warms the wall, which no sensor measures, as well as the tank: a reset at the anchor puts the tank back on its reading
// whatever the heater did, so the wall is where an input the engine got wrong still shows.
const heatedModel = { derivatives: { 2: ({ input }) => input(20), 3: ({ input }) => input(20) } };
const heater = (from, to, value = () => 0) => {
    const list = [];
    for (let time = from; time <= to + 1e-9; time += 100) list.push(reading('heater', time, value(time)));
    return list;
};
const steady = (from, to) => [...heater(from, to), ...temperatures(from, to, () => 20)];
// What a move computed, to compare one twin's with another's.
const outcome = (cycle) => ({ restored: cycle.restored, model: cycle.model, inferred: cycle.inferred, forecast: cycle.forecast });

// Feeds two twins the same readings in the same batches, except that one has a reading as it was corrected from the start and the
// other is sent the correction later, with the batch named; answers both twins' moves.
async function corrected(t, { batches, correction, at, options = {} }) {
    const run = async (late) => {
        const engines = installFakeEngine(t, heatedModel);
        const twin = session({ ...options });
        for (const [position, batch] of batches.entries()) {
            const readings = batch.map((entry) => (!late && entry.signal === correction.signal && entry.time === origin + correction.time ? { ...entry, value: correction.value } : entry));
            twin.push(late && position === at ? [...readings, reading(correction.signal, correction.time, correction.value, { revision: 1 })] : readings);
            await twin.idle();
        }
        await twin.close();
        return { twin, engines };
    };
    return { late: await run(true), reference: await run(false) };
}

test('a corrected input reading the next move runs over is sent again in place of the old, and that move is as if it had come in time', async (t) => {
    // Move 0 (anchor 0, now 600) runs on the heater off at 500 s; then the reading at 500 s is corrected to on. Move 1's run starts at
    // its anchor, 200 s, so the correction falls inside it.
    const { late, reference } = await corrected(t, { batches: [steady(0, 700), steady(800, 900)], correction: { signal: 'heater', time: 500, value: 0.01 }, at: 1 });
    assert.equal(late.twin.cycles.length, 2);
    assert.deepEqual(late.twin.cycles[1].inputCorrections, [{ signal: 'heater', time: 500, applied: 'resent' }]);
    const replaced = late.engines[0].batches.flat().find((command) => command.type === 'appendInputSamples' && command.replaceFrom !== undefined);
    assert.deepEqual(replaced, { type: 'appendInputSamples', parameterId: 20, replaceFrom: 500, samples: [500, 600, 700, 800].map((time) => ({ time, value: time === 500 ? 0.01 : 0 })) },
        'From the corrected reading on, in place of what the engine held.');
    assert.notDeepEqual(outcome(late.twin.cycles[0]), outcome(reference.twin.cycles[0]), 'Move 0 keeps the record of what was known when it was made.');
    assert.deepEqual(outcome(late.twin.cycles[1]), outcome(reference.twin.cycles[1]));
    assert.deepEqual(late.twin.freshRunFor(late.twin.cycles[1]), reference.twin.freshRunFor(reference.twin.cycles[1]), 'Its record reproduces what it ran.');
    assert.equal(reference.twin.cycles[1].inputCorrections, undefined, 'A twin with nothing corrected says nothing of corrections.');
});

test('a corrected input reading from before the checkpoint a move starts at runs the twin again from the state it logged before it', async (t) => {
    // The reading at 100 s is corrected after moves 0 and 1: move 2 starts at its anchor, 400 s, from a checkpoint taken with the heater
    // off at 100 s. It is run again from move 0's logged state (0 s), with move 1's reset at 200 s made again on the way.
    const { late, reference } = await corrected(t, { batches: [steady(0, 900), steady(1000, 1100)], correction: { signal: 'heater', time: 100, value: 0.01 }, at: 1 });
    const [, , move] = late.twin.cycles;
    assert.deepEqual(move.inputCorrections, [{ signal: 'heater', time: 100, applied: 'rebuilt', from: 0 }]);
    assert.equal(move.inferred[3][0].value, 6, 'The wall had the heater\'s 100 s on it, which a run on the old reading would not.');
    assert.deepEqual(outcome(move), outcome(reference.twin.cycles[2]));
    const rebuild = late.engines[0].batches.at(-2);
    assert.deepEqual(rebuild.filter((command) => command.type === 'restoreState' || command.type === 'restoreCheckpoint').map((command) => [command.type, command.time]),
        [['restoreState', 0], ['restoreCheckpoint', 200], ['restoreCheckpoint', 400]], 'From move 0\'s state, through move 1\'s reset, to the move\'s own anchor.');
});

test('a correction from before the earliest state the twin can run again from is applied from there, and the record says so', async (t) => {
    // Keeping up, the twin started at move 11 (anchor 2200 s): a reading at 1000 s corrected after that can only be run again from 2200 s.
    const { late } = await corrected(t, { batches: [steady(0, 3000), steady(3100, 3100)], correction: { signal: 'heater', time: 1000, value: 0.01 }, at: 1, options: { keepUp: true } });
    assert.deepEqual(late.twin.cycles.map((cycle) => cycle.index), [11, 12]);
    assert.deepEqual(late.twin.cycles[1].inputCorrections, [{
        signal: 'heater', time: 1000, applied: 'rebuilt', from: 2200, reason: 'from the earliest state the twin can run again from: before it, the twin ran on the reading as it was'
    }]);
});

test('a refit restarts the twin from a state of its own, which a later rebuild runs from rather than from before it', async (t) => {
    const engines = installFakeEngine(t, heatedModel);
    const twin = session();
    twin.push(steady(0, 900));
    await twin.idle();
    await twin.applyRefit({ values: [{ parameterId: 3, value: 9 }], cycle: 1 });
    twin.push([reading('heater', 100, 0.01, { revision: 1 }), ...steady(1000, 1100)]);
    await twin.idle();
    const move = twin.cycles.at(-1);
    assert.deepEqual(move.inputCorrections, [{ signal: 'heater', time: 100, applied: 'rebuilt', from: 200, reason: 'from the earliest state the twin can run again from: before it, the twin ran on the reading as it was' }]);
    const rebuild = engines.at(-1).batches.at(-2).find((command) => command.type === 'restoreState');
    assert.equal(rebuild.values[1], 9, 'From the wall the refit found at 200 s.');
    await twin.close();
});

test('with the estimator, a correction from before its last analysis is said not to have been applied, and a later one is sent again', async (t) => {
    const engines = installFakeEngine(t, heatedModel);
    const twin = session({ corrections: { T: { estimate: true, noise: 0.1 } } });
    twin.push(steady(0, 900));
    await twin.idle();
    twin.push([reading('heater', 100, 0.01, { revision: 1 }), reading('heater', 700, 0.01, { revision: 1 }), ...steady(1000, 1100)]);
    await twin.idle();
    assert.deepEqual(twin.cycles.at(-1).inputCorrections, [{ signal: 'heater', time: 100, applied: null, reason: 'before the estimator\'s last analysis, which is not run again' }],
        'One record for the input, at its earliest change.');
    // (Commands that take a forecast's projected inputs out again send no readings: they are not corrections.)
    const replaced = engines[0].batches.flat().filter((command) => command.replaceFrom !== undefined && command.samples.length);
    assert.deepEqual(replaced.map((command) => command.replaceFrom), [100], 'The engine still gets the readings as they now are.');
    await twin.close();
});

test('an input reading marked bad after it was sent is taken back, and one that arrives late is put in its place', async (t) => {
    const engines = installFakeEngine(t, heatedModel);
    const twin = session();
    twin.push([...heater(0, 700, (time) => (time === 400 ? 0.01 : 0)).filter((entry) => entry.time !== origin + 300), ...temperatures(0, 700, () => 20)]);
    await twin.idle();
    twin.push([reading('heater', 400, 0.01, { quality: 'bad', revision: 1 }), reading('heater', 300, 0.02), ...steady(800, 900)]);
    await twin.idle();
    const replaced = engines[0].batches.flat().find((command) => command.replaceFrom !== undefined);
    assert.deepEqual(replaced.replaceFrom, 300);
    assert.deepEqual(replaced.samples.map((sample) => [sample.time, sample.value]), [[300, 0.02], [500, 0], [600, 0], [700, 0], [800, 0]]);
    assert.deepEqual(twin.cycles[1].inputCorrections, [{ signal: 'heater', time: 300, applied: 'resent' }]);
    await twin.close();
});

test('after skipping a backlog, the catch-up runs on the inputs that were applied, not on what the engine kept for the move after', async (t) => {
    installFakeEngine(t, heatedModel);
    const twin = session({ keepUp: true, maxBehind: 3 });
    // The heater is on for 100 s from 2200 s, the anchor move 11 logs; the engine then keeps only the readings from 2400 s on (and the
    // last before it, the heater off at 2300 s), so a catch-up from 2200 s on what it kept would miss that 100 s.
    const on = (time) => (time === 2200 ? 0.01 : 0);
    twin.push([...heater(0, 3000, on), ...temperatures(0, 3000, () => 20)]);
    await twin.idle();
    twin.push(steady(3100, 4000));
    await twin.idle();
    const [first, skipped] = twin.cycles;
    assert.deepEqual([first.index, skipped.index], [11, 16]);
    assert.equal(skipped.restored.values[1] - first.restored.values[1], 1, 'The wall warmed by the heater\'s 100 s between the two anchors.');
    assert.equal(skipped.inputCorrections, undefined, 'Sending the readings again for a catch-up is not a correction.');
    await twin.close();
});

test('the trend calls a lean only once it is clear twice running, and raises the warning past it', async (t) => {
    installFakeEngine(t, tankModel);
    const twin = session({ alertAt: 1 });
    twin.push(temperatures(0, 1400));
    await twin.end();
    const trends = twin.cycles.map((cycle) => cycle.trend);
    assert.deepEqual(trends.slice(0, 4).map((trend) => trend.direction), ['none', 'none', 'none', 'none'],
        'Under three jumps there is nothing to read; with three, the move before had not leaned yet.');
    assert.equal(trends[4].direction, 'below', 'Every jump is 2 K below the reading.');
    assert.equal(trends[4].mean, -2);
    assert.equal(trends[4].alarm, true, '2 K is past one tolerance.');

    const quiet = session({ alertAt: 3 });
    quiet.push(temperatures(0, 1400));
    await quiet.end();
    assert.equal(quiet.cycles[4].trend.direction, 'below');
    assert.equal(quiet.cycles[4].trend.alarm, false, '2 K is short of three tolerances.');

    const small = session({ tolerances: { T: 100 } });
    small.push(temperatures(0, 1400));
    await small.end();
    assert.equal(small.cycles[4].trend.direction, 'none', 'A lean under a fifth of the tolerance is not a drift.');
    await twin.close();
    await quiet.close();
    await small.close();
});

test('a model that runs away on a move is said', async (t) => {
    installFakeEngine(t, { derivatives: { 2: () => 1e6 } });
    const twin = session();
    twin.push(temperatures(0, 600));
    await twin.end();
    const [runaway] = twin.cycles[0].runaway;
    assert.equal(runaway.signal, 'T');
    assert.equal(runaway.reading, 26);
    assert.ok(runaway.value > 1e3 * 27);
    await twin.close();
});

test('keeping up, a backlog is skipped to the newest anchor, and data already there before the first move is passed over', async (t) => {
    const engines = installFakeEngine(t, tankModel);
    const twin = session({ keepUp: true, maxBehind: 3 });
    twin.push(temperatures(0, 3000));
    await twin.idle();
    assert.deepEqual(twin.cycles.map((cycle) => cycle.index), [11], 'Moves 0 to 10 were already history when the twin started.');
    assert.deepEqual(twin.cycles[0].restored, { time: 2200, values: [42, 27], providerStates: [] },
        'The move logs its own anchor\'s state, not the catch-up\'s from the start.');
    assert.equal(valueAt(twin.cycles[0].model.T, 2200), 42);
    twin.push(temperatures(3100, 4000));
    await twin.idle();
    assert.deepEqual(twin.cycles.map((cycle) => cycle.index), [11, 16]);
    const catchUp = engines[0].batches.at(-2).filter((command) => command.discardSamples);
    assert.deepEqual(catchUp.map((command) => command.time), [3200], 'The skipped stretch is run from the last move\'s state to the new anchor, without samples.');
    assert.equal(engines[0].batches.at(-2).find((command) => command.type === 'restoreState').time, 2200);
    const stats = twin.stats();
    assert.equal(stats.passedOver, 11);
    assert.equal(stats.skipped, 4);
    assert.equal(stats.lagSeconds, 200, 'The newest move the data has gone past ends at 3800 s.');
    await twin.close();
});

test('a dead engine is replaced and the moves go on exactly as if it had not died', async (t) => {
    const heater = [0, 300, 700, 1100].map((time) => reading('heater', time, time === 300 ? 0.01 : 0.002));
    const data = [...heater, ...temperatures(0, 1200, (time) => 20 + (time % 300) / 100)];
    installFakeEngine(t, tankModel);
    const steady = session();
    steady.push(data);
    await steady.end();

    const engines = installFakeEngine(t, tankModel);
    let runs = 0;
    engines.crash = () => ++runs === 4; // the second move's first batch
    const recovered = session();
    recovered.push(data);
    await recovered.end();
    assert.equal(engines.length, 2, 'A new engine was started.');
    assert.equal(recovered.stats().recoveries, 1);
    assert.deepEqual(recovered.cycles.map((cycle) => [cycle.restored, cycle.model, cycle.jumps]), steady.cycles.map((cycle) => [cycle.restored, cycle.model, cycle.jumps]));
    await steady.close();
    await recovered.close();
});

test('a failure that is not the engine dying stops the twin and is reported', async (t) => {
    const engines = installFakeEngine(t, tankModel);
    engines.crash = () => { throw new TypeError('something else broke'); };
    const failures = [];
    const twin = session({ onFailure: (error) => failures.push(error.message) });
    twin.push(temperatures(0, 700));
    await assert.rejects(twin.idle(), /something else broke/);
    assert.equal(twin.stats().recoveries, 0);
    // Said as soon as it happened, once, and no move is tried after it (each would fail the same way, unseen).
    assert.deepEqual(failures, ['something else broke']);
    twin.push(temperatures(800, 1500));
    await assert.rejects(twin.idle(), /something else broke/);
    assert.deepEqual(failures, ['something else broke']);
    assert.equal(twin.cycles.length, 0);
    await twin.close();
});

// The tank with a controller's output in the heater's unit (state 4), for an input handed to the model past now.
function tankWithController() {
    const document = tankDocument();
    document.nodes[0].states.push({ id: 4, name: 'Command', symbol: 'u', initialValue: 0, unit: 'K/s' });
    document.nodes.push({
        id: 5, name: 'Room', position: [1, 0, 0], appearance: { type: 'primitive', shape: 'box', color: '#34727a' },
        states: [{ id: 6, name: 'Supply', symbol: 's', initialValue: 0, unit: 'K/s' }],
        sourceTerms: [{
            id: 7, state: 's', expression: 'heater', setsValue: true,
            expressionModel: { latex: 'heater', output: { stateId: 6 }, mathJson: 'heater', bindings: [{ kind: 'parameter', parameterId: 20, symbol: 'heater' }] }
        }]
    });
    return document;
}

test('an input handed to the model follows only a state that could drive it, said in words', () => {
    const follow = (state) => session({ document: tankWithController(), inputForecasts: { heater: { choice: 'model', state } } });
    assert.throws(() => follow(2), /heater cannot follow Tank · Temperature past now: a signal measures it\./);
    assert.throws(() => follow(3), /heater cannot follow Tank · Wall past now: it is in K, and the input in K\/s\./);
    assert.throws(() => follow(6), /heater cannot follow Room · Supply past now: an input sets it\./);
    assert.throws(() => follow(99), /name one that is in it/);
    assert.doesNotThrow(() => follow(4));
});

test('an engine older than the twin is refused for an input handed to the model, in words, as soon as it starts', async (t) => {
    installFakeEngine(t, { derivatives: { ...tankModel.derivatives, 4: () => 0 } });
    const failures = [];
    const twin = session({ document: tankWithController(), inputForecasts: { heater: { choice: 'model', state: 4 } }, onFailure: (error) => failures.push(error.message) });
    twin.push([...temperatures(0, 700), reading('heater', 0, 0)]);
    await assert.rejects(twin.idle(), /older than the twin and cannot hand an input to the model past now \(heater\)/);
    assert.equal(failures.length, 1);
    await twin.close();
});

test('an engine that keeps dying is given one retry per move, then the failure is reported', async (t) => {
    const engines = installFakeEngine(t, tankModel);
    // Every engine dies at its first batch, however many are started.
    Object.defineProperty(engines, 'crash', { get: () => () => true, set: () => {} });
    const twin = session();
    twin.push(temperatures(0, 700));
    await assert.rejects(twin.idle(), EngineSessionError);
    assert.equal(twin.stats().recoveries, 1);
    assert.equal(engines.length, 2, 'One replacement, not one after another.');
    await twin.close();
});

test('a refit plan covers the latest window, starting each state where the move left it', async (t) => {
    installFakeEngine(t, tankModel);
    const document = tankDocument();
    document.nodes[0].states[1].tuning = { minimum: 0, maximum: 1 };
    const twin = session({ document });
    assert.throws(() => twin.refitPlan(), /no window to refit before the first move/);
    twin.push([reading('heater', 0, 0), ...temperatures(0, 1000)]);
    await twin.end();
    const plan = twin.refitPlan();
    const last = twin.cycles.at(-1);
    assert.equal(plan.anchor, last.anchor);
    assert.equal(plan.now, last.now);
    assert.equal(plan.cycle, last.index);
    assert.deepEqual(plan.tunable, [{ kind: 'parameter', id: 10 }, { kind: 'state', id: 3 }]);
    const wall = plan.document.nodes[0].states[1];
    assert.equal(wall.initialValue, last.restored.values[1]);
    assert.deepEqual(wall.tuning, { minimum: 0, maximum: last.restored.values[1] }, 'Its bounds widened to take in where it starts.');

    const fixed = tankDocument();
    delete fixed.edges[0].parameters[0].tuning;
    const nothing = session({ document: fixed });
    nothing.push([reading('heater', 0, 0), ...temperatures(0, 600)]);
    await nothing.end();
    assert.throws(() => nothing.refitPlan(), /as tunable \(with bounds\) first/);
    await twin.close();
    await nothing.close();
});

test('a refit restarts the twin with what it found, and one it cannot take leaves the twin as it was', async (t) => {
    const engines = installFakeEngine(t, tankModel);
    const twin = session();
    twin.push(temperatures(0, 800, () => 20));
    await twin.end();
    const last = twin.cycles.at(-1);
    await assert.rejects(twin.applyRefit({ values: [{ parameterId: 99, value: 1 }], cycle: last.index }), /Parameter 99 is not in the twin/);
    await assert.rejects(twin.applyRefit({ values: [{ parameterId: 10, value: NaN }], cycle: last.index }), /no finite value/);
    await assert.rejects(twin.applyRefit({ values: [{ parameterId: 10, value: 0.01 }], cycle: 42 }), /not one this twin made/);
    assert.equal(twin.document.edges[0].parameters[0].value, 0);

    const started = engines.length;
    const { takesEffect } = await twin.applyRefit({ values: [{ parameterId: 10, value: 0.01 }, { parameterId: 3, value: 7 }], cycle: last.index });
    assert.equal(takesEffect, last.now);
    assert.equal(engines.length, started + 1, 'A new engine, with the new values.');
    assert.equal(twin.document.edges[0].parameters[0].value, 0.01);
    const restart = engines.at(-1).batches[0].find((command) => command.type === 'restoreState');
    assert.deepEqual(restart.values, [last.restored.values[0], 7], 'From that move\'s anchor, with the state the refit found.');
    twin.push(temperatures(900, 1000, () => 20));
    await twin.end();
    const next = twin.cycles.at(-1);
    assert.deepEqual(next.refit, { fromCycle: last.index, anchor: last.anchor, states: { 3: 7 } });
    assert.equal(valueAt(next.model.T, next.anchor + 100), 19, 'The new heat loss takes 1 K every 100 s.');
    await twin.close();
});

test('a changed model carries each state across by its id, and one that drops a mapped signal\'s target is refused', async (t) => {
    installFakeEngine(t, tankModel);
    const twin = session();
    await assert.rejects(twin.applyModel(tankDocument()), /no move to apply a change from yet/);
    twin.push([reading('heater', 0, 0), ...temperatures(0, 800)]);
    await twin.end();

    const withoutTank = tankDocument();
    withoutTank.nodes[0].states = withoutTank.nodes[0].states.filter((state) => state.id !== 2);
    await assert.rejects(twin.applyModel(withoutTank), /T is compared with a state the change removes/);
    const withoutHeater = tankDocument();
    withoutHeater.sharedParameters = [];
    await assert.rejects(twin.applyModel(withoutHeater), /heater drives a shared parameter the change removes/);

    const grown = tankDocument();
    grown.nodes[0].states.push({ id: 4, name: 'Lid', symbol: 'l', initialValue: 3, unit: 'K' });
    const outcome = await twin.applyModel(grown);
    assert.deepEqual(outcome, { carried: [2, 3], added: [4], removed: [], takesEffect: twin.cycles.at(-1).now });
    assert.deepEqual(twin.inferredStateIds, [3, 4]);
    await twin.close();
});

test('a fresh run reproduces a move from its logged state, with the inputs as hold schedules', async (t) => {
    installFakeEngine(t, tankModel);
    const twin = session();
    twin.push([reading('heater', 0, 0), reading('heater', 300, 0.01), ...temperatures(0, 600)]);
    await twin.end();
    const [cycle] = twin.cycles;
    const { document, configuration } = twin.freshRunFor(cycle);
    assert.deepEqual(document.sharedParameters[0].schedule, { interpolation: 'hold', samples: [[0, 0], [300, 0.01]] });
    assert.equal(configuration.targetTime, 1000);
    assert.deepEqual(configuration.startCheckpoint, { time: 0, states: [{ stateId: 2, value: 20 }, { stateId: 3, value: 5 }], providerStates: [] });
    await twin.close();
});

test('a sandbox starts from the live state at now and keeps what is tried there to itself', async (t) => {
    const engines = installFakeEngine(t, tankModel);
    const twin = session();
    await assert.rejects(twin.detach(), /nothing to detach from before the first cycle/);
    twin.push([reading('heater', 0, 0), ...temperatures(0, 600, () => 20)]);
    await twin.end();
    const sandbox = await twin.detach();
    assert.equal(engines.length, 2, 'An engine of its own.');
    assert.equal(sandbox.time, 600);
    assert.deepEqual(sandbox.startInputs, { heater: 0 });
    await assert.rejects(sandbox.setInput('nope', 1), /not an input of this twin/);
    await sandbox.setInput('heater', 0.02);
    assert.deepEqual(sandbox.tried, [{ time: 600, signal: 'heater', value: 0.02 }]);
    const series = await sandbox.runFor(400);
    assert.deepEqual(series.T.map((sample) => [sample.time, sample.value]), [[700, 22], [800, 24], [900, 26], [1000, 28]]);
    assert.equal(engines[0].batches.flat().filter((command) => command.type === 'appendInputSamples' && command.samples.some((sample) => sample.value === 0.02)).length, 0,
        'The live engine never sees it.');

    const drawn = Sandbox.drawnPoints;
    t.after(() => { Sandbox.drawnPoints = drawn; });
    Sandbox.drawnPoints = 2;
    const thinned = await sandbox.runFor(400);
    assert.equal(engines[1].batches.at(-1)[0].keepEvery, 2, 'Only about drawnPoints of a long run are kept.');
    assert.equal(thinned.T.at(-1).time, 1400, 'Always with the last.');
    await sandbox.close();
    await twin.close();
});

test('the estimator moves the state toward its readings and reports its spread and band', async (t) => {
    installFakeEngine(t, tankModel);
    const twin = session({ corrections: { T: { estimate: true, noise: 0.1 } }, estimator: { seed: 3 } });
    twin.push(temperatures(0, 800));
    await twin.end();
    const [first, second] = twin.cycles;
    assert.equal(first.estimate.members, 32);
    assert.deepEqual(first.estimate.noise, { T: 0.1 });
    assert.deepEqual(first.estimate.states.map((state) => state.stateId), [2, 3]);
    assert.ok(first.estimate.band.T.every((point) => point.low <= point.high));
    assert.deepEqual(second.corrections.T.readings, 2, 'Both readings since the last anchor.');
    const estimated = second.corrections.T.applied;
    assert.ok(estimated > 20.5 && estimated < 22, `The analysis moves from the prediction of 20 K toward the readings of 21 and 22 K, not past them (got ${estimated}).`);
    await twin.close();
});

test('stats report the moves made, and a closed twin takes no more readings', async (t) => {
    const engines = installFakeEngine(t, tankModel);
    const twin = session();
    assert.equal(twin.stats().lagSeconds, null);
    twin.push(temperatures(0, 900));
    await twin.idle();
    const stats = twin.stats();
    assert.equal(stats.cycles, 2);
    assert.equal(stats.lagSeconds, 100, 'The latest reading is 100 s past the last move\'s now.');
    assert.equal(stats.recoveries, 0);
    await twin.close();
    assert.ok(engines[0].closed);
    assert.throws(() => twin.push(temperatures(1000, 1000)), /The session is closed/);
});
