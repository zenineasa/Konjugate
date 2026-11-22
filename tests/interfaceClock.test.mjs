/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window ??= {};
const { clearInterfaceTimer, interfaceNow, setInterfaceTimer } = await import('../src/renderer/interfaceClock.mjs');
const clock = globalThis.window.__debugClock;

test('a stopped interface clock moves only when moved on, firing each timer when its time comes and in order', () => {
    clock.stop();
    try {
        const started = interfaceNow();
        const fired = [];
        setInterfaceTimer(() => fired.push('hold'), 450);
        setInterfaceTimer(() => fired.push('long press'), 600);
        const cancelled = setInterfaceTimer(() => fired.push('cancelled'), 100);
        clearInterfaceTimer(cancelled);
        assert.equal(clock.pending(), 2);
        assert.equal(interfaceNow(), started, 'A stopped clock moved by itself.');

        clock.advance(449);
        assert.deepEqual(fired, [], 'A timer fired before its time.');
        clock.advance(1);
        assert.deepEqual(fired, ['hold']);
        // A timer set while moving on is counted from the time the clock has reached.
        setInterfaceTimer(() => fired.push('later'), 100);
        clock.advance(1000);
        assert.deepEqual(fired, ['hold', 'later', 'long press']);
        assert.equal(interfaceNow(), started + 1450);
        assert.equal(clock.pending(), 0);
    } finally {
        clock.resume();
    }
});

// The failure the test above met about one run in three: stopped at a fractional real time, the clock summed each move onto it,
// and the rounding of those sums left it a hair off where the moves add up to. Stopped here at the real time that run had.
test('a stopped interface clock reaches exactly the times it is moved to, from whatever real time it stopped at', () => {
    const realNow = performance.now;
    performance.now = () => 27.206583;
    try {
        clock.stop();
    } finally {
        performance.now = realNow;
    }
    try {
        const started = interfaceNow();
        const fired = [];
        setInterfaceTimer(() => fired.push('hold'), 450);
        setInterfaceTimer(() => fired.push('long press'), 600);
        clock.advance(449);
        clock.advance(1);
        assert.deepEqual(fired, ['hold'], 'A timer due when the clock got there did not fire.');
        setInterfaceTimer(() => fired.push('later'), 100);
        clock.advance(1000);
        assert.deepEqual(fired, ['hold', 'later', 'long press']);
        assert.equal(interfaceNow(), started + 1450, 'The clock is not where the moves add up to.');
    } finally {
        clock.resume();
    }
});

test('letting the interface clock go hands its waiting timers to the real clock, and they can still be cancelled', async () => {
    clock.stop();
    const fired = [];
    setInterfaceTimer(() => fired.push('kept'), 5);
    const dropped = setInterfaceTimer(() => fired.push('dropped'), 5);
    clock.resume();
    clearInterfaceTimer(dropped);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(fired, ['kept']);
    assert.throws(() => clock.advance(10), /not stopped/);
});

test('an interface clock that is not stopped is the real clock', async () => {
    const before = performance.now();
    assert.ok(interfaceNow() >= before);
    const fired = await new Promise((resolve) => setInterfaceTimer(() => resolve(true), 5));
    assert.equal(fired, true);
});
