/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The push service's demonstration, over the network (docs/proposals/pushService.md, step 5): the service listens on every
// interface, encrypted with Konjugate's own certificate, and examples/dataSources/pushTankRig.py (the simulated rig, as a lab's
// script) sends the rig's six hours to this computer's network address, trusting that certificate. Checked: a live twin following
// the pushed readings makes the same moves, to the bit, as one fed the rig's own log; the script refuses an https:// address
// without a certificate; and given another Konjugate's certificate, its TLS refuses to talk.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/liveTwinPushNetwork.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readDataLog } from '../../src/dataLog.mjs';
import { guessReplayMapping, replayTargets } from '../../src/dataLogReplay.mjs';
import { LiveTwin } from '../../src/liveTwinHost.mjs';
import { ensurePushCertificate, networkAddresses } from '../../src/pushCertificate.mjs';
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
    console.log('The push service over the network skipped: no Python on this computer to run the simulated rig.');
    process.exit(0);
}

// The script, run as a lab would run it; resolves with its exit code and what it printed.
const runScript = (args) => new Promise((resolve) => {
    const child = spawn(python, [join(root, 'examples', 'dataSources', 'pushTankRig.py'), ...args]);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
});

const directory = await mkdtemp(join(tmpdir(), 'konjugatePushNetwork-'));
const hub = new PushHub();
const store = new PushKeyStore(directory);
const { key } = await store.add('simulated rig', ['heaterPower', 'tankTemperature']);
const certificate = await ensurePushCertificate(directory);
const service = new PushService({ keyStore: store, deliver: (readings) => hub.publish(readings) });
const { port } = await service.start({ host: '0.0.0.0', port: 0, grpcPort: 0, tls: certificate });
// This computer's own network address when it has one, so the readings go out through the network stack and the certificate's
// address is the one checked; the loopback address when it has none (a computer with no network still runs the test).
const address = networkAddresses().ips.find((ip) => !ip.includes(':')) ?? '127.0.0.1';
const url = `https://${address}:${port}`;
try {
    const start = '2026-11-07T09:00:00Z';
    const logPath = join(directory, 'rig.csv');
    const rig = spawnSync(python, [join(root, 'examples', 'dataSources', 'simulatedTankRig.py'), logPath, '--speed', '1e9', '--start', start], { encoding: 'utf8' });
    assert.equal(rig.status, 0, rig.stderr);
    const log = readDataLog(await readFile(logPath, 'utf8'));

    // The script refuses an https:// address without the certificate, and does not talk to a Konjugate whose certificate it was
    // not given.
    const bare = await runScript([url, '--key', key, '--duration', '60']);
    assert.notEqual(bare.code, 0);
    assert.match(bare.output, /needs the service's certificate/);
    const elsewhere = await mkdtemp(join(tmpdir(), 'konjugatePushNetworkOther-'));
    const stranger = await ensurePushCertificate(elsewhere);
    const wrong = await runScript([url, '--key', key, '--certificate', stranger.path, '--duration', '60']);
    await rm(elsewhere, { recursive: true, force: true });
    assert.notEqual(wrong.code, 0);
    assert.match(wrong.output, /CERTIFICATE_VERIFY_FAILED/);
    assert.equal(hub.unclaimed, 0, 'Nothing reached the service from a script that did not trust it.');

    const document = tankRigProject();
    const signals = log.header.signals.map((signal) => ({ signal: signal.name, name: signal.name, role: signal.role, unit: signal.unit }));
    const mapping = guessReplayMapping({ signals: log.header.signals }, replayTargets(document));
    const settings = { document, mapping, window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances: { tankTemperature: 0.5 }, keepUp: false };
    const events = [];
    const twin = new LiveTwin(settings, { kind: 'push', hub, signals, recordTo: join(directory, 'recording.csv') }, engineOptions, (event) => events.push(event));
    const pushed = await runScript([url, '--key', key, '--certificate', certificate.path, '--speed', '1e9', '--start', start]);
    assert.equal(pushed.code, 0, pushed.output);
    assert.match(pushed.output, new RegExp(`Done: ${log.observations.length} readings sent`));
    const lastTime = Math.max(...log.observations.map((observation) => observation.time)) - log.observations[0].time;
    for (let waited = 0; waited < 60000 && twin.session.latestTime < lastTime; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    await twin.session.end();
    const liveCycles = twin.session.cycles;
    await twin.stop();
    assert.equal(events.filter((event) => event.type === 'cycle').length, 31, 'Every move was made from the readings sent over the network.');

    const direct = new WindowSession({ ...settings, header: log.header, engineOptions });
    direct.push(log.observations);
    await direct.end();
    const outcome = (cycles) => cycles.map(({ anchor, now, jumps, window, forecast, restored }) => JSON.stringify({ anchor, now, jumps, window, forecast, restored }));
    assert.deepEqual(outcome(liveCycles), outcome(direct.cycles), 'Sent over the network or read from the file, the moves are the same.');
    await direct.close();
    console.log(`The push service over the network: the simulated rig sent ${log.observations.length} readings to ${address} over TLS, a live twin made ${liveCycles.length} moves, the same as from the file; a script without the certificate, or with another, was refused.`);
} finally {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
}
