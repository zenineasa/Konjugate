/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateCoordinator } from '../src/updateCoordinator.mjs';

const hour = 60 * 60 * 1000;
const minute = 60 * 1000;

// A clock the test moves by hand, a GitHub that answers whatever the test last told it to (and counts
// how often it was asked), and a skip store that keeps its value in memory.
function harness({ source = 'other', running = '1.1.8', platform = 'darwin', skipped = null, appImagePath } = {}) {
    const state = {
        time: 1_000_000_000, requests: 0, announcements: [],
        release: { version: running, url: 'https://example.test/release', assetNames: ['Konjugate-x.dmg', 'Konjugate-x-setup.exe', 'Konjugate-x.AppImage'] },
        failure: null, skipped, persisted: []
    };
    const fetchLatest = async () => {
        state.requests += 1;
        if (state.failure) throw new Error(state.failure);
        return state.release;
    };
    const skipStore = { get: async () => state.skipped, set: async (version) => { state.skipped = version; state.persisted.push(version); } };
    const coordinator = createUpdateCoordinator({
        source, running, platform, appImagePath, fetchLatest, skipStore,
        now: () => state.time, onChange: (snapshot) => state.announcements.push(snapshot)
    });
    return { state, coordinator, advance: (ms) => { state.time += ms; }, publish: (version) => { state.release = { ...state.release, version }; } };
}

test('before any check there is no answer and no badge', async () => {
    const { coordinator } = harness();
    const status = await coordinator.init();
    assert.equal(status.state, 'unknown');
    assert.equal(status.badge, false);
    assert.equal(status.latest, null);
    assert.equal(status.checkedAt, null);
});

test('a launch check that finds the same version says up to date, with no badge', async () => {
    const { coordinator, state } = harness();
    await coordinator.init();
    const status = await coordinator.maybeCheck();
    assert.equal(status.state, 'upToDate');
    assert.equal(status.badge, false);
    assert.equal(state.requests, 1);
});

test('a launch check that finds a newer version raises the badge and tells the windows once', async () => {
    const { coordinator, state, publish } = harness();
    await coordinator.init();
    publish('1.2.0');
    const status = await coordinator.maybeCheck();
    assert.equal(status.state, 'available');
    assert.equal(status.badge, true);
    assert.deepEqual(status.latest, { version: '1.2.0', url: 'https://example.test/release' });
    assert.equal(state.announcements.length, 1);
    assert.equal(state.announcements[0].badge, true);
});

test('focus events inside the first day make no request, and the first one after a day does', async () => {
    const { coordinator, state, advance } = harness();
    await coordinator.init();
    await coordinator.maybeCheck();
    for (let focuses = 0; focuses < 5; focuses += 1) {
        advance(hour);
        await coordinator.maybeCheck();
    }
    assert.equal(state.requests, 1, 'five hours in, still the launch answer');
    advance(18 * hour); // 23 hours since the launch check: one hour short
    await coordinator.maybeCheck();
    assert.equal(state.requests, 1, 'not yet a day');
    advance(hour); // exactly 24 hours since the launch check
    await coordinator.maybeCheck();
    assert.equal(state.requests, 2);
    advance(hour);
    await coordinator.maybeCheck();
    assert.equal(state.requests, 2, 'the new success restarts the day');
});

test('an app left open for days picks up a release published meanwhile at the next focus', async () => {
    const { coordinator, advance, publish } = harness();
    await coordinator.init();
    await coordinator.maybeCheck();
    publish('1.2.0');
    advance(3 * 24 * hour);
    const status = await coordinator.maybeCheck();
    assert.equal(status.badge, true);
});

test('a failed launch check leaves "unknown" with the reason, and retries at most every fifteen minutes', async () => {
    const { coordinator, state, advance } = harness();
    await coordinator.init();
    state.failure = 'fetch failed';
    const failed = await coordinator.maybeCheck();
    assert.equal(failed.state, 'unknown');
    assert.equal(failed.lastAttemptFailed, true);
    assert.equal(failed.error, 'fetch failed');
    advance(5 * minute);
    await coordinator.maybeCheck();
    assert.equal(state.requests, 1, 'throttled');
    advance(10 * minute);
    state.failure = null;
    const recovered = await coordinator.maybeCheck();
    assert.equal(state.requests, 2);
    assert.equal(recovered.state, 'upToDate');
    assert.equal(recovered.lastAttemptFailed, false);
});

test('a later failure never takes away what was known: the update stays, flagged as a failed attempt', async () => {
    const { coordinator, state, advance, publish } = harness();
    await coordinator.init();
    publish('1.2.0');
    await coordinator.maybeCheck();
    advance(25 * hour);
    state.failure = 'GitHub returned 403';
    const status = await coordinator.maybeCheck();
    assert.equal(status.state, 'available');
    assert.equal(status.badge, true);
    assert.equal(status.lastAttemptFailed, true);
    assert.equal(status.error, 'GitHub returned 403');
});

