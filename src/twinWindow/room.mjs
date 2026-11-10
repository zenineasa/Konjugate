/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The control room (docs/proposals/controlRoom.md, "The control room"): the health of the twin and its source along the top; a tile
// for every measured signal, arranged, widened, pinned and hidden as a person likes and kept with the project; under them the inputs
// as they were received, what the twin infers of what no sensor measures, and the events. Time can be scrubbed back through the moves
// the twin has made. "Try something" opens a sandbox from now, which never changes the twin, and keeps what was tried as a draft
// scenario. A change to the model in the project window is offered to the engineer to apply.

import { $, $$, ago, clock, cleanError, dataClock, dataTime, describeChange, element, plotLayout, plural, readable, sameTwinModel, shown, sparkline, stepOf, trendOf, valueAt } from './common.mjs';
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
    $('#trendColumn').addEventListener('pointermove', (event) => showCursor(event));
    $('#trendColumn').addEventListener('pointerleave', () => hideCursor());
    $('#trendScroll').addEventListener('scroll', () => { hideCursor(); markMoreBelow(); });
    // The column scrolls when its strips do not all fit: a fade at its foot says there is more below.
    new ResizeObserver(() => markMoreBelow()).observe($('#trendScroll'));
    new MutationObserver(() => markMoreBelow()).observe($('#trendScroll'), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    $('#engineerToggle').addEventListener('click', () => {
        const on = $('#engineerToggle').getAttribute('aria-pressed') !== 'true';
        $('#engineerToggle').setAttribute('aria-pressed', String(on));
        // The engineer's view takes the events' place in the sidebar while it is on.
        $('#sidebar').classList.toggle('engineering', on);
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
        layout: { order: [], wide: [], tall: [], pinned: [], hidden: [], ...structuredClone(run.layout ?? {}) },
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
    // Run ahead starts at the twin's own forecast horizon, in whole minutes: an hour for the tank, a minute for the motor (an hour of a
    // motor is millions of steps, and tells nothing its first minute does not).
    $('#sandboxMinutes').value = String(Math.max(1, Math.round((settings.horizon ?? 3600) / 60)));
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
    // Trying something starts from the twin's latest move, while it runs: once the log has been played or the twin stopped, it is not
    // offered, and says why.
    $('#trySomething').disabled = !twin?.running || Boolean(twin.sandbox);
    $('#trySomething').title = twin?.running ? trySomethingTitle : 'The twin has stopped: try something while it runs (Back to the setup, then Start).';
}
const trySomethingTitle = 'A copy of the twin from now, to try what an input would do; the twin itself is not changed';

// The speed the data arrives at: a file played at its pace, a recording replayed as fast as it can go, a live source at one second a
// second.
const arrivingSpeed = () => (Number.isFinite(twin.run.source.speed) ? twin.run.source.speed : twin.run.source.kind === 'recording' ? Infinity : 1);

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
    const { tall, pinned, hidden } = twin.layout;
    const shownTiles = orderedTiles().filter((tile) => !hidden.includes(tile.name));
    $('#tiles').replaceChildren(...shownTiles.map((tile) => {
        const label = tile.target?.label ?? tile.signal;
        const section = element('section', { className: `tile${tall.includes(tile.name) ? ' tall' : ''}${pinned.includes(tile.name) ? ' pinned' : ''}`, draggable: true });
        section.dataset.signal = tile.signal;
        const toggle = (list) => () => {
            twin.layout[list] = twin.layout[list].includes(tile.name) ? twin.layout[list].filter((name) => name !== tile.name) : [...twin.layout[list], tile.name];
            buildTiles();
            saveLayout();
            renderView();
        };
        const isPinned = pinned.includes(tile.name);
        const pinMark = isPinned ? element('span', { className: 'pinMark', title: 'Pinned to the top', innerHTML: icon(pinIcon) }) : null;
        const menuButton = element('button', { type: 'button', className: 'tileMenuButton', title: `Options for ${label}`, innerHTML: icon(moreIcon) });
        menuButton.setAttribute('aria-label', `Options for ${label}`);
        menuButton.setAttribute('aria-haspopup', 'menu');
        menuButton.setAttribute('aria-expanded', 'false');
        menuButton.addEventListener('click', (event) => {
            event.stopPropagation();
            openTileMenu(menuButton, [
                { label: 'Pin to the top', checked: isPinned, run: toggle('pinned') },
                { label: 'Taller', checked: tall.includes(tile.name), run: toggle('tall') },
                null,
                { label: 'Hide this signal', danger: true, run: toggle('hidden') }
            ]);
        });
        // A strip's header: its name, what the twin makes of it (the facts), its value (at the pointer, or the latest), its options.
        const header = element('header', {},
            element('div', { className: 'stripName' }, element('span', { className: 'grip', textContent: '⋮⋮', title: 'Drag to move' }), pinMark, pinMark ? ' ' : null, element('strong', { textContent: label }), ' ', element('small', { textContent: tile.name })),
            element('div', { className: 'facts' }),
            element('span', { className: 'tileEnd' }, element('span', { className: 'value', textContent: '—' }), menuButton));
        section.append(header, element('p', { className: 'tileWaiting', textContent: 'Waiting for the twin\'s first move.' }), element('div', { className: 'plot' }));
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
    $('#hiddenTiles').textContent = `Show ${plural(hidden.length, 'hidden signal')}`;
}

// The icons the room draws (24-unit paths, filled with the text colour).
const pinIcon = 'M16 3l5 5-2 1-3 3 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 3-3z';
const moreIcon = 'M5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z';
const checkIcon = 'M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z';
const icon = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;

// A menu under its button (a strip's options, the title bar's More): items { label, checked, danger, disabled, title, run }, null for a
// divider. One menu is open at a time; it closes on a choice, Escape, a click elsewhere, or the window changing size, and gives the focus
// back to its button.
let openMenu = null;
export function closeTileMenu({ refocus = false } = {}) {
    if (!openMenu) return;
    const { menu, button, cleanup } = openMenu;
    openMenu = null;
    cleanup();
    menu.remove();
    button.setAttribute('aria-expanded', 'false');
    if (refocus && button.isConnected) button.focus();
}

export function openTileMenu(button, items) {
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
        if (item.title) choice.title = item.title;
        choice.disabled = Boolean(item.disabled);
        choice.addEventListener('click', () => { closeTileMenu(); item.run(); });
        menu.append(choice);
    }
    document.body.append(menu);
    const place = button.getBoundingClientRect();
    menu.style.top = `${Math.min(place.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
    menu.style.left = `${Math.max(8, place.right - menu.offsetWidth)}px`;
    const choices = [...menu.querySelectorAll('button:not(:disabled)')];
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
    // In the unit the room's words give the latest time in ("Following now · 1.5 h", the events' times: src/twinWindow/common.mjs,
    // dataClock), so the axis and the words agree; only a span that is a sliver of the data (a motor's last twenty seconds, five minutes
    // in) is in the unit that reads at its own size.
    const unit = shown >= end / 4
        ? (end < 60 ? { divisor: 1, title: 'seconds' } : end < 3600 ? { divisor: 60, title: 'minutes' } : { divisor: 3600, title: 'hours' })
        : shown < 180 ? { divisor: 1, title: 'seconds' } : shown < 3 * 3600 ? { divisor: 60, title: 'minutes' }
        : shown < 3 * 86400 ? { divisor: 3600, title: 'hours' } : { divisor: 86400, title: 'days' };
    return { start, end, ...unit };
}

function drawTile(tile, cycle, past, time = visibleTime(cycle)) {
    if (!tile.element) return;
    $('.tileWaiting', tile.element)?.remove();
    const rows = cycle.window[tile.signal] ?? [];
    const shownAs = displayOf(tile.target?.unit);
    const measured = [...tile.measured].filter(([at]) => at <= cycle.now + 1e-9).sort((a, b) => a[0] - b[0]).map(([at, value]) => [at, shownAs.at(value)]);
    const latest = measured.at(-1)?.[1];
    const unit = shownAs.unit ? ` ${shownAs.unit}` : '';
    const value = $('.value', tile.element);
    value.dataset.latest = `${shown(latest)}${unit}`;
    if (!cursorTime) value.textContent = value.dataset.latest;
    const jump = cycle.jumps?.[tile.signal]?.jump;
    const trend = trendOfSignal(cycle, tile.signal);
    const leaning = Boolean(trend) && trend.direction !== 'none';
    const alarm = Boolean(trend?.alarm);
    tile.element.className = tile.element.className.replace(/ ?\b(good|lean|bad)\b/g, '') + ` ${alarm ? 'bad' : leaning || (Number.isFinite(jump) && Math.abs(jump) > tile.tolerance) ? 'lean' : 'good'}`;
    const facts = $('.facts', tile.element);
    facts.replaceChildren();
    const upTo = twin.cycles.filter((item) => item.index <= cycle.index);
    const jumps = upTo.map((item) => item.jumps?.[tile.signal]?.jump).filter(Number.isFinite).slice(-60);
    // The header is one line, so it says only what matters most, in order: the jumps against the most one may be, the drift's state,
    // an estimate's band, and the warning while there is no state to say. Each says the rest in its tooltip; on a narrow strip what
    // comes last shrinks and ends in an ellipsis.
    const within = `${brief(shownAs.by(tile.tolerance))}${unit}`;
    const warnsAt = Number.isFinite(twin.settings.alertAt) && twin.settings.alertAt > 0 ? `${brief(shownAs.by(twin.settings.alertAt * tile.tolerance))}${unit}` : null;
    facts.append(element('span', {
        className: 'jumps',
        title: `How far each move set the model right (the latest last). A jump larger than ±${within} leans the strip amber${warnsAt ? `; when the jumps keep to one side by more than ${warnsAt}, on average a move, the room warns of a drift` : ''}.`
    }, `jumps`, sparkline(jumps, '#e0a14c'), `${Number.isFinite(jump) ? brief(shownAs.by(jump)) : '—'} of ±${within}`));
    if (alarm) facts.append(element('span', { className: 'state', textContent: 'drifting past the warning' }));
    else if (leaning) facts.append(element('span', { className: 'state', textContent: `leaning ${trend.direction} the readings` }));
    const honesty = tile.estimated ? bandOf(tile, upTo) : null;
    if (honesty) facts.append(element('span', { className: `state ${honesty.word === 'honest' ? '' : 'lean'}`, textContent: honesty.text, title: honesty.title }));
    if (warnsAt && !alarm && !leaning) facts.append(element('span', { textContent: `warns at ${warnsAt}`, title: `When the jumps keep to one side by more than ${warnsAt}, on average a move, the room warns of a drift` }));
    if (!globalThis.Plotly) return;
    // Only what is in the span is drawn (a little before it too, so a line enters from the edge): the plot stays readable, and quick.
    const from = time.start - (time.end - time.start) * 0.02;
    const inSpan = (points) => points.filter((point) => point.time >= from);
    const hours = (points) => points.map((point) => point.time / time.divisor);
    // The model before this move's window, as each earlier move ran it: the stretch each move added after the one before it, joined into
    // one line that jumps straight up or down where a move set it right (each move's stretch starts at the time the one before ended).
    // Up to the move before this one; this move's stretch, from where that one ended to now, is drawn as now. (Drawn whole, this move's
    // window hid the earlier moves' corrections within it, and read as an hour of the model running away to a step at now.)
    const earlier = { x: [], y: [] };
    let previousNow = -Infinity;
    // Where the twin took new values (a refit applied, or a parameter set): the start of the stretch of the first move made with them.
    const changes = [];
    for (const item of twin.cycles) {
        if (item.refit && Number.isFinite(previousNow) && item.index <= cycle.index && previousNow >= from) changes.push(previousNow);
        if (item.index >= cycle.index) break;
        const added = (item.window[tile.signal] ?? []).filter((row) => row.time >= previousNow - 1e-9 && row.time <= item.now + 1e-9 && row.time >= from);
        // The first move with new values ran its window again with them, so where its stretch starts the model is where those values
        // put it, not where the old ones had: a different run, not a jump in the temperature. The line breaks there, at the marker,
        // rather than drawing a cliff no system could make.
        if (item.refit && earlier.x.length) { earlier.x.push(null); earlier.y.push(null); }
        previousNow = item.now;
        for (const row of added) { earlier.x.push(row.time / time.divisor); earlier.y.push(shownAs.at(row.simulated)); }
    }
    const window = inSpan(rows.filter((row) => row.time >= previousNow - 1e-9).map((row) => ({ time: row.time, value: shownAs.at(row.simulated) })));
    // The forecast from where the system is: the state set at now toward the latest reading (src/windowSession.mjs), its line starting there.
    const startsAt = cycle.forecastFrom?.[tile.signal]?.applied;
    const forecast = [...(Number.isFinite(startsAt) ? [{ time: cycle.now, value: shownAs.at(startsAt) }] : []), ...(cycle.forecast?.[tile.signal] ?? []).map((point) => ({ time: point.time, value: shownAs.at(point.value) }))];
    const shownMeasured = measured.filter(([at]) => at >= from);
    const band = cycle.estimate?.band?.[tile.signal] ? inSpan(cycle.estimate.band[tile.signal]) : null;
    const sandbox = !past ? (twin.sandbox?.series?.[tile.signal] ?? null)?.map((point) => ({ time: point.time, value: shownAs.at(point.value) })) ?? null : null;
    const traces = [
        ...(band ? [
            { type: 'scatter', mode: 'lines', name: 'Band', x: hours(band), y: band.map((point) => shownAs.at(point.high)), line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
            { type: 'scatter', mode: 'lines', name: 'Band (10–90%)', x: hours(band), y: band.map((point) => shownAs.at(point.low)), line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(75,143,226,.18)', hoverinfo: 'skip' }
        ] : []),
        { type: 'scatter', mode: 'markers', name: 'Measured', x: shownMeasured.map(([at]) => at / time.divisor), y: shownMeasured.map(([, value]) => value), marker: { size: 3, color: '#e0894c' } },
        ...(earlier.x.length ? [{ type: 'scatter', mode: 'lines', name: 'Model, as each move ran it', x: earlier.x, y: earlier.y, connectgaps: false, line: { width: 1.5, color: 'rgba(75,143,226,.75)' }, legendgroup: 'model', showlegend: false }] : []),
        { type: 'scatter', mode: 'lines', name: 'Model', x: hours(window), y: window.map((point) => point.value), line: { width: 2, color: '#4b8fe2' }, legendgroup: 'model' },
        { type: 'scatter', mode: 'lines', name: 'Forecast', x: hours(forecast), y: forecast.map((point) => point.value), line: { width: 2, dash: 'dash', color: '#4b8fe2' } },
        ...(sandbox ? [{ type: 'scatter', mode: 'lines', name: 'Tried', x: hours(sandbox), y: sandbox.map((point) => point.value), line: { width: 2, dash: 'dot', color: '#9b8cf0' } }] : [])
    ];
    // What the pointer line reads at a time: the measured readings drawn, else the model.
    tile.drawn = { readings: shownMeasured, unit, model: [...earlier.x.map((x, index) => [x, earlier.y[index]]).filter(([x]) => x !== null).map(([x, y]) => [x * time.divisor, y]), ...window.map((point) => [point.time, point.value])] };
    globalThis.Plotly.react($('.plot', tile.element), traces, plotLayout({
        margin: stripMargin, showlegend: false, hovermode: false,
        xaxis: { gridcolor: '#17252f', zeroline: false, showticklabels: false, range: [time.start / time.divisor, time.end / time.divisor], fixedrange: true },
        yaxis: { gridcolor: '#17252f', zeroline: false, nticks: 4, fixedrange: true, title: { text: shownAs.unit, standoff: 4, font: { size: 10 } } },
        shapes: [
            { type: 'rect', xref: 'x', yref: 'paper', x0: Math.max(cycle.anchor, time.start) / time.divisor, x1: cycle.now / time.divisor, y0: 0, y1: 1, fillcolor: 'rgba(57,135,229,.10)', line: { width: 0 }, layer: 'below' },
            ...changes.map((at) => ({ type: 'line', xref: 'x', yref: 'paper', x0: at / time.divisor, x1: at / time.divisor, y0: 0, y1: 1, line: { color: '#42c9bc', width: 1, dash: 'dot' } }))
        ],
        annotations: changes.map((at) => ({ x: at / time.divisor, y: 1, xref: 'x', yref: 'paper', text: 'new values', showarrow: false, xanchor: 'left', yanchor: 'top', xshift: 3, font: { size: 10, color: '#42c9bc' } }))
    }), { displayModeBar: false, responsive: true });
    tile.changes = changes;
}

// An input as the room names it (its parameter's label, not the identifier the readings carry), and its unit.
const inputName = (signal) => twin?.inputs.find((input) => input.signal === signal)?.target?.label?.replace(/^Shared · /, '') ?? signal;
const inputUnit = (signal) => {
    const unit = twin?.inputs.find((input) => input.signal === signal)?.target?.unit;
    return unit ? ` ${unit}` : '';
};

function markMoreBelow() {
    const scroll = $('#trendScroll');
    scroll.classList.toggle('moreBelow', scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 2);
}

// Every plot in the column has the same margins, so their time axes line up to the pixel: a time is in the same place in every strip.
const stripMargin = { l: 64, r: 14, t: 6, b: 6 };

// The column's one time axis, at its foot.
function drawAxis(time) {
    if (!globalThis.Plotly) return;
    globalThis.Plotly.react($('#timeAxis'), [{ type: 'scatter', mode: 'lines', x: [time.start / time.divisor, time.end / time.divisor], y: [0, 0], line: { width: 0 }, hoverinfo: 'skip' }], plotLayout({
        margin: { ...stripMargin, t: 0, b: 30 }, showlegend: false, hovermode: false,
        xaxis: { gridcolor: '#17252f', zeroline: false, showgrid: false, range: [time.start / time.divisor, time.end / time.divisor], title: { text: time.title, standoff: 4, font: { size: 11 } }, fixedrange: true },
        yaxis: { visible: false, fixedrange: true }
    }), { displayModeBar: false, responsive: true, staticPlot: true });
    twin.shownTime = time;
}

// ---- The line through the column at the pointer ----------------------------------------------------------------------------------
// Pointed at, a time is marked through every strip, each strip's value at that time is shown in its header, and the time beneath.
let cursorTime = null;
const valueAtTime = (points, at) => {
    let found = null;
    for (const [time, value] of points) {
        if (time > at + 1e-9) break;
        found = value;
    }
    return found;
};
function showCursor(event) {
    const time = twin?.shownTime;
    const plot = event.target.closest?.('.plot');
    if (!time || !plot) { hideCursor(); return; }
    const box = plot.getBoundingClientRect();
    const fraction = (event.clientX - box.left - stripMargin.l) / (box.width - stripMargin.l - stripMargin.r);
    if (!(fraction >= 0 && fraction <= 1)) { hideCursor(); return; }
    cursorTime = time.start + fraction * (time.end - time.start);
    const column = $('#trendColumn').getBoundingClientRect();
    const line = $('#trendCursor');
    line.hidden = false;
    // From the top of the strips (under the column's header, however tall it wraps) to the axis.
    line.style.top = `${$('#trendScroll').offsetTop}px`;
    $('#trendColumn').classList.add('pointing');
    line.style.left = `${event.clientX - column.left}px`;
    $('#trendCursorTime').textContent = dataTime(cursorTime);
    for (const tile of twin.tiles) {
        if (!tile.element || !tile.drawn) continue;
        const read = valueAtTime(tile.drawn.readings, cursorTime) ?? valueAtTime(tile.drawn.model, cursorTime);
        $('.value', tile.element).textContent = read === null ? '—' : `${shown(read)}${tile.drawn.unit}`;
    }
    for (const input of twin.inputs) {
        if (!input.element || !input.drawn) continue;
        const read = valueAtTime(input.drawn.readings, cursorTime);
        $('.latest', input.element).textContent = read === null ? '—' : `${shown(read)}${input.drawn.unit}`;
    }
}
function hideCursor() {
    if (cursorTime === null && $('#trendCursor').hidden) return;
    cursorTime = null;
    $('#trendCursor').hidden = true;
    $('#trendColumn').classList.remove('pointing');
    for (const tile of twin?.tiles ?? []) if (tile.element) $('.value', tile.element).textContent = $('.value', tile.element).dataset.latest ?? '—';
    for (const input of twin?.inputs ?? []) if (input.element) $('.latest', input.element).textContent = $('.latest', input.element).dataset.latest ?? '—';
}

// ---- Inputs and what the twin infers ---------------------------------------------------------------------------------------------
function renderInputs() {
    if (!twin.inputs.length) {
        $('#inputRows').replaceChildren(element('p', { className: 'empty', textContent: 'No input is mapped: the model runs on its own parameter values.' }));
        return;
    }
    $('#inputRows').replaceChildren(...twin.inputs.map((input) => {
        const row = element('div', { className: 'inputRow' },
            element('header', {}, element('strong', { textContent: input.target?.label.replace(/^Shared · /, '') ?? input.signal }), element('small', { className: 'inputKind', textContent: 'input' }), element('span', { className: 'latest', textContent: '—' })),
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
        $('.latest', input.element).dataset.latest = readings.length ? `${shown(readings.at(-1)[1])}${unit}` : 'nothing received yet';
        if (!cursorTime) $('.latest', input.element).textContent = $('.latest', input.element).dataset.latest;
        input.drawn = { readings, unit };
        // What was tried in the sandbox (while following now): the value it started from, each change and when, held to where it has run.
        const sandbox = twin.view === null ? twin.sandbox : null;
        const tried = sandbox ? triedInput(sandbox, input.signal).map(([at, value]) => [at, shownAs.at(value)]) : [];
        if (!globalThis.Plotly || !readings.length) continue;
        // Within the span, the value held from before it starting at its edge, and the last value held up to now, so a step is drawn
        // to the present.
        const before = readings.filter(([at]) => at < time.start).at(-1);
        const within = [...(before ? [[time.start, before[1]]] : []), ...readings.filter(([at]) => at >= time.start)];
        const x = [...within.map(([at]) => at / time.divisor), cycle.now / time.divisor];
        const y = [...within.map(([, value]) => value), within.at(-1)[1]];
        const low = Math.min(...y, ...tried.map(([, value]) => value));
        const high = Math.max(...y, ...tried.map(([, value]) => value));
        const pad = (high - low || Math.abs(high) || 1) * 0.15;
        const traces = [{ type: 'scatter', mode: 'lines', name: 'Received', x, y, line: { shape: 'hv', width: 1.5, color: '#9b8cf0' } }];
        if (tried.length > 1) traces.push({ type: 'scatter', mode: 'lines', name: 'Tried', x: tried.map(([at]) => at / time.divisor), y: tried.map(([, value]) => value), line: { shape: 'hv', width: 2, dash: 'dot', color: '#d6ccff' } });
        globalThis.Plotly.react($('.plot', input.element), traces,
            plotLayout({
                margin: stripMargin, showlegend: false, hovermode: false, font: { color: '#9fb2bb', size: 10 },
                xaxis: { gridcolor: '#17252f', zeroline: false, showticklabels: false, range: [time.start / time.divisor, time.end / time.divisor], fixedrange: true },
                yaxis: { gridcolor: '#17252f', zeroline: false, fixedrange: true, range: [low - pad, high + pad], tickvals: low === high ? [low] : [low, high], ticktext: (low === high ? [low] : [low, high]).map((value) => `${shown(value)}${unit}`) }
            }), { displayModeBar: false, responsive: true });
    }
}

// An input as the sandbox has it: [[time, value]] from its start, each change tried, and the last held to where it has run; empty when
// the sandbox has not run, or knows nothing of the input.
function triedInput(sandbox, signal) {
    const reached = sandbox.startedAt + sandbox.ranFor;
    const start = sandbox.startInputs?.[signal];
    const steps = sandbox.tried.filter((step) => step.signal === signal).map((step) => [step.time, step.value]);
    if (!(reached > sandbox.startedAt) || (!Number.isFinite(start) && !steps.length)) return [];
    const points = [...(Number.isFinite(start) ? [[sandbox.startedAt, start]] : []), ...steps];
    return [...points, [reached, points.at(-1)[1]]];
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
        // Each move's stretch after the one before ended, as the model line is drawn: a later move's run of its window, from its own
        // start, written over the earlier ones' made a comb of the starts of every run.
        const after = entry.until ?? -Infinity;
        for (const point of series) if (point.time > after + 1e-9 && point.time <= cycle.now + 1e-9) entry.history.set(point.time, point.value);
        entry.history.set(cycle.now, valueAt(series, cycle.now));
        entry.until = Math.max(after, cycle.now);
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

// At most `count` points, evenly through the series, its last kept.
const everyFew = (points, count) => (points.length <= count ? points : Array.from({ length: count }, (_, index) => points[Math.round((index * (points.length - 1)) / (count - 1))]));

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
        // Over the twin's own time scale, its window: an hour for a tank, five seconds for a motor.
        const span = Number(twin.settings.window) > 0 ? Number(twin.settings.window) : 3600;
        // The sparkline shows the last dozen windows, and the word says where its right-hand end is going, over the last three: an
        // hour's movement alone hides a day's fall outdoors.
        const shownHistory = raw.filter(([time]) => time >= raw.at(-1)[0] - 12 * span - 1e-9);
        const step = stepOf(raw, span);
        const stepUnit = shownAs.unit ? ` ${shownAs.unit}` : '';
        const trend = step
            ? { word: `${step.change < 0 ? 'dropped' : 'rose'} ${ago(raw.at(-1)[0] - step.time, span)}`, kind: step.change < 0 ? 'falling' : 'rising', said: `from ${readable(shownAs.at(step.from))}${stepUnit} to ${readable(shownAs.at(step.to))}${stepUnit}` }
            : trendOf(shownHistory, 3 * span);
        const units = shownAs.unit ? ` ${shownAs.unit}` : '';
        const number = element('div', { className: 'number', textContent: `${readable(latest)}${units}` });
        if (Number.isFinite(spread) && spread > 0) number.append(element('small', { textContent: ` ±${brief(spread)}` }));
        const made = element('div', { className: 'inferredRow' },
            element('div', {}, element('strong', { textContent: name }), element('small', { textContent: kind })),
            number,
            element('span', { className: `trend ${trend.kind}`, textContent: trend.word, title: trend.said ?? (Number.isFinite(trend.change) ? `${trend.change > 0 ? '+' : ''}${shown(shownAs.by(trend.change))}${units} over the last ${dataClock(trend.span)}` : '') }),
            sparkline(everyFew(shownHistory, 120).map(([, value]) => shownAs.at(value))));
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
    $('#timeLabel').textContent = following ? `Following now · ${dataClock(cycle.now)}` : `${dataTime(cycle.now)} · ${plural(behind, 'move')} ago`;
    $('#timeFollow').hidden = following;
    $('#tiles').classList.toggle('past', !following);
    const time = visibleTime(cycle);
    for (const tile of twin.tiles) drawTile(tile, cycle, !following, time);
    drawInputs(cycle, time);
    drawAxis(time);
    // The legend names what is drawn: the band only while a signal is estimated, what was tried only in a sandbox.
    $('#legendBand').hidden = !twin.tiles.some((tile) => tile.estimated);
    $('#legendTried').hidden = !twin.sandbox || !following;
    drawInferred(cycle);
}

// ---- Events ----------------------------------------------------------------------------------------------------------------------
// One list, timed, newest first: warnings, the twin falling behind, the engine restarted, what the source says, changes made, the end.
// actions: [{ label, run }] offered on the event, such as replaying a recording.
// An estimated signal's band: how many of its readings fell outside the 10th to 90th percentile the twin expected, where about one in
// five is honest; far more, the twin is surer than it should be (its band too narrow), far fewer, more cautious than it need be.
function bandOf(tile, cycles) {
    const outside = cycles.reduce((sum, item) => sum + (item.estimate?.outside?.[tile.signal]?.outside ?? 0), 0);
    const total = cycles.reduce((sum, item) => sum + (item.estimate?.outside?.[tile.signal]?.total ?? 0), 0);
    if (!total) return null;
    const share = Math.round((outside / total) * 100);
    const word = share > 35 ? 'too narrow' : share < 8 ? 'too wide' : 'honest';
    return {
        word, share,
        text: `band ${word} · ${share}% outside`,
        title: `${outside} of ${total} readings fell outside the twin's 10th to 90th percentile; about 20% is honest. ${word === 'too narrow' ? 'The twin is surer than it should be: give the readings more noise, or let the model drift more, in the engineer\'s view.' : word === 'too wide' ? 'The twin is more cautious than it need be: less noise, or less drift, would tighten it.' : ''}`.trim()
    };
}

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
        if (drift === 'bad') addEvent('bad', `${name} is drifting past the warning`, `${jumps}; it warns at ${brief(shownAs.by(twin.settings.alertAt * (tile.tolerance ?? 0)))}${unit} a move on average${advice}`, cycle.now);
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
        const arriving = arrivingSpeed();
        const headroom = Number.isFinite(stats.realTimeFactor) && Number.isFinite(arriving) ? stats.realTimeFactor / arriving : Infinity;
        const pace = headroom >= 10 ? 'keeping up easily' : headroom >= 1.5 ? 'keeping up' : 'only just keeping up';
        const behind = stats.lagSeconds > 2 * twin.settings.stride;
        $('#healthTwin').textContent = `Live · ${plural(stats.cycles, 'move')} · ${behind ? `${Math.round(stats.lagSeconds / 60)} min behind the data` : pace}`;
        $('#healthTwin').title = `The model runs ${Number.isFinite(stats.realTimeFactor) ? Math.round(stats.realTimeFactor).toLocaleString() : 'far more'} times faster than real time${Number.isFinite(arriving) ? `, and the data arrives at ${arriving}×` : ''}; a move takes ${(stats.cycleSeconds.median * 1000).toFixed(1)} ms.`;
        $('#healthTwin').className = `healthItem ${headroom >= 1.5 && !behind ? 'good' : 'lean'}`;
        const alarm = cycle.trend?.alarm;
        // In step, but an estimated signal's band too narrow: said with it, so the chip does not say all is well beside a strip that
        // says most readings fall outside what the twin expected.
        const narrow = twin.tiles.filter((tile) => tile.estimated && bandOf(tile, twin.cycles)?.word === 'too narrow');
        const leaningNow = cycle.trend?.direction !== 'none';
        $('#healthDrift').className = `healthItem ${alarm ? 'bad' : leaningNow || narrow.length ? 'lean' : 'good'}`;
        $('#healthDrift').textContent = alarm ? 'Drifting past the warning' : leaningNow ? 'Leaning' : narrow.length ? 'In step · band too narrow' : 'In step';
        const worst = twin.tiles.find((tile) => tile.signal === cycle.trend?.signal);
        $('#healthDrift').title = alarm || leaningNow ? `${worst?.target?.label ?? cycle.trend?.signal}${twin.tiles.filter((tile) => driftOf(trendOfSignal(cycle, tile.signal)) !== 'good').length > 1 ? ', and others' : ''}`
            : narrow.length ? `The model keeps to the readings, but more of ${narrow.map((tile) => tile.target?.label ?? tile.signal).join(', ')}'s readings fall outside the twin's band than an honest band lets through: it is surer than it should be`
            : 'Every measured signal is in step';
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
        const takesEffect = Number.isFinite(outcome?.takesEffect) ? outcome.takesEffect : twin.cycles.at(-1).now;
        twin.baseline = model;
        twin.settings = { ...twin.settings, document: model };
        twin.pending = null;
        addEvent('info', 'The model\'s change was applied to the twin', `${said}; the twin runs on with it from ${dataClock(takesEffect)} of data, its latest window run again with it${outcome.added.length ? `, ${plural(outcome.added.length, 'new state')} at ${outcome.added.length === 1 ? 'its' : 'their'} initial value${outcome.added.length === 1 ? '' : 's'}` : ''}`, takesEffect);
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
        // Its inputs as the sandbox starts from them (the session's latest move, which may be newer than the one drawn here).
        const startInputs = opened.startInputs ?? cycle.inputs ?? {};
        twin.sandbox = { startedAt: opened.time, ranFor: 0, tried: [], series: null, cycle, startInputs };
        twin.view = null;
        const slots = [];
        sandboxTargets = [];
        $('#sandboxInputs').replaceChildren(...twin.inputs.map((input) => {
            const field = element('input', { type: 'number', step: 'any', value: String(startInputs[input.signal] ?? '') });
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
        $('#sandboxStatus').textContent = `From ${dataClock(opened.time)} of data.`;
        // Following the controls starts at the pace the data arrives at, the fastest offered at or below it: real time for a motor steered
        // by hand, ten minutes a second for a log played at 600×.
        const paces = [...$('#sandboxPace').options].map((option) => Number(option.value));
        $('#sandboxPace').value = String(paces.filter((pace) => pace <= arrivingSpeed()).at(-1) ?? paces[0]);
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
            const before = sandbox.tried.filter((step) => step.signal === field.dataset.signal).at(-1)?.value ?? sandbox.startInputs?.[field.dataset.signal];
            if (field.value.trim() === '' || !Number.isFinite(value) || value === before) continue;
            await host.api.liveTwin.sandboxSetInput(field.dataset.signal, value);
        }
        const seconds = Number($('#sandboxMinutes').value) * 60;
        if (!(seconds > 0)) throw new Error('Run ahead for a positive number of minutes.');
        const result = await host.api.liveTwin.sandboxRunFor(seconds);
        takeSandboxResult(sandbox, result);
        $('#sandboxStatus').className = 'status good';
        $('#sandboxStatus').textContent = `Ran ahead to ${dataClock(result.time)}${result.tried.length ? ` with ${result.tried.map((step) => `${inputName(step.signal)} ${Number(Number(step.value).toPrecision(4))}${inputUnit(step.signal)}`).join(', ')}` : ' with nothing changed'}.`;
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
    sandbox.series = Object.fromEntries(Object.entries(result.series).map(([signal, samples]) => [signal, thinned([...(previous[signal] ?? []), ...samples])]));
}

// What was tried, drawn from a few thousand points however long it is followed: past the limit, the points are kept evenly spaced in
// time over the whole run, at most half the limit of them (and the last kept). Following the controls adds a run ahead twenty times a
// second, and kept whole, a motor at a millisecond grows by tens of thousands of points a second. (Halving by index instead let the
// start of the run decay away, each halving thinning it again while the newest arrived whole.)
const sandboxDrawnLimit = 4000;
function thinned(samples) {
    if (samples.length <= sandboxDrawnLimit) return samples;
    const spacing = (samples.at(-1).time - samples[0].time) / (sandboxDrawnLimit / 2);
    const kept = [samples[0]];
    for (const sample of samples.slice(1, -1)) if (sample.time >= kept.at(-1).time + spacing) kept.push(sample);
    kept.push(samples.at(-1));
    return kept;
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
    if (!twin?.sandbox || twin.sandbox.following) return;
    // Started again from the live twin's latest move when the live twin has moved on since the copy was made: steered in real time, what
    // is done must be drawn at the right-hand edge as it is done, not back where Try something was opened, behind the live data and soon
    // scrolled away. What was tried in the copy before is kept as a draft, as Back to live keeps it; what the person changed in the fields is
    // carried over.
    const latest = twin.cycles.at(-1)?.now;
    if (twin.running && Number.isFinite(latest) && twin.sandbox.startedAt + twin.sandbox.ranFor < latest - 1e-9) {
        // Only what the person changed is carried over: a field still showing what the old copy had (its start, or its last value tried)
        // takes the new move's input instead. Carried whole, a voltage read during a ramp at 11 s was applied at 18 s, a change nobody
        // made, while the motor was receiving 12 V.
        const old = twin.sandbox;
        const had = (signal) => old.tried.filter((step) => step.signal === signal).at(-1)?.value ?? old.startInputs?.[signal];
        const fields = Object.fromEntries($$('#sandboxInputs input')
            .filter((field) => field.value.trim() !== '' && Number(field.value) !== had(field.dataset.signal))
            .map((field) => [field.dataset.signal, field.value]));
        await closeSandbox();
        await openSandbox();
        if (!twin?.sandbox) return;
        for (const field of $$('#sandboxInputs input')) if (fields[field.dataset.signal] !== undefined) field.value = fields[field.dataset.signal];
        refreshFollowOffer();
    }
    const sandbox = twin.sandbox;
    const following = { queue: [], startedWall: performance.now(), startedModel: sandbox.startedAt + sandbox.ranFor };
    // What the fields say as it starts goes first: a value typed or moved before.
    for (const field of $$('#sandboxInputs input')) {
        const value = Number(field.value);
        const before = sandbox.tried.filter((step) => step.signal === field.dataset.signal).at(-1)?.value ?? sandbox.startInputs?.[field.dataset.signal];
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
                        $('#sandboxStatus').textContent = `Following the controls: ${dataClock(result.time)}${result.tried.length ? `, ${result.tried.length} ${result.tried.length === 1 ? 'change' : 'changes'} tried` : ''}.`;
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

// Pause holds the sandbox where it is; Run ahead carries on from there, and so does Follow the controls unless the live twin has moved
// on meanwhile (then it starts again from the latest move).
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
    reportStatus();
    const closed = await host.api.liveTwin.sandboxClose().catch(() => null);
    const tried = closed?.tried ?? sandbox.tried;
    if (tried.length || sandbox.ranFor > 0) {
        try {
            const kept = await host.askProject('keepScenario', {
                logFileName: twin.run.logFileName ?? '', startedAt: sandbox.startedAt, ranFor: sandbox.ranFor,
                settings: { window: twin.settings.window, stride: twin.settings.stride, horizon: twin.settings.horizon }, tried, document: twin.settings.document,
                inputs: Object.fromEntries(twin.inputs.map((input) => [input.signal, { name: input.target?.label.replace(/^Shared · /, '') ?? input.signal, unit: input.target?.unit ?? '' }]))
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
            element('small', { textContent: `From ${dataTime(scenario.startedAt).replace(/^at /, '')}${scenario.logFileName ? ` of ${scenario.logFileName}` : ''}, run ahead ${dataClock(scenario.ranFor)}${scenario.modelChanged ? '. The model has changed since.' : '.'}` }));
        row.dataset.scenarioId = scenario.id;
        return row;
    }));
    if (!scenarios.length) $('#scenarioList').hidden = true;
}
