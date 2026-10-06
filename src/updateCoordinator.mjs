/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { fetchLatestRelease, hasInstallerFor, isCheckDue, isNewerVersion, shouldCheckForUpdates, shouldShowBadge, updateCommand } from './updateCheck.mjs';

// Holds what the app knows about updates -- the latest release GitHub reported, when it last asked,
// and whether the person skipped that version -- and decides when to ask again. One of these exists
// per app run, in the main process; the windows only ever read its status() and are told when it
// changes (docs/updates.md, "The experience we are building"). Nothing here touches Electron, the
// network or the disk directly: the release fetch, the clock, the skip store and the change callback
// are all passed in, so the schedule is tested with a fake clock.
export function createUpdateCoordinator({
    source, running, platform = process.platform, appImagePath,
    fetchLatest = fetchLatestRelease, skipStore, now = Date.now, onChange = () => {}
}) {
    if (!skipStore) throw new Error('The update coordinator requires a skip store.');
    const command = updateCommand(source, { appImagePath });
    let latest = null; // { version, url } for a release that is newer-or-equal and has an installer here
    let lastSuccess = null;
    let lastAttempt = null;
    let lastError = null;
    let skipped = null;
    let inflight = null;
    let lastAnnounced = null;

    function status() {
        const available = source !== 'store' && latest !== null && isNewerVersion(latest.version, running);
        let state = 'unknown';
        if (source === 'store') state = 'managedByStore';
        else if (available) state = 'available';
        else if (lastSuccess !== null) state = 'upToDate';
        return {
            source,
            running,
            state,
            latest: available ? { version: latest.version, url: latest.url } : null,
            skipped: available && latest.version === skipped,
            badge: available && shouldShowBadge({ latest, running, skipped }),
            command: available ? command : null,
            checkedAt: lastSuccess,
            // The most recent attempt failed. The state above is still what was last known, so a
            // background failure never makes a known update or "up to date" vanish; the window says so.
            lastAttemptFailed: lastError !== null,
            error: lastError
        };
    }

    function announceIfChanged() {
        const snapshot = status();
        const serialized = JSON.stringify(snapshot);
        if (serialized === lastAnnounced) return;
        lastAnnounced = serialized;
        onChange(snapshot);
    }

    function runCheck() {
        if (inflight) return inflight;
        inflight = (async () => {
            lastAttempt = now();
            try {
                const release = await fetchLatest();
                lastSuccess = now();
                lastError = null;
                latest = release?.version && hasInstallerFor(release, platform) ? { version: release.version, url: release.url } : null;
            } catch (error) {
                lastError = error?.message ?? String(error);
            } finally {
                inflight = null;
            }
            announceIfChanged();
            return status();
        })();
        return inflight;
    }

    return {
        status,

        // The skipped version is the only thing read from disk, once, at start.
        async init() {
            skipped = await skipStore.get();
            lastAnnounced = JSON.stringify(status());
            return status();
        },

        // For launch and for a window regaining focus: asks GitHub only if the schedule says it is
        // time (isCheckDue), and never for a Store install, which the Store updates.
        async maybeCheck() {
            if (!shouldCheckForUpdates(source)) return status();
            if (!isCheckDue({ now: now(), lastSuccess, lastAttempt })) return status();
            return runCheck();
        },

        // The "Check for updates" button: ignores the schedule and the skipped version, and the
        // result carries the failure if there was one.
        async checkNow() {
            if (!shouldCheckForUpdates(source)) return status();
            return runCheck();
        },

        async skip(version) {
            if (typeof version !== 'string' || version === '') throw new Error('A version to skip is required.');
            skipped = version;
            await skipStore.set(version);
            announceIfChanged();
            return status();
        }
    };
}
