/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fmiImplementation, fmuPortNotes, freeKey, nodeProgramErrors, nodeProgramInputCandidates, nodeProgramInputValue } from '../src/nodeProgram.mjs';
import { defaultNodeProviderSource, olderNodeProviderSource } from '../src/providerTemplate.mjs';

const tank = { id: 1, title: 'Tank', states: [{ id: 2, symbol: 'level' }, { id: 3, symbol: 'effort' }] };
const valve = { id: 4, title: 'Valve', states: [{ id: 5, symbol: 'opening' }] };
const shared = [{ id: 9, name: 'Setpoint', symbol: 'setpoint' }];

test('a program reads this node\'s states, any other node\'s and the shared parameters, as the schema writes them', () => {
    const candidates = nodeProgramInputCandidates(tank, [tank, valve], shared);
    assert.deepEqual(candidates.map(({ label }) => label), ['this.level', 'this.effort', 'Valve.opening', 'shared Setpoint (setpoint)']);
    assert.deepEqual(candidates[0].binding, { kind: 'state', stateId: 2 }, 'its own state needs no nodeId');
    assert.deepEqual(candidates[2].binding, { kind: 'state', nodeId: 4, stateId: 5 });
    assert.deepEqual(candidates[3].binding, { kind: 'parameter', sharedParameterId: 9 });
    for (const candidate of candidates) assert.equal(nodeProgramInputValue({ key: 'x', ...candidate.binding }, tank), candidate.value);
});

