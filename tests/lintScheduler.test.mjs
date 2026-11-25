/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLintScheduler, lintHash, lintTimeoutMessage } from '../src/lintScheduler.mjs';

// A stand-in for a compiler process: it answers when told to, and records being killed. A killed process takes a moment to go, as a real
// one does.
function fakeProcesses() {
    const processes = [];
    let alive = 0;
    let maxAlive = 0;
    const run = (request, signal) => new Promise((resolve, reject) => {
        alive += 1;
        maxAlive = Math.max(maxAlive, alive);
        const process = { request, killed: false, finish: (answer) => { alive -= 1; resolve(answer); } };
        processes.push(process);
        signal.addEventListener('abort', () => {
            process.killed = true;
            setTimeout(() => { alive -= 1; reject(new Error('killed')); }, 5);
        });
    });
    return { processes, run, get alive() { return alive; }, get maxAlive() { return maxAlive; } };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a newer request kills the check running, and waits until it has gone before starting its own', async () => {
    const fake = fakeProcesses();
    const scheduler = createLintScheduler({ run: fake.run, key: (request) => lintHash(request.source) });
    const first = scheduler.schedule({ source: 'a' });
    await tick();
    const second = scheduler.schedule({ source: 'ab' });
    const third = scheduler.schedule({ source: 'abc' });
    assert.deepEqual(await first, { superseded: true });
    assert.deepEqual(await second, { superseded: true });
    await tick();
    assert.equal(fake.processes[0].killed, true);
    assert.equal(fake.processes.length, 2, 'the request superseded while it waited never started a process');
    assert.equal(fake.processes[1].request.source, 'abc');
    fake.processes[1].finish({ valid: true, diagnostics: [] });
    assert.deepEqual(await third, { valid: true, diagnostics: [] });
    assert.equal(fake.maxAlive, 1, 'never two processes at once');
    assert.equal(scheduler.stats.maxActive, 1);
});

test('a check past the time limit is stopped and says it will run again', async () => {
    const fake = fakeProcesses();
    const scheduler = createLintScheduler({ run: fake.run, key: (request) => lintHash(request.source), timeoutMs: 20 });
    const answer = await scheduler.schedule({ source: 'slow' });
    assert.deepEqual(answer, { valid: null, timedOut: true, message: lintTimeoutMessage });
    assert.equal(fake.processes[0].killed, true);
    assert.equal(scheduler.stats.timedOut, 1);
    assert.equal(scheduler.cacheSize, 0, 'a timed-out check is not kept');
});

test('an answer already worked out for the same source starts nothing; the last 32 are kept', async () => {
    let started = 0;
    const scheduler = createLintScheduler({
        run: async (request) => { started += 1; return { valid: request.source !== 'bad', diagnostics: [] }; },
        key: (request) => `${request.compiler}|${lintHash(request.source)}`
    });
    assert.equal((await scheduler.schedule({ source: 'good', compiler: 'clang' })).valid, true);
    assert.equal((await scheduler.schedule({ source: 'bad', compiler: 'clang' })).valid, false);
    assert.equal((await scheduler.schedule({ source: 'good', compiler: 'clang' })).valid, true);
    assert.equal(started, 2);
    assert.equal(scheduler.stats.cacheHits, 1);
    await scheduler.schedule({ source: 'good', compiler: 'gcc' });
    assert.equal(started, 3, 'another compiler is another answer');
    for (let index = 0; index < 40; index += 1) await scheduler.schedule({ source: `s${index}`, compiler: 'clang' });
    assert.equal(scheduler.cacheSize, 32);
    await scheduler.schedule({ source: 's39', compiler: 'clang' });
    assert.equal(started, 43, 'a recent source is still kept');
    await scheduler.schedule({ source: 'good', compiler: 'clang' });
    assert.equal(started, 44, 'an old one has gone');
});

test('a check that fails on its own is reported, not swallowed', async () => {
    const scheduler = createLintScheduler({ run: async () => { throw new Error('no compiler'); } });
    await assert.rejects(scheduler.schedule({ source: 'x' }), /no compiler/);
    assert.equal(scheduler.stats.active, 0);
});

test('the hash tells sources apart and is stable', () => {
    assert.equal(lintHash('abc'), lintHash('abc'));
    assert.notEqual(lintHash('abc'), lintHash('abd'));
    assert.notEqual(lintHash(''), lintHash(' '));
});
