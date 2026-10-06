/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
    checkIntervalMs,
    fetchLatestRelease,
    hasInstallerFor,
    homebrewCaskroomCandidates,
    installSource,
    isCheckDue,
    isHomebrewCask,
    isNewerVersion,
    retryThrottleMs,
    shellQuote,
    shouldCheckForUpdates,
    shouldShowBadge,
    updateCommand
} from '../src/updateCheck.mjs';
import { allReleasesUrl, describeCheckedAt, describeUpdateStatus } from '../src/updatePanel.mjs';

function release(tag, assetNames, url = `https://github.com/zenineasa/Konjugate/releases/tag/${tag}`) {
    return { tag_name: tag, html_url: url, assets: assetNames.map((name) => ({ name })) };
}
function fakeFetch(body, { ok = true, status = 200 } = {}) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return { ok, status, json: async () => body };
    };
    return Object.assign(fetchImpl, { calls });
}
const allPlatforms = ['Konjugate-1.2.0-arm64.dmg', 'Konjugate-1.2.0-x64-setup.exe', 'Konjugate-1.2.0-x86_64.AppImage', 'Konjugate-1.2.0-x86_64.AppImage.zsync'];

// ---- The request

test('the check asks GitHub\'s latest-release endpoint and never anything else', async () => {
    const fetchImpl = fakeFetch(release('v1.2.0', allPlatforms));
    await fetchLatestRelease({ fetchImpl });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, 'https://api.github.com/repos/zenineasa/Konjugate/releases/latest');
    assert.match(fetchImpl.calls[0].options.headers.Accept, /github/);
    assert.ok(fetchImpl.calls[0].options.signal, 'the request has a timeout, so a hung connection cannot hold the check forever');
});

// ---- Where this copy was installed from
//
// Every installSource call below passes `homebrew` explicitly: its default looks at the real
// machine's Homebrew, and a test must not depend on whether the developer running it has the cask.

const nothingElse = { windowsStore: undefined, appImagePath: undefined, homebrew: false };

test('installSource: Microsoft Store builds are recognised, and only on Windows', () => {
    assert.equal(installSource({ ...nothingElse, platform: 'win32', windowsStore: true }), 'store');
    assert.equal(installSource({ ...nothingElse, platform: 'win32', windowsStore: false }), 'other');
    assert.equal(installSource({ ...nothingElse, platform: 'win32' }), 'other');
    // The flag means nothing off Windows.
    assert.equal(installSource({ ...nothingElse, platform: 'darwin', windowsStore: true }), 'other');
    assert.equal(installSource({ ...nothingElse, platform: 'linux', windowsStore: true }), 'other');
});

test('installSource: an AppImage is recognised by the path the runtime sets, and only on Linux', () => {
    assert.equal(installSource({ ...nothingElse, platform: 'linux', appImagePath: '/home/me/Konjugate-1.2.0-x86_64.AppImage' }), 'appimage');
    assert.equal(installSource({ ...nothingElse, platform: 'linux', appImagePath: '' }), 'other');
    assert.equal(installSource({ ...nothingElse, platform: 'linux' }), 'other');
    assert.equal(installSource({ ...nothingElse, platform: 'darwin', appImagePath: '/x.AppImage' }), 'other');
    assert.equal(installSource({ ...nothingElse, platform: 'win32', appImagePath: '/x.AppImage' }), 'other');
});

test('installSource: a Homebrew cask is recognised on macOS and Linux, and wins over the AppImage it also is', () => {
    assert.equal(installSource({ ...nothingElse, platform: 'darwin', homebrew: true }), 'homebrew');
    assert.equal(installSource({ ...nothingElse, platform: 'linux', homebrew: true }), 'homebrew');
    // A Linux cask install runs as an AppImage too, but `brew upgrade` is the right way to update it.
    assert.equal(installSource({ ...nothingElse, platform: 'linux', homebrew: true, appImagePath: '/home/linuxbrew/.linuxbrew/Caskroom/konjugate/1.2.0/K.AppImage' }), 'homebrew');
    assert.equal(installSource({ ...nothingElse, platform: 'win32', homebrew: true }), 'other');
});

