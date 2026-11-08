/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Steering a model by hand (docs/proposals/humanInputBinding.md): the rules a binding of a gamepad's, a MIDI controller's or the
// keyboard's control to a live parameter follows, shared by the project window, the twin's window and the web edition. What a
// binding is and how it is cleaned when read back; which parameter of the open model it drives (by symbol, not id, so one binding
// serves every model that has the parameter); what value a control's reading gives; and when a value is worth sending, so a run
// steered by hand is recorded by the size of each change rather than at every reading. No DOM, no Node.

// A change smaller than this fraction of the parameter's live range (or one step, if that is larger) is not sent.
export const defaultThreshold = 0.01;
// A control that has not moved for this long has come to rest, and the value it rests at is sent even if the change is small.
export const restMilliseconds = 250;
// A centred stick's readings within this distance of its centre read as the centre.
export const defaultDeadZone = 0.08;
// A button or key held down to step a value steps again after this long, and then this often.
export const repeatDelayMilliseconds = 400;
export const repeatIntervalMilliseconds = 100;

const deviceKinds = ['gamepad', 'midi', 'keyboard'];
const curves = ['linear', 'fineMiddle', 'fineLow'];
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const text = (value, limit = 200) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');
const optionalNumber = (value) => (finite(value) ? value : null);

// The live range a parameter's slider has: its own control's minimum, maximum and step, or, where it has none, the value plus and
// minus its own size (taking in zero), in a hundred steps.
export function liveRange(parameter) {
    const value = Number(parameter?.value) || 0;
    const magnitude = Math.max(Math.abs(value), 1);
    const minimum = Number.isFinite(Number(parameter?.control?.minimum))
        ? Number(parameter.control.minimum) : Math.min(0, value - magnitude);
    const maximum = Number.isFinite(Number(parameter?.control?.maximum))
        ? Number(parameter.control.maximum) : Math.max(0, value + magnitude);
    const fallbackStep = Math.max((maximum - minimum) / 100, 0.001);
    const step = Number(parameter?.control?.step) > 0 ? Number(parameter.control.step) : fallbackStep;
    return { minimum, maximum, step };
}

// ---- Controls -------------------------------------------------------------------------------------------------------------------
// A control is what on a device moves: a gamepad's { type: 'axis', index } or { type: 'button', index }; a MIDI controller's
// { type: 'cc', channel, number }, { type: 'note', channel, number } or { type: 'pitch', channel }; a key, { type: 'key', code }, known
// by its physical place (KeyW), or two keys as one control, { type: 'keys', up, down }.

function normalizeControl(kind, raw) {
    if (!raw || typeof raw !== 'object') return null;
    const index = (value, limit) => (Number.isInteger(value) && value >= 0 && value < limit ? value : null);
    if (kind === 'gamepad') {
        if (!['axis', 'button'].includes(raw.type) || index(raw.index, 64) === null) return null;
        return { type: raw.type, index: raw.index };
    }
    if (kind === 'midi') {
        const channel = Number.isInteger(raw.channel) && raw.channel >= 1 && raw.channel <= 16 ? raw.channel : null;
        if (channel === null) return null;
        if (raw.type === 'pitch') return { type: 'pitch', channel };
        if (!['cc', 'note'].includes(raw.type) || index(raw.number, 128) === null) return null;
        return { type: raw.type, channel, number: raw.number };
    }
    if (kind === 'keyboard') {
        const code = (value) => (typeof value === 'string' && /^[A-Za-z0-9]{1,24}$/.test(value) ? value : null);
        if (raw.type === 'key' && code(raw.code)) return { type: 'key', code: raw.code };
        if (raw.type === 'keys' && code(raw.up) && code(raw.down) && raw.up !== raw.down) return { type: 'keys', up: raw.up, down: raw.down };
    }
    return null;
}

// Whether a control gives a position (a stick, a knob, a trigger) rather than a press: a position is mapped across the live range.
export function givesPosition(control, { analogue = false } = {}) {
    return ['axis', 'cc', 'pitch'].includes(control?.type) || (control?.type === 'button' && analogue);
}

// Whether a reading ({ device, control }) comes from the control a binding names. Two keys as one control answer to either key.
export function readingMatches(binding, reading) {
    if (binding.device.kind !== reading.device.kind) return false;
    if (binding.device.kind !== 'keyboard' && binding.device.id !== reading.device.id) return false;
    const bound = binding.control;
    const read = reading.control;
    if (bound.type === 'keys') return read.type === 'key' && (read.code === bound.up || read.code === bound.down);
    return bound.type === read.type && bound.index === read.index && bound.channel === read.channel && bound.number === read.number && bound.code === read.code;
}

