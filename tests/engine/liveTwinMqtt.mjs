/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A live twin fed by an MQTT broker (src/mqttSource.mjs through src/liveTwinHost.mjs): a broker runs in this process, the simulated
// rig's six hours are published to it as a lab's gateway would publish them (one topic per signal, JSON with the reading's own
// time), and a live twin follows the topics. Checked: listening to the broker finds the topics; the twin makes every move; what it
// received is recorded as a data log that reads back; and its moves are the same, to the bit, as a twin fed the rig's own log.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/liveTwinMqtt.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { readDataLog } from '../../src/dataLog.mjs';
import { guessReplayMapping, replayTargets } from '../../src/dataLogReplay.mjs';
import { LiveTwin } from '../../src/liveTwinHost.mjs';
import { listenToBroker } from '../../src/mqttSource.mjs';
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
    console.log('Live twin over MQTT skipped: no Python on this computer to run the simulated rig.');
    process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), 'konjugateMqtt-'));
const broker = await Aedes.createBroker();
const server = createServer(broker.handle);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `mqtt://127.0.0.1:${server.address().port}`;
const publisher = await mqtt.connectAsync(url);
try {
    const logPath = join(directory, 'rig.csv');
    const rig = spawnSync(python, [join(root, 'examples', 'dataSources', 'simulatedTankRig.py'), logPath, '--speed', '1e9', '--start', '2026-11-06T09:00:00Z'], { encoding: 'utf8' });
    assert.equal(rig.status, 0, rig.stderr);
    const log = readDataLog(await readFile(logPath, 'utf8'));
    const epochSeconds = log.header.epoch / 1000;
    const topics = { heaterPower: 'lab/rig2/heater/power', tankTemperature: 'lab/rig2/tank/temperature' };
    const publish = (observation) => publisher.publishAsync(topics[observation.signal], JSON.stringify({
        value: observation.value, time: epochSeconds + observation.time, ...(observation.quality !== 'good' ? { quality: observation.quality } : {})
    }));

    // Listening: what the broker sends in a moment, while the gateway sends a reading of each.
    const listening = listenToBroker(url, { seconds: 0.5, filter: 'lab/#' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const observation of log.observations.slice(0, 2)) await publish(observation);
    const heard = await listening;
    assert.deepEqual(heard.map((topic) => [topic.topic, topic.numeric]), [[topics.heaterPower, true], [topics.tankTemperature, true]]);

    // The live twin, following the two topics and recording them.
    const document = tankRigProject();
    const signals = log.header.signals.map((signal) => ({ topic: topics[signal.name], name: signal.name, role: signal.role, unit: signal.unit }));
    const mapping = guessReplayMapping({ signals: log.header.signals }, replayTargets(document));
    // Every move, however fast the readings come, so the moves can be compared with the file's.
    const settings = { document, mapping, window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances: { tankTemperature: 0.5 }, keepUp: false };
    const recordTo = join(directory, 'recording.csv');
    const events = [];
    const twin = new LiveTwin(settings, { kind: 'mqtt', url, signals, recordTo }, engineOptions, (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 200)); // subscribed
    // The gateway sends what the rig logged, in the order it was logged.
    for (const observation of log.observations) await publish(observation);
    // Every reading in (a broker or a server never says it has finished), then the data is complete.
    const lastTime = Math.max(...log.observations.map((observation) => observation.time)) - log.observations[0].time;
    for (let waited = 0; waited < 60000 && twin.session.latestTime < lastTime; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    await twin.session.end();
    const liveCycles = twin.session.cycles;
    await twin.stop();
    assert.equal(events.filter((event) => event.type === 'cycle').length, 31, 'Every move was made from the broker\'s readings.');
    assert.equal(events.at(-1).type, 'ended');
    assert.equal(events.at(-1).recordedTo, recordTo);

    // What the broker sent is a data log now, with every reading.
    const recorded = readDataLog(await readFile(recordTo, 'utf8'));
    assert.equal(recorded.observations.length, log.observations.length);
    assert.equal(recorded.observations.filter((observation) => observation.quality === 'bad').length, 1, 'The bad reading is recorded as bad.');

    // The same moves as a twin fed the rig's own log.
    const direct = new WindowSession({ ...settings, header: log.header, engineOptions });
    direct.push(log.observations);
    await direct.end();
    const outcome = (cycles) => cycles.map(({ anchor, now, jumps, window, forecast, restored }) => JSON.stringify({ anchor, now, jumps, window, forecast, restored }));
    assert.deepEqual(outcome(liveCycles), outcome(direct.cycles), 'Through the broker or from the file, the moves are the same.');
    await direct.close();
    console.log(`Live twin over MQTT: topics found by listening, ${liveCycles.length} moves from the broker's readings, the same as from the file, and ${recorded.observations.length} readings recorded.`);
} finally {
    await publisher.endAsync();
    await new Promise((resolve) => server.close(resolve));
    broker.close();
    await rm(directory, { recursive: true, force: true });
}
