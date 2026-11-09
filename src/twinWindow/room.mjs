/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The control room (docs/proposals/controlRoom.md, "The control room"): the health of the twin and its source along the top; a tile
// for every measured signal, arranged, widened, pinned and hidden as a person likes and kept with the project; under them the inputs
// as they were received, what the twin infers of what no sensor measures, and the events. Time can be scrubbed back through the moves
// the twin has made. "Try something" opens a sandbox from now, which never changes the twin, and keeps what was tried as a draft
// scenario. A change to the model in the project window is offered to the engineer to apply.

import { $, $$, clock, cleanError, dataTime, describeChange, element, plotLayout, plural, readable, sameTwinModel, shown, sparkline, trendOf, valueAt } from './common.mjs';
import { engineerCycle, engineerOpened, showEngineer, engineerOn } from './engineer.mjs';
import { liveRange } from '../inputBindings.mjs';
import { createHumanInput } from '../renderer/humanInput.mjs';
import { createSteering } from '../renderer/inputSteering.mjs';

const keptCycles = 1000;
// A jump or a tolerance to two figures: a difference read at a glance.
const brief = (value) => (Number.isFinite(value) ? Number(value.toPrecision(2)).toString() : '—');
let host = null;
let twin = null;
// The controls a person steers the sandbox with (docs/proposals/humanInputBinding.md): this window reads its own devices, since a
// gamepad is read only by the window in front; the bindings are the ones the project window uses, matched by symbol.
let steering = null;
let sandboxTargets = [];

export const currentTwin = () => twin;

// host: { api, state (the window's), candidates(), projectName(), saveLayout(layout), saveRecord(record), backToSetup(), replayRecording(path),
//         askProject(action, payload), reportStatus(status) }
export function initRoom(given) {
    host = given;
    $('#roomStop').addEventListener('click', () => host.api.liveTwin.stop());
    $('#roomSetup').addEventListener('click', async () => {
        if (twin?.running && !window.confirm('Go back to the setup? The twin stops.')) return;
        await closeSandbox();
        await host.api.liveTwin.stop();
        twin = null;
        reportStatus();
        host.backToSetup();
    });
    $('#timeScrub').addEventListener('input', () => {
        if (!twin) return;
        const index = Number($('#timeScrub').value);
        twin.view = index >= twin.cycles.length - 1 ? null : index;
        renderView();
    });
    $('#timeFollow').addEventListener('click', () => {
        if (!twin) return;
        twin.view = null;
        renderView();
    });
    $('#hiddenTiles').addEventListener('click', () => {
        if (!twin) return;
        twin.layout.hidden = [];
        buildTiles();
        saveLayout();
        renderView();
    });
    $('#engineerToggle').addEventListener('click', () => {
        const on = $('#engineerToggle').getAttribute('aria-pressed') !== 'true';
        $('#engineerToggle').setAttribute('aria-pressed', String(on));
        showEngineer(on);
        refreshBanner();
        // The tiles take the room that is left.
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    });
    $('#modelApply').addEventListener('click', () => applyModelChange());
    $('#modelDismiss').addEventListener('click', () => {
        if (!twin?.pending) return;
        twin.dismissed = twin.pending;
        $('#modelBanner').hidden = true;
    });
    $('#trySomething').addEventListener('click', () => openSandbox());
    $('#sandboxFollow').addEventListener('click', () => (twin?.sandbox?.following ? stopFollowing() : followControls()));
    $('#sandboxPace').addEventListener('change', () => {
        // A new pace counts from now, so the sandbox does not leap to catch up with it.
        const following = twin?.sandbox?.following;
        if (following) Object.assign(following, { startedWall: performance.now(), startedModel: twin.sandbox.startedAt + twin.sandbox.ranFor });
    });
    const humanInput = createHumanInput();
    steering = createSteering({
        humanInput, store: host.api.inputBindings, modelName: () => host.projectName?.() ?? '',
        status: (text) => { $('#sandboxStatus').className = 'status'; $('#sandboxStatus').textContent = text; }
    });
    steering.onChanged(() => refreshFollowOffer());
    steering.load();
    window.__debugSteering = { steering, devices: humanInput.simulated };
    $('#sandboxRun').addEventListener('click', () => runSandbox());
    $('#sandboxBack').addEventListener('click', () => closeSandbox());
    $('#scenariosToggle').addEventListener('click', () => { $('#scenarioList').hidden = !$('#scenarioList').hidden; });
    // A status chip shortened to fit says all of itself when pointed at, unless it already has a tooltip of its own saying more.
    const chipTitles = new MutationObserver((changes) => {
        for (const change of changes) {
            const chip = change.target.nodeType === Node.ELEMENT_NODE ? change.target : change.target.parentElement;
            if (!chip?.classList.contains('healthItem') || (chip.title && chip.title !== chip.dataset.textTitle)) continue;
            chip.title = chip.textContent;
            chip.dataset.textTitle = chip.textContent;
        }
    });
    for (const chip of $$('#health .healthItem')) chipTitles.observe(chip, { childList: true, characterData: true, subtree: true });
    $('#timeSpan').addEventListener('change', () => {
        if (!twin) return;
        const value = $('#timeSpan').value;
        if (value === 'recent') delete twin.layout.span;
        else twin.layout.span = value === 'all' ? 'all' : Number(value);
        saveLayout();
        renderView();
    });
    $('#temperatureUnit').addEventListener('click', () => {
        if (!twin) return;
        twin.layout.temperature = twin.layout.temperature === 'K' ? 'C' : 'K';
        refreshTemperatureButton();
        saveLayout();
        renderView();
    });
}