test('installSource: a Store build wins over everything else that might be set', () => {
    assert.equal(installSource({ platform: 'win32', windowsStore: true, appImagePath: '/x.AppImage', homebrew: true }), 'store');
});

test('installSource reads the real process by default and never throws', () => {
    assert.ok(['store', 'homebrew', 'appimage', 'other'].includes(installSource()));
});

test('only Store installs skip the update check', () => {
    assert.equal(shouldCheckForUpdates('store'), false);
    for (const source of ['homebrew', 'appimage', 'other']) assert.equal(shouldCheckForUpdates(source), true, source);
});

// ---- Finding Homebrew's cask folder

test('the Caskroom locations checked are the standard ones for each platform, plus HOMEBREW_PREFIX when set', () => {
    assert.deepEqual(homebrewCaskroomCandidates({ platform: 'darwin', home: '/Users/me', env: {} }),
        ['/opt/homebrew/Caskroom/konjugate', '/usr/local/Caskroom/konjugate']);
    assert.deepEqual(homebrewCaskroomCandidates({ platform: 'linux', home: '/home/me', env: {} }),
        ['/home/linuxbrew/.linuxbrew/Caskroom/konjugate', '/home/me/.linuxbrew/Caskroom/konjugate']);
    assert.deepEqual(homebrewCaskroomCandidates({ platform: 'win32', home: 'C:\\Users\\me', env: {} }), []);
    assert.deepEqual(homebrewCaskroomCandidates({ platform: 'darwin', home: '/Users/me', env: { HOMEBREW_PREFIX: '/custom/brew' } })[0], '/custom/brew/Caskroom/konjugate');
});

test('isHomebrewCask is true only when one of those folders exists', () => {
    const only = (path) => (candidate) => candidate === path;
    assert.equal(isHomebrewCask({ platform: 'darwin', home: '/Users/me', env: {}, exists: only('/opt/homebrew/Caskroom/konjugate') }), true);
    assert.equal(isHomebrewCask({ platform: 'darwin', home: '/Users/me', env: {}, exists: only('/usr/local/Caskroom/konjugate') }), true);
    assert.equal(isHomebrewCask({ platform: 'linux', home: '/home/me', env: {}, exists: only('/home/me/.linuxbrew/Caskroom/konjugate') }), true);
    assert.equal(isHomebrewCask({ platform: 'darwin', home: '/Users/me', env: {}, exists: () => false }), false);
    // A Caskroom for some other app, or Homebrew's own folder, is not Konjugate's.
    assert.equal(isHomebrewCask({ platform: 'darwin', home: '/Users/me', env: {}, exists: only('/opt/homebrew/Caskroom/other') }), false);
    // Nothing is even looked at where there are no Homebrew casks.
    assert.equal(isHomebrewCask({ platform: 'win32', exists: () => true }), false);
});

test('isHomebrewCask treats a filesystem error as "not Homebrew" instead of failing the update check', () => {
    assert.equal(isHomebrewCask({ platform: 'darwin', home: '/Users/me', env: {}, exists: () => { throw new Error('EACCES'); } }), false);
    assert.doesNotThrow(() => isHomebrewCask());
});

// ---- The command shown for each source

test('updateCommand: Homebrew gets brew upgrade, an AppImage gets its updater on its own path, everything else none', () => {
    assert.equal(updateCommand('homebrew'), 'brew upgrade --cask konjugate');
    assert.equal(updateCommand('appimage', { appImagePath: '/home/me/Konjugate-1.2.0-x86_64.AppImage' }), "appimageupdatetool '/home/me/Konjugate-1.2.0-x86_64.AppImage'");
    assert.equal(updateCommand('appimage', {}), null);
    assert.equal(updateCommand('appimage', { appImagePath: '' }), null);
    assert.equal(updateCommand('store'), null);
    assert.equal(updateCommand('other'), null);
});

