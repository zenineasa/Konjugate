/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The "Copy details for a bug report" text on the Welcome window: what a report on GitHub needs so
// that it does not start with "which version, and on what?". Plain strings in, plain text out.

const installLabels = {
    store: 'Microsoft Store',
    homebrew: 'Homebrew',
    appimage: 'AppImage',
    other: 'an installer, a DMG, winget, Chocolatey or a build from source'
};
const platformNames = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const known = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : 'unknown');

export function formatBugReportDetails({ version, source, platform, arch, osRelease, electron, chromium } = {}) {
    return [
        `Konjugate: ${known(version)}`,
        `Installed from: ${installLabels[source] ?? 'unknown'}`,
        `Operating system: ${platformNames[platform] ?? known(platform)} ${known(osRelease)} (${known(arch)})`,
        `Electron: ${known(electron)} (Chromium ${known(chromium)})`
    ].join('\n');
}
