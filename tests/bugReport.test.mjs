/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBugReportDetails } from '../src/bugReport.mjs';

test('the details name the version, install source, operating system and Electron', () => {
    assert.equal(formatBugReportDetails({ version: '1.1.8', source: 'store', platform: 'win32', arch: 'x64', osRelease: '10.0.26100', electron: '43.2.0', chromium: '140.0.1' }),
        ['Konjugate: 1.1.8', 'Installed from: Microsoft Store', 'Operating system: Windows 10.0.26100 (x64)', 'Electron: 43.2.0 (Chromium 140.0.1)'].join('\n'));
});

test('every install source and platform has a readable name', () => {
    const base = { version: '1', arch: 'arm64', osRelease: '25.0.0', electron: '1', chromium: '2' };
    assert.match(formatBugReportDetails({ ...base, source: 'homebrew', platform: 'darwin' }), /Installed from: Homebrew\nOperating system: macOS 25\.0\.0 \(arm64\)/);
    assert.match(formatBugReportDetails({ ...base, source: 'appimage', platform: 'linux' }), /Installed from: AppImage\nOperating system: Linux/);
    assert.match(formatBugReportDetails({ ...base, source: 'other', platform: 'win32' }), /an installer, a DMG, winget, Chocolatey or a build from source/);
});

test('anything missing is "unknown", never "undefined" or an exception', () => {
    const text = formatBugReportDetails();
    assert.ok(!/undefined|null/.test(text), text);
    assert.match(text, /Konjugate: unknown/);
    assert.match(text, /Installed from: unknown/);
    assert.match(formatBugReportDetails({ version: '  ', source: 'nonsense', platform: 'plan9' }), /Konjugate: unknown\nInstalled from: unknown\nOperating system: plan9 unknown \(unknown\)/);
});
