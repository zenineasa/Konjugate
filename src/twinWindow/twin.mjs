/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The twin's own window (docs/proposals/controlRoom.md): the setup (the model, where its readings come from, and how they map to it,
// with suggestions and unit conversions proposed), then the control room, a tile for every measured signal and the health of the
// twin and its source along the top. The setup is handed back to the project window to be kept with the project; matches confirmed
// are remembered across projects.

import { readDataLog } from '../dataLog.mjs';
import { defaultTolerance, suggestedReplayTimeStep } from '../dataLogReplay.mjs';
import { suggestSymbol } from '../csvImport.mjs';
import { mappingCandidates, rememberMapping, suggestMapping } from '../signalMatching.mjs';
import { twinSessionMapping } from '../twinSetup.mjs';
import { unitConversion } from '../units.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const api = window.twin;
const confident = 0.75;
const cleanError = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

const state = {
    context: null,      // { document, projectName, projectPath, setup }
    candidates: [],     // the model's quantities a signal can map to
    source: null,       // { kind, ... } chosen in step 2
    signals: [],        // what the source offers: { id (the source's own key), name, unit, values, role }
    rows: [],           // one per signal: { signal, name, role, target, conversion, suggestion }
    log: null,          // a data log chosen or played: { content, header, observations, fileName, path, speed }
    memory: {},
    twin: null          // the running twin's view
};

// ---- Window controls -------------------------------------------------------------------------------------------------------------
$('#minimize').addEventListener('click', () => window.windowControls.minimize());
$('#maximize').addEventListener('click', () => window.windowControls.toggleMaximize());
$('#close').addEventListener('click', () => window.windowControls.close());

// ---- Step 1: the model ---------------------------------------------------------------------------------------------------------
function renderModel() {
    const { document: model, projectName } = state.context;
    $('#projectName').textContent = projectName ? `· ${projectName}` : '';
    state.candidates = mappingCandidates(model);
    const states = state.candidates.filter((candidate) => candidate.kind === 'state');
    const parameters = state.candidates.filter((candidate) => candidate.kind === 'parameter');
    const chip = (candidate) => {
        const element = document.createElement('span');
        element.className = `chip${candidate.kind === 'parameter' ? ' input' : ''}`;
        element.textContent = candidate.label.replace(/^Shared · /, '');
        if (candidate.unit) element.append(Object.assign(document.createElement('small'), { textContent: ` ${candidate.unit}` }));
        return element;
    };
    const summary = $('#modelSummary');
    summary.replaceChildren(
        Object.assign(document.createElement('span'), { className: 'hint', textContent: `${states.length} state${states.length === 1 ? '' : 's'} to compare with sensors:` }),
        ...states.map(chip),
        ...(parameters.length ? [Object.assign(document.createElement('span'), { className: 'hint', textContent: ` and ${parameters.length} shared parameter${parameters.length === 1 ? '' : 's'} to drive with inputs:` }), ...parameters.map(chip)] : [])
    );
    if (!states.length) summary.append(Object.assign(document.createElement('p'), { className: 'status warning', textContent: 'The model has no states, so there is nothing to compare with readings. Add a node with a state in the project window first.' }));
}

// ---- Step 2: the source --------------------------------------------------------------------------------------------------------
function chooseSourceTile(kind) {
    for (const tile of $$('[data-source]')) tile.setAttribute('aria-pressed', String(tile.dataset.source === kind));
    $('#sourceForm').hidden = false;
    for (const form of $$('[data-form]')) form.hidden = form.dataset.form !== kind;
    if (kind === 'push') refreshPushState();
}
for (const tile of $$('[data-source]')) tile.addEventListener('click', () => chooseSourceTile(tile.dataset.source));

function sourceStatus(text, kind = '') {
    $('#sourceStatus').className = `status${kind ? ` ${kind}` : ''}`;
    $('#sourceStatus').textContent = text;
}