const standardAxes = ['Left stick ↔', 'Left stick ↕', 'Right stick ↔', 'Right stick ↕'];
const standardButtons = ['A', 'B', 'X', 'Y', 'Left bumper', 'Right bumper', 'Left trigger', 'Right trigger', 'Back', 'Start',
    'Left stick press', 'Right stick press', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Home'];
const noteNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const keyNames = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Enter: 'Enter', ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Left Alt', AltRight: 'Right Alt', Tab: 'Tab',
    PageUp: 'Page Up', PageDown: 'Page Down', Minus: '−', Equal: '=', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/' };

export function keyName(code) {
    if (keyNames[code]) return keyNames[code];
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter) return letter[1];
    const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
    if (digit) return code.startsWith('Numpad') ? `Numpad ${digit[1]}` : digit[1];
    return code;
}

// What a control is called on its chip: "🎮 Left stick ↕", "🎛 Control 3", "⌨ W / S".
export function controlLabel(device, control) {
    if (device.kind === 'gamepad') {
        const name = control.type === 'axis' ? (standardAxes[control.index] ?? `Axis ${control.index + 1}`) : (standardButtons[control.index] ?? `Button ${control.index + 1}`);
        return `🎮 ${name}`;
    }
    if (device.kind === 'midi') {
        const channel = control.channel === 1 ? '' : ` (channel ${control.channel})`;
        if (control.type === 'pitch') return `🎛 Pitch wheel${channel}`;
        if (control.type === 'note') return `🎛 Pad ${noteNames[control.number % 12]}${Math.floor(control.number / 12) - 1}${channel}`;
        return `🎛 Control ${control.number}${channel}`;
    }
    if (control.type === 'keys') return `⌨ ${keyName(control.up)} / ${keyName(control.down)}`;
    return `⌨ ${keyName(control.code)}`;
}

// ---- Mappings -------------------------------------------------------------------------------------------------------------------
// How a control's reading becomes a value:
//   { kind: 'range', invert, curve, centre }     a position across the live range; a centred stick's centre is the middle of the
//                                                range ('middle') or the value the parameter had when the stick left it ('value')
//   { kind: 'momentary', pressed, released }     one value while held, another when let go (null: the live maximum, the minimum)
//   { kind: 'toggle', on, off }                  each press goes from one to the other (null: the maximum, the minimum)
//   { kind: 'step', amount, repeat }             each press adds `amount` (null: one live step), again and again while held if `repeat`
//   { kind: 'ramp', rate }                       two keys: up and down at `rate` a second while held (null: the range in five seconds)

export function defaultMapping(control, { analogue = false } = {}) {
    if (control.type === 'keys') return { kind: 'ramp', rate: null };
    if (givesPosition(control, { analogue })) return { kind: 'range', invert: false, curve: 'linear', centre: 'middle' };
    return { kind: 'momentary', pressed: null, released: null };
}

function normalizeMapping(raw, control) {
    const fallback = defaultMapping(control, { analogue: raw?.kind === 'range' });
    if (!raw || typeof raw !== 'object') return fallback;
    if (control.type === 'keys') return { kind: 'ramp', rate: finite(raw.rate) && raw.rate > 0 ? raw.rate : null };
    switch (raw.kind) {
    case 'range':
        if (control.type === 'key' || control.type === 'note') return fallback;
        return { kind: 'range', invert: raw.invert === true, curve: curves.includes(raw.curve) ? raw.curve : 'linear', centre: raw.centre === 'value' ? 'value' : 'middle' };
    case 'momentary': return { kind: 'momentary', pressed: optionalNumber(raw.pressed), released: optionalNumber(raw.released) };
    case 'toggle': return { kind: 'toggle', on: optionalNumber(raw.on), off: optionalNumber(raw.off) };
    case 'step': return { kind: 'step', amount: finite(raw.amount) && raw.amount !== 0 ? raw.amount : null, repeat: raw.repeat !== false };
    default: return fallback;
    }
}

