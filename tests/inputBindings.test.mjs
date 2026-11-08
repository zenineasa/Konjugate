/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    bindingLabel, bindingTarget, bindingsForSymbol, controlLabel, createBinding, createBindingDriver, createChangeRecorder, defaultThreshold,
    liveRange, normalizeInputBindings, onSteps, readingMatches, restMilliseconds, smallestChange, withoutDeadZone
} from '../src/inputBindings.mjs';
import { createInputBindingsStore, inputBindingsFile } from '../src/inputBindingsStore.mjs';
import { recordAsCommands } from '../src/interventionSchedules.mjs';
import { heldUntil } from '../src/parameterSchedule.mjs';

const pad = { kind: 'gamepad', id: 'Pad (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', name: 'Pad' };
const knobs = { kind: 'midi', id: 'Acme|Faders', name: 'Faders' };
const keyboard = { kind: 'keyboard', id: 'keyboard', name: 'Keyboard' };
const heater = { symbol: 'heaterPower', name: 'Heater power' };
const range = { minimum: 0, maximum: 100, step: 0.5 };

test('a live range is the parameter\'s own control, or its value give or take its size', () => {
    assert.deepEqual(liveRange({ value: 3, control: { minimum: -10, maximum: 10, step: 0.1 } }), { minimum: -10, maximum: 10, step: 0.1 });
    assert.deepEqual(liveRange({ value: 3 }), { minimum: 0, maximum: 6, step: 0.06 });
    assert.deepEqual(liveRange({ value: 0 }), { minimum: -1, maximum: 1, step: 0.02 });
});

test('bindings read back clean: unknown devices, controls and duplicates are dropped', () => {
    const document = normalizeInputBindings({
        threshold: 0.001,
        bindings: [
            { id: 'a', device: pad, control: { type: 'axis', index: 1 }, parameter: heater, mapping: { kind: 'range', invert: true, curve: 'fineLow' } },
            { id: 'a', device: pad, control: { type: 'axis', index: 2 }, parameter: heater },
            { id: 'b', device: { kind: 'joystick', id: 'x' }, control: { type: 'axis', index: 0 }, parameter: heater },
            { id: 'c', device: knobs, control: { type: 'cc', channel: 17, number: 3 }, parameter: heater },
            { id: 'd', device: keyboard, control: { type: 'keys', up: 'KeyW', down: 'KeyS' }, parameter: { symbol: 'drive' }, model: 'Robot' },
            { id: 'e', device: knobs, control: { type: 'note', channel: 1, number: 60 }, parameter: heater, mapping: { kind: 'range' } }
        ]
    });
    assert.equal(document.threshold, 0.001);
    assert.deepEqual(document.bindings.map((binding) => binding.id), ['a', 'd', 'e']);
    assert.deepEqual(document.bindings[0].mapping, { kind: 'range', invert: true, curve: 'fineLow', centre: 'middle' });
    assert.equal(document.bindings[0].centred, true, 'A stick axis reads −1 to 1 unless it says otherwise.');
    assert.deepEqual(document.bindings[1].mapping, { kind: 'ramp', rate: null });
    assert.deepEqual(document.bindings[1].parameter, { symbol: 'drive', name: 'drive' });
    assert.equal(document.bindings[1].model, 'Robot');
    assert.deepEqual(document.bindings[2].mapping, { kind: 'momentary', pressed: null, released: null }, 'A pad cannot be mapped as a position.');
    assert.equal(normalizeInputBindings(null).threshold, defaultThreshold);
    assert.equal(normalizeInputBindings({ threshold: 2 }).threshold, defaultThreshold);
});

test('a binding follows a parameter by symbol, in every model or only in the one it is narrowed to', () => {
    const everywhere = createBinding({ id: '1', device: pad, control: { type: 'axis', index: 1 }, centred: true, parameter: heater });
    const narrowed = { ...createBinding({ id: '2', device: knobs, control: { type: 'cc', channel: 1, number: 7 }, parameter: heater }), model: 'House' };
    assert.deepEqual(bindingsForSymbol([everywhere, narrowed], 'heaterPower', 'Lab').map((binding) => binding.id), ['1']);
    assert.deepEqual(bindingsForSymbol([everywhere, narrowed], 'heaterPower', 'House').map((binding) => binding.id), ['1', '2']);
    const targets = [{ symbol: 'heaterPower', key: 7 }];
    assert.equal(bindingTarget(everywhere, targets, 'Lab').key, 7);
    assert.equal(bindingTarget(narrowed, targets, 'Lab'), null);
    assert.equal(bindingTarget(everywhere, [{ symbol: 'other' }], 'Lab'), null, 'A binding whose parameter is not in the model waits.');
});

