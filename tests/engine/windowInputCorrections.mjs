/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Input readings that change after the twin sent them to the engine (a logger's correction row, a reading marked bad, one that arrived
// late), through the real engine: a twin given the corrections late makes the moves after them exactly as a twin given the corrected
// readings from the start does, whether the correction falls inside the next move's run (sent again, replacing what the engine held)
// or before the checkpoint it starts at (the twin run again from the state it logged before the correction). And after skipping a
// backlog, the catch-up runs on the inputs that were applied. The logic is unit tested against a fake engine in
// tests/windowSession.test.mjs; this checks the engine takes the commands as that fake does.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/windowInputCorrections.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { WindowSession } from '../../src/windowSession.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

// A tank and its wall, both warmed by a heater (an input, K/s); only the tank is measured, so the wall is where an input the engine
// got wrong still shows after the tank is reset to its reading.
const heatedTerm = (id, stateId, symbol) => ({
    id, state: symbol, expression: 'heater',
    parameters: [{ id: id + 1, name: 'Heater', symbol: 'heater', value: 0, unit: 'K/s', mode: 'constant', sharedParameterId: 20 }],
    expressionModel: { latex: '\\mathrm{heater}', output: { stateId }, mathJson: 'heater', bindings: [{ kind: 'parameter', parameterId: id + 1, symbol: 'heater' }] }
});
const document = {
    format: 'konjugate', version: 1,
    runConfigurations: [{ id: 30, name: 'Run', globalTimeStep: 100, outputInterval: 100 }], activeRunConfigurationId: 30,
    sharedParameters: [{ id: 20, name: 'Heater', symbol: 'heater', value: 0, unit: 'K/s', mode: 'constant' }],
    nodes: [{
        id: 1, name: 'Tank', position: [0, 0, 0], appearance: { type: 'primitive', shape: 'box', color: '#34727a' },
        states: [{ id: 2, name: 'Temperature', symbol: 'temperature', initialValue: 20, unit: 'K' }, { id: 3, name: 'Wall', symbol: 'w', initialValue: 5, unit: 'K' }],
        sourceTerms: [heatedTerm(4, 2, 'temperature'), heatedTerm(6, 3, 'w')]
    }],
    edges: []
};
const header = { signals: [{ name: 'heater', role: 'input', unit: 'K/s' }, { name: 'T', role: 'output', unit: 'K' }] };
const mapping = [{ signal: 'heater', role: 'input', unit: 'K/s', parameterId: 20 }, { signal: 'T', role: 'output', unit: 'K', stateId: 2 }];
const reading = (signal, time, value, extra = {}) => ({ signal, time, value, quality: 'good', revision: 0, ...extra });
const steady = (from, to, heater = () => 0) => {
    const list = [];
    for (let time = from; time <= to + 1e-9; time += 100) list.push(reading('heater', time, heater(time)), reading('T', time, 20));
    return list;
};

// Two twins fed the same batches, one with a reading corrected from the start and one sent the correction with batch `at`.
async function compare({ batches, correction, at, keepUp = false }) {
    const run = async (late) => {
        const twin = new WindowSession({ document, header, mapping, window: 600, stride: 200, horizon: 400, timeStep: 100, tolerances: { T: 1 }, engineOptions, keepUp });
        for (const [position, batch] of batches.entries()) {
            const readings = batch.map((entry) => (!late && entry.signal === correction.signal && entry.time === correction.time ? { ...entry, value: correction.value } : entry));
            twin.push(late && position === at ? [...readings, reading(correction.signal, correction.time, correction.value, { revision: 1 })] : readings);
            await twin.idle();
        }
        await twin.close();
        return twin.cycles;
    };
    return { late: await run(true), reference: await run(false) };
}
const close = (actual, expected, message) => {
    const flat = (cycle) => [...cycle.restored.values, ...cycle.model.T.map((sample) => sample.value), ...cycle.inferred[3].map((sample) => sample.value)];
    const [a, b] = [flat(actual), flat(expected)];
    assert.equal(a.length, b.length, message);
    a.forEach((value, index) => assert.ok(Math.abs(value - b[index]) < 1e-9, `${message}: ${value} against ${b[index]}`));
};

// Inside the next move's run: sent again.
{
    const { late, reference } = await compare({ batches: [steady(0, 700), steady(800, 900)], correction: { signal: 'heater', time: 500, value: 0.01 }, at: 1 });
    assert.deepEqual(late[1].inputCorrections, [{ signal: 'heater', time: 500, applied: 'resent' }]);
    close(late[1], reference[1], 'A correction inside the move\'s run is as if it had come in time');
}

// Before the checkpoint the next move starts at: run again from move 0's logged state, through move 1's reset.
{
    const { late, reference } = await compare({ batches: [steady(0, 900), steady(1000, 1100)], correction: { signal: 'heater', time: 100, value: 0.01 }, at: 1 });
    assert.deepEqual(late[2].inputCorrections, [{ signal: 'heater', time: 100, applied: 'rebuilt', from: 0 }]);
    assert.equal(late[2].inferred[3][0].value, 6, 'The wall carries the heater\'s 100 s.');
    close(late[2], reference[2], 'A correction before the checkpoint is as if it had come in time');
}

// After skipping a backlog, the catch-up from the last move's anchor runs on the readings the engine had let go of.
{
    const twin = new WindowSession({ document, header, mapping, window: 600, stride: 200, horizon: 400, timeStep: 100, tolerances: { T: 1 }, engineOptions, keepUp: true });
    twin.push(steady(0, 3000, (time) => (time === 2200 ? 0.01 : 0)));
    await twin.idle();
    twin.push(steady(3100, 4000));
    await twin.idle();
    await twin.close();
    const [first, skipped] = twin.cycles;
    assert.deepEqual([first.index, skipped.index], [11, 16]);
    assert.ok(Math.abs(skipped.restored.values[1] - first.restored.values[1] - 1) < 1e-9, `The wall warmed 1 K between the anchors (got ${skipped.restored.values[1] - first.restored.values[1]}).`);
}

console.log('Window input corrections: a correction inside the next run sent again, one before its checkpoint run again from the logged state, both as if they had come in time; a catch-up after skipping runs on the inputs that were applied.');
