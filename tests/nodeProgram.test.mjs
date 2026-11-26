/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    documentRequires, fmiImplementation, fmiNodeFromPorts, fmuAboutLines, fmuConnectionNotes, fmuInputRows, fmuPortHint, fmuPortNotes, fmuPortRole, fmuUsesStartValues, freeKey, implementationForFile,
    nodeProgramErrors, nodeProgramInputCandidates, nodeProgramInputValue
} from '../src/nodeProgram.mjs';
import { defaultNodeProviderSource, olderNodeProviderSource } from '../src/providerTemplate.mjs';
import { bindPort } from '../src/programBinding.mjs';
import { fmuBoxPorts } from '../src/boxPorts.mjs';
import { readFile } from 'node:fs/promises';

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

test('an FMU input that reads nothing keeps the FMU\'s start value, so it is not a mistake; a value given must be a number', () => {
    const implementation = {
        kind: 'fmi', fmuId: 'guid', fmuVersion: '1.0',
        bindings: [{ key: 'u', kind: 'state', stateId: null }, { key: 'gain', kind: 'value', value: 2 }, { key: 'offset', kind: 'value', value: Number.NaN }],
        outputs: [{ key: 'y', stateId: 2, setsValue: true }]
    };
    const errors = nodeProgramErrors(implementation, tank, [tank], []);
    assert.deepEqual(errors.inputs, [[], [], ['Give this input a number.']]);
    assert.deepEqual(nodeProgramErrors({ kind: 'cpp', bindings: [{ key: 'u', kind: 'state', stateId: null }], outputs: [{ key: 'y', stateId: 2 }] }, tank, [tank], []).inputs, [['Choose what this input reads.']],
        'A program\'s input still has to read something.');
});