// run: { settings, source, sourceLabel, logFileName, nameOf(signal) → the setup's name for it, layout, document }
export function openRoom(run) {
    $('#setup').hidden = true;
    $('#room').hidden = false;
    const { settings } = run;
    const candidates = host.candidates();
    const state = (stateId) => candidates.find((candidate) => candidate.kind === 'state' && candidate.id === stateId);
    const parameter = (parameterId) => candidates.find((candidate) => candidate.kind === 'parameter' && candidate.id === parameterId);
    twin = {
        run, settings, running: true, cycles: [], firstIndex: 0, events: [], startedAt: new Date(), drift: 'good', drifts: {}, stats: { skipped: 0, recoveries: 0 }, view: null,
        layout: { order: [], wide: [], pinned: [], hidden: [], ...structuredClone(run.layout ?? {}) },
        tiles: settings.mapping.filter((entry) => entry.role === 'output').map((entry) => ({
            signal: entry.signal, name: run.nameOf(entry.signal), target: state(entry.stateId), measured: new Map(), tolerance: settings.tolerances[entry.signal],
            estimated: Boolean(settings.corrections?.[entry.signal]?.estimate)
        })),
        inputs: settings.mapping.filter((entry) => entry.role === 'input').map((entry) => ({ signal: entry.signal, target: parameter(entry.parameterId), readings: new Map() })),
        inferred: new Map(),    // stateId → { target, history: Map(time → value), spreads: Map(time → spread) }
        tracked: new Map(),     // parameterId → { name, unit, history: Map(time → value), spreads }
        // The model the twin runs, as the project last had it when the twin took it; a change to it from the project window is offered.
        baseline: settings.document, pending: null, dismissed: null,
        sandbox: null, scenarios: []
    };
    buildTiles();
    refreshTemperatureButton();
    // A span kept with the project that this menu does not offer (written by hand, say) is still used; the menu then shows Recent.
    $('#timeSpan').value = String(twin.layout.span ?? 'recent');
    if (!$('#timeSpan').value) $('#timeSpan').value = 'recent';
    $('#healthTwin').className = 'healthItem';
    $('#healthTwin').textContent = 'Starting the twin…';
    $('#healthSource').className = 'healthItem';
    $('#healthSource').textContent = run.sourceLabel;
    $('#healthDrift').textContent = '';
    $('#roomStatus').textContent = '';
    $('#modelBanner').hidden = true;
    $('#sandboxBar').hidden = true;
    $('#timeScrub').max = '0';
    $('#timeScrub').value = '0';
    renderInputs();
    $('#inferredRows').replaceChildren(element('p', { className: 'empty', textContent: 'Waiting for the twin\'s first move.' }));
    $('#eventsList').replaceChildren();
    // Started again by the engineer: what happened before stays in the list, and the restart is said.
    for (const event of [...(run.carried?.events ?? [])].reverse()) showEvent(event);
    if (run.carried?.said) addEvent('info', ...run.carried.said);
    addEvent('info', 'The twin started', run.sourceLabel);
    engineerOpened(twin);
    refreshScenarios();
    reportStatus();
}

export function closeRoom() {
    $('#room').hidden = true;
    $('#setup').hidden = false;
}

// The twin couldn't start: the room is left, and its record kept.
export function abandonRoom() {
    twin = null;
    closeRoom();
}

function reportStatus() {
    host.reportStatus({ running: Boolean(twin?.running), moves: twin?.cycles.length ?? 0, alarm: twin?.drift === 'bad' });
}

// ---- How quantities are shown --------------------------------------------------------------------------------------------------
// The model keeps temperatures in kelvin; a room is read in degrees Celsius unless it is set to kelvin (the °C / K button, kept with
// the layout). at() converts a value, by() a difference (a jump, a tolerance, a spread), which a change of zero leaves alone.
function displayOf(unit) {
    if (unit === 'K' && twin?.layout.temperature !== 'K') return { unit: '°C', at: (value) => value - 273.15, by: (value) => value };
    return { unit: unit ?? '', at: (value) => value, by: (value) => value };
}

function refreshTemperatureButton() {
    const kelvin = twin.layout.temperature === 'K';
    const any = twin.tiles.some((tile) => tile.target?.unit === 'K') || [...twin.inferred.values()].some((entry) => entry.target?.unit === 'K');
    $('#temperatureUnit').hidden = !any;
    $('#temperatureUnit').textContent = kelvin ? 'K' : '°C';
    $('#temperatureUnit').title = kelvin ? 'Temperatures are shown in kelvin, as the model keeps them: show them in °C' : 'Temperatures are shown in °C: show them in kelvin, as the model keeps them';
}

// ---- Tiles, and how they are laid out ------------------------------------------------------------------------------------------
function orderedTiles() {
    const { order, pinned } = twin.layout;
    const rank = (tile) => (order.includes(tile.name) ? order.indexOf(tile.name) : order.length + twin.tiles.indexOf(tile));
    return [...twin.tiles].sort((a, b) => (pinned.includes(b.name) - pinned.includes(a.name)) || rank(a) - rank(b));
}

function saveLayout() {
    twin.layout.order = orderedTiles().map((tile) => tile.name);
    host.saveLayout(structuredClone(twin.layout));
}

function buildTiles() {
    closeTileMenu();
    const { wide, pinned, hidden } = twin.layout;
    const shownTiles = orderedTiles().filter((tile) => !hidden.includes(tile.name));
    $('#tiles').replaceChildren(...shownTiles.map((tile) => {
        const label = tile.target?.label ?? tile.signal;
        const section = element('section', { className: `tile${wide.includes(tile.name) ? ' wide' : ''}${pinned.includes(tile.name) ? ' pinned' : ''}`, draggable: true });
        section.dataset.signal = tile.signal;
        const toggle = (list) => () => {
            twin.layout[list] = twin.layout[list].includes(tile.name) ? twin.layout[list].filter((name) => name !== tile.name) : [...twin.layout[list], tile.name];
            buildTiles();
            saveLayout();
            renderView();
        };
        const isPinned = pinned.includes(tile.name);
        const pinMark = isPinned ? element('span', { className: 'pinMark', title: 'Pinned to the front', innerHTML: icon(pinIcon) }) : null;
        const menuButton = element('button', { type: 'button', className: 'tileMenuButton', title: `Options for ${label}`, innerHTML: icon(moreIcon) });
        menuButton.setAttribute('aria-label', `Options for ${label}`);
        menuButton.setAttribute('aria-haspopup', 'menu');
        menuButton.setAttribute('aria-expanded', 'false');
        menuButton.addEventListener('click', (event) => {
            event.stopPropagation();
            openTileMenu(menuButton, [
                { label: 'Pin to the front', checked: isPinned, run: toggle('pinned') },
                { label: 'Draw twice as wide', checked: wide.includes(tile.name), run: toggle('wide') },
                null,
                { label: 'Hide this tile', danger: true, run: toggle('hidden') }
            ]);
        });
        const header = element('header', {},
            element('div', {}, element('span', { className: 'grip', textContent: '⋮⋮', title: 'Drag to move' }), pinMark, pinMark ? ' ' : null, element('strong', { textContent: label }), ' ', element('small', { textContent: tile.name })),
            element('span', { className: 'tileEnd' }, element('span', { className: 'value', textContent: '—' }), menuButton));
        section.append(header, element('div', { className: 'plot' }), element('div', { className: 'facts' }));
        // Dragged onto another tile, it takes that tile's place.
        section.addEventListener('dragstart', (event) => {
            event.dataTransfer.setData('text/plain', tile.name);
            event.dataTransfer.effectAllowed = 'move';
            section.classList.add('dragging');
        });
        section.addEventListener('dragend', () => section.classList.remove('dragging'));
        section.addEventListener('dragover', (event) => { event.preventDefault(); section.classList.add('dropTarget'); });
        section.addEventListener('dragleave', () => section.classList.remove('dropTarget'));
        section.addEventListener('drop', (event) => {
            event.preventDefault();
            section.classList.remove('dropTarget');
            moveTile(event.dataTransfer.getData('text/plain'), tile.name);
        });
        tile.element = section;
        return section;
    }));
    for (const tile of twin.tiles) if (hidden.includes(tile.name)) tile.element = null;
    $('#hiddenTiles').hidden = hidden.length === 0;
    $('#hiddenTiles').textContent = `Show ${plural(hidden.length, 'hidden tile')}`;
}

