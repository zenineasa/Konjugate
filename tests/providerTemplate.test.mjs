/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultProviderSource, replayProviderSource } from '../src/providerTemplate.mjs';

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

// See docs/proposals/causalInferenceInputReplay.md: the mathematical/numerical correctness of
// the generated evaluate() body (exact reproduction under Euler integration at any substep
// count, including the floating-point boundary-drift fix) was verified by compiling this
// function's actual output against the real SDK header and running it through a standalone Euler
// harness -- not reproduced as a JS-side unit test here, since that would mean re-implementing a
// C++ compiler's semantics in JS. These tests cover what a JS unit test can meaningfully check:
// structural shape and embedded-data correctness.
test('replayProviderSource embeds no bindings and declares a bare output port', () => {
    const source = replayProviderSource('ambientTemperature', [{ time: 0, value: 1 }, { time: 1, value: 2 }], 'Ambient Temperature');
    assert.match(source, /#include <konjugate\/relationshipProvider\.hpp>/);
    assert.match(source, /class AmbientTemperature final : public konjugate::sdk::v1::RelationshipProvider/);
    assert.match(source, /"ambientTemperature"/);
    assert.match(source, /\{\}[\s,]*konjugate::sdk::v1::ScalarPort\{"output", "output", ""\}/s);
    assert.match(source, /std::make_unique<AmbientTemperature>/);
});

test('replayProviderSource embeds every recorded sample as a C++ double literal, in order', () => {
    const pairs = [{ time: 0, value: 1.5 }, { time: 1, value: -2.25 }, { time: 2, value: 0 }];
    const source = replayProviderSource('x', pairs, 'x');
    assert.match(source, /constexpr double kTimes\[\] = \{ 0, 1, 2 \};/);
    assert.match(source, /constexpr double kValues\[\] = \{ 1\.5, -2\.25, 0 \};/);
});

test('replayProviderSource holds past the recorded range rather than extrapolating', () => {
    const source = replayProviderSource('x', [{ time: 0, value: 1 }, { time: 1, value: 2 }], 'x');
    assert.match(source, /position < 0 \|\| position >= kSampleCount - 1/);
    assert.match(source, /output\.addGradient\(0\);/);
});

test('produces syntactically balanced braces at 2 samples and above', () => {
    for (const pairs of [
        [{ time: 0, value: 1 }, { time: 1, value: 2 }],
        [{ time: 0, value: 1 }, { time: 1, value: 2 }, { time: 2, value: 3 }]
    ]) {
        const source = replayProviderSource('x', pairs, 'x');
        const opens = (source.match(/[{[]/g) ?? []).length;
        const closes = (source.match(/[}\]]/g) ?? []).length;
        assert.equal(opens, closes, `${pairs.length}-sample template is unbalanced.`);
    }
});

test('replayProviderSource rejects fewer than 2 samples rather than emitting a zero-length array', () => {
    assert.throws(() => replayProviderSource('x', [], 'x'), /at least 2 recorded samples/);
    assert.throws(() => replayProviderSource('x', [{ time: 0, value: 1 }], 'x'), /at least 2 recorded samples/);
});
