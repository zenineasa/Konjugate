/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
    bugReportEmailAddress, bugReportEmailPlaceholder, bugReportSections, bugReportUrl, formatBugReportBody, formatBugReportDetails, formatBugReportEmail, formatBugReportEmailBlock
} from '../src/bugReport.mjs';

test('the details name the version, install source, operating system and Electron', () => {
    assert.equal(formatBugReportDetails({ version: '1.1.8', source: 'store', platform: 'win32', arch: 'x64', osRelease: '10.0.26100', electron: '43.2.0', chromium: '140.0.1' }),
        ['Konjugate: 1.1.8', 'Installed from: Microsoft Store', 'Operating system: Windows 10.0.26100 (x64)', 'Electron: 43.2.0 (Chromium 140.0.1)'].join('\n'));
});

test('every install source and platform has a readable name', () => {
    const base = { version: '1', arch: 'arm64', osRelease: '25.0.0', electron: '1', chromium: '2' };
    assert.match(formatBugReportDetails({ ...base, source: 'homebrew', platform: 'darwin' }), /Installed from: Homebrew\nOperating system: macOS 25\.0\.0 \(arm64\)/);
    assert.match(formatBugReportDetails({ ...base, source: 'appimage', platform: 'linux' }), /Installed from: AppImage\nOperating system: Linux/);
    assert.match(formatBugReportDetails({ ...base, source: 'other', platform: 'win32' }), /an installer, a DMG, Chocolatey or a build from source/);
});

test('anything missing is "unknown", never "undefined" or an exception', () => {
    const text = formatBugReportDetails();
    assert.ok(!/undefined|null/.test(text), text);
    assert.match(text, /Konjugate: unknown/);
    assert.match(text, /Installed from: unknown/);
    assert.match(formatBugReportDetails({ version: '  ', source: 'nonsense', platform: 'plan9' }), /Konjugate: unknown\nInstalled from: unknown\nOperating system: plan9 unknown \(unknown\)/);
});

test('the report body has every section and carries the system details', () => {
    const details = { version: '1.1.8', source: 'store', platform: 'win32', arch: 'x64', osRelease: '10.0.26100', electron: '43.2.0', chromium: '140.0.1' };
    const body = formatBugReportBody(details);
    assert.deepEqual([...body.matchAll(/^## (.+)$/gm)].map((match) => match[1]), bugReportSections);
    assert.ok(body.endsWith(`## System details\n\n${formatBugReportDetails(details)}\n`));
});

test('the URL opens the new-issue page with the whole body encoded in it', () => {
    const details = { version: '1.1.8 & more', source: 'other', platform: 'linux', arch: 'x64', osRelease: '6.1', electron: '1', chromium: '2' };
    const url = new URL(bugReportUrl('https://github.com/zenineasa/Konjugate/issues/new', details));
    assert.equal(url.origin + url.pathname, 'https://github.com/zenineasa/Konjugate/issues/new');
    assert.equal(url.searchParams.get('labels'), 'bug');
    assert.equal(url.searchParams.get('body'), formatBugReportBody(details));
    assert.ok(bugReportUrl('https://github.com/zenineasa/Konjugate/issues/new', {}).length < 2000);
});

test('the GitHub issue template has the same headings as the body the app writes', async () => {
    const template = await readFile(new URL('../.github/ISSUE_TEMPLATE/bug_report.md', import.meta.url), 'utf8');
    assert.deepEqual([...template.matchAll(/^## (.+)$/gm)].map((match) => match[1]), bugReportSections);
});

test('the web edition reports its browser, not an installer or Electron', () => {
    assert.equal(formatBugReportDetails({ version: 'dev', browser: 'Mozilla/5.0 (X11; Linux x86_64)' }), 'Konjugate: dev (web edition)\nBrowser: Mozilla/5.0 (X11; Linux x86_64)');
    assert.equal(formatBugReportDetails({ browser: '' }), 'Konjugate: unknown (web edition)\nBrowser: unknown');
});

const details = { version: '1.2.1', source: 'homebrew', platform: 'darwin', arch: 'arm64', osRelease: '25.0.0', electron: '43.2.0', chromium: '140.0.1' };

test('the email is plain text with every section, in the GitHub report\'s order, and the details in it', () => {
    const { address, subject, body } = formatBugReportEmail(details);
    assert.equal(address, 'info@konjugate.com');
    assert.equal(address, bugReportEmailAddress);
    assert.equal(subject, 'Konjugate problem report (1.2.1)');
    assert.ok(!/#|<!--/.test(body), 'no Markdown headings or HTML comments in an email');
    const positions = bugReportSections.map((heading) => body.indexOf(`${heading}\n`));
    assert.ok(positions.every((position) => position >= 0), body);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.ok(body.endsWith(`System details\n${formatBugReportDetails(details)}\n`));
});

test('an email with no details is still written, and says "unknown" rather than "undefined"', () => {
    const { subject, body } = formatBugReportEmail();
    assert.equal(subject, 'Konjugate problem report (unknown)');
    assert.ok(!/undefined|null/.test(body), body);
});

test('the email starts with a placeholder the dialog can find, under "What happened"', () => {
    assert.ok(formatBugReportEmail(details).body.startsWith(`What happened\n${bugReportEmailPlaceholder}\n`));
});

test('everything is one block: who it goes to, the subject, then the message', () => {
    const email = formatBugReportEmail(details);
    assert.equal(formatBugReportEmailBlock(email), `To: info@konjugate.com\nSubject: Konjugate problem report (1.2.1)\n\n${email.body}`);
});