// A data log's signals, with their first readings to judge them by.
function offerLog(content, { fileName, path = null, speed = '600', demo = false }) {
    let log;
    try {
        log = readDataLog(content);
    } catch (error) {
        sourceStatus(`That file is not a Konjugate data log: ${cleanError(error)}`, 'warning');
        return;
    }
    state.log = { content, header: log.header, observations: log.observations, fileName, path, speed, demo };
    state.source = { kind: 'file', fileName };
    const values = (name) => log.observations.filter((observation) => observation.signal === name && observation.quality !== 'bad').slice(0, 60).map((observation) => observation.value);
    offerSignals(log.header.signals.map((signal) => ({ id: signal.name, name: signal.name, unit: signal.unit, role: signal.role, values: values(signal.name) })));
    sourceStatus(`${log.header.signals.length} signals in ${fileName}, ${log.observations.length} readings${log.header.source ? `, from ${log.header.source}` : ''}.`, 'good');
}

$('#fileInput').addEventListener('change', async () => {
    const file = $('#fileInput').files[0];
    if (!file) return;
    offerLog(await file.text(), { fileName: file.name, path: api.liveTwin.pathForFile(file), speed: $('#fileSpeed').value });
});
$('#fileSpeed').addEventListener('change', () => { if (state.log) state.log.speed = $('#fileSpeed').value; });

for (const button of $$('[data-demo]')) {
    button.addEventListener('click', async () => {
        try {
            const demo = await api.liveTwin.demo(button.dataset.demo);
            chooseSourceTile('file');
            $('#fileSpeed').value = '600';
            offerLog(demo.log.content, { fileName: demo.log.fileName, speed: '600', demo: true });
            // The rig's readings against another model match nothing: its own model is one click away, opened in the project window.
            if (!state.candidates.some((candidate) => candidate.label === 'Water tank · Water temperature')) {
                sourceStatus('These are the simulated rig\'s readings, and this project is another model. Open the rig\'s model to compare them with it.', 'warning');
                const open = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Open the rig\'s model' });
                open.addEventListener('click', () => api.openDemoModel(button.dataset.demo));
                $('#sourceStatus').append(' ', open);
            }
        } catch (error) {
            sourceStatus(`The demonstration could not be opened: ${cleanError(error)}`, 'warning');
        }
    });
}

$('#mqttListen').addEventListener('click', async () => {
    const url = $('#mqttUrl').value.trim();
    sourceStatus(`Listening to ${url}…`);
    try {
        const heard = await api.liveTwin.listen(url, 3);
        state.source = { kind: 'mqtt', url };
        state.log = null;
        offerSignals(heard.filter((topic) => topic.numeric).map((topic) => ({ id: topic.topic, name: topic.topic, unit: '', values: [topic.value] })));
        sourceStatus(heard.length ? `Heard ${heard.length} topic${heard.length === 1 ? '' : 's'}${heard.some((topic) => !topic.numeric) ? `; those that are not numbers are left out` : ''}.` : 'Nothing was heard in 3 seconds. Is anything publishing to this broker?', heard.length ? 'good' : 'warning');
    } catch (error) {
        sourceStatus(`Could not listen to ${url}: ${cleanError(error)}`, 'warning');
    }
});

async function browseOpcUa(trustServer = false) {
    const url = $('#opcuaUrl').value.trim();
    const security = $('#opcuaSecurity').value;
    sourceStatus(`Browsing ${url}…`);
    try {
        const answer = await api.liveTwin.browseOpcUa(url, security, trustServer);
        if (answer.untrusted) {
            sourceStatus(answer.message, 'warning');
            if (window.confirm(`${answer.message}\n\nTrust this server's certificate?`)) return browseOpcUa(true);
            return;
        }
        state.source = { kind: 'opcua', url, security, trustServer };
        state.log = null;
        offerSignals(answer.tags.filter((tag) => tag.numeric).map((tag) => ({ id: tag.nodeId, name: tag.path, unit: tag.unit, values: tag.value === null ? [] : [Number(tag.value)] })));
        sourceStatus(`Found ${answer.tags.length} tag${answer.tags.length === 1 ? '' : 's'}.`, 'good');
    } catch (error) {
        sourceStatus(`Could not browse ${url}: ${cleanError(error)}`, 'warning');
    }
}
$('#opcuaBrowse').addEventListener('click', () => browseOpcUa(false));

