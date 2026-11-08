/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Steering live parameters by hand (docs/proposals/humanInputBinding.md): the bindings a person keeps, joined to the targets the
// window has open now. A target is something a control can drive: a live parameter in the project window, an input in the twin's
// sandbox ({ key, symbol, name, unit, range, value(), apply(value), show(value) }: `apply` sends a value, `show` only moves the slider
// or field). Each control's readings are mapped to values (src/inputBindings.mjs) and sent by the size of each change and once where
// the control comes to rest, so the record is short and exact. Beside each target a Bind… button and a chip per binding; the chip opens
// the binding's settings. Shared by the project window and the twin's window, each with its own devices (src/renderer/humanInput.mjs).

import {
    bindingLabel, bindingTarget, controlLabel, createBinding, createBindingDriver, createChangeRecorder, defaultMapping, givesPosition,
    keyName, normalizeInputBindings, readingMatches
} from '../inputBindings.mjs';

const tickMilliseconds = 40;
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function element(tag, properties = {}, ...children) {
    const node = Object.assign(document.createElement(tag), properties);
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
}

// `store`: { get(), set(document), onChanged(callback) }. `modelName()`: the open model's name, which a binding may be narrowed to.
// `status(text)`: tells the person something. `now()`: milliseconds, for tests.
export function createSteering({ humanInput, store, modelName = () => '', status = () => {}, now = () => performance.now() }) {
    let bindings = normalizeInputBindings(null);
    let targets = new Map();
    // Per binding: its driver and recorder (made for the target it drives now) and whether the slider took over from it.
    const states = new Map();
    const slots = new Map();
    const changeListeners = new Set();
    let ticker = null;
    let binding = null;

    const notify = () => { for (const listener of changeListeners) listener(); };

    function stateOf(entry) {
        const target = bindingTarget(entry, [...targets.values()], modelName());
        if (!target) { states.delete(entry.id); return null; }
        let state = states.get(entry.id);
        const rangeKey = JSON.stringify([target.key, target.range, entry.mapping, entry.centred, bindings.threshold]);
        if (!state || state.rangeKey !== rangeKey) {
            state = {
                rangeKey, target,
                driver: createBindingDriver(entry, target.range),
                recorder: createChangeRecorder(target.range, { threshold: bindings.threshold }),
                overridden: state?.overridden ?? false
            };
            states.set(entry.id, state);
        }
        state.target = target;
        return state;
    }

    // What is read follows what is bound: nothing until a binding exists, MIDI only once one names a MIDI device.
    function refreshReading() {
        const active = bindings.bindings.filter((entry) => stateOf(entry));
        const codes = new Set(active.filter((entry) => entry.device.kind === 'keyboard')
            .flatMap((entry) => (entry.control.type === 'keys' ? [entry.control.up, entry.control.down] : [entry.control.code])));
        humanInput.setKeyFilter((code) => codes.has(code));
        if (bindings.bindings.length) {
            humanInput.start();
            if (bindings.bindings.some((entry) => entry.device.kind === 'midi')) humanInput.requestMidi();
        }
    }

    function send(state, value) {
        state.target.apply(value);
        state.recorder.sent(value);
    }

    function offer(state, value, at) {
        state.target.show(value);
        const sent = state.recorder.offer(value, at);
        if (sent !== null) state.target.apply(sent);
        ensureTicking();
    }

    humanInput.onReading((reading) => {
        const at = now();
        for (const entry of bindings.bindings) {
            if (!readingMatches(entry, reading)) continue;
            const state = stateOf(entry);
            if (!state) continue;
            if (state.overridden) {
                state.overridden = false;
                refreshChips(state.target.key);
            }
            const current = state.target.value();
            const value = state.driver.reading(reading, at, current);
            if (value !== null) {
                // A press is a decision: sent as it is. A position is sent by the size of its change.
                if (entry.mapping.kind === 'range') offer(state, value, at);
                else { state.target.show(value); send(state, value); }
            }
            if (!reading.pressed) {
                const rested = state.driver.released(state.target.value());
                if (rested !== null) { state.target.show(rested); send(state, rested); }
            }
            ensureTicking();
        }
    });
    humanInput.onDevicesChanged(() => { refreshAllChips(); notify(); });

    function ensureTicking() {
        if (ticker !== null) return;
        ticker = setInterval(tick, tickMilliseconds);
    }

    function tick() {
        const at = now();
        let busy = false;
        for (const entry of bindings.bindings) {
            const state = states.get(entry.id);
            if (!state || !targets.has(state.target.key)) continue;
            if (!state.overridden) {
                const value = state.driver.tick(at, state.target.value());
                if (value !== null) {
                    state.target.show(value);
                    const sent = state.recorder.offer(value, at);
                    if (sent !== null) state.target.apply(sent);
                }
            }
            const rested = state.recorder.settle(at);
            if (rested !== null) state.target.apply(rested);
            busy ||= state.driver.holding || state.recorder.waiting;
        }
        if (!busy) { clearInterval(ticker); ticker = null; }
    }

    async function save(next) {
        const kept = normalizeInputBindings(next);
        bindings = kept;
        refreshReading();
        refreshAllChips();
        notify();
        try {
            bindings = normalizeInputBindings(await store.set(kept));
        } catch (error) {
            status(`The controller bindings could not be kept: ${error.message}`);
        }
        return bindings;
    }

    // ---- Chips and Bind… ------------------------------------------------------------------------------------------------------------
    function chipText(entry) {
        const state = states.get(entry.id);
        const notes = [];
        if (!humanInput.isConnected(entry.device)) notes.push(entry.device.kind === 'midi' && humanInput.midiState === 'unsupported' ? 'no MIDI in this browser' : 'not plugged in');
        else if (state?.overridden) notes.push('the slider took over until the control moves again');
        return { label: bindingLabel(entry), note: notes.join(' · ') };
    }

    // `fresh`: the slot was just made and may not be on the page yet; otherwise a slot no longer on the page is forgotten.
    function refreshChips(key, { fresh = false } = {}) {
        const slot = slots.get(key);
        const target = targets.get(key);
        if (slot && !fresh && !slot.isConnected) { slots.delete(key); return; }
        if (!slot || !target) return;
        const own = bindings.bindings.filter((entry) => bindingTarget(entry, [target], modelName()));
        const chips = own.map((entry) => {
            const { label, note } = chipText(entry);
            const chip = element('button', { type: 'button', className: `inputBindingChip${note ? ' inputBindingChipNote' : ''}`, title: `${label}${note ? ` (${note})` : ''}: change how it drives ${target.name}` },
                element('span', { textContent: label }), note ? element('small', { textContent: note }) : null);
            chip.dataset.bindingId = entry.id;
            chip.addEventListener('click', () => openSettings(entry.id));
            return chip;
        });
        const bind = element('button', { type: 'button', className: 'inputBindButton', textContent: binding?.key === key ? 'Move a control… (Esc to stop)' : 'Bind…',
            title: `Steer ${target.name} with a gamepad, a MIDI controller or a key: press this, then move the control or press the key` });
        bind.dataset.bind = 'true';
        bind.addEventListener('click', () => (binding?.key === key ? binding.abort() : bindTo(key)));
        slot.replaceChildren(...chips, bind);
    }

    function refreshAllChips() { for (const key of slots.keys()) refreshChips(key); }

    // Waits for a person to move a control, then binds it to `parameter` ({ symbol, name }). `waiting(bool)` is told when it starts
    // and stops waiting. Answers the new binding, or null when the person stopped (Escape) or another bind began.
    async function bindParameter(parameter, { waiting = () => {}, key = null } = {}) {
        binding?.abort();
        const controller = new AbortController();
        const current = { key, abort: () => controller.abort() };
        binding = current;
        waiting(true);
        status(`Move a control or press a key to steer ${parameter.name}; Escape stops.`);
        humanInput.requestMidi();
        const moved = await humanInput.capture({ signal: controller.signal });
        if (binding === current) binding = null;
        waiting(false);
        if (!moved) { status(''); return null; }
        const created = createBinding({ id: newId(), device: moved.device, control: moved.control, centred: moved.centred, analogue: moved.analogue, parameter });
        // The same control bound again to the same parameter replaces what it was.
        const same = (entry) => entry.device.kind === created.device.kind && entry.device.id === created.device.id
            && JSON.stringify(entry.control) === JSON.stringify(created.control) && entry.parameter.symbol === created.parameter.symbol;
        await save({ ...bindings, bindings: [...bindings.bindings.filter((entry) => !same(entry)), created] });
        status(`${controlLabel(created.device, created.control)} now drives ${parameter.name}.`);
        return created;
    }

    // Binds a control to the target `key`, from its Bind… button.
    function bindTo(key) {
        const target = targets.get(key);
        if (!target) return Promise.resolve(null);
        return bindParameter({ symbol: target.symbol, name: target.name }, { key, waiting: () => refreshChips(key) });
    }

    // ---- A binding's settings ------------------------------------------------------------------------------------------------------
    let dialog = null;
    function openSettings(id) {
        const entry = bindings.bindings.find((candidate) => candidate.id === id);
        if (!entry) return;
        dialog?.remove();
        const position = entry.mapping.kind === 'range' || givesPosition(entry.control) || entry.control.type === 'button';
        const field = (label, input, hint) => element('label', { className: 'inputBindingField' }, element('span', { textContent: label }), input, hint ? element('small', { textContent: hint }) : null);
        const number = (value, name) => Object.assign(element('input', { type: 'number', step: 'any', value: value ?? '', placeholder: 'default' }), { name });
        const select = (name, options, value) => {
            const node = element('select', { name });
            for (const [optionValue, text] of options) node.append(new Option(text, optionValue, false, optionValue === value));
            return node;
        };
        const kinds = entry.control.type === 'keys' ? [['ramp', 'Up and down while held']]
            : [...(position ? [['range', 'Across the live range']] : []), ['momentary', 'One value while held'], ['toggle', 'Toggle between two values'], ['step', 'Step by an amount']];
        const kind = select('kind', kinds, entry.mapping.kind);
        const name = element('input', { type: 'text', name: 'label', value: entry.label, placeholder: controlLabel(entry.device, entry.control), maxLength: 80 });
        const onlyHere = element('input', { type: 'checkbox', name: 'model', checked: entry.model !== null });
        const model = entry.model ?? modelName();
        const groups = {
            range: element('div', { className: 'inputBindingGroup' },
                field('Direction', select('invert', [['false', 'As it moves'], ['true', 'Inverted']], String(entry.mapping.invert ?? false))),
                field('Curve', select('curve', [['linear', 'Linear'], ['fineMiddle', 'Finer near the middle (a setpoint)'], ['fineLow', 'Finer near the bottom (a throttle)']], entry.mapping.curve ?? 'linear')),
                entry.centred ? field('Centre', select('centre', [['middle', 'The middle of the range'], ['value', 'The value the parameter had']], entry.mapping.centre ?? 'middle')) : null),
            momentary: element('div', { className: 'inputBindingGroup' }, field('While held', number(entry.mapping.pressed, 'pressed'), 'empty: the live maximum'), field('When let go', number(entry.mapping.released, 'released'), 'empty: the live minimum')),
            toggle: element('div', { className: 'inputBindingGroup' }, field('On', number(entry.mapping.on, 'on'), 'empty: the live maximum'), field('Off', number(entry.mapping.off, 'off'), 'empty: the live minimum')),
            step: element('div', { className: 'inputBindingGroup' }, field('Each press adds', number(entry.mapping.amount, 'amount'), 'empty: one live step; negative steps down'),
                field('Held down', select('repeat', [['true', 'Repeats'], ['false', 'Once']], String(entry.mapping.repeat ?? true)))),
            ramp: element('div', { className: 'inputBindingGroup' }, field('Rate, a second', number(entry.mapping.rate, 'rate'), 'empty: the whole range in five seconds'))
        };
        const showGroup = () => { for (const [groupKind, group] of Object.entries(groups)) group.hidden = groupKind !== kind.value; };
        kind.addEventListener('change', showGroup);
        const secondKey = entry.control.type === 'key' ? element('button', { type: 'button', textContent: 'Add a key for down…', title: 'Make two keys one control: this one up, the next you press down' }) : null;
        const remove = element('button', { type: 'button', textContent: 'Remove', className: 'inputBindingRemove' });
        const done = element('button', { type: 'submit', textContent: 'Done', className: 'doneButton' });
        const form = element('form', { method: 'dialog' },
            element('span', { className: 'contextKicker', textContent: 'Controller' }),
            element('strong', { textContent: controlLabel(entry.device, entry.control) }),
            element('p', { textContent: `${entry.device.name}, driving ${entry.parameter.name} (${entry.parameter.symbol}).` }),
            field('Name', name),
            field('How it maps', kind),
            ...Object.values(groups),
            element('label', { className: 'inputBindingCheck' }, onlyHere, element('span', { textContent: `Only in “${model || 'this model'}”` })),
            element('footer', {}, remove, secondKey, done));
        // Its own dialog: a reopened one (after a second key is added) must not be closed or removed by the one it replaced.
        const own = element('dialog', { className: 'passwordDialog inputBindingDialog' }, form);
        dialog = own;
        document.body.append(own);
        showGroup();
        const value = (fieldName) => {
            const input = form.elements[fieldName];
            return input && input.value.trim() !== '' && Number.isFinite(Number(input.value)) ? Number(input.value) : null;
        };
        const mappingFromForm = () => {
            switch (kind.value) {
            case 'range': return { kind: 'range', invert: form.elements.invert.value === 'true', curve: form.elements.curve.value, centre: form.elements.centre?.value ?? 'middle' };
            case 'momentary': return { kind: 'momentary', pressed: value('pressed'), released: value('released') };
            case 'toggle': return { kind: 'toggle', on: value('on'), off: value('off') };
            case 'step': return { kind: 'step', amount: value('amount'), repeat: form.elements.repeat.value === 'true' };
            default: return { kind: 'ramp', rate: value('rate') };
            }
        };
        const replace = (changes) => save({ ...bindings, bindings: bindings.bindings.map((candidate) => (candidate.id === id ? { ...candidate, ...changes } : candidate)) });
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            replace({ label: name.value, mapping: mappingFromForm(), model: onlyHere.checked ? (model || null) : null });
            own.close();
        });
        remove.addEventListener('click', () => {
            save({ ...bindings, bindings: bindings.bindings.filter((candidate) => candidate.id !== id) });
            own.close();
        });
        secondKey?.addEventListener('click', async () => {
            secondKey.textContent = 'Press the key for down…';
            let moved = null;
            while (moved === null || (moved && moved.device.kind !== 'keyboard')) {
                moved = await humanInput.capture();
                if (moved === null) break;
            }
            if (moved && moved.control.code !== entry.control.code) {
                const control = { type: 'keys', up: entry.control.code, down: moved.control.code };
                await replace({ control, mapping: defaultMapping(control) });
                own.close();
                openSettings(id);
                return;
            }
            secondKey.textContent = 'Add a key for down…';
        });
        own.addEventListener('close', () => { own.remove(); if (dialog === own) dialog = null; });
        own.showModal();
    }

    return Object.freeze({
        async load() {
            try { bindings = normalizeInputBindings(await store.get()); } catch { bindings = normalizeInputBindings(null); }
            store.onChanged?.((next) => {
                bindings = normalizeInputBindings(next);
                refreshReading();
                refreshAllChips();
                notify();
            });
            refreshReading();
            notify();
        },
        // The targets the window has open now, replacing those it had.
        setTargets(list) {
            targets = new Map(list.map((target) => [target.key, target]));
            for (const key of [...slots.keys()]) if (!targets.has(key)) slots.delete(key);
            refreshReading();
            refreshAllChips();
        },
        // Puts the Bind… button and the chips of `key`'s bindings in `slot`, kept up to date.
        decorate(slot, key) {
            slot.classList.add('inputBindingSlot');
            slots.set(key, slot);
            refreshChips(key, { fresh: true });
        },
        // The slider or field of `key` was moved by hand: it wins over a control until the control moves again.
        sliderMoved(key) {
            let changed = false;
            for (const state of states.values()) {
                if (state.target.key === key && !state.overridden) { state.overridden = true; changed = true; }
            }
            if (changed) refreshChips(key);
        },
        bindTo,
        bindParameter,
        // Stops waiting for a control to bind.
        stopBinding() { binding?.abort(); },
        openSettings,
        save,
        get document() { return bindings; },
        targets: () => [...targets.values()],
        // A binding as the settings list shows it: its target in the open model, if any, and whether its device is there.
        describe(entry) {
            return { label: bindingLabel(entry), target: bindingTarget(entry, [...targets.values()], modelName()), connected: humanInput.isConnected(entry.device) };
        },
        isBound: (key) => bindings.bindings.some((entry) => { const target = targets.get(key); return target && bindingTarget(entry, [target], modelName()); }),
        onChanged(listener) { changeListeners.add(listener); return () => changeListeners.delete(listener); },
        keyName,
        humanInput
    });
}
