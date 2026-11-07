/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The push service (src/pushService.mjs, docs/proposals/pushService.md): its keys, its two encodings, and its three front ends held
// to the same answers. The refusals are written once and sent every way a script can send them: HTTP with JSON, HTTP with protobuf,
// a WebSocket with each, and a gRPC stream.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';
import WebSocket from 'ws';
import { PushKeyStore } from '../src/pushKeyStore.mjs';
import { PushGate, PushRefusal } from '../src/pushGate.mjs';
import { codecForContentType, jsonPushCodec, protobufPushCodec, pushProtoPath } from '../src/pushCodecs.mjs';
import { PushService } from '../src/pushService.mjs';
import { ensurePushCertificate, readOwnCertificate } from '../src/pushCertificate.mjs';

const protoRoot = protobuf.loadSync(pushProtoPath);
const PushReadings = protoRoot.lookupType('konjugate.push.v1.PushReadings');
const PushAnswer = protoRoot.lookupType('konjugate.push.v1.PushAnswer');
const loaderOptions = { keepCase: true, longs: Number, enums: String, defaults: false, oneofs: true };
const ReadingPush = grpc.loadPackageDefinition(protoLoader.loadSync(pushProtoPath, loaderOptions)).konjugate.push.v1.ReadingPush;
const Health = grpc.loadPackageDefinition(protoLoader.loadSync(join(import.meta.dirname, '..', 'protocol', 'grpcHealth.proto'), loaderOptions)).grpc.health.v1.Health;

// A message as a test writes it ({ readings: [{ signal, value, time (seconds or null), quality }] }) in each encoding.
const asJson = (message) => JSON.stringify({
    readings: message.readings.map(({ time, ...reading }) => ({ ...reading, ...(time === null || time === undefined ? {} : { time }) }))
});
const asProtobufObject = (message) => ({
    readings: message.readings.map(({ signal, value, time, quality }) => ({
        signal, ...(value === undefined ? {} : { value }),
        ...(time === null || time === undefined ? {} : { time: { seconds: Math.floor(time), nanos: Math.round((time - Math.floor(time)) * 1e9) } }),
        ...(quality ? { quality: quality.toUpperCase() } : {})
    }))
});
const asProtobuf = (message) => Buffer.from(PushReadings.encode(PushReadings.fromObject(asProtobufObject(message))).finish());

const fixed = 1794046502;

describe('push keys', () => {
    let directory;
    before(async () => { directory = await mkdtemp(join(tmpdir(), 'konjugatePushKeys-')); });
    after(async () => { await rm(directory, { recursive: true, force: true }); });

    test('a key is shown once and only its hash is kept; another process sees a key added or revoked', async () => {
        const store = new PushKeyStore(directory, { now: () => 1000 });
        const { key, record } = await store.add('vessel rig', ['vesselTemperature', 'heaterPower']);
        assert.match(key, /^kjp_[A-Za-z0-9_-]{43}$/);
        assert.deepEqual(record, { name: 'vessel rig', signals: ['vesselTemperature', 'heaterPower'], created: 1000, revoked: null });
        const file = await readFile(store.path, 'utf8');
        assert.equal(file.includes(key), false, 'The key itself is not written down.');
        assert.equal((await store.find(key)).name, 'vessel rig');
        assert.equal(await store.find('kjp_notAKey'), null);

        const other = new PushKeyStore(directory);
        assert.equal((await other.find(key)).revoked, null);
        await store.revoke('vessel rig');
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(typeof (await other.find(key)).revoked, 'number', 'A key revoked elsewhere is seen within half a second.');
        assert.deepEqual((await other.list()).map((entry) => entry.name), ['vessel rig']);
    });

    test('a key made elsewhere is known at once, to every lookup, even those arriving together', async () => {
        const service = new PushKeyStore(directory);
        const manager = new PushKeyStore(directory);
        await service.list();
        // The service has just looked; the key is made straight after, and a burst of lookups follows.
        const { key } = await manager.add('burst', ['level']);
        const found = await Promise.all(Array.from({ length: 20 }, () => service.find(key)));
        assert.ok(found.every((record) => record?.name === 'burst'), 'Every lookup found the new key.');
    });

    test('a key needs a name of its own and signals that can be names', async () => {
        const store = new PushKeyStore(directory);
        await store.add('balance', ['mass']);
        await assert.rejects(store.add('balance', ['mass']), /already a key named "balance"/);
        await assert.rejects(store.add('', ['mass']), /needs a name/);
        await assert.rejects(store.add('scale', []), /at least one signal/);
        await assert.rejects(store.add('scale', ['2mass']), /cannot name a signal/);
        await assert.rejects(store.revoke('nobody'), /no key named "nobody"/);
        await store.revoke('balance');
        await store.add('balance', ['mass']);
    });
});

