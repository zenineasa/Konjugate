/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The host side of launcher add-ons (docs/proposals/launcherAddons.md): a guided starting window that
// can ask the host to run one of its declared importers, run one of its declared scenarios, open the
// result in the canvas, and export it with a provenance manifest. The window never sees a file path,
// a file's contents, or the model: it names declared ids, and this module does the work.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { startEngineRun } from './engineAdapter.mjs';
import { encodeProjectFile } from './projectFile.mjs';

const maximumInputBytes = 10 * 1024 * 1024;
const importerTimeoutMilliseconds = 30000;
const maximumImporterDataBytes = 8 * 1024 * 1024;
const maximumOptionsBytes = 2 * 1024 * 1024;
const maximumFetchBytes = 5 * 1024 * 1024;
const maximumSuppliedSamples = 5000;
const maximumRunTime = 2000;
const maximumFetchedTextBytes = 1024 * 1024;
const fetchTimeoutMilliseconds = 20000;
const maximumRedirects = 3;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Text as a spreadsheet may have saved it: UTF-8 (with or without a byte-order mark), UTF-16 with a mark, or,
// failing a strict UTF-8 read, Windows-1252, which is what Excel writes for "CSV" on Windows. The name of the
// encoding used is returned so the importer can tell the user when it was not UTF-8.
export function decodeText(bytes) {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
    } catch {
        return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
    }
}

// ---- fetching ---------------------------------------------------------------------------------------------

// One HTTPS GET, only to a host the manifest lists, following at most a few redirects and only to listed hosts,
// with a size limit and a time limit. Returns the bytes; throws a message a user can act on.
export async function fetchAllowed({ url, hosts, fetchImpl = globalThis.fetch, userAgent = 'Konjugate' }) {
    const allowed = new Set(hosts.map((host) => host.toLowerCase()));
    let current;
    try { current = new URL(url); } catch { throw new Error('That is not a web address.'); }
    for (let hop = 0; hop <= maximumRedirects; hop += 1) {
        if (current.protocol !== 'https:') throw new Error('Only https addresses can be fetched.');
        if (current.username || current.password) throw new Error('An address with a user name or password cannot be fetched.');
        if (!allowed.has(current.hostname.toLowerCase())) throw new Error(`This window may not connect to ${current.hostname}. It may reach: ${[...allowed].join(', ')}.`);
        let response;
        try {
            response = await fetchImpl(current.href, { redirect: 'manual', headers: { 'User-Agent': userAgent, Accept: '*/*' }, signal: AbortSignal.timeout(fetchTimeoutMilliseconds) });
        } catch (error) {
            throw new Error(error.name === 'TimeoutError' ? `${current.hostname} did not answer within ${fetchTimeoutMilliseconds / 1000} seconds.` : `Could not reach ${current.hostname}. Check the connection.`);
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location) throw new Error(`${current.hostname} redirected without saying where.`);
            current = new URL(location, current);
            continue;
        }
        if (!response.ok) throw new Error(`${current.hostname} answered ${response.status}${response.status === 404 ? ' (not found: check the symbol)' : response.status === 429 ? ' (too many requests: wait a while)' : ''}.`);
        const declared = Number(response.headers.get('content-length'));
        if (declared > maximumFetchBytes) throw new Error('The answer is larger than the size limit.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > maximumFetchBytes) throw new Error('The answer is larger than the size limit.');
        return bytes;
    }
    throw new Error('Too many redirects.');
}

// A name safe to show and to key a file by: no path separators or control characters.
export const safeFileName = (name) => String(name ?? '').replace(/[^\p{L}\p{N} .&()_=^-]+/gu, '_').trim().slice(0, 60);

// ---- importers --------------------------------------------------------------------------------------