async function refreshPushState() {
    const service = await api.pushService.state();
    $('#pushState').textContent = service.listening ? `The push service is listening${service.encrypted ? ' on the network, encrypted' : ''}.` : 'The push service is not listening: start it in the Connections panel, and make a key for each script.';
}
$('#pushConnections').addEventListener('click', () => api.openConnections());
$('#pushRefresh').addEventListener('click', async () => {
    const keys = (await api.pushService.keys()).filter((key) => !key.revoked);
    const names = [...new Set(keys.flatMap((key) => key.signals))];
    state.source = { kind: 'push' };
    state.log = null;
    offerSignals(names.map((name) => ({ id: name, name, unit: '', values: [] })));
    sourceStatus(names.length ? `${names.length} signal${names.length === 1 ? '' : 's'} the keys may send.` : 'No key may send anything yet: make one in the Connections panel.', names.length ? 'good' : 'warning');
});

// ---- Step 3: the mapping -------------------------------------------------------------------------------------------------------
// A name the twin can use for a signal (an identifier), unique among them.
function twinNames(signals) {
    const used = new Set();
    return signals.map((signal) => {
        let name = /^[A-Za-z][A-Za-z0-9_]*$/.test(signal.name) ? signal.name : suggestSymbol(signal.name) || 'signal';
        if (!/^[A-Za-z]/.test(name)) name = `s${name}`;
        let unique = name;
        for (let index = 2; used.has(unique); index += 1) unique = `${name}${index}`;
        used.add(unique);
        return unique;
    });
}

function offerSignals(signals) {
    state.signals = signals;
    const suggestions = suggestMapping(signals, state.context.document, { memory: state.memory });
    const names = twinNames(signals);
    const saved = state.context.setup?.source?.kind === state.source.kind ? state.context.setup.mapping : [];
    state.rows = signals.map((signal, index) => {
        const suggestion = suggestions[index];
        const kept = saved.find((entry) => entry.source === signal.id);
        if (kept) {
            const target = kept.target ? state.candidates.find((candidate) => candidate.kind === kept.target.kind && candidate.id === kept.target.id) : null;
            return { signal, name: names[index], role: target ? kept.role : null, target: target ?? null, conversion: kept.conversion, suggestion, kept: true };
        }
        const apply = suggestion.target && suggestion.confidence >= confident;
        return {
            signal, name: names[index], suggestion,
            role: apply ? suggestion.role : null,
            target: apply ? state.candidates.find((candidate) => candidate.kind === suggestion.target.kind && candidate.id === suggestion.target.id) : null,
            conversion: apply ? suggestion.conversion : null
        };
    });
    $('#stepMapping').hidden = false;
    renderRows();
    $('#stepMapping').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function sparkline(values) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 26');
    svg.setAttribute('preserveAspectRatio', 'none');
    if (values.length < 2) return svg;
    const low = Math.min(...values);
    const high = Math.max(...values);
    const span = high - low || 1;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    path.setAttribute('points', values.map((value, index) => `${(index / (values.length - 1)) * 100},${24 - ((value - low) / span) * 22}`).join(' '));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#42c9bc');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(path);
    return svg;
}

const shown = (value) => (Number.isFinite(value) ? Number(value.toPrecision(5)).toString() : '—');

function conversionFor(row, target) {
    if (!target || !row.signal.unit || !target.unit) return null;
    const found = unitConversion(row.signal.unit, target.unit);
    return found.error || found.identity ? null : { scale: found.scale, offset: found.offset, from: found.from, to: found.to, note: found.note ?? null };
}

