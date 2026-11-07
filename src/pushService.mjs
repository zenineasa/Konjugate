/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Konjugate's push service (docs/proposals/pushService.md): the one place Konjugate listens, for a lab whose own script has nowhere
// else to put its readings. Three front ends, each only turning what arrives into a key and readings for the one PushGate:
//
//   HTTP        POST /v1/readings, JSON or protobuf by Content-Type, answered in the same encoding
//   WebSocket   GET /v1/stream upgraded; a text frame is a JSON message, a binary frame a protobuf one, each answered in its own
//   gRPC        konjugate.push.v1.ReadingPush on its own port: Push (a stream, answered message by message, slowed by HTTP/2's flow
//               control when the readings are taken slowly) and Check; and grpc.health.v1.Health
//
// The key is sent as "Authorization: Bearer <key>" (gRPC metadata `authorization`). A connection's messages are taken one at a time,
// the next read only once the last is handed on, so a consumer slower than the sender slows the sender rather than filling memory.
// It listens on the loopback address unless told otherwise, and beyond this computer only encrypted (HTTPS, secure WebSockets and
// gRPC over TLS, on one certificate: src/pushCertificate.mjs), since a key sent in the clear on a network can be read by anyone on
// it; the service refuses to listen on the network otherwise, whoever asks. Stopping refuses new connections, tells each open one why (a WebSocket
// closed with 1001, a gRPC call ended UNAVAILABLE, an HTTP request answered 503), and resolves once all have gone.

import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { WebSocketServer } from 'ws';
import { PushGate, PushRefusal, bearerKey, refusalAnswer } from './pushGate.mjs';
import { codecForContentType, jsonPushCodec, protobufPushCodec, pushProtoPath, readingsFromPushMessage } from './pushCodecs.mjs';

export const defaultPushPort = 8737;
const healthProtoPath = fileURLToPath(new URL('../protocol/grpcHealth.proto', import.meta.url));
const maximumMessageBytes = 1024 * 1024;
const stoppedReason = 'Konjugate stopped listening';
const recentClientMilliseconds = 10000;

let grpcDefinitions = null;
const definitions = () => {
    if (grpcDefinitions) return grpcDefinitions;
    const options = { keepCase: true, longs: Number, enums: String, defaults: false, oneofs: true };
    const push = grpc.loadPackageDefinition(protoLoader.loadSync(pushProtoPath, options));
    const health = grpc.loadPackageDefinition(protoLoader.loadSync(healthProtoPath, options));
    grpcDefinitions = { push: push.konjugate.push.v1.ReadingPush.service, health: health.grpc.health.v1.Health.service };
    return grpcDefinitions;
};

// An HTTP status as the gRPC status the same refusal ends a call with.
const grpcStatusFor = (refusal) => {
    if (refusal.status === 401) return refusal.revoked ? grpc.status.PERMISSION_DENIED : grpc.status.UNAUTHENTICATED;
    if (refusal.status === 429) return grpc.status.RESOURCE_EXHAUSTED;
    if (refusal.status === 503) return grpc.status.UNAVAILABLE;
    if (refusal.status === 403) return grpc.status.PERMISSION_DENIED;
    return grpc.status.INVALID_ARGUMENT;
};
const grpcError = (code, details) => Object.assign(new Error(details), { code, details });

const isLoopback = (host) => host === 'localhost' || host === '::1' || /^127\./.test(host);