test('shellQuote: a path always reaches a real shell as exactly one literal word', { skip: process.platform === 'win32' }, () => {
    const paths = ['/home/me/Konjugate.AppImage', '/home/me/My Apps/Konjugate.AppImage', "/home/me/it's here/K.AppImage", '/home/me/$HOME/K.AppImage',
        '/home/me/`id`/K.AppImage', '/home/me/a"b/K.AppImage', '/home/me/a\\b/K.AppImage', '/home/me/semi;colon && rm -rf x/K.AppImage', '/home/me/ünï/K.AppImage'];
    for (const path of paths) {
        const echoed = execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(path)}`], { encoding: 'utf8' });
        assert.equal(echoed, path, path);
    }
});

// ---- Reading the release

test('isNewerVersion compares number by number and refuses what it cannot read', () => {
    assert.equal(isNewerVersion('1.2.0', '1.1.8'), true);
    assert.equal(isNewerVersion('v1.2.0', '1.1.8'), true);
    assert.equal(isNewerVersion('1.10.0', '1.9.9'), true);
    assert.equal(isNewerVersion('1.9.9', '1.10.0'), false);
    assert.equal(isNewerVersion('1.1.8', '1.1.8'), false);
    assert.equal(isNewerVersion('1.1.7', '1.1.8'), false);
    for (const unreadable of [null, undefined, '', 'nightly', '1.2']) {
        assert.equal(isNewerVersion(unreadable, '1.1.8'), false, String(unreadable));
        assert.equal(isNewerVersion('1.2.0', unreadable), false, String(unreadable));
    }
});

test('fetchLatestRelease reports the version, page and asset names, and throws on a bad status', async () => {
    const fetchImpl = fakeFetch(release('v1.2.0', allPlatforms));
    assert.deepEqual(await fetchLatestRelease({ fetchImpl }), {
        version: '1.2.0', url: 'https://github.com/zenineasa/Konjugate/releases/tag/v1.2.0', assetNames: allPlatforms
    });
    assert.deepEqual(await fetchLatestRelease({ fetchImpl: fakeFetch({ html_url: 'x' }) }), { version: null, url: 'x', assetNames: [] });
    await assert.rejects(() => fetchLatestRelease({ fetchImpl: fakeFetch({}, { ok: false, status: 500 }) }), /500/);
});

test('hasInstallerFor wants this platform\'s installer, and the .zsync is not one', () => {
    const everything = { assetNames: allPlatforms };
    assert.equal(hasInstallerFor(everything, 'darwin'), true);
    assert.equal(hasInstallerFor(everything, 'win32'), true);
    assert.equal(hasInstallerFor(everything, 'linux'), true);
    assert.equal(hasInstallerFor({ assetNames: ['Konjugate-1.2.0-x86_64.AppImage.zsync'] }, 'linux'), false);
    assert.equal(hasInstallerFor({ assetNames: [] }, 'darwin'), false);
    assert.equal(hasInstallerFor(everything, 'freebsd'), false);
});

// ---- When to check

const hour = 60 * 60 * 1000;

test('a first check is always due', () => {
    assert.equal(isCheckDue({ now: 1_000_000 }), true);
    assert.equal(isCheckDue({ now: 1_000_000, lastSuccess: null, lastAttempt: null }), true);
});

test('a check is due once the last success is a day old, and not before', () => {
    const lastSuccess = 10 * hour;
    assert.equal(isCheckDue({ now: lastSuccess + 24 * hour - 1, lastSuccess, lastAttempt: lastSuccess }), false);
    assert.equal(isCheckDue({ now: lastSuccess + 24 * hour, lastSuccess, lastAttempt: lastSuccess }), true);
    assert.equal(isCheckDue({ now: lastSuccess + 100 * hour, lastSuccess, lastAttempt: lastSuccess }), true);
    assert.equal(checkIntervalMs, 24 * hour);
});

test('a failed check does not count as a success, but is not retried more than every fifteen minutes', () => {
    const lastSuccess = 0;
    const lastAttempt = 30 * hour; // a day and a half after the last success, an attempt that failed
    assert.equal(isCheckDue({ now: lastAttempt + retryThrottleMs - 1, lastSuccess, lastAttempt }), false);
    assert.equal(isCheckDue({ now: lastAttempt + retryThrottleMs, lastSuccess, lastAttempt }), true);
    // Never succeeded at all: still throttled after an attempt, due again once the throttle passes.
    assert.equal(isCheckDue({ now: 5 * 60 * 1000, lastSuccess: null, lastAttempt: 0 }), false);
    assert.equal(isCheckDue({ now: retryThrottleMs, lastSuccess: null, lastAttempt: 0 }), true);
    assert.equal(retryThrottleMs, 15 * 60 * 1000);
});

test('the throttle applies even to a recent success that is somehow overdue', () => {
    // Defensive: an attempt moments ago blocks a new one regardless of the success time.
    assert.equal(isCheckDue({ now: 100 * hour, lastSuccess: 0, lastAttempt: 100 * hour - 1000 }), false);
});

// ---- When the badge shows

test('the badge shows for a newer version that was not skipped, and a newer one than the skipped returns it', () => {
    const latest = { version: '1.2.0', url: 'u' };
    assert.equal(shouldShowBadge({ latest, running: '1.1.8', skipped: null }), true);
    assert.equal(shouldShowBadge({ latest, running: '1.1.8' }), true);
    assert.equal(shouldShowBadge({ latest, running: '1.1.8', skipped: '1.2.0' }), false);
    assert.equal(shouldShowBadge({ latest: { version: '1.2.1', url: 'u' }, running: '1.1.8', skipped: '1.2.0' }), true);
    assert.equal(shouldShowBadge({ latest, running: '1.1.8', skipped: '1.1.9' }), true, 'skipping an older version says nothing about this one');
});

test('no badge when there is nothing newer, whatever was skipped', () => {
    assert.equal(shouldShowBadge({ latest: null, running: '1.1.8' }), false);
    assert.equal(shouldShowBadge({ latest: { version: '1.1.8', url: 'u' }, running: '1.1.8' }), false);
    assert.equal(shouldShowBadge({ latest: { version: '1.1.7', url: 'u' }, running: '1.1.8' }), false);
    assert.equal(shouldShowBadge({ latest: { version: 'nightly', url: 'u' }, running: '1.1.8' }), false);
});

// ---- What the Updates section shows

const availableStatus = (overrides = {}) => ({
    source: 'other', running: '1.1.8', state: 'available', latest: { version: '1.2.0', url: 'https://example.test/release' },
    skipped: false, badge: true, command: null, checkedAt: 1, lastAttemptFailed: false, error: null, ...overrides
});
const actionLabels = (model) => model.actions.map((action) => action.label);

test('a Store install is told the Store handles updates, with no actions', () => {
    const model = describeUpdateStatus({ source: 'store', running: '1.1.8', state: 'managedByStore', latest: null, lastAttemptFailed: false, error: null });
    assert.match(model.headline, /Microsoft Store/);
    assert.deepEqual(model.actions, []);
    assert.equal(model.canCheck, false, 'a Store install makes no request, so the button would do nothing');
    assert.deepEqual(model.links, [{ label: 'All releases', url: allReleasesUrl }]);
});

test('up to date names the running version', () => {
    const model = describeUpdateStatus({ source: 'other', running: '1.1.8', state: 'upToDate', latest: null, lastAttemptFailed: false, error: null });
    assert.equal(model.headline, 'Konjugate 1.1.8 is up to date.');
    assert.equal(model.notice, null);
    assert.equal(model.canCheck, true);
});

test('a background failure after a good answer keeps the answer and says the last check failed', () => {
    const model = describeUpdateStatus({ source: 'other', running: '1.1.8', state: 'upToDate', latest: null, lastAttemptFailed: true, error: 'GitHub returned 403' });
    assert.equal(model.headline, 'Konjugate 1.1.8 is up to date.');
    assert.match(model.notice, /last check failed \(GitHub returned 403\)/);
});

test('with no answer yet, the failure is the headline and the success path is invited', () => {
    assert.match(describeUpdateStatus({ source: 'other', running: '1.1.8', state: 'unknown', latest: null, lastAttemptFailed: true, error: 'fetch failed' }).headline, /Couldn't check/);
    assert.equal(describeUpdateStatus({ source: 'other', running: '1.1.8', state: 'unknown', latest: null, lastAttemptFailed: true, error: 'fetch failed' }).detail, 'fetch failed');
    const neverChecked = describeUpdateStatus({ source: 'other', running: '1.1.8', state: 'unknown', latest: null, lastAttemptFailed: false, error: null });
    assert.match(neverChecked.headline, /hasn't checked/);
    assert.match(neverChecked.detail, /Check for updates/);
});

test('available, Homebrew: the brew command, what is new, the lag note, and skip', () => {
    const model = describeUpdateStatus(availableStatus({ source: 'homebrew', command: 'brew upgrade --cask konjugate' }));
    assert.equal(model.headline, 'Konjugate 1.2.0 is available.');
    assert.deepEqual(actionLabels(model), ['Copy Command', "What's new", 'Skip this version']);
    assert.equal(model.actions[0].command, 'brew upgrade --cask konjugate');
    assert.equal(model.actions[1].url, 'https://example.test/release');
    assert.equal(model.actions[1].secondary, true, 'the command is the action; the release page is the extra');
    assert.match(model.hint, /few minutes/);
});

test('available, AppImage: the updater command, a download, and the note that the tool is separate', () => {
    const model = describeUpdateStatus(availableStatus({ source: 'appimage', command: "appimageupdatetool '/home/me/K.AppImage'" }));
    assert.deepEqual(actionLabels(model), ['Copy Command', 'Download the new AppImage', 'Skip this version']);
    assert.match(model.hint, /separate download/);
    assert.match(model.hint, /Gear Lever/);
    assert.equal(model.actions[1].secondary, true, 'the download is the alternative to the command');
    // No known path, no command: the download is still there.
    const noCommand = describeUpdateStatus(availableStatus({ source: 'appimage', command: null }));
    assert.deepEqual(actionLabels(noCommand), ['Download the new AppImage', 'Skip this version']);
    assert.equal(noCommand.actions[0].secondary, false, 'with no command, the download is the main action');
});

test('available, anything else: a plain download, and the winget/Chocolatey hint instead of a primary action', () => {
    const model = describeUpdateStatus(availableStatus());
    assert.deepEqual(actionLabels(model), ['Download 1.2.0', 'Skip this version']);
    assert.equal(model.actions[0].url, 'https://example.test/release');
    assert.ok(!model.actions[0].secondary, 'the download is the main action here');
    assert.match(model.hint, /winget upgrade Konjugate\.Konjugate/);
    assert.match(model.hint, /choco upgrade konjugate/);
    assert.match(model.hint, /few days/);
});

test('a skipped version offers no skip button and says it will not be flagged', () => {
    const model = describeUpdateStatus(availableStatus({ skipped: true, badge: false }));
    assert.deepEqual(actionLabels(model), ['Download 1.2.0']);
    assert.match(model.detail, /skipped this version/);
});

test('every state offers the all-releases link', () => {
    for (const status of [availableStatus(), { source: 'store', running: '1', state: 'managedByStore' }, { source: 'other', running: '1', state: 'upToDate' }, { source: 'other', running: '1', state: 'unknown' }]) {
        assert.deepEqual(describeUpdateStatus(status).links, [{ label: 'All releases', url: 'https://github.com/zenineasa/Konjugate/releases' }], status.state);
    }
});

test('describeCheckedAt says how long ago, in the units a person would use', () => {
    const now = 1_000_000_000_000;
    assert.equal(describeCheckedAt(null, now), null);
    assert.equal(describeCheckedAt(undefined, now), null);
    assert.equal(describeCheckedAt(now, now), 'Checked just now.');
    assert.equal(describeCheckedAt(now - 59_000, now), 'Checked just now.');
    assert.equal(describeCheckedAt(now - 60_000, now), 'Checked 1 minute ago.');
    assert.equal(describeCheckedAt(now - 5 * 60_000, now), 'Checked 5 minutes ago.');
    assert.equal(describeCheckedAt(now - 60 * 60_000, now), 'Checked 1 hour ago.');
    assert.equal(describeCheckedAt(now - 23 * 3_600_000, now), 'Checked 23 hours ago.');
    assert.equal(describeCheckedAt(now - 72 * 3_600_000, now), 'Checked 3 days ago.');
    assert.equal(describeCheckedAt(now + 5000, now), 'Checked just now.', 'a clock that moved backwards never reads as the future');
});

test('the display model imports nothing, so the Welcome window (a page without Node) can load it', async () => {
    const source = await readFile(new URL('../src/updatePanel.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^\s*import\s/m);
});
