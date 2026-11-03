/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The rules of a launcher's runs that need no Node: checking a window's fork time and run length, turning a declared scenario into
// parameter changes, composing a forked branch, picking series for the window, and keeping one baseline per run length. The desktop host
// (launcherHost.mjs) and the web edition's (webLauncherBridge.mjs) both use them, so a run is asked for and answered the same way in each;
// only the engine that does the run differs.

export const maximumSuppliedSamples = 5000;
// A run length the window chooses is limited by engine steps, not by time: models count time in whatever
// unit suits them (days, or seconds with a per-day conversion), so a cap in time units would be either
// too tight for one or too loose for another.
const maximumRunSteps = 500000;

// A fork time the window asks for (with the scenarioForkTime feature): from the start of the run up to, but not
// including, its end. The fork itself lands on the nearest kept checkpoint, one per output interval. Returns the
// fork time; throws a message a user can act on.
export function checkForkTime(forkAt, runTime) {
    if (!(Number.isFinite(forkAt) && forkAt >= 0 && forkAt < runTime)) {
        throw new Error(`The scenario must start at or after 0 and before the end of the run (${runTime}).`);
    }
    return forkAt;
}

// A run length the window asks for: after the scenario's fork, and at most maximumRunSteps of the model's own
// global step. Returns the run length; throws a message a user can act on.
export function checkRunLength(runTime, forkAt, globalTimeStep) {
    const step = Number.isFinite(globalTimeStep) && globalTimeStep > 0 ? globalTimeStep : 1;
    const maximum = maximumRunSteps * step;
    if (!(Number.isFinite(runTime) && runTime > forkAt && runTime <= maximum)) {
        throw new Error(`The run length must be more than ${forkAt} and at most ${maximum} (${maximumRunSteps.toLocaleString('en')} steps of ${step}).`);
    }
    return runTime;
}

// Turns a declared scenario into concrete parameter changes. A parameter is found by its `key` in the
// importer's parameter index: `chosen` targets the entry belonging to the entity the user picked, `all`
// every entry with that key, `global` the single entity-less entry. Throws a message a user can act on.
export function resolveInterventions(scenario, parameterIndex, chosenEntity, supplied = null) {
    const resolved = [];
    for (const intervention of scenario.interventions) {
        const entries = parameterIndex.filter((entry) => entry.key === intervention.parameter);
        if (intervention.target === 'supplied') {
            // The window's data for this parameter: its own entry under byParameter (with the suppliedPerParameter feature),
            // or else the data shared by every supplied intervention.
            const source = supplied?.byParameter?.[intervention.parameter] ?? supplied;
            const entities = source?.entities ?? [];
            if (!entities.length) throw new Error(`The scenario "${scenario.name}" needs the window to supply data${supplied?.byParameter ? ` for "${intervention.parameter}"` : ''}.`);
            for (const entity of entities) {
                const entry = entries.find((candidate) => candidate.entity === entity);
                if (!entry) throw new Error(`The scenario "${scenario.name}" changes "${intervention.parameter}", which this model does not have for ${entity}.`);
                if (!entry.live) throw new Error(`"${entry.name}" cannot be changed during a run.`);
                const clamp = (value) => Math.min(Math.max(value, entry.minimum ?? -Infinity), entry.maximum ?? Infinity);
                // A value outside the parameter's range is held to it, and the change says so, so the window can tell its
                // user rather than run something other than what it supplied without a word.
                const clamped = (values) => {
                    const count = values.filter((value) => value !== clamp(value)).length;
                    return count ? { clamped: { count, of: values.length, minimum: entry.minimum ?? null, maximum: entry.maximum ?? null } } : {};
                };
                if (intervention.samples) {
                    const samples = source.samples?.[entity];
                    if (!Array.isArray(samples) || samples.length < 2 || samples.length > maximumSuppliedSamples || !samples.every((pair) => Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))) {
                        throw new Error(`The data supplied for ${entity} must be at least two, and at most ${maximumSuppliedSamples}, pairs of time and value.`);
                    }
                    resolved.push({
                        sharedParameterId: entry.sharedParameterId, name: entry.name, parameter: intervention.parameter, entity,
                        samples: samples.map(([time, value]) => ({ time, value: clamp(value) })), at: 0, duration: 0, baseValue: entry.value ?? 0,
                        ...clamped(samples.map(([, value]) => value))
                    });
                } else {
                    resolved.push({ sharedParameterId: entry.sharedParameterId, name: entry.name, parameter: intervention.parameter, entity, value: clamp(intervention.value), at: intervention.at ?? 0, duration: intervention.duration ?? 0, baseValue: entry.value ?? 0, ...clamped([intervention.value]) });
                }
            }
            continue;
        }
        const matching = intervention.target === 'global' ? entries.filter((entry) => entry.scope === 'global')
            : intervention.target === 'all' ? entries.filter((entry) => entry.entity !== undefined)
                : entries.filter((entry) => entry.entity === chosenEntity);
        if (!matching.length) {
            throw new Error(intervention.target === 'chosen' && !chosenEntity
                ? `The scenario "${scenario.name}" needs you to choose one first.`
                : `The scenario "${scenario.name}" changes "${intervention.parameter}", which this model does not have.`);
        }
        for (const entry of matching) {
            if (!entry.live) throw new Error(`"${entry.name}" cannot be changed during a run.`);
            const value = Number.isFinite(intervention.value) ? intervention.value : intervention.fractionOfMaximum * entry.maximum;
            resolved.push({
                sharedParameterId: entry.sharedParameterId, name: entry.name, parameter: intervention.parameter,
                entity: entry.entity ?? null, value: Math.min(Math.max(value, entry.minimum ?? -Infinity), entry.maximum ?? Infinity),
                at: intervention.at ?? 0, duration: intervention.duration ?? 0, baseValue: entry.value ?? 0
            });
        }
    }
    return resolved;
}

