/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The twin's own window (docs/proposals/controlRoom.md): the setup (the model, where its readings come from, and how they map to it,
// with suggestions and unit conversions proposed), then the control room: the health of the twin and its source along the top, a
// tile for every measured signal, and under them the inputs as they were received, what the twin infers of what no sensor measures,
// and the events. The setup is handed back to the project window to be kept with the project; matches confirmed
// are remembered across projects.

import { readDataLog } from '../dataLog.mjs';
import { defaultTolerance, suggestedReplayTimeStep } from '../dataLogReplay.mjs';
import { suggestSymbol } from '../csvImport.mjs';
import { describeLoggerCsv, readLoggerCsv } from '../loggerCsv.mjs';
import { readingNoise } from '../stateEstimator.mjs';
import { mappingCandidates, rememberMapping, suggestMapping } from '../signalMatching.mjs';
import { normalizeTwinSetup, twinSessionMapping } from '../twinSetup.mjs';
import { unitConversion } from '../units.mjs';
import { $, $$, cleanError, shown, sparkline } from './common.mjs';
import { abandonRoom, closeRoom, currentTwin, handleEvent, initRoom, modelChanged, openRoom, openTileMenu } from './room.mjs';
import { initEngineer } from './engineer.mjs';

const api = window.twin;
const confident = 0.75;

const state = {
    context: null,      // { document, projectName, projectPath, setup }
    candidates: [],     // the model's quantities a signal can map to
    source: null,       // { kind, ... } chosen in step 2
    signals: [],        // what the source offers: { id (the source's own key), name, unit, values, role }
    rows: [],           // one per signal: { signal, name, role, target, conversion, suggestion }
    log: null,          // a data log chosen or played: { content, header, observations, fileName, path, speed, logger }
    memory: {},
    saved: null         // the setup as the project keeps it: its source, mapping, the twin's settings, the room's layout and record
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
    if (!states.length) summary.replaceChildren(Object.assign(document.createElement('p'), { className: 'status warning modelEmpty', textContent: 'The model has no states, so there is nothing to compare with readings. Add a node with a state in the project window, or try the simulated rig below.' }));
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
    let logger = null;
    try {
        log = readDataLog(content);
    } catch (error) {
        ({ log, logger } = readOtherLogger(content, fileName, cleanError(error)) ?? {});
        if (!log) return;
    }
    state.log = { content, header: log.header, observations: log.observations, fileName, path, speed, demo, logger };
    $('#fileName').textContent = demo ? `${fileName} (a demonstration recording)` : fileName;
    state.source = { kind: 'file', fileName };
    const values = (name) => log.observations.filter((observation) => observation.signal === name && observation.quality !== 'bad').slice(0, 60).map((observation) => observation.value);
    offerSignals(log.header.signals.map((signal) => ({ id: signal.name, name: signal.name, unit: signal.unit, role: signal.role, values: values(signal.name) })));
    sourceStatus(logger
        ? `${fileName} is another logger's table: ${log.header.signals.length} columns of numbers, ${log.observations.length} readings${log.otherLogger}. Say below what each is.`
        : `${log.header.signals.length} signals in ${fileName}, ${log.observations.length} readings${log.header.source ? `, from ${log.header.source}` : ''}.`, 'good');
}

