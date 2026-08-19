/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseKjtPathFromArgv } from '../src/fileAssociation.mjs';

test('finds a .kjt path among ordinary argv entries', () => {
    assert.equal(parseKjtPathFromArgv(['/usr/bin/konjugate', '/Users/me/model.kjt']), '/Users/me/model.kjt');
});

test('is case-insensitive on the extension', () => {
    assert.equal(parseKjtPathFromArgv(['/Applications/Konjugate.app/Contents/MacOS/Konjugate', 'C:\\models\\Pump.KJT']), 'C:\\models\\Pump.KJT');
});

test('preserves spaces in the path', () => {
    assert.equal(parseKjtPathFromArgv(['electron', '/Users/me/My Documents/pump suction.kjt']), '/Users/me/My Documents/pump suction.kjt');
});

test('ignores flags even if they end in .kjt-like text', () => {
    assert.equal(parseKjtPathFromArgv(['electron', '--interaction-test', '--generate-example-thumbnails']), null);
});

test('returns null when nothing looks like a project file', () => {
    assert.equal(parseKjtPathFromArgv(['/usr/bin/konjugate']), null);
    assert.equal(parseKjtPathFromArgv(['/usr/bin/konjugate', 'notes.txt']), null);
    assert.equal(parseKjtPathFromArgv([]), null);
});
