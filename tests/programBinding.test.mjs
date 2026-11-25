/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { bindPort, portBindingChoices, referenceToProviderBinding, sourceTermReferenceToBinding } from '../src/programBinding.mjs';

const withoutKey = ({ key, ...rest }) => rest;

test('binding a port writes the same implementation.bindings the card\'s rows wrote', () => {
    const source = { kind: 'state', role: 'source', nodeId: 1, stateId: 11, label: 'source.temperature' };
    const target = { kind: 'state', role: 'target', nodeId: 2, stateId: 21, label: 'target.temperature' };
    const conductance = { kind: 'parameter', parameterId: 5, label: 'conductance' };
    // The relationship card's rows: ＋ added { key: inputN, ...first candidate }, then the key and the reference were changed in place.
    const rows = [referenceToProviderBinding('hot', source), referenceToProviderBinding('cold', target), referenceToProviderBinding('g', conductance)];
    let ports = [];
    ports = bindPort(ports, 'hot', withoutKey(referenceToProviderBinding('', source)));
    ports = bindPort(ports, 'cold', withoutKey(referenceToProviderBinding('', target)));
    ports = bindPort(ports, 'g', withoutKey(referenceToProviderBinding('', conductance)));
    assert.deepEqual(ports, rows);
    assert.deepEqual(rows[0], { key: 'hot', kind: 'state', role: 'source', nodeId: 1, stateId: 11 });
    assert.deepEqual(rows[2], { key: 'g', kind: 'parameter', parameterId: 5 });
    // A node's own part writes its state or its own parameter, as its rows did.
    assert.deepEqual(bindPort([], 'temperature', withoutKey(sourceTermReferenceToBinding('', { kind: 'state', stateId: 7 }))), [{ key: 'temperature', kind: 'state', stateId: 7 }]);
});

test('rebinding replaces the entry in place, unbinding removes it, and the others are left exactly as they were', () => {
    const others = { key: 'b', kind: 'parameter', parameterId: 2, extra: 'kept' };
    const bindings = [{ key: 'a', kind: 'state', stateId: 1 }, others];
    const rebound = bindPort(bindings, 'a', { kind: 'state', stateId: 9 });
    assert.deepEqual(rebound, [{ key: 'a', kind: 'state', stateId: 9 }, others]);
    assert.equal(rebound[1], others);
    assert.notEqual(rebound, bindings, 'a new array');
    assert.deepEqual(bindings[0], { key: 'a', kind: 'state', stateId: 1 }, 'the old array is unchanged');
    assert.deepEqual(bindPort(bindings, 'a', null), [others]);
    assert.deepEqual(bindPort(bindings, 'missing', null), bindings);
    assert.deepEqual(bindPort(undefined, 'c', { kind: 'state', stateId: 3 }), [{ key: 'c', kind: 'state', stateId: 3 }]);
});

test('the choices for a port: those whose unit converts first, the others listed with the reason, units unchecked when absent', () => {
    const choices = portBindingChoices('K', [
        { value: 'a', label: 'Room · Pressure', unit: 'Pa' },
        { value: 'b', label: 'Room · Temperature', unit: '°C' },
        { value: 'c', label: 'Gain', unit: '' },
        { value: 'd', label: 'Wall · Temperature', unit: 'K' }
    ]);
    assert.deepEqual(choices.map((choice) => [choice.value, choice.compatible, choice.note]), [
        ['b', true, '°C → K at the port'],
        ['c', true, ''],
        ['d', true, ''],
        ['a', false, 'Cannot be bound: Pa and K measure different kinds of quantity']
    ]);
    assert.ok(portBindingChoices('', [{ value: 'a', unit: 'Pa' }])[0].compatible, 'A port with no unit is not checked.');
});
