/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The engineer's view of the control room (docs/proposals/controlRoom.md, "The engineer's view, and changing the model"): what
// changes the twin. A tunable parameter set here, or a refit accepted, is applied to the twin from its latest move and kept in the
// model (an undoable edit in the project window), so there is one model; the warning is taken at once; what a move does with each
// measured signal, the parameters the estimator tracks, and the twin's timing take effect when it starts again.

import { $, $$, cleanError, dataClock, element, formatSpan, shown, tunableParameters, withValues } from './common.mjs';
import { addEvent, baselineTakes, currentTwin } from './room.mjs';
import { forecastChoices, forecastLabels, parsePlan, planText } from '../inputForecast.mjs';
import { modelTimeStep, timingProblem } from '../twinSetup.mjs';

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
    for (const field of ['#members', '#inputUncertainty', '#timingWindow', '#timingStride', '#timingHorizon', '#timingStep']) $(field).addEventListener('change', () => markDirty());
    // The unit the window, the time between moves and the forecast are typed in: what they read is kept, only said in another unit.
    $('#timingUnit').addEventListener('change', () => {
        const from = Number($('#timingUnit').dataset.factor) || 60;
        const to = Number($('#timingUnit').value);
        for (const field of [...timingFields.map((selector) => $(selector)), ...$$('.forecastSpan')]) {
            const value = Number(field.value);
            if (field.value !== '' && Number.isFinite(value)) field.value = String(Number((value * from / to).toPrecision(12)));
        }
        showTimingUnit(to);
    });
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
    showTiming(twin);
    $('#members').value = String(live.members);
    $('#inputUncertainty').checked = live.inputUncertainty !== false;
    renderTunable(twin);
    renderCorrections(twin);
    renderInputForecasts(twin);
    refreshButtons(twin);
}

export function engineerCycle(twin, cycle) {
    if (!on) return;
    refreshButtons(twin);
    showInputScores(twin, cycle);
    // A tracked parameter's estimate, shown where its slider would be.
    for (const parameter of cycle?.estimate?.parameters ?? []) {
        const value = $(`#tunableRows [data-parameter-id="${parameter.parameterId}"] .trackedValue`);
        if (value) value.textContent = `${shown(parameter.mean)} ± ${shown(parameter.spread)}`;
    }
}

function refreshButtons(twin) {
    $('#refitRun').disabled = !twin.running || !twin.cycles.length || Boolean(refit?.running);
    $('#refitRun').title = !twin.running ? 'The twin has stopped: a refit is fitted on its latest window while it runs (Back to the setup, then Start)'
        : !twin.cycles.length ? 'Wait for the twin\'s first move: a refit is fitted on its latest window'
        : refit?.running ? 'A refit is running' : 'Fit the tunable values to the latest window';
    for (const field of $$('#tunableRows input')) field.disabled = !twin.running || !twin.cycles.length;
    $('#restartTwin').disabled = !dirty || Boolean(timingProblem(liveFromForm(twin)) ?? inputsFromForm(twin, Number($('#timingUnit').value) || 60).problem);
    // What a refit found: applied to the twin while it runs. Once it has stopped (a log played to its end while the fit ran) there is
    // no twin to run on with it, so Apply is not offered, and says why; the values can still be kept in the model, for its next run.
    if (refit?.report) {
        const parameters = refit.plan.tunable.some((entry) => entry.kind === 'parameter');
        $('#refitApply').hidden = !twin.running;
        $('#refitKeep').hidden = !parameters;
        $('#refitKeep').textContent = twin.running ? 'Apply, and keep in the model' : 'Keep in the model';
        if (!twin.running) {
            $('#refitStatus').className = 'status warning';
            $('#refitStatus').textContent = `The twin has stopped, so it cannot run on with these values${parameters ? '; they can still be kept in the model, for its next run' : ''}.`;
        }
    }
}