// The icons the room draws (24-unit paths, filled with the text colour).
const pinIcon = 'M16 3l5 5-2 1-3 3 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 3-3z';
const moreIcon = 'M5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z';
const checkIcon = 'M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z';
const icon = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;

// A tile's options, as a menu under its button: items { label, checked, danger, run }, null for a divider. One menu is open at a time;
// it closes on a choice, Escape, a click elsewhere, or the window changing size, and gives the focus back to its button.
let openMenu = null;
function closeTileMenu({ refocus = false } = {}) {
    if (!openMenu) return;
    const { menu, button, cleanup } = openMenu;
    openMenu = null;
    cleanup();
    menu.remove();
    button.setAttribute('aria-expanded', 'false');
    if (refocus && button.isConnected) button.focus();
}

function openTileMenu(button, items) {
    const reopening = openMenu?.button === button;
    closeTileMenu();
    if (reopening) return;
    const menu = element('div', { className: 'tileMenu' });
    menu.setAttribute('role', 'menu');
    for (const item of items) {
        if (!item) { menu.append(element('hr')); continue; }
        const choice = element('button', { type: 'button', className: item.danger ? 'danger' : '', innerHTML: `${item.checked ? icon(checkIcon) : '<span></span>'}<span></span>` });
        choice.lastChild.textContent = item.label;
        choice.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
        if (item.checked !== undefined) choice.setAttribute('aria-checked', String(item.checked));
        choice.addEventListener('click', () => { closeTileMenu(); item.run(); });
        menu.append(choice);
    }
    document.body.append(menu);
    const place = button.getBoundingClientRect();
    menu.style.top = `${Math.min(place.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
    menu.style.left = `${Math.max(8, place.right - menu.offsetWidth)}px`;
    const choices = [...menu.querySelectorAll('button')];
    const onKey = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeTileMenu({ refocus: true }); return; }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const at = choices.indexOf(document.activeElement);
        choices[(at + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length].focus();
    };
    const onPointer = (event) => { if (!menu.contains(event.target) && event.target !== button) closeTileMenu(); };
    const onResize = () => closeTileMenu();
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', onResize);
    openMenu = { menu, button, cleanup: () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer, true); window.removeEventListener('resize', onResize); } };
    button.setAttribute('aria-expanded', 'true');
    choices[0]?.focus();
}

// Moves a tile to where another is: before it, or after it when coming from in front.
export function moveTile(name, ontoName) {
    if (!twin || name === ontoName) return;
    const names = orderedTiles().map((tile) => tile.name);
    const from = names.indexOf(name);
    const to = names.indexOf(ontoName);
    if (from < 0 || to < 0) return;
    names.splice(from, 1);
    names.splice(to, 0, name);
    twin.layout.order = names;
    buildTiles();
    saveLayout();
    renderView();
}

// What the plots show of time at a move: from `start` to `end` in seconds of data, with the unit their axis is read in. The span is the
// room's choice (the Show menu): four times the twin's window by default, so the plots keep what a person is watching at a readable
// scale however long the twin has run; a fixed span; or everything since the first reading. It always runs on to the forecast's end.
function visibleTime(cycle) {
    const firstOf = (map) => map.keys().next().value;
    const firsts = [...twin.tiles.map((tile) => firstOf(tile.measured)), ...twin.inputs.map((input) => firstOf(input.readings))].filter(Number.isFinite);
    const first = firsts.length ? Math.min(...firsts) : cycle.anchor;
    const ends = [
        ...twin.tiles.map((tile) => cycle.forecast?.[tile.signal]?.at(-1)?.time),
        ...Object.values(twin.sandbox?.series ?? {}).map((series) => series.at(-1)?.time)
    ].filter(Number.isFinite);
    const end = Math.max(cycle.now, ...ends);
    const span = twin.layout.span ?? 'recent';
    const length = span === 'all' ? Infinity : span === 'recent' ? 4 * (cycle.now - cycle.anchor) : span;
    const start = length > 0 && Number.isFinite(length) ? Math.max(first, cycle.now - length) : first;
    const shown = Math.max(end - start, 1);
    const unit = shown < 180 ? { divisor: 1, title: 'seconds' } : shown < 3 * 3600 ? { divisor: 60, title: 'minutes' }
        : shown < 3 * 86400 ? { divisor: 3600, title: 'hours' } : { divisor: 86400, title: 'days' };
    return { start, end, ...unit };
}

function drawTile(tile, cycle, past, time = visibleTime(cycle)) {
    if (!tile.element) return;
    const rows = cycle.window[tile.signal] ?? [];
    const shownAs = displayOf(tile.target?.unit);
    const measured = [...tile.measured].filter(([at]) => at <= cycle.now + 1e-9).sort((a, b) => a[0] - b[0]).map(([at, value]) => [at, shownAs.at(value)]);
    const latest = measured.at(-1)?.[1];
    const unit = shownAs.unit ? ` ${shownAs.unit}` : '';
    $('.value', tile.element).textContent = `${shown(latest)}${unit}`;
    const jump = cycle.jumps?.[tile.signal]?.jump;
    const trend = trendOfSignal(cycle, tile.signal);
    const leaning = Boolean(trend) && trend.direction !== 'none';
    const alarm = Boolean(trend?.alarm);
    tile.element.className = tile.element.className.replace(/ ?\b(good|lean|bad)\b/g, '') + ` ${alarm ? 'bad' : leaning || (Number.isFinite(jump) && Math.abs(jump) > tile.tolerance) ? 'lean' : 'good'}`;
    const facts = $('.facts', tile.element);
    facts.replaceChildren();
    const upTo = twin.cycles.filter((item) => item.index <= cycle.index);
    const jumps = upTo.map((item) => item.jumps?.[tile.signal]?.jump).filter(Number.isFinite).slice(-60);
    facts.append(
        element('span', { className: 'jumps' }, `jumps`, sparkline(jumps, '#e0a14c'), `last ${Number.isFinite(jump) ? `${brief(shownAs.by(jump))}${unit}` : '—'}`),
        element('span', { textContent: `tolerance ±${brief(shownAs.by(tile.tolerance))}${unit}` }));
    if (alarm) facts.append(element('span', { textContent: 'drifting past the warning' }));
    else if (leaning) facts.append(element('span', { textContent: `leaning ${trend.direction} the readings` }));
    // An estimated signal: how many readings fell outside the band the twin expected, where about one in five is honest.
    if (tile.estimated) {
        const outside = upTo.reduce((sum, item) => sum + (item.estimate?.outside?.[tile.signal]?.outside ?? 0), 0);
        const total = upTo.reduce((sum, item) => sum + (item.estimate?.outside?.[tile.signal]?.total ?? 0), 0);
        if (total) facts.append(element('span', { textContent: `${Math.round((outside / total) * 100)}% of readings outside the band (about 20% is honest)`, title: `${outside} of ${total} readings fell outside the twin's 10th to 90th percentile` }));
    }
    if (!globalThis.Plotly) return;
    // Only what is in the span is drawn (a little before it too, so a line enters from the edge): the plot stays readable, and quick.
    const from = time.start - (time.end - time.start) * 0.02;
    const inSpan = (points) => points.filter((point) => point.time >= from);
    const hours = (points) => points.map((point) => point.time / time.divisor);
    const window = inSpan(rows.map((row) => ({ time: row.time, value: shownAs.at(row.simulated) })));
    const forecast = (cycle.forecast?.[tile.signal] ?? []).map((point) => ({ time: point.time, value: shownAs.at(point.value) }));
    const shownMeasured = measured.filter(([at]) => at >= from);
    const band = cycle.estimate?.band?.[tile.signal] ? inSpan(cycle.estimate.band[tile.signal]) : null;
    const sandbox = !past ? (twin.sandbox?.series?.[tile.signal] ?? null)?.map((point) => ({ time: point.time, value: shownAs.at(point.value) })) ?? null : null;
    const traces = [
        ...(band ? [
            { type: 'scatter', mode: 'lines', name: 'Band', x: hours(band), y: band.map((point) => shownAs.at(point.high)), line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
            { type: 'scatter', mode: 'lines', name: 'Band (10–90%)', x: hours(band), y: band.map((point) => shownAs.at(point.low)), line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(75,143,226,.18)', hoverinfo: 'skip' }
        ] : []),
        { type: 'scatter', mode: 'markers', name: 'Measured', x: shownMeasured.map(([at]) => at / time.divisor), y: shownMeasured.map(([, value]) => value), marker: { size: 3, color: '#e0894c' } },
        { type: 'scatter', mode: 'lines', name: 'Model', x: hours(window), y: window.map((point) => point.value), line: { width: 2, color: '#4b8fe2' } },
        { type: 'scatter', mode: 'lines', name: 'Forecast', x: hours(forecast), y: forecast.map((point) => point.value), line: { width: 2, dash: 'dash', color: '#4b8fe2' } },
        ...(sandbox ? [{ type: 'scatter', mode: 'lines', name: 'Tried', x: hours(sandbox), y: sandbox.map((point) => point.value), line: { width: 2, dash: 'dot', color: '#9b8cf0' } }] : [])
    ];
    globalThis.Plotly.react($('.plot', tile.element), traces, plotLayout({
        margin: { l: 52, r: 10, t: 22, b: 28 },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 10 }, bgcolor: 'rgba(0,0,0,0)' },
        xaxis: { gridcolor: '#17252f', zeroline: false, title: { text: time.title, standoff: 2 }, range: [time.start / time.divisor, time.end / time.divisor] },
        yaxis: { gridcolor: '#17252f', zeroline: false, title: { text: shownAs.unit, standoff: 4 } },
        shapes: [{ type: 'rect', xref: 'x', yref: 'paper', x0: Math.max(cycle.anchor, time.start) / time.divisor, x1: cycle.now / time.divisor, y0: 0, y1: 1, fillcolor: 'rgba(57,135,229,.10)', line: { width: 0 }, layer: 'below' }]
    }), { displayModeBar: false, responsive: true });
}

