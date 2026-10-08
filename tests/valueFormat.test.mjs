// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import test from 'node:test';
import { formatStateNumber, stateValueText } from '../src/renderer/valueFormat.mjs';

test('a state\'s number is written short on a label: six digits at most, scientific where too small or too large', () => {
    assert.equal(formatStateNumber(0), '0');
    assert.equal(formatStateNumber(20), '20');
    assert.equal(formatStateNumber(293.15), '293.15');
    assert.equal(formatStateNumber(-12.3456789), '-12.3457');
    assert.equal(formatStateNumber(123456.7), '123457');
    assert.equal(formatStateNumber(0.0012345678), '0.00123457');
    // Every digit the engine holds was once written out.
    assert.equal(formatStateNumber(0.000010693069306930694), '1.069 × 10⁻⁵');
    assert.equal(formatStateNumber(-0.00001), '-1 × 10⁻⁵');
    assert.equal(formatStateNumber(12345678), '1.235 × 10⁷');
    assert.equal(formatStateNumber(1e100), '1 × 10¹⁰⁰');
    assert.equal(formatStateNumber(NaN), 'NaN');
    assert.equal(formatStateNumber(Infinity), 'Infinity');
});

test('the label\'s tooltip keeps the whole number, both with the unit', () => {
    assert.deepEqual(stateValueText(0.000010693069306930694, 'pallets'), { text: '1.069 × 10⁻⁵ pallets', exact: '0.000010693069306930694 pallets' });
    assert.deepEqual(stateValueText(20), { text: '20', exact: '20' });
});
