/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Scenarios tried in a live twin's sandbox (docs/proposals/digitalTwinConnections.md, "Detaching to try things"), kept with the
// project as `scenarios` (docs/projectSchema.md) without the person choosing a place: a sandbox in which something was done becomes
// a draft scenario when the person goes back to live, and a list in the card keeps, renames or deletes them. Like the tuning setup
// it sits beside the model, not in it, and never reaches the engine, validation or undo. Results are not kept; a scenario says what
// was tried, from when, and with which model, so it can be run again and can tell when the model has changed since.

const maximumScenarios = 50;

// A short, stable fingerprint of a model, to tell whether a scenario was tried with the model as it is now.
export function modelFingerprint(document) {
    const text = JSON.stringify({ nodes: document.nodes, edges: document.edges, sharedParameters: document.sharedParameters ?? [] });
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

const finite = (value) => Number.isFinite(Number(value));

// The scenarios a project file carries, made safe to use: anything unusable is dropped.
export function normalizeScenarios(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string' && finite(entry.startedAt)).slice(0, maximumScenarios).map((entry) => ({
        id: entry.id,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : 'Scenario',
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
        logFileName: typeof entry.logFileName === 'string' ? entry.logFileName : '',
        startedAt: Number(entry.startedAt),
        ranFor: finite(entry.ranFor) ? Number(entry.ranFor) : 0,
        settings: entry.settings && typeof entry.settings === 'object' ? {
            window: Number(entry.settings.window) || 0, stride: Number(entry.settings.stride) || 0, horizon: Number(entry.settings.horizon) || 0
        } : { window: 0, stride: 0, horizon: 0 },
        tried: (Array.isArray(entry.tried) ? entry.tried : []).filter((step) => step && typeof step.signal === 'string' && finite(step.time) && finite(step.value))
            .map((step) => ({ time: Number(step.time), signal: step.signal, value: Number(step.value) })),
        modelFingerprint: typeof entry.modelFingerprint === 'string' ? entry.modelFingerprint : ''
    }));
}

// A draft scenario from what a sandbox did, or null when nothing was done in it (such a sandbox is not kept).
export function draftScenario({ id, now = new Date(), logFileName = '', startedAt, ranFor, settings, tried, document }) {
    if (!tried?.length) return null;
    const hours = (seconds) => `${Math.round(seconds / 60)} min`;
    return normalizeScenarios([{
        id, name: `Tried at ${hours(startedAt)}: ${tried.map((step) => `${step.signal} ${step.value}`).join(', ')}`,
        createdAt: now.toISOString(), logFileName, startedAt, ranFor, settings, tried, modelFingerprint: modelFingerprint(document)
    }])[0];
}

// The list with a scenario added; the oldest goes when the list is full, and the caller is told which one went.
export function withScenario(scenarios, scenario) {
    const next = [...scenarios, scenario];
    const dropped = next.length > maximumScenarios ? next.shift() : null;
    return { scenarios: next, dropped };
}
