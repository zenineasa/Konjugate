/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Presents webEngineWorker.mjs's one-shot batch run through the SAME method surface
// src/preload.mjs's window.engine exposes for a true live/streaming run (start/setPacing/
// setExecutionState/setParameterValue/readResultSeries/readResultSample/releaseResult/cancel/
// onUpdate/onComplete/onError) -- see docs/proposals/webEdition.md, phase 3's Run-button
// "batch fallback" decision. True live streaming needs a Worker + Asyncify-style design so a
// blocking WASM callMain() can still receive commands mid-run; that is a separate, harder
// project, not attempted here. This module instead runs the whole simulation to completion in a
// Worker (keeps the page responsive), then plays the single result back through the same
// onComplete/readResultSeries/readResultSample contract src/main.mjs's real engineStart/
// engineReadResultSeries/engineReadResultSample handlers already use -- via resultSession.mjs,
// which both this module and those handlers import (confirmed already renderer-safe: no node:*
// imports, already reused by resultExport.mjs on the renderer side today).
//
// Consequences a caller should know: onUpdate never fires (no incremental updates once the run
// is already complete by the time this module knows about it at all); setPacing/
// setExecutionState/setParameterValue reject, since there is no in-flight process left to steer.
//
// registerCompletedResult is also used by the phase-3 project-file shim (webShims/
// projectFiles.mjs) to seed this same job cache when a loaded .kjt embeds a result -- matching
// how src/main.mjs's real completedEngineResults map is shared between a completed live run and
// createEmbeddedResultSession, for exactly the same reason: readResultSeries/readResultSample/
// releaseResult must work uniformly regardless of where a result came from.

import { nearestResultSample, rendererResultProjection, resultSignalSeries } from './resultSession.mjs';

const jobs = new Map(); // jobId -> the raw decodeResultFile()-shaped result (full precision, not projected)
const completeListeners = [];
const errorListeners = [];
const updateListeners = []; // registered for interface symmetry with window.engine.onUpdate; never invoked, see header comment

let worker = null;
function getWorker() {
    if (!worker) worker = new Worker(new URL('./webEngineWorker.mjs', import.meta.url), { type: 'module' });
    return worker;
}

let requestCounter = 0;
function runInWorker(engineModuleUrl, content, configuration) {
    return new Promise((resolve, reject) => {
        const requestId = ++requestCounter;
        const instance = getWorker();
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

export function registerCompletedResult(jobId, result) {
    jobs.set(jobId, result);
}

// Returns { available: true, jobId } as soon as a job identifier exists -- deliberately not
// awaiting the Worker's completion, matching engineStart's real shape (the desktop handler also
// returns well before the simulation finishes; completion arrives later via onComplete/onError).
export function startWebEngineLiveRun(engineModuleUrl, content, configuration) {
    const jobId = crypto.randomUUID();
    runInWorker(engineModuleUrl, content, configuration).then((outcome) => {
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

export async function setWebEngineLivePacing() {
    throw new Error("Live pacing isn't available in the web edition's batch-run mode.");
}

export async function setWebEngineLiveExecutionState() {
    throw new Error("Pausing or stopping a run isn't available in the web edition's batch-run mode.");
}

export async function setWebEngineLiveParameterValue() {
    throw new Error("Live parameter control isn't available in the web edition's batch-run mode.");
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