// Adjusts the interventions a scenario declares with values the window supplies, for parameters the importer has declared live.
// `overrides` is { parameterKey: { entityName | '*': { value, at?, duration? } | null } }: '*' names the one entity-less (global)
// entry, an entry replaces the declared change for that entity or adds one, and null removes it. With no overrides nothing changes,
// so a scenario that is run as declared is run exactly as it always was. Values outside a parameter's declared range are still held
// to it, as a backstop; the window is expected to check them first and say so.
export function applyOverrides(resolved, parameterIndex, overrides) {
    if (!overrides || !Object.keys(overrides).length) return resolved;
    const result = [...resolved];
    for (const [parameter, byEntity] of Object.entries(overrides)) {
        if (!byEntity || typeof byEntity !== 'object') throw new Error(`The changes for "${parameter}" must name the entities they apply to.`);
        for (const [entityName, change] of Object.entries(byEntity)) {
            const entry = parameterIndex.find((candidate) => candidate.key === parameter && (entityName === '*' ? candidate.scope === 'global' : candidate.entity === entityName));
            if (!entry) throw new Error(`This model has no "${parameter}" for ${entityName === '*' ? 'the whole model' : entityName}.`);
            if (!entry.live) throw new Error(`"${entry.name}" cannot be changed during a run.`);
            const at = result.findIndex((candidate) => candidate.sharedParameterId === entry.sharedParameterId);
            if (change === null) { if (at >= 0) result.splice(at, 1); continue; }
            const { value, at: delay = 0, duration = 0 } = change ?? {};
            if (![value, delay, duration].every(Number.isFinite) || delay < 0 || duration < 0) throw new Error(`The change to ${entry.name} needs a finite value, and a start and duration of zero or more.`);
            const replacement = {
                sharedParameterId: entry.sharedParameterId, name: entry.name, parameter, entity: entry.entity ?? null,
                value: Math.min(Math.max(value, entry.minimum ?? -Infinity), entry.maximum ?? Infinity), at: delay, duration, baseValue: entry.value ?? 0
            };
            if (at >= 0) result[at] = replacement; else result.push(replacement);
        }
    }
    return result;
}

// Samples of the forked branch as one continuous history: the parent's samples before the fork, then
// the child's from the fork on (the child's first sample is the fork point itself).
export function composeBranchSamples(parentSamples, childSamples, forkTime) {
    return [...parentSamples.filter((sample) => sample.time < forkTime - 1e-9), ...childSamples];
}

// { nodeName: { stateSymbol: [[time, value], ...] } } for the requested symbols, from a list of samples.
export function extractSeries(samples, document, symbols, maximumPoints = 400) {
    const stride = Math.max(1, Math.ceil(samples.length / maximumPoints));
    const picked = samples.filter((_sample, index) => index % stride === 0 || index === samples.length - 1);
    const series = {};
    for (const node of document.nodes) {
        for (const state of node.states) {
            if (!symbols.includes(state.symbol)) continue;
            series[node.name] ??= {};
            series[node.name][state.symbol] = picked.map((sample) => [sample.time, sample.states.find((item) => item.stateId === state.id)?.value ?? null]);
        }
    }
    return series;
}