// The address a request came from, without the IPv4-in-IPv6 prefix.
const addressOf = (socket) => String(socket?.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
const grpcAddressOf = (call) => String(call.getPeer?.() ?? 'unknown').replace(/^ipv[46]:/, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');

export class PushService {
    #gate;
    #log;
    #httpServer = null;
    #webSocketServer = null;
    #grpcServer = null;
    #sockets = new Set();
    #grpcCalls = new Set();
    #healthWatchers = new Set();
    #recentClients = new Map();
    #openClients = new Map();
    #stopping = false;
    #listening = null;

    // keyStore: a PushKeyStore. deliver(readings, client): hands on what was taken (may return a promise, which the client's next
    // message waits for). log(line): a sentence for each client that connects or is refused. now: milliseconds since 1970.
    constructor({ keyStore, deliver, log = () => {}, now = () => Date.now(), gateOptions = {} }) {
        this.#gate = new PushGate({ keyStore, deliver, now, ...gateOptions });
        this.#log = log;
        this.now = now;
    }

    get gate() { return this.#gate; }

    // Starts the three front ends: HTTP and the WebSocket on `port`, gRPC on `grpcPort` (by default the next one). 0 asks for a free
    // port. tls: { certificate, key } in PEM, for HTTPS, secure WebSockets and gRPC over TLS; required for any host but the loopback.
    // Answers the status.
    async start({ host = '127.0.0.1', port = defaultPushPort, grpcPort = port === 0 ? 0 : port + 1, tls = null } = {}) {
        if (this.#listening) throw new Error('The push service is already listening.');
        if (!isLoopback(host) && !tls) throw new Error('The push service listens on the network only encrypted: a key sent in the clear could be read by anyone on it.');
        this.#stopping = false;
        const handle = (request, response) => { this.#handleHttp(request, response).catch(() => response.destroy()); };
        const httpServer = tls ? createSecureServer({ cert: tls.certificate, key: tls.key }, handle) : createServer(handle);
        // Every connection's own socket (under TLS too, ending it ends the encrypted one), to end any still open a second into stopping.
        httpServer.on('connection', (socket) => {
            this.#sockets.add(socket);
            socket.once('close', () => this.#sockets.delete(socket));
        });
        const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: maximumMessageBytes });
        httpServer.on('upgrade', (request, socket, head) => { this.#handleUpgrade(webSocketServer, request, socket, head).catch(() => socket.destroy()); });
        await new Promise((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(port, host, () => { httpServer.off('error', reject); resolve(); });
        });

        const grpcServer = new grpc.Server({ 'grpc.max_receive_message_length': maximumMessageBytes });
        const { push, health } = definitions();
        grpcServer.addService(push, {
            Push: (call) => this.#handlePushCall(call),
            Check: (call, callback) => this.#handleCheck(call, callback)
        });
        grpcServer.addService(health, {
            Check: (_call, callback) => callback(null, { status: this.#stopping ? 'NOT_SERVING' : 'SERVING' }),
            Watch: (call) => {
                call.write({ status: this.#stopping ? 'NOT_SERVING' : 'SERVING' });
                this.#healthWatchers.add(call);
                call.on('cancelled', () => this.#healthWatchers.delete(call));
            }
        });
        let boundGrpcPort;
        try {
            boundGrpcPort = await new Promise((resolve, reject) => {
                const credentials = tls
                    ? grpc.ServerCredentials.createSsl(null, [{ private_key: Buffer.from(tls.key), cert_chain: Buffer.from(tls.certificate) }], false)
                    : grpc.ServerCredentials.createInsecure();
                grpcServer.bindAsync(`${host.includes(':') ? `[${host}]` : host}:${grpcPort}`, credentials, (error, bound) => (error ? reject(error) : resolve(bound)));
            });
        } catch (error) {
            await new Promise((resolve) => httpServer.close(resolve));
            throw new Error(`The gRPC port ${grpcPort} could not be used: ${error.message}`);
        }
        this.#httpServer = httpServer;
        this.#webSocketServer = webSocketServer;
        this.#grpcServer = grpcServer;
        this.#listening = { host, port: httpServer.address().port, grpcPort: boundGrpcPort, encrypted: Boolean(tls) };
        return this.status();
    }

    // { listening, host, port, grpcPort, clients, connections: { webSocket, grpc }, taken, readingsPerSecond, lastUsed }. `clients`
    // counts each key at each address heard from in the last ten seconds or with a connection open.
    status() {
        const now = this.now();
        const clients = new Set([...this.#openClients.keys()]);
        for (const [client, seen] of this.#recentClients) {
            if (now - seen < recentClientMilliseconds) clients.add(client);
            else this.#recentClients.delete(client);
        }
        const connections = { webSocket: 0, grpc: 0 };
        for (const open of this.#openClients.values()) for (const [kind, count] of Object.entries(open)) connections[kind] += count;
        return {
            listening: Boolean(this.#listening), ...(this.#listening ?? { host: null, port: null, grpcPort: null, encrypted: false }),
            clients: clients.size, connections, ...this.#gate.figures()
        };
    }

    #seen(client) {
        this.#recentClients.set(`${client.name} at ${client.address}`, this.now());
    }

    #opened(client, kind) {
        const id = `${client.name} at ${client.address}`;
        const open = this.#openClients.get(id) ?? { webSocket: 0, grpc: 0 };
        open[kind] += 1;
        this.#openClients.set(id, open);
        this.#log(`"${client.name}" connected from ${client.address} over ${kind === 'grpc' ? 'gRPC' : 'a WebSocket'}.`);
        return () => {
            open[kind] -= 1;
            if (!open.webSocket && !open.grpc) this.#openClients.delete(id);
            this.#seen(client);
        };
    }

    async #handleHttp(request, response) {
        const send = (codec, answer) => {
            const body = codec.encodeAnswer(answer);
            response.writeHead(answer.status, { 'content-type': codec.contentType, 'content-length': Buffer.byteLength(body) });
            response.end(body);
        };
        if (this.#stopping) return send(jsonPushCodec, { status: 503, taken: 0, reason: stoppedReason });
        const path = new URL(request.url, 'http://localhost').pathname;
        if (path !== '/v1/readings') return send(jsonPushCodec, { status: 404, taken: 0, reason: 'Readings are sent to POST /v1/readings, or streamed to /v1/stream as a WebSocket.' });
        if (request.method !== 'POST') return send(jsonPushCodec, { status: 405, taken: 0, reason: 'Readings are sent with POST.' });
        const codec = codecForContentType(request.headers['content-type']);
        if (!codec) return send(jsonPushCodec, { status: 415, taken: 0, reason: 'Send readings as application/json or application/x-protobuf.' });
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            size += chunk.length;
            if (size > maximumMessageBytes) return send(codec, { status: 413, taken: 0, reason: 'A message is at most 1 MB: send the readings in several.' });
            chunks.push(chunk);
        }
        try {
            const client = await this.#gate.admit(bearerKey(request.headers.authorization), addressOf(request.socket));
            this.#seen(client);
            const answer = await this.#gate.take(client, codec.decode(Buffer.concat(chunks)));
            send(codec, answer);
        } catch (error) {
            send(codec, refusalAnswer(error));
        }
    }

    async #handleUpgrade(webSocketServer, request, socket, head) {
        const refuse = (status, reason) => {
            const body = jsonPushCodec.encodeAnswer({ status, taken: 0, reason });
            socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 429 ? 'Too Many Requests' : status === 404 ? 'Not Found' : 'Service Unavailable'}\r\n`
                + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        };
        if (this.#stopping) return refuse(503, stoppedReason);
        if (new URL(request.url, 'http://localhost').pathname !== '/v1/stream') return refuse(404, 'A WebSocket connects to /v1/stream.');
        let client;
        try {
            client = await this.#gate.admit(bearerKey(request.headers.authorization), addressOf(socket));
        } catch (error) {
            const answer = refusalAnswer(error);
            this.#log(`A WebSocket from ${addressOf(socket)} was refused: ${answer.reason}`);
            return refuse(answer.status, answer.reason);
        }
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
            const closed = this.#opened(client, 'webSocket');
            webSocket.once('close', closed);
            let queue = Promise.resolve();
            webSocket.on('message', (data, isBinary) => {
                // One message at a time: the socket is paused while a message is taken, so a sender faster than the consumer waits.
                webSocket.pause();
                queue = queue.then(async () => {
                    const codec = isBinary ? protobufPushCodec : jsonPushCodec;
                    let answer;
                    try {
                        if (this.#stopping) throw new PushRefusal(503, stoppedReason);
                        answer = await this.#gate.take(client, codec.decode(Buffer.isBuffer(data) ? data : Buffer.concat(data)));
                    } catch (error) {
                        answer = refusalAnswer(error);
                        if (error.revoked) {
                            webSocket.send(codec.encodeAnswer(answer), { binary: isBinary });
                            webSocket.close(1008, 'This key was revoked');
                            return;
                        }
                    }
                    this.#seen(client);
                    if (webSocket.readyState === webSocket.OPEN) webSocket.send(codec.encodeAnswer(answer), { binary: isBinary });
                }).finally(() => { if (webSocket.readyState === webSocket.OPEN) webSocket.resume(); });
            });
        });
    }

    async #admitCall(call) {
        const [authorization] = call.metadata.get('authorization');
        return this.#gate.admit(bearerKey(authorization), grpcAddressOf(call));
    }

    #handlePushCall(call) {
        let closed = null;
        this.#grpcCalls.add(call);
        const finish = () => {
            this.#grpcCalls.delete(call);
            closed?.();
            closed = null;
        };
        call.on('cancelled', finish);
        call.on('error', finish);
        call.pause();
        (async () => {
            if (this.#stopping) throw new PushRefusal(503, stoppedReason);
            const client = await this.#admitCall(call);
            closed = this.#opened(client, 'grpc');
            call.on('data', (message) => {
                // One message at a time: reading stops while a message is taken, so HTTP/2's flow control holds back a faster sender.
                call.pause();
                (async () => {
                    let answer;
                    try {
                        if (this.#stopping) throw new PushRefusal(503, stoppedReason);
                        answer = await this.#gate.take(client, readingsFromPushMessage(message));
                    } catch (error) {
                        if (error.revoked) {
                            call.emit('error', grpcError(grpcStatusFor(error), error.reason));
                            return;
                        }
                        answer = refusalAnswer(error);
                    }
                    this.#seen(client);
                    if (!call.write(answer)) await once(call, 'drain');
                    call.resume();
                })().catch((error) => call.emit('error', grpcError(grpc.status.INTERNAL, error.message)));
            });
            call.on('end', () => {
                call.end();
                finish();
            });
            call.resume();
        })().catch((error) => {
            const refusal = error instanceof PushRefusal ? error : new PushRefusal(500, error.message);
            if (refusal.status !== 503) this.#log(`A gRPC call from ${grpcAddressOf(call)} was refused: ${refusal.reason}`);
            call.emit('error', grpcError(error instanceof PushRefusal ? grpcStatusFor(refusal) : grpc.status.INTERNAL, refusal.reason));
            finish();
        });
    }

    #handleCheck(call, callback) {
        if (this.#stopping) return callback(grpcError(grpc.status.UNAVAILABLE, stoppedReason));
        this.#admitCall(call).then(
            (client) => callback(null, { name: client.name, signals: [...client.signals] }),
            (error) => callback(grpcError(error instanceof PushRefusal ? grpcStatusFor(error) : grpc.status.INTERNAL, error.reason ?? error.message))
        );
    }

    // Stops listening, telling each open connection `reason`, and resolves once all are gone.
    async stop(reason = stoppedReason) {
        if (!this.#listening) return;
        this.#stopping = true;
        for (const watcher of this.#healthWatchers) {
            watcher.write({ status: 'NOT_SERVING' });
            watcher.end();
        }
        this.#healthWatchers.clear();
        for (const call of this.#grpcCalls) call.emit('error', grpcError(grpc.status.UNAVAILABLE, reason));
        for (const webSocket of this.#webSocketServer.clients) webSocket.close(1001, reason);
        const grpcServer = this.#grpcServer;
        const httpServer = this.#httpServer;
        await Promise.all([
            new Promise((resolve) => {
                const force = setTimeout(() => { grpcServer.forceShutdown(); resolve(); }, 2000);
                grpcServer.tryShutdown(() => { clearTimeout(force); resolve(); });
            }),
            new Promise((resolve) => {
                httpServer.close(() => resolve());
                httpServer.closeIdleConnections();
                // A WebSocket that does not answer its close, or a request still sending, is ended after a second.
                setTimeout(() => { for (const socket of this.#sockets) socket.destroy(); }, 1000).unref();
            })
        ]);
        this.#webSocketServer.close();
        this.#httpServer = null;
        this.#webSocketServer = null;
        this.#grpcServer = null;
        this.#listening = null;
        this.#openClients.clear();
    }
}