// Runs a declared importer over the given files ([{ role, name, text }]) in a worker thread with a time
// limit, and checks the shape of what comes back before anyone uses it.
export function runImporter({ addonDirectory, importer, files, options = {}, timeoutMilliseconds = importerTimeoutMilliseconds }) {
    return new Promise((resolvePromise, reject) => {
        const worker = new Worker(new URL('./importerWorker.mjs', import.meta.url), {
            workerData: { entry: importer.entry, packageRoot: addonDirectory, files, options },
            resourceLimits: { maxOldGenerationSizeMb: 512 }
        });
        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error(`The importer did not finish within ${timeoutMilliseconds / 1000} seconds.`));
        }, timeoutMilliseconds);
        worker.once('message', (message) => {
            clearTimeout(timer);
            worker.terminate();
            if (!message.ok) return reject(new Error(`The importer failed: ${message.message}`));
            const { result } = message;
            if (typeof result?.ok !== 'boolean' || !result.report) return reject(new Error('The importer returned an unexpected result.'));
            // A successful importer returns a model, or only `data` when it is a first step that needs the window to do more
            // (for example run an analysis) before the model can be built.
            if (result.ok && result.data === undefined && (!Array.isArray(result.document?.nodes) || !Array.isArray(result.document?.edges))) return reject(new Error('The importer reported success without a model.'));
            if (result.data !== undefined && JSON.stringify(result.data).length > maximumImporterDataBytes) return reject(new Error('The importer returned more data than a window may receive.'));
            resolvePromise(result);
        });
        worker.once('error', (error) => { clearTimeout(timer); reject(new Error(`The importer failed: ${error.message}`)); });
    });
}

// ---- scenarios --------------------------------------------------------------------------------------