// ---- Each input, in the forecast ----------------------------------------------------------------------------------------------------
// How each input is carried past now (src/inputForecast.mjs): the choice, and the spans it reads, in the timing's unit (the span an
// average or a trend is read over, empty for the window; how long a trend takes to level off, empty for the forecast's length; the
// period a day is repeated at, empty for a day). Taken when the twin starts again.
const spanFields = { span: ['mean', 'trend', 'trend2', 'automatic'], damping: ['trend', 'trend2'], period: ['day'] };
const spanPlaceholders = { span: 'over: the window', damping: 'levels off: forecast', period: 'period: a day' };

// An input's values as the room reads them: temperatures in °C unless it is set to kelvin, as the model keeps them.
function inputScale(twin, unit) {
    return unit === 'K' && twin.layout?.temperature !== 'K'
        ? { unit: '°C', shown: (value) => value - 273.15, kept: (value) => value + 273.15 }
        : { unit: unit ?? '', shown: (value) => value, kept: (value) => value };
}
// The computer's own time zone, for a plan written here.
const ownTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function renderInputForecasts(twin) {
    const live = twin.run.live;
    const factor = Number($('#timingUnit').dataset.factor) || 60;
    if (!twin.inputs.length) {
        $('#inputForecastRows').replaceChildren(element('p', { className: 'hint', textContent: 'No input is mapped.' }));
        return;
    }
    $('#inputForecastRows').replaceChildren(...twin.inputs.map((input) => {
        const name = twin.run.nameOf(input.signal);
        const label = input.target?.label.replace(/^Shared · /, '') ?? name;
        const setting = live.inputs?.[name] ?? { forecast: 'hold' };
        const choice = element('select', { className: 'forecastChoice' });
        choice.dataset.input = name;
        choice.setAttribute('aria-label', `What the forecast assumes of ${label}`);
        choice.append(...forecastChoices.map((value) => new Option(forecastLabels[value], value)));
        choice.value = setting.forecast;
        const fields = Object.keys(spanFields).map((key) => {
            const field = element('input', { type: 'number', min: '0', step: 'any', className: 'forecastSpan', placeholder: spanPlaceholders[key], value: setting[key] ? String(Number((setting[key] / factor).toPrecision(12))) : '' });
            field.dataset.input = name;
            field.dataset.key = key;
            field.title = { span: 'How far back an average or a trend is read', damping: 'How long the trend keeps its pace before it levels off', period: 'How long ago the input is repeated from' }[key];
            field.setAttribute('aria-label', `${field.title}, for ${label}`);
            field.addEventListener('change', () => markDirty());
            return field;
        });
        // From a plan: daily or weekly, the programme as times and values (in the unit the room reads the input in), and the plant's
        // time zone (the computer's, for a new plan).
        const scale = inputScale(twin, input.target?.unit);
        const repeat = element('select', { className: 'forecastRepeat' });
        repeat.append(new Option('Daily', 'daily'), new Option('Weekly', 'weekly'));
        repeat.value = setting.plan?.repeat ?? 'daily';
        const programme = element('textarea', {
            className: 'forecastPlan', rows: 3, placeholder: `06:30 ${scale.unit === '°C' ? '21' : '1'}\n23:00 ${scale.unit === '°C' ? '17' : '0'}`,
            value: setting.plan ? planText(setting.plan, scale.shown) : ''
        });
        programme.title = `One time and value to a line${scale.unit ? `, in ${scale.unit}` : ''}; weekly, the day first (Mon 06:30 21). Each value holds until the next.`;
        const zone = element('input', { type: 'text', className: 'forecastZone', value: setting.plan?.timeZone ?? ownTimeZone(), title: 'The time zone the plan\'s times are in' });
        // From the model: the state it follows past now (a controller's output), any but those the readings measure.
        const measured = new Set(twin.tiles.map((tile) => tile.target?.id));
        const follow = element('select', { className: 'forecastState' });
        follow.append(...host.states().filter((candidate) => !measured.has(candidate.id)).map((candidate) => new Option(candidate.label, String(candidate.id))));
        if (setting.state) follow.value = String(setting.state);
        follow.title = 'The state of the model the input follows past now, from its last reading: a controller\'s output';
        for (const [element_, label_] of [[repeat, 'How the plan repeats'], [programme, 'The plan'], [zone, 'The plan\'s time zone'], [follow, 'The state it follows']]) {
            element_.dataset.input = name;
            element_.setAttribute('aria-label', `${label_}, for ${label}`);
            element_.addEventListener('change', () => markDirty());
        }
        const showFields = () => {
            fields.forEach((field) => { field.hidden = !spanFields[field.dataset.key].includes(choice.value); });
            for (const field of [repeat, programme, zone]) field.hidden = choice.value !== 'plan';
            follow.hidden = choice.value !== 'model';
        };
        showFields();
        choice.addEventListener('change', () => { showFields(); markDirty(); });
        const score = element('small', { className: 'forecastScore' });
        score.dataset.input = input.signal;
        return element('div', { className: 'forecastRow' }, element('span', { textContent: label }), choice, ...fields, repeat, zone, programme, follow, score);
    }));
    showInputScores(twin, twin.cycles.at(-1));
}

