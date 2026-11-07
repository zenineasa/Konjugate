/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A twin's setup as a project keeps it (`twin` in the project document, docs/proposals/controlRoom.md): where its readings come from,
// how each incoming signal maps to the model, with its unit conversion, and the twin's own settings. Read with normalizeTwinSetup,
// which keeps what is usable and drops what is not, so a file written by hand or by another version never breaks the twin's window.
//
//   source    { kind: 'file', fileName } | { kind: 'mqtt', url } | { kind: 'opcua', url, security } | { kind: 'push' }
//   mapping   [{ source, name, role, target: { kind, id } | null, unit, conversion: { scale, offset } | null }]: `source` is what the
//             source calls the signal (a column, a topic, a tag's node id, a pushed signal), `name` the identifier the twin uses
//   live      { window, stride, horizon, speed, alert }

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const positive = (value) => finite(value) && value > 0;
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 2000;

function normalizeSource(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.kind === 'file' && text(raw.fileName)) return { kind: 'file', fileName: raw.fileName };
    if (raw.kind === 'mqtt' && text(raw.url)) return { kind: 'mqtt', url: raw.url };
    if (raw.kind === 'opcua' && text(raw.url)) return { kind: 'opcua', url: raw.url, security: ['none', 'sign', 'signAndEncrypt'].includes(raw.security) ? raw.security : 'none' };
    if (raw.kind === 'push') return { kind: 'push' };
    return null;
}

function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object' || !text(raw.source) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(raw.name ?? '')) return null;
    const role = raw.role === 'input' || raw.role === 'output' ? raw.role : null;
    const target = role && raw.target && ['state', 'parameter'].includes(raw.target.kind) && Number.isSafeInteger(raw.target.id) && raw.target.id > 0
        && (raw.target.kind === 'state') === (role === 'output') ? { kind: raw.target.kind, id: raw.target.id } : null;
    const conversion = raw.conversion && finite(raw.conversion.scale) && raw.conversion.scale !== 0 && finite(raw.conversion.offset)
        ? { scale: raw.conversion.scale, offset: raw.conversion.offset } : null;
    return { source: raw.source, name: raw.name, role: target ? role : null, target, unit: typeof raw.unit === 'string' ? raw.unit : '', conversion };
}

export function normalizeTwinSetup(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const source = normalizeSource(raw.source);
    if (!source) return null;
    const names = new Set();
    const mapping = (Array.isArray(raw.mapping) ? raw.mapping : []).map(normalizeEntry).filter((entry) => {
        if (!entry || names.has(entry.name)) return false;
        names.add(entry.name);
        return true;
    });
    const live = {};
    for (const key of ['window', 'stride', 'horizon']) if (positive(raw.live?.[key])) live[key] = raw.live[key];
    if (raw.live?.speed === 'follow' || raw.live?.speed === 'Infinity' || positive(Number(raw.live?.speed))) live.speed = String(raw.live.speed);
    if (finite(raw.live?.alert) && raw.live.alert >= 0) live.alert = raw.live.alert;
    return { source, mapping, live };
}

// The live twin's mapping (src/windowSession.mjs) from a setup's: the mapped signals, by the twin's names for them, onto states and
// shared parameters; and the conversions to apply as readings arrive.
export function twinSessionMapping(setup) {
    const mapping = setup.mapping.filter((entry) => entry.target).map((entry) => (entry.role === 'input'
        ? { signal: entry.name, role: 'input', unit: entry.unit, parameterId: entry.target.id }
        : { signal: entry.name, role: 'output', unit: entry.unit, stateId: entry.target.id }));
    const conversions = Object.fromEntries(setup.mapping.filter((entry) => entry.target && entry.conversion).map((entry) => [entry.name, entry.conversion]));
    return { mapping, conversions };
}
