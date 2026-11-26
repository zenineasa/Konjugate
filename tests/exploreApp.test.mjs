/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { lockedScreen, otherDrivenRuns, parseArguments } from '../scripts/exploreApp.mjs';

test('the explore launcher takes one script and its options', () => {
    assert.deepEqual(parseArguments(['tests/explore/openExampleOverChanges.mjs']), { script: 'tests/explore/openExampleOverChanges.mjs', out: null, minutes: 15, keepProfile: false });
    assert.deepEqual(parseArguments(['a.mjs', '--out', '/tmp/shots', '--minutes', '3', '--keep-profile']), { script: 'a.mjs', out: '/tmp/shots', minutes: 3, keepProfile: true });
    assert.deepEqual(parseArguments(['--help']), { help: true });
    assert.throws(() => parseArguments([]), /Usage/);
    assert.throws(() => parseArguments(['a.mjs', 'b.mjs']), /One script at a time/);
    assert.throws(() => parseArguments(['a.mjs', '--minutes', 'soon']), /--minutes/);
    assert.throws(() => parseArguments(['a.mjs', '--out']), /--out takes a folder/);
    assert.throws(() => parseArguments(['a.mjs', '--fast']), /Unknown option --fast/);
});

test('a locked screen is the login window in front', () => {
    assert.equal(lockedScreen('"LSDisplayName"="loginwindow"'), true);
    assert.equal(lockedScreen('"LSDisplayName"="Electron"'), false);
    assert.equal(lockedScreen(null), false);
});

test('another driven run is an Electron started with --interaction-test, not the shells around it', () => {
    const ps = [
        '  101 /Users/me/konjugate/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --interaction-test --disable-gpu --enable-unsafe-swiftshader --use-mock-keychain',
        '  102 node scripts/runInteractionTests.mjs',
        '  103 /bin/zsh -c pgrep -f "Electron . --interaction-test"',
        '  104 /Applications/Konjugate.app/Contents/MacOS/Konjugate',
        '  105 node scripts/exploreApp.mjs a.mjs --interaction-test',
        '  106 /Users/me/konjugate/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --interaction-test --use-mock-keychain'
    ].join('\n');
    assert.deepEqual(otherDrivenRuns(ps, 999).map(({ pid }) => pid), [101, 106]);
    assert.deepEqual(otherDrivenRuns(ps, 106).map(({ pid }) => pid), [101]);
    assert.deepEqual(otherDrivenRuns(''), []);
});