// ---- The bindings a person keeps ------------------------------------------------------------------------------------------------
// { version: 1, threshold, bindings: [{ id, label, device: { kind, id, name }, control, centred, parameter: { symbol, name }, model,
// mapping }] }. `model` (a model's name, or null) narrows a binding to one model; `centred` says the control reads −1 to 1.

export function normalizeInputBindings(raw) {
    const threshold = finite(raw?.threshold) && raw.threshold > 0 && raw.threshold <= 0.5 ? raw.threshold : defaultThreshold;
    const seen = new Set();
    const bindings = (Array.isArray(raw?.bindings) ? raw.bindings : []).flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const id = text(entry.id, 64);
        const kind = entry.device?.kind;
        const symbol = text(entry.parameter?.symbol, 120);
        if (!id || seen.has(id) || !deviceKinds.includes(kind) || !symbol) return [];
        const control = normalizeControl(kind, entry.control);
        if (!control) return [];
        const deviceId = kind === 'keyboard' ? 'keyboard' : text(entry.device.id, 300);
        if (!deviceId) return [];
        seen.add(id);
        return [{
            id, label: text(entry.label, 80),
            device: { kind, id: deviceId, name: kind === 'keyboard' ? 'Keyboard' : (text(entry.device.name, 200) || deviceId) },
            control, centred: control.type === 'axis' || control.type === 'pitch' ? entry.centred !== false : false,
            parameter: { symbol, name: text(entry.parameter.name, 200) || symbol },
            model: text(entry.model, 200) || null,
            mapping: normalizeMapping(entry.mapping, control)
        }];
    });
    return { version: 1, threshold, bindings };
}

// A new binding of `control` on `device` to `parameter` ({ symbol, name }). `analogue`: a gamepad button that gave a value between
// 0 and 1 (a trigger), which is mapped as a position.
export function createBinding({ id, device, control, centred = false, analogue = false, parameter }) {
    return normalizeInputBindings({ bindings: [{ id, device, control, centred, parameter, mapping: defaultMapping(control, { analogue }) }] }).bindings[0] ?? null;
}

// The bindings that drive a parameter of `symbol` in the model called `modelName`: those narrowed to this model, then the rest.
export function bindingsForSymbol(bindings, symbol, modelName) {
    return bindings.filter((binding) => binding.parameter.symbol === symbol && (binding.model === null || binding.model === modelName));
}

// Whether a binding has a parameter to drive among `targets` ([{ symbol }]) in the model called `modelName`.
export function bindingTarget(binding, targets, modelName) {
    if (binding.model !== null && binding.model !== modelName) return null;
    return targets.find((target) => target.symbol === binding.parameter.symbol) ?? null;
}

// What a binding's chip says: its own name, or the control's.
export const bindingLabel = (binding) => binding.label || controlLabel(binding.device, binding.control);

// ---- From reading to value ------------------------------------------------------------------------------------------------------

// A value held to the live range and put on its steps, as the slider would have it.
export function onSteps(value, { minimum, maximum, step }) {
    const held = Math.min(maximum, Math.max(minimum, value));
    const stepped = step > 0 ? minimum + Math.round((held - minimum) / step) * step : held;
    return Math.min(maximum, Math.max(minimum, Number(stepped.toPrecision(12))));
}

const curved = (fraction, curve) => {
    if (curve === 'fineLow') return fraction * fraction;
    if (curve === 'fineMiddle') {
        const offset = fraction - 0.5;
        return 0.5 + Math.sign(offset) * (2 * offset) ** 2 / 2;
    }
    return fraction;
};

// A stick's reading with its dead zone taken out: the centre within `deadZone`, and the rest stretched to reach ±1 again.
export function withoutDeadZone(value, deadZone = defaultDeadZone) {
    const size = Math.abs(value);
    if (size <= deadZone) return 0;
    return Math.sign(value) * Math.min(1, (size - deadZone) / (1 - deadZone));
}

