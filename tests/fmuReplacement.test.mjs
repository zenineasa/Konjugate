/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { instanceCount, placeAnotherInstance } from '../src/components.mjs';
import { fmuReplacementPlan, instanceRunByPortName, replaceInstanceWithFmu } from '../src/fmuReplacement.mjs';
import { replacementHost as host } from './fixtures/fmuReplacementHost.mjs';

// The FMU an export of the controller gives, as describeInstalledFmuPorts describes it (FMI 3.0: units said).
const exportedPorts = (changes = {}) => ({
    name: 'PortedController', fmiVersion: '3.0',
    inputs: [
        { key: 'setpoint', name: 'setpoint', causality: 'input', variability: 'continuous', type: 'Float64', unit: 'degC', start: 20 },
        { key: 'measurement', name: 'measurement', causality: 'input', variability: 'continuous', type: 'Float64', unit: 'degC', start: 18 },
        { key: 'g', name: 'g', causality: 'parameter', variability: 'tunable', type: 'Float64', unit: '1/s', start: 0.5 },
        ...(changes.extraInputs ?? [])
    ].map((port) => ({ ...port, ...(changes.inputs?.[port.name] ?? {}) })).filter((port) => !port.gone),
    outputs: [{ key: 'command', name: 'command', type: 'Float64', start: 0 }, ...(changes.extraOutputs ?? [])].map((port) => ({ ...port, ...(changes.outputs?.[port.name] ?? {}) })).filter((port) => !port.gone)
});

test('an instance matched to its FMU by port names lists each port, connection and parameter carried', () => {
    const { document, subsystemId } = host();
    const plan = fmuReplacementPlan(document, subsystemId, exportedPorts());
    assert.equal(plan.ok, true, plan.problems.join(' '));
    assert.deepEqual(plan.rows.map((row) => row.text), [
        'in · setpoint (degC) → FMU input setpoint, reading Thermostat.target',
        'in · measurement (degC) → FMU input measurement, reading Room.temperature',
        'out · command → FMU output command, read by “Drive”',
        'parameter · g = 0.8 (1/s) → FMU parameter g'
    ]);
    assert.deepEqual(plan.notes, []);
    // As the canvas saves a relationship: every symbol it may use listed as a binding, the one it uses its equation.
    const saved = structuredClone(document);
    for (const edge of saved.edges.filter((item) => item.id === 2001 || item.id === 2002)) {
        edge.equationModel.bindings.push({ kind: 'state', role: 'target', nodeId: edge.target.nodeId, stateId: edge.target.stateId, symbol: 'targetPort' }, { kind: 'time', symbol: 't' });
    }
    assert.deepEqual(fmuReplacementPlan(saved, subsystemId, exportedPorts()).rows.map((row) => row.ok), [true, true, true, true]);
});

test('replacing moves every connection to the terminal of the same name and takes the instance away, in one document', () => {
    const { document, subsystemId, port } = host();
    const command = port('command');
    const insideNodeIds = new Set(document.nodes.filter((node) => node.subsystemId === subsystemId).map((node) => node.id));
    const { document: replaced, nodeId } = replaceInstanceWithFmu(document, subsystemId, { fmuPorts: exportedPorts(), guid: 'guid-1', version: '1.0.0' });
    const node = replaced.nodes.find((item) => item.id === nodeId);
    assert.equal(node.name, 'Ported controller', 'The FMU node takes the instance\'s name.');
    assert.deepEqual(node.position, [1, 2, 0], 'and its place.');
    assert.equal(node.subsystemId, undefined);
    assert.equal(node.implementation.fmuId, 'guid-1');
    assert.deepEqual(node.implementation.bindings, [
        { key: 'setpoint', kind: 'state', nodeId: 1001, stateId: 1002 },
        { key: 'measurement', kind: 'state', nodeId: 1003, stateId: 1004 },
        { key: 'g', kind: 'value', value: 0.8 }
    ], 'Each in port\'s source is read by the FMU input of its name; the gain is carried.');
    const output = node.implementation.outputs.find((item) => item.key === 'command');
    assert.equal(node.states.find((state) => state.id === output.stateId).symbol, 'command');
    const drive = replaced.edges.find((edge) => edge.id === 2003);
    assert.deepEqual(drive.source, { nodeId, stateId: output.stateId }, 'What read the out port reads the FMU\'s output.');
    assert.deepEqual(drive.equationModel.bindings[0], { kind: 'state', role: 'source', nodeId, stateId: output.stateId, symbol: 'u' });
    assert.ok(!JSON.stringify(drive).includes(`"stateId":${command.stateId},`), 'Nothing refers to the out port\'s state any more.');
    assert.deepEqual(replaced.edges.map((edge) => edge.id), [2003], 'The setting relationships became bindings; the inside ones went with the instance.');
    assert.equal(replaced.subsystems.length, 0);
    assert.equal((replaced.subsystemDefinitions ?? []).length, 0, 'A definition no instance uses goes.');
    assert.ok(replaced.nodes.every((item) => !insideNodeIds.has(item.id)));
    assert.equal((replaced.sharedParameters ?? []).length, 0, 'The instance\'s own parameters go with it.');
    assert.equal(JSON.stringify(document).includes('guid-1'), false, 'The document given is left as it was (undo keeps it).');
});