test('readings are matched to the control that was bound, and labelled as a person knows it', () => {
    const stick = createBinding({ id: '1', device: pad, control: { type: 'axis', index: 1 }, centred: true, parameter: heater });
    assert.ok(readingMatches(stick, { device: pad, control: { type: 'axis', index: 1 } }));
    assert.ok(!readingMatches(stick, { device: pad, control: { type: 'axis', index: 0 } }));
    assert.ok(!readingMatches(stick, { device: { ...pad, id: 'other' }, control: { type: 'axis', index: 1 } }));
    const keys = createBinding({ id: '2', device: keyboard, control: { type: 'keys', up: 'KeyW', down: 'KeyS' }, parameter: heater });
    assert.ok(readingMatches(keys, { device: keyboard, control: { type: 'key', code: 'KeyS' } }));
    assert.ok(!readingMatches(keys, { device: keyboard, control: { type: 'key', code: 'KeyA' } }));
    assert.equal(controlLabel(pad, { type: 'axis', index: 1 }), '🎮 Left stick ↕');
    assert.equal(controlLabel(pad, { type: 'button', index: 7 }), '🎮 Right trigger');
    assert.equal(controlLabel(knobs, { type: 'cc', channel: 1, number: 3 }), '🎛 Control 3');
    assert.equal(controlLabel(knobs, { type: 'note', channel: 2, number: 60 }), '🎛 Pad C4 (channel 2)');
    assert.equal(controlLabel(keyboard, { type: 'keys', up: 'ArrowUp', down: 'ArrowDown' }), '⌨ ↑ / ↓');
    assert.equal(bindingLabel({ ...keys, label: 'Throttle' }), 'Throttle');
});

test('a stick, a knob and a trigger are mapped across the live range, on its steps', () => {
    const stick = createBindingDriver(createBinding({ id: '1', device: pad, control: { type: 'axis', index: 1 }, centred: true, parameter: heater }), range);
    assert.equal(stick.reading({ value: -1 }, 0, 50), 0);
    assert.equal(stick.reading({ value: 0 }, 0, 50), 50);
    assert.equal(stick.reading({ value: 0.333 }, 0, 50), 66.5);
    const knob = createBinding({ id: '2', device: knobs, control: { type: 'cc', channel: 1, number: 3 }, parameter: heater });
    assert.equal(createBindingDriver(knob, range).reading({ value: 0.25 }, 0, 0), 25);
    assert.equal(createBindingDriver({ ...knob, mapping: { ...knob.mapping, invert: true } }, range).reading({ value: 0.25 }, 0, 0), 75);
    assert.equal(createBindingDriver({ ...knob, mapping: { ...knob.mapping, curve: 'fineLow' } }, range).reading({ value: 0.5 }, 0, 0), 25);
    assert.equal(createBindingDriver({ ...knob, mapping: { ...knob.mapping, curve: 'fineMiddle' } }, range).reading({ value: 0.75 }, 0, 0), 62.5);
    assert.equal(onSteps(1000, range), 100, 'A value never leaves the live range.');
    assert.equal(onSteps(0.1 + 0.2, { minimum: 0, maximum: 1, step: 0.1 }), 0.3);
});

test('a centred stick can move the value it had, and goes back to it when let go', () => {
    const binding = createBinding({ id: '1', device: pad, control: { type: 'axis', index: 0 }, centred: true, parameter: heater });
    const driver = createBindingDriver({ ...binding, mapping: { ...binding.mapping, centre: 'value' } }, range);
    assert.equal(driver.reading({ value: 0.5 }, 0, 20), 60);
    assert.equal(driver.reading({ value: -1 }, 10, 60), 0, 'The origin stays where the stick left the centre.');
    assert.equal(driver.reading({ value: 0 }, 20, 0), 20);
    assert.equal(driver.reading({ value: 0 }, 30, 20), null, 'Resting at the centre gives nothing more.');
    assert.equal(withoutDeadZone(0.05), 0);
    assert.equal(withoutDeadZone(-1), -1);
    assert.ok(Math.abs(withoutDeadZone(0.54) - 0.5) < 1e-12);
});

test('buttons and keys: momentary, toggle, a repeating step and a ramp of two keys', () => {
    const button = createBinding({ id: '1', device: pad, control: { type: 'button', index: 0 }, parameter: heater });
    const momentary = createBindingDriver(button, range);
    assert.equal(momentary.reading({ pressed: true }, 0, 0), 100);
    assert.equal(momentary.reading({ pressed: true }, 5, 100), null, 'A press already held is not pressed again.');
    assert.equal(momentary.reading({ pressed: false }, 10, 100), 0);

    const toggle = createBindingDriver({ ...button, mapping: { kind: 'toggle', on: 80, off: 10 } }, range);
    assert.equal(toggle.reading({ pressed: true }, 0, 10), 80);
    toggle.reading({ pressed: false }, 1, 80);
    assert.equal(toggle.reading({ pressed: true }, 2, 80), 10);

    const step = createBindingDriver({ ...button, mapping: { kind: 'step', amount: 2, repeat: true } }, range);
    assert.equal(step.reading({ pressed: true }, 0, 10), 12);
    assert.equal(step.tick(300, 12), null, 'No repeat before the delay.');
    assert.equal(step.tick(400, 12), 14);
    assert.equal(step.tick(450, 14), null);
    assert.equal(step.tick(500, 14), 16);

    const keys = createBindingDriver(createBinding({ id: '2', device: keyboard, control: { type: 'keys', up: 'KeyW', down: 'KeyS' }, parameter: heater }), range);
    assert.equal(keys.reading({ pressed: true, control: { type: 'key', code: 'KeyW' } }, 0, 10), null);
    assert.equal(keys.tick(500, 10), 20, 'The whole range in five seconds: ten in half a second.');
    keys.reading({ pressed: false, control: { type: 'key', code: 'KeyW' } }, 600, 20);
    assert.equal(keys.released(20.2), 20, 'Let go, it ends on a step.');
    assert.equal(keys.tick(700, 20), null);
});

