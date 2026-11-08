/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Reading the devices a person steers a model with (docs/proposals/humanInputBinding.md): gamepads and joysticks through the Gamepad
// API, MIDI controllers through Web MIDI, and the keyboard. Every kind reports one thing, a reading: this control on this device now
// has this value ({ device, control, value, pressed, centred, analogue }), a position from 0 to 1 (−1 to 1 for a centred stick) or a
// press and a release. What a person cannot press reliably is filtered here: a stick's dead zone, and a knob's jitter of one step
// that comes straight back. Nothing is read until start() (or capture()) is called, and MIDI is asked for only by requestMidi().
// A window reads its devices only while it is in front, so a knob turned while another window is in front does nothing.
// For tests, `simulated` stands in for the devices: a test cannot plug in a gamepad. Shared by the project window and the twin's.

import { defaultDeadZone, withoutDeadZone } from '../inputBindings.mjs';

const keyboardDevice = Object.freeze({ kind: 'keyboard', id: 'keyboard', name: 'Keyboard' });
// A single step of a 7-bit knob that comes back within this long is jitter, not a turn.
const jitterMilliseconds = 60;
const textEntryTypes = new Set(['', 'text', 'number', 'search', 'email', 'password', 'url', 'tel', 'date', 'time', 'datetime-local', 'month', 'week']);

// Whether a key pressed in `target` is being typed into a field, which a binding must leave alone.
function typingInto(target) {
    if (!target || typeof target !== 'object') return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return tag === 'INPUT' && textEntryTypes.has((target.getAttribute('type') ?? '').toLowerCase());
}

const gamepadName = (id) => String(id).replace(/\s*\(.*\)\s*$/, '').trim() || String(id);

