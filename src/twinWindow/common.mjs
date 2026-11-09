/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the twin window's setup, control room and engineer's view share: finding elements, showing numbers, small drawings, and
// reading the model the twin runs.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const cleanError = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (Error: )?/, '').replace(/^(ReplayError|ENGINE_FAILURE): /, '');
// A value read across a room: four figures.
export const readable = (value) => (Number.isFinite(value) ? Number(value.toPrecision(4)).toString() : '—');
export const shown = (value) => (Number.isFinite(value) ? Number(value.toPrecision(5)).toString() : '—');
export const clock = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
// A time in the data, in the unit that reads at its size: seconds for a motor's, minutes, hours for a tank's or a house's.
export const dataClock = (seconds) => (Math.abs(seconds) < 60 ? `${Number(seconds.toFixed(1))} s`
    : Math.abs(seconds) < 3600 ? `${Number((seconds / 60).toFixed(1))} min` : `${Number((seconds / 3600).toFixed(2))} h`);
export const dataTime = (seconds) => `at ${dataClock(seconds)} of data`;
export const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

export function element(tag, properties = {}, ...children) {
    const made = Object.assign(document.createElement(tag), properties);
    made.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return made;
}

// A small line of a series' course, scaled to fit.
export function sparkline(values, color = '#42c9bc') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 26');
    svg.setAttribute('preserveAspectRatio', 'none');
    const finite = values.filter(Number.isFinite);
    if (finite.length < 2) return svg;
    const low = Math.min(...finite);
    const high = Math.max(...finite);
    const span = high - low || 1;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    path.setAttribute('points', finite.map((value, index) => `${(index / (finite.length - 1)) * 100},${24 - ((value - low) / span) * 22}`).join(' '));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(path);
    return svg;
}

export const plotLayout = (extra = {}) => ({
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: { color: '#9fb2bb', size: 11 }, showlegend: false,
    xaxis: { gridcolor: '#17252f', zeroline: false }, yaxis: { gridcolor: '#17252f', zeroline: false }, ...extra
});

export function valueAt(series, time) {
    if (!series.length) return NaN;
    if (time <= series[0].time) return series[0].value;
    for (let index = 1; index < series.length; index += 1) {
        if (series[index].time >= time) {
            const [a, b] = [series[index - 1], series[index]];
            return a.value + (b.value - a.value) * ((time - a.time) / (b.time - a.time || 1));
        }
    }
    return series.at(-1).value;
}

// How a quantity has moved over the last hour of its history ([[time, value]], in time order): rising or falling when it moved by
// more than half a percent of itself (or of its own range, for one near zero), else steady.
export function trendOf(points) {
    if (points.length < 2) return { word: '—', kind: '' };
    const [latestTime, latest] = points.at(-1);
    const [earlierTime, earlier] = points.find(([time]) => time >= latestTime - 3600 - 1e-9);
    if (latestTime - earlierTime < 1e-9) return { word: '—', kind: '' };
    const perHour = (latest - earlier) / ((latestTime - earlierTime) / 3600);
    const values = points.map(([, value]) => value);
    const scale = Math.abs(latest) > 1e-12 ? Math.abs(latest) : Math.max(...values) - Math.min(...values);
    if (!(scale > 0) || Math.abs(perHour) <= 0.005 * scale) return { word: 'steady', kind: 'steady', perHour };
    return { word: perHour > 0 ? 'rising' : 'falling', kind: perHour > 0 ? 'rising' : 'falling', perHour };
}

// A change made at once within the last hour of data, as an input or a heater's heat flow makes one: { time, from, to, change }, or null.
// A rate (rising, falling) is the wrong word for one: "steady" an hour after a heater went off, while the line shows it going off, reads
// as a mistake. It counts when one step between two neighbouring points makes most of the movement over the hour, and is more than a
// twentieth of the value's size. The point just before the hour is included, so a step at the hour's very edge is not missed.
export function stepOf(points) {
    if (points.length < 2) return null;
    const latestTime = points.at(-1)[0];
    const first = Math.max(0, points.findIndex(([time]) => time >= latestTime - 3600 - 1e-9) - 1);
    const recent = points.slice(first);
    let largest = null;
    let movement = 0;
    for (let index = 1; index < recent.length; index += 1) {
        const change = recent[index][1] - recent[index - 1][1];
        movement += Math.abs(change);
        if (!largest || Math.abs(change) > Math.abs(largest.change)) largest = { time: recent[index][0], from: recent[index - 1][1], to: recent[index][1], change };
    }
    const values = recent.map(([, value]) => value);
    const scale = Math.max(Math.abs(points.at(-1)[1]), Math.max(...values) - Math.min(...values));
    if (!largest || !(scale > 0) || Math.abs(largest.change) < 0.05 * scale || Math.abs(largest.change) < 0.8 * movement) return null;
    return largest;
}