function renderRows() {
    const filter = $('#mappingSearch').value.trim().toLowerCase();
    const container = $('#mappingRows');
    container.replaceChildren(...state.rows.filter((row) => !filter || row.signal.name.toLowerCase().includes(filter)).map((row) => {
        const element = document.createElement('div');
        const { suggestion } = row;
        const usingSuggestion = row.target && suggestion.target && row.target.kind === suggestion.target.kind && row.target.id === suggestion.target.id;
        element.className = `mappingRow ${!row.target ? 'unused' : usingSuggestion && suggestion.confidence >= confident || row.kept ? 'confident' : 'check'}`;
        element.dataset.signal = row.signal.id;
        element.setAttribute('role', 'row');
        // The signal: its name, unit, latest value and its course.
        const signal = document.createElement('div');
        signal.className = 'signal';
        signal.append(Object.assign(document.createElement('strong'), { textContent: row.signal.name }),
            Object.assign(document.createElement('small'), { textContent: `${shown(row.signal.values?.at(-1))}${row.signal.unit ? ` ${row.signal.unit}` : ''}${row.signal.role ? ` · declared ${row.signal.role === 'input' ? 'an input' : 'measured'}` : ''}` }),
            sparkline(row.signal.values ?? []));
        // Its role.
        const role = document.createElement('select');
        role.dataset.field = 'role';
        role.setAttribute('aria-label', `What ${row.signal.name} is`);
        role.append(new Option('Not used', ''), new Option('Input', 'input'), new Option('Measured', 'output'));
        role.value = row.role ?? '';
        role.addEventListener('change', () => {
            row.role = role.value || null;
            if (!row.role || (row.target && row.target.role !== row.role)) {
                row.target = null;
                row.conversion = null;
            }
            renderRows();
        });
        // What it maps to: the model's quantities for its role, the suggestion's alternatives first.
        const target = document.createElement('select');
        target.dataset.field = 'target';
        target.setAttribute('aria-label', `What ${row.signal.name} maps to`);
        target.disabled = !row.role;
        target.append(new Option(row.role ? 'Choose…' : '—', ''));
        for (const candidate of state.candidates.filter((item) => item.role === row.role)) {
            target.append(new Option(`${candidate.label.replace(/^Shared · /, '')}${candidate.unit ? ` (${candidate.unit})` : ''}`, `${candidate.kind}:${candidate.id}`));
        }
        target.value = row.target ? `${row.target.kind}:${row.target.id}` : '';
        target.addEventListener('change', () => {
            const [kind, id] = target.value.split(':');
            row.target = state.candidates.find((candidate) => candidate.kind === kind && candidate.id === Number(id)) ?? null;
            row.conversion = conversionFor(row, row.target);
            renderRows();
        });
        // The unit conversion: proposed, editable.
        const conversion = document.createElement('div');
        conversion.className = 'conversion';
        const unitCheck = row.target && row.signal.unit && row.target.unit ? unitConversion(row.signal.unit, row.target.unit) : null;
        if (!row.target) {
            conversion.textContent = '';
        } else if (unitCheck?.error && !row.conversion) {
            conversion.append(Object.assign(document.createElement('span'), { className: 'status warning', textContent: unitCheck.error }));
        } else {
            const said = row.conversion
                ? `${row.conversion.from ?? row.signal.unit} → ${row.conversion.to ?? row.target.unit}${row.conversion.note ? ` (${row.conversion.note})` : ''}`
                : row.signal.unit && row.target.unit ? `both in ${row.target.unit}` : 'no conversion';
            conversion.append(Object.assign(document.createElement('span'), { textContent: said }));
            const numbers = document.createElement('div');
            numbers.className = 'numbers';
            const scale = Object.assign(document.createElement('input'), { type: 'number', step: 'any', value: String(row.conversion?.scale ?? 1) });
            scale.setAttribute('aria-label', `Scale for ${row.signal.name}`);
            const offset = Object.assign(document.createElement('input'), { type: 'number', step: 'any', value: String(row.conversion?.offset ?? 0) });
            offset.setAttribute('aria-label', `Offset for ${row.signal.name}`);
            const change = () => {
                const nextScale = Number(scale.value);
                const nextOffset = Number(offset.value);
                if (!Number.isFinite(nextScale) || nextScale === 0 || !Number.isFinite(nextOffset)) return;
                row.conversion = nextScale === 1 && nextOffset === 0 ? null : { ...(row.conversion ?? {}), scale: nextScale, offset: nextOffset };
            };
            scale.addEventListener('change', change);
            offset.addEventListener('change', change);
            numbers.append('×', scale, '+', offset);
            conversion.append(numbers);
        }
        // Why: the suggestion, its confidence and reasons, and a button to use it when it is not in use.
        const why = document.createElement('div');
        why.className = 'why';
        if (row.kept && !usingSuggestion) {
            why.append(Object.assign(document.createElement('small'), { textContent: 'as set up last time' }));
        } else if (suggestion.target) {
            const badge = Object.assign(document.createElement('span'), { className: `confidence ${suggestion.confidence >= confident ? 'high' : suggestion.confidence >= 0.5 ? 'medium' : 'low'}`, textContent: `${Math.round(suggestion.confidence * 100)}%` });
            why.append(badge, document.createTextNode(usingSuggestion ? 'suggested' : `suggests ${suggestion.target.label.replace(/^Shared · /, '')}`),
                Object.assign(document.createElement('small'), { textContent: suggestion.reasons.join('; ') }));
            if (!usingSuggestion) {
                const use = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Use' });
                use.addEventListener('click', () => {
                    applySuggestion(row);
                    renderRows();
                });
                why.append(use);
            }
        } else {
            why.append(Object.assign(document.createElement('small'), { textContent: suggestion.reasons.join('; ') }));
        }
        element.append(signal, role, target, conversion, why);
        return element;
    }));
    const mapped = state.rows.filter((row) => row.target);
    const measured = mapped.filter((row) => row.role === 'output');
    const waiting = state.rows.filter((row) => row.suggestion.target && !row.target);
    $('#useAllSuggestions').hidden = waiting.length === 0;
    $('#useAllSuggestions').textContent = `Use every suggestion (${waiting.length})`;
    $('#mappingCount').textContent = `${mapped.length} of ${state.rows.length} signals mapped: ${measured.length} measured, ${mapped.length - measured.length} input${mapped.length - measured.length === 1 ? '' : 's'}.`;
    $('#openRoom').disabled = measured.length === 0;
    $('#setupStatus').className = 'status';
    $('#setupStatus').textContent = measured.length ? '' : 'Map at least one measured signal to a state, so there is something to compare.';
}