// Another logger's table (src/loggerCsv.mjs): its separator, decimal mark and time column found as they seem to be, and every column
// of numbers offered as a signal (its unit read from a "(unit)" or "[unit]" in its name), the mapping step saying what each is.
function readOtherLogger(content, fileName, why) {
    let described;
    try {
        described = describeLoggerCsv(content);
    } catch (error) {
        sourceStatus(`${fileName} is neither a Konjugate data log (${why}) nor a table Konjugate can read: ${cleanError(error)}`, 'warning');
        return null;
    }
    if (!described.time) {
        sourceStatus(`${fileName} is another logger's table, but no column of dates and times was found in it. Open it in the tuning card's "Replay a data log", which asks how to read it.`, 'warning');
        return null;
    }
    const columns = described.columns.filter((column) => column.numeric && !described.time.columns.includes(column.name));
    const names = twinNames(columns.map((column) => ({ name: column.name.replace(/\s*[([].*$/, '').trim() || column.name })));
    const unitOf = (name) => { const found = /\(([^)]*)\)|\[([^\]]*)\]/.exec(name); return found?.[1] ?? found?.[2] ?? ''; };
    const base = { delimiter: described.delimiter, decimal: described.decimal, time: { columns: described.time.columns, format: described.time.format, zone: Intl.DateTimeFormat().resolvedOptions().timeZone }, source: fileName };
    const signals = columns.map((column, index) => ({ column: column.name, name: names[index], role: 'output', unit: unitOf(column.name) }));
    try {
        const log = readLoggerCsv(content, { ...base, signals });
        const left = described.columns.length - columns.length - described.time.columns.length;
        log.header.signals = log.header.signals.map((signal) => ({ ...signal, role: undefined }));
        log.otherLogger = left > 0 ? `; ${left} column${left === 1 ? '' : 's'} of words left out` : '';
        return { log, logger: { base, columns: Object.fromEntries(signals.map((signal) => [signal.name, signal.column])) } };
    } catch (error) {
        sourceStatus(`${fileName} is another logger's table, but it could not be read as it seems to be: ${cleanError(error)}. Open it in the tuning card's "Replay a data log", which asks how to read it.`, 'warning');
        return null;
    }
}

$('#fileChoose').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async () => {
    const file = $('#fileInput').files[0];
    if (!file) return;
    offerLog(await file.text(), { fileName: file.name, path: api.liveTwin.pathForFile(file), speed: $('#fileSpeed').value });
});
$('#fileSpeed').addEventListener('change', () => { if (state.log) state.log.speed = $('#fileSpeed').value; });

// The demonstrations, one click from nothing to a twin running: the simulated rig's recording, and, with another model open, the rig's
// model opened in the project window first (the project asks about unsaved work, as opening any project does). The rig and the rig
// that drifts go straight into the control room once matched; a plant's names stay on the mapping, which is what they are there to
// show.
// The demonstration's model is open when its first room or tank is among the model's quantities.
const demoMarkers = { house: 'Living room · Air temperature', motor: 'Motor · Speed' };
const demoModelOpen = (variant) => state.candidates.some((candidate) => candidate.label === (demoMarkers[variant] ?? 'Water tank · Water temperature'));

// A demonstration whose readings are matched goes into the control room, unless it is there to show the mapping.
function continueDemo() {
    const variant = state.demoPending;
    if (!variant || !demoModelOpen(variant)) return;
    state.demoPending = null;
    if (variant !== 'plant' && state.rows.some((row) => row.target && row.role === 'output')) startTwin();
}

// The title bar's More menu: the demonstrations, kept out of the setup's way since each replaces the project. While a twin runs it is
// stopped first from the room, so the item says so instead.
$('#moreMenu').addEventListener('click', (event) => {
    event.stopPropagation();
    const running = Boolean(currentTwin()?.running);
    openTileMenu($('#moreMenu'), [
        { label: 'Demonstrations…', disabled: running, title: running ? 'Stop the twin first: a demonstration starts from the setup' : '', run: () => $('#demosDialog').showModal() }
    ]);
});
$('#openDemos').addEventListener('click', () => $('#demosDialog').showModal());