// One baseline per run length, kept in the launcher's workspace. Runs that ask for it at the same time share one engine
// run, and a run that needs a different length waits for the one in progress. Changing the length replaces the
// baseline, so a batch of runs must all use the same length. `run(contentText, config)` runs the model to the end and
// answers { result, resultPath, cleanup } (the host's is the engine; a test's may be anything).
export async function ensureBaseline(workspace, runTime, notify, run) {
    for (;;) {
        if (workspace.baseline?.runTime === runTime) return workspace.baseline;
        const pending = workspace.baselinePending;
        if (!pending) break;
        if (pending.runTime === runTime) return pending.promise;
        await pending.promise.catch(() => {});
    }
    if (workspace.baseline) await Promise.all([workspace.baseline.cleanup?.()].filter(Boolean));
    workspace.baseline = null;
    const { document, contentText } = workspace.imported;
    const configuration = document.runConfigurations[0];
    const config = { name: 'Baseline', targetTime: runTime, globalTimeStep: configuration.globalTimeStep, outputInterval: configuration.outputInterval };
    notify({ stage: 'baseline', message: 'Running the baseline…' });
    const entry = { runTime, promise: null };
    entry.promise = (async () => {
        const result = await run(contentText, config);
        workspace.baseline = { runTime, config, uuid: globalThis.crypto.randomUUID(), ...result };
        return workspace.baseline;
    })().finally(() => { if (workspace.baselinePending === entry) workspace.baselinePending = null; });
    workspace.baselinePending = entry;
    return entry.promise;
}

// The run length of a plain run (runBaseline): the one the window asks for, or else the model's own (its first run
// configuration's target time), checked as a scenario's is. Throws a message a user can act on.
export function baselineRunTime(runTime, document) {
    const configuration = document.runConfigurations?.[0];
    const length = runTime ?? configuration?.targetTime;
    if (length === undefined || length === null) throw new Error('Say how long to run: the model has no run length of its own.');
    return checkRunLength(length, 0, configuration?.globalTimeStep);
}

// The kept checkpoint nearest the time a scenario forks at (one is kept per output interval).
export function nearestCheckpoint(checkpoints, forkAt) {
    return checkpoints.reduce((closest, candidate) => (Math.abs(candidate.time - forkAt) < Math.abs(closest.time - forkAt) ? candidate : closest));
}

const csvField = (value) => (/[",\n\r]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value));

// Long-format results, one row per branch, time, node and state: easy to pivot in a spreadsheet.
export function resultsToCsv(branches, document) {
    const lines = ['branch,time,node,state,unit,value'];
    for (const branch of branches) {
        for (const sample of branch.samples) {
            const values = new Map(sample.states.map((item) => [item.stateId, item.value]));
            for (const node of document.nodes) {
                for (const state of node.states) {
                    if (!values.has(state.id)) continue;
                    lines.push([branch.label, sample.time, node.name, state.name, state.unit ?? '', values.get(state.id)].map(csvField).join(','));
                }
            }
        }
    }
    return `${lines.join('\n')}\n`;
}

// The record that lets a result be reproduced and explained: what produced it, from which inputs, with
// what changes. Plain JSON, so it can be attached to a report and compared between runs.
export function runManifest({ modelSha256, appVersion, addon, importerId, importerOptions = null, overrides = null, inputs, document, config, scenario, chosenEntity, interventions, files }) {
    return {
        manifestVersion: 1,
        createdAt: new Date().toISOString(),
        konjugate: { version: appVersion },
        package: { addonId: addon.addonId, name: addon.name, version: addon.version, importerId },
        // What the window asked for beyond the declared scenario: the options the importer was given, and the changes made to the
        // scenario's interventions. Absent when nothing was changed, so a run as declared records exactly what it always did.
        ...(importerOptions && Object.keys(importerOptions).length ? { importerOptions } : {}),
        ...(overrides && Object.keys(overrides).length ? { overrides } : {}),
        inputs: inputs.map(({ role, name, sha256: hash, bytes, url, retrievedAt }) => ({ role, name, sha256: hash, bytes, ...(url ? { url, retrievedAt } : {}) })),
        model: { sha256: modelSha256, nodes: document.nodes.length, edges: document.edges.length },
        runConfiguration: config,
        scenario: scenario ? {
            scenarioId: scenario.scenarioId, name: scenario.name, description: scenario.description, forkAt: scenario.forkAt,
            chosenEntity: chosenEntity ?? null, interventions
        } : null,
        files
    };
}