function applySuggestion(row) {
    const { suggestion } = row;
    if (!suggestion.target) return;
    row.role = suggestion.role;
    row.target = state.candidates.find((candidate) => candidate.kind === suggestion.target.kind && candidate.id === suggestion.target.id) ?? null;
    row.conversion = suggestion.conversion;
    row.kept = false;
}

$('#mappingSearch').addEventListener('input', () => renderRows());
$('#useAllSuggestions').addEventListener('click', () => {
    // Each model quantity once: a suggestion whose quantity another row already uses is left.
    for (const row of state.rows) {
        if (row.target || !row.suggestion.target) continue;
        const taken = state.rows.some((other) => other.target && other.target.kind === row.suggestion.target.kind && other.target.id === row.suggestion.target.id);
        if (!taken) applySuggestion(row);
    }
    renderRows();
});

// ---- Opening the control room --------------------------------------------------------------------------------------------------
function currentSetup() {
    return {
        source: state.source.kind === 'file' ? { kind: 'file', fileName: state.source.fileName } : state.source.kind === 'opcua' ? { kind: 'opcua', url: state.source.url, security: state.source.security } : { ...state.source },
        mapping: state.rows.map((row) => ({
            source: row.signal.id, name: row.name, role: row.target ? row.role : null, target: row.target ? { kind: row.target.kind, id: row.target.id } : null,
            unit: row.signal.unit ?? '', conversion: row.conversion ? { scale: row.conversion.scale, offset: row.conversion.offset } : null
        })),
        live: { window: 3600, stride: 600, horizon: 3600, speed: state.log?.speed ?? 'follow' }
    };
}

