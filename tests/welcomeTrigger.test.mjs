/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSkipWelcomeTrigger } from '../src/welcomeTrigger.mjs';

test('does not skip under ordinary launch argv', () => {
    assert.equal(shouldSkipWelcomeTrigger(['node', 'main.mjs']), false);
});

test('skips under --interaction-test', () => {
    assert.equal(shouldSkipWelcomeTrigger(['node', 'main.mjs', '--interaction-test']), true);
});

test('skips under --generate-example-thumbnails', () => {
    assert.equal(shouldSkipWelcomeTrigger(['node', 'main.mjs', '--generate-example-thumbnails']), true);
});