// The score beside each input: how its forecasts would have done, by the choice that came closest, against holding it; and what the
// forecast assumes of it now, and why, when that is not Hold.
function showInputScores(twin, cycle) {
    for (const score of $$('#inputForecastRows .forecastScore')) {
        const input = twin.inputs.find((candidate) => candidate.signal === score.dataset.input);
        const unit = input?.target?.unit ? ` ${input.target.unit}` : '';
        const scored = cycle?.inputScores?.[score.dataset.input];
        const projection = cycle?.projections?.[score.dataset.input];
        const parts = [];
        if (projection && projection.choice !== 'hold') parts.push(`Now: ${forecastLabels[projection.using].toLowerCase()}${projection.reason ? ` (${projection.reason})` : ''}.`);
        if (scored?.projections) {
            const ranked = Object.entries(scored.error).filter(([choice]) => choice !== 'automatic').sort((a, b) => a[1] - b[1]);
            const [best, error] = ranked[0];
            const figure = (value) => `${shown(Number(value.toPrecision(3)))}${unit}`;
            parts.push(best === 'hold' || !(error < scored.error.hold)
                ? `Over ${scored.projections} forecasts, holding has been closest (missed by ${figure(scored.error.hold)}).`
                : `Over ${scored.projections} forecasts, ${forecastLabels[best].toLowerCase()} would have been ${Number((scored.error.hold / Math.max(error, 1e-12)).toPrecision(2))}× closer than holding (${figure(error)} against ${figure(scored.error.hold)}).`);
        } else parts.push('Scored once a forecast\'s horizon has passed.');
        score.textContent = parts.join(' ');
    }
}

// What each input's choice in the form says, for the live settings; `problem` the first thing that cannot be used as written.
function inputsFromForm(twin, factor) {
    const inputs = {};
    let problem = null;
    for (const choice of $$('#inputForecastRows .forecastChoice')) {
        const name = choice.dataset.input;
        if (choice.value === 'hold') continue;
        const of = (selector) => $(`#inputForecastRows ${selector}[data-input="${CSS.escape(name)}"]`);
        const setting = { forecast: choice.value };
        for (const field of $$('#inputForecastRows .forecastSpan').filter((entry) => entry.dataset.input === name && !entry.hidden && Number(entry.value) > 0)) {
            setting[field.dataset.key] = Number((Number(field.value) * factor).toPrecision(12));
        }
        if (choice.value === 'plan') {
            const input = twin.inputs.find((candidate) => twin.run.nameOf(candidate.signal) === name);
            const scale = inputScale(twin, input?.target?.unit);
            const repeat = of('.forecastRepeat').value;
            const parsed = parsePlan(of('.forecastPlan').value, repeat);
            let timeZone = of('.forecastZone').value.trim() || ownTimeZone();
            try {
                timeZone = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
            } catch {
                problem ??= `${input?.target?.label.replace(/^Shared · /, '') ?? name}'s plan: "${timeZone}" is not a time zone (Europe/Paris, UTC).`;
            }
            if (parsed.error) problem ??= `${input?.target?.label.replace(/^Shared · /, '') ?? name}'s plan: ${parsed.error}`;
            else setting.plan = { repeat, timeZone, points: parsed.points.map((point) => ({ ...point, value: scale.kept(point.value) })) };
        }
        if (choice.value === 'model') {
            const state = Number(of('.forecastState').value);
            if (!(state > 0)) problem ??= `${name}: choose the state of the model it follows.`;
            else setting.state = state;
        }
        inputs[name] = setting;
    }
    return { inputs, problem };
}