// The live twin's source, for the setup: only the signals mapped are followed.
function twinSource() {
    const mapped = state.rows.filter((row) => row.target);
    const signal = (row, key) => ({ [key]: row.signal.id, name: row.name, role: row.role, unit: row.signal.unit ?? '' });
    if (state.source.kind === 'file') {
        if (state.log.speed === 'follow' && state.log.path) return { kind: 'file', path: state.log.path };
        return { kind: 'recording', content: state.log.content, speed: state.log.speed === 'Infinity' ? Infinity : Number(state.log.speed === 'follow' ? 600 : state.log.speed) };
    }
    if (state.source.kind === 'mqtt') return { kind: 'mqtt', url: state.source.url, signals: mapped.map((row) => signal(row, 'topic')) };
    if (state.source.kind === 'opcua') return { kind: 'opcua', url: state.source.url, security: state.source.security, trustServer: state.source.trustServer, signals: mapped.map((row) => signal(row, 'nodeId')) };
    return { kind: 'push', url: 'the push service', signals: mapped.map((row) => signal(row, 'signal')) };
}

$('#openRoom').addEventListener('click', async () => {
    const setup = currentSetup();
    const { mapping, conversions } = twinSessionMapping(setup);
    // A data log's signals keep their own names; the twin's names are the setup's.
    const units = Object.fromEntries(state.rows.filter((row) => row.target).map((row) => [row.name, row.target.unit]));
    for (const [name, conversion] of Object.entries(conversions)) conversion.unit = units[name];
    // The tolerance of each measured signal from its first readings, converted; the drift warning a quarter of it a move.
    const tolerances = Object.fromEntries(state.rows.filter((row) => row.target && row.role === 'output').map((row) => {
        const conversion = conversions[row.name];
        const readings = (row.signal.values ?? []).map((value) => ({ value: conversion ? value * conversion.scale + conversion.offset : value }));
        return [row.name, readings.length > 1 ? defaultTolerance(readings) : 1];
    }));
    const timeStep = state.log ? suggestedReplayTimeStep(state.context.document, state.log.observations, mapping) : 60;
    const settings = {
        document: state.context.document, mapping, window: setup.live.window, stride: setup.live.stride, horizon: setup.live.horizon, timeStep,
        tolerances, corrections: {}, conversions, alertAt: 0.25
    };
    // A data log's own names are those the readings carry; a live source's are the twin's.
    if (state.source.kind === 'file') {
        settings.mapping = mapping.map((entry) => ({ ...entry, signal: state.rows.find((row) => row.name === entry.signal).signal.id }));
        settings.conversions = Object.fromEntries(Object.entries(conversions).map(([name, conversion]) => [state.rows.find((row) => row.name === name).signal.id, conversion]));
        settings.tolerances = Object.fromEntries(Object.entries(tolerances).map(([name, tolerance]) => [state.rows.find((row) => row.name === name).signal.id, tolerance]));
    }
    try {
        await api.saveSetup(setup);
        state.memory = rememberMapping(state.memory, state.rows.filter((row) => row.target).map((row) => ({ name: row.signal.name, role: row.role, target: row.target, conversion: row.conversion })), state.context.document);
        await api.memory.save(state.memory).catch(() => {});
        openRoom(settings);
        await api.liveTwin.start(settings, twinSource(), state.context.projectPath ?? null);
    } catch (error) {
        $('#setupStatus').className = 'status warning';
        $('#setupStatus').textContent = `The twin could not start: ${cleanError(error)}`;
        closeRoom();
    }
});