// Turns a declared scenario into concrete parameter changes. A parameter is found by its `key` in the
// importer's parameter index: `chosen` targets the entry belonging to the entity the user picked, `all`
// every entry with that key, `global` the single entity-less entry. Throws a message a user can act on.
export function resolveInterventions(scenario, parameterIndex, chosenEntity, supplied = null) {
    const resolved = [];
    for (const intervention of scenario.interventions) {
        const entries = parameterIndex.filter((entry) => entry.key === intervention.parameter);
        if (intervention.target === 'supplied') {
            const entities = supplied?.entities ?? [];
            if (!entities.length) throw new Error(`The scenario "${scenario.name}" needs the window to supply data.`);
            for (const entity of entities) {
                const entry = entries.find((candidate) => candidate.entity === entity);
                if (!entry) throw new Error(`The scenario "${scenario.name}" changes "${intervention.parameter}", which this model does not have for ${entity}.`);
                if (!entry.live) throw new Error(`"${entry.name}" cannot be changed during a run.`);
                const clamp = (value) => Math.min(Math.max(value, entry.minimum ?? -Infinity), entry.maximum ?? Infinity);
                if (intervention.samples) {
                    const samples = supplied.samples?.[entity];
                    if (!Array.isArray(samples) || samples.length < 2 || samples.length > maximumSuppliedSamples || !samples.every((pair) => Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))) {
                        throw new Error(`The data supplied for ${entity} must be at least two, and at most ${maximumSuppliedSamples}, pairs of time and value.`);
                    }
                    resolved.push({
                        sharedParameterId: entry.sharedParameterId, name: entry.name, parameter: intervention.parameter, entity,
                        samples: samples.map(([time, value]) => ({ time, value: clamp(value) })), at: 0, duration: 0, baseValue: entry.value ?? 0
                    });
                } else {
                    resolved.push({ sharedParameterId: entry.sharedParameterId, name: entry.name, parameter: intervention.parameter, entity, value: clamp(intervention.value), at: intervention.at ?? 0, duration: intervention.duration ?? 0, baseValue: entry.value ?? 0 });
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
export function buildRunManifest({ appVersion, addon, importerId, importerOptions = null, overrides = null, inputs, contentText, document, config, scenario, chosenEntity, interventions, files }) {
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
        model: { sha256: sha256(contentText), nodes: document.nodes.length, edges: document.edges.length },
        runConfiguration: config,
        scenario: scenario ? {
            scenarioId: scenario.scenarioId, name: scenario.name, description: scenario.description, forkAt: scenario.forkAt,
            chosenEntity: chosenEntity ?? null, interventions
        } : null,
        files
    };
}

async function runToCompletion(content, config, engineOptions, prepare) {
    const execution = await startEngineRun(content, config, engineOptions, { retainResult: true });
    if (!execution.available) throw new Error('The simulation engine is unavailable.');
    if (prepare) await prepare(execution);
    const result = await execution.completion;
    return { result, resultPath: execution.resultPath, cleanup: execution.cleanup };
}

// Runs the model once as a baseline (cached by the caller) and once forked from it at the scenario's
// time with its interventions applied: the same fork the canvas makes, headless. The child is started
// paused so every change is in place before its first step (the engine drains queued control commands
// before integrating step 0), exactly as the canvas orders it.
export async function runScenarioBranches({ content, config, scenario, interventions, baseline, engineOptions }) {
    const checkpoint = baseline.result.checkpoints.reduce((closest, candidate) =>
        Math.abs(candidate.time - scenario.forkAt) < Math.abs(closest.time - scenario.forkAt) ? candidate : closest);
    const child = await runToCompletion(content, { ...config, targetTime: scenario.runTime, startCheckpoint: structuredClone(checkpoint) }, engineOptions, async (execution) => {
        await execution.setExecutionState('paused');
        for (const change of interventions) {
            // A path of values is followed as a piecewise schedule, its times counted from the fork; a change with a
            // duration is a pulse that returns to the parameter's base value when it ends.
            const schedule = change.samples
                ? { mode: 'piecewise', samples: change.samples.map((sample) => ({ time: checkpoint.time + sample.time, value: sample.value })), baseValue: change.baseValue ?? 0 }
                : change.duration > 0
                ? { mode: 'pulse', startTime: checkpoint.time + change.at, duration: change.duration, targetValue: change.value, baseValue: change.baseValue ?? 0 }
                : { mode: 'step', startTime: checkpoint.time + change.at, targetValue: change.value };
            await execution.scheduleParameterValue(change.sharedParameterId, schedule);
        }
        await execution.setExecutionState('running');
    });
    return { forkTime: checkpoint.time, child };
}

// ---- window and IPC ---------------------------------------------------------------------------------

export function registerLauncherHandlers(deps) {
    const {
        ipcMain, dialog, BrowserWindow, app, screen, currentDir, iconPath, projectWindows, projectWindowState, installCustomWindowState,
        auxiliaryWindowBounds, auxiliaryWindowPresentation, engineOptions, decodeProjectForRenderer, addonRegistry, inferWithEngine, fetchImpl = (...args) => globalThis.fetch(...args)
    } = deps;
    const workspaces = new Map();

    function launcherContext(event) {
        for (const projectWindow of projectWindows) {
            const state = projectWindowState.get(projectWindow);
            if (state?.launcherWindow && !state.launcherWindow.isDestroyed() && state.launcherWindow.webContents === event.sender) {
                const addon = addonRegistry.get(state.launcherAddonId);
                if (!addon) break;
                return { projectWindow, state, addon, workspace: workspaces.get(event.sender.id) };
            }
        }
        throw new Error('This request did not come from an open launcher window.');
    }
    const can = (addon, permission) => (addon.manifest.permissions ?? []).includes(permission);
    const needs = (addon, permission) => { if (!can(addon, permission)) throw new Error(`This launcher was not granted ${permission}.`); };
    const declared = (list, key, id, description) => {
        const item = (list ?? []).find((candidate) => candidate[key] === id);
        if (!item) throw new Error(`The launcher named an undeclared ${description}.`);
        return item;
    };
    const insidePackage = (addon, relativePath) => {
        const target = resolve(addon.addonDirectory, relativePath);
        if (!target.startsWith(`${resolve(addon.addonDirectory)}${sep}`)) throw new Error('That file lies outside the add-on package.');
        return target;
    };
    // Every handler answers { ok: true, ... } or { ok: false, message }, so the window can show a reason.
    const guarded = (handler) => async (event, request = {}) => {
        try {
            return { ok: true, ...await handler(launcherContext(event), request, event) };
        } catch (error) {
            return { ok: false, message: error.message };
        }
    };
    const releaseRuns = async (workspace) => {
        const runs = [workspace.baseline, ...workspace.scenarios.values()].filter(Boolean);
        workspace.baseline = null;
        workspace.scenarios.clear();
        await Promise.all(runs.flatMap((run) => [run.cleanup?.(), run.child?.cleanup?.()]).filter(Boolean));
    };

    async function openLauncher(projectWindow, addon) {
        const state = projectWindowState.get(projectWindow);
        if (state.launcherWindow && !state.launcherWindow.isDestroyed() && state.launcherAddonId === addon.manifest.addonId) {
            state.launcherWindow.show();
            state.launcherWindow.focus();
            return;
        }
        state.launcherWindow?.destroy();
        state.launcherAddonId = addon.manifest.addonId;
        const window = new BrowserWindow({
            ...auxiliaryWindowBounds(projectWindow, 1180, 800, null, screen),
            minWidth: 900,
            minHeight: 620,
            ...auxiliaryWindowPresentation(projectWindow),
            title: addon.manifest.name,
            icon: iconPath,
            frame: false,
            backgroundColor: '#0b1620',
            webPreferences: {
                preload: join(currentDir, 'launcherPreload.cjs'),
                contextIsolation: true, nodeIntegration: false, sandbox: true
            }
        });
        installCustomWindowState(window);
        state.launcherWindow = window;
        const id = window.webContents.id;
        workspaces.set(id, { pending: new Map(), imported: null, baseline: null, scenarios: new Map() });
        window.on('closed', async () => {
            const workspace = workspaces.get(id);
            workspaces.delete(id);
            if (state.launcherWindow === window) state.launcherWindow = null;
            if (workspace) await releaseRuns(workspace).catch(() => {});
        });
        projectWindow.once('closed', () => { if (!window.isDestroyed()) window.destroy(); });
        await window.loadFile(insidePackage(addon, addon.manifest.entry));
    }

    ipcMain.handle('launcherTitlebarStylesheet', (event) => {
        for (const projectWindow of projectWindows) {
            const state = projectWindowState.get(projectWindow);
            if (state?.launcherWindow && !state.launcherWindow.isDestroyed() && state.launcherWindow.webContents === event.sender) {
                return pathToFileURL(join(currentDir, 'addonTitlebar.css')).href;
            }
        }
        throw new Error('The titlebar stylesheet is available only to a launcher window.');
    });

    ipcMain.handle('launcherGetManifest', guarded(({ addon, workspace }) => {
        const { manifest } = addon;
        const contributes = manifest.contributes ?? {};
        return {
            addonId: manifest.addonId, name: manifest.name, version: manifest.version,
            network: { hosts: manifest.network?.hosts ?? [] },
            importers: (contributes.importers ?? []).map(({ importerId, name, guide, files }) => ({
                importerId, name, guide: guide ?? null,
                files: files.map(({ role, label, required = false, description = '', accept = ['csv'], sample, multiple = false }) => ({ role, label, required, description, accept, multiple, hasSample: Boolean(sample) }))
            })),
            scenarios: (contributes.scenarios ?? []).map(({ scenarioId, name, description, forkAt, runTime, choose, effects, interventions }) => ({ scenarioId, name, description, forkAt, runTime, choose: choose ?? null, effects: effects ?? [], interventions: (interventions ?? []).map(({ parameter, target, value, fractionOfMaximum, at, duration }) => ({ parameter, target, value: value ?? null, fractionOfMaximum: fractionOfMaximum ?? null, at: at ?? 0, duration: duration ?? 0 })) })),
            pages: (contributes.pages ?? []).map(({ pageId, label }) => ({ pageId, label })),
            // One entry per role; a role that accepts several files lists them all.
            files: (() => {
                const chosen = {};
                const multiple = new Set((contributes.importers ?? []).flatMap((importer) => importer.files.filter((file) => file.multiple).map((file) => file.role)));
                for (const file of workspace.pending.values()) {
                    const summary = { name: file.name, bytes: file.bytes, sample: file.sample, fetched: Boolean(file.url) };
                    if (multiple.has(file.role)) (chosen[file.role] ??= []).push(summary);
                    else chosen[file.role] = summary;
                }
                return chosen;
            })(),
            imported: workspace.imported ? { importerId: workspace.imported.importerId, report: workspace.imported.report, entities: workspace.imported.entities } : null
        };
    }));

    // A pending file is kept under its role, or under role and name for a role that accepts several files.
    const pendingKey = (file, name) => (file.multiple ? `${file.role}::${name}` : file.role);
    const dropRole = (workspace, file) => { for (const [key, item] of workspace.pending) if (item.role === file.role) workspace.pending.delete(key); };

    ipcMain.handle('launcherChooseFile', guarded(async ({ addon, workspace, projectWindow, state }, { importerId, role }) => {
        needs(addon, 'data.import');
        const importer = declared(addon.manifest.contributes?.importers, 'importerId', importerId, 'importer');
        const file = declared(importer.files, 'role', role, 'file role');
        const extensions = file.accept ?? ['csv'];
        const chosen = await dialog.showOpenDialog(state.launcherWindow, {
            title: file.label, properties: file.multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters: [{ name: extensions.join(', ').toUpperCase(), extensions }]
        });
        if (chosen.canceled || !chosen.filePaths.length) return { chosen: false };
        const paths = file.multiple ? chosen.filePaths : chosen.filePaths.slice(0, 1);
        const read = [];
        for (const path of paths) {
            const bytes = await readFile(path);
            if (bytes.length > maximumInputBytes) throw new Error(`${basename(path)} is larger than the ${maximumInputBytes / 1024 / 1024} MB limit.`);
            read.push({ path, bytes });
        }
        if (!file.multiple) dropRole(workspace, file);
        for (const { path, bytes } of read) {
            const name = basename(path);
            workspace.pending.set(pendingKey(file, name), { role, name, path, ...decodeText(bytes), sha256: sha256(bytes), bytes: bytes.length, sample: false });
        }
        workspace.imported = null;
        await releaseRuns(workspace);
        return { chosen: true, name: basename(paths[0]), names: paths.map((path) => basename(path)), bytes: read[0].bytes.length };
    }));

    ipcMain.handle('launcherClearFile', guarded(async ({ addon, workspace }, { importerId, role, name }) => {
        needs(addon, 'data.import');
        const importer = declared(addon.manifest.contributes?.importers, 'importerId', importerId, 'importer');
        const file = declared(importer.files, 'role', role, 'file role');
        if (file.multiple && typeof name === 'string') workspace.pending.delete(pendingKey(file, name));
        else dropRole(workspace, file);
        workspace.imported = null;
        await releaseRuns(workspace);
        return {};
    }));

    ipcMain.handle('launcherUseSample', guarded(async ({ addon, workspace }, { importerId }) => {
        needs(addon, 'data.import');
        const importer = declared(addon.manifest.contributes?.importers, 'importerId', importerId, 'importer');
        workspace.pending.clear();
        for (const file of importer.files.filter((item) => item.sample)) {
            for (const sample of [file.sample].flat()) {
                const bytes = await readFile(insidePackage(addon, sample));
                workspace.pending.set(pendingKey(file, basename(sample)), { role: file.role, name: basename(sample), ...decodeText(bytes), sha256: sha256(bytes), bytes: bytes.length, sample: true });
            }
        }
        workspace.imported = null;
        await releaseRuns(workspace);
        return {};
    }));

    // Fetches a page of text from a listed host and hands it to the window, for a launcher that needs an answer to show
    // (a symbol search, say) rather than a file to read. Same hosts, https, size and time limits as a file fetch.
    ipcMain.handle('launcherFetchText', guarded(async ({ addon }, { url }) => {
        needs(addon, 'network.fetch');
        const bytes = await fetchAllowed({ url, hosts: addon.manifest.network?.hosts ?? [], fetchImpl, userAgent: `Konjugate/${app.getVersion()}` });
        if (bytes.length > maximumFetchedTextBytes) throw new Error('The answer is larger than a window may receive as text.');
        return { text: new TextDecoder().decode(bytes) };
    }));

    // Fetches a file from the internet into a file role, from a host the manifest names. The bytes go through the
    // same reading as a chosen file, and the address and time are kept for the run manifest.
    ipcMain.handle('launcherFetchFile', guarded(async ({ addon, workspace }, { importerId, role, url, name }) => {
        needs(addon, 'network.fetch');
        needs(addon, 'data.import');
        const importer = declared(addon.manifest.contributes?.importers, 'importerId', importerId, 'importer');
        const file = declared(importer.files, 'role', role, 'file role');
        const fileName = safeFileName(name);
        if (!fileName) throw new Error('Give the series a name.');
        const bytes = await fetchAllowed({ url, hosts: addon.manifest.network?.hosts ?? [], fetchImpl, userAgent: `Konjugate/${app.getVersion()}` });
        if (!file.multiple) dropRole(workspace, file);
        workspace.pending.set(pendingKey(file, fileName), { role, name: fileName, url, retrievedAt: new Date().toISOString(), ...decodeText(bytes), sha256: sha256(bytes), bytes: bytes.length, sample: false });
        workspace.imported = null;
        await releaseRuns(workspace);
        return { name: fileName, bytes: bytes.length };
    }));

    // Reads the chosen files from disk again, for data that another program keeps up to date. Sample files are
    // packaged and never change. Answers how many files changed.
    ipcMain.handle('launcherReloadFiles', guarded(async ({ addon, workspace }, { importerId }) => {
        needs(addon, 'data.import');
        declared(addon.manifest.contributes?.importers, 'importerId', importerId, 'importer');
        let changed = 0;
        const missing = [];
        for (const [key, file] of workspace.pending) {
            if (file.sample || (!file.path && !file.url)) continue;
            let bytes;
            try { bytes = file.url ? await fetchAllowed({ url: file.url, hosts: addon.manifest.network?.hosts ?? [], fetchImpl, userAgent: `Konjugate/${app.getVersion()}` }) : await readFile(file.path); } catch { missing.push(file.name); continue; }
            if (bytes.length > maximumInputBytes) throw new Error(`${file.name} is larger than the ${maximumInputBytes / 1024 / 1024} MB limit.`);
            const hash = sha256(bytes);
            if (hash === file.sha256) continue;
            workspace.pending.set(key, { ...file, ...decodeText(bytes), sha256: hash, bytes: bytes.length, ...(file.url ? { retrievedAt: new Date().toISOString() } : {}) });
            changed += 1;
        }
        if (changed) { workspace.imported = null; await releaseRuns(workspace); }
        return { changed, missing };
    }));

    // Causal inference on a table the launcher supplies, for a launcher that builds its own model from data. The
    // CSV is Konjugate's inference format: a numeric, regularly spaced time column, then one column per series.
    ipcMain.handle('launcherInfer', guarded(async ({ addon }, { csv, config = {} }) => {
        needs(addon, 'analysis.infer');
        if (typeof csv !== 'string' || !csv.length) throw new Error('Provide the table as CSV text.');
        const result = await inferWithEngine(csv, config, await engineOptions());
        if (!result.available) throw new Error('The inference engine is not available.');
        return { edges: result.report.edges ?? [], selfTerms: result.report.selfTerms ?? [] };
    }));

    ipcMain.handle('launcherRunImport', guarded(async ({ addon, workspace }, { importerId, options = {} }) => {
        needs(addon, 'data.import');
        const importer = declared(addon.manifest.contributes?.importers, 'importerId', importerId, 'importer');
        const chosenRoles = new Set([...workspace.pending.values()].map((file) => file.role));
        const missing = importer.files.filter((file) => file.required && !chosenRoles.has(file.role));
        if (missing.length) throw new Error(`Choose ${missing.map((file) => file.label).join(' and ')} first.`);
        const roles = new Set(importer.files.map((file) => file.role));
        const files = [...workspace.pending.values()].filter((file) => roles.has(file.role)).map(({ role, name, text, encoding }) => ({ role, name, text, encoding }));
        if (JSON.stringify(options ?? {}).length > maximumOptionsBytes) throw new Error('The options are larger than the host accepts.');
        const result = await runImporter({ addonDirectory: addon.addonDirectory, importer, files, options: options ?? {} });
        // A first step that returns only data leaves any earlier model alone and builds none.
        if (result.ok && !result.document) return { imported: false, report: result.report, data: result.data };
        await releaseRuns(workspace);
        if (!result.ok) {
            workspace.imported = null;
            return { imported: false, report: result.report, data: result.data };
        }
        const contentText = JSON.stringify(result.document);
        const entities = [...new Set((result.parameterIndex ?? []).map((entry) => entry.entity).filter(Boolean))];
        workspace.imported = { importerId, options: options ?? {}, document: result.document, contentText, parameterIndex: result.parameterIndex ?? [], report: result.report, entities };
        return { imported: true, report: result.report, entities, data: result.data };
    }));

    // One baseline per run length. Runs that ask for it at the same time share one engine run, and a run that needs a different length waits
    // for the one in progress. Changing the length replaces the baseline, so a batch of runs must all use the same length.
    async function ensureBaseline(workspace, runTime, notify) {
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
            const run = await runToCompletion(contentText, config, await engineOptions());
            workspace.baseline = { runTime, config, uuid: randomUUID(), ...run };
            return workspace.baseline;
        })().finally(() => { if (workspace.baselinePending === entry) workspace.baselinePending = null; });
        workspace.baselinePending = entry;
        return entry.promise;
    }

    ipcMain.handle('launcherRunScenario', guarded(async ({ addon, workspace, state }, { scenarioId, entity = null, signals = [], runTime = null, supplied = null, overrides = null, retain = true }) => {
        needs(addon, 'scenario.run');
        const declaredScenario = declared(addon.manifest.contributes?.scenarios, 'scenarioId', scenarioId, 'scenario');
        if (!workspace.imported) throw new Error('Import your data first.');
        // The window may choose how far ahead to run, and may supply the data a scenario declares it takes.
        if (runTime !== null && !(Number.isFinite(runTime) && runTime > declaredScenario.forkAt && runTime <= maximumRunTime)) throw new Error(`The run length must be more than ${declaredScenario.forkAt} and at most ${maximumRunTime}.`);
        if (supplied !== null && JSON.stringify(supplied).length > maximumOptionsBytes) throw new Error('The supplied data is larger than the host accepts.');
        const scenario = { ...declaredScenario, ...(runTime === null ? {} : { runTime }) };
        if (scenario.choose && !workspace.imported.entities.includes(entity)) throw new Error(`Choose ${scenario.choose.label.toLowerCase()} first.`);
        const notify = (progress) => { if (state.launcherWindow && !state.launcherWindow.isDestroyed()) state.launcherWindow.webContents.send('launcherProgress', progress); };
        if (overrides !== null && JSON.stringify(overrides).length > maximumOptionsBytes) throw new Error('The changes are larger than the host accepts.');
        const interventions = applyOverrides(resolveInterventions(scenario, workspace.imported.parameterIndex, scenario.choose ? entity : null, supplied), workspace.imported.parameterIndex, overrides);
        const { document, contentText } = workspace.imported;
        const baseline = await ensureBaseline(workspace, scenario.runTime, notify);
        notify({ stage: 'scenario', message: `Running “${scenario.name}”…` });
        const key = `${scenarioId}|${entity ?? ''}`;
        // A run that is not retained (one of many in a batch) is summarized and then released, so a batch does not keep a result file each.
        const previous = retain ? workspace.scenarios.get(key) : null;
        if (previous) await previous.child.cleanup?.();
        const { forkTime, child } = await runScenarioBranches({ content: contentText, config: baseline.config, scenario, interventions, baseline, engineOptions: await engineOptions() });
        const scenarioSamples = composeBranchSamples(baseline.result.samples, child.result.samples, forkTime);
        if (retain) workspace.scenarios.set(key, { scenarioId, entity, scenario, interventions, overrides, forkTime, child, samples: scenarioSamples, uuid: randomUUID() });
        const answer = {
            scenarioId, entity, forkTime, runTime: scenario.runTime, interventions,
            branches: [
                { id: 'baseline', label: 'Baseline', series: extractSeries(baseline.result.samples, document, signals) },
                { id: 'scenario', label: scenario.name, series: extractSeries(scenarioSamples, document, signals) }
            ]
        };
        if (!retain) await child.cleanup?.();
        notify({ stage: 'done', message: 'Done' });
        return answer;
    }));

    // The project the canvas would hold after these runs: the model with a baseline branch and, when a
    // scenario has run, its forked branch, exactly as the canvas's own Fork here would have built it.
    async function buildProject(workspace, scenarioKey) {
        const { contentText } = workspace.imported;
        const branches = [];
        if (workspace.baseline) branches.push({ buffer: await readFile(workspace.baseline.resultPath), branchUuid: workspace.baseline.uuid, parentBranchUuid: null, forkTime: null, label: 'Baseline' });
        const run = scenarioKey ? workspace.scenarios.get(scenarioKey) : null;
        if (run && workspace.baseline) {
            branches.push({ buffer: await readFile(run.child.resultPath), branchUuid: run.uuid, parentBranchUuid: workspace.baseline.uuid, forkTime: run.forkTime, label: run.scenario.name });
        }
        return encodeProjectFile(contentText, { resultBranches: branches.length ? branches : null });
    }
    const keyFor = (workspace, scenarioId) => {
        if (!scenarioId) return null;
        const matches = [...workspace.scenarios.keys()].filter((key) => key.startsWith(`${scenarioId}|`));
        return matches.at(-1) ?? null;
    };

    ipcMain.handle('launcherOpenInCanvas', guarded(async ({ addon, workspace, projectWindow }, { scenarioId = null, focus = true, silent = false }) => {
        needs(addon, 'model.open');
        if (!workspace.imported) throw new Error('Import your data first.');
        const payload = await decodeProjectForRenderer(await buildProject(workspace, keyFor(workspace, scenarioId)));
        if (projectWindow.isDestroyed()) throw new Error('The project window has been closed.');
        projectWindow.webContents.send('launcherOpenProject', { ...payload, silent, suggestedFilename: `${addon.manifest.name.replaceAll(/[^A-Za-z0-9]+/g, '')}.kjt` });
        if (focus) {
            projectWindow.show();
            projectWindow.focus();
        }
        return {};
    }));

    ipcMain.handle('launcherExportResults', guarded(async ({ addon, workspace, state }, { scenarioId = null, summaryCsv = '' }) => {
        needs(addon, 'results.export');
        if (!workspace.imported) throw new Error('Import your data first.');
        if (!workspace.baseline) throw new Error('Run a scenario first, so there is something to export.');
        const scenarioKey = keyFor(workspace, scenarioId);
        const run = scenarioKey ? workspace.scenarios.get(scenarioKey) : null;
        const chosen = await dialog.showOpenDialog(state.launcherWindow, { title: 'Choose a folder for the results', properties: ['openDirectory', 'createDirectory'] });
        if (chosen.canceled || !chosen.filePaths[0]) return { exported: false };
        const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19);
        const folder = join(chosen.filePaths[0], `stress-test-${stamp}`);
        await mkdir(folder, { recursive: true });
        const { document, contentText } = workspace.imported;
        const branches = [{ label: 'Baseline', samples: workspace.baseline.result.samples }];
        if (run) branches.push({ label: run.scenario.name, samples: run.samples });
        const written = {};
        const put = async (name, data) => { await writeFile(join(folder, name), data); written[name] = { sha256: sha256(data), bytes: Buffer.byteLength(data) }; };
        await put('results.csv', resultsToCsv(branches, document));
        if (summaryCsv) await put('summary.csv', String(summaryCsv).slice(0, 200000));
        await put('project.kjt', await buildProject(workspace, scenarioKey));
        const manifest = buildRunManifest({
            appVersion: app.getVersion(), addon: addon.manifest, importerId: workspace.imported.importerId,
            importerOptions: workspace.imported.options, overrides: run?.overrides ?? null,
            inputs: [...workspace.pending.values()], contentText, document, config: workspace.baseline.config,
            scenario: run?.scenario ?? null, chosenEntity: run?.entity ?? null,
            interventions: run?.interventions ?? [], files: written
        });
        await writeFile(join(folder, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        return { exported: true, folder, files: [...Object.keys(written), 'run-manifest.json'] };
    }));

    ipcMain.handle('launcherOpenPage', guarded(async ({ addon, state }, { pageId }) => {
        needs(addon, 'pages.open');
        const page = declared(addon.manifest.contributes?.pages, 'pageId', pageId, 'page');
        const target = insidePackage(addon, page.entry);
        state.launcherPages ??= new Map();
        const existing = state.launcherPages.get(pageId);
        if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return {}; }
        const window = new BrowserWindow({
            width: 860, height: 760, title: page.label, icon: iconPath, backgroundColor: '#f5f3ee', autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
        });
        window.setMenu(null);
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (navigation) => navigation.preventDefault());
        state.launcherPages.set(pageId, window);
        window.on('closed', () => state.launcherPages.delete(pageId));
        await window.loadFile(target);
        return {};
    }));

    return { openLauncher };
}
