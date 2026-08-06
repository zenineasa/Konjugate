/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultProviderSource } from '../src/providerTemplate.mjs';

const bindings = [{ key: 'sourceTemperature' }, { key: 'conductance' }];

test('C++ template declares every binding key as an input port and the output port', () => {
    const source = defaultProviderSource('cpp', bindings, 'targetTemperatureGradient', 'Thermal coupling');
    assert.match(source, /#include <konjugate\/relationshipProvider\.hpp>/);
    assert.match(source, /ScalarPort\{"sourceTemperature", "sourceTemperature", ""\}/);
    assert.match(source, /ScalarPort\{"conductance", "conductance", ""\}/);
    assert.match(source, /ScalarPort\{"targetTemperatureGradient", "targetTemperatureGradient", ""\}/);
    assert.match(source, /const double sourceTemperature = context\.inputs\.at\("sourceTemperature"\);/);
    assert.match(source, /const double conductance = context\.inputs\.at\("conductance"\);/);
    assert.match(source, /"thermalCoupling"/);
    assert.match(source, /"Thermal Coupling"/);
    assert.match(source, /class ThermalCoupling final/);
    assert.match(source, /std::make_unique<ThermalCoupling>/);
});

test('Python template declares every binding key as an input port and the output port', () => {
    const source = defaultProviderSource('python', bindings, 'targetTemperatureGradient', 'Thermal coupling');
    assert.match(source, /from konjugate import/);
    assert.match(source, /ScalarPort\("sourceTemperature", "sourceTemperature", ""\)/);
    assert.match(source, /ScalarPort\("conductance", "conductance", ""\)/);
    assert.match(source, /ScalarPort\("targetTemperatureGradient", "targetTemperatureGradient", ""\)/);
    assert.match(source, /sourceTemperature = inputs\["sourceTemperature"\]/);
    assert.match(source, /conductance = inputs\["conductance"\]/);
    assert.match(source, /class ThermalCoupling\(RelationshipProvider\)/);
});

test('omits undeclared or invalid binding keys and falls back to a generic output name', () => {
    const source = defaultProviderSource('cpp', [{ key: '' }, { key: 'Invalid Key' }], '', '');
    assert.doesNotMatch(source, /ScalarPort\{"", /);
    assert.doesNotMatch(source, /Invalid Key/);
    assert.match(source, /No bindings declared yet/);
    assert.match(source, /ScalarPort\{"output", "output", ""\}/);
    assert.match(source, /"relationship"/);
    assert.match(source, /class Relationship final/);
});

test('gives two differently-titled relationships distinct class names', () => {
    const first = defaultProviderSource('cpp', [], 'gradient', 'Thermal coupling');
    const second = defaultProviderSource('cpp', [], 'gradient', 'Electrical losses');
    assert.match(first, /class ThermalCoupling final/);
    assert.match(second, /class ElectricalLosses final/);
    assert.notEqual(first, second);
});

test('falls back to a letter-led class name when the title starts with a digit', () => {
    const cppSource = defaultProviderSource('cpp', [], 'gradient', '3-way valve');
    assert.match(cppSource, /class Relationship3WayValve final/);
    const pythonSource = defaultProviderSource('python', [], 'gradient', '3-way valve');
    assert.match(pythonSource, /class Relationship3WayValve\(RelationshipProvider\)/);
});

test('produces syntactically balanced braces for both languages regardless of binding count', () => {
    for (const kind of ['cpp', 'python']) {
        for (const testBindings of [[], bindings]) {
            const source = defaultProviderSource(kind, testBindings, 'gradient', 'Example');
            const opens = (source.match(/[{[]/g) ?? []).length;
            const closes = (source.match(/[}\]]/g) ?? []).length;
            assert.equal(opens, closes, `${kind} template with ${testBindings.length} bindings is unbalanced.`);
        }
    }
});
