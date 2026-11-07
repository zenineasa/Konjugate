/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A live twin fed by Konjugate's push service (src/pushService.mjs and src/pushSource.mjs through src/liveTwinHost.mjs): the service
// runs in this process, and the simulated rig's six hours are pushed to it as a lab's own script would push them, in batches, in
// turn over HTTP with JSON, a WebSocket with protobuf and a gRPC stream. Checked: the twin makes every move; what it received is
// recorded as a data log that reads back; its moves are the same, to the bit, as a twin fed the rig's own log; and readings for a
// signal no twin follows are counted, not kept.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/liveTwinPush.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';
import WebSocket from 'ws';
import { readDataLog } from '../../src/dataLog.mjs';
import { guessReplayMapping, replayTargets } from '../../src/dataLogReplay.mjs';
import { LiveTwin } from '../../src/liveTwinHost.mjs';
import { pushProtoPath } from '../../src/pushCodecs.mjs';
import { PushKeyStore } from '../../src/pushKeyStore.mjs';
import { PushService } from '../../src/pushService.mjs';
import { PushHub } from '../../src/pushSource.mjs';
import { WindowSession } from '../../src/windowSession.mjs';
import { tankRigProject } from '../../scripts/generateTankRigModel.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };
const python = (process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']).find((candidate) => spawnSync(candidate, ['--version']).status === 0);
if (!python) {
    console.log('Live twin from the push service skipped: no Python on this computer to run the simulated rig.');
    process.exit(0);
}

const PushReadings = protobuf.loadSync(pushProtoPath).lookupType('konjugate.push.v1.PushReadings');
const ReadingPush = grpc.loadPackageDefinition(protoLoader.loadSync(pushProtoPath, { keepCase: true, longs: Number, enums: String, defaults: false })).konjugate.push.v1.ReadingPush;

const directory = await mkdtemp(join(tmpdir(), 'konjugatePushTwin-'));
const hub = new PushHub();
const store = new PushKeyStore(directory);
const { key } = await store.add('simulated rig', ['heaterPower', 'tankTemperature', 'stirrerSpeed']);
const service = new PushService({ keyStore: store, deliver: (readings) => hub.publish(readings) });
const { port, grpcPort } = await service.start({ port: 0, grpcPort: 0 });
const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, { headers: { authorization: `Bearer ${key}` } });
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
const grpcClient = new ReadingPush(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure());
const metadata = new grpc.Metadata();
metadata.set('authorization', `Bearer ${key}`);
const call = grpcClient.Push(metadata);
try {
    const logPath = join(directory, 'rig.csv');
    const rig = spawnSync(python, [join(root, 'examples', 'dataSources', 'simulatedTankRig.py'), logPath, '--speed', '1e9', '--start', '2026-11-06T09:00:00Z'], { encoding: 'utf8' });
    assert.equal(rig.status, 0, rig.stderr);
    const log = readDataLog(await readFile(logPath, 'utf8'));
    const epochSeconds = log.header.epoch / 1000;
    const reading = (observation) => ({ signal: observation.signal, value: observation.value, time: epochSeconds + observation.time, quality: observation.quality });

    // Three ways a script can push, each waiting for its answer before the next batch, as a careful script does.
    const ways = [
        async (batch) => {
            const response = await fetch(`http://127.0.0.1:${port}/v1/readings`, {
                method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ readings: batch })
            });
            return (await response.json()).status;
        },
        async (batch) => {
            const message = { readings: batch.map(({ time, quality, ...rest }) => ({ ...rest, time: { seconds: Math.floor(time), nanos: Math.round((time - Math.floor(time)) * 1e9) }, quality: quality.toUpperCase() })) };
            socket.send(PushReadings.encode(PushReadings.fromObject(message)).finish(), { binary: true });
            const [data] = await new Promise((resolve) => socket.once('message', (...args) => resolve(args)));
            return protobuf.loadSync(pushProtoPath).lookupType('konjugate.push.v1.PushAnswer').decode(data).status;
        },
        async (batch) => {
            const answered = new Promise((resolve) => call.once('data', (answer) => resolve(answer.status)));
            call.write({ readings: batch.map(({ time, quality, ...rest }) => ({ ...rest, time: { seconds: Math.floor(time), nanos: Math.round((time - Math.floor(time)) * 1e9) }, quality: quality.toUpperCase() })) });
            return answered;
        }
    ];

    const document = tankRigProject();
    const signals = log.header.signals.map((signal) => ({ signal: signal.name, name: signal.name, role: signal.role, unit: signal.unit }));
    const mapping = guessReplayMapping({ signals: log.header.signals }, replayTargets(document));
    const settings = { document, mapping, window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances: { tankTemperature: 0.5 }, keepUp: false };
    const recordTo = join(directory, 'recording.csv');
    const events = [];
    const twin = new LiveTwin(settings, { kind: 'push', hub, signals, recordTo }, engineOptions, (event) => events.push(event));

    // A signal the key may send but no twin follows: taken, and counted as unclaimed.
    assert.equal(await ways[0]([{ signal: 'stirrerSpeed', value: 120, time: epochSeconds, quality: 'good' }]), 202);
    const batchSize = 40;
    for (let start = 0, turn = 0; start < log.observations.length; start += batchSize, turn += 1) {
        const status = await ways[turn % ways.length](log.observations.slice(start, start + batchSize).map(reading));
        assert.equal(status, 202);
    }
    const lastTime = Math.max(...log.observations.map((observation) => observation.time)) - log.observations[0].time;
    for (let waited = 0; waited < 60000 && twin.session.latestTime < lastTime; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    await twin.session.end();
    const liveCycles = twin.session.cycles;
    await twin.stop();
    assert.equal(events.filter((event) => event.type === 'cycle').length, 31, 'Every move was made from the pushed readings.');
    assert.equal(events.at(-1).type, 'ended');
    assert.equal(events.at(-1).recordedTo, recordTo);
    assert.equal(hub.unclaimed, 1, 'The reading no twin followed was counted.');
    assert.equal(hub.followers, 0, 'A stopped twin no longer follows the hub.');

    const recorded = readDataLog(await readFile(recordTo, 'utf8'));
    assert.equal(recorded.header.source, 'Konjugate push service');
    assert.equal(recorded.observations.length, log.observations.length);
    assert.equal(recorded.observations.filter((observation) => observation.quality === 'bad').length, 1, 'The bad reading is recorded as bad.');

    const direct = new WindowSession({ ...settings, header: log.header, engineOptions });
    direct.push(log.observations);
    await direct.end();
    const outcome = (cycles) => cycles.map(({ anchor, now, jumps, window, forecast, restored }) => JSON.stringify({ anchor, now, jumps, window, forecast, restored }));
    assert.deepEqual(outcome(liveCycles), outcome(direct.cycles), 'Pushed or from the file, the moves are the same.');
    await direct.close();
    console.log(`Live twin from the push service: ${liveCycles.length} moves from readings pushed over HTTP, a WebSocket and gRPC, the same as from the file, and ${recorded.observations.length} readings recorded.`);
} finally {
    // The stream is ended by the script, and its status heard, before the service stops.
    await new Promise((resolve) => { call.once('status', resolve); call.once('error', resolve); call.end(); });
    socket.close();
    grpcClient.close();
    await service.stop();
    await rm(directory, { recursive: true, force: true });
}
