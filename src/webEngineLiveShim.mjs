/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Presents webEngineWorker.mjs's one-shot batch run (default web build) or
// webEngineLiveRunWorker.mjs's real live/streaming run (web-threads build) through the SAME
// method surface src/preload.mjs's window.engine exposes (start/setPacing/setExecutionState/
// setParameterValue/readResultSeries/readResultSample/releaseResult/cancel/onUpdate/onComplete/
// onError) -- see docs/proposals/webEdition.md, phase 3's Run-button "batch fallback" decision
// and phase 6's live-run follow-up.
//
// Which implementation a given startWebEngineLiveRun() call uses is decided per call, by runtime
// feature detection (SharedArrayBuffer + Atomics + crossOriginIsolated) rather than a build-time
// flag: a real live run needs exactly the same cross-origin isolation the web-threads build's own
// parallel execution and C++ providers already require (see webEngineLiveRunWorker.mjs's own
// header comment for why), and detecting that directly means this module works correctly
// regardless of which shell variant happens to be serving it, with no cross-layer import of
// webShims/buildInfo.mjs needed.
//
// The batch path's own consequences (onUpdate never fires, setPacing/setExecutionState/
// setParameterValue reject, a live parameter tweak has no effect) are unchanged from before -- see
// startBatchRun() below, moved here verbatim from this file's earlier, batch-only version.
//
// registerCompletedResult is also used by the phase-3 project-file shim (webShims/
// projectFiles.mjs) to seed this same job cache when a loaded .kjt embeds a result -- matching
// how src/main.mjs's real completedEngineResults map is shared between a completed live run and
// createEmbeddedResultSession, for exactly the same reason: readResultSeries/readResultSample/
// releaseResult must work uniformly regardless of where a result came from.

import { encodeEngineCommand } from './engineProtocol.mjs';
import { nearestResultSample, rendererResultProjection, resultSignalSeries } from './resultSession.mjs';
import { createStdinRingBuffer, pushStdinBytes } from './webEngineStdinBuffer.mjs';
import { liveControlParameterIds } from './sharedParameters.mjs';

const jobs = new Map(); // jobId -> the raw decodeResultFile()-shaped result (full precision, not projected)
const liveJobs = new Map(); // jobId -> { worker, stdinRing, commandSequence, liveParameterIds } -- real live jobs only, see startRealLiveRun()
const completeListeners = [];
const errorListeners = [];
const updateListeners = [];

const liveRunSupported = typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined' && globalThis.crossOriginIsolated === true;

// Mirrors src/engineAdapter.mjs's own normalizePacing() -- duplicated rather than imported, since
// that module pulls in node:child_process/node:fs at its top level and cannot load in a browser
// at all (matching webEngineAdapter.mjs's own header comment on why it does not reuse that file).
function normalizePacing(pacing = {}) {
    const mode = pacing.mode ?? 'fastest';
    const ratio = mode === 'realTime' ? 1 : Number(pacing.simulationSecondsPerWallSecond ?? 1);
    if (!['fastest', 'realTime', 'limitedRatio'].includes(mode)) throw new Error('Unsupported simulation pacing mode.');
    if (mode === 'limitedRatio' && (!(ratio > 0) || !Number.isFinite(ratio))) {
        throw new Error('Limited simulation pacing requires a finite positive ratio.');
    }
    return { mode, simulationSecondsPerWallSecond: ratio };
}

// Mirrors src/main.mjs's engineStart handler's own projectLiveResult() -- trims a live update to
// its most recent sample only (readWebEngineResultSeries/readWebEngineResultSample serve the full
// history separately; onUpdate is a lightweight "something changed" nudge, not a resend of
// everything so far).
function projectLiveResult(result) {
    return { ...result, samples: result.samples?.length ? [result.samples.at(-1)] : [], checkpoints: [] };
}

export function registerCompletedResult(jobId, result) {
    jobs.set(jobId, result);
}

let batchWorker = null;
function getBatchWorker() {
    if (!batchWorker) batchWorker = new Worker(new URL('./webEngineWorker.mjs', import.meta.url), { type: 'module' });
    return batchWorker;
}

let requestCounter = 0;
function runInBatchWorker(engineModuleUrl, content, configuration) {
    return new Promise((resolve, reject) => {
        const requestId = ++requestCounter;
        const instance = getBatchWorker();
        const onMessage = (event) => {
            if (event.data.requestId !== requestId) return;
            instance.removeEventListener('message', onMessage);
            if (event.data.ok) resolve(event.data.outcome);
            else reject(new Error(event.data.message));
        };
        instance.addEventListener('message', onMessage);
        instance.postMessage({
            requestId,
            engineModuleUrl: new URL(engineModuleUrl, location.href).href,
            content,
            configuration
        });
    });
}

// Batch fallback (default web build, or any browser without cross-origin isolation): runs the
// whole simulation to completion in a Worker, then plays the single result back through
// onComplete -- no incremental updates, no live control. See this file's own header comment.
function startBatchRun(engineModuleUrl, content, configuration) {
    const jobId = crypto.randomUUID();
    runInBatchWorker(engineModuleUrl, content, configuration).then((outcome) => {
        if (!outcome.available) {
            errorListeners.forEach((listener) => listener({ jobId, message: 'The C++ simulation engine is unavailable.' }));
            return;
        }
        registerCompletedResult(jobId, outcome.result);
        completeListeners.forEach((listener) => listener({ jobId, result: rendererResultProjection(outcome.result) }));
    }).catch((error) => {
        errorListeners.forEach((listener) => listener({ jobId, message: error.message }));
    });
    return Promise.resolve({ available: true, jobId });
}