// ---- The control room ----------------------------------------------------------------------------------------------------------
function openRoom(settings) {
    $('#setup').hidden = true;
    $('#room').hidden = false;
    const measured = settings.mapping.filter((entry) => entry.role === 'output');
    const label = (entry) => state.candidates.find((candidate) => candidate.kind === 'state' && candidate.id === entry.stateId);
    state.twin = {
        settings, running: true, cycles: [],
        tiles: measured.map((entry) => ({ signal: entry.signal, target: label(entry), measured: new Map(), tolerance: settings.tolerances[entry.signal] }))
    };
    $('#tiles').replaceChildren(...state.twin.tiles.map((tile) => {
        const element = document.createElement('section');
        element.className = 'tile';
        element.dataset.signal = tile.signal;
        element.innerHTML = '<header><div><strong></strong> <small></small></div><span class="value">—</span></header><div class="plot"></div><div class="facts"></div>';
        $('strong', element).textContent = tile.target?.label ?? tile.signal;
        $('small', element).textContent = tile.signal;
        tile.element = element;
        return element;
    }));
    $('#healthTwin').className = 'healthItem';
    $('#healthTwin').textContent = 'Starting the twin…';
    $('#healthSource').className = 'healthItem';
    $('#healthSource').textContent = state.source.kind === 'file' ? `${state.log.fileName}${state.log.speed === 'follow' ? ', followed as it grows' : `, played at ${state.log.speed === 'Infinity' ? 'full speed' : `${state.log.speed}×`}`}` : state.source.url ?? 'the push service';
    $('#healthDrift').textContent = '';
    $('#roomStatus').textContent = '';
}

function closeRoom() {
    $('#room').hidden = true;
    $('#setup').hidden = false;
}

function drawTile(tile, cycle) {
    const rows = cycle.window[tile.signal] ?? [];
    for (const row of rows) tile.measured.set(row.time, row.measured);
    const measured = [...tile.measured].sort((a, b) => a[0] - b[0]);
    const latest = measured.at(-1)?.[1];
    const unit = tile.target?.unit ? ` ${tile.target.unit}` : '';
    $('.value', tile.element).textContent = `${shown(latest)}${unit}`;
    const jump = cycle.jumps?.[tile.signal]?.jump;
    const leaning = cycle.trend?.signal === tile.signal && cycle.trend.direction !== 'none';
    const alarm = cycle.trend?.signal === tile.signal && cycle.trend.alarm;
    tile.element.className = `tile ${alarm ? 'bad' : leaning || (Number.isFinite(jump) && Math.abs(jump) > tile.tolerance) ? 'lean' : 'good'}`;
    $('.facts', tile.element).textContent = '';
    for (const fact of [
        `last jump ${Number.isFinite(jump) ? `${shown(jump)}${unit}` : '—'}`,
        `tolerance ±${shown(tile.tolerance)}${unit}`,
        ...(alarm ? ['drifting past the warning'] : leaning ? [`leaning ${cycle.trend.direction} the readings`] : [])
    ]) $('.facts', tile.element).append(Object.assign(document.createElement('span'), { textContent: fact }));
    if (!globalThis.Plotly) return;
    const hours = (points) => points.map((point) => point.time / 3600);
    const window = rows.map((row) => ({ time: row.time, value: row.simulated }));
    const forecast = cycle.forecast?.[tile.signal] ?? [];
    globalThis.Plotly.react($('.plot', tile.element), [
        { type: 'scatter', mode: 'markers', name: 'Measured', x: measured.map(([time]) => time / 3600), y: measured.map(([, value]) => value), marker: { size: 3, color: '#e0894c' } },
        { type: 'scatter', mode: 'lines', name: 'Model', x: hours(window), y: window.map((point) => point.value), line: { width: 2, color: '#4b8fe2' } },
        { type: 'scatter', mode: 'lines', name: 'Forecast', x: hours(forecast), y: forecast.map((point) => point.value), line: { width: 2, dash: 'dash', color: '#4b8fe2' } }
    ], {
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: { color: '#9fb2bb', size: 11 }, margin: { l: 46, r: 10, t: 6, b: 28 }, showlegend: false,
        xaxis: { gridcolor: '#1c2c38', zeroline: false, title: { text: 'hours', standoff: 2 } }, yaxis: { gridcolor: '#1c2c38', zeroline: false },
        shapes: [{ type: 'rect', xref: 'x', yref: 'paper', x0: cycle.anchor / 3600, x1: cycle.now / 3600, y0: 0, y1: 1, fillcolor: 'rgba(57,135,229,.10)', line: { width: 0 }, layer: 'below' }]
    }, { displayModeBar: false, responsive: true });
}

