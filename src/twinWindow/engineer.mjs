/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The engineer's view of the control room (docs/proposals/controlRoom.md, "The engineer's view, and changing the model"): what
// changes the twin. A tunable parameter set here, or a refit accepted, is applied to the twin from its latest move and kept in the
// model (an undoable edit in the project window), so there is one model; the warning is taken at once; what a move does with each
// measured signal, the parameters the estimator tracks, and the twin's timing take effect when it starts again.

import { $, $$, cleanError, element, shown, tunableParameters, withValues } from './common.mjs';
import { addEvent, baselineTakes, currentTwin } from './room.mjs';

let host = null;
let on = false;
let refit = null;       // what the last refit found: { plan, report }
let dirty = false;

export const engineerOn = () => on;

// host: { api, states() → the model's states, restartWith(live), saveLive(partial), askProject(action, payload) }
export function initEngineer(given) {
    host = given;
    $('#refitRun').addEventListener('click', () => runRefit());
    $('#refitApply').addEventListener('click', () => applyRefit(false));
    $('#refitKeep').addEventListener('click', () => applyRefit(true));
    $('#alertAmount').addEventListener('change', () => setAlert());
    for (const field of ['#members', '#timingWindow', '#timingStride', '#timingHorizon', '#timingStep']) $(field).addEventListener('change', () => markDirty());
    $('#restartTwin').addEventListener('click', () => restart());
}

export function showEngineer(visible) {
    on = visible;
    $('#engineer').hidden = !visible;
    const twin = currentTwin();
    if (visible && twin) engineerOpened(twin);
}

// The view filled in from the twin as it runs: its settings, its model's tunable parameters, its measured signals.
export function engineerOpened(twin) {
    if (!on || !twin) return;
    const live = twin.run.live;
    refit = null;
    dirty = false;
    $('#refitRows').replaceChildren();
    $('#refitStatus').textContent = '';
    $('#refitApply').hidden = true;
    $('#refitKeep').hidden = true;
    const first = twin.tiles[0];
    // A drift is a difference, the same in kelvin and in °C: said in the unit the room shows.
    const unit = first?.target?.unit === 'K' && twin.layout?.temperature !== 'K' ? '°C' : first?.target?.unit ?? '';
    $('#alertLabel').textContent = twin.tiles.length > 1
        ? `Warn when a signal drifts by (${unit ? `${unit} ` : ''}a move on ${first?.target?.label ?? first?.signal}; the same share of each other signal's tolerance)`
        : `Warn when it drifts by (${unit ? `${unit} ` : ''}a move)`;
    $('#alertAmount').value = live.alert > 0 ? String(Number(live.alert.toPrecision(2))) : '';
    $('#timingWindow').value = String(live.window / 60);
    $('#timingStride').value = String(live.stride / 60);
    $('#timingHorizon').value = String(live.horizon / 60);
    $('#timingStep').value = String(live.timeStep);
    $('#members').value = String(live.members);
    renderTunable(twin);
    renderCorrections(twin);
    refreshButtons(twin);
}

export function engineerCycle(twin, cycle) {
    if (!on) return;
    refreshButtons(twin);
    // A tracked parameter's estimate, shown where its slider would be.
    for (const parameter of cycle?.estimate?.parameters ?? []) {
        const value = $(`#tunableRows [data-parameter-id="${parameter.parameterId}"] .trackedValue`);
        if (value) value.textContent = `${shown(parameter.mean)} ± ${shown(parameter.spread)}`;
    }
}

function refreshButtons(twin) {
    $('#refitRun').disabled = !twin.running || !twin.cycles.length || Boolean(refit?.running);
    for (const field of $$('#tunableRows input')) field.disabled = !twin.running || !twin.cycles.length;
    $('#restartTwin').disabled = !dirty;
}

function markDirty() {
    dirty = true;
    $('#restartTwin').disabled = false;
    const twin = currentTwin();
    $('#restartNote').textContent = twin?.run.source.kind === 'recording'
        ? 'Taken when the twin starts again: the recording is played again from its start.'
        : 'Taken when the twin starts again: it follows its source again from now.';
}