function findLiveParameterIds(content) {
    let document;
    try {
        document = JSON.parse(content);
    } catch {
        return new Set();
    }
    return liveControlParameterIds(document);
}

// Real live run (web-threads build only -- see liveRunSupported above): mirrors
// src/main.mjs's engineStart handler's own update-throttling (a 100ms coalescing timer) on top of
// webEngineLiveRunWorker.mjs's own event-driven updates, so onUpdate fires at a UI-appropriate
// rate even if the engine emits events faster than that.
function startRealLiveRun(engineModuleUrl, content, configuration) {
    const jobId = crypto.randomUUID();
    const stdinRing = createStdinRingBuffer();
    const worker = new Worker(new URL('./webEngineLiveRunWorker.mjs', import.meta.url), { type: 'module' });
    const job = { worker, stdinRing, commandSequence: 0, liveParameterIds: findLiveParameterIds(content) };
    liveJobs.set(jobId, job);

    let updateTimer = null;
    let latestUpdate = null;
    const flushUpdate = () => {
        updateTimer = null;
        if (latestUpdate) updateListeners.forEach((listener) => listener(latestUpdate));
        latestUpdate = null;
    };
    const finish = () => {
        if (updateTimer) clearTimeout(updateTimer);
        updateTimer = null;
        latestUpdate = null;
        liveJobs.delete(jobId);
        worker.terminate();
    };
    worker.addEventListener('message', (event) => {
        const { type } = event.data;
        if (type === 'update') {
            latestUpdate = { jobId, result: projectLiveResult(event.data.result) };
            updateTimer ??= setTimeout(flushUpdate, 100);
        } else if (type === 'complete') {
            finish();
            registerCompletedResult(jobId, event.data.result);
            completeListeners.forEach((listener) => listener({ jobId, result: rendererResultProjection(event.data.result) }));
        } else if (type === 'error') {
            finish();
            errorListeners.forEach((listener) => listener({ jobId, message: event.data.message }));
        }
    });
    worker.postMessage({
        engineModuleUrl: new URL(engineModuleUrl, location.href).href,
        content, configuration, stdinRing
    });
    return Promise.resolve({ available: true, jobId });
}

export function startWebEngineLiveRun(engineModuleUrl, content, configuration) {
    return liveRunSupported
        ? startRealLiveRun(engineModuleUrl, content, configuration)
        : startBatchRun(engineModuleUrl, content, configuration);
}

function sendLiveCommand(job, command) {
    job.commandSequence += 1;
    pushStdinBytes(job.stdinRing, encodeEngineCommand(job.commandSequence, command));
}

export async function setWebEngineLivePacing(jobId, pacing) {
    const job = liveJobs.get(jobId);
    if (!job) throw new Error("Live pacing isn't available in the web edition's batch-run mode.");
    const normalized = normalizePacing(pacing);
    sendLiveCommand(job, { type: 'setPacing', pacing: normalized });
    return normalized;
}

export async function setWebEngineLiveExecutionState(jobId, executionState) {
    const job = liveJobs.get(jobId);
    if (!job) throw new Error("Pausing or stopping a run isn't available in the web edition's batch-run mode.");
    if (!['running', 'paused', 'stopped'].includes(executionState)) throw new Error('Unsupported execution state.');
    sendLiveCommand(job, { type: 'setRunState', state: executionState });
    return executionState;
}

export async function setWebEngineLiveParameterValue(jobId, parameterId, value) {
    const job = liveJobs.get(jobId);
    if (!job) throw new Error("Live parameter control isn't available in the web edition's batch-run mode.");
    if (!job.liveParameterIds.has(parameterId)) throw new Error('That parameter is not available for live control.');
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) throw new Error('A live parameter value must be finite.');
    sendLiveCommand(job, { type: 'setParameterValue', parameterId, value: numericValue });
    return { parameterId, value: numericValue };
}

export async function readWebEngineResultSeries(jobId, signalIds, options) {
    const result = jobs.get(jobId);
    if (!result) return [];
    return resultSignalSeries(result, signalIds, options);
}

export async function readWebEngineResultSample(jobId, time) {
    const result = jobs.get(jobId);
    if (!result) return null;
    return nearestResultSample(result, Number(time));
}

export async function releaseWebEngineResult(jobId) {
    return jobs.delete(jobId);
}

export async function cancelWebEngineRun(jobId) {
    const job = liveJobs.get(jobId);
    if (job) {
        sendLiveCommand(job, { type: 'setRunState', state: 'stopped' });
        // Best-effort grace period for the engine to wind down and post its own 'complete'/
        // 'error' message (which already cleans up liveJobs/terminates the worker via finish());
        // if it hasn't within a second, force-terminate rather than leave the Worker running
        // indefinitely -- there is no OS-process SIGKILL equivalent to escalate to here, a
        // Worker either responds to being asked to stop or gets torn down outright.
        setTimeout(() => {
            if (liveJobs.has(jobId)) {
                liveJobs.delete(jobId);
                job.worker.terminate();
            }
        }, 1000);
        return true;
    }
    // Batch mode has no in-flight process to steer once a run has started: the Worker either
    // already finished (its result is cached in `jobs`) or is still computing and will land in
    // onComplete/onError normally when it does. Releasing whatever is cached is the only thing
    // "cancel" means here.
    return jobs.delete(jobId);
}

export function onWebEngineUpdate(callback) {
    updateListeners.push(callback);
}

export function onWebEngineComplete(callback) {
    completeListeners.push(callback);
}

export function onWebEngineError(callback) {
    errorListeners.push(callback);
}