// ---- Timing ------------------------------------------------------------------------------------------------------------------------
// The window, the time between moves and the forecast, in the unit that reads at the twin's scale: seconds for a motor that moves
// every second, minutes for a tank that moves every ten, hours for one that moves every hour or more. The time step is in seconds.
const timingFields = ['#timingWindow', '#timingStride', '#timingHorizon'];
const timingUnitOf = (stride) => (stride < 60 ? 1 : stride < 3600 ? 60 : 3600);

function showTimingUnit(factor) {
    $('#timingUnit').value = String(factor);
    $('#timingUnit').dataset.factor = String(factor);
    for (const name of $$('.timingUnitName')) name.textContent = { 1: 's', 60: 'min', 3600: 'h' }[factor];
}

// The twin's timing as it runs, in the form (the timing chosen from a live source's first readings arrives while it may be open).
export function showTiming(twin) {
    const live = twin.run.live;
    const factor = timingUnitOf(live.stride);
    showTimingUnit(factor);
    for (const [field, key] of [['#timingWindow', 'window'], ['#timingStride', 'stride'], ['#timingHorizon', 'horizon']]) $(field).value = String(Number((live[key] / factor).toPrecision(12)));
    $('#timingStep').value = String(live.timeStep);
    timingNote(twin, live);
}

// A time step longer than the one the model's own runs take, said: a stiff model (a motor's current, which settles in milliseconds)
// can run away at a longer one, its values growing without end.
function timingNote(twin, live) {
    const own = modelTimeStep(twin.settings.document);
    const longer = own && live.timeStep > own * (1 + 1e-9);
    $('#timingNote').className = longer ? 'status warning' : 'status';
    $('#timingNote').textContent = longer ? `The model's own runs step every ${formatSpan(own)}: a longer step can make a fast model run away. Shorten it if the twin's values grow without end.` : '';
}

