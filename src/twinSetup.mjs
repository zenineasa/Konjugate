/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A twin's setup as a project keeps it (`twin` in the project document, docs/proposals/controlRoom.md): where its readings come from,
// how each incoming signal maps to the model, with its unit conversion, and the twin's own settings. Read with normalizeTwinSetup,
// which keeps what is usable and drops what is not, so a file written by hand or by another version never breaks the twin's window.
//
//   source    { kind: 'file', fileName } | { kind: 'mqtt', url } | { kind: 'opcua', url, security } | { kind: 'push' }
//   mapping   [{ source, name, role, target: { kind, id } | null, unit, conversion: { scale, offset } | null }]: `source` is what the
//             source calls the signal (a column, a topic, a tag's node id, a pushed signal), `name` the identifier the twin uses
//   live      { window, stride, horizon, speed, alert, timeStep, corrections, members, untracked }: the twin's settings, the
//             engineer's to change. `alert` is the drift warning in the first measured signal's unit a move (0 for none);
//             `corrections` { name: { gain } | { estimate: true } } what a move does with each measured signal (reset to the
//             reading when not given), an estimate with the readings' `noise` (a standard deviation) when one is given; `members` the
//             estimator's ensemble; `untracked` the tunable parameters the estimator leaves alone (every other one is tracked when a
//             signal is estimated); `drift` { stateId: how far it may drift in an hour, beyond what the model says }
//   layout    { order, wide, pinned, hidden, temperature, span, bounds }: the control room's tiles by measured signal's name, in
//             order, those drawn twice as wide, pinned first, and hidden; temperatures shown in 'C' (the default) or 'K'; how much of
//             the past the plots show, 'all' or a span in seconds (four times the twin's window when not given); the window's place
//             and size, { x, y, width, height, maximized }
//   record    { startedAt, events: [{ at, kind, text, detail }] }: the last run's events, newest first

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
    if (positive(raw.live?.timeStep)) live.timeStep = raw.live.timeStep;
    if (Number.isInteger(raw.live?.members) && raw.live.members >= 4 && raw.live.members <= 1000) live.members = raw.live.members;
    const corrections = {};
    for (const [name, correction] of Object.entries(raw.live?.corrections && typeof raw.live.corrections === 'object' ? raw.live.corrections : {})) {
        if (!names.has(name) || !correction || typeof correction !== 'object') continue;
        if (correction.estimate === true) corrections[name] = positive(correction.noise) ? { estimate: true, noise: correction.noise } : { estimate: true };
        else if (finite(correction.gain) && correction.gain >= 0 && correction.gain <= 1) corrections[name] = { gain: correction.gain };
    }
    if (Object.keys(corrections).length) live.corrections = corrections;
    const ids = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (ids(raw.live?.untracked).length) live.untracked = ids(raw.live.untracked);
    const drift = Object.fromEntries(Object.entries(raw.live?.drift && typeof raw.live.drift === 'object' ? raw.live.drift : {}).filter(([id, value]) => /^[1-9]\d*$/.test(id) && positive(value)));
    if (Object.keys(drift).length) live.drift = drift;
    const setup = { source, mapping, live };
    const signalNames = (list) => [...new Set((Array.isArray(list) ? list : []).filter((name) => names.has(name)))];
    if (raw.layout && typeof raw.layout === 'object') {
        const layout = {};
        for (const key of ['order', 'wide', 'pinned', 'hidden']) if (signalNames(raw.layout[key]).length) layout[key] = signalNames(raw.layout[key]);
        if (raw.layout.temperature === 'C' || raw.layout.temperature === 'K') layout.temperature = raw.layout.temperature;
        // How much of the past the plots show: 'all', or a span in seconds; the twin's own recent span when not given.
        if (raw.layout.span === 'all' || positive(raw.layout.span)) layout.span = raw.layout.span;
        const bounds = raw.layout.bounds;
        if (bounds && ['x', 'y', 'width', 'height'].every((key) => finite(bounds[key])) && bounds.width >= 400 && bounds.height >= 300) {
            layout.bounds = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height), maximized: bounds.maximized === true };
        }
        if (Object.keys(layout).length) setup.layout = layout;
    }
    if (raw.record && typeof raw.record === 'object' && Array.isArray(raw.record.events)) {
        const events = raw.record.events.filter((event) => event && text(event.at) && ['info', 'good', 'lean', 'bad'].includes(event.kind) && text(event.text))
            .slice(0, 500).map((event) => ({ at: event.at, kind: event.kind, text: event.text, detail: typeof event.detail === 'string' ? event.detail.slice(0, 2000) : '' }));
        if (events.length) setup.record = { startedAt: text(raw.record.startedAt) ? raw.record.startedAt : events.at(-1).at, events };
    }
    return setup;
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