// ---- Inputs and what the twin infers ---------------------------------------------------------------------------------------------
function renderInputs() {
    if (!twin.inputs.length) {
        $('#inputRows').replaceChildren(element('p', { className: 'empty', textContent: 'No input is mapped: the model runs on its own parameter values.' }));
        return;
    }
    $('#inputRows').replaceChildren(...twin.inputs.map((input) => {
        const row = element('div', { className: 'inputRow' },
            element('div', {}, element('strong', { textContent: input.target?.label.replace(/^Shared · /, '') ?? input.signal }), element('small', { className: 'latest', textContent: '—' })),
            element('div', { className: 'plot' }));
        row.dataset.signal = input.signal;
        input.element = row;
        return row;
    }));
}

function drawInputs(cycle, time = visibleTime(cycle)) {
    for (const input of twin.inputs) {
        const shownAs = displayOf(input.target?.unit);
        const readings = [...input.readings].filter(([time]) => time <= cycle.now + 1e-9).sort((a, b) => a[0] - b[0]).map(([time, value]) => [time, shownAs.at(value)]);
        const unit = shownAs.unit ? ` ${shownAs.unit}` : '';
        $('.latest', input.element).textContent = readings.length ? `${shown(readings.at(-1)[1])}${unit}` : 'nothing received yet';
        if (!globalThis.Plotly || !readings.length) continue;
        // Within the span, the value held from before it starting at its edge, and the last value held up to now, so a step is drawn
        // to the present.
        const before = readings.filter(([at]) => at < time.start).at(-1);
        const within = [...(before ? [[time.start, before[1]]] : []), ...readings.filter(([at]) => at >= time.start)];
        const x = [...within.map(([at]) => at / time.divisor), cycle.now / time.divisor];
        const y = [...within.map(([, value]) => value), within.at(-1)[1]];
        const low = Math.min(...y);
        const high = Math.max(...y);
        const pad = (high - low || Math.abs(high) || 1) * 0.15;
        globalThis.Plotly.react($('.plot', input.element), [{ type: 'scatter', mode: 'lines', x, y, line: { shape: 'hv', width: 1.5, color: '#9b8cf0' } }],
            plotLayout({
                margin: { l: 46, r: 6, t: 8, b: 8 }, font: { color: '#9fb2bb', size: 10 }, xaxis: { gridcolor: '#17252f', zeroline: false, showticklabels: false, range: [time.start / time.divisor, cycle.now / time.divisor] },
                yaxis: { gridcolor: '#17252f', zeroline: false, range: [low - pad, high + pad], tickvals: low === high ? [low] : [low, high], ticktext: (low === high ? [low] : [low, high]).map((value) => shown(value)) }
            }), { displayModeBar: false, responsive: true, staticPlot: true });
    }
}

function parameterInfo(parameterId) {
    const found = [
        ...(twin.settings.document.sharedParameters ?? []),
        ...(twin.settings.document.edges ?? []).flatMap((edge) => edge.parameters ?? []),
        ...(twin.settings.document.nodes ?? []).flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => term.parameters ?? []))
    ].find((candidate) => candidate.id === parameterId);
    return { name: found?.name ?? `Parameter ${parameterId}`, unit: found?.unit ?? '' };
}

