/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultProviderSource, olderProviderSource, programSourceVersion, replayProviderSource, withProgramVersion } from '../src/providerTemplate.mjs';

const bindings = [{ key: 'sourceTemperature' }, { key: 'conductance' }];

test('C++ template declares every binding key as an input port and the output port, in version 2', () => {
    const source = defaultProviderSource('cpp', bindings, 'targetTemperatureGradient', 'Thermal coupling');
    assert.match(source, /#include <konjugate\/sdk\/v2\/program\.hpp>/);
    assert.match(source, /k::Input sourceTemperature\{this, "sourceTemperature"\};/);
    assert.match(source, /k::Input conductance\{this, "conductance"\};/);
    assert.match(source, /k::Output targetTemperatureGradient\{this, "targetTemperatureGradient"\};/);
    assert.match(source, /x\[sourceTemperature\], x\[conductance\]/);
    assert.match(source, /double evaluate\(double t, const k::Inputs& x\) const override/);
    assert.match(source, /class ThermalCoupling final : public k::Relationship/);
    assert.match(source, /std::make_unique<ThermalCoupling>/);
    assert.equal(programSourceVersion('cpp', source), 2);
});

test('Python template declares every binding key as an input port and the output port, in version 2', () => {
    const source = defaultProviderSource('python', bindings, 'targetTemperatureGradient', 'Thermal coupling');
    assert.match(source, /^from konjugate\.v2 import Input, Output, Relationship$/m);
    assert.match(source, /^    source_temperature = Input\(\)$/m);
    assert.match(source, /^    conductance = Input\(\)$/m);
    assert.match(source, /^    target_temperature_gradient = Output\(\)$/m);
    assert.match(source, /x\.source_temperature, x\.conductance/);
    assert.match(source, /class ThermalCoupling\(Relationship\)/);
    assert.equal(programSourceVersion('python', source), 2);
});

test('the templates say where memory belongs and that a continuous quantity is a state', () => {
    for (const kind of ['cpp', 'python']) {
        const source = defaultProviderSource(kind, bindings, 'gradient', 'Example');
        assert.match(source, /evaluate\(\) changes nothing/);
        assert.match(source, /changed only in advance\(\)/);
        assert.match(source, /a quantity that changes continuously is better\s+(\/\/|#) a node's state/);
    }
});

test('omits undeclared or invalid binding keys and falls back to a generic output name', () => {
    const source = defaultProviderSource('cpp', [{ key: '' }, { key: 'Invalid Key' }], '', '');
    assert.doesNotMatch(source, /Invalid Key/);
    assert.match(source, /No inputs declared yet: declare one here, as k::Input name\{this, "name", "unit"\};, and bind it in the code editor's Ports\./);
    assert.match(source, /k::Output output\{this, "output"\};/);
    assert.match(source, /class Relationship final/);
});

test('a key that is a word C++ or Python keeps is renamed in the code, and binds as written', () => {
    const cpp = defaultProviderSource('cpp', [{ key: 'class' }], 'return', 'Words');
    assert.match(cpp, /k::Input class_\{this, "class"\};/);
    assert.match(cpp, /k::Output return_\{this, "return"\};/);
    const python = defaultProviderSource('python', [{ key: 'lambda' }], 'outputs', 'Words');
    assert.match(python, /^    lambda_ = Input\(name="lambda"\)$/m);
    assert.match(python, /^    outputs_ = Output\(name="outputs"\)$/m);
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
    assert.match(pythonSource, /class Relationship3WayValve\(Relationship\)/);
});

test('produces syntactically balanced braces for both languages regardless of binding count', () => {
    for (const kind of ['cpp', 'python']) {
        for (const testBindings of [[], bindings]) {
            for (const source of [defaultProviderSource(kind, testBindings, 'gradient', 'Example'), olderProviderSource(kind, testBindings, 'gradient', 'Example')]) {
                const opens = (source.match(/[{[(]/g) ?? []).length;
                const closes = (source.match(/[}\])]/g) ?? []).length;
                assert.equal(opens, closes, `${kind} template with ${testBindings.length} bindings is unbalanced.`);
            }
        }
    }
});

test('the older program format keeps its template, and the version follows the source', () => {
    const older = olderProviderSource('cpp', bindings, 'gradient', 'Thermal coupling');
    assert.match(older, /#include <konjugate\/relationshipProvider\.hpp>/);
    assert.match(older, /ScalarPort\{"sourceTemperature", "sourceTemperature", ""\}/);
    assert.equal(programSourceVersion('cpp', older), 1);
    assert.equal(programSourceVersion('python', olderProviderSource('python', bindings, 'gradient', 'x')), 1);
    assert.deepEqual(withProgramVersion({ kind: 'cpp', providerApiVersion: 1, source: older }), { kind: 'cpp', providerApiVersion: 1, source: older });
    const unversioned = { kind: 'python', source: 'from konjugate import RelationshipProvider' };
    assert.equal(withProgramVersion(unversioned), unversioned, 'An older program without a version is written as it was.');
    const newer = defaultProviderSource('python', bindings, 'gradient', 'x');
    assert.equal(withProgramVersion({ kind: 'python', providerApiVersion: 1, source: newer }).providerApiVersion, 2);
    assert.equal(withProgramVersion({ kind: 'plugin', providerApiVersion: 1 }).providerApiVersion, 1, 'A plugin\'s provider is left alone.');
});

// See docs/proposals/causalInferenceInputReplay.md: the mathematical/numerical correctness of
// the generated evaluate() body (exact reproduction under Euler integration at any substep
// count, including the floating-point boundary-drift fix) was verified by compiling this
// function's actual output against the real SDK header and running it through a standalone Euler
// harness -- not reproduced as a JS-side unit test here, since that would mean re-implementing a
// C++ compiler's semantics in JS. These tests cover what a JS unit test can meaningfully check:
// structural shape and embedded-data correctness.
test('replayProviderSource is a version 2 relationship with no bindings and a bare output port', () => {
    const source = replayProviderSource('ambientTemperature', [{ time: 0, value: 1 }, { time: 1, value: 2 }], 'Ambient Temperature');
    assert.match(source, /#include <konjugate\/sdk\/v2\/program\.hpp>/);
    assert.match(source, /class AmbientTemperature final : public k::Relationship/);
    assert.match(source, /k::Output output\{this, "output"\};/);
    assert.doesNotMatch(source, /k::Input\s+\w+\{/);
    assert.match(source, /std::make_unique<AmbientTemperature>/);
    assert.equal(programSourceVersion('cpp', source), 2);
});

test('replayProviderSource embeds every recorded sample as a C++ double literal, in order', () => {
    const pairs = [{ time: 0, value: 1.5 }, { time: 1, value: -2.25 }, { time: 2, value: 0 }];
    const source = replayProviderSource('x', pairs, 'x');
    assert.match(source, /constexpr double kTimes\[\] = \{ 0, 1, 2 \};/);
    assert.match(source, /constexpr double kValues\[\] = \{ 1\.5, -2\.25, 0 \};/);
});

test('replayProviderSource holds at the nearest known value past the recorded range rather than extrapolating', () => {
    const source = replayProviderSource('x', [{ time: 0, value: 1 }, { time: 1, value: 2 }], 'x');
    assert.match(source, /if \(position < 0\) return kValues\[0\];/);
    assert.match(source, /if \(position >= kSampleCount - 1\) return kValues\[kSampleCount - 1\];/);
});

test('replayProviderSource interpolates linearly between the two straddling samples', () => {
    const source = replayProviderSource('x', [{ time: 0, value: 1 }, { time: 1, value: 2 }], 'x');
    assert.match(source, /const double fraction = position - static_cast<double>\(index\);/);
    assert.match(source, /return kValues\[index\] \+ fraction \* \(kValues\[index \+ 1\] - kValues\[index\]\);/);
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
