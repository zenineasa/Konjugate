/* Copyright © 2026 Zenin Easa Panthakkalakath */

// window.engine for the web shell (docs/proposals/webEdition.md, phase 3) -- composes phase 2's
// one-shot operations (unchanged) with webEngineLiveShim.mjs's batch-run-as-live-job surface,
// assembled into the exact method set src/preload.mjs exposes on the desktop.

import { resolvePluginReferences } from './packages.mjs';
import {
    fitWithWebEngine, getWebEngineCapabilities, checkSubstepConvergenceWithWebEngine,
    inferWithWebEngine, runWithWebEngine, validateWithWebEngine
} from '../../webEngineAdapter.mjs';
import {
    cancelWebEngineRun, onWebEngineComplete, onWebEngineError, onWebEngineUpdate,
    readWebEngineResultSample, readWebEngineResultSeries, releaseWebEngineResult,
    setWebEngineLiveExecutionState, setWebEngineLivePacing, setWebEngineLiveParameterValue, scheduleWebEngineLiveParameterValue,
    startWebEngineLiveRun
} from '../../webEngineLiveShim.mjs';

// Relative to this file's own served location -- see scripts/buildWebShell.mjs, which mirrors
// src/'s directory layout under out/webShell/ and copies out/engineWeb/konjugateEngine.{js,wasm}
// to out/webShell/engine/.
const engineModuleUrl = new URL('../../engine/konjugateEngine.js', import.meta.url).href;

export default {
    capabilities: () => getWebEngineCapabilities(engineModuleUrl),
    // Each call that takes a model has the plugin providers it names resolved to their source first, as the desktop does before the engine.
    validate: async (content) => validateWithWebEngine(engineModuleUrl, await resolvePluginReferences(content)),
    infer: (csv, config) => inferWithWebEngine(engineModuleUrl, csv, config),
    fit: async (content, csv, config) => fitWithWebEngine(engineModuleUrl, await resolvePluginReferences(content), csv, config),
    // The web engine reports a fit only when it ends: there is no progress to show and nothing to stop part way.
    onFitProgress: () => {},
    stopFit: async () => false,
    checkObjective: async () => ({ available: false }),
    // A web page cannot start a program of its own: an objective written as a program is a desktop feature.
    programObjectives: false,
    // A web page cannot keep an engine running or read a file as it grows: the live twin is a desktop feature for now.
    liveTwin: { available: false, onEvent: () => {}, pathForFile: () => null },
    discardFit: async () => false,
    checkSubstepConvergence: () => checkSubstepConvergenceWithWebEngine(),
    run: async (content, configuration) => runWithWebEngine(engineModuleUrl, await resolvePluginReferences(content), configuration),
    start: async (content, configuration) => startWebEngineLiveRun(engineModuleUrl, await resolvePluginReferences(content), configuration),
    setPacing: (jobId, pacing) => setWebEngineLivePacing(jobId, pacing),
    setExecutionState: (jobId, executionState) => setWebEngineLiveExecutionState(jobId, executionState),
    setParameterValue: (jobId, parameterId, value) => setWebEngineLiveParameterValue(jobId, parameterId, value),
    scheduleParameterValue: (jobId, parameterId, schedule) => scheduleWebEngineLiveParameterValue(jobId, parameterId, schedule),
    readResultSeries: (jobId, signalIds, options) => readWebEngineResultSeries(jobId, signalIds, options),
    readResultSample: (jobId, time) => readWebEngineResultSample(jobId, time),
    releaseResult: (jobId) => releaseWebEngineResult(jobId),
    cancel: (jobId) => cancelWebEngineRun(jobId),
    onUpdate: (callback) => onWebEngineUpdate(callback),
    onComplete: (callback) => onWebEngineComplete(callback),
    onError: (callback) => onWebEngineError(callback)
};