function collectInferred(cycle) {
    const candidates = host.candidates();
    for (const [key, series] of Object.entries(cycle.inferred ?? {})) {
        const stateId = Number(key);
        if (!twin.inferred.has(stateId)) twin.inferred.set(stateId, { history: new Map(), spreads: new Map() });
        const entry = twin.inferred.get(stateId);
        entry.target = candidates.find((candidate) => candidate.kind === 'state' && candidate.id === stateId) ?? entry.target;
        entry.lastSeen = cycle.index;
        for (const point of series) if (point.time <= cycle.now + 1e-9) entry.history.set(point.time, point.value);
        entry.history.set(cycle.now, valueAt(series, cycle.now));
        const spread = cycle.estimate?.states?.find((candidate) => candidate.stateId === stateId)?.spread;
        if (Number.isFinite(spread)) entry.spreads.set(cycle.now, spread);
    }
    for (const parameter of cycle.estimate?.parameters ?? []) {
        if (!twin.tracked.has(parameter.parameterId)) twin.tracked.set(parameter.parameterId, { ...parameterInfo(parameter.parameterId), history: new Map(), spreads: new Map() });
        const entry = twin.tracked.get(parameter.parameterId);
        entry.history.set(cycle.anchor, parameter.mean);
        entry.spreads.set(cycle.anchor, parameter.spread);
        entry.lastSeen = cycle.index;
    }
}

function drawInferred(cycle) {
    const upTo = (map) => [...map].filter(([time]) => time <= cycle.now + 1e-9).sort((a, b) => a[0] - b[0]);
    const row = ({ name, kind, unit, history, spreads }) => {
        const shownAs = displayOf(unit);
        const raw = upTo(history);
        const points = raw.map(([time, value]) => [time, shownAs.at(value)]);
        if (!points.length) return null;
        const latest = points.at(-1)[1];
        const spread = upTo(spreads).at(-1)?.[1];
        // Judged in the model's own units, since half a percent of a temperature in °C is not half a percent of it in kelvin.
        const trend = trendOf(raw);
        const units = shownAs.unit ? ` ${shownAs.unit}` : '';
        const number = element('div', { className: 'number', textContent: `${readable(latest)}${units}` });
        if (Number.isFinite(spread) && spread > 0) number.append(element('small', { textContent: ` ±${brief(spread)}` }));
        const made = element('div', { className: 'inferredRow' },
            element('div', {}, element('strong', { textContent: name }), element('small', { textContent: kind })),
            number,
            element('span', { className: `trend ${trend.kind}`, textContent: trend.word, title: Number.isFinite(trend.perHour) ? `${trend.perHour > 0 ? '+' : ''}${shown(trend.perHour)}${units} an hour` : '' }),
            sparkline(points.slice(-120).map(([, value]) => value)));
        made.setAttribute('role', 'row');
        return made;
    };
    const rows = [
        ...[...twin.tracked.values()].map((entry) => row({ ...entry, kind: 'a parameter, tracked' })),
        ...[...twin.inferred.values()].filter((entry) => entry.lastSeen === twin.cycles.at(-1)?.index || cycle !== twin.cycles.at(-1))
            .map((entry) => row({ ...entry, name: entry.target?.label ?? 'A state', kind: entry.spreads.size ? 'estimated' : 'carried by the model', unit: entry.target?.unit ?? '' }))
    ].filter(Boolean);
    $('#inferredRows').replaceChildren(...(rows.length ? rows : [element('p', { className: 'empty', textContent: 'Every state is measured: there is nothing left to infer.' })]));
}

// ---- Time: following now, or a move scrubbed back to ------------------------------------------------------------------------------
function renderView() {
    if (!twin?.cycles.length) return;
    const following = twin.view === null;
    const cycle = following ? twin.cycles.at(-1) : twin.cycles[twin.view];
    const behind = twin.cycles.length - 1 - twin.cycles.indexOf(cycle);
    $('#timeScrub').max = String(twin.cycles.length - 1);
    $('#timeScrub').value = String(following ? twin.cycles.length - 1 : twin.view);
    $('#timeLabel').textContent = following ? `Following now · ${Number((cycle.now / 3600).toFixed(2))} h` : `${dataTime(cycle.now)} · ${plural(behind, 'move')} ago`;
    $('#timeFollow').hidden = following;
    $('#tiles').classList.toggle('past', !following);
    const time = visibleTime(cycle);
    for (const tile of twin.tiles) drawTile(tile, cycle, !following, time);
    drawInputs(cycle, time);
    drawInferred(cycle);
}

// ---- Events ----------------------------------------------------------------------------------------------------------------------
// One list, timed, newest first: warnings, the twin falling behind, the engine restarted, what the source says, changes made, the end.
// actions: [{ label, run }] offered on the event, such as replaying a recording.
export function addEvent(kind, text, detail = '', time = null, actions = []) {
    if (!twin) return;
    const event = { at: new Date(), kind, text, detail: [detail, time === null ? '' : dataTime(time)].filter(Boolean).join(' · ') };
    showEvent(event, actions);
}

function showEvent(event, actions = []) {
    twin.events.unshift(event);
    twin.events.length = Math.min(twin.events.length, 500);
    const { kind, text } = event;
    const body = element('div', {}, text);
    if (event.detail) body.append(element('small', { textContent: event.detail }));
    for (const action of actions) {
        const button = element('button', { type: 'button', textContent: action.label });
        button.addEventListener('click', action.run);
        body.append(button);
    }
    const item = element('li', { className: kind }, element('time', { textContent: clock(event.at), dateTime: event.at.toISOString() }), body);
    $('#eventsList').prepend(item);
    while ($('#eventsList').children.length > 500) $('#eventsList').lastElementChild.remove();
}

// The last run's events kept with the project, so the next shift sees what happened.
function keepRecord() {
    if (!twin) return;
    host.saveRecord({ startedAt: twin.startedAt.toISOString(), events: twin.events.map((event) => ({ at: event.at.toISOString(), kind: event.kind, text: event.text, detail: event.detail })) });
}

// A signal's trend on a move: its own, or (from a twin that judged only its first signal) the move's when it is this signal's.
const trendOfSignal = (cycle, signal) => cycle.trends?.[signal] ?? (cycle.trend?.signal === signal ? cycle.trend : null);
const driftOf = (trend) => (trend?.alarm ? 'bad' : trend?.direction && trend.direction !== 'none' ? 'lean' : 'good');

