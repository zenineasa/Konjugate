// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
    changelogDate, changelogFile, controlFile, copyrightFile, debFileName, debianArchitectures, debianVersion, dependencies,
    desktopEntry, lintianOverrides, metainfoFor, wrapDescription, wrapperScript
} from '../scripts/debPackage.mjs';

const metadata = {
    name: 'Konjugate',
    developerName: 'Zenin Easa Panthakkalakath',
    summary: 'Graph-native simulation engine',
    description: ['First paragraph.', 'Second paragraph.'],
    homepage: 'https://example.org/konjugate',
    bugtracker: 'https://example.org/konjugate/issues',
    license: 'MPL-2.0'
};

test('the .deb uses Debian architecture names', () => {
    assert.deepEqual(debianArchitectures, { x64: 'amd64', arm64: 'arm64' });
});

test('versions get a Debian revision, and a prerelease sorts before its release', () => {
    assert.equal(debianVersion('1.4.5'), '1.4.5-1');
    assert.equal(debianVersion('1.4.5', '2'), '1.4.5-2');
    assert.equal(debianVersion('1.5.0-beta.1'), '1.5.0~beta.1-1');
    assert.throws(() => debianVersion('latest'), /not one a \.deb version/);
    assert.throws(() => debianVersion('1.4.5', 'a b'), /Debian revision/);
});

test('the file name follows the Debian convention', () => {
    assert.equal(debFileName('1.4.5-1', 'arm64'), 'konjugate_1.4.5-1_arm64.deb');
});

test('a description is wrapped and separated into paragraphs the control file accepts', () => {
    const wrapped = wrapDescription('Summary', ['one two three four five', 'six'], 12).split('\n');
    assert.deepEqual(wrapped, ['Summary', ' one two', ' three four', ' five', ' .', ' six']);
    for (const line of wrapped.slice(1)) assert.match(line, /^ /);
});

test('the control file carries the fields apt needs, with t64 alternatives for the renamed libraries', () => {
    const control = controlFile({ version: '1.4.5-1', architecture: 'amd64', installedSizeKilobytes: 123, maintainer: 'A <a@example.org>', metadata });
    assert.match(control, /^Package: konjugate$/m);
    assert.match(control, /^Version: 1\.4\.5-1$/m);
    assert.match(control, /^Architecture: amd64$/m);
    assert.match(control, /^Installed-Size: 123$/m);
    assert.match(control, /^Depends: .*libasound2t64 \| libasound2/m);
    assert.match(control, /^Recommends: python3, g\+\+ \| c\+\+-compiler$/m);
    assert.doesNotMatch(control, /^Suggests:/m);
    assert.match(control, /^Description: Graph-native simulation engine\n First paragraph\.\n \.\n Second paragraph\.\n$/m);
    assert.ok(control.endsWith('\n'));
    // A control file is a list of "Name: value" fields and indented continuation lines, nothing else.
    for (const line of control.trimEnd().split('\n')) assert.match(line, /^( |[A-Za-z-]+: )/);
    for (const library of dependencies) assert.ok(control.includes(library));
});

test('the launcher is valid shell, runs the installed app and only drops the sandbox if the helper lost its setuid bit', () => {
    const script = wrapperScript();
    assert.equal(spawnSync('sh', ['-n'], { input: script }).status, 0);
    assert.match(script, /^appDir=\/usr\/lib\/konjugate$/m);
    assert.match(script, /exec "\$appDir\/Konjugate" "\$@"/);
    assert.match(script, /if \[ ! -u "\$appDir\/chrome-sandbox" \]/);
    assert.match(script, /--no-sandbox/);
});

test('the shipped desktop file names the window class GNOME needs to show the app icon', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../packaging/linux/com.konjugate.Konjugate.desktop', import.meta.url), 'utf8');
    assert.match(desktopEntry(source), /^StartupWMClass=konjugate$/m);
});

test('the desktop entry points at the launcher on the PATH and keeps everything else', () => {
    const entry = desktopEntry('[Desktop Entry]\nName=Konjugate\nExec=Konjugate %f\nIcon=com.konjugate.Konjugate\n');
    assert.equal(entry, '[Desktop Entry]\nName=Konjugate\nExec=konjugate %f\nIcon=com.konjugate.Konjugate\n');
    assert.throws(() => desktopEntry('[Desktop Entry]\nName=Konjugate\n'), /no Exec=/);
});

test('the metainfo release entry and screenshot URL are brought up to the packaged version', () => {
    const source = '<release version="0.1.0" date="2020-01-01" />\nhttps://raw.githubusercontent.com/zenineasa/Konjugate/v0.1.0/assets/shot.png\n';
    assert.equal(
        metainfoFor(source, '1.4.5', '2026-11-11'),
        '<release version="1.4.5" date="2026-11-11" />\nhttps://raw.githubusercontent.com/zenineasa/Konjugate/v1.4.5/assets/shot.png\n'
    );
    assert.throws(() => metainfoFor('no release here', '1.4.5', '2026-11-11'), /no <release>/);
});

test('the copyright file names the licence and the bundled third-party components', () => {
    const copyright = copyrightFile(metadata);
    assert.match(copyright, /^Format: https:\/\/www\.debian\.org\/doc\/packaging-manuals\/copyright-format\/1\.0\/$/m);
    assert.match(copyright, /^License: MPL-2\.0$/m);
    assert.match(copyright, /Electron, Chromium/);
});

test('the changelog trailer uses the RFC 2822 date dpkg expects', () => {
    const date = new Date(Date.UTC(2026, 10, 11, 10, 0, 0));
    assert.equal(changelogDate(date), 'Wed, 11 Nov 2026 10:00:00 +0000');
    assert.match(changelogFile({ version: '1.4.5-1', upstreamVersion: '1.4.5', maintainer: 'A <a@example.org>', date }), /^konjugate \(1\.4\.5-1\) unstable; urgency=medium\n[\s\S]* -- A <a@example\.org>  Wed, 11 Nov 2026 10:00:00 \+0000\n$/);
});

test('the lintian override names the setuid sandbox helper exactly as lintian reports it', () => {
    assert.match(lintianOverrides(), /^konjugate: elevated-privileges 4755 root\/root \[usr\/lib\/konjugate\/chrome-sandbox\]$/m);
});
