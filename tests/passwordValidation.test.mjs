/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProjectPassword } from '../src/renderer/passwordValidation.mjs';

test('requires twelve characters for a new encrypted-project password', () => {
    assert.deepEqual(validateProjectPassword('short', '', true), {
        valid: false,
        message: 'Use at least 12 characters · 7 more characters.'
    });
});

test('requires a matching password confirmation', () => {
    assert.equal(validateProjectPassword('longEnoughPassword', '', true).message, 'Confirm your password.');
    assert.deepEqual(validateProjectPassword('longEnoughPassword', 'differentPassword', true), {
        valid: false,
        message: 'The passwords do not match.'
    });
});

test('enables encrypted save only for matching valid passwords', () => {
    assert.deepEqual(validateProjectPassword('longEnoughPassword', 'longEnoughPassword', true), {
        valid: true,
        message: ''
    });
});

test('allows any non-empty password when unlocking an existing project', () => {
    assert.equal(validateProjectPassword('', '', false, 'Incorrect password.').valid, false);
    assert.deepEqual(validateProjectPassword('existing', '', false, 'Incorrect password.'), {
        valid: true,
        message: ''
    });
});