function cycleEvents(cycle, stats) {
    if (twin.cycles.length === 1) addEvent('good', 'The twin is live: its first move is made', '', cycle.now);
    // Each measured signal on its own: a bedroom drifting while the other rooms stay in step is said of the bedroom.
    const estimating = Object.values(cycle.corrections ?? {}).some((correction) => correction?.estimate);
    for (const tile of twin.tiles) {
        const trend = trendOfSignal(cycle, tile.signal);
        if (!trend) continue;
        const drift = driftOf(trend);
        if (drift === (twin.drifts[tile.signal] ?? 'good')) continue;
        twin.drifts[tile.signal] = drift;
        const name = tile.target?.label ?? tile.signal;
        const shownAs = displayOf(tile.target?.unit);
        const unit = shownAs.unit ? ` ${shownAs.unit}` : '';
        const jumps = `the model is put right by ${brief(shownAs.by(Math.abs(trend.mean)))}${unit} a move on average`;
        const advice = estimating ? '' : '. An engineer can refit on the latest window to find what changed, or estimate the signal and track the tunable parameters as it goes';
        if (drift === 'bad') addEvent('bad', `${name} is drifting past the warning`, `${jumps}; the warning is ${brief(shownAs.by(twin.settings.alertAt * (tile.tolerance ?? 0)))}${unit}${advice}`, cycle.now);
        else if (drift === 'lean') addEvent('lean', `${name} is leaning ${trend.direction} the readings`, jumps, cycle.now);
        else addEvent('good', `${name} is back in step with the readings`, '', cycle.now);
    }
    twin.drift = driftOf(cycle.trend);
    if (stats.skipped > twin.stats.skipped) addEvent('lean', `The twin fell behind the data, and skipped ${plural(stats.skipped - twin.stats.skipped, 'move')} to keep up`, 'a longer stride or a shorter window (Engineer, Timing) keeps up', cycle.now);
    if (stats.recoveries > twin.stats.recoveries) addEvent('lean', 'The engine stopped, and was started again from the last move', '', cycle.now);
    twin.stats = { skipped: stats.skipped ?? 0, recoveries: stats.recoveries ?? 0 };
}

export function handleEvent(update) {
    if (!twin) return;
    if (update.type === 'cycle') {
        const { stats, cycle } = update;
        twin.cycles.push(cycle);
        // The oldest moves are let go of, so a twin that runs for days keeps a steady footprint; a view scrubbed back keeps its move.
        if (twin.cycles.length > keptCycles) {
            twin.cycles.shift();
            if (twin.view !== null) twin.view = Math.max(0, twin.view - 1);
        }
        for (const tile of twin.tiles) for (const row of cycle.window[tile.signal] ?? []) tile.measured.set(row.time, row.measured);
        for (const input of twin.inputs) for (const reading of cycle.inputChanges?.[input.signal] ?? []) input.readings.set(reading.time, reading.value);
        collectInferred(cycle);
        // How the twin keeps up with the data, in words: the engine's own speed beside the speed the data arrives at reads as a
        // contradiction, so the exact figure is kept for the tooltip.
        const arriving = Number.isFinite(twin.run.source.speed) ? twin.run.source.speed : twin.run.source.kind === 'recording' ? Infinity : 1;
        const headroom = Number.isFinite(stats.realTimeFactor) && Number.isFinite(arriving) ? stats.realTimeFactor / arriving : Infinity;
        const pace = headroom >= 10 ? 'keeping up easily' : headroom >= 1.5 ? 'keeping up' : 'only just keeping up';
        const behind = stats.lagSeconds > 2 * twin.settings.stride;
        $('#healthTwin').textContent = `Live · ${plural(stats.cycles, 'move')} · ${behind ? `${Math.round(stats.lagSeconds / 60)} min behind the data` : pace}`;
        $('#healthTwin').title = `The model runs ${Number.isFinite(stats.realTimeFactor) ? Math.round(stats.realTimeFactor).toLocaleString() : 'far more'} times faster than real time${Number.isFinite(arriving) ? `, and the data arrives at ${arriving}×` : ''}; a move takes ${(stats.cycleSeconds.median * 1000).toFixed(1)} ms.`;
        $('#healthTwin').className = `healthItem ${headroom >= 1.5 && !behind ? 'good' : 'lean'}`;
        const alarm = cycle.trend?.alarm;
        $('#healthDrift').className = `healthItem ${alarm ? 'bad' : cycle.trend?.direction !== 'none' ? 'lean' : 'good'}`;
        $('#healthDrift').textContent = alarm ? 'Drifting past the warning' : cycle.trend?.direction !== 'none' ? 'Leaning' : 'In step';
        const worst = twin.tiles.find((tile) => tile.signal === cycle.trend?.signal);
        $('#healthDrift').title = alarm || cycle.trend?.direction !== 'none' ? `${worst?.target?.label ?? cycle.trend?.signal}${twin.tiles.filter((tile) => driftOf(trendOfSignal(cycle, tile.signal)) !== 'good').length > 1 ? ', and others' : ''}` : 'Every measured signal is in step';
        cycleEvents(cycle, stats);
        if (twin.view === null) renderView();
        else {
            $('#timeScrub').max = String(twin.cycles.length - 1);
            $('#timeLabel').textContent = `${dataTime(twin.cycles[twin.view].now)} · ${plural(twin.cycles.length - 1 - twin.view, 'move')} ago`;
        }
        engineerCycle(twin, cycle);
        reportStatus();
    } else if (update.type === 'note') {
        $('#roomStatus').textContent = update.message;
        addEvent('info', update.message);
    } else if (update.type === 'ended') {
        twin.running = false;
        twin.ended = update.reason;
        twin.recordedTo = update.recordedTo ?? null;
        $('#healthTwin').className = 'healthItem';
        $('#healthTwin').textContent = update.reason === 'played' ? `The whole log has been played: ${plural(twin.cycles.length, 'move')}` : `Stopped after ${plural(twin.cycles.length, 'move')}`;
        addEvent('info', update.reason === 'played' ? 'The whole log has been played' : 'The twin was stopped', plural(twin.cycles.length, 'move'), twin.cycles.at(-1)?.now ?? null);
        if (update.recordedTo) {
            const path = update.recordedTo;
            $('#roomStatus').textContent = `What the source sent is recorded in ${path}.`;
            addEvent('info', 'What the source sent is recorded, to replay later', path, null, [
                { label: 'Replay this recording', run: () => host.replayRecording(path) },
                { label: 'Show in folder', run: () => host.api.liveTwin.showRecording(path) }
            ]);
        }
        if (update.recordingLate) addEvent('lean', `${plural(update.recordingLate, 'reading')} came after later ones`, 'they reached the twin, but a log only goes forward, so the recording could not hold them');
        closeSandbox();
        keepRecord();
        engineerCycle(twin, null);
        reportStatus();
    } else if (update.type === 'error') {
        twin.running = false;
        $('#healthTwin').className = 'healthItem bad';
        $('#healthTwin').textContent = `Stopped: ${update.message}`;
        addEvent('bad', 'The twin stopped', update.message);
        keepRecord();
        engineerCycle(twin, null);
        reportStatus();
    }
}

