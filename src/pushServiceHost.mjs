/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The push service as the app runs it (docs/proposals/pushService.md, "Where it runs"): started in its own process
// (src/pushServiceProcess.mjs) and watched from the main process. Readings that process takes are published on a PushHub, which the
// live twins following pushed readings read from; keys are managed here, in the main process, through a PushKeyStore on the same
// file the service reads, so a key made or revoked applies to the running service at once.
//
// `fork(modulePath)` starts the process: Electron's utilityProcess.fork in the app. What it returns needs postMessage(message),
// on('message', handler) and on('exit', handler) and kill(), as a utility process has.

import { fileURLToPath } from 'node:url';
import { PushKeyStore } from './pushKeyStore.mjs';
import { defaultPushPort } from './pushService.mjs';
import { PushHub } from './pushSource.mjs';

const processModule = fileURLToPath(new URL('./pushServiceProcess.mjs', import.meta.url));
const stoppedReason = 'Konjugate stopped listening';

export class PushServiceHost {
    #fork;
    #child = null;
    #status = { listening: false };
    #failure = null;
    #onChange;
    #log = [];
    #poll = null;
    #pending = null;
    #stopping = false;

    // directory: where the keys are kept (the app's own folder). onChange(state): every change to what the panel and the chip show.
    constructor({ directory, fork, onChange = () => {} }) {
        this.directory = directory;
        this.keys = new PushKeyStore(directory);
        this.hub = new PushHub();
        this.#fork = fork;
        this.#onChange = onChange;
    }

    // What the panel and the chip show: the service's status, why it stopped if it failed, the readings no twin followed, how many
    // twins follow it, and the last few connections.
    state() {
        return {
            ...this.#status, failure: this.#failure, unclaimed: this.hub.unclaimed, followers: this.hub.followers,
            followedSignals: this.hub.followedSignals, log: [...this.#log], defaultPort: defaultPushPort
        };
    }

    #changed() { this.#onChange(this.state()); }

    #note(line) {
        this.#log.push({ time: Date.now(), line });
        if (this.#log.length > 20) this.#log.shift();
    }

    // Starts listening, on the loopback address. Answers the state once it listens, or throws why it could not.
    async start({ port = defaultPushPort, grpcPort = port === 0 ? 0 : port + 1 } = {}) {
        if (this.#child) throw new Error('The push service is already listening.');
        this.#failure = null;
        const child = this.#fork(processModule);
        this.#child = child;
        const started = new Promise((resolve, reject) => { this.#pending = { resolve, reject }; });
        child.on('message', (message) => this.#receive(child, message));
        child.on('exit', (code) => {
            if (this.#child !== child) return;
            this.#child = null;
            clearInterval(this.#poll);
            const wasListening = this.#status.listening;
            this.#status = { listening: false };
            if (this.#pending) {
                this.#pending.reject(new Error(this.#failure ?? `The push service ended as it started (code ${code}).`));
                this.#pending = null;
            } else if (wasListening && !this.#stopping) {
                this.#failure ??= `The push service ended unexpectedly (code ${code}).`;
                this.hub.fail(this.#failure);
            }
            this.#changed();
        });
        child.postMessage({ type: 'start', directory: this.directory, host: '127.0.0.1', port, grpcPort });
        await started;
        // The rate and the clients change without a message: the panel and the chip are kept current every second while it listens.
        this.#poll = setInterval(() => child.postMessage({ type: 'status' }), 1000);
        this.#poll.unref?.();
        return this.state();
    }

    #receive(child, message) {
        if (message.type === 'readings') {
            try {
                this.hub.publish(message.readings);
            } finally {
                child.postMessage({ type: 'taken', id: message.id });
            }
        } else if (message.type === 'started') {
            this.#status = message.status;
            this.#note(`Listening on ${message.status.host}:${message.status.port}, gRPC on ${message.status.grpcPort}.`);
            this.#pending?.resolve();
            this.#pending = null;
            this.#changed();
        } else if (message.type === 'status') {
            const before = JSON.stringify(this.#status);
            this.#status = message.status;
            if (JSON.stringify(this.#status) !== before) this.#changed();
        } else if (message.type === 'log') {
            this.#note(message.line);
            this.#changed();
        } else if (message.type === 'failed') {
            this.#failure = message.message;
            if (this.#pending) {
                // Forgotten at once, so another start can follow straight away; its exit, when it comes, changes nothing.
                if (this.#child === child) this.#child = null;
                this.#pending.reject(new Error(message.message));
                this.#pending = null;
                child.kill();
            }
        } else if (message.type === 'stopped') {
            child.kill();
        }
    }

    // Stops listening: each open connection is told `reason`, the twins following it are told it stopped, and the process ends.
    async stop(reason = stoppedReason) {
        const child = this.#child;
        if (!child) return this.state();
        this.#stopping = true;
        clearInterval(this.#poll);
        const exited = new Promise((resolve) => child.on('exit', resolve));
        child.postMessage({ type: 'stop', reason });
        const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000));
        if (await Promise.race([exited, timeout]) === 'timeout') child.kill();
        await exited;
        this.#stopping = false;
        this.hub.fail(`${reason}.`);
        this.#note('Stopped listening.');
        this.#changed();
        return this.state();
    }
}
