/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What a result visualizer may ask of the page in the web edition (docs/proposals/webEditionPackages.md, stage 3). The add-on runs in a
// sandboxed frame with no access to the page (webAddonFrame.mjs); everything it can do goes through `call` below, which checks the
// permissions the person approved at install, exactly as the desktop's main process does for the visualizer window (the visualizer*
// handlers in src/main.mjs). A call without its permission is answered as the desktop answers it and does nothing else. The module
// holds no DOM and no storage, so the rules are the same under test as in the browser.

import { publicVisualizerContext, readSignalSeries, validateAddonManifest } from './addonHost.mjs';
import { webLauncherRefusal } from './webLauncherBridge.mjs';
import { describeIntervention, parameterChangeEntries } from './parameterHistory.mjs';

// Of the permissions a result visualizer may ask for (addonHost.mjs), the ones the web edition can honour. The rest need a run that is
// still going, or the project's own data, which the web edition does not give an add-on yet; a visualizer asking for one is turned away
// at install, saying which.
export const webVisualizerPermissions = new Set(['results.read', 'timeline.read', 'timeline.seek', 'selection.read', 'results.export', 'settings.store']);
export const webVisualizerFeatures = new Set(['addonSettings']);

export const maximumSettingsBytes = 256 * 1024;
export const maximumCsvBytes = 64 * 1024 * 1024;

// The reason the web edition cannot run this add-on, or null when it can.
export function webAddonRefusal(contributionManifest) {
    if (contributionManifest?.kind !== 'launcher' && contributionManifest?.kind !== 'resultVisualizer') return 'This add-on is neither a result visualizer nor a launcher, which are the kinds the web edition runs.';
    try {
        validateAddonManifest(contributionManifest);
    } catch (error) {
        return error.message;
    }
    if (contributionManifest.kind === 'launcher') return webLauncherRefusal(contributionManifest);
    const permissions = contributionManifest.permissions ?? [];
    const unavailable = permissions.filter((permission) => !webVisualizerPermissions.has(permission));
    if (unavailable.length) return `This visualizer asks for ${unavailable.join(', ')}, which the web edition cannot give an add-on yet. It works in the desktop app.`;
    const needs = (contributionManifest.requires ?? []).filter((feature) => !webVisualizerFeatures.has(feature));
    if (needs.length) return `This visualizer needs ${needs.join(', ')}, which the web edition does not provide yet. It works in the desktop app.`;
    return null;
}

const fileNameOf = (name) => String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120) || 'results.csv';

// One open visualizer. `session` is createVisualizerSession's result; `settings` is { get(addonId), set(addonId, value) };
// `saveCsv(fileName, text)` hands the person a file; `requestSeek(time)` moves the page's timeline.
export function createVisualizerBridge({ manifest, session, settings, saveCsv, requestSeek }) {
    const state = { session };
    const permitted = new Set(manifest.permissions ?? []);
    const need = (permission, what) => {
        if (!permitted.has(permission)) throw new Error(`The visualizer was not granted ${permission}${what ? ` (${what})` : ''}.`);
    };

    const handlers = {
        getContext: () => (permitted.has('results.read') ? publicVisualizerContext(state.session) : null),
        listSignals: () => (permitted.has('results.read') ? structuredClone(state.session.signals) : []),
        getParameterChanges: () => {
            if (!permitted.has('results.read')) return [];
            const { session: current } = state;
            const endTime = current.samples.at(-1)?.time ?? 0;
            return parameterChangeEntries(current.parameters, current.interventions ?? [], endTime).map((entry) => ({
                ...entry, changes: entry.changes.filter((change) => change.kind !== 'restart').map((change) => ({ ...change, description: describeIntervention(change, entry.unit) }))
            }));
        },
        readSeries: ({ signalIds, options } = {}) => {
            if (!permitted.has('results.read')) return [];
            if (!Array.isArray(signalIds) || !signalIds.every((id) => typeof id === 'string' || Number.isFinite(id))) throw new Error('readSeries needs a list of signal ids.');
            return readSignalSeries(state.session, signalIds, options && typeof options === 'object' ? options : {});
        },
        seek: ({ time } = {}) => {
            if (!permitted.has('timeline.seek')) return undefined;
            const { run } = state.session;
            if (['running', 'paused'].includes(run.lifecycle)) return undefined;
            const wanted = Number(time);
            if (!Number.isFinite(wanted)) return undefined;
            state.session.time = Math.max(0, Math.min(wanted, run.availableResultTime));
            requestSeek(state.session.time);
            return undefined;
        },
        requestPacing: () => {
            throw new Error('The visualizer does not have permission to control pacing.');
        },
        exportCsv: async ({ suggestedFilename, csv } = {}) => {
            if (!permitted.has('results.export')) throw new Error('The visualizer does not have permission to export results.');
            if (typeof csv !== 'string') throw new Error('exportCsv needs the file text.');
            if (csv.length > maximumCsvBytes) throw new Error('That file is too large to export.');
            let fileName = fileNameOf(suggestedFilename);
            if (!fileName.toLowerCase().endsWith('.csv')) fileName += '.csv';
            await saveCsv(fileName, csv);
            return { path: null, fileName };
        },
        getProjectData: () => need('project.data'),
        setProjectData: () => need('project.data'),
        getSettings: async () => {
            need('settings.store');
            return settings.get(manifest.addonId);
        },
        setSettings: async ({ settings: value } = {}) => {
            need('settings.store');
            if (value !== null && value !== undefined && JSON.stringify(value) === undefined) throw new Error('Add-on settings must be JSON.');
            if (value !== null && value !== undefined && JSON.stringify(value).length > maximumSettingsBytes) throw new Error(`An add-on's settings may be at most ${maximumSettingsBytes / 1024} KB.`);
            await settings.set(manifest.addonId, value ?? null);
            return undefined;
        }
    };

    return {
        // A request from the frame: the method's answer, or a rejection with a message the add-on can show. Only the names above are
        // reachable (Object.hasOwn, so nothing inherited is).
        async call(method, params) {
            if (typeof method !== 'string' || !Object.hasOwn(handlers, method)) throw new Error(`Unknown method: ${String(method).slice(0, 60)}.`);
            return handlers[method](params && typeof params === 'object' ? params : {});
        },
        // The page changed something the add-on may be told: { channel, payload } for the frame, or null when the add-on may not hear of it.
        // The bridge's own copy of the state moves either way, so a later read is current.
        event(name, payload) {
            if (name === 'timeline.change') {
                state.session.time = Number(payload);
                return permitted.has('timeline.read') ? { channel: 'timelineChange', payload: state.session.time } : null;
            }
            if (name === 'selection.change') {
                state.session.selectedNodeId = payload ?? null;
                return permitted.has('selection.read') ? { channel: 'selectionChange', payload: state.session.selectedNodeId } : null;
            }
            return null;
        },
        // A new result session for the same visualizer (the person ran again and opened it again).
        replaceSession(next) {
            state.session = next;
            return { channel: 'sessionChange', payload: null };
        },
        get session() { return state.session; }
    };
}