for (const button of $$('[data-demo]')) {
    button.addEventListener('click', async () => {
        if ($('#demosDialog').open) $('#demosDialog').close();
        try {
            const variant = button.dataset.demo;
            const demo = await api.liveTwin.demo(variant);
            chooseSourceTile('file');
            // The pace chosen in the dialog, or the demonstration's own: real time for the motor, fast for the slow systems.
            const pace = $('#demoPace').value;
            const speed = pace === 'own' ? (demo.speed ?? '600') : pace;
            if ([...$('#fileSpeed').options].some((option) => option.value === speed)) $('#fileSpeed').value = speed;
            state.demoPending = variant;
            offerLog(demo.log.content, { fileName: demo.log.fileName, speed, demo: true });
            if (demoModelOpen(variant)) {
                continueDemo();
                return;
            }
            // The demonstration's readings against another model match nothing: its model is opened in the project window, and the
            // readings matched to it when it comes. Should the project decline (unsaved work kept), the button does it again.
            const whose = { house: 'house', motor: 'motor' }[variant] ?? 'rig';
            sourceStatus(`These are the simulated ${whose}'s readings: opening the ${whose}'s model in the project window to compare them with…`, 'warning');
            const open = Object.assign(document.createElement('button'), { type: 'button', textContent: `Open the ${whose}'s model` });
            open.addEventListener('click', () => api.openDemoModel(variant));
            $('#sourceStatus').append(' ', open);
            await api.openDemoModel(variant);
        } catch (error) {
            state.demoPending = null;
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
        offerSignals(answer.tags.filter((tag) => tag.numeric).map((tag) => ({ id: tag.nodeId, name: tag.path, unit: tag.unit, range: tag.range, values: tag.value === null ? [] : [Number(tag.value)] })));
        sourceStatus(`Found ${answer.tags.length} tag${answer.tags.length === 1 ? '' : 's'}.`, 'good');
    } catch (error) {
        sourceStatus(`Could not browse ${url}: ${cleanError(error)}`, 'warning');
    }
}
$('#opcuaBrowse').addEventListener('click', () => browseOpcUa(false));

async function refreshPushState() {
    const service = await api.pushService.state();
    $('#pushState').textContent = service.listening ? `The push service is listening${service.encrypted ? ' on the network, encrypted' : ''}.` : 'The push service is not listening: start it in Settings › Push service (in the project window), and make a key for each script.';
}
$('#pushConnections').addEventListener('click', () => api.openConnections());
$('#pushRefresh').addEventListener('click', async () => {
    const keys = (await api.pushService.keys()).filter((key) => !key.revoked);
    const names = [...new Set(keys.flatMap((key) => key.signals))];
    state.source = { kind: 'push' };
    state.log = null;
    offerSignals(names.map((name) => ({ id: name, name, unit: '', values: [] })));
    sourceStatus(names.length ? `${names.length} signal${names.length === 1 ? '' : 's'} the keys may send.` : 'No key may send anything yet: make one in Settings › Push service.', names.length ? 'good' : 'warning');
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
    const saved = state.saved?.source?.kind === state.source.kind ? state.saved.mapping : [];
    state.rows = signals.map((signal, index) => {
        const suggestion = suggestions[index];
        // A recording this twin made comes back with the mapping it was made with: its signals carry the twin's names.
        const carried = state.carry?.get(signal.id);
        if (carried) return { signal, name: names[index], role: carried.role, target: carried.target, conversion: carried.conversion, suggestion, kept: true };
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
    state.carry = null;
    $('#stepMapping').hidden = false;
    renderRows();
    $('#stepMapping').scrollIntoView({ behavior: 'smooth', block: 'start' });
}


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
            Object.assign(document.createElement('small'), { textContent: `${shown(row.signal.values?.at(-1))}${row.signal.unit ? ` ${row.signal.unit}` : ''}${row.signal.range ? `, ${shown(row.signal.range.low)} to ${shown(row.signal.range.high)}` : ''}${row.signal.role ? ` · declared ${row.signal.role === 'input' ? 'an input' : 'measured'}` : ''}` }),
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
const liveDefaults = { window: 3600, stride: 600, horizon: 3600, corrections: {}, members: 32, untracked: [] };

function currentSetup() {
    return normalizeTwinSetup({
        ...(state.saved ?? {}),
        source: state.source.kind === 'file' ? { kind: 'file', fileName: state.source.fileName } : state.source.kind === 'opcua' ? { kind: 'opcua', url: state.source.url, security: state.source.security } : { ...state.source },
        mapping: state.rows.map((row) => ({
            source: row.signal.id, name: row.name, role: row.target ? row.role : null, target: row.target ? { kind: row.target.kind, id: row.target.id } : null,
            unit: row.signal.unit ?? '', conversion: row.conversion ? { scale: row.conversion.scale, offset: row.conversion.offset } : null
        })),
        live: { ...(state.saved?.live ?? {}), speed: state.log?.speed ?? 'follow' }
    });
}

async function saveSetup(setup) {
    state.saved = setup;
    await api.saveSetup(setup).catch(() => {});
}

// The live twin's source, for the setup: only the signals mapped are followed.
function twinSource() {
    const mapped = state.rows.filter((row) => row.target);
    const signal = (row, key) => ({ [key]: row.signal.id, name: row.name, role: row.role, unit: row.signal.unit ?? '' });
    if (state.source.kind === 'file') {
        // Another logger's table is read with the roles the mapping gave its columns.
        const logger = state.log.logger ? { ...state.log.logger.base, signals: mapped.map((row) => ({ column: state.log.logger.columns[row.signal.id], name: row.signal.id, role: row.role, unit: row.signal.unit ?? '' })) } : undefined;
        if (state.log.speed === 'follow' && state.log.path) return { kind: 'file', path: state.log.path, logger };
        return { kind: 'recording', content: state.log.content, speed: state.log.speed === 'Infinity' ? Infinity : Number(state.log.speed === 'follow' ? 600 : state.log.speed), logger };
    }
    if (state.source.kind === 'mqtt') return { kind: 'mqtt', url: state.source.url, signals: mapped.map((row) => signal(row, 'topic')) };
    if (state.source.kind === 'opcua') return { kind: 'opcua', url: state.source.url, security: state.source.security, trustServer: state.source.trustServer, signals: mapped.map((row) => signal(row, 'nodeId')) };
    return { kind: 'push', url: 'the push service', signals: mapped.map((row) => signal(row, 'signal')) };
}

// What the twin runs with: the setup's mapping and conversions, the tolerances read from the first readings, and the twin's settings
// (the setup's, or the defaults: an hour's window moving every ten minutes, an hour's forecast, a warning at a quarter of the first
// measured signal's tolerance).
function buildRun(setup) {
    const { mapping, conversions } = twinSessionMapping(setup);
    const rows = state.rows.filter((row) => row.target);
    const units = Object.fromEntries(rows.map((row) => [row.name, row.target.unit]));
    for (const [name, conversion] of Object.entries(conversions)) conversion.unit = units[name];
    const tolerances = Object.fromEntries(rows.filter((row) => row.role === 'output').map((row) => {
        const conversion = conversions[row.name];
        const readings = (row.signal.values ?? []).map((value) => ({ value: conversion ? value * conversion.scale + conversion.offset : value }));
        // At least four times the readings' own noise, so a thermometer's scatter is not taken for drift; else a twentieth of the
        // range they moved over.
        const noise = readingNoise(readings.map((reading) => reading.value)) ?? 0;
        return [row.name, readings.length > 1 ? Number(Math.max(defaultTolerance(readings), 4 * noise).toPrecision(2)) : 1];
    }));
    const first = mapping.find((entry) => entry.role === 'output');
    const saved = { ...liveDefaults, ...setup.live };
    const live = {
        ...saved,
        timeStep: saved.timeStep ?? (state.log ? suggestedReplayTimeStep(state.context.document, state.log.observations.map((observation) => ({ ...observation, signal: rows.find((row) => row.signal.id === observation.signal)?.name ?? observation.signal })), mapping) : 60),
        alert: saved.alert ?? 0.25 * tolerances[first.signal]
    };
    const estimating = Object.values(live.corrections).some((correction) => correction.estimate);
    const trackable = estimating ? tunableIds(state.context.document).filter((id) => !live.untracked.includes(id)) : [];
    let settings = {
        document: state.context.document, mapping, window: live.window, stride: live.stride, horizon: live.horizon, timeStep: live.timeStep,
        tolerances, corrections: structuredClone(live.corrections), conversions,
        estimator: { members: live.members, parameters: trackable, drift: Object.fromEntries(Object.entries(live.drift ?? {}).map(([id, value]) => [Number(id), value])) },
        alertAt: live.alert > 0 && tolerances[first.signal] > 0 ? live.alert / tolerances[first.signal] : null
    };
    // A log's readings carry its own names for its signals (another logger's columns, the names they were read under); every other
    // source's readings carry the twin's.
    const idOf = (name) => state.rows.find((row) => row.name === name).signal.id;
    const byId = state.source.kind === 'file';
    if (byId) {
        const rename = (object) => Object.fromEntries(Object.entries(object).map(([name, value]) => [idOf(name), value]));
        settings = { ...settings, mapping: mapping.map((entry) => ({ ...entry, signal: idOf(entry.signal) })), conversions: rename(conversions), tolerances: rename(tolerances), corrections: rename(settings.corrections) };
    }
    const names = Object.fromEntries(rows.map((row) => [byId ? row.signal.id : row.name, row.name]));
    const sourceLabel = state.source.kind === 'file' ? `${state.log.fileName}${state.log.speed === 'follow' ? ', followed as it grows' : `, played at ${state.log.speed === 'Infinity' ? 'full speed' : `${state.log.speed}×`}`}` : state.source.url ?? 'the push service';
    return { settings, source: twinSource(), sourceLabel, logFileName: state.log?.fileName ?? '', nameOf: (signal) => names[signal] ?? signal, layout: setup.layout, live };
}

const tunableIds = (model) => [
    ...(model.sharedParameters ?? []), ...model.edges.flatMap((edge) => edge.parameters ?? []),
    ...model.nodes.flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => term.parameters ?? []))
].filter((parameter) => parameter.tuning && !parameter.sharedParameterId).map((parameter) => parameter.id);

async function startTwin(carried = null) {
    const setup = currentSetup();
    let run;
    try {
        run = { ...buildRun(setup), carried };
    } catch (error) {
        $('#setupStatus').className = 'status warning';
        $('#setupStatus').textContent = `The twin could not start: ${cleanError(error)}`;
        return;
    }
    await saveSetup(setup);
    openRoom(run);
    try {
        await api.liveTwin.start(run.settings, run.source, state.context.projectPath ?? null);
    } catch (error) {
        $('#setupStatus').className = 'status warning';
        $('#setupStatus').textContent = `The twin could not start: ${cleanError(error)}`;
        abandonRoom();
    }
}

$('#openRoom').addEventListener('click', async () => {
    state.memory = rememberMapping(state.memory, state.rows.filter((row) => row.target).map((row) => ({ name: row.signal.name, role: row.role, target: row.target, conversion: row.conversion })), state.context.document);
    await api.memory.save(state.memory).catch(() => {});
    await startTwin();
});

// ---- The control room and the engineer's view ------------------------------------------------------------------------------------
initRoom({
    api,
    candidates: () => state.candidates,
    // The project's name, which a controller binding may be narrowed to (docs/proposals/humanInputBinding.md).
    projectName: () => state.context?.projectName ?? '',
    saveLayout: (layout) => saveSetup(normalizeTwinSetup({ ...state.saved, layout: { ...layout, ...(state.saved?.layout?.bounds ? { bounds: state.saved.layout.bounds } : {}) } })),
    saveRecord: (record) => saveSetup(normalizeTwinSetup({ ...state.saved, record })),
    backToSetup: () => closeRoom(),
    askProject: (action, payload) => api.askProject(action, payload),
    reportStatus: (status) => api.reportStatus?.(status).catch(() => {}),
    // A recording the twin made, offered in the setup as a log to play again.
    replayRecording: async (path) => {
        try {
            const content = await api.liveTwin.readRecording(path);
            await api.liveTwin.stop();
            state.carry = new Map(state.rows.filter((row) => row.target).map((row) => [row.name, row]));
            closeRoom();
            chooseSourceTile('file');
            offerLog(content, { fileName: path.split(/[\\/]/).pop(), path, speed: $('#fileSpeed').value });
        } catch (error) {
            $('#roomStatus').textContent = `The recording could not be opened: ${cleanError(error)}`;
        }
    }
});
initEngineer({
    api,
    states: () => state.candidates.filter((candidate) => candidate.kind === 'state'),
    askProject: (action, payload) => api.askProject(action, payload),
    saveLive: (partial) => saveSetup(normalizeTwinSetup({ ...state.saved, live: { ...(state.saved?.live ?? {}), ...partial } })),
    // The twin started again with the engineer's settings, kept with the setup.
    restartWith: async (live) => {
        const twin = currentTwin();
        const { window, stride, horizon, timeStep, corrections, members, untracked, drift } = live;
        state.saved = normalizeTwinSetup({ ...state.saved, live: { ...(state.saved?.live ?? {}), window, stride, horizon, timeStep, corrections, members, untracked, drift } });
        await api.liveTwin.stop();
        const estimated = Object.entries(corrections).filter(([, correction]) => correction.estimate).map(([name]) => name);
        await startTwin({
            events: twin?.events ?? [],
            said: ['The twin was started again with the engineer\'s settings', `window ${window / 60} min, moving every ${stride / 60} min, forecast ${horizon / 60} min, time step ${timeStep} s${estimated.length ? `; estimating ${estimated.join(', ')}` : ''}`]
        });
    }
});
api.liveTwin.onEvent((update) => handleEvent(update));

// ---- The window's context ------------------------------------------------------------------------------------------------------
api.onContext(async (context) => {
    state.context = context;
    state.saved = normalizeTwinSetup(context.setup) ?? state.saved;
    state.memory = await api.memory.get().catch(() => ({}));
    renderModel();
    if (currentTwin()) return;
    // A log handed over by the tuning card's replay: chosen as the source.
    if (context.log?.content) {
        chooseSourceTile('file');
        offerLog(context.log.content, { fileName: context.log.fileName || 'the log', path: context.log.path ?? null, speed: $('#fileSpeed').value });
        return;
    }
    // A model opened again (a demonstration's, or the project changed) with readings already chosen: they are matched again.
    if (state.signals.length) {
        offerSignals(state.signals);
        if (state.log) sourceStatus(`${state.log.header.signals.length} signals in ${state.log.fileName}, matched to ${context.projectName || 'the model'}.`, 'good');
        continueDemo();
        return;
    }
    // A setup kept with the project: its source is chosen again, and its mapping comes back when the source's signals are found.
    const saved = state.saved;
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

// The project's model changed in the project window: the setup shows it, and a running twin offers it to the engineer.
api.onModelChanged((model) => {
    if (!state.context) return;
    state.context = { ...state.context, document: model };
    renderModel();
    if (currentTwin()?.running) modelChanged(model);
    else if (state.signals.length && $('#room').hidden) {
        offerSignals(state.signals);
        continueDemo();
    }
});

// For the interaction tests: the chosen log's speed set to one the list does not offer, and the running twin's view.
window.__debugTwinWindow = {
    setSpeed: (speed) => { if (state.log) state.log.speed = String(speed); },
    twin: () => currentTwin(),
    // A log handed over as text, as if chosen.
    offerLog: (content, fileName) => {
        chooseSourceTile('file');
        offerLog(content, { fileName, speed: $('#fileSpeed').value });
    },
    summary: () => {
        const twin = currentTwin();
        return twin ? { startedAt: twin.startedAt.toISOString(), running: twin.running, ended: twin.ended ?? null, moves: twin.cycles.length, last: structuredClone(twin.cycles.at(-1) ?? null), sandbox: Boolean(twin.sandbox), recordedTo: twin.recordedTo ?? null } : null;
    }
};