describe('push encodings', () => {
    test('JSON times are seconds, or ISO 8601 with a zone, or left out', () => {
        const readings = jsonPushCodec.decode(JSON.stringify({ readings: [
            { signal: 'a', value: 1, time: '2026-11-07T10:15:02.250Z' },
            { signal: 'a', value: 2, time: fixed + 0.5, quality: 'uncertain' },
            { signal: 'a', value: 3 }
        ] }));
        assert.deepEqual(readings, [
            { signal: 'a', value: 1, time: Date.parse('2026-11-07T10:15:02.250Z') / 1000, quality: 'good' },
            { signal: 'a', value: 2, time: fixed + 0.5, quality: 'uncertain' },
            { signal: 'a', value: 3, time: null, quality: 'good' }
        ]);
        assert.throws(() => jsonPushCodec.decode('{"readings":[{"signal":"a","value":1,"time":"2026-11-07 10:15"}]}'), /no time zone/);
        assert.throws(() => jsonPushCodec.decode('{"readings":[{"signal":"a","value":1,"time":"soon"}]}'), /not a time/);
        assert.throws(() => jsonPushCodec.decode('{"readings":'), (error) => error instanceof PushRefusal && error.status === 400 && /not JSON/.test(error.reason));
        assert.throws(() => jsonPushCodec.decode('[1,2]'), /A message is/);
    });

    test('protobuf carries the same readings, a value of 0 kept apart from none', () => {
        const message = { readings: [{ signal: 'a', value: 0, time: fixed + 0.25 }, { signal: 'b', quality: 'bad' }] };
        assert.deepEqual(protobufPushCodec.decode(asProtobuf(message)), [
            { signal: 'a', value: 0, time: fixed + 0.25, quality: 'good' },
            { signal: 'b', value: undefined, time: null, quality: 'bad' }
        ]);
        assert.throws(() => protobufPushCodec.decode(Buffer.from([0x0a, 0xff, 0xff])), (error) => error.status === 400 && /not a PushReadings message/.test(error.reason));
        const answer = PushAnswer.toObject(PushAnswer.decode(protobufPushCodec.encodeAnswer({ status: 202, taken: 2, reason: '' })));
        assert.deepEqual(answer, { status: 202, taken: 2 });
        assert.equal(codecForContentType('application/json; charset=utf-8'), jsonPushCodec);
        assert.equal(codecForContentType('application/x-protobuf'), protobufPushCodec);
        assert.equal(codecForContentType('text/plain'), null);
    });
});