// ---- A change to the model in the project window -------------------------------------------------------------------------------
export function modelChanged(model) {
    if (!twin?.running) return;
    if (sameTwinModel(model, twin.baseline)) {
        twin.baseline = model;
        twin.pending = null;
        refreshBanner();
        return;
    }
    twin.pending = model;
    refreshBanner();
}

// Values the twin and the model now both have (set or refitted here, and kept in the model): the model's next change is expected.
export function baselineTakes(model) {
    if (twin) twin.baseline = model;
}

function refreshBanner() {
    if (!twin?.pending || twin.pending === twin.dismissed) {
        $('#modelBanner').hidden = true;
        return;
    }
    $('#modelBanner').hidden = false;
    const engineer = engineerOn();
    $('#modelBannerText').textContent = `The model has changed in the project window: ${describeChange(twin.baseline, twin.pending)}.${engineer ? ' Applied, the twin starts again from its latest move with it.' : ' An engineer can apply it to the twin (Engineer).'}`;
    $('#modelApply').hidden = !engineer;
}

async function applyModelChange() {
    if (!twin?.pending || !twin.running) return;
    const model = twin.pending;
    const said = describeChange(twin.baseline, model);
    $('#modelApply').disabled = true;
    try {
        const outcome = await host.api.liveTwin.applyModel(model);
        const at = twin.cycles.at(-1);
        twin.baseline = model;
        twin.settings = { ...twin.settings, document: model };
        twin.pending = null;
        addEvent('info', 'The model\'s change was applied to the twin', `${said}; it starts again from the move at ${Number((at.anchor / 3600).toFixed(2))} h${outcome.added.length ? `, ${plural(outcome.added.length, 'new state')} at ${outcome.added.length === 1 ? 'its' : 'their'} initial value${outcome.added.length === 1 ? '' : 's'}` : ''}`, at.now);
        engineerOpened(twin);
    } catch (error) {
        addEvent('bad', 'The model\'s change was not applied', cleanError(error));
        $('#modelBannerText').textContent = `The model's change could not be applied: ${cleanError(error)}`;
        return;
    } finally {
        $('#modelApply').disabled = false;
    }
    refreshBanner();
}

// ---- Trying something: a sandbox from now ----------------------------------------------------------------------------------------
async function openSandbox() {
    if (!twin?.running || twin.sandbox) return;
    if (!twin.cycles.length) {
        $('#roomStatus').textContent = 'Wait for the twin\'s first move, then try something from it.';
        return;
    }
    try {
        const opened = await host.api.liveTwin.detach();
        const cycle = twin.cycles.at(-1);
        twin.sandbox = { startedAt: opened.time, ranFor: 0, tried: [], series: null, cycle };
        twin.view = null;
        const slots = [];
        sandboxTargets = [];
        $('#sandboxInputs').replaceChildren(...twin.inputs.map((input) => {
            const field = element('input', { type: 'number', step: 'any', value: String(cycle.inputs?.[input.signal] ?? '') });
            field.dataset.signal = input.signal;
            const name = input.target?.label.replace(/^Shared · /, '') ?? input.signal;
            field.setAttribute('aria-label', `${name} from now`);
            const label = element('label', { className: 'field inline' }, element('span', { textContent: `${name}${input.target?.unit ? ` (${input.target.unit})` : ''}` }), field);
            if (!input.target?.symbol) return label;
            // A control bound to the input's parameter (by its symbol) moves this field, and while the sandbox follows the controls,
            // the input itself.
            const shared = (twin.settings.document?.sharedParameters ?? []).find((parameter) => parameter.id === input.target.id);
            const range = liveRange(shared ?? { value: Number(field.value) || 0 });
            field.addEventListener('input', () => steering.sliderMoved(input.signal));
            sandboxTargets.push({
                key: input.signal, symbol: input.target.symbol, name, unit: input.target.unit ?? '', range,
                value: () => Number(field.value) || 0,
                show: (value) => { field.value = String(value); },
                apply: (value) => {
                    field.value = String(value);
                    twin?.sandbox?.following?.queue.push({ signal: input.signal, value });
                }
            });
            const slot = element('span', {});
            slots.push([slot, input.signal]);
            return element('span', { className: 'sandboxInput' }, label, slot);
        }));
        steering.setTargets(sandboxTargets);
        for (const [slot, key] of slots) steering.decorate(slot, key);
        refreshFollowOffer();
        if (!twin.inputs.length) $('#sandboxInputs').replaceChildren(element('span', { className: 'hint', textContent: 'No input is mapped: run ahead to see the twin\'s own course.' }));
        $('#sandboxStatus').textContent = `From ${dataTime(opened.time)}.`;
        $('#sandboxBar').hidden = false;
        $('#trySomething').disabled = true;
    } catch (error) {
        $('#roomStatus').textContent = `Could not try something: ${cleanError(error)}`;
    }
}

async function runSandbox() {
    const sandbox = twin?.sandbox;
    if (!sandbox) return;
    $('#sandboxRun').disabled = true;
    try {
        for (const field of $$('#sandboxInputs input')) {
            const value = Number(field.value);
            const before = sandbox.tried.filter((step) => step.signal === field.dataset.signal).at(-1)?.value ?? sandbox.cycle.inputs?.[field.dataset.signal];
            if (field.value.trim() === '' || !Number.isFinite(value) || value === before) continue;
            await host.api.liveTwin.sandboxSetInput(field.dataset.signal, value);
        }
        const seconds = Number($('#sandboxMinutes').value) * 60;
        if (!(seconds > 0)) throw new Error('Run ahead for a positive number of minutes.');
        const result = await host.api.liveTwin.sandboxRunFor(seconds);
        takeSandboxResult(sandbox, result);
        $('#sandboxStatus').className = 'status good';
        $('#sandboxStatus').textContent = `Ran ahead to ${Number((result.time / 3600).toFixed(2))} h${result.tried.length ? ` with ${result.tried.map((step) => `${step.signal} ${step.value}`).join(', ')}` : ' with nothing changed'}.`;
        renderView();
    } catch (error) {
        $('#sandboxStatus').className = 'status warning';
        $('#sandboxStatus').textContent = cleanError(error);
    } finally {
        $('#sandboxRun').disabled = false;
    }
}

function takeSandboxResult(sandbox, result) {
    sandbox.tried = result.tried;
    sandbox.ranFor = result.time - sandbox.startedAt;
    const previous = sandbox.series ?? {};
    sandbox.series = Object.fromEntries(Object.entries(result.series).map(([signal, samples]) => [signal, [...(previous[signal] ?? []), ...samples]]));
}