test('every mistake in a program\'s wiring is named on its row', () => {
    const errors = nodeProgramErrors({
        kind: 'python', source: '',
        bindings: [{ key: 'level', kind: 'state', stateId: 2 }, { key: 'level', kind: 'state', nodeId: 4, stateId: 99 }, { key: 'Bad', kind: 'parameter', sharedParameterId: 9 }],
        outputs: [{ key: 'rate', stateId: 2 }, { key: 'rate2', stateId: 5 }]
    }, tank, [tank, valve], shared);
    assert.deepEqual(errors.inputs[0], []);
    assert.match(errors.inputs[1].join(' '), /Two inputs are called "level".*is gone/);
    assert.match(errors.inputs[2][0], /not a valid input key/);
    assert.deepEqual(errors.outputs[0], []);
    assert.match(errors.outputs[1][0], /this node's states/);
    assert.match(nodeProgramErrors({ kind: 'cpp', bindings: [], outputs: [] }, tank, [tank], []).errors[0], /Add an output/);
    assert.match(nodeProgramErrors({ kind: 'fmi', fmuId: '', bindings: [], outputs: [{ key: 'y', stateId: 2 }] }, tank, [tank], []).errors[0], /Choose an installed FMU/);
});

test('an FMU is wired under its own keys, keeping what earlier wiring read and wrote', () => {
    const ports = { inputs: [{ key: 'u' }, { key: 'gain' }], outputs: [{ key: 'y' }] };
    const first = fmiImplementation('guid', '1.0', ports);
    assert.deepEqual(first, {
        kind: 'fmi', fmuId: 'guid', fmuVersion: '1.0',
        bindings: [{ key: 'u', kind: 'state', stateId: null }, { key: 'gain', kind: 'state', stateId: null }],
        outputs: [{ key: 'y', stateId: null, setsValue: true }]
    });
    const wired = { ...first, bindings: [{ key: 'u', kind: 'state', nodeId: 4, stateId: 5 }, first.bindings[1]], outputs: [{ key: 'y', stateId: 2, setsValue: true }] };
    const updated = fmiImplementation('guid', '1.1', { inputs: [{ key: 'u' }], outputs: [{ key: 'y' }, { key: 'z' }] }, wired);
    assert.deepEqual(updated.bindings, [{ key: 'u', kind: 'state', nodeId: 4, stateId: 5 }]);
    assert.deepEqual(updated.outputs, [{ key: 'y', stateId: 2, setsValue: true }, { key: 'z', stateId: null, setsValue: true }]);
    assert.equal(freeKey([{ key: 'input' }, { key: 'input2' }], 'input'), 'input3');
});

test('an FMU says which binary runs, what it fixes, what it converts and what is not wired', () => {
    assert.deepEqual(fmuPortNotes({
        binary: 'Runs binaries/aarch64-darwin/Feedthrough.dylib.',
        inputs: [
            { name: 'g', causality: 'parameter', variability: 'fixed', type: 'Float64' },
            { name: 'e', causality: 'parameter', variability: 'tunable', type: 'Float64' },
            { name: 'n', causality: 'input', variability: 'discrete', type: 'Int8' },
            { name: 'm', causality: 'input', variability: 'discrete', type: 'Enumeration' },
            { name: 'on', causality: 'input', variability: 'discrete', type: 'Boolean' }
        ],
        outputs: [{ name: 'counter', type: 'Int32' }, { name: 'h', type: 'Real' }],
        notExposed: [{ name: 'label', causality: 'input', type: 'String' }]
    }), [
        'Runs binaries/aarch64-darwin/Feedthrough.dylib.',
        'Set once, when the run starts (fixed): g.',
        'Take the nearest whole number: n (Int8) and m (Enumeration).',
        'True for anything other than 0: on.',
        'Read as numbers: counter (Int32).',
        'Not wired, so the FMU keeps its own value: label (String).'
    ]);
    assert.deepEqual(fmuPortNotes({ inputs: [{ name: 'k', causality: 'input', type: 'Real' }], outputs: [{ name: 'b', type: 'Boolean' }] }),
        ['Read as numbers, true as 1 and false as 0: b (Boolean).']);
});

test('a new program starts from a template naming every input and output', () => {
    const python = defaultNodeProviderSource('python', [{ key: 'level' }, { key: 'inflowRate' }], [{ key: 'rate' }], 'Tank');
    assert.match(python, /^from konjugate\.v2 import Input, Node, Output$/m);
    assert.match(python, /class Tank\(Node\)/);
    assert.match(python, /^    level = Input\(\)$/m);
    assert.match(python, /^    inflow_rate = Input\(\)$/m, 'A camelCase key is a snake_case attribute, which binds as the key.');
    assert.match(python, /^    rate = Output\(\)$/m);
    assert.match(python, /return self\.outputs\(rate=0\.0\)/);
    assert.doesNotMatch(python, /checkpoint/, 'A version 2 program writes no checkpoint: the engine keeps its memory.');
    const cpp = defaultNodeProviderSource('cpp', [{ key: 'level' }], [{ key: 'rate' }], 'Tank');
    assert.match(cpp, /#include <konjugate\/sdk\/v2\/program\.hpp>/);
    assert.match(cpp, /class Tank final : public k::Node/);
    assert.match(cpp, /k::Input level\{this, "level"\};/);
    assert.match(cpp, /y\[rate\] = 0\.0;/);
    assert.match(cpp, /std::unique_ptr<k::Program> createProgram\(\)/);
    const older = olderNodeProviderSource('python', [{ key: 'level' }], [{ key: 'rate' }], 'Tank');
    assert.match(older, /class Tank\(NodeProvider\)/, 'The older program format keeps its own template.');
});

test('an installed plugin\'s relationship providers are offered, pinned to the installed version', async () => {
    const { pluginProviderChoices, pluginProviderValue } = await import('../src/pluginProviders.mjs');
    const choices = pluginProviderChoices([
        { packageType: 'plugin', packageId: 'example.helloProvider', name: 'Hello', version: '0.1.0', manifest: { contributes: [
            { providerId: 'example.helloWorld', runtime: 'python' }, { kind: 'component', componentId: 'helloComponent' }
        ] } },
        { packageType: 'plugin', packageId: 'off', version: '1', enabled: false, manifest: { contributes: [{ providerId: 'x' }] } },
        { packageType: 'fmu', packageId: 'guid', version: '1' }
    ]);
    assert.deepEqual(choices.map(({ label, reference }) => [label, reference]), [
        ['Hello 0.1.0: example.helloWorld (Python)', { pluginId: 'example.helloProvider', pluginVersion: '0.1.0', providerId: 'example.helloWorld' }]
    ]);
    assert.equal(pluginProviderValue({ kind: 'plugin', ...choices[0].reference }), choices[0].value);
    assert.equal(pluginProviderValue({ kind: 'plugin', pluginId: '' }), '');
});
