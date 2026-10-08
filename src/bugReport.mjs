/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The "Report a problem" button on the Welcome window opens GitHub's new-issue page with this already
// written: what a report needs so that it does not start with "which version, and on what?". Plain
// strings in, plain text out.

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

// The sections of a report, in order. .github/ISSUE_TEMPLATE/bug_report.md has the same headings for
// someone reporting from the GitHub site; tests/bugReport.test.mjs keeps the two in step. The
// new-issue page's `body` parameter replaces a template's own body, so the app writes the whole body
// itself instead of relying on `template=`.
export const bugReportSections = ['What happened', 'What you expected', 'Steps to reproduce', 'System details'];

export function formatBugReportBody(details) {
    return [
        `## ${bugReportSections[0]}\n\n<!-- Describe the problem. -->`,
        `## ${bugReportSections[1]}`,
        `## ${bugReportSections[2]}\n\n1. `,
        `## ${bugReportSections[3]}\n\n${formatBugReportDetails(details)}`
    ].join('\n\n') + '\n';
}

export function bugReportUrl(newIssueUrl, details) {
    return `${newIssueUrl}?labels=bug&body=${encodeURIComponent(formatBugReportBody(details))}`;
}