// Turns one binding's readings into values. `reading(reading, now, current)` answers the value the reading gives, or null when it
// gives none; `tick(now, current)` the value a held key or button has reached (a ramp, or a step repeated), or null. `current` is the
// parameter's value as it now is. A reading is { value, pressed }: a position 0 to 1 (−1 to 1 when centred), or a press and release.
export function createBindingDriver(binding, range) {
    const mapping = binding.mapping;
    const span = range.maximum - range.minimum;
    let origin = null;
    const held = new Set();
    let holdStarted = 0;
    let lastRepeat = 0;
    let lastTick = 0;
    let toggled = null;
    const pressedValue = (value, fallback) => onSteps(value ?? fallback, range);
    return {
        get holding() { return held.size > 0; },
        reading(reading, now, current) {
            if (mapping.kind === 'range') {
                let value = reading.value;
                if (binding.centred) {
                    if (mapping.invert) value = -value;
                    if (mapping.centre === 'value') {
                        if (value === 0) { const back = origin; origin = null; return back === null ? null : onSteps(back, range); }
                        origin ??= current;
                        // How far from its centre the stick is, finer near the centre with a curve; it reaches the end of the range
                        // on its side at full travel.
                        const distance = mapping.curve === 'linear' ? Math.abs(value) : value * value;
                        return onSteps(value > 0 ? origin + distance * (range.maximum - origin) : origin - distance * (origin - range.minimum), range);
                    }
                    return onSteps(range.minimum + curved((value + 1) / 2, mapping.curve) * span, range);
                }
                if (mapping.invert) value = 1 - value;
                return onSteps(range.minimum + curved(Math.min(1, Math.max(0, value)), mapping.curve) * span, range);
            }
            const key = reading.control?.code ?? 'press';
            if (!reading.pressed) {
                held.delete(key);
                if (mapping.kind === 'momentary' && !held.size) return pressedValue(mapping.released, range.minimum);
                return null;
            }
            if (held.has(key)) return null;
            held.add(key);
            holdStarted = now;
            lastRepeat = now;
            lastTick = now;
            switch (mapping.kind) {
            case 'momentary': return pressedValue(mapping.pressed, range.maximum);
            case 'toggle': {
                const on = pressedValue(mapping.on, range.maximum);
                const off = pressedValue(mapping.off, range.minimum);
                toggled = toggled === null ? Math.abs(current - on) > Math.abs(current - off) : !toggled;
                return toggled ? on : off;
            }
            case 'step': return onSteps(current + (mapping.amount ?? range.step), range);
            default: return null;
            }
        },
        tick(now, current) {
            if (!held.size) return null;
            if (mapping.kind === 'ramp') {
                const elapsed = Math.max(0, now - lastTick) / 1000;
                lastTick = now;
                const direction = (held.has(binding.control.up) ? 1 : 0) - (held.has(binding.control.down) ? 1 : 0);
                if (!direction || !elapsed) return null;
                const rate = mapping.rate ?? span / 5;
                // Unstepped while it ramps, so a slow ramp is not held back by rounding; put on the steps once it is let go.
                return Math.min(range.maximum, Math.max(range.minimum, current + direction * rate * elapsed));
            }
            if (mapping.kind === 'step' && mapping.repeat && now - holdStarted >= repeatDelayMilliseconds && now - lastRepeat >= repeatIntervalMilliseconds) {
                lastRepeat = now;
                return onSteps(current + (mapping.amount ?? range.step), range);
            }
            return null;
        },
        // A held key's ramp ends on a step.
        released(current) { return mapping.kind === 'ramp' && !held.size ? onSteps(current, range) : null; },
        reset() { held.clear(); origin = null; }
    };
}

// ---- When a value is worth sending ------------------------------------------------------------------------------------------------

// The smallest change that is sent: the threshold's share of the live range, or one step, whichever is larger.
export const smallestChange = (range, threshold = defaultThreshold) => Math.max(threshold * (range.maximum - range.minimum), range.step > 0 ? range.step : 0);

// Decides which of a moving control's values are sent, so the record holds each change that mattered and the value the control came
// to rest at, not every reading. `offer(value, now)` answers the value to send now, or null; `settle(now)` the value to send once the
// control has rested `restMilliseconds`, or null; `sent(value)` tells it of a value sent another way (a press, always sent).
export function createChangeRecorder(range, { threshold = defaultThreshold, lastSent = null } = {}) {
    const smallest = smallestChange(range, threshold);
    let last = lastSent;
    let pending = null;
    let movedAt = 0;
    return {
        offer(value, now) {
            movedAt = now;
            if (last === null || Math.abs(value - last) >= smallest - 1e-12) {
                last = value;
                pending = null;
                return value;
            }
            pending = value === last ? null : value;
            return null;
        },
        settle(now) {
            if (pending === null || now - movedAt < restMilliseconds) return null;
            const value = pending;
            last = value;
            pending = null;
            return value;
        },
        sent(value) { last = value; pending = null; },
        get waiting() { return pending !== null; }
    };
}
