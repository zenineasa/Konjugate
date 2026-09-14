/* Copyright © 2026 Zenin Easa Panthakkalakath */

// window.engine for the web shell (docs/proposals/webEdition.md, phase 3) -- composes phase 2's
// one-shot operations (unchanged) with webEngineLiveShim.mjs's batch-run-as-live-job surface,
// assembled into the exact method set src/preload.mjs exposes on the desktop.

import {
    fitWithWebEngine, getWebEngineCapabilities, checkSubstepConvergenceWithWebEngine,
    inferWithWebEngine, runWithWebEngine, validateWithWebEngine
} from '../../webEngineAdapter.mjs';
import {
    cancelWebEngineRun, onWebEngineComplete, onWebEngineError, onWebEngineUpdate,
    readWebEngineResultSample, readWebEngineResultSeries, releaseWebEngineResult,
    setWebEngineLiveExecutionState, setWebEngineLivePacing, setWebEngineLiveParameterValue,
    startWebEngineLiveRun
} from '../../webEngineLiveShim.mjs';

// Relative to this file's own served location -- see scripts/buildWebShell.mjs, which mirrors
// src/'s directory layout under out/webShell/ and copies out/engineWeb/konjugateEngine.{js,wasm}
// to out/webShell/engine/.
const engineModuleUrl = new URL('../../engine/konjugateEngine.js', import.meta.url).href;

export default {
    capabilities: () => getWebEngineCapabilities(engineModuleUrl),
    validate: (content) => validateWithWebEngine(engineModuleUrl, content),
    infer: (csv, config) => inferWithWebEngine(engineModuleUrl, csv, config),
    fit: (content, csv, config) => fitWithWebEngine(engineModuleUrl, content, csv, config),
    checkSubstepConvergence: () => checkSubstepConvergenceWithWebEngine(),
    run: (content, configuration) => runWithWebEngine(engineModuleUrl, content, configuration),
    start: (content, configuration) => startWebEngineLiveRun(engineModuleUrl, content, configuration),
    setPacing: (jobId, pacing) => setWebEngineLivePacing(jobId, pacing),
    setExecutionState: (jobId, executionState) => setWebEngineLiveExecutionState(jobId, executionState),
    setParameterValue: (jobId, parameterId, value) => setWebEngineLiveParameterValue(jobId, parameterId, value),
    readResultSeries: (jobId, signalIds, options) => readWebEngineResultSeries(jobId, signalIds, options),
    readResultSample: (jobId, time) => readWebEngineResultSample(jobId, time),
    releaseResult: (jobId) => releaseWebEngineResult(jobId),
    cancel: (jobId) => cancelWebEngineRun(jobId),
    onUpdate: (callback) => onWebEngineUpdate(callback),
    onComplete: (callback) => onWebEngineComplete(callback),
    onError: (callback) => onWebEngineError(callback)
};