// ---- Tunable parameters ------------------------------------------------------------------------------------------------------------
function renderTunable(twin) {
    const tracked = new Set(twin.settings.estimator?.parameters ?? []);
    const parameters = tunableParameters(twin.settings.document);
    if (!parameters.length) {
        $('#tunableRows').replaceChildren(element('p', { className: 'hint', textContent: 'Nothing is marked tunable: in the project window, mark a parameter "Tunable" with bounds in its relationship\'s editor.' }));
        return;
    }
    $('#tunableRows').replaceChildren(...parameters.map((parameter) => {
        // The relationship it belongs to, when that says more than its own name does.
        const owner = parameter.owner !== parameter.name ? parameter.owner : '';
        const label = element('label', { textContent: `${parameter.name} ` }, element('small', { textContent: [owner, parameter.unit].filter(Boolean).join(' · ') }));
        const row = element('div', { className: 'tunableRow' }, label);
        row.dataset.parameterId = String(parameter.parameterId);
        if (tracked.has(parameter.parameterId)) {
            row.append(element('span', { className: 'trackedValue', textContent: 'tracked' }), element('small', { textContent: 'found by the estimator as the twin goes' }));
            return row;
        }
        const step = (parameter.maximum - parameter.minimum) / 200;
        const range = element('input', { type: 'range', min: String(parameter.minimum), max: String(parameter.maximum), step: String(step), value: String(parameter.value) });
        const number = element('input', { type: 'number', min: String(parameter.minimum), max: String(parameter.maximum), step: 'any', value: String(Number(parameter.value.toPrecision(6))) });
        range.setAttribute('aria-label', `${parameter.name}, from ${parameter.minimum} to ${parameter.maximum}`);
        number.setAttribute('aria-label', `${parameter.name} value`);
        range.addEventListener('input', () => { number.value = String(Number(Number(range.value).toPrecision(6))); });
        const set = (value) => setParameter(parameter, value, [range, number]);
        range.addEventListener('change', () => set(Number(range.value)));
        number.addEventListener('change', () => set(Number(number.value)));
        row.append(number, range);
        return row;
    }));
}

// A tunable parameter set: the twin runs on with it from its latest move, and the model keeps it.
async function setParameter(parameter, value, fields) {
    const twin = currentTwin();
    if (!twin?.running || !twin.cycles.length) return;
    if (!Number.isFinite(value) || value < parameter.minimum || value > parameter.maximum) {
        addEvent('lean', `${parameter.name} stays at ${shown(parameter.value)}`, `${shown(value)} is outside its bounds, ${shown(parameter.minimum)} to ${shown(parameter.maximum)}`);
        for (const field of fields) field.value = String(parameter.value);
        return;
    }
    const at = twin.cycles.at(-1);
    const from = parameter.value;
    try {
        await host.api.liveTwin.applyRefit([{ parameterId: parameter.parameterId, value }], at.index);
    } catch (error) {
        addEvent('bad', `${parameter.name} could not be set`, cleanError(error));
        return;
    }
    const kept = await keepInModel(twin, [{ parameterId: parameter.parameterId, value }]);
    parameter.value = value;
    addEvent('info', `${parameter.name} set from ${shown(from)} to ${shown(value)}${parameter.unit ? ` ${parameter.unit}` : ''}`, `the twin runs on with it from the move at ${Number((at.anchor / 3600).toFixed(2))} h; ${kept}`, at.now);
}

// Values kept in the model, in the project window (an undoable edit there); the twin's own copy follows, and the model's change that
// comes back is expected, not offered.
async function keepInModel(twin, values) {
    try {
        const outcome = await host.askProject('keepValues', values);
        if (!outcome?.applied && outcome?.message !== 'The fitted values already match the model.') return `the model was left as it was: ${outcome?.message ?? 'no answer'}`;
    } catch (error) {
        return `the model was left as it was: ${cleanError(error)}`;
    }
    const model = withValues(twin.settings.document, values);
    twin.settings = { ...twin.settings, document: model };
    baselineTakes(model);
    return 'kept in the model too (Undo in the project window takes it back)';
}

// ---- Refit on the latest window ---------------------------------------------------------------------------------------------------
async function runRefit() {
    const twin = currentTwin();
    if (!twin?.running || refit?.running) return;
    $('#refitRows').replaceChildren();
    $('#refitApply').hidden = true;
    $('#refitKeep').hidden = true;
    $('#refitStatus').className = 'status';
    let plan;
    try {
        plan = await host.api.liveTwin.refitPlan();
    } catch (error) {
        $('#refitStatus').textContent = cleanError(error);
        return;
    }
    refit = { running: true, plan };
    refreshButtons(twin);
    $('#refitStatus').textContent = `Refitting on the window from ${Number((plan.anchor / 3600).toFixed(2))} h to ${Number((plan.now / 3600).toFixed(2))} h…`;
    try {
        const result = await host.api.fit(JSON.stringify(plan.document), plan.csv, { backend: 'nlopt-bobyqa', maxIterations: 400 });
        if (!result.available) throw new Error('The native fitting engine is unavailable.');
        const states = new Map(plan.document.nodes.flatMap((node) => (node.states ?? []).map((state) => [state.id, { node, state }])));
        const parameters = new Map(tunableParametersOf(plan.document));
        refit = { plan, report: result.report };
        refit.rows = result.report.finalParameters.map((entry) => {
            const state = states.get(entry.parameterId);
            const parameter = parameters.get(entry.parameterId);
            return state
                ? `${state.node.name} · ${state.state.name} at ${Number((plan.anchor / 3600).toFixed(2))} h: ${shown(state.state.initialValue)} → ${shown(entry.value)}`
                : `${parameter?.name ?? entry.parameterId}: ${shown(parameter?.value)} → ${shown(entry.value)}${parameter?.unit ? ` ${parameter.unit}` : ''}`;
        });
        $('#refitRows').replaceChildren(...refit.rows.map((text) => element('div', { textContent: text })));
        $('#refitStatus').className = 'status good';
        $('#refitStatus').textContent = 'Apply it to run the twin on from that window with these values.';
        $('#refitApply').hidden = !twin.running;
        $('#refitKeep').hidden = !twin.running || !plan.tunable.some((entry) => entry.kind === 'parameter');
    } catch (error) {
        refit = null;
        $('#refitStatus').className = 'status warning';
        $('#refitStatus').textContent = `The refit could not run: ${cleanError(error)}`;
    } finally {
        if (currentTwin() === twin) refreshButtons(twin);
    }
}

