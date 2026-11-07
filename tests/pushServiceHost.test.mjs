/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The push service as the app runs it (src/pushServiceHost.mjs): in a process of its own (here started with Node's
// child_process.fork, as the app starts it with Electron's utilityProcess), its readings published on the hub a live twin follows,
// and its stopping, failing to start, or ending unexpectedly told to the twins following it.

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PushServiceHost } from '../src/pushServiceHost.mjs';
import { followPush } from '../src/pushSource.mjs';

// Node's child process dressed as Electron's utility process: postMessage, on('message'), on('exit') and kill().
function forkLikeUtilityProcess(started) {
    return (modulePath) => {
        const child = fork(modulePath, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        started.push(child);
        return { postMessage: (message) => child.send(message), on: (event, handler) => child.on(event, handler), kill: () => child.kill() };
    };
}

test('the service in its own process: readings reach the twins following the hub, and stopping tells them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugatePushHost-'));
    const children = [];
    const changes = [];
    const host = new PushServiceHost({ directory, fork: forkLikeUtilityProcess(children), onChange: (state) => changes.push(state) });
    try {
        const { key } = await host.keys.add('vessel rig', ['vesselTemperature', 'heaterPower']);
        const state = await host.start({ port: 0 });
        assert.equal(state.listening, true);
        assert.equal(state.host, '127.0.0.1');
        assert.ok(state.port > 0 && state.grpcPort > 0);

        const observations = [];
        const errors = [];
        followPush(host.hub, {
            signals: [{ signal: 'vesselTemperature', name: 'tankTemperature', role: 'output', unit: 'K' }],
            onObservations: (batch) => observations.push(...batch), onError: (error) => errors.push(error.message), batchMilliseconds: 5
        });
        assert.deepEqual(host.state().followedSignals, ['vesselTemperature']);
        const response = await fetch(`http://127.0.0.1:${state.port}/v1/readings`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ readings: [{ signal: 'vesselTemperature', value: 341.5 }, { signal: 'heaterPower', value: 1200 }] })
        });
        assert.equal((await response.json()).status, 202);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(observations.map(({ signal, value }) => ({ signal, value })), [{ signal: 'tankTemperature', value: 341.5 }]);
        assert.equal(host.state().unclaimed, 1, 'The heater reading no twin follows is counted.');
        assert.ok(host.state().log.some((entry) => /Listening on 127\.0\.0\.1/.test(entry.line)));

        await host.stop();
        assert.equal(host.state().listening, false);
        assert.deepEqual(errors, ['The push service stopped: Konjugate stopped listening.']);
        assert.equal(changes.at(-1).listening, false);
        await assert.rejects(fetch(`http://127.0.0.1:${state.port}/v1/readings`, { method: 'POST' }));
    } finally {
        await host.stop();
        await rm(directory, { recursive: true, force: true });
    }
});

test('a port in use is said, and a service that ends unexpectedly ends the twins following it with the reason', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugatePushHost-'));
    const children = [];
    const host = new PushServiceHost({ directory, fork: forkLikeUtilityProcess(children) });
    const blocker = createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    try {
        await assert.rejects(host.start({ port: blocker.address().port, grpcPort: 0 }), /EADDRINUSE/);
        assert.equal(host.state().listening, false);

        await host.start({ port: 0 });
        const errors = [];
        followPush(host.hub, { signals: [{ signal: 'level', name: 'level', role: 'output' }], onError: (error) => errors.push(error.message) });
        const exited = new Promise((resolve) => children.at(-1).once('exit', resolve));
        children.at(-1).kill('SIGKILL');
        await exited;
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(host.state().listening, false);
        assert.match(host.state().failure, /ended unexpectedly/);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /ended unexpectedly/);
    } finally {
        await host.stop();
        await new Promise((resolve) => blocker.close(resolve));
        await rm(directory, { recursive: true, force: true });
    }
});

test('on the network: encrypted with the host\'s certificate, a script trusting it taken at this computer\'s address, and a wrong pair of files refused', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugatePushHostTls-'));
    const children = [];
    const host = new PushServiceHost({ directory, fork: forkLikeUtilityProcess(children) });
    try {
        const { key } = await host.keys.add('remote rig', ['level']);
        const info = await host.certificateInfo();
        assert.equal(info.own, false);
        assert.equal(info.key, undefined, 'The panel is never handed the key.');
        const state = await host.start({ port: 0, network: true });
        assert.equal(state.encrypted, true);
        assert.equal(state.host, '0.0.0.0');
        assert.equal(state.certificate.fingerprint, info.fingerprint, 'It listens with the certificate the panel showed.');
        const address = state.addresses.find((ip) => !ip.includes(':')) ?? '127.0.0.1';
        const answer = await new Promise((resolve, reject) => {
            const request = httpsRequest({ host: address, port: state.port, path: '/v1/readings', method: 'POST', ca: info.certificate, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } }, (response) => {
                let text = '';
                response.on('data', (chunk) => { text += chunk; });
                response.on('end', () => resolve(JSON.parse(text)));
            });
            request.on('error', reject);
            request.end(JSON.stringify({ readings: [{ signal: 'level', value: 2 }] }));
        });
        assert.equal(answer.status, 202, `Taken at ${address}, over TLS.`);
        await host.stop();

        await assert.rejects(host.useOwnCertificate(join(directory, 'pushCertificate.pem'), join(directory, 'nothing.pem')));
        assert.equal(await host.ownCertificatePaths(), null, 'A refused choice is not kept.');
        const back = await host.useKonjugateCertificate();
        assert.equal(back.fingerprint, info.fingerprint);
    } finally {
        await host.stop();
        await rm(directory, { recursive: true, force: true });
    }
});