export function createHumanInput({ host = globalThis } = {}) {
    const readingListeners = new Set();
    const deviceListeners = new Set();
    let started = false;
    let frame = null;
    let midiState = typeof host.navigator?.requestMIDIAccess === 'function' ? 'unasked' : 'unsupported';
    let midiAccess = null;
    let midiRequest = null;
    const midiDevices = new Map();
    const midiMostSignificant = new Map();
    const midiPending = new Map();
    const midiLast = new Map();
    // Gamepads by id: what each control read last, so only a change is reported. A pad seen for the first time (or again after it was
    // unplugged) only sets this, so a stick that comes back off-centre does not move a value until it is moved.
    const padState = new Map();
    const simulatedPads = new Map();
    const heldKeys = new Set();
    let keyWanted = () => false;
    let capturing = null;

    const inFront = () => host.document?.visibilityState !== 'hidden' && (host.document?.hasFocus?.() ?? true);
    const emit = (reading) => {
        if (capturing && capturing.consider(reading)) return;
        for (const listener of readingListeners) listener(reading);
    };
    const devicesChanged = () => { for (const listener of deviceListeners) listener(); };

    // ---- Gamepads -----------------------------------------------------------------------------------------------------------------
    function pads() {
        const real = [...(host.navigator?.getGamepads?.() ?? [])].filter((pad) => pad && pad.connected !== false);
        return [...real.map((pad) => ({ pad, simulated: false })), ...[...simulatedPads.values()].map((pad) => ({ pad, simulated: true }))];
    }

    function pollGamepads() {
        const seen = new Set();
        for (const { pad, simulated } of pads()) {
            if (seen.has(pad.id)) continue;
            seen.add(pad.id);
            const device = { kind: 'gamepad', id: pad.id, name: gamepadName(pad.id) };
            const axes = [...pad.axes].map((value) => Math.round(withoutDeadZone(Number(value) || 0, defaultDeadZone) * 1000) / 1000);
            const buttons = [...pad.buttons].map((button) => ({ value: Number(button?.value) || 0, pressed: Boolean(button?.pressed) }));
            const previous = padState.get(pad.id);
            if (!previous) {
                padState.set(pad.id, { axes, buttons, analogue: new Set() });
                devicesChanged();
                continue;
            }
            // A real pad is read only while the window is in front (the browser stops it otherwise); a simulated one always.
            if (!simulated && !inFront()) { previous.axes = axes; previous.buttons = buttons; continue; }
            axes.forEach((value, index) => {
                if (value === previous.axes[index]) return;
                emit({ device, control: { type: 'axis', index }, value, pressed: value !== 0, centred: true, analogue: true });
            });
            buttons.forEach((button, index) => {
                const before = previous.buttons[index] ?? { value: 0, pressed: false };
                if (button.value > 0 && button.value < 1) previous.analogue.add(index);
                if (Math.abs(button.value - before.value) < 0.01 && button.pressed === before.pressed) return;
                emit({ device, control: { type: 'button', index }, value: button.value, pressed: button.pressed, centred: false, analogue: previous.analogue.has(index) });
            });
            previous.axes = axes;
            previous.buttons = buttons;
        }
        for (const id of [...padState.keys()]) {
            if (!seen.has(id)) { padState.delete(id); devicesChanged(); }
        }
    }

    function loop() {
        frame = null;
        if (!started) return;
        pollGamepads();
        frame = host.requestAnimationFrame ? host.requestAnimationFrame(loop) : host.setTimeout(loop, 16);
    }

    // ---- The keyboard -------------------------------------------------------------------------------------------------------------
    function onKeyDown(event) {
        if (!started || typingInto(event.target)) return;
        const wanted = capturing || keyWanted(event.code);
        if (!wanted) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat || heldKeys.has(event.code)) return;
        heldKeys.add(event.code);
        emit({ device: keyboardDevice, control: { type: 'key', code: event.code }, value: 1, pressed: true, centred: false, analogue: false, key: event.key });
    }
    function onKeyUp(event) {
        if (!heldKeys.has(event.code)) return;
        heldKeys.delete(event.code);
        event.preventDefault();
        event.stopImmediatePropagation();
        emit({ device: keyboardDevice, control: { type: 'key', code: event.code }, value: 0, pressed: false, centred: false, analogue: false });
    }
    // Keys held when the window loses focus are let go: their key-up goes to another window.
    function onBlur() {
        for (const code of [...heldKeys]) {
            heldKeys.delete(code);
            emit({ device: keyboardDevice, control: { type: 'key', code }, value: 0, pressed: false, centred: false, analogue: false });
        }
    }

    // ---- MIDI ---------------------------------------------------------------------------------------------------------------------
    function midiDevice(input) {
        return { kind: 'midi', id: `${input.manufacturer ?? ''}|${input.name ?? input.id}`, name: input.name || input.manufacturer || 'MIDI controller' };
    }

    function midiMessage(device, data, { simulated = false } = {}) {
        if (!started || data.length < 2) return;
        if (!simulated && !inFront()) return;
        const status = data[0] & 0xF0;
        const channel = (data[0] & 0x0F) + 1;
        if (status === 0xB0 && data.length >= 3) {
            const number = data[1];
            const value = data[2];
            if (number >= 32 && number < 64) {
                // The fine half of a 14-bit control, after its coarse half.
                const coarse = midiMostSignificant.get(`${device.id}|${channel}|${number - 32}`);
                if (coarse === undefined) return;
                emit({ device, control: { type: 'cc', channel, number: number - 32 }, value: (coarse * 128 + value) / 16383, pressed: true, centred: false, analogue: true });
                return;
            }
            midiMostSignificant.set(`${device.id}|${channel}|${number}`, value);
            controlChange(device, channel, number, value);
        } else if (status === 0x90 && data.length >= 3 && data[2] > 0) {
            emit({ device, control: { type: 'note', channel, number: data[1] }, value: data[2] / 127, pressed: true, centred: false, analogue: false });
        } else if (status === 0x80 || (status === 0x90 && data.length >= 3)) {
            emit({ device, control: { type: 'note', channel, number: data[1] }, value: 0, pressed: false, centred: false, analogue: false });
        } else if (status === 0xE0 && data.length >= 3) {
            const value = Math.max(-1, ((data[2] << 7) | data[1]) / 8192 - 1);
            emit({ device, control: { type: 'pitch', channel }, value, pressed: value !== 0, centred: true, analogue: true });
        }
    }

    // A knob's change: a single step is held a moment, and dropped if the next reading takes it straight back.
    function controlChange(device, channel, number, raw) {
        const key = `${device.id}|${channel}|${number}`;
        const send = (value) => {
            midiLast.set(key, value);
            emit({ device, control: { type: 'cc', channel, number }, value: value / 127, pressed: true, centred: false, analogue: true });
        };
        const pending = midiPending.get(key);
        if (pending) {
            host.clearTimeout(pending.timer);
            midiPending.delete(key);
            if (raw === midiLast.get(key)) return;
        }
        const last = midiLast.get(key);
        if (last !== undefined && Math.abs(raw - last) === 1) {
            midiPending.set(key, { timer: host.setTimeout(() => { midiPending.delete(key); send(raw); }, jitterMilliseconds) });
            return;
        }
        send(raw);
    }

    function attachMidiInputs() {
        if (!midiAccess) return;
        const present = new Set();
        midiAccess.inputs.forEach((input) => {
            const device = midiDevice(input);
            present.add(device.id);
            midiDevices.set(device.id, device);
            input.onmidimessage = (event) => midiMessage(device, event.data);
        });
        for (const id of [...midiDevices.keys()]) if (!present.has(id) && !id.startsWith('simulated|')) midiDevices.delete(id);
        devicesChanged();
    }

    async function requestMidi() {
        if (midiState === 'granted' || midiState === 'unsupported' || midiState === 'denied') return midiState;
        midiRequest ??= host.navigator.requestMIDIAccess({ sysex: false }).then((access) => {
            midiAccess = access;
            midiState = 'granted';
            access.onstatechange = () => attachMidiInputs();
            attachMidiInputs();
            return midiState;
        }, () => {
            midiState = 'denied';
            devicesChanged();
            return midiState;
        });
        return midiRequest;
    }

    // ---- Starting, and the controls a person moves to bind one --------------------------------------------------------------------
    function start() {
        if (started) return;
        started = true;
        host.addEventListener?.('keydown', onKeyDown, true);
        host.addEventListener?.('keyup', onKeyUp, true);
        host.addEventListener?.('blur', onBlur);
        host.addEventListener?.('gamepadconnected', devicesChanged);
        host.addEventListener?.('gamepaddisconnected', devicesChanged);
        loop();
    }

    function stop() {
        if (!started) return;
        started = false;
        host.removeEventListener?.('keydown', onKeyDown, true);
        host.removeEventListener?.('keyup', onKeyUp, true);
        host.removeEventListener?.('blur', onBlur);
        host.removeEventListener?.('gamepadconnected', devicesChanged);
        host.removeEventListener?.('gamepaddisconnected', devicesChanged);
        if (frame !== null) (host.cancelAnimationFrame ?? host.clearTimeout)?.(frame);
        frame = null;
        heldKeys.clear();
    }

    // Waits for the next control a person moves decisively (a stick or trigger past half way, a knob turned, a pad or key pressed) and
    // answers { device, control, centred, analogue }; null when cancelled (Escape, or `signal` aborted). Every key goes to it meanwhile.
    function capture({ signal } = {}) {
        start();
        if (capturing) capturing.finish(null);
        return new Promise((resolve) => {
            const turned = new Map();
            const session = {
                finish(answer) {
                    if (capturing === session) capturing = null;
                    resolve(answer);
                },
                consider(reading) {
                    const { device, control } = reading;
                    if (device.kind === 'keyboard') {
                        if (!reading.pressed) return true;
                        session.finish(control.code === 'Escape' ? null : { device, control, centred: false, analogue: false });
                        return true;
                    }
                    let decisive = false;
                    if (control.type === 'cc') {
                        const key = `${device.id}|${control.channel}|${control.number}`;
                        const first = turned.get(key) ?? reading.value;
                        turned.set(key, first);
                        decisive = Math.abs(reading.value - first) >= 8 / 127;
                    } else if (control.type === 'note') decisive = reading.pressed;
                    else if (reading.centred) decisive = Math.abs(reading.value) >= 0.5;
                    else decisive = reading.pressed || reading.value >= 0.5;
                    if (decisive) session.finish({ device, control, centred: reading.centred, analogue: reading.analogue });
                    return true;
                }
            };
            capturing = session;
            signal?.addEventListener('abort', () => session.finish(null), { once: true });
        });
    }

    return Object.freeze({
        start,
        stop,
        get started() { return started; },
        capture,
        get capturing() { return Boolean(capturing); },
        requestMidi,
        get midiState() { return midiState; },
        onReading(listener) { readingListeners.add(listener); return () => readingListeners.delete(listener); },
        onDevicesChanged(listener) { deviceListeners.add(listener); return () => deviceListeners.delete(listener); },
        // Which keys a binding uses: only those are taken from the rest of the window.
        setKeyFilter(predicate) { keyWanted = typeof predicate === 'function' ? predicate : () => false; },
        // The devices connected now (the keyboard always is).
        devices() {
            return [keyboardDevice, ...[...padState.keys()].map((id) => ({ kind: 'gamepad', id, name: gamepadName(id) })), ...midiDevices.values()];
        },
        isConnected(device) {
            if (device.kind === 'keyboard') return true;
            if (device.kind === 'gamepad') return padState.has(device.id);
            return midiDevices.has(device.id);
        },
        // Stand-ins for real devices, for tests.
        simulated: Object.freeze({
            connectGamepad(id, { axes = 4, buttons = 17 } = {}) {
                simulatedPads.set(id, { id, axes: Array(axes).fill(0), buttons: Array.from({ length: buttons }, () => ({ value: 0, pressed: false })) });
            },
            disconnectGamepad(id) { simulatedPads.delete(id); },
            moveAxis(id, index, value) { simulatedPads.get(id).axes[index] = value; },
            setButton(id, index, value) { simulatedPads.get(id).buttons[index] = { value, pressed: value > 0.5 }; },
            poll() { pollGamepads(); },
            connectMidi(name) {
                const device = { kind: 'midi', id: `simulated|${name}`, name };
                midiDevices.set(device.id, device);
                devicesChanged();
                return device.id;
            },
            disconnectMidi(name) { midiDevices.delete(`simulated|${name}`); devicesChanged(); },
            midi(name, bytes) { midiMessage(midiDevices.get(`simulated|${name}`), Uint8Array.from(bytes), { simulated: true }); }
        })
    });
}