const tunableParametersOf = (model) => [
    ...(model.sharedParameters ?? []), ...model.edges.flatMap((edge) => edge.parameters ?? []),
    ...model.nodes.flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => term.parameters ?? []))
].map((parameter) => [parameter.id, parameter]);

async function applyRefit(keep) {
    const twin = currentTwin();
    if (!twin || !refit?.report) return;
    const { plan, report, rows } = refit;
    $('#refitApply').hidden = true;
    $('#refitKeep').hidden = true;
    try {
        await host.api.liveTwin.applyRefit(report.finalParameters, plan.cycle);
    } catch (error) {
        $('#refitStatus').className = 'status warning';
        $('#refitStatus').textContent = `The refit was not applied: ${cleanError(error)}`;
        return;
    }
    refit = null;
    let kept = '';
    if (keep) {
        const parameterIds = new Set(plan.tunable.filter((entry) => entry.kind === 'parameter').map((entry) => entry.id));
        kept = `; ${await keepInModel(twin, report.finalParameters.filter((entry) => parameterIds.has(entry.parameterId)))}`;
        renderTunable(twin);
    }
    $('#refitStatus').className = 'status good';
    $('#refitStatus').textContent = `Applied from the move at ${Number((plan.anchor / 3600).toFixed(2))} h.`;
    addEvent('info', 'A refit was applied to the twin', `${rows.join('; ')}; it runs on from the move at ${Number((plan.anchor / 3600).toFixed(2))} h${kept}`, plan.now);
}

// ---- The warning --------------------------------------------------------------------------------------------------------------------
async function setAlert() {
    const twin = currentTwin();
    if (!twin) return;
    const text = $('#alertAmount').value.trim();
    const amount = Number(text);
    const tolerance = twin.tiles[0]?.tolerance;
    const alertAt = text !== '' && amount > 0 && tolerance > 0 ? amount / tolerance : null;
    const modelUnit = twin.tiles[0]?.target?.unit ?? '';
    const shownUnit = modelUnit === 'K' && twin.layout?.temperature !== 'K' ? '°C' : modelUnit;
    const unit = shownUnit ? ` ${shownUnit}` : '';
    try {
        if (twin.running) await host.api.liveTwin.setAlert(alertAt);
    } catch (error) {
        addEvent('lean', 'The warning was not changed', cleanError(error));
        return;
    }
    twin.settings = { ...twin.settings, alertAt };
    twin.run.live.alert = alertAt === null ? 0 : amount;
    host.saveLive({ alert: twin.run.live.alert });
    addEvent('info', alertAt === null ? 'No drift warning now' : `The warning set to ${shown(amount)}${unit} a move`, 'from the next move on');
}