// How long ago a time in the data was, in words: "just now", "12 min ago", "1 h ago", "1.5 h ago".
export function ago(seconds) {
    if (seconds < 60) return 'just now';
    if (seconds < 3570) return `${Math.round(seconds / 60)} min ago`;
    return `${Number((seconds / 3600).toFixed(1))} h ago`;
}

// Every parameter in a model, wherever it is, with who owns it: { parameter, owner }.
export function modelParameters(model) {
    return [
        ...(model.sharedParameters ?? []).map((parameter) => ({ parameter, owner: 'Shared' })),
        ...(model.edges ?? []).flatMap((edge) => (edge.parameters ?? []).map((parameter) => ({ parameter, owner: edge.name }))),
        ...(model.nodes ?? []).flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => (term.parameters ?? []).map((parameter) => ({ parameter, owner: `${node.name} · source term` }))))
    ];
}

export function modelStates(model) {
    return (model.nodes ?? []).flatMap((node) => (node.states ?? []).map((state) => ({ state, node })));
}

// The parameters an engineer may set, and the estimator may track: those marked tunable, with bounds, that take their value from
// no shared parameter.
export function tunableParameters(model) {
    return modelParameters(model).filter(({ parameter }) => parameter.tuning && !parameter.sharedParameterId)
        .map(({ parameter, owner }) => ({ parameterId: parameter.id, name: parameter.name, owner, unit: parameter.unit ?? '', value: parameter.value, minimum: parameter.tuning.minimum, maximum: parameter.tuning.maximum }));
}

// Values set in a model (a parameter's value, or a state's initial value), in a copy.
export function withValues(model, values) {
    const copy = structuredClone(model);
    const parameters = new Map(modelParameters(copy).map(({ parameter }) => [parameter.id, parameter]));
    const states = new Map(modelStates(copy).map(({ state }) => [state.id, state]));
    for (const { parameterId, value } of values) {
        if (parameters.has(parameterId)) parameters.get(parameterId).value = value;
        else if (states.has(parameterId)) states.get(parameterId).initialValue = value;
    }
    return copy;
}

// The model as the twin runs it: what the canvas draws (positions, turns, sizes, looks, descriptions) is left out, so moving a node
// in the project window is not a change to the twin.
export function twinModel(model) {
    const strip = (item, keys) => Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key)));
    return {
        nodes: (model.nodes ?? []).map((node) => strip(node, ['position', 'rotation', 'scale', 'appearance', 'description'])),
        edges: (model.edges ?? []).map((edge) => strip(edge, ['appearance', 'description'])),
        sharedParameters: model.sharedParameters ?? []
    };
}

export const sameTwinModel = (a, b) => JSON.stringify(twinModel(a)) === JSON.stringify(twinModel(b));

// What changed from one model to the next, in a few words: values changed, states added or removed, relationships changed.
export function describeChange(before, after) {
    const said = [];
    const oldParameters = new Map(modelParameters(before).map(({ parameter, owner }) => [parameter.id, { parameter, owner }]));
    const changedValues = modelParameters(after).filter(({ parameter }) => oldParameters.has(parameter.id) && oldParameters.get(parameter.id).parameter.value !== parameter.value);
    for (const { parameter } of changedValues.slice(0, 3)) said.push(`${parameter.name} ${shown(oldParameters.get(parameter.id).parameter.value)} → ${shown(parameter.value)}${parameter.unit ? ` ${parameter.unit}` : ''}`);
    if (changedValues.length > 3) said.push(`${changedValues.length - 3} more values`);
    const oldStates = new Set(modelStates(before).map(({ state }) => state.id));
    const newStates = modelStates(after);
    const added = newStates.filter(({ state }) => !oldStates.has(state.id));
    const removed = modelStates(before).filter(({ state }) => !newStates.some((entry) => entry.state.id === state.id));
    if (added.length) said.push(`${plural(added.length, 'state')} added (${added.slice(0, 3).map(({ node, state }) => `${node.name} · ${state.name}`).join(', ')})`);
    if (removed.length) said.push(`${plural(removed.length, 'state')} removed (${removed.slice(0, 3).map(({ node, state }) => `${node.name} · ${state.name}`).join(', ')})`);
    const edgeText = (model) => new Map((model.edges ?? []).map((edge) => [edge.id, JSON.stringify(twinModel({ edges: [{ ...edge, parameters: (edge.parameters ?? []).map((parameter) => ({ ...parameter, value: 0 })) }] }).edges)]));
    const oldEdges = edgeText(before);
    const newEdges = edgeText(after);
    const edgesChanged = [...newEdges].filter(([id, text]) => oldEdges.get(id) !== text).length + [...oldEdges.keys()].filter((id) => !newEdges.has(id)).length;
    if (edgesChanged) said.push(`${plural(edgesChanged, 'relationship')} changed`);
    return said.length ? said.join('; ') : 'something the twin runs on changed';
}