describe('push gate', () => {
    test('ten wrong keys from one address shut it out for a minute, good key or not', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'konjugatePushGate-'));
        try {
            const store = new PushKeyStore(directory);
            const { key } = await store.add('rig', ['level']);
            let now = 0;
            const gate = new PushGate({ keyStore: store, now: () => now });
            for (let attempt = 0; attempt < 10; attempt += 1) await assert.rejects(gate.admit('kjp_wrong', '10.0.0.7'), (error) => error.status === 401);
            await assert.rejects(gate.admit(key, '10.0.0.7'), (error) => error.status === 429);
            assert.equal((await gate.admit(key, '10.0.0.8')).name, 'rig', 'Another address is not shut out.');
            now = 61000;
            assert.equal((await gate.admit(key, '10.0.0.7')).name, 'rig');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe('push service', () => {
    let directory;
    let store;
    let service;
    let status;
    let key;
    let revokedKey;
    let delivered = [];
    let deliverDelay = 0;
    let inFlight = 0;
    let mostInFlight = 0;

    before(async () => {
        directory = await mkdtemp(join(tmpdir(), 'konjugatePush-'));
        store = new PushKeyStore(directory);
        ({ key } = await store.add('vessel rig', ['vesselTemperature', 'heaterPower']));
        ({ key: revokedKey } = await store.add('old script', ['vesselTemperature']));
        await store.revoke('old script');
        // Every refusal below comes from 127.0.0.1, more than ten wrong keys in a minute: the limit has its own test (push gate).
        service = new PushService({
            keyStore: store, gateOptions: { failureLimit: 1000 },
            deliver: async (readings, client) => {
                inFlight += 1;
                mostInFlight = Math.max(mostInFlight, inFlight);
                if (deliverDelay) await new Promise((resolve) => setTimeout(resolve, deliverDelay));
                delivered.push(...readings.map((reading) => ({ ...reading, client: client.name })));
                inFlight -= 1;
            }
        });
        status = await service.start({ port: 0, grpcPort: 0 });
    });
    after(async () => {
        await service.stop();
        await rm(directory, { recursive: true, force: true });
    });

    const httpUrl = () => `http://127.0.0.1:${status.port}`;
    const grpcClient = () => new ReadingPush(`127.0.0.1:${status.grpcPort}`, grpc.credentials.createInsecure());
    const metadataFor = (withKey) => {
        const metadata = new grpc.Metadata();
        if (withKey) metadata.set('authorization', `Bearer ${withKey}`);
        return metadata;
    };

    async function sendHttp(encoding, withKey, message) {
        const response = await fetch(`${httpUrl()}/v1/readings`, {
            method: 'POST',
            headers: { 'content-type': encoding === 'json' ? 'application/json' : 'application/x-protobuf', ...(withKey ? { authorization: `Bearer ${withKey}` } : {}) },
            body: encoding === 'json' ? asJson(message) : asProtobuf(message)
        });
        const body = Buffer.from(await response.arrayBuffer());
        const answer = encoding === 'json' ? JSON.parse(body.toString('utf8')) : { taken: 0, reason: '', ...PushAnswer.toObject(PushAnswer.decode(body)) };
        assert.equal(answer.status, response.status, 'The answer carries the HTTP status.');
        return answer;
    }

    async function sendWebSocket(encoding, withKey, message) {
        const socket = new WebSocket(`ws://127.0.0.1:${status.port}/v1/stream`, { headers: withKey ? { authorization: `Bearer ${withKey}` } : {} });
        const refused = new Promise((resolve) => socket.once('unexpected-response', (_request, response) => {
            let body = '';
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => resolve(JSON.parse(body)));
        }));
        const opened = new Promise((resolve, reject) => { socket.once('open', () => resolve(null)); socket.once('error', reject); });
        const first = await Promise.race([refused, opened.catch(() => refused)]);
        if (first) return first;
        socket.send(encoding === 'json' ? asJson(message) : asProtobuf(message), { binary: encoding === 'protobuf' });
        const [data, isBinary] = await new Promise((resolve) => socket.once('message', (...args) => resolve(args)));
        socket.close();
        return isBinary ? { taken: 0, reason: '', ...PushAnswer.toObject(PushAnswer.decode(data)) } : JSON.parse(data.toString('utf8'));
    }

    // A gRPC stream of one message; a refused key ends the call, given back as the HTTP status the same refusal has.
    async function sendGrpc(withKey, message) {
        const client = grpcClient();
        try {
            return await new Promise((resolve) => {
                const call = client.Push(metadataFor(withKey));
                call.on('data', (answer) => { resolve({ taken: 0, reason: '', ...answer }); call.end(); });
                call.on('error', (error) => resolve({ status: { [grpc.status.UNAUTHENTICATED]: 401, [grpc.status.PERMISSION_DENIED]: 401, [grpc.status.RESOURCE_EXHAUSTED]: 429 }[error.code] ?? error.code, taken: 0, reason: error.details, code: error.code }));
                call.write(asProtobufObject(message));
            });
        } finally {
            client.close();
        }
    }

    const ways = {
        'HTTP with JSON': (withKey, message) => sendHttp('json', withKey, message),
        'HTTP with protobuf': (withKey, message) => sendHttp('protobuf', withKey, message),
        'a WebSocket with JSON': (withKey, message) => sendWebSocket('json', withKey, message),
        'a WebSocket with protobuf': (withKey, message) => sendWebSocket('protobuf', withKey, message),
        gRPC: (withKey, message) => sendGrpc(withKey, message)
    };

    // What each message is answered, whichever way it is sent.
    const cases = [
        ['readings are taken', () => key, { readings: [{ signal: 'vesselTemperature', value: 341.2, time: fixed }, { signal: 'heaterPower', value: 0, time: fixed + 0.5, quality: 'uncertain' }] }, 202, /^$/],
        ['a key Konjugate does not know', () => 'kjp_unknown', { readings: [{ signal: 'vesselTemperature', value: 1, time: fixed }] }, 401, /not one Konjugate knows/],
        ['no key', () => null, { readings: [{ signal: 'vesselTemperature', value: 1, time: fixed }] }, 401, /Authorization: Bearer/],
        ['a revoked key', () => revokedKey, { readings: [{ signal: 'vesselTemperature', value: 1, time: fixed }] }, 401, /"old script"\) was revoked/],
        ['a signal the key may not send', () => key, { readings: [{ signal: 'vesselTemperature', value: 1, time: fixed }, { signal: 'stirrerSpeed', value: 3, time: fixed }] }, 403, /may not send "stirrerSpeed"/],
        ['a reading with no value', () => key, { readings: [{ signal: 'vesselTemperature', value: 1, time: fixed }, { signal: 'heaterPower', time: fixed }] }, 400, /Reading 2 \(heaterPower\) has no value/],
        ['a time in milliseconds', () => key, { readings: [{ signal: 'vesselTemperature', value: 1, time: fixed * 1000 }] }, 400, /not milliseconds/]
    ];

    for (const [way, send] of Object.entries(ways)) {
        test(`over ${way}, every message gets the same answer`, async () => {
            for (const [what, withKey, message, expectedStatus, reason] of cases) {
                delivered = [];
                const answer = await send(withKey(), message);
                assert.equal(answer.status, expectedStatus, `${what}: ${answer.reason}`);
                assert.match(answer.reason ?? '', reason, what);
                assert.equal(answer.taken ?? 0, expectedStatus === 202 ? message.readings.length : 0, what);
                assert.equal(delivered.length, expectedStatus === 202 ? message.readings.length : 0, `${what}: a refused message is refused whole.`);
            }
        });
    }

    test('the same readings are taken identically whichever way they come, and a reading with no time is stamped on arrival', async () => {
        const message = { readings: [{ signal: 'vesselTemperature', value: 340.125, time: fixed + 0.125 }, { signal: 'heaterPower', value: 1200, time: null, quality: 'bad' }] };
        const taken = [];
        for (const send of Object.values(ways)) {
            delivered = [];
            const before = Date.now() / 1000;
            assert.equal((await send(key, message)).status, 202);
            const after = Date.now() / 1000;
            assert.ok(delivered[1].time >= before - 0.01 && delivered[1].time <= after + 0.01 && delivered[1].stamped, 'Stamped when it arrived.');
            taken.push(delivered.map(({ time, ...reading }) => ({ ...reading, time: reading.stamped ? 'arrival' : time })));
        }
        for (const other of taken.slice(1)) assert.deepEqual(other, taken[0]);
        assert.deepEqual(taken[0][0], { signal: 'vesselTemperature', value: 340.125, quality: 'good', stamped: false, client: 'vessel rig', time: fixed + 0.125 });
    });

    test('HTTP says what it takes: the path, the method and the two content types', async () => {
        const post = (path, headers, method = 'POST') => fetch(`${httpUrl()}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...headers }, body: method === 'POST' ? '{}' : undefined });
        const unsupported = await post('/v1/readings', { 'content-type': 'text/plain' });
        assert.equal(unsupported.status, 415);
        assert.match((await unsupported.json()).reason, /application\/json or application\/x-protobuf/);
        assert.equal((await post('/elsewhere', { 'content-type': 'application/json' })).status, 404);
        assert.equal((await post('/v1/readings', {}, 'GET')).status, 405);
    });

    test('gRPC: Check says what a key may send, and the health service says it is serving', async () => {
        const client = grpcClient();
        const health = new Health(`127.0.0.1:${status.grpcPort}`, grpc.credentials.createInsecure());
        try {
            const checked = await new Promise((resolve, reject) => client.Check({}, metadataFor(key), (error, answer) => (error ? reject(error) : resolve(answer))));
            assert.deepEqual(checked, { name: 'vessel rig', signals: ['vesselTemperature', 'heaterPower'] });
            const revoked = await new Promise((resolve) => client.Check({}, metadataFor(revokedKey), (error) => resolve(error)));
            assert.equal(revoked.code, grpc.status.PERMISSION_DENIED);
            const unknown = await new Promise((resolve) => client.Check({}, metadataFor('kjp_nobody'), (error) => resolve(error)));
            assert.equal(unknown.code, grpc.status.UNAUTHENTICATED);
            const serving = await new Promise((resolve, reject) => health.Check({}, (error, answer) => (error ? reject(error) : resolve(answer))));
            assert.equal(serving.status, 'SERVING');
        } finally {
            client.close();
            health.close();
        }
    });

    test('a gRPC sender faster than the readings are taken is held back, not buffered without limit', async () => {
        delivered = [];
        deliverDelay = 5;
        mostInFlight = 0;
        const client = grpcClient();
        try {
            const count = 200;
            const answers = [];
            let heldBack = false;
            await new Promise((resolve, reject) => {
                const call = client.Push(metadataFor(key));
                call.on('data', (answer) => {
                    answers.push(answer);
                    if (answers.length === count) call.end();
                });
                call.on('end', resolve);
                call.on('error', reject);
                for (let index = 0; index < count; index += 1) {
                    if (!call.write(asProtobufObject({ readings: [{ signal: 'vesselTemperature', value: index, time: fixed + index }] }))) heldBack = true;
                }
            });
            assert.equal(answers.length, count);
            assert.ok(answers.every((answer) => answer.status === 202));
            assert.deepEqual(delivered.map((reading) => reading.value), Array.from({ length: count }, (_, index) => index), 'Taken in the order sent.');
            assert.equal(mostInFlight, 1, 'One message is taken at a time.');
            assert.ok(heldBack, 'The sender was told to wait.');
            assert.equal(service.status().clients >= 1, true);
        } finally {
            deliverDelay = 0;
            client.close();
        }
    });

    test('stopping tells each open connection why, and then nothing listens', async () => {
        const second = new PushService({ keyStore: store, deliver: () => {} });
        const started = await second.start({ port: 0, grpcPort: 0 });
        const socket = new WebSocket(`ws://127.0.0.1:${started.port}/v1/stream`, { headers: { authorization: `Bearer ${key}` } });
        await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        const socketClosed = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
        const client = new ReadingPush(`127.0.0.1:${started.grpcPort}`, grpc.credentials.createInsecure());
        const call = client.Push(metadataFor(key));
        const callEnded = new Promise((resolve) => call.on('error', resolve));
        // The call is open once its first message has been answered.
        await new Promise((resolve) => {
            call.once('data', resolve);
            call.write(asProtobufObject({ readings: [{ signal: 'vesselTemperature', value: 1, time: fixed }] }));
        });
        assert.deepEqual(second.status().connections, { webSocket: 1, grpc: 1 });
        await second.stop();
        assert.deepEqual(await socketClosed, { code: 1001, reason: 'Konjugate stopped listening' });
        const ended = await callEnded;
        assert.equal(ended.code, grpc.status.UNAVAILABLE);
        assert.equal(ended.details, 'Konjugate stopped listening');
        client.close();
        await assert.rejects(fetch(`http://127.0.0.1:${started.port}/v1/readings`, { method: 'POST' }));
        assert.equal(second.status().listening, false);
    });
});

describe('push service on the network', () => {
    let directory;
    before(async () => { directory = await mkdtemp(join(tmpdir(), 'konjugatePushTls-')); });
    after(async () => { await rm(directory, { recursive: true, force: true }); });

    test('Konjugate\'s own certificate: made once, for this computer\'s addresses, its key private, and made again when they change', async () => {
        const addresses = { ips: ['192.0.2.10'], names: ['labpc', 'labpc.local'] };
        const first = await ensurePushCertificate(directory, { addresses });
        assert.equal(first.made, true);
        assert.match(first.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
        for (const name of ['localhost', '127.0.0.1', '192.0.2.10', 'labpc', 'labpc.local']) assert.ok(first.names.includes(name), name);
        if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'pushKey.pem'))).mode & 0o777, 0o600, 'The key is readable by this user only.');
        const again = await ensurePushCertificate(directory, { addresses });
        assert.equal(again.made, false);
        assert.equal(again.fingerprint, first.fingerprint, 'The same certificate is used again, so scripts keep trusting it.');
        const moved = await ensurePushCertificate(directory, { addresses: { ips: ['192.0.2.99'], names: ['labpc'] } });
        assert.equal(moved.made, true, 'A new address is not in the old certificate, so a new one is made.');
        const late = await ensurePushCertificate(directory, { addresses: { ips: ['192.0.2.99'], names: ['labpc'] }, now: Date.now() + 820 * 86400000 });
        assert.equal(late.made, true, 'A certificate about to run out is made again.');

        const other = await mkdtemp(join(tmpdir(), 'konjugatePushTlsOther-'));
        const stranger = await ensurePushCertificate(other, { addresses });
        await assert.rejects(readOwnCertificate(join(directory, 'pushCertificate.pem'), join(other, 'pushKey.pem')), /not the certificate's own/);
        assert.equal((await readOwnCertificate(join(other, 'pushCertificate.pem'), join(other, 'pushKey.pem'))).fingerprint, stranger.fingerprint);
        await rm(other, { recursive: true, force: true });
    });

    test('the network only encrypted; over TLS a script that trusts the certificate is taken every way, and one that does not is refused', async () => {
        const store = new PushKeyStore(directory);
        const { key } = await store.add('remote rig', ['level']);
        const tls = await ensurePushCertificate(directory, { addresses: { ips: [], names: [] } });
        const refusing = new PushService({ keyStore: store, deliver: () => {} });
        await assert.rejects(refusing.start({ host: '0.0.0.0', port: 0, grpcPort: 0 }), /only encrypted/);

        const delivered = [];
        const service = new PushService({ keyStore: store, deliver: (readings) => { delivered.push(...readings); } });
        const status = await service.start({ host: '127.0.0.1', port: 0, grpcPort: 0, tls });
        try {
            assert.equal(status.encrypted, true);
            const body = JSON.stringify({ readings: [{ signal: 'level', value: 1.5, time: fixed }] });
            const post = (options) => new Promise((resolve, reject) => {
                const request = httpsRequest({ host: '127.0.0.1', port: status.port, path: '/v1/readings', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, ...options }, (response) => {
                    let text = '';
                    response.on('data', (chunk) => { text += chunk; });
                    response.on('end', () => resolve(JSON.parse(text)));
                });
                request.on('error', reject);
                request.end(body);
            });
            assert.equal((await post({ ca: tls.certificate })).status, 202, 'HTTPS, trusting the certificate.');
            await assert.rejects(post({}), (error) => /SELF_SIGNED|DEPTH_ZERO/.test(error.code), 'Not trusting it, the script is refused by its own TLS.');
            await assert.rejects(fetch(`http://127.0.0.1:${status.port}/v1/readings`, { method: 'POST', body }), 'Plain HTTP is not answered.');

            const socket = new WebSocket(`wss://127.0.0.1:${status.port}/v1/stream`, { headers: { authorization: `Bearer ${key}` }, ca: tls.certificate });
            await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
            socket.send(body);
            const [answer] = await new Promise((resolve) => socket.once('message', (...args) => resolve(args)));
            assert.equal(JSON.parse(answer.toString('utf8')).status, 202, 'A secure WebSocket.');
            socket.close();

            const secureClient = new ReadingPush(`127.0.0.1:${status.grpcPort}`, grpc.credentials.createSsl(Buffer.from(tls.certificate)));
            const metadata = new grpc.Metadata();
            metadata.set('authorization', `Bearer ${key}`);
            const checked = await new Promise((resolve, reject) => secureClient.Check({}, metadata, (error, value) => (error ? reject(error) : resolve(value))));
            assert.deepEqual(checked, { name: 'remote rig', signals: ['level'] }, 'gRPC over TLS.');
            secureClient.close();
            const untrusting = new ReadingPush(`127.0.0.1:${status.grpcPort}`, grpc.credentials.createSsl());
            const refused = await new Promise((resolve) => untrusting.Check({}, metadata, { deadline: Date.now() + 5000 }, (error) => resolve(error)));
            assert.equal(refused.code, grpc.status.UNAVAILABLE, 'gRPC that does not trust the certificate does not connect.');
            untrusting.close();
            assert.equal(delivered.length, 2);
        } finally {
            await service.stop();
        }
    });
});