test('a release without an installer for this platform is not an update', async () => {
    const { coordinator, state } = harness({ platform: 'linux' });
    await coordinator.init();
    state.release = { version: '1.2.0', url: 'u', assetNames: ['Konjugate-1.2.0-arm64.dmg'] };
    const status = await coordinator.maybeCheck();
    assert.equal(status.state, 'upToDate');
    assert.equal(status.badge, false);
});

test('a Store install never asks GitHub, on launch, on focus or on the button, and never shows a badge', async () => {
    const { coordinator, state, advance, publish } = harness({ source: 'store', platform: 'win32' });
    await coordinator.init();
    publish('9.9.9');
    for (const action of [() => coordinator.maybeCheck(), () => coordinator.checkNow()]) {
        advance(48 * hour);
        const status = await action();
        assert.equal(status.state, 'managedByStore');
        assert.equal(status.badge, false);
    }
    assert.equal(state.requests, 0);
    assert.equal(state.announcements.length, 0);
});

test('skipping hides the badge for that version, remembers it, and a newer version brings it back', async () => {
    const { coordinator, state, advance, publish } = harness();
    await coordinator.init();
    publish('1.2.0');
    await coordinator.maybeCheck();
    const skipped = await coordinator.skip('1.2.0');
    assert.equal(skipped.badge, false);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.state, 'available', 'the update itself is still shown in the Welcome window');
    assert.deepEqual(state.persisted, ['1.2.0']);
    advance(25 * hour);
    publish('1.2.1');
    const newer = await coordinator.maybeCheck();
    assert.equal(newer.badge, true);
    assert.equal(newer.skipped, false);
});

test('a version skipped in an earlier run is honoured from the start', async () => {
    const { coordinator, publish } = harness({ skipped: '1.2.0' });
    await coordinator.init();
    publish('1.2.0');
    const status = await coordinator.maybeCheck();
    assert.equal(status.state, 'available');
    assert.equal(status.badge, false);
    assert.equal(status.skipped, true);
});

test('Check for updates ignores both the schedule and a skipped version', async () => {
    const { coordinator, state, advance, publish } = harness({ skipped: '1.2.0' });
    await coordinator.init();
    publish('1.2.0');
    await coordinator.maybeCheck();
    advance(minute);
    const status = await coordinator.checkNow();
    assert.equal(state.requests, 2, 'asked again a minute later');
    assert.equal(status.latest.version, '1.2.0');
    assert.equal(status.skipped, true, 'the skip is shown, not erased');
});

test('Check for updates reports a failure even when an earlier answer exists', async () => {
    const { coordinator, state } = harness();
    await coordinator.init();
    await coordinator.maybeCheck();
    state.failure = 'offline';
    const status = await coordinator.checkNow();
    assert.equal(status.lastAttemptFailed, true);
    assert.equal(status.error, 'offline');
    assert.equal(status.state, 'upToDate');
});

test('two checks at once make one request', async () => {
    const { coordinator, state } = harness();
    await coordinator.init();
    const [first, second] = await Promise.all([coordinator.maybeCheck(), coordinator.checkNow()]);
    assert.equal(state.requests, 1);
    assert.deepEqual(first, second);
});

test('the windows are told only when the status actually changes', async () => {
    const { coordinator, state, advance, publish } = harness();
    await coordinator.init();
    await coordinator.maybeCheck(); // unknown -> upToDate
    const afterFirst = state.announcements.length;
    advance(minute);
    await coordinator.checkNow(); // same answer, but checkedAt moves, so this one does announce
    advance(minute);
    publish('1.2.0');
    await coordinator.checkNow(); // newer: announces
    assert.ok(state.announcements.length > afterFirst);
    const count = state.announcements.length;
    await coordinator.skip('1.2.0');
    assert.equal(state.announcements.length, count + 1, 'skipping changes the badge');
    await coordinator.skip('1.2.0');
    assert.equal(state.announcements.length, count + 1, 'skipping the same version again changes nothing');
});

test('the status carries the command for the install source, only while an update is available', async () => {
    const homebrew = harness({ source: 'homebrew' });
    await homebrew.coordinator.init();
    assert.equal((await homebrew.coordinator.maybeCheck()).command, null, 'up to date: nothing to run');
    homebrew.advance(25 * hour);
    homebrew.publish('1.2.0');
    assert.equal((await homebrew.coordinator.maybeCheck()).command, 'brew upgrade --cask konjugate');

    const appImage = harness({ source: 'appimage', platform: 'linux', appImagePath: '/home/me/K.AppImage' });
    await appImage.coordinator.init();
    appImage.publish('1.2.0');
    assert.equal((await appImage.coordinator.maybeCheck()).command, "appimageupdatetool '/home/me/K.AppImage'");
});

test('skip needs a version, and a coordinator needs a skip store', async () => {
    const { coordinator } = harness();
    await coordinator.init();
    for (const bad of [undefined, null, '', 42]) await assert.rejects(() => coordinator.skip(bad), /version to skip/, String(bad));
    assert.throws(() => createUpdateCoordinator({ source: 'other', running: '1.1.8' }), /skip store/);
});