// ---- What each move does with each measured signal, and what the estimator tracks ------------------------------------------------
function renderCorrections(twin) {
    const live = twin.run.live;
    $('#correctionRows').replaceChildren(...twin.tiles.map((tile) => {
        const correction = live.corrections[tile.name];
        const choice = element('select');
        choice.dataset.signal = tile.name;
        choice.setAttribute('aria-label', `What a move does with ${tile.target?.label ?? tile.name}`);
        choice.append(new Option('Reset to the reading', 'reset'), new Option('Nudge toward it', 'nudge'), new Option('Watch only', 'watch'), new Option('Estimate', 'estimate'));
        choice.value = correction?.estimate ? 'estimate' : correction?.gain === 0 ? 'watch' : correction && correction.gain < 1 ? 'nudge' : 'reset';
        const gain = element('input', { type: 'number', min: '0.01', max: '0.99', step: '0.05', value: String(correction?.gain > 0 && correction.gain < 1 ? correction.gain : 0.3) });
        gain.dataset.signal = tile.name;
        gain.setAttribute('aria-label', `How far each move nudges ${tile.target?.label ?? tile.name} toward its reading`);
        gain.hidden = choice.value !== 'nudge';
        const noise = element('input', { type: 'number', min: '0', step: 'any', placeholder: 'noise: read', value: correction?.noise ? String(correction.noise) : '', title: 'How noisy the readings are, as a standard deviation in their unit; left empty, it is read from the readings themselves' });
        noise.dataset.noise = tile.name;
        noise.setAttribute('aria-label', `The noise of ${tile.target?.label ?? tile.name}'s readings`);
        noise.hidden = choice.value !== 'estimate';
        choice.addEventListener('change', () => {
            gain.hidden = choice.value !== 'nudge';
            noise.hidden = choice.value !== 'estimate';
            refreshTracking(twin);
            markDirty();
        });
        gain.addEventListener('change', () => markDirty());
        noise.addEventListener('change', () => markDirty());
        return element('div', { className: 'correctionRow' }, element('span', { textContent: tile.target?.label ?? tile.name }), choice, gain, noise);
    }));
    // How far each state may drift in an hour, beyond what the model says: empty for the estimator's own choice, shown as a hint.
    const used = new Map((twin.cycles.at(-1)?.estimate?.states ?? []).map((entry) => [entry.stateId, entry.drift]));
    $('#driftRows').replaceChildren(...host.states().map((candidate) => {
        const field = element('input', { type: 'number', min: '0', step: 'any', value: live.drift?.[candidate.id] ? String(live.drift[candidate.id]) : '', placeholder: used.has(candidate.id) ? shown(used.get(candidate.id)) : 'its own' });
        field.dataset.stateId = String(candidate.id);
        field.setAttribute('aria-label', `How far ${candidate.label} may drift in an hour`);
        field.addEventListener('change', () => markDirty());
        return element('label', { className: 'field inline' }, element('span', { textContent: `${candidate.label}${candidate.unit ? ` (${candidate.unit})` : ''}` }), field);
    }));
    const tracked = new Set(live.untracked);
    $('#trackRows').replaceChildren(...tunableParameters(twin.settings.document).map((parameter) => {
        const box = element('input', { type: 'checkbox', checked: !tracked.has(parameter.parameterId) });
        box.dataset.parameterId = String(parameter.parameterId);
        box.addEventListener('change', () => markDirty());
        return element('label', {}, box, `${parameter.name}`, element('small', { textContent: ` ${parameter.owner}` }));
    }));
    refreshTracking(twin);
}

function refreshTracking() {
    const estimating = $$('#correctionRows select').some((choice) => choice.value === 'estimate');
    $('#trackBlock').hidden = !estimating;
    $('#trackParameters').hidden = !$$('#trackRows input').length;
}

function liveFromForm(twin) {
    const corrections = {};
    for (const choice of $$('#correctionRows select')) {
        const name = choice.dataset.signal;
        if (choice.value === 'estimate') {
            const noise = Number($(`#correctionRows input[data-noise="${CSS.escape(name)}"]`).value);
            corrections[name] = noise > 0 ? { estimate: true, noise } : { estimate: true };
        }
        else if (choice.value === 'watch') corrections[name] = { gain: 0 };
        else if (choice.value === 'nudge') {
            const gain = Number($(`#correctionRows input[data-signal="${CSS.escape(name)}"]`).value);
            corrections[name] = { gain: gain > 0 && gain < 1 ? gain : 0.3 };
        }
    }
    const minutes = (selector, fallback) => {
        const value = Number($(selector).value);
        return value > 0 ? value * 60 : fallback;
    };
    return {
        ...twin.run.live,
        window: minutes('#timingWindow', twin.run.live.window), stride: minutes('#timingStride', twin.run.live.stride), horizon: minutes('#timingHorizon', twin.run.live.horizon),
        timeStep: Number($('#timingStep').value) > 0 ? Number($('#timingStep').value) : twin.run.live.timeStep,
        corrections,
        members: Math.round(Number($('#members').value)) || 32,
        untracked: $$('#trackRows input').filter((box) => !box.checked).map((box) => Number(box.dataset.parameterId)),
        drift: Object.fromEntries($$('#driftRows input').filter((field) => Number(field.value) > 0).map((field) => [field.dataset.stateId, Number(field.value)]))
    };
}

async function restart() {
    const twin = currentTwin();
    if (!twin || !dirty) return;
    const live = liveFromForm(twin);
    dirty = false;
    $('#restartTwin').disabled = true;
    $('#restartNote').textContent = '';
    await host.restartWith(live);
}
