/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A live twin fed by an OPC UA server (src/opcuaSource.mjs through src/liveTwinHost.mjs): a server stands in for a lab's PLC
// (tests/fixtures/opcuaRigServer.mjs), the simulated rig's six hours are reported through its tags with their own source timestamps,
// and a live twin follows the tags. Checked: browsing finds the tags with the unit and range the server gives; a signed and encrypted
// connection is refused until the person trusts the server's certificate, and works once they have; the twin makes every move, and
// the same moves as a twin fed the rig's own log; the sensor's failure is a bad reading; and what arrived is recorded as a data log.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/liveTwinOpcUa.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readDataLog } from '../../src/dataLog.mjs';
import { guessReplayMapping, replayTargets } from '../../src/dataLogReplay.mjs';
import { LiveTwin } from '../../src/liveTwinHost.mjs';
import { browseOpcUa } from '../../src/opcuaSource.mjs';
import { WindowSession } from '../../src/windowSession.mjs';
import { startRigServer } from '../fixtures/opcuaRigServer.mjs';
import { tankRigProject } from '../../scripts/generateTankRigModel.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };
const python = (process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']).find((candidate) => spawnSync(candidate, ['--version']).status === 0);
if (!python) {
    console.log('Live twin over OPC UA skipped: no Python on this computer to run the simulated rig.');
    process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), 'konjugateOpcUa-'));
const server = await startRigServer({ pkiFolder: join(directory, 'serverPki') });
try {
    // Browsing: the tags, with what the server says about them.
    const tags = await browseOpcUa(server.url, { pkiFolder: join(directory, 'clientPki') });
    const tank = tags.find((tag) => tag.path === 'Rig2/TankTemperature');
    const heater = tags.find((tag) => tag.path === 'Rig2/HeaterPower');
    assert.ok(tank && heater, `Browsing finds the rig's tags: ${tags.map((tag) => tag.path)}.`);
    assert.equal(tank.unit, 'K', 'The unit is the one the server gives.');
    assert.deepEqual(tank.range, { low: 250, high: 400 });
    assert.equal(heater.unit, 'W');

    // Security: signed and encrypted, the server's certificate must be trusted by the person first.
    await assert.rejects(browseOpcUa(server.url, { security: 'signAndEncrypt', pkiFolder: join(directory, 'clientPki') }), (error) => error.untrusted === true, 'An untrusted server is refused, and the person asked.');
    const secured = await browseOpcUa(server.url, { security: 'signAndEncrypt', pkiFolder: join(directory, 'clientPki'), trustServer: true });
    assert.ok(secured.some((tag) => tag.path === 'Rig2/TankTemperature'), 'Once trusted, the encrypted connection works.');
    const again = await browseOpcUa(server.url, { security: 'signAndEncrypt', pkiFolder: join(directory, 'clientPki') });
    assert.ok(again.length, 'And the trust is remembered.');

    // The rig's six hours, through the tags.
    const logPath = join(directory, 'rig.csv');
    const rig = spawnSync(python, [join(root, 'examples', 'dataSources', 'simulatedTankRig.py'), logPath, '--speed', '1e9', '--start', '2026-11-06T09:00:00Z'], { encoding: 'utf8' });
    assert.equal(rig.status, 0, rig.stderr);
    const log = readDataLog(await readFile(logPath, 'utf8'));
    const document = tankRigProject();
    const signals = [
        { nodeId: server.nodeId('HeaterPower'), name: 'heaterPower', role: 'input', unit: 'W' },
        { nodeId: server.nodeId('TankTemperature'), name: 'tankTemperature', role: 'output', unit: 'K' }
    ];
    const mapping = guessReplayMapping({ signals: log.header.signals }, replayTargets(document));
    const settings = { document, mapping, window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances: { tankTemperature: 0.5 }, keepUp: false };
    const recordTo = join(directory, 'recording.csv');
    const events = [];
    // A PLC that is running already has its tags' current values, and a subscription starts by sending them: here, the rig's first
    // readings, so the first notification is the first reading and not the tags' values from when the server started.
    const nameOf = { heaterPower: 'HeaterPower', tankTemperature: 'TankTemperature' };
    const firstTime = log.observations[0].time;
    const first = log.observations.filter((observation) => observation.time === firstTime);
    for (const observation of first) server.set(nameOf[observation.signal], observation.value, new Date(log.header.epoch + observation.time * 1000));
    const twin = new LiveTwin(settings, { kind: 'opcua', url: server.url, signals, security: 'none', pkiFolder: join(directory, 'clientPki'), recordTo }, engineOptions, (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 1500)); // connected and subscribed
    for (const observation of log.observations.slice(first.length)) {
        server.set(nameOf[observation.signal], observation.value, new Date(log.header.epoch + observation.time * 1000), observation.quality === 'bad' ? 'bad' : 'good');
        // A server samples its tags (this one every 50 ms) and a subscription reports what it sampled, not every change: the rig's
        // readings are given more slowly than that, as a real rig's are (a reading a minute), so none is sampled over.
        await new Promise((resolve) => setTimeout(resolve, 75));
    }
    // Every reading in (a broker or a server never says it has finished), then the data is complete.
    const lastTime = Math.max(...log.observations.map((observation) => observation.time)) - log.observations[0].time;
    for (let waited = 0; waited < 60000 && twin.session.latestTime < lastTime; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    await twin.session.end();
    const liveCycles = twin.session.cycles;
    await twin.stop();
    assert.equal(events.filter((event) => event.type === 'cycle').length, 31, 'Every move was made from the server\'s tags.');

    // What arrived is recorded, the sensor's failure as a bad reading.
    const recorded = readDataLog(await readFile(recordTo, 'utf8'));
    const recordedTemperatures = recorded.observations.filter((observation) => observation.signal === 'tankTemperature');
    assert.ok(recordedTemperatures.length >= log.observations.filter((observation) => observation.signal === 'tankTemperature').length, 'Every reading is recorded.');
    assert.equal(recordedTemperatures.filter((observation) => observation.quality === 'bad').length, 1, 'The sensor\'s failure is recorded as a bad reading.');

    // The same moves as a twin fed the rig's own log.
    const direct = new WindowSession({ ...settings, header: log.header, engineOptions });
    direct.push(log.observations);
    await direct.end();
    const outcome = (cycles) => cycles.map(({ anchor, now, jumps, window, forecast }) => JSON.stringify({ anchor, now, jumps, window, forecast }));
    assert.deepEqual(outcome(liveCycles), outcome(direct.cycles), 'Through the server or from the file, the moves are the same.');
    await direct.close();
    console.log(`Live twin over OPC UA: tags browsed with their units and ranges; an encrypted connection refused until trusted; ${liveCycles.length} moves from the server's tags, the same as from the file; the sensor failure recorded as bad.`);
} finally {
    await server.shutdown();
    await rm(directory, { recursive: true, force: true });
}