// Settings changed, to be taken when the twin starts again; timing it could not run with is said at once, and the twin is not stopped
// for it.
function markDirty() {
    dirty = true;
    const twin = currentTwin();
    const problem = twin ? timingProblem(liveFromForm(twin)) ?? inputsFromForm(twin, Number($('#timingUnit').value) || 60).problem : null;
    if (twin) timingNote(twin, liveFromForm(twin));
    $('#restartTwin').disabled = Boolean(problem);
    $('#restartNote').className = problem ? 'status warning' : 'status';
    $('#restartNote').textContent = problem ?? (twin?.run.source.kind === 'recording'
        ? 'Taken when the twin starts again: the recording is played again from its start.'
        : 'Taken when the twin starts again: it follows its source again from now.');
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
    // The field's change said again with the value it already has (a field committing once more as it loses focus): nothing to set.
    if (value === parameter.value) return;
    const at = twin.cycles.at(-1);
    const from = parameter.value;
    let applied;
    try {
        applied = await host.api.liveTwin.applyRefit([{ parameterId: parameter.parameterId, value }], at.index);
    } catch (error) {
        addEvent('bad', `${parameter.name} could not be set`, cleanError(error));
        return;
    }
    parameter.value = value;
    for (const field of fields) field.value = String(field.type === 'number' ? Number(value.toPrecision(6)) : value);
    const kept = await keepInModel(twin, [{ parameterId: parameter.parameterId, value }]);
    // Said at the one time the strips mark it: where the twin's record starts with it.
    const takesEffect = Number.isFinite(applied?.takesEffect) ? applied.takesEffect : at.now;
    addEvent('info', `${parameter.name} set from ${shown(from)} to ${shown(value)}${parameter.unit ? ` ${parameter.unit}` : ''}`, `the twin runs on with it from ${dataClock(takesEffect)} of data; ${kept}`, takesEffect);
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
    $('#refitStatus').textContent = `Refitting on the window from ${dataClock(plan.anchor)} to ${dataClock(plan.now)}…`;
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
                ? `${state.node.name} · ${state.state.name} at ${dataClock(plan.anchor)}: ${shown(state.state.initialValue)} → ${shown(entry.value)}`
                : `${parameter?.name ?? entry.parameterId}: ${shown(parameter?.value)} → ${shown(entry.value)}${parameter?.unit ? ` ${parameter.unit}` : ''}`;
        });
        $('#refitRows').replaceChildren(...refit.rows.map((text) => element('div', { textContent: text })));
        $('#refitStatus').className = 'status good';
        $('#refitStatus').textContent = 'Apply it to run the twin on from that window with these values.';
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
    // Stopped: kept in the model only, for the twin's next run.
    if (!twin.running) {
        if (!keep) return;
        refit = null;
        const parameterIds = new Set(plan.tunable.filter((entry) => entry.kind === 'parameter').map((entry) => entry.id));
        const kept = await keepInModel(twin, report.finalParameters.filter((entry) => parameterIds.has(entry.parameterId)));
        renderTunable(twin);
        $('#refitStatus').className = 'status good';
        $('#refitStatus').textContent = 'Kept in the model, for the twin\'s next run.';
        addEvent('info', 'What a refit found is kept in the model', `${rows.join('; ')}; ${kept}`, plan.now);
        return;
    }
    let applied;
    try {
        applied = await host.api.liveTwin.applyRefit(report.finalParameters, plan.cycle);
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
    // One time for it, the one the strips mark: where the twin's record starts with the new values. (The window it was fitted on is
    // said as a span, so it is not read as a second time it took effect.)
    const takesEffect = Number.isFinite(applied?.takesEffect) ? applied.takesEffect : plan.now;
    $('#refitStatus').className = 'status good';
    $('#refitStatus').textContent = `Applied: the twin runs with the new values from ${dataClock(takesEffect)} of data.`;
    addEvent('info', 'A refit was applied to the twin', `${rows.join('; ')}, fitted on the window from ${dataClock(plan.anchor)} to ${dataClock(plan.now)}; the twin runs with them from ${dataClock(takesEffect)}${kept}`, takesEffect);
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
    const factor = Number($('#timingUnit').value) || 60;
    // In seconds, rounded off the unit's conversion (0.1 min is 6 s, not 6.000000000000001).
    const span = (selector, fallback) => {
        const value = Number($(selector).value);
        return value > 0 ? Number((value * factor).toPrecision(12)) : fallback;
    };
    return {
        ...twin.run.live,
        window: span('#timingWindow', twin.run.live.window), stride: span('#timingStride', twin.run.live.stride), horizon: span('#timingHorizon', twin.run.live.horizon),
        timeStep: Number($('#timingStep').value) > 0 ? Number($('#timingStep').value) : twin.run.live.timeStep,
        corrections,
        members: Math.round(Number($('#members').value)) || 32,
        untracked: $$('#trackRows input').filter((box) => !box.checked).map((box) => Number(box.dataset.parameterId)),
        inputs: inputsFromForm(twin, factor).inputs,
        inputUncertainty: $('#inputUncertainty').checked,
        drift: Object.fromEntries($$('#driftRows input').filter((field) => Number(field.value) > 0).map((field) => [field.dataset.stateId, Number(field.value)]))
    };
}

async function restart() {
    const twin = currentTwin();
    if (!twin || !dirty) return;
    const live = liveFromForm(twin);
    if (timingProblem(live) || inputsFromForm(twin, Number($('#timingUnit').value) || 60).problem) return markDirty();
    dirty = false;
    $('#restartTwin').disabled = true;
    $('#restartNote').textContent = '';
    await host.restartWith(live);
}
