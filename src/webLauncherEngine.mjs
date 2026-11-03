/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs a model to its end for a launcher add-on in the web edition (docs/proposals/webEditionPackages.md, stage 5), answering the whole
// decoded result, checkpoints included, which the page's own Run path trims. A plain run goes to the batch worker, as Run does. A run
// with commands to send (a fork with its parameter changes) goes to the live-run worker and gets them through its control ring, as it
// can only where the page is cross-origin isolated (webEngineLiveShim.mjs); `canSendCommands` says whether that is so here.

import { encodeEngineCommand } from './engineProtocol.mjs';
import { createStdinRingBuffer, pushStdinBytes } from './webEngineStdinBuffer.mjs';

export const canSendCommands = () => typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined' && globalThis.crossOriginIsolated === true;

// Frames for a fork's changes are as large as the paths a window supplies, and all are queued before the engine reads the first.
const commandRingBytes = 8 * 1024 * 1024;

let batchWorker = null;
let requestCounter = 0;

function runInBatchWorker(engineModuleUrl, content, configuration) {
    batchWorker ??= new Worker(new URL('./webEngineWorker.mjs', import.meta.url), { type: 'module' });
    const worker = batchWorker;
    return new Promise((resolve, reject) => {
        const requestId = ++requestCounter;
        const onMessage = (event) => {
            if (event.data.requestId !== requestId) return;
            worker.removeEventListener('message', onMessage);
            if (!event.data.ok) reject(new Error(event.data.message));
            else if (!event.data.outcome.available) reject(new Error('The simulation engine is unavailable.'));
            else resolve(event.data.outcome.result);
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({ requestId, engineModuleUrl, content, configuration });
    });
}

function runInLiveWorker(engineModuleUrl, content, configuration, commands) {
    return new Promise((resolve, reject) => {
        const stdinRing = createStdinRingBuffer(commandRingBytes);
        const worker = new Worker(new URL('./webEngineLiveRunWorker.mjs', import.meta.url), { type: 'module' });
        worker.addEventListener('message', (event) => {
            const { type } = event.data;
            if (type === 'complete') {
                worker.terminate();
                resolve(event.data.result);
            } else if (type === 'error') {
                worker.terminate();
                reject(new Error(event.data.message));
            }
        });
        worker.addEventListener('error', (event) => {
            worker.terminate();
            reject(new Error(event.message || 'The simulation engine stopped.'));
        });
        worker.postMessage({ engineModuleUrl, content, configuration, stdinRing });
        let sequence = 0;
        try {
            for (const command of commands) pushStdinBytes(stdinRing, encodeEngineCommand(++sequence, command));
        } catch (error) {
            worker.terminate();
            reject(error);
        }
    });
}

// `engineModuleUrl` is an absolute address; `content` is the model's text with its plugins resolved.
export function runModel(engineModuleUrl, content, configuration, commands = []) {
    return commands.length ? runInLiveWorker(engineModuleUrl, content, configuration, commands) : runInBatchWorker(engineModuleUrl, content, configuration);
}
