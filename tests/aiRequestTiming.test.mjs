/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLatestThrottle, createRequestWatchdog } from '../src/aiRequestTiming.mjs';

test('the watchdog expires after the idle time with no sign of life', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const reasons = [];
    createRequestWatchdog({ idleSeconds: 60, onExpire: (reason) => reasons.push(reason) });
    context.mock.timers.tick(59_000);
    assert.deepEqual(reasons, []);
    context.mock.timers.tick(1_000);
    assert.deepEqual(reasons, ['idle']);
});

test('every sign of life restarts the idle clock, so a model that keeps talking is never cut off', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const reasons = [];
    const watchdog = createRequestWatchdog({ idleSeconds: 60, maximumSeconds: 100_000, onExpire: (reason) => reasons.push(reason) });
    for (let second = 0; second < 600; second += 30) {
        context.mock.timers.tick(30_000);
        watchdog.touch();
    }
    assert.deepEqual(reasons, []);
    context.mock.timers.tick(60_000);
    assert.deepEqual(reasons, ['idle']);
});

test('the maximum ends a request even while it keeps talking', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const reasons = [];
    const watchdog = createRequestWatchdog({ idleSeconds: 60, maximumSeconds: 300, onExpire: (reason) => reasons.push(reason) });
    for (let second = 0; second < 300; second += 30) {
        context.mock.timers.tick(30_000);
        watchdog.touch();
    }
    assert.deepEqual(reasons, ['maximum']);
});

test('a stopped watchdog never expires and ignores later touches', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const reasons = [];
    const watchdog = createRequestWatchdog({ idleSeconds: 10, onExpire: (reason) => reasons.push(reason) });
    watchdog.stop();
    watchdog.touch();
    context.mock.timers.tick(3_600_000);
    assert.deepEqual(reasons, []);
});

test('the throttle sends only the newest value, once per interval, and nothing after stop', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = [];
    const throttle = createLatestThrottle((value) => sent.push(value), 100);
    throttle.push(1);
    throttle.push(2);
    throttle.push(3);
    assert.deepEqual(sent, []);
    context.mock.timers.tick(100);
    assert.deepEqual(sent, [3]);
    throttle.push(4);
    throttle.stop();
    context.mock.timers.tick(500);
    assert.deepEqual(sent, [3]);
});
