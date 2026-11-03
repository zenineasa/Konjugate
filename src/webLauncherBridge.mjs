/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What a launcher add-on may ask of the page in the web edition (docs/proposals/webEditionPackages.md, stage 5). Like the visualizer's
// (webAddonBridge.mjs) it is the only way out of the add-on's sandboxed frame, and it checks every request against the permissions the
// person approved and the ids the manifest declared, as the desktop's handlers in launcherHost.mjs do; every method answers
// { ok: true, ... } or { ok: false, message }. This first slice of launchers can bring in files, run a declared importer, open the model it
// built in the canvas, run a plain baseline and its declared scenarios, export their results, open a declared help page and open a link on a declared host. What
// needs more (fetching from the network, stored files, inference, kept sessions) is turned away at install, and a method
// for it answers that it is not available here.
// No DOM and no storage in this module: the page gives it `host` callbacks.

import { addressAllowed, checkedProgress, decodeText, importerInputs, maximumInputBytes, maximumOptionsBytes } from './launcherImport.mjs';
import { applyOverrides, baselineRunTime, checkForkTime, checkRunLength, composeBranchSamples, ensureBaseline, extractSeries, resolveInterventions, resultsToCsv, runManifest } from './launcherRuns.mjs';
import { runScenarioFork } from './webLauncherRuns.mjs';

// Of the permissions a launcher may ask for (addonHost.mjs), the ones this slice can honour, and the optional behaviours it can offer.
export const webLauncherPermissions = new Set(['data.import', 'scenario.run', 'results.export', 'model.open', 'pages.open', 'links.open']);
export const webLauncherFeatures = new Set(['importProgress', 'scenarioOverrides', 'scenarioForkTime', 'baselineRun', 'suppliedPerParameter', 'parameterSchedules', 'scenarioEveryBackend', 'runRecord']);

const notYet = (what) => `${what} is not available in the web edition yet. It works in the desktop app.`;

// The reason the web edition cannot run this launcher, or null when it can. `manifest` has already passed validateLauncherManifest.
export function webLauncherRefusal(manifest) {
    const unavailable = (manifest.permissions ?? []).filter((permission) => !webLauncherPermissions.has(permission));
    if (unavailable.length) return `This launcher asks for ${unavailable.join(', ')}, which the web edition cannot give an add-on yet. It works in the desktop app.`;
    const needs = (manifest.requires ?? []).filter((feature) => !webLauncherFeatures.has(feature));
    if (needs.length) return `This launcher needs ${needs.join(', ')}, which the web edition does not provide yet. It works in the desktop app.`;
    const importers = manifest.contributes?.importers ?? [];
    if (importers.some((importer) => importer.files.some((file) => file.binary))) return 'This launcher reads large binary files, which the web edition cannot give an importer yet. It works in the desktop app.';
    return null;
}

const unavailableMethods = {
    fetchText: 'Fetching from the internet', fetchFile: 'Fetching from the internet', cacheInfo: 'The download cache', clearCache: 'The download cache',
    keepSession: 'Keeping a session with the project', restoreSession: 'Keeping a session with the project', reloadFiles: 'Reloading files',
    infer: 'Inference',
    checkPython: 'Checking Python', storedFiles: 'Stored files', storeFiles: 'Stored files', downloadFile: 'Downloads', cancelDownload: 'Downloads',
    partialDownloads: 'Downloads', discardPartialDownload: 'Downloads', fileSize: 'Downloads', describeStoredFile: 'Stored files',
    removeStoredFile: 'Stored files', useStoredFiles: 'Stored files'
};