// Follow the controls is offered once a control drives one of the sandbox's inputs.
function refreshFollowOffer() {
    const offered = Boolean(twin?.sandbox) && sandboxTargets.some((target) => steering.isBound(target.key));
    $('#sandboxFollowControls').hidden = !offered;
    if (!offered && twin?.sandbox?.following) stopFollowing();
}

// Following the controls: the sandbox runs ahead continuously at the pace chosen beside it, each input taking the value its control
// has as it goes (sent by the size of each change, so what was tried is a short list of steps), and the tiles draw its course as it
// grows. It runs on the sandbox's own engine; the live twin is never touched. A slow model falls behind the pace and simply runs as
// fast as it can, rather than leaping ahead to catch up.
async function followControls() {
    const sandbox = twin?.sandbox;
    if (!sandbox || sandbox.following) return;
    const following = { queue: [], startedWall: performance.now(), startedModel: sandbox.startedAt + sandbox.ranFor };
    // What the fields say as it starts goes first: a value typed or moved before.
    for (const field of $$('#sandboxInputs input')) {
        const value = Number(field.value);
        const before = sandbox.tried.filter((step) => step.signal === field.dataset.signal).at(-1)?.value ?? sandbox.cycle.inputs?.[field.dataset.signal];
        if (field.value.trim() !== '' && Number.isFinite(value) && value !== before) following.queue.push({ signal: field.dataset.signal, value });
    }
    sandbox.following = following;
    $('#sandboxFollow').setAttribute('aria-pressed', 'true');
    $('#sandboxFollow').textContent = 'Pause';
    $('#sandboxRun').disabled = true;
    const step = Number(twin.settings.timeStep) > 0 ? Number(twin.settings.timeStep) : 60;
    let drawnAt = 0;
    following.done = (async () => {
        while (twin?.sandbox === sandbox && sandbox.following === following) {
            try {
                const pace = Number($('#sandboxPace').value) || 60;
                const reached = sandbox.startedAt + sandbox.ranFor;
                let wanted = following.startedModel + pace * (performance.now() - following.startedWall) / 1000;
                // More than two seconds behind: carry on from where it is.
                if (wanted - reached > 2 * pace) {
                    Object.assign(following, { startedWall: performance.now(), startedModel: reached });
                    wanted = reached;
                }
                for (const { signal, value } of following.queue.splice(0)) await host.api.liveTwin.sandboxSetInput(signal, value);
                if (wanted - reached >= step) {
                    const result = await host.api.liveTwin.sandboxRunFor(Math.floor((wanted - reached) / step) * step);
                    if (twin?.sandbox !== sandbox) break;
                    takeSandboxResult(sandbox, result);
                    if (performance.now() - drawnAt > 250) {
                        drawnAt = performance.now();
                        $('#sandboxStatus').className = 'status good';
                        $('#sandboxStatus').textContent = `Following the controls: ${Number((result.time / 3600).toFixed(2))} h${result.tried.length ? `, ${result.tried.length} ${result.tried.length === 1 ? 'change' : 'changes'} tried` : ''}.`;
                        renderView();
                    }
                }
            } catch (error) {
                if (twin?.sandbox === sandbox) {
                    $('#sandboxStatus').className = 'status warning';
                    $('#sandboxStatus').textContent = cleanError(error);
                }
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (sandbox.following === following) sandbox.following = null;
        if (twin?.sandbox === sandbox) {
            $('#sandboxFollow').setAttribute('aria-pressed', 'false');
            $('#sandboxFollow').textContent = 'Follow the controls';
            $('#sandboxRun').disabled = false;
            renderView();
        }
    })();
}

// Pause holds the sandbox where it is; Run ahead and Follow the controls carry on from there.
async function stopFollowing() {
    const following = twin?.sandbox?.following;
    if (!following) return;
    twin.sandbox.following = null;
    await following.done;
}

// Back to live: nothing the sandbox did reaches the twin. What was tried is kept as a draft scenario with the project.
export async function closeSandbox() {
    const sandbox = twin?.sandbox;
    if (!sandbox) return;
    await stopFollowing();
    sandboxTargets = [];
    steering.setTargets([]);
    twin.sandbox = null;
    $('#sandboxFollowControls').hidden = true;
    $('#sandboxBar').hidden = true;
    $('#trySomething').disabled = false;
    const closed = await host.api.liveTwin.sandboxClose().catch(() => null);
    const tried = closed?.tried ?? sandbox.tried;
    if (tried.length || sandbox.ranFor > 0) {
        try {
            const kept = await host.askProject('keepScenario', {
                logFileName: twin.run.logFileName ?? '', startedAt: sandbox.startedAt, ranFor: sandbox.ranFor,
                settings: { window: twin.settings.window, stride: twin.settings.stride, horizon: twin.settings.horizon }, tried, document: twin.settings.document
            });
            if (kept?.kept) addEvent('info', `What was tried is kept as a draft scenario, "${kept.name}"`, kept.dropped ? `the oldest, "${kept.dropped}", made room for it` : 'with the project', sandbox.startedAt);
        } catch (error) {
            addEvent('lean', 'What was tried could not be kept', cleanError(error));
        }
        refreshScenarios();
    }
    renderView();
}

// The project's scenarios: renamed or deleted here, as in the project.
async function refreshScenarios() {
    let scenarios = [];
    try {
        scenarios = await host.askProject('scenarios');
    } catch {
        scenarios = [];
    }
    if (!twin) return;
    twin.scenarios = scenarios;
    $('#scenariosToggle').hidden = !scenarios.length;
    $('#scenariosToggle').textContent = `Scenarios (${scenarios.length})`;
    $('#scenarioList').replaceChildren(...scenarios.map((scenario) => {
        const name = element('input', { value: scenario.name });
        name.setAttribute('aria-label', 'Scenario name');
        name.addEventListener('change', () => host.askProject('renameScenario', { id: scenario.id, name: name.value }).then(refreshScenarios));
        const remove = element('button', { type: 'button', textContent: 'Delete', className: 'small' });
        remove.addEventListener('click', () => host.askProject('deleteScenario', { id: scenario.id }).then(refreshScenarios));
        const row = element('div', { className: 'scenarioRow' }, name, remove,
            element('small', { textContent: `From ${dataTime(scenario.startedAt).replace(/^at /, '')}${scenario.logFileName ? ` of ${scenario.logFileName}` : ''}, run ahead ${Math.round(scenario.ranFor / 60)} min${scenario.modelChanged ? '. The model has changed since.' : '.'}` }));
        row.dataset.scenarioId = scenario.id;
        return row;
    }));
    if (!scenarios.length) $('#scenarioList').hidden = true;
}
