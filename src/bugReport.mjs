/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Help & feedback" (the button at the bottom of the left rail, and the Welcome window's button) offers two ways to
// report a problem, both with this already written: what a report needs so that it does not start with "which
// version, and on what?". GitHub's new-issue page gets it as Markdown in the URL; for an email it is plain text the
// person copies, because most people have no mail program set up for a mailto: link to open. Plain strings in,
// plain text out.

const installLabels = {
    store: 'Microsoft Store',
    homebrew: 'Homebrew',
    appimage: 'AppImage',
    other: 'an installer, a DMG, Chocolatey or a build from source'
};
const platformNames = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const known = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : 'unknown');

export function formatBugReportDetails({ version, source, platform, arch, osRelease, electron, chromium, browser } = {}) {
    // The web edition has no installer, operating-system build or Electron to report: its browser says it all.
    if (browser !== undefined) return [`Konjugate: ${known(version)} (web edition)`, `Browser: ${known(browser)}`].join('\n');
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

// ---- By email

export const bugReportEmailAddress = 'info@konjugate.com';
// The line under "What happened" until the person replaces it, so the dialog can select it for them and notice when it is still there.
export const bugReportEmailPlaceholder = '(Describe what went wrong.)';

// The email's subject and plain-text body: the same four sections, in the same order, as the GitHub report.
export function formatBugReportEmail(details) {
    const body = [
        `${bugReportSections[0]}\n${bugReportEmailPlaceholder}`,
        `${bugReportSections[1]}\n`,
        `${bugReportSections[2]}\n1. `,
        `${bugReportSections[3]}\n${formatBugReportDetails(details)}`
    ].join('\n\n') + '\n';
    return { address: bugReportEmailAddress, subject: `Konjugate problem report (${known(details?.version)})`, body };
}

// All of it as one block to paste anywhere: who to send it to, the subject, then the message.
export function formatBugReportEmailBlock({ address, subject, body }) {
    return `To: ${address}\nSubject: ${subject}\n\n${body}`;
}
