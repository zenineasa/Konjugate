/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isNewerVersion } from './versionCompare.mjs';

export { isNewerVersion };

const releasesEndpoint = 'https://api.github.com/repos/zenineasa/Konjugate/releases/latest';

// Matches the installer filenames the Makefile actually produces (see packageMacos/
// packageWindows/packageLinux in the Makefile): *.dmg, *-setup.exe, *.AppImage.
const platformAssetPatterns = {
    darwin: /\.dmg$/i,
    win32: /\.exe$/i,
    linux: /\.AppImage$/i
};

// GitHub's latest release, as { version, url, assetNames }, or a thrown error (no network, a rate
// limit, a bad status). Says nothing about whether it is newer: that is isNewerVersion's job.
export async function fetchLatestRelease({ fetchImpl = fetch } = {}) {
    const response = await fetchImpl(releasesEndpoint, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const release = await response.json();
    return {
        version: typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : null,
        url: release.html_url,
        assetNames: (release.assets ?? []).map((asset) => asset.name)
    };
}

// Whether the release has an installer for this platform. A release can exist a while before every
// platform's build is attached to it, and announcing one with nothing to download helps no one.
export function hasInstallerFor(release, platform = process.platform) {
    const pattern = platformAssetPatterns[platform];
    return pattern ? release.assetNames.some((name) => pattern.test(name)) : false;
}

// ---- Where this copy of Konjugate was installed from, and what to tell the person about updating.
// See docs/updates.md for the reasoning behind each of these.

// Homebrew leaves a folder per installed cask in its Caskroom. These are its standard locations
// (Apple silicon, Intel, Linux), plus HOMEBREW_PREFIX when it is set -- it usually isn't for an app
// launched from Finder, which is why fixed paths are needed at all.
export function homebrewCaskroomCandidates({ platform = process.platform, home = homedir(), env = process.env } = {}) {
    const paths = [];
    if (env.HOMEBREW_PREFIX) paths.push(join(env.HOMEBREW_PREFIX, 'Caskroom', 'konjugate'));
    if (platform === 'darwin') paths.push('/opt/homebrew/Caskroom/konjugate', '/usr/local/Caskroom/konjugate');
    if (platform === 'linux') paths.push('/home/linuxbrew/.linuxbrew/Caskroom/konjugate', join(home, '.linuxbrew', 'Caskroom', 'konjugate'));
    return paths;
}

// Whether `brew install --cask konjugate` installed this machine's copy. Homebrew casks only exist
// for macOS and Linux here, so nothing is checked on other platforms.
export function isHomebrewCask({ platform = process.platform, home, env, exists = existsSync } = {}) {
    if (platform !== 'darwin' && platform !== 'linux') return false;
    return homebrewCaskroomCandidates({ platform, home, env }).some((path) => {
        try {
            return exists(path);
        } catch {
            return false;
        }
    });
}

// How this copy of Konjugate was installed, as far as the app can tell: 'store' (Microsoft Store /
// MSIX), 'homebrew' (a Homebrew cask), 'appimage' (running from an AppImage), or 'other' (an
// installer, a DMG, winget, Chocolatey -- none of which leave anything the app can tell apart). Electron
// sets process.windowsStore for a Store app, and the AppImage runtime sets APPIMAGE to the file it is
// running. Homebrew is checked before the AppImage: a Linux cask install is an AppImage too, but
// `brew upgrade` is the right way to update it.
export function installSource({ platform = process.platform, windowsStore = process.windowsStore, appImagePath = process.env.APPIMAGE, homebrew = isHomebrewCask({ platform }) } = {}) {
    if (platform === 'win32' && Boolean(windowsStore)) return 'store';
    if (Boolean(homebrew) && (platform === 'darwin' || platform === 'linux')) return 'homebrew';
    if (platform === 'linux' && typeof appImagePath === 'string' && appImagePath !== '') return 'appimage';
    return 'other';
}

// Whether the "Update available" notice should be shown at all. A Store install is updated by the
// Store, and the GitHub release it would point at is both too early (the Store certifies for up to
// three business days after the release exists) and the wrong thing to install (a second copy
// alongside the Store one), so it gets no notice and the check does not even make its request.
export function shouldCheckForUpdates(source) {
    return source !== 'store';
}

// POSIX single-quoting, so a path with spaces, quotes, $ or backticks is pasted into a terminal as
// one literal word.
export function shellQuote(text) {
    return `'${String(text).replaceAll("'", "'\\''")}'`;
}

// The command worth putting in front of the person, or null when "View Release" is the right action.
// Homebrew: the only correct way to update a cask. AppImage: AppImageUpdate's command-line tool,
// which reads the update information built into the AppImage (the tool is a separate download, so
// the notice says so).
export function updateCommand(source, { appImagePath } = {}) {
    if (source === 'homebrew') return 'brew upgrade --cask konjugate';
    if (source === 'appimage' && typeof appImagePath === 'string' && appImagePath !== '') return `appimageupdatetool ${shellQuote(appImagePath)}`;
    return null;
}

// ---- When to check, and when to show the badge (docs/updates.md, "When it checks")

export const checkIntervalMs = 24 * 60 * 60 * 1000;
export const retryThrottleMs = 15 * 60 * 1000;

// Whether a check should run now: on the very first call, or when the last SUCCESSFUL check is at
// least a day old -- but never within retryThrottleMs of the last attempt, successful or not, so an
// offline laptop is not retried on every click. Times are milliseconds (Date.now()); null means
// "never".
export function isCheckDue({ now, lastSuccess = null, lastAttempt = null, intervalMs = checkIntervalMs, throttleMs = retryThrottleMs }) {
    if (lastAttempt !== null && now - lastAttempt < throttleMs) return false;
    return lastSuccess === null || now - lastSuccess >= intervalMs;
}

// Whether the title bar badge should show: there is a release newer than the one running that has
// an installer for this platform (the caller only passes such a release as `latest`), and the person
// has not skipped exactly that version. A newer version than the skipped one shows it again.
export function shouldShowBadge({ latest, running, skipped = null }) {
    if (!latest || !isNewerVersion(latest.version, running)) return false;
    return latest.version !== skipped;
}
