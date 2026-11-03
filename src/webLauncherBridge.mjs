/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What a launcher add-on may ask of the page in the web edition (docs/proposals/webEditionPackages.md, stage 5). Like the visualizer's
// (webAddonBridge.mjs) it is the only way out of the add-on's sandboxed frame, and it checks every request against the permissions the
// person approved and the ids the manifest declared, as the desktop's handlers in launcherHost.mjs do; every method answers
// { ok: true, ... } or { ok: false, message }. This first slice of launchers can bring in files, run a declared importer, open the model it
// built in the canvas, run a plain baseline and its declared scenarios, export their results, keep its session with the project it opens, fetch from the hosts it declares (a server that does not allow web pages
// to read it fails with a message saying so), open a declared help page and open a link on a declared host. What
// needs more (the download cache, stored files, inference, kept sessions) is turned away at install, and a method
// for it answers that it is not available here.
// No DOM and no storage in this module: the page gives it `host` callbacks.

import { maximumAgeDaysLimit } from './addonCacheLimits.mjs';
import { addressAllowed, checkedProgress, decodeText, importerInputs, maximumFetchedTextBytes, maximumInputBytes, maximumOptionsBytes, safeFileName } from './launcherImport.mjs';
import { binaryChoice, maximumBinaryInputBytes, storedFileKinds } from './launcherFiles.mjs';
import { applyOverrides, baselineRunTime, checkForkTime, checkRunLength, composeBranchSamples, ensureBaseline, extractSeries, resolveInterventions, resultsToCsv, runManifest } from './launcherRuns.mjs';
import { attachAddonData, buildSessionEntry, sessionInputs } from './launcherSession.mjs';
import { runScenarioFork } from './webLauncherRuns.mjs';

// Of the permissions a launcher may ask for (addonHost.mjs), the ones this slice can honour, and the optional behaviours it can offer.
export const webLauncherPermissions = new Set(['data.import', 'scenario.run', 'results.export', 'model.open', 'pages.open', 'links.open', 'network.fetch', 'project.data', 'files.store']);
export const webLauncherFeatures = new Set(['importProgress', 'scenarioOverrides', 'scenarioForkTime', 'baselineRun', 'suppliedPerParameter', 'parameterSchedules', 'scenarioEveryBackend', 'runRecord', 'projectSession', 'keepSession', 'openLink', 'fetchCache', 'binaryInputs', 'multipleBinaryInputs', 'storedFiles', 'resumableDownloads']);

const notYet = (what) => `${what} is not available in the web edition yet. It works in the desktop app.`;

// The reason the web edition cannot run this launcher, or null when it can. `manifest` has already passed validateLauncherManifest.
export function webLauncherRefusal(manifest) {
    const unavailable = (manifest.permissions ?? []).filter((permission) => !webLauncherPermissions.has(permission));
    if (unavailable.length) return `This launcher asks for ${unavailable.join(', ')}, which the web edition cannot give an add-on yet. It works in the desktop app.`;
    const needs = (manifest.requires ?? []).filter((feature) => !webLauncherFeatures.has(feature));
    if (needs.length) return `This launcher needs ${needs.join(', ')}, which the web edition does not provide yet. It works in the desktop app.`;
    return null;
}

const unavailableMethods = {
    infer: 'Inference', checkPython: 'Checking Python'
};

