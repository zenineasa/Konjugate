/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The OPC UA source (src/opcuaSource.mjs) checked thoroughly against a real server (tests/fixtures/opcuaRigServer.mjs), by
// simulating what a PLC sends. A subscription reports what the server samples, at the interval it grants (50 ms here, often 100 to
// 1000 ms on a PLC), so the simulated PLC changes its tags at that pace, as a PLC's scan does; for each condition every reading it
// gives the server after the subscription began must arrive exactly once, with its own time, value and quality, and every batch handed
// on must keep time order. The conditions: a steady feed of tags changing at the same instants, a value repeated, qualities and
// types, readings out of time order, many tags, an encrypted connection, the server restarting, a loaded machine, stopping, and
// changes faster than the server samples, which no client can see: what is granted is reported, and arrivals are never faster.
//
// Run manually (it needs no engine; scripts/testEngine.mjs runs it with the other long checks):
//   node tests/engine/opcuaSource.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { readDataLog } from '../../src/dataLog.mjs';
import { DataLogWriter } from '../../src/dataLogWriter.mjs';
import { followOpcUa } from '../../src/opcuaSource.mjs';
import { startRigServer } from '../fixtures/opcuaRigServer.mjs';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitUntil(condition, what, timeout = 20000) {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}.`);
        await pause(20);
    }
}

let directory;
before(async () => { directory = await mkdtemp(join(tmpdir(), 'konjugateOpcUaSource-')); });
after(async () => { await rm(directory, { recursive: true, force: true }); });

// A server for one scenario, and the followers it starts, all stopped at the end whether it passed or not.
async function scenario(serverOptions, body) {
    const followers = [];
    let server = await startRigServer({ pkiFolder: join(directory, 'serverPki'), ...serverOptions });
    const context = {
        get server() { return server; },
        async restart() {
            const port = server.port;
            await server.shutdown();
            await pause(500);
            server = await startRigServer({ pkiFolder: join(directory, 'serverPki'), ...serverOptions, port });
        },
        // Follows tags by their names; every batch is kept as handed on. Resolves once each tag's starting value has arrived, with
        // the interval the server granted for sampling it.
        async follow(names, options = {}) {
            const batches = [];
            const errors = [];
            const follower = followOpcUa(server.url, {
                signals: names.map((name) => ({ nodeId: server.nodeId(name), name, role: 'output' })),
                pkiFolder: join(directory, 'clientPki'), trustServer: true, batchMilliseconds: 10,
                onObservations: (batch) => batches.push(batch), onError: (error) => errors.push(error), ...options
            });
            followers.push(follower);
            await follower.ready;
            const sampling = await Promise.race([follower.sampling, pause(10000).then(() => { throw new Error('The server did not answer for every tag.'); })]);
            const numeric = names.filter((name) => name !== 'OperatorNote');
            await waitUntil(() => new Set(batches.flat().map((reading) => reading.signal)).size >= numeric.length, 'the starting values');
            const epochSeconds = follower.header.epoch / 1000;
            return {
                follower, batches, errors, sampling,
                // The slowest granted interval, and the pace a PLC reporting through it is simulated at.
                pace: Math.max(...Object.values(sampling)) + 15,
                // What arrived of the readings measured from `from` on, each with its time in milliseconds since 1970 again.
                since: (from) => batches.flat().filter((reading) => epochSeconds + reading.time >= from.getTime() / 1000 - 1e-9)
                    .map((reading) => ({ ...reading, at: Math.round((epochSeconds + reading.time) * 1000) }))
            };
        }
    };
    try {
        await body(context);
    } finally {
        for (const follower of followers) await follower.stop().catch(() => {});
        await server.shutdown().catch(() => {});
    }
}

function assertInTimeOrder(batches, what) {
    const times = batches.flat().map((reading) => reading.time);
    const backwards = times.findIndex((time, index) => index > 0 && time < times[index - 1]);
    assert.equal(backwards, -1, `${what}: a reading went back in time at position ${backwards}.`);
}

function sameReadings(arrived, published) {
    const key = (reading) => `${reading.signal}@${reading.at}=${reading.value}/${reading.quality}`;
    const got = arrived.map(key).sort();
    const want = published.map(key).sort();
    const missing = want.filter((entry) => !got.includes(entry));
    assert.equal(got.length, want.length, `${got.length} arrived of ${want.length} published${missing.length ? `; missing ${missing.slice(0, 3).join(', ')}` : ''}.`);
    assert.deepEqual(got, want);
    assert.equal(new Set(got).size, got.length, 'None arrived twice.');
}

// The PLC's own clock for a step: a minute a step from `base`, as the tests' rig reports it.
const stamp = (base, step) => new Date(base.getTime() + step * 60000);
const futureBase = () => new Date(Math.ceil(Date.now() / 1000) * 1000 + 3600000);

// Gives the server each step's readings (several tags at one instant together), at the PLC's pace; answers what was published.
async function publish(server, steps, pace, reading) {
    const base = futureBase();
    const published = [];
    for (let step = 0; step < steps; step += 1) {
        for (const { name, value, quality = 'good', expected = value } of reading(step)) {
            server.set(name, value, stamp(base, step), quality);
            published.push({ signal: name, at: stamp(base, step).getTime(), value: expected, quality });
        }
        await pause(pace);
    }
    return { base, published };
}

describe('the OPC UA source against a server, as a PLC sends', () => {
    test('a steady feed of two tags changing at the same instants: every reading once, exactly timed, in time order', () => scenario({}, async ({ server, follow }) => {
        const watch = await follow(['TankTemperature', 'HeaterPower']);
        assert.ok(Object.values(watch.sampling).every((interval) => interval > 0), `The server says how often it samples: ${JSON.stringify(watch.sampling)}.`);
        const { base, published } = await publish(server, 120, watch.pace, (step) => [
            { name: 'TankTemperature', value: 293 + step / 10 }, { name: 'HeaterPower', value: step % 2 ? 1000 : 0 }
        ]);
        await waitUntil(() => watch.since(base).length >= published.length, 'every reading');
        await pause(150);
        sameReadings(watch.since(base), published);
        assertInTimeOrder(watch.batches, 'steady feed');
    }));

    test('a value repeated with new times is a reading each time; good, uncertain and bad; a true/false tag as 1 and 0; a text tag left out', () => scenario({}, async ({ server, follow }) => {
        const watch = await follow(['TankTemperature', 'HeaterOn', 'OperatorNote']);
        const qualities = ['good', 'good', 'uncertain', 'bad', 'bad', 'good'];
        const { base, published } = await publish(server, 30, watch.pace, (step) => [
            { name: 'TankTemperature', value: 300, quality: qualities[step % qualities.length] },
            { name: 'HeaterOn', value: step % 3 === 0, expected: step % 3 === 0 ? 1 : 0 }
        ]);
        for (let step = 0; step < 5; step += 1) {
            server.set('OperatorNote', `step ${step}`, stamp(base, 100 + step));
            await pause(watch.pace);
        }
        await waitUntil(() => watch.since(base).length >= published.length, 'the repeated values');
        await pause(150);
        sameReadings(watch.since(base), published);
        assert.equal(watch.batches.flat().filter((reading) => reading.signal === 'OperatorNote').length, 0, 'A text tag is not a number, so not a reading.');
    }));

    test('readings out of time order (a PLC sending what it buffered): each handed on, and a recording counts those it cannot write', () => scenario({}, async ({ server, follow }) => {
        const watch = await follow(['TankTemperature']);
        const base = futureBase();
        const order = [0, 1, 2, 5, 6, 3, 4, 7];
        for (const step of order) {
            server.set('TankTemperature', step, stamp(base, step));
            await pause(watch.pace);
        }
        await waitUntil(() => watch.since(base).length >= order.length, 'the readings out of order');
        assert.deepEqual(watch.since(base).map((reading) => reading.value), order, 'Every reading arrives, in the order the PLC sent it.');
        const writer = await DataLogWriter.create(join(directory, 'late.csv'), { epoch: watch.follower.header.epoch, signals: [{ name: 'TankTemperature', role: 'output', unit: 'K' }] });
        for (const batch of watch.batches) await writer.append(batch);
        await writer.close();
        assert.equal(writer.late, 2, 'The two that came after a later one cannot go in a log whose rows only go forward, and are counted.');
        const recorded = readDataLog(await readFile(join(directory, 'late.csv'), 'utf8'));
        assert.equal(recorded.observations.length, watch.batches.flat().length - 2);
    }));

    test('forty tags at once', () => scenario({ extraTags: 40 }, async ({ server, follow }) => {
        const names = Array.from({ length: 40 }, (_, index) => `Tag${index}`);
        const watch = await follow(names);
        const { base, published } = await publish(server, 20, watch.pace, (step) => names.map((name, index) => ({ name, value: step * 100 + index })));
        await waitUntil(() => watch.since(base).length >= published.length, 'every tag\'s readings');
        sameReadings(watch.since(base), published);
        assertInTimeOrder(watch.batches, 'forty tags');
    }));

    test('signed and encrypted: the same readings', () => scenario({}, async ({ server, follow }) => {
        const watch = await follow(['TankTemperature', 'HeaterPower'], { security: 'signAndEncrypt' });
        const { base, published } = await publish(server, 60, watch.pace, (step) => [{ name: 'TankTemperature', value: step }, { name: 'HeaterPower', value: step * 10 }]);
        await waitUntil(() => watch.since(base).length >= published.length, 'the encrypted readings');
        sameReadings(watch.since(base), published);
    }));

    test('the server restarting (a PLC rebooting): the client reconnects by itself, and from its first reading after, every one arrives', () => scenario({}, async (context) => {
        const watch = await context.follow(['TankTemperature']);
        const first = await publish(context.server, 20, watch.pace, (step) => [{ name: 'TankTemperature', value: step }]);
        await waitUntil(() => watch.since(first.base).length >= first.published.length, 'the readings before the restart');
        sameReadings(watch.since(first.base), first.published);

        await context.restart();
        // After the restart the PLC reports at its pace until enough have come through the reconnected client.
        const restartBase = stamp(futureBase(), 2000);
        const afterRestart = [];
        let step = 0;
        const reporting = setInterval(() => {
            context.server.set('TankTemperature', 1000 + step, stamp(restartBase, step));
            afterRestart.push({ signal: 'TankTemperature', at: stamp(restartBase, step).getTime(), value: 1000 + step, quality: 'good' });
            step += 1;
        }, watch.pace);
        try {
            await waitUntil(() => watch.since(restartBase).length >= 15, 'readings through the reconnected client', 30000);
        } finally {
            clearInterval(reporting);
        }
        await pause(300);
        const arrived = watch.since(restartBase);
        const from = afterRestart.findIndex((reading) => reading.at === arrived[0].at);
        sameReadings(arrived, afterRestart.slice(from));
        assertInTimeOrder(watch.batches, 'across the restart');
        assert.deepEqual(watch.errors, [], 'A restart is not an error for the twin.');
    }));

    test('on a loaded machine (every core busy in other processes): every reading once, in order', async () => {
        const busy = Array.from({ length: cpus().length + 2 }, () => spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
        try {
            await scenario({}, async ({ server, follow }) => {
                const watch = await follow(['TankTemperature', 'HeaterPower']);
                const { base, published } = await publish(server, 100, watch.pace, (step) => [{ name: 'TankTemperature', value: step }, { name: 'HeaterPower', value: step % 5 }]);
                await waitUntil(() => watch.since(base).length >= published.length, 'every reading under load', 40000);
                await pause(150);
                sameReadings(watch.since(base), published);
                assertInTimeOrder(watch.batches, 'under load');
            });
        } finally {
            for (const child of busy) child.kill('SIGKILL');
        }
    });

    test('stopping hands on what was waiting for its batch, and nothing after', () => scenario({}, async ({ server, follow }) => {
        const watch = await follow(['TankTemperature'], { batchMilliseconds: 2000 });
        const { base, published } = await publish(server, 5, 70, (step) => [{ name: 'TankTemperature', value: step }]);
        await pause(200);
        assert.equal(watch.since(base).length, 0, 'Still waiting for the batch.');
        await watch.follower.stop();
        sameReadings(watch.since(base), published);
        const handedOn = watch.batches.length;
        server.set('TankTemperature', 99, stamp(base, 99));
        await pause(300);
        assert.equal(watch.batches.length, handedOn, 'Nothing is handed on after stopping.');
    }));

    test('changes faster than the server samples: no client sees them all; the first and the last always arrive, never faster than granted', () => scenario({}, async ({ server, follow }) => {
        const watch = await follow(['TankTemperature']);
        const interval = watch.sampling.TankTemperature;
        const base = futureBase();
        const started = Date.now();
        for (let step = 0; step < 40; step += 1) {
            server.set('TankTemperature', step, stamp(base, step));
            await pause(interval / 5);
        }
        const took = Date.now() - started;
        await pause(interval * 4);
        const arrived = watch.since(base).map((reading) => reading.value);
        assert.equal(arrived[0], 0, 'The first change is seen.');
        assert.equal(arrived.at(-1), 39, 'The last change is seen.');
        assert.ok(arrived.length <= Math.ceil(took / interval) + 2, `No more arrive than samples were taken: ${arrived.length} in ${took} ms at ${interval} ms.`);
        assert.ok(arrived.length < 40, 'Some were never seen, as with any OPC UA client.');
        assert.deepEqual([...arrived].sort((a, b) => a - b), arrived, 'Those seen keep their order.');
    }));
});