api.liveTwin.onEvent((update) => {
    const twin = state.twin;
    if (!twin) return;
    if (update.type === 'cycle') {
        twin.cycles.push(update.cycle);
        const { stats, cycle } = update;
        $('#healthTwin').className = 'healthItem good';
        $('#healthTwin').textContent = `Live · ${stats.cycles} move${stats.cycles === 1 ? '' : 's'}${stats.lagSeconds > 0 ? ` · ${Math.round(stats.lagSeconds / 60)} min behind` : ''}`;
        const alarm = cycle.trend?.alarm;
        $('#healthDrift').className = `healthItem ${alarm ? 'bad' : cycle.trend?.direction !== 'none' ? 'lean' : 'good'}`;
        $('#healthDrift').textContent = alarm ? 'Drifting past the warning' : cycle.trend?.direction !== 'none' ? 'Leaning' : 'In step';
        for (const tile of twin.tiles) drawTile(tile, cycle);
    } else if (update.type === 'note') {
        $('#roomStatus').textContent = update.message;
    } else if (update.type === 'ended') {
        twin.running = false;
        $('#healthTwin').className = 'healthItem';
        $('#healthTwin').textContent = update.reason === 'played' ? `The whole log has been played: ${twin.cycles.length} moves` : `Stopped after ${twin.cycles.length} moves`;
        if (update.recordedTo) $('#roomStatus').textContent = `What the source sent is recorded in ${update.recordedTo}.`;
    } else if (update.type === 'error') {
        twin.running = false;
        $('#healthTwin').className = 'healthItem bad';
        $('#healthTwin').textContent = `Stopped: ${update.message}`;
    }
});

$('#roomStop').addEventListener('click', async () => {
    await api.liveTwin.stop();
});
$('#roomSetup').addEventListener('click', async () => {
    if (state.twin?.running && !window.confirm('Go back to the setup? The twin stops.')) return;
    await api.liveTwin.stop();
    state.twin = null;
    closeRoom();
});

// ---- The window's context ------------------------------------------------------------------------------------------------------
api.onContext(async (context) => {
    state.context = context;
    state.memory = await api.memory.get().catch(() => ({}));
    renderModel();
    // A model opened again (a demonstration's, or the project changed) with readings already chosen: they are matched again.
    if (state.signals.length && !state.twin) {
        offerSignals(state.signals);
        if (state.log) sourceStatus(`${state.log.header.signals.length} signals in ${state.log.fileName}, matched to ${context.projectName || 'the model'}.`, 'good');
        return;
    }
    // A setup kept with the project: its source is chosen again, and its mapping comes back when the source's signals are found.
    const saved = context.setup;
    if (saved?.source) {
        chooseSourceTile(saved.source.kind);
        if (saved.source.kind === 'mqtt') $('#mqttUrl').value = saved.source.url;
        if (saved.source.kind === 'opcua') {
            $('#opcuaUrl').value = saved.source.url;
            $('#opcuaSecurity').value = saved.source.security;
        }
        sourceStatus(saved.source.kind === 'file' ? `Last time this twin read ${saved.source.fileName}: choose it again, and its mapping comes back.` : 'Set up before: find the signals again, and the mapping comes back.');
    }
});
