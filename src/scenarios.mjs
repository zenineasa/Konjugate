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

// A time in the data, in the unit that reads at its size (as the twin's window reads it: seconds for a motor, hours for a house).
export const dataClock = (seconds) => (Math.abs(seconds) < 60 ? `${Number(seconds.toFixed(1))} s`
    : Math.abs(seconds) < 3600 ? `${Number((seconds / 60).toFixed(1))} min` : `${Number((seconds / 3600).toFixed(2))} h`);

// What was tried, in words, for a draft's name: each input by its own name and unit (`inputs`: signal → { name, unit }), each value with
// when it applied ("Voltage 12 V at 14 s, 0 V at 17 s"); an input moved more than three times, by its range and when ("Heater power,
// 37 changes between 0 and 2000 W from 3.2 h to 4 h"), since a fader followed gives a change every few hundredths of a second.
export function describeTried(tried, inputs = {}) {
    const signals = [...new Set(tried.map((step) => step.signal))];
    return signals.map((signal) => {
        const steps = tried.filter((step) => step.signal === signal);
        const name = inputs[signal]?.name || signal;
        const unit = inputs[signal]?.unit ? ` ${inputs[signal].unit}` : '';
        const value = (number) => Number(Number(number).toPrecision(4));
        if (steps.length <= 3) return `${name} ${steps.map((step) => `${value(step.value)}${unit} at ${dataClock(step.time)}`).join(', ')}`;
        const values = steps.map((step) => step.value);
        return `${name}, ${steps.length} changes between ${value(Math.min(...values))} and ${value(Math.max(...values))}${unit} from ${dataClock(steps[0].time)} to ${dataClock(steps.at(-1).time)}`;
    }).join('; ');
}

// A draft scenario from what a sandbox did, or null when nothing was done in it (such a sandbox is not kept).
export function draftScenario({ id, now = new Date(), logFileName = '', startedAt, ranFor, settings, tried, document, inputs = {} }) {
    if (!tried?.length) return null;
    return normalizeScenarios([{
        id, name: `Tried from ${dataClock(startedAt)}: ${describeTried(tried, inputs)}`,
        createdAt: now.toISOString(), logFileName, startedAt, ranFor, settings, tried, modelFingerprint: modelFingerprint(document)
    }])[0];
}

// The list with a scenario added; the oldest goes when the list is full, and the caller is told which one went.
export function withScenario(scenarios, scenario) {
    const next = [...scenarios, scenario];
    const dropped = next.length > maximumScenarios ? next.shift() : null;
    return { scenarios: next, dropped };
}