test('a moving control is recorded by the size of each change, and once more where it comes to rest', () => {
    const recorder = createChangeRecorder({ minimum: 0, maximum: 10, step: 0.01 });
    assert.equal(smallestChange({ minimum: 0, maximum: 10, step: 0.01 }), 0.1);
    assert.equal(smallestChange({ minimum: 0, maximum: 10, step: 0.5 }), 0.5, 'One step, when that is larger.');
    assert.equal(recorder.offer(1, 0), 1, 'The first value is always sent.');
    assert.equal(recorder.offer(1.05, 16), null);
    assert.equal(recorder.offer(1.1, 32), 1.1);
    assert.equal(recorder.offer(1.14, 48), null);
    assert.equal(recorder.settle(48 + restMilliseconds - 1), null);
    assert.equal(recorder.settle(48 + restMilliseconds), 1.14, 'Where it rests is sent, however small the change.');
    assert.equal(recorder.settle(1000), null);
    // Sixty readings a second of a slow sweep over a second become about a tenth as many values.
    const sweep = createChangeRecorder({ minimum: 0, maximum: 10, step: 0.01 });
    const sent = Array.from({ length: 60 }, (_, index) => sweep.offer(Number((index * 0.02).toFixed(2)), index * 16)).filter((value) => value !== null);
    assert.ok(sent.length <= 13, `${sent.length} values were sent.`);
    assert.ok(createChangeRecorder(range, { threshold: 0.001 }).offer(0, 0) === 0);
});

test('a run\'s record becomes the commands that repeat it, each held until its time', () => {
    const record = [
        { time: 0, kind: 'value', parameterId: 4, value: 3 },
        { time: 0.25, kind: 'value', parameterId: 4, value: 2.5 },
        { time: 0.25, kind: 'value', parameterId: 4, value: 2.75 },
        { time: 0.75, kind: 'schedule', parameterId: 4, mode: 'ramp', startTime: 0.7, duration: 0.2, targetValue: -3, baseValue: 2.75 }
    ];
    assert.deepEqual(recordAsCommands(record), [
        { type: 'setParameterValue', parameterId: 4, value: 3, applyAt: 0 },
        { type: 'setParameterValue', parameterId: 4, value: 2.5, applyAt: 0.25 },
        { type: 'setParameterValue', parameterId: 4, value: 2.75, applyAt: 0.25 },
        { type: 'scheduleParameterValue', parameterId: 4, schedule: { mode: 'ramp', startTime: 0.7, duration: 0.2, targetValue: -3, baseValue: 2.75 }, applyAt: 0.75 }
    ]);
    assert.deepEqual(recordAsCommands([]), []);
    assert.throws(() => recordAsCommands([...record, { time: 1, kind: 'restart' }]), /continued after it stopped/);
    assert.deepEqual(heldUntil(undefined), {});
    assert.deepEqual(heldUntil(0), {});
    assert.deepEqual(heldUntil(1.5), { applyAt: 1.5 });
    assert.throws(() => heldUntil(-1), /non-negative/);
});

test('the bindings are kept in the user\'s data folder, and a damaged file reads as none', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'konjugateInputBindings-'));
    try {
        const store = createInputBindingsStore({ userData });
        assert.deepEqual(await store.get(), { version: 1, threshold: defaultThreshold, bindings: [] });
        const binding = createBinding({ id: '1', device: pad, control: { type: 'axis', index: 1 }, centred: true, parameter: heater });
        const kept = await store.set({ threshold: 0.005, bindings: [binding, { id: 'broken' }] });
        assert.deepEqual(kept.bindings, [binding]);
        assert.deepEqual(await store.get(), kept);
        assert.deepEqual(JSON.parse(await readFile(inputBindingsFile(userData), 'utf8')), kept);
        await writeFile(inputBindingsFile(userData), '{ not json');
        assert.deepEqual((await store.get()).bindings, []);
    } finally {
        await rm(userData, { recursive: true, force: true });
    }
});
