/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The push service's own process (docs/proposals/pushService.md, "Where it runs"): Electron's utilityProcess, started and watched by
// src/pushServiceHost.mjs in the main process, so a flood of messages cannot stall the windows. It runs one PushService and talks to
// the main process over its parent port:
//
//   from the main process   { type: 'start', directory, host, port, grpcPort }   { type: 'stop', reason }   { type: 'status' }
//                           { type: 'taken', id }  (the readings sent as `id` are handed on: the client's next message may come)
//   to the main process     { type: 'started', status }   { type: 'status', status }   { type: 'stopped' }   { type: 'failed', message }
//                           { type: 'readings', id, readings, client }   { type: 'log', line }
//
// A message's readings wait for the main process's 'taken' before the client is answered, so a slow twin slows the script down
// rather than filling this process's memory.

import { PushKeyStore } from './pushKeyStore.mjs';
import { PushService } from './pushService.mjs';

// Electron's parent port; under Node's child_process.fork (the host's tests), the same messages over process.send.
const port = process.parentPort ?? {
    on: (event, handler) => process.on(event, (data) => handler({ data })),
    postMessage: (message) => process.send(message)
};
const waiting = new Map();
let nextId = 1;
let service = null;

const post = (message) => port.postMessage(message);

port.on('message', async ({ data: message }) => {
    try {
        if (message.type === 'start') {
            service = new PushService({
                keyStore: new PushKeyStore(message.directory),
                deliver: (readings, client) => new Promise((resolve) => {
                    const id = nextId;
                    nextId += 1;
                    waiting.set(id, resolve);
                    post({ type: 'readings', id, readings, client: { name: client.name, address: client.address } });
                }),
                log: (line) => post({ type: 'log', line })
            });
            post({ type: 'started', status: await service.start({ host: message.host, port: message.port, grpcPort: message.grpcPort }) });
        } else if (message.type === 'taken') {
            waiting.get(message.id)?.();
            waiting.delete(message.id);
        } else if (message.type === 'status') {
            post({ type: 'status', status: service?.status() ?? { listening: false } });
        } else if (message.type === 'stop') {
            await service?.stop(message.reason);
            for (const resolve of waiting.values()) resolve();
            waiting.clear();
            post({ type: 'stopped' });
            // A moment for the message to leave before the process does; the host ends it on 'stopped' in any case.
            setTimeout(() => process.exit(0), 100);
        }
    } catch (error) {
        // The host ends this process once it has heard why it could not start.
        post({ type: 'failed', message: error.message });
    }
});