test('another instance of the same component keeps its definition', () => {
    const { document, subsystemId } = host();
    const { document: twice } = placeAnotherInstance(document, subsystemId);
    const { document: replaced } = replaceInstanceWithFmu(twice, subsystemId, { fmuPorts: exportedPorts(), guid: 'guid-1', version: '1.0.0' });
    assert.equal(replaced.subsystemDefinitions.length, 1);
    assert.equal(replaced.subsystems.length, 1);
    assert.equal(instanceCount(replaced, replaced.subsystems[0].id), 1);
});

test('a port with no FMU variable of its name, in the wrong direction or another unit refuses, saying why', () => {
    const { document, subsystemId } = host();
    const refused = (changes) => {
        const plan = fmuReplacementPlan(document, subsystemId, exportedPorts(changes));
        assert.equal(plan.ok, false);
        assert.throws(() => replaceInstanceWithFmu(document, subsystemId, { fmuPorts: exportedPorts(changes), guid: 'g', version: '1.0.0' }));
        return plan.problems;
    };
    assert.deepEqual(refused({ inputs: { setpoint: { gone: true } } }), ['In port “setpoint” has no FMU input of the same name.']);
    assert.deepEqual(refused({ inputs: { setpoint: { gone: true } }, extraOutputs: [{ key: 'setpoint', name: 'setpoint' }] }), ['In port “setpoint” is an output of the FMU, not an input.']);
    assert.deepEqual(refused({ outputs: { command: { gone: true } } }), ['Out port “command” has no FMU output of the same name.']);
    assert.deepEqual(refused({ inputs: { measurement: { unit: 'K' } } }), ['“measurement” is in degC here and in K in the FMU.']);
});

test('what would be lost refuses: an in port set through an equation, and a connection to a state that is not a port', () => {
    const { document, subsystemId, port } = host();
    const equation = structuredClone(document);
    const setting = equation.edges.find((edge) => edge.id === 2001);
    setting.equationModel.mathJson = ['Multiply', 2, setting.equationModel.bindings[0].symbol];
    assert.match(fmuReplacementPlan(equation, subsystemId, exportedPorts()).problems[0], /^“setpoint” is set by “.*” through an equation: an FMU input reads a state as it is/);

    const inside = structuredClone(document);
    const counter = inside.nodes.find((node) => node.subsystemId === subsystemId && node.name === 'Counter');
    inside.edges.push({ ...structuredClone(inside.edges.find((edge) => edge.id === 2003)), id: 2004, name: 'Count read', source: { nodeId: counter.id, stateId: counter.states[0].id } });
    assert.deepEqual(fmuReplacementPlan(inside, subsystemId, exportedPorts()).problems,
        ['“Count read” connects to a state inside Ported controller that is not a port: the FMU does not offer it. Make that state a port, or remove “Count read”.']);
    assert.ok(port('setpoint'));
});

test('what loses nothing is said: an FMU variable that is not a port, an unsaid unit, a parameter not carried', () => {
    const { document, subsystemId } = host();
    const plan = fmuReplacementPlan(document, subsystemId, exportedPorts({
        inputs: { setpoint: { unit: undefined }, measurement: { unit: undefined }, g: { gone: true } },
        extraInputs: [{ key: 'offset', name: 'offset', causality: 'input', unit: 'degC', start: 0 }],
        extraOutputs: [{ key: 'error', name: 'error' }]
    }));
    assert.equal(plan.ok, true, plan.problems.join(' '));
    assert.deepEqual(plan.notes, [
        'The FMU does not say the unit of “setpoint”, “measurement” (an FMI 2.0 export says none): taken as the port\'s own.',
        'The FMU\'s input “offset” has no in port here: it keeps the FMU\'s own start.',
        'The FMU\'s output “error” is not a port here: it is offered on the FMU\'s box.',
        'Gain (g) = 0.8 (1/s) has no FMU parameter of the same name: not carried, the FMU keeps its own.'
    ]);
    assert.equal(plan.rows.find((row) => row.kind === 'parameter').ok, false);
});

test('an instance with nothing connected to an in port leaves the FMU input at its own start, and one without ports is refused', () => {
    const { document, subsystemId } = host();
    const loose = structuredClone(document);
    loose.edges = loose.edges.filter((edge) => edge.id !== 2002);
    const plan = fmuReplacementPlan(loose, subsystemId, exportedPorts());
    assert.equal(plan.rows[1].text, 'in · measurement (degC) → FMU input measurement: nothing connected, the FMU\'s own start · 18 (degC)');
    const { document: replaced, nodeId } = replaceInstanceWithFmu(loose, subsystemId, { fmuPorts: exportedPorts(), guid: 'g', version: '1.0.0' });
    assert.deepEqual(replaced.nodes.find((node) => node.id === nodeId).implementation.bindings.map((binding) => binding.key), ['setpoint', 'g']);

    const bare = structuredClone(document);
    bare.subsystemDefinitions[0].document.component.ports = [];
    assert.match(fmuReplacementPlan(bare, subsystemId, exportedPorts()).problems[0], /declares no ports/);
    assert.match(fmuReplacementPlan(document, 12345, exportedPorts()).problems[0], /Only an instance of a component/);
});

test('the instance\'s run by its out ports\' names is what Compare with original compares the FMU with', () => {
    const { document, subsystemId, port } = host();
    const command = port('command');
    const samples = [0, 0.1].map((time, index) => ({ time, states: [{ stateId: command.stateId, value: index * 0.16 }, { stateId: 1006, value: 1 }] }));
    assert.deepEqual(instanceRunByPortName(document, subsystemId, samples, 'Ported controller'), { modelName: 'Ported controller', times: [0, 0.1], outputs: { command: [0, 0.16] } });
    assert.equal(instanceRunByPortName(document, subsystemId, [], 'x'), null);
});