// `host`: { readPackageFile(path) -> Uint8Array | null, chooseFiles(file) -> [{ name, bytes }] | null, runImporter({ importer, files, options, onProgress }) ->
// the importer's checked result, runModel({ content, config, commands }) -> the engine's decoded result, canSendCommands (whether runModel can
// take commands), sha256(bytes) -> hex, appVersion, encodeModel(content) -> the model as project-file bytes, saveFiles(name, { fileName: text | bytes })
// -> hands the person those files together, openProject({ content, suggestedFilename, silent, addonName, focus, branches: [{ result, branchUuid, parentBranchUuid, forkTime, label }] }), openPage(page), openLink(href), emit(channel, payload) }.
export function createLauncherBridge({ manifest, host }) {
    const contributes = manifest.contributes ?? {};
    const permitted = new Set(manifest.permissions ?? []);
    const needs = (permission) => { if (!permitted.has(permission)) throw new Error(`This launcher was not granted ${permission}.`); };
    const declared = (list, key, id, description) => {
        const item = (list ?? []).find((candidate) => candidate[key] === id);
        if (!item) throw new Error(`The launcher named an undeclared ${description}.`);
        return item;
    };
    const workspace = { pending: new Map(), imported: null, baseline: null, baselinePending: null, scenarios: new Map() };
    // What was run belongs to the model it was run from: a new import, or the files changing, drops it.
    const releaseRuns = () => { workspace.baseline = null; workspace.baselinePending = null; workspace.scenarios.clear(); };
    const notify = (progress) => host.emit('launcherProgress', progress);
    // A pending file is kept under its role, or under role and name for a role that accepts several files.
    const pendingKey = (file, name) => (file.multiple ? `${file.role}::${name}` : file.role);
    const dropRole = (file) => { for (const [key, item] of workspace.pending) if (item.role === file.role) workspace.pending.delete(key); };
    const sampleName = (path) => path.split('/').pop();

    // The baseline of a run length (ensureBaseline), run by the engine: the model from its start, with its checkpoints kept to fork from.
    const baselineOf = (runTime) => ensureBaseline(workspace, runTime, notify, async (contentText, config) => ({ result: await host.runModel({ content: contentText, config, commands: [] }) }));

    const handlers = {
        getManifest: () => {
            const multiple = new Set((contributes.importers ?? []).flatMap((importer) => importer.files.filter((file) => file.multiple).map((file) => file.role)));
            const files = {};
            for (const file of workspace.pending.values()) {
                const summary = { name: file.name, bytes: file.bytes, sample: file.sample, fetched: false };
                if (multiple.has(file.role)) (files[file.role] ??= []).push(summary);
                else files[file.role] = summary;
            }
            return {
                addonId: manifest.addonId, name: manifest.name, version: manifest.version, network: { hosts: manifest.network?.hosts ?? [] },
                importers: (contributes.importers ?? []).map(({ importerId, name, guide, files: roles }) => ({
                    importerId, name, guide: guide ?? null,
                    files: roles.map(({ role, label, required = false, description = '', accept = ['csv'], sample, multiple: several = false, binary = false }) => ({ role, label, required, description, accept, multiple: several, binary, hasSample: Boolean(sample) }))
                })),
                scenarios: (contributes.scenarios ?? []).map(({ scenarioId, name, description, forkAt, runTime, choose, effects, interventions }) => ({ scenarioId, name, description, forkAt, runTime, choose: choose ?? null, effects: effects ?? [], interventions: (interventions ?? []).map(({ parameter, target, value, fractionOfMaximum, at, duration }) => ({ parameter, target, value: value ?? null, fractionOfMaximum: fractionOfMaximum ?? null, at: at ?? 0, duration: duration ?? 0 })) })),
                pages: (contributes.pages ?? []).map(({ pageId, label }) => ({ pageId, label })),
                files,
                imported: workspace.imported ? { importerId: workspace.imported.importerId, report: workspace.imported.report, entities: workspace.imported.entities } : null
            };
        },
        chooseFile: async ({ importerId, role }) => {
            needs('data.import');
            const importer = declared(contributes.importers, 'importerId', importerId, 'importer');
            const file = declared(importer.files, 'role', role, 'file role');
            const chosen = await host.chooseFiles({ ...file, extensions: file.accept ?? ['csv'] });
            if (!chosen?.length) return { chosen: false };
            const taken = file.multiple ? chosen : chosen.slice(0, 1);
            for (const item of taken) if (item.bytes.length > maximumInputBytes) throw new Error(`${item.name} is larger than the ${maximumInputBytes / 1024 / 1024} MB limit.`);
            if (!file.multiple) dropRole(file);
            for (const item of taken) workspace.pending.set(pendingKey(file, item.name), { role, name: item.name, ...decodeText(item.bytes), sha256: await host.sha256(item.bytes), bytes: item.bytes.length, sample: false });
            workspace.imported = null;
            releaseRuns();
            return { chosen: true, name: taken[0].name, names: taken.map((item) => item.name), bytes: taken[0].bytes.length };
        },
        clearFile: ({ importerId, role, name }) => {
            needs('data.import');
            const importer = declared(contributes.importers, 'importerId', importerId, 'importer');
            const file = declared(importer.files, 'role', role, 'file role');
            if (file.multiple && typeof name === 'string') workspace.pending.delete(pendingKey(file, name));
            else dropRole(file);
            workspace.imported = null;
            releaseRuns();
            return {};
        },
        useSample: async ({ importerId }) => {
            needs('data.import');
            const importer = declared(contributes.importers, 'importerId', importerId, 'importer');
            workspace.pending.clear();
            for (const file of importer.files.filter((item) => item.sample)) {
                for (const sample of [file.sample].flat()) {
                    const bytes = await host.readPackageFile(sample);
                    if (!bytes) throw new Error(`The sample ${sample} is not in the package.`);
                    workspace.pending.set(pendingKey(file, sampleName(sample)), { role: file.role, name: sampleName(sample), ...decodeText(bytes), sha256: await host.sha256(bytes), bytes: bytes.length, sample: true });
                }
            }
            workspace.imported = null;
            releaseRuns();
            return {};
        },
        runImport: async ({ importerId, options = {} }) => {
            needs('data.import');
            const importer = declared(contributes.importers, 'importerId', importerId, 'importer');
            const chosenRoles = new Set([...workspace.pending.values()].map((file) => file.role));
            const missing = importer.files.filter((file) => file.required && !chosenRoles.has(file.role));
            if (missing.length) throw new Error(`Choose ${missing.map((file) => file.label).join(' and ')} first.`);
            if (JSON.stringify(options ?? {}).length > maximumOptionsBytes) throw new Error('The options are larger than the host accepts.');
            const roles = new Set(importer.files.map((file) => file.role));
            const files = importerInputs(workspace.pending.values(), roles, options).map((file) => ({ role: file.role, name: file.name, text: file.text, encoding: file.encoding }));
            const onProgress = (progress) => {
                const checked = checkedProgress(progress);
                if (checked) host.emit('launcherProgress', { stage: 'import', importerId, ...checked });
            };
            const result = await host.runImporter({ importer, files, options: options ?? {}, onProgress });
            // What the importer derived takes the place of the files of those roles.
            if (result.ok && result.derived?.length) {
                for (const role of new Set(result.derived.map((item) => item.role))) dropRole({ role });
                for (const item of result.derived) {
                    const file = importer.files.find((candidate) => candidate.role === item.role);
                    const derivedBytes = new TextEncoder().encode(item.text);
                    workspace.pending.set(pendingKey(file, item.name), { role: item.role, name: item.name, text: item.text, encoding: 'utf-8', sha256: await host.sha256(derivedBytes), bytes: derivedBytes.length, sample: false, ...(item.source ? { source: item.source } : {}) });
                }
                workspace.imported = null;
                releaseRuns();
                if (!result.document) return { imported: false, report: result.report, data: result.data, derived: result.derived.map(({ role, name, text }) => ({ role, name, bytes: new TextEncoder().encode(text).length })) };
            }
            // A first step that returns only data leaves any earlier model alone and builds none.
            if (result.ok && !result.document) return { imported: false, report: result.report, data: result.data };
            if (!result.ok) {
                workspace.imported = null;
                releaseRuns();
                return { imported: false, report: result.report, data: result.data };
            }
            const entities = [...new Set((result.parameterIndex ?? []).map((entry) => entry.entity).filter(Boolean))];
            releaseRuns();
            workspace.imported = { importerId, options: options ?? {}, document: result.document, contentText: JSON.stringify(result.document), parameterIndex: result.parameterIndex ?? [], report: result.report, entities };
            return { imported: true, report: result.report, entities, data: result.data };
        },
        // A plain run of the imported model, as Run is in the canvas: the model run once from its start, its series answered as a scenario's
        // are. It is the baseline a scenario of the same length forks from, so running one after it runs no baseline again.
        runBaseline: async ({ runTime = null, signals = [] } = {}) => {
            needs('scenario.run');
            if (!workspace.imported) throw new Error('Import your data first.');
            const length = baselineRunTime(runTime, workspace.imported.document);
            const baseline = await baselineOf(length);
            notify({ stage: 'done', message: 'Done' });
            return { runTime: length, branches: [{ id: 'baseline', label: 'Baseline', series: extractSeries(baseline.result.samples, workspace.imported.document, signals) }] };
        },
        runScenario: async ({ scenarioId, entity = null, signals = [], runTime = null, forkAt = null, supplied = null, overrides = null, retain = true } = {}) => {
            needs('scenario.run');
            const declaredScenario = declared(contributes.scenarios, 'scenarioId', scenarioId, 'scenario');
            if (!workspace.imported) throw new Error('Import your data first.');
            // The window may choose when the scenario starts and how far ahead to run, and may supply the data a scenario declares it takes.
            // Supplied paths are counted from the fork, wherever it is.
            const chosenFork = forkAt === null ? declaredScenario.forkAt : checkForkTime(forkAt, runTime ?? declaredScenario.runTime);
            if (runTime !== null) checkRunLength(runTime, chosenFork, workspace.imported.document.runConfigurations?.[0]?.globalTimeStep);
            if (supplied !== null && JSON.stringify(supplied).length > maximumOptionsBytes) throw new Error('The supplied data is larger than the host accepts.');
            const scenario = { ...declaredScenario, forkAt: chosenFork, ...(runTime === null ? {} : { runTime }) };
            if (scenario.choose && !workspace.imported.entities.includes(entity)) throw new Error(`Choose ${scenario.choose.label.toLowerCase()} first.`);
            if (overrides !== null && JSON.stringify(overrides).length > maximumOptionsBytes) throw new Error('The changes are larger than the host accepts.');
            const { document, contentText, parameterIndex } = workspace.imported;
            const interventions = applyOverrides(resolveInterventions(scenario, parameterIndex, scenario.choose ? entity : null, supplied), parameterIndex, overrides);
            const baseline = await baselineOf(scenario.runTime);
            notify({ stage: 'scenario', message: `Running “${scenario.name}”…` });
            const { forkTime, child } = await runScenarioFork({ host, document, contentText, config: baseline.config, scenario, interventions, baseline });
            const scenarioSamples = composeBranchSamples(baseline.result.samples, child.result.samples, forkTime);
            // Kept for the export, one per scenario and entity, a later run of the same replacing it.
            if (retain) workspace.scenarios.set(`${scenarioId}|${entity ?? ''}`, { scenarioId, entity, scenario, interventions, overrides, forkTime, samples: scenarioSamples, result: child.result, uuid: globalThis.crypto.randomUUID() });
            notify({ stage: 'done', message: 'Done' });
            return {
                scenarioId, entity, forkTime, runTime: scenario.runTime, interventions,
                branches: [
                    { id: 'baseline', label: 'Baseline', series: extractSeries(baseline.result.samples, document, signals) },
                    { id: 'scenario', label: scenario.name, series: extractSeries(scenarioSamples, document, signals) }
                ]
            };
        },
        // The results as one zip of files, handed to the person (the desktop writes a folder): the long-format results, the window's summary,
        // the imported model, and the run manifest that records what produced them, with the hash and size of each of the others.
        exportResults: async ({ scenarioId = null, summaryCsv = '' } = {}) => {
            needs('results.export');
            if (!workspace.imported) throw new Error('Import your data first.');
            if (!workspace.baseline) throw new Error('Run a scenario first, so there is something to export.');
            const key = scenarioId ? [...workspace.scenarios.keys()].filter((candidate) => candidate.startsWith(`${scenarioId}|`)).at(-1) ?? null : null;
            const run = key ? workspace.scenarios.get(key) : null;
            const { document, contentText } = workspace.imported;
            const branches = [{ label: 'Baseline', samples: workspace.baseline.result.samples }];
            if (run) branches.push({ label: run.scenario.name, samples: run.samples });
            const encoder = new TextEncoder();
            const contents = { 'results.csv': encoder.encode(resultsToCsv(branches, document)) };
            if (summaryCsv) contents['summary.csv'] = encoder.encode(String(summaryCsv).slice(0, 200000));
            // The model alone: the baseline and scenario branches are not carried into it here.
            contents['model.kjt'] = await host.encodeModel(contentText);
            const files = {};
            for (const [name, bytes] of Object.entries(contents)) files[name] = { sha256: await host.sha256(bytes), bytes: bytes.length };
            const manifestBytes = encoder.encode(`${JSON.stringify(runManifest({
                modelSha256: await host.sha256(encoder.encode(contentText)), appVersion: host.appVersion, addon: manifest, importerId: workspace.imported.importerId,
                importerOptions: workspace.imported.options, overrides: run?.overrides ?? null, inputs: [...workspace.pending.values()], document,
                config: workspace.baseline.config, scenario: run?.scenario ?? null, chosenEntity: run?.entity ?? null, interventions: run?.interventions ?? [], files
            }), null, 2)}\n`);
            const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19);
            const folder = `${manifest.name.replaceAll(/[^A-Za-z0-9]+/g, '') || 'results'}-${stamp}`;
            await host.saveFiles(folder, { ...contents, 'run-manifest.json': manifestBytes });
            return { exported: true, folder: `${folder}.zip`, files: [...Object.keys(contents), 'run-manifest.json'] };
        },
        openInCanvas: async ({ scenarioId = null, focus = true, silent = false, session } = {}) => {
            needs('model.open');
            if (!workspace.imported) throw new Error('Import your data first.');
            if (session !== undefined) throw new Error(notYet('Keeping a session with the project'));
            // The project the canvas would hold after these runs: the model with the baseline as its first branch and, when a scenario is named
            // and has been run, its fork from the baseline as a second.
            const branches = [];
            if (workspace.baseline) {
                branches.push({ result: workspace.baseline.result, branchUuid: workspace.baseline.uuid, parentBranchUuid: null, forkTime: null, label: 'Baseline' });
                const key = scenarioId ? [...workspace.scenarios.keys()].filter((candidate) => candidate.startsWith(`${scenarioId}|`)).at(-1) : null;
                const run = key ? workspace.scenarios.get(key) : null;
                if (run) branches.push({ result: run.result, branchUuid: run.uuid, parentBranchUuid: workspace.baseline.uuid, forkTime: run.forkTime, label: run.scenario.name });
            }
            await host.openProject({ content: workspace.imported.contentText, suggestedFilename: `${manifest.name.replaceAll(/[^A-Za-z0-9]+/g, '')}.kjt`, silent, addonName: manifest.name, focus, branches });
            return {};
        },
        openPage: async ({ pageId }) => {
            needs('pages.open');
            const page = declared(contributes.pages, 'pageId', pageId, 'page');
            await host.openPage(page);
            return {};
        },
        openLink: async ({ url }) => {
            needs('links.open');
            const href = addressAllowed(url, manifest.links?.hosts ?? []);
            return { opened: Boolean(await host.openLink(href)) };
        }
    };

    return {
        // A request from the frame, answered { ok: true, ... } or { ok: false, message }, never thrown.
        async call(method, params) {
            try {
                if (typeof method === 'string' && Object.hasOwn(unavailableMethods, method)) throw new Error(notYet(unavailableMethods[method]));
                if (typeof method !== 'string' || !Object.hasOwn(handlers, method)) throw new Error(`Unknown method: ${String(method).slice(0, 60)}.`);
                return { ok: true, ...await handlers[method](params && typeof params === 'object' ? params : {}) };
            } catch (error) {
                return { ok: false, message: String(error?.message ?? error).slice(0, 400) };
            }
        }
    };
}