test('a file keeps an FMU\'s targeted bindings only, and requires fmuStartValues exactly while one is left to the FMU or given a value', () => {
    const wired = { kind: 'fmi', fmuId: 'guid', fmuVersion: '1.0', bindings: [{ key: 'u', kind: 'state', stateId: 3 }, { key: 'g', kind: 'parameter', sharedParameterId: 7 }], outputs: [] };
    assert.equal(implementationForFile(wired), wired, 'A fully bound FMU is written as it was.');
    assert.equal(fmuUsesStartValues(wired), false);
    const loose = { ...wired, bindings: [...wired.bindings, { key: 'k', kind: 'state', stateId: null }, { key: 'm', kind: 'parameter' }] };
    assert.deepEqual(implementationForFile(loose).bindings, wired.bindings);
    assert.equal(fmuUsesStartValues(loose), true);
    const given = { ...wired, bindings: [...wired.bindings, { key: 'k', kind: 'value', value: 1.5 }] };
    assert.deepEqual(implementationForFile(given).bindings, given.bindings, 'A value given is kept.');
    assert.equal(fmuUsesStartValues(given), true);
    const program = { kind: 'cpp', bindings: [{ key: 'u', kind: 'state', stateId: null }], outputs: [] };
    assert.equal(implementationForFile(program), program, 'Only FMUs leave unbound inputs out.');
    const node = (implementation) => ({ id: 1, implementation });
    assert.deepEqual(documentRequires([], [node(wired)]), []);
    assert.deepEqual(documentRequires(undefined, [node(loose)]), ['fmuStartValues']);
    assert.deepEqual(documentRequires(['other'], [node(given), node(program)]), ['other', 'fmuStartValues']);
    assert.deepEqual(documentRequires(['fmuStartValues', 'other'], [node(wired)]), ['other', 'fmuStartValues'],
        'A file opened with it keeps it while it has an FMU: a binding it left out is not known without the FMU\'s ports.');
    assert.deepEqual(documentRequires(['fmuStartValues'], [node(program)]), [], 'With no FMU left, it is dropped.');
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

// The node an FMU becomes (docs/proposals/fmuImportWorkflow.md, stage 3): the springMassDamper FMU, Konjugate's own export.
const springPorts = {
    name: 'springMassDamper',
    inputs: [
        { key: 'stiffness', name: 'stiffness', causality: 'parameter', variability: 'tunable', start: 4, unit: 'N/m' },
        { key: 'springForceMass', name: 'Spring force.mass', causality: 'parameter', variability: 'tunable', start: 1, unit: 'kg' }
    ],
    outputs: [
        { key: 'suspendedMassDisplacement', name: 'Suspended mass.Displacement', start: 0.1, unit: 'm' },
        { key: 'suspendedMassVelocity', name: 'Suspended mass.Velocity', start: 0, unit: 'm/s' }
    ]
};

test('choosing an FMU builds the node: a state per output with its name, unit and start, every parameter at the FMU\'s value, the new node\'s x gone', () => {
    let next = 50;
    const fresh = { id: 2, name: 'New node', states: [{ id: 3, name: 'x', symbol: 'x', initialValue: 0, unit: '' }], implementation: null };
    const built = fmiNodeFromPorts(fresh, { guid: 'g', version: '1.0.0', ports: springPorts, newId: () => next++, removableStateIds: [3] });
    assert.equal(built.name, 'springMassDamper', 'A new node is named after the FMU.');
    assert.deepEqual(built.states, [
        { id: 50, name: 'Suspended mass.Displacement', symbol: 'suspendedMassDisplacement', initialValue: 0.1, unit: 'm' },
        { id: 51, name: 'Suspended mass.Velocity', symbol: 'suspendedMassVelocity', initialValue: 0, unit: 'm/s' }
    ]);
    assert.deepEqual(built.implementation, {
        kind: 'fmi', fmuId: 'g', fmuVersion: '1.0.0',
        bindings: [{ key: 'stiffness', kind: 'state', stateId: null }, { key: 'springForceMass', kind: 'state', stateId: null }],
        outputs: [{ key: 'suspendedMassDisplacement', stateId: 50, setsValue: true }, { key: 'suspendedMassVelocity', stateId: 51, setsValue: true }]
    });
    assert.equal(fmuUsesStartValues(built.implementation), true, 'It runs on the FMU\'s own values.');
    // The new node's x is not taken for an FMU's output called x (Dahlquist's): that output's state starts where the FMU does.
    const dahlquist = fmiNodeFromPorts(fresh, { guid: 'g', version: '1', ports: { name: 'Dahlquist', inputs: [], outputs: [{ key: 'x', name: 'x', start: 1 }] }, newId: () => 60, removableStateIds: [3] });
    assert.deepEqual(dahlquist.states, [{ id: 60, name: 'x', symbol: 'x', initialValue: 1, unit: '' }]);
});

test('choosing an FMU again keeps the states and wiring a person made, and a node of their own name keeps it', () => {
    let next = 80;
    const wired = {
        id: 2, name: 'Suspension',
        states: [
            { id: 10, name: 'Height', symbol: 'height', initialValue: 0.2, unit: 'm' },
            { id: 11, name: 'Other', symbol: 'suspendedMassVelocity', initialValue: 5, unit: 'm/s' },
            { id: 12, name: 'Kept', symbol: 'kept', initialValue: 1, unit: '' }
        ],
        implementation: {
            kind: 'fmi', fmuId: 'g', fmuVersion: '1.0.0',
            bindings: [{ key: 'stiffness', kind: 'value', value: 8 }],
            outputs: [{ key: 'suspendedMassDisplacement', stateId: 10, setsValue: true }]
        }
    };
    const built = fmiNodeFromPorts(wired, { guid: 'g', version: '1.1.0', ports: springPorts, newId: () => next++ });
    assert.equal(built.name, 'Suspension');
    assert.deepEqual(built.states.map((state) => state.id), [10, 11, 12], 'The earlier output\'s state and a state already named for an output are used; no state is made or removed.');
    assert.deepEqual(built.implementation.outputs.map((output) => output.stateId), [10, 11]);
    assert.deepEqual(built.implementation.bindings, [{ key: 'stiffness', kind: 'value', value: 8 }, { key: 'springForceMass', kind: 'state', stateId: null }]);
    // A symbol taken by a state that is not that output's gets a suffix.
    const clash = fmiNodeFromPorts({ id: 2, name: 'N', states: [{ id: 1, name: 'mine', symbol: 'suspendedMassDisplacement2', initialValue: 0 }], implementation: { kind: 'fmi', outputs: [{ key: 'suspendedMassDisplacement', stateId: 1 }] } },
        { guid: 'g', version: '1', ports: { name: 'M', inputs: [], outputs: [{ key: 'suspendedMassDisplacement', name: 'a' }, { key: 'suspendedMassDisplacement2', name: 'b' }] }, newId: () => 7 });
    assert.deepEqual(clash.states.map((state) => state.symbol), ['suspendedMassDisplacement2', 'suspendedMassDisplacement22']);
});

test('a row says what an FMU\'s parameter or input is, and About this FMU says what the FMU is and how it runs here', () => {
    assert.equal(fmuPortRole({ causality: 'parameter', variability: 'tunable' }), 'parameter · tunable');
    assert.equal(fmuPortRole({ causality: 'parameter', variability: 'fixed' }), 'parameter · fixed');
    assert.equal(fmuPortRole({ causality: 'input' }), 'input');
    assert.equal(fmuPortHint({ causality: 'parameter', variability: 'tunable', description: 'Coefficient of restitution', min: 0.5, max: 1 }), 'Coefficient of restitution · from 0.5 to 1');
    assert.equal(fmuPortHint({ causality: 'parameter', variability: 'fixed', unit: 'm/s2', min: -20 }), 'from -20 to ∞ m/s2 · set once, when the run starts');
    assert.deepEqual(fmuAboutLines({
        fmiVersion: '3.0', generationTool: 'Reference FMUs (v0.0.42)', description: 'A ball dropped from 1 m',
        platforms: ['aarch64-darwin', 'x86_64-linux'], runsHere: true, defaultExperiment: { startTime: 0, stopTime: 3, stepSize: 0.01 },
        coSimulation: { canHandleVariableCommunicationStepSize: true, fixedInternalStepSize: 0.001, canBeInstantiatedOnlyOncePerProcess: false }, canGetAndSetFMUState: true
    }), [
        'FMI 3.0 Co-Simulation · generated by Reference FMUs (v0.0.42)',
        'A ball dropped from 1 m',
        'Binaries for aarch64-darwin, x86_64-linux',
        'Steps: its own step is 0.001 s',
        'Suggested run: to 3 s, in steps of 0.01 s',
        'Can save and restore its state (checkpoints, forks, rewinding a twin)'
    ]);
    assert.deepEqual(fmuAboutLines({ fmiVersion: '2.0', author: 'Ada', version: '2', platforms: ['win64'], runsHere: false, coSimulation: { canHandleVariableCommunicationStepSize: false, canBeInstantiatedOnlyOncePerProcess: true } }), [
        'FMI 2.0 Co-Simulation', 'by Ada · version 2', 'Binaries for win64 (none for this computer)', 'Steps: it needs every step the same length',
        'Cannot save its state: checkpoints, forks and rewinding are not available with it', 'Only one copy of it can run at a time'
    ]);
    assert.deepEqual(fmuAboutLines(null), []);
});

test('the Connect to… picker groups what an input can read and gives units (the label itself carries none, for the code editor\'s Ports); a row says a unit that differs and that another node is read a step late', () => {
    const source = { id: 7, title: 'Dahlquist A', states: [{ id: 8, symbol: 'x', unit: 'm' }, { id: 9, symbol: 'v', unit: '' }] };
    const reader = { id: 1, title: 'Feedthrough', states: [{ id: 2, symbol: 'y', unit: 'm/s' }] };
    const candidates = nodeProgramInputCandidates(reader, [reader, source], [{ id: 3, name: 'Gain', symbol: 'gain', unit: 'W' }]);
    assert.deepEqual(candidates.map(({ label, group, unit }) => [label, group, unit]), [
        ['this.y', 'This node', 'm/s'], ['Dahlquist A.x', 'Dahlquist A', 'm'], ['Dahlquist A.v', 'Dahlquist A', ''], ['shared Gain (gain)', 'Shared parameters', 'W']
    ]);
    const port = { key: 'u', name: 'Float64_continuous_input', unit: 'm/s' };
    assert.deepEqual(fmuConnectionNotes({ key: 'u', kind: 'state', nodeId: 7, stateId: 8 }, port, reader, [reader, source]),
        ['Dahlquist A.x is in m; this input is in m/s. It is not converted.', 'Read at the start of each step, so one step late.']);
    assert.deepEqual(fmuConnectionNotes({ key: 'u', kind: 'state', nodeId: 7, stateId: 9 }, port, reader, [reader, source]),
        ['Dahlquist A.v has no unit; this input is in m/s.', 'Read at the start of each step, so one step late.']);
    assert.deepEqual(fmuConnectionNotes({ key: 'u', kind: 'state', stateId: 2 }, port, reader, [reader, source]), [], 'Its own state, in its unit, read as it is.');
    assert.deepEqual(fmuConnectionNotes({ key: 'u', kind: 'state', nodeId: 7, stateId: 8 }, { key: 'u', name: 'u' }, reader, [reader, source]), ['Read at the start of each step, so one step late.'], 'An input with no unit warns of none.');
    assert.deepEqual(fmuConnectionNotes({ key: 'u', kind: 'value', value: 1 }, port, reader, [reader, source]), []);
});

test('a node keeps its FMU in the project by the archive\'s SHA-256, links it when it is over 16 MB, and the file says it requires attachments', () => {
    const ports = { name: 'M', inputs: [], outputs: [], about: { archiveSha256: 'abc', archiveBytes: 1000 } };
    const kept = fmiNodeFromPorts({ id: 1, name: 'New node', states: [] }, { guid: 'g', version: '1', ports, newId: () => 5 }).implementation;
    assert.equal(kept.fmuSha256, 'abc');
    assert.equal(kept.fmuLink, undefined);
    assert.deepEqual(documentRequires([], [{ implementation: kept }]), ['fmuAttachments']);
    const big = fmiNodeFromPorts({ id: 1, name: 'New node', states: [] }, { guid: 'g', version: '1', ports: { ...ports, about: { archiveSha256: 'def', archiveBytes: 20 * 1024 * 1024 } }, newId: () => 5 }).implementation;
    assert.equal(big.fmuLink, true, 'Over the limit kept by default, it is linked.');
    assert.deepEqual(documentRequires([], [{ implementation: big }]), [], 'A linked FMU requires nothing new.');
    // Replaced or chosen again, a node keeps being linked or kept as it was.
    const relinked = fmiNodeFromPorts({ id: 1, name: 'X', states: [], implementation: { kind: 'fmi', fmuSha256: 'abc', fmuLink: true, outputs: [] } }, { guid: 'g', version: '2', ports, newId: () => 5 }).implementation;
    assert.equal(relinked.fmuLink, true);
    const stillKept = fmiNodeFromPorts({ id: 1, name: 'X', states: [], implementation: { kind: 'fmi', fmuSha256: 'abc', outputs: [] } }, { guid: 'g', version: '2', ports: { ...ports, about: { archiveSha256: 'new', archiveBytes: 20 * 1024 * 1024 } }, newId: () => 5 }).implementation;
    assert.equal(stillKept.fmuLink, undefined, 'A node kept in the project stays kept when its replacement is large.');
    assert.equal(stillKept.fmuSha256, 'new');
    // A project from before (no SHA-256 on its FMU node) stays linked, and its file stays readable by older versions.
    assert.deepEqual(documentRequires([], [{ implementation: { kind: 'fmi', fmuId: 'g', fmuVersion: '1', bindings: [{ key: 'k', kind: 'state', stateId: 2 }], outputs: [] } }]), []);
});

// ---- The FMU card's rows, by key (the bug hunt's "measurement switched to setpoint") --------------------------------------
const pidPorts = {
    name: 'PidController',
    inputs: [
        { key: 'measurement', name: 'measurement', causality: 'input', start: 0, unit: 'degC' },
        { key: 'setpoint', name: 'setpoint', causality: 'input', start: 0, unit: 'degC' },
        { key: 'ti', name: 'Ti', causality: 'parameter', variability: 'fixed', start: 600, unit: 's' },
        { key: 'k', name: 'k', causality: 'parameter', variability: 'fixed', start: 1, unit: '' }
    ],
    outputs: [{ key: 'command', name: 'command', unit: '' }]
};

test('an FMU card lists one row per port in the FMU\'s order, each binding found by key, whatever order the file and the drags left', () => {
    // Reopened (the file leaves out what reads nothing), then setpoint connected before measurement: [setpoint, measurement].
    const bindings = [
        { key: 'setpoint', kind: 'state', nodeId: 1, stateId: 2 },
        { key: 'measurement', kind: 'state', nodeId: 10, stateId: 11 }
    ];
    const rows = fmuInputRows(pidPorts.inputs, bindings);
    assert.deepEqual(rows.map((row) => row.key), ['measurement', 'setpoint', 'ti', 'k']);
    assert.deepEqual(rows.map((row) => row.index), [1, 0, -1, -1]);
    assert.deepEqual(rows[2].binding, { key: 'ti', kind: 'state', stateId: null }, 'A port the file left out reads nothing: the FMU\'s own start.');
    // A binding the FMU has no port for (an older FMU's input) keeps a row, after the ports.
    assert.deepEqual(fmuInputRows(pidPorts.inputs, [{ key: 'gone', kind: 'value', value: 1 }]).map((row) => row.key), ['measurement', 'setpoint', 'ti', 'k', 'gone']);
});

test('an FMU row\'s change written after the list changed under it still writes its own input, never another\'s', () => {
    // The reported sequence: built from the FMU, saved and reopened (compacted), setpoint then measurement connected by dragging.
    let implementation = structuredClone(implementationForFile(fmiImplementation('pid', '1.0.0', pidPorts)));
    for (const [key, nodeId, stateId] of [['setpoint', 1, 2], ['measurement', 10, 11]]) {
        implementation.bindings = bindPort(implementation.bindings, key, { kind: 'state', nodeId, stateId });
    }
    // The card drawn now: the measurement row was drawn with its binding at place 1.
    const measurementRow = fmuInputRows(pidPorts.inputs, implementation.bindings).find((row) => row.key === 'measurement');
    // Before its change lands, the list is reordered (as the card's ports arriving used to re-sort it) and k given a value.
    implementation.bindings = [...implementation.bindings].reverse();
    implementation.bindings = bindPort(implementation.bindings, 'k', { kind: 'value', value: 2 });
    // The stale row's change: measurement now reads Room.heater.
    implementation.bindings = bindPort(implementation.bindings, measurementRow.key, { kind: 'state', nodeId: 10, stateId: 12 }, measurementRow.index);
    const keys = implementation.bindings.map((binding) => binding.key);
    assert.equal(new Set(keys).size, keys.length, 'No input is written twice.');
    const nodes = [{ id: 1, name: 'Setpoint', states: [{ id: 2, symbol: 'setpoint' }] }, { id: 10, name: 'Room', states: [{ id: 11, symbol: 'temperature' }, { id: 12, symbol: 'heater' }] }];
    const box = fmuBoxPorts({ implementation, states: [] }, pidPorts, nodes);
    assert.deepEqual(box.inputs.map((input) => `${input.key}: ${input.reads?.text ?? 'start'}`), ['measurement: Room.heater', 'setpoint: Setpoint.setpoint']);
    assert.deepEqual(nodeProgramErrors(implementation, { id: 20, states: [] }, nodes, []).inputs.flat(), [], 'No "two inputs are called" error.');
});

test('the project window writes program and FMU bindings by key, and never reorders an FMU\'s bindings outside undo', async () => {
    const renderer = await readFile(new URL('../src/renderer/renderer.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(renderer, /implementation\.bindings\[index\]/, 'A row writes the binding it was drawn for by its key, not its drawn place.');
    assert.doesNotMatch(renderer, /implementation\.outputs\[index\]/, 'An output row writes by its key, not its drawn place.');
    assert.doesNotMatch(renderer, /bindings\.splice\(index, 1\)/, 'A row removes the entry it was drawn for, not whatever stands at its place.');
    const fmus = renderer.slice(renderer.indexOf('async function renderNodeProgramFmus('), renderer.indexOf('function megabytes('));
    assert.doesNotMatch(fmus, /\.bindings\s*=/, 'Showing an FMU\'s ports does not change its node\'s bindings.');
    assert.doesNotMatch(fmus, /\.sort\(/, 'Showing an FMU\'s ports does not re-sort its node\'s bindings.');
});
