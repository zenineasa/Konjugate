/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The conversions a version 2 program's ports apply, as the code editor's Ports panel works them out (src/programPortUnits.mjs). That
// they are the engine's, number for number, over a sweep of units, is held by tests/engine/programDescription.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { inputPortConversion, outputPortConversion, perSecond, portUnitConversion } from '../src/programPortUnits.mjs';

test('an input converts the bound value\'s unit onto the port\'s, and says so', () => {
    assert.deepEqual(inputPortConversion('°C', 'K'), { scale: 1, offset: 273.15, identity: false, text: '°C → K at the port' });
    assert.deepEqual(inputPortConversion('kJ/K', 'J/K'), { scale: 1000, offset: 0, identity: false, text: 'kJ/K → J/K at the port' });
    assert.deepEqual(inputPortConversion('K', 'K'), { scale: 1, offset: 0, identity: true, text: null });
    assert.deepEqual(inputPortConversion('', 'K'), { scale: 1, offset: 0, identity: true, text: null }, 'Nothing is checked when the binding has no unit.');
    assert.deepEqual(inputPortConversion('Pa', 'K'), { error: 'Pa and K measure different kinds of quantity' });
    assert.deepEqual(inputPortConversion('furlongs', 'm'), { error: '"furlongs" is not a unit Konjugate knows' });
});

test('an output reaches a Rate state per second without an offset, and an Update state as it is', () => {
    assert.deepEqual(outputPortConversion('K/s', { unit: '°C', rate: true }), { scale: 1, offset: 0, identity: true, text: null });
    assert.deepEqual(outputPortConversion('W', { unit: 'kW', rate: false }), { scale: 0.001, offset: 0, identity: false, text: 'W → kW at the port' });
    assert.deepEqual(outputPortConversion('K', { unit: 'K', rate: true }), { error: 'K and K/s measure different kinds of quantity' });
    assert.equal(portUnitConversion('K', '°C', { rate: true }).offset, 0);
    assert.equal(portUnitConversion('K', '°C').offset, -273.15);
});

test('a rate\'s unit is written as the engine writes it', () => {
    assert.deepEqual(['', 'K', '°C', 'W/K', 'kg·m', 'N m'].map(perSecond), ['Hz', 'K/s', '°C/s', '(W/K)/s', '(kg·m)/s', '(N m)/s']);
});