// `host`: { readPackageFile(path) -> Uint8Array | null, chooseFiles(file) -> [{ name, bytes }] | null (for a binary role [{ name, size, read() -> Uint8Array }]), runImporter({ importer, files, options, onProgress }) ->
// the importer's checked result, runModel({ content, config, commands }) -> the engine's decoded result, canSendCommands (whether runModel can
// take commands), sha256(bytes) -> hex, appVersion, encodeModel(content) -> the model as project-file bytes, saveFiles(name, { fileName: text | bytes })
// -> hands the person those files together, files() and cache() -> the add-on's store of stored files (webFileStore.mjs) and its fetch cache (webFileCache.mjs), pickFiles({ title, extensions }) -> File[] | null, keepAddonData(addonId, entry) (null removes) and requestAddonData(addonId) -> the entry the open project keeps for the add-on, or null, fetchBytes(href, hosts) -> the bytes of an answer from a listed host (webFetch.mjs), openProject({ content, suggestedFilename, silent, addonName, focus, branches: [{ result, branchUuid, parentBranchUuid, forkTime, label }] }), openPage(page), openLink(href), emit(channel, payload) }.
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
    const hosts = manifest.network?.hosts ?? [];
    const sampleName = (path) => path.split('/').pop();

    // The baseline of a run length (ensureBaseline), run by the engine: the model from its start, with its checkpoints kept to fork from.
    const baselineOf = (runTime) => ensureBaseline(workspace, runTime, notify, async (contentText, config) => ({ result: await host.runModel({ content: contentText, config, commands: [] }) }));

    // What the launcher keeps with a project: its window's state and the input files the model was built from (launcherSession.mjs).
    const sessionEntry = (session) => { needs('project.data'); return buildSessionEntry({ addon: manifest, window: session, inputs: [...workspace.pending.values()] }); };

    const downloads = new Map(); // a window's download id -> its AbortController
    // A window sees an entry without the bytes behind it.
    const shown = ({ blob, ...entry }) => entry;

    const handlers = {
        getManifest: () => {
            const multiple = new Set((contributes.importers ?? []).flatMap((importer) => importer.files.filter((file) => file.multiple).map((file) => file.role)));
            const files = {};
            for (const file of workspace.pending.values()) {
                const summary = { name: file.name, bytes: file.bytes, sample: file.sample, fetched: Boolean(file.url), ...(file.binary ? { binary: true } : {}), ...(file.source ? { derivedFrom: file.source } : {}) };
                if (multiple.has(file.role)) (files[file.role] ??= []).push(summary);
                else files[file.role] = summary;
            }
            return {
                addonId: manifest.addonId, name: manifest.name, version: manifest.version, network: { hosts },
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
        // A page of text from a listed host, for a window that needs an answer to show (a symbol search) rather than a file to read.
        fetchText: async ({ url } = {}) => {
            needs('network.fetch');
            const bytes = await host.fetchBytes(addressAllowed(url, hosts), hosts);
            if (bytes.length > maximumFetchedTextBytes) throw new Error('The answer is larger than a window may receive as text.');
            return { text: new TextDecoder().decode(bytes) };
        },
        // A file from a listed host into a file role, read as a chosen file is; its address and time are kept for the run manifest.
        //
        // With `cache: 'use'` (and `requires: ["fetchCache"]`), an answer fetched from the same address within `maximumAgeDays` (30 by default) is
        // read from the add-on's cache instead, and a fresh one is kept there; `cache: 'refresh'` always fetches and keeps the answer; `cache: 'off'`
        // (the default) neither reads nor keeps. The file's `retrievedAt` is when it was really fetched, whichever way it came.
        fetchFile: async ({ importerId, role, url, name, cache = 'off', maximumAgeDays = null }) => {
            needs('network.fetch');
            needs('data.import');
            const importer = declared(contributes.importers, 'importerId', importerId, 'importer');
            const file = declared(importer.files, 'role', role, 'file role');
            const fileName = safeFileName(name);
            if (!fileName) throw new Error('Give the series a name.');
            if (!['off', 'use', 'refresh'].includes(cache)) throw new Error('A fetch is cached with use, refresh or off.');
            const href = addressAllowed(url, hosts);
            const store = cache === 'off' ? null : await host.cache();
            const age = Number(maximumAgeDays) > 0 ? Math.min(Number(maximumAgeDays), maximumAgeDaysLimit) : undefined;
            // The address is checked before the cache is read, as it is before a fetch.
            const hit = cache === 'use' ? await store.get(href, { maximumAgeDays: age }) : null;
            let bytes;
            let retrievedAt;
            if (hit) {
                bytes = hit.bytes;
                retrievedAt = hit.retrievedAt;
            } else {
                bytes = await host.fetchBytes(href, hosts);
                retrievedAt = new Date().toISOString();
                // A cache that cannot be written (a full disk) never stops a fetch.
                if (store) await store.put(href, bytes, { retrievedAt }).catch(() => {});
            }
            if (!file.multiple) dropRole(file);
            workspace.pending.set(pendingKey(file, fileName), { role, name: fileName, url, retrievedAt, ...decodeText(bytes), sha256: await host.sha256(bytes), bytes: bytes.length, sample: false });
            workspace.imported = null;
            releaseRuns();
            return { name: fileName, bytes: bytes.length, cached: Boolean(hit), retrievedAt };
        },
        // Fetches the files that came from a listed address again, for data that its publisher keeps up to date, and answers how many changed.
        // A browser cannot read a file the person picked from disk a second time, so those (and the packaged samples) are left as they are and
        // counted in `local`; a file whose address no longer answers is named in `missing`.
        reloadFiles: async ({ importerId }) => {
            needs('data.import');
            declared(contributes.importers, 'importerId', importerId, 'importer');
            let changed = 0;
            let local = 0;
            const missing = [];
            for (const [key, file] of [...workspace.pending]) {
                if (file.sample || file.binary) continue;
                if (!file.url) { local += 1; continue; }
                let bytes;
                try { bytes = await host.fetchBytes(addressAllowed(file.url, hosts), hosts); } catch { missing.push(file.name); continue; }
                const hash = await host.sha256(bytes);
                if (hash === file.sha256) continue;
                workspace.pending.set(key, { ...file, ...decodeText(bytes), sha256: hash, bytes: bytes.length, retrievedAt: new Date().toISOString() });
                changed += 1;
            }
            if (changed) { workspace.imported = null; releaseRuns(); }
            return { changed, missing, local };
        },
        // How much the add-on's cache holds ({ entries, bytes, oldest, newest }), and clearing it: for a window that lets the user see it and start afresh.
        cacheInfo: async () => {
            needs('network.fetch');
            return (await host.cache()).info();
        },
        clearCache: async () => {
            needs('network.fetch');
            await (await host.cache()).clear();
            return {};
        },
        chooseFile: async ({ importerId, role }) => {
            needs('data.import');
            const importer = declared(contributes.importers, 'importerId', importerId, 'importer');
            const file = declared(importer.files, 'role', role, 'file role');
            const chosen = await host.chooseFiles({ ...file, extensions: file.accept ?? ['csv'] });
            if (!chosen?.length) return { chosen: false };
            const taken = file.multiple ? chosen : chosen.slice(0, 1);
            if (file.binary) {
                // Noted, not read: read when the importer runs. Choosing changes no other input until then. Those chosen together replace the role's earlier ones.
                const entries = binaryChoice(taken.map((item) => ({ path: item.name, size: item.size })), role);
                dropRole(file);
                entries.forEach((entry, index) => workspace.pending.set(pendingKey(file, entry.name), { ...entry, read: taken[index].read }));
                return { chosen: true, name: entries[0].name, names: entries.map((entry) => entry.name), bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
            }
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
            const files = [];
            for (const file of importerInputs(workspace.pending.values(), roles, options)) {
                if (!file.binary) { files.push({ role: file.role, name: file.name, text: file.text, encoding: file.encoding }); continue; }
                // A binary input is read now, into memory of its own, and handed over to the importer.
                let data;
                try { data = await file.read(); } catch (error) { throw new Error(error?.name === 'RangeError' || error?.name === 'NotReadableError' ? `${file.name} could not be read here: it may be too large for this device's memory, or it was moved. Choose it again.` : `${file.name} could not be read (${error?.message ?? 'unknown reason'}). Choose it again.`); }
                if (data.length > maximumBinaryInputBytes) throw new Error(`${file.name} is larger than the ${maximumBinaryInputBytes / 1024 / 1024} MB limit.`);
                files.push({ role: file.role, name: file.name, data });
            }
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
            // The project the canvas would hold after these runs: the model with the baseline as its first branch and, when a scenario is named
            // and has been run, its fork from the baseline as a second.
            const branches = [];
            if (workspace.baseline) {
                branches.push({ result: workspace.baseline.result, branchUuid: workspace.baseline.uuid, parentBranchUuid: null, forkTime: null, label: 'Baseline' });
                const key = scenarioId ? [...workspace.scenarios.keys()].filter((candidate) => candidate.startsWith(`${scenarioId}|`)).at(-1) : null;
                const run = key ? workspace.scenarios.get(key) : null;
                if (run) branches.push({ result: run.result, branchUuid: run.uuid, parentBranchUuid: workspace.baseline.uuid, forkTime: run.forkTime, label: run.scenario.name });
            }
            // A launcher with project.data may keep its session with the project it opens: saved with it, restored from it.
            const content = session === undefined ? workspace.imported.contentText : attachAddonData(workspace.imported.contentText, manifest.addonId, sessionEntry(session));
            await host.openProject({ content, suggestedFilename: `${manifest.name.replaceAll(/[^A-Za-z0-9]+/g, '')}.kjt`, silent, addonName: manifest.name, focus, branches });
            return {};
        },
        // Keeps the window's session with the open project without opening a model (with `requires: ["keepSession"]`): work in the window before
        // anything is built is then saved with the project, and restored.
        keepSession: ({ session } = {}) => {
            host.keepAddonData(manifest.addonId, sessionEntry(session));
            return {};
        },
        // Restores the session this launcher kept with the open project: its input files become the pending files again (so its importer can
        // run as before, offline), and the window gets back the state it saved.
        restoreSession: async () => {
            needs('project.data');
            const saved = await host.requestAddonData(manifest.addonId);
            // The web's SHA-256 is asynchronous, so an input saved without its hash gets it before the shared code reads the entry.
            const entry = saved?.version === 1 && Array.isArray(saved.inputs)
                ? { ...saved, inputs: await Promise.all(saved.inputs.map(async (input) => (input?.sha256 || typeof input?.text !== 'string' ? input : { ...input, sha256: await host.sha256(new TextEncoder().encode(input.text)) }))) }
                : saved;
            const inputs = sessionInputs(entry, contributes.importers);
            if (!inputs) return { session: null };
            workspace.pending.clear();
            for (const { key, file } of inputs) workspace.pending.set(key, file);
            workspace.imported = null;
            releaseRuns();
            return {
                session: entry.window ?? null, savedAt: entry.savedAt ?? null, addonVersion: entry.addonVersion ?? null,
                inputs: inputs.map(({ file }) => ({ role: file.role, name: file.name, bytes: file.bytes, ...(file.url ? { url: file.url, retrievedAt: file.retrievedAt } : {}), ...(file.source ? { derivedFrom: file.source } : {}) }))
            };
        },
        // ---- large files kept for the user (webFileStore.mjs) ----------------------------------------------------------
        storedFiles: async () => {
            needs('files.store');
            const store = await host.files();
            return { files: await store.list(), bytes: await store.usage() };
        },
        // Brings files in from the person's disk, as copies: chosen in the browser's file picker (any number, of the kinds the window names when it
        // names them), kept as their own.
        storeFiles: async ({ details = {}, accept = null, title = null } = {}) => {
            needs('files.store');
            const kinds = storedFileKinds(accept);
            const chosen = await host.pickFiles({ title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : 'Files to keep', extensions: kinds.filters[0]?.extensions ?? null });
            if (!chosen?.length) return { files: [] };
            for (const file of chosen) kinds.check(file.name);
            const store = await host.files();
            const files = [];
            for (const file of chosen) files.push(await store.putFile({ file, details }));
            return { files };
        },
        // Downloads a file from a host the manifest declares, into the store, saying how far it has got.
        downloadFile: async ({ url, name = null, server = null, checksumUrl = null, details = {}, downloadId = null, fresh = false } = {}) => {
            needs('files.store');
            needs('network.fetch');
            const store = await host.files();
            const controller = new AbortController();
            if (typeof downloadId === 'string') downloads.set(downloadId, controller);
            let last = 0;
            const onProgress = ({ done, total, resumedFrom }) => {
                const now = Date.now();
                if (now - last < 200 && done !== total) return;
                last = now;
                host.emit('launcherProgress', { stage: 'download', downloadId, done, total, resumedFrom });
            };
            try {
                return { file: await store.download({ url, name, server, checksumUrl, details, fresh: fresh === true, hosts, onProgress, signal: controller.signal }) };
            } finally {
                if (typeof downloadId === 'string') downloads.delete(downloadId);
            }
        },
        // How large a file is before it is downloaded: asked of the server, at a declared host.
        fileSize: async ({ url } = {}) => {
            needs('files.store');
            needs('network.fetch');
            return { bytes: await (await host.files()).size({ url, hosts }) };
        },
        // Downloads that stopped part way, kept to continue (by downloading the same address again) or to give up.
        partialDownloads: async () => {
            needs('files.store');
            return { partials: await (await host.files()).partials() };
        },
        discardPartialDownload: async ({ id } = {}) => {
            needs('files.store');
            await (await host.files()).discardPartial(id);
            return {};
        },
        cancelDownload: ({ downloadId } = {}) => {
            needs('files.store');
            downloads.get(downloadId)?.abort();
            return {};
        },
        describeStoredFile: async ({ id, details } = {}) => {
            needs('files.store');
            return { file: shown(await (await host.files()).describe(id, details)) };
        },
        removeStoredFile: async ({ id } = {}) => {
            needs('files.store');
            await (await host.files()).remove(id);
            return {};
        },
        // Stored files as a binary role's files, in place of any chosen: read when the importer is next asked to.
        useStoredFiles: async ({ importerId, role, ids } = {}) => {
            needs('files.store');
            needs('data.import');
            const importer = declared(contributes.importers, 'importerId', importerId, 'importer');
            const file = declared(importer.files, 'role', role, 'file role');
            if (!file.binary) throw new Error('Stored files are given to a binary file role.');
            if (!Array.isArray(ids) || !ids.length || (!file.multiple && ids.length > 1)) throw new Error('Name the stored files to use.');
            const store = await host.files();
            const entries = [];
            for (const id of ids) {
                const entry = await store.get(id);
                if (!entry) throw new Error('A stored file named is no longer kept.');
                entries.push(entry);
            }
            const pending = binaryChoice(entries.map((entry) => ({ path: entry.name, size: entry.bytes })), role);
            dropRole(file);
            pending.forEach((item, index) => workspace.pending.set(pendingKey(file, `${entries[index].id}-${entries[index].name}`), { ...item, name: entries[index].name, stored: entries[index].id, read: async () => new Uint8Array(await entries[index].blob.arrayBuffer()) }));
            return { files: entries.map(shown) };
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
