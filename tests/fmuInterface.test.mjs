/* Copyright © 2026 Zenin Easa Panthakkalakath */

// FMU export with a declared interface (docs/proposals/rootPorts.md, stage 4): in ports are inputs, out ports outputs, exposed
// parameters tunable parameters, every other state a local; value references follow the interface; refusals said with why.

import assert from 'node:assert/strict';
import test from 'node:test';
import { exposeBakedParameters, fmuExportInterface, fmuInterfaceSummary } from '../src/fmuInterface.mjs';
import { describeFmu } from '../src/fmiExport.mjs';
import { generateFmiModel } from '../src/fmiCodeGen.mjs';
import { executionProjectDocument } from '../src/subsystems.mjs';
import { stripEdgeGroups } from '../src/edgeGroups.mjs';
import { portsDocument } from './engine/fixtures/fmuPortsFixture.mjs';

const flat = (document) => stripEdgeGroups(executionProjectDocument(document));

test('a project\'s ports are its FMU\'s interface: in ports inputs, out ports outputs, exposed parameters, and what is baked', () => {
    const fmuInterface = fmuExportInterface(portsDocument);
    assert.deepEqual(fmuInterface.inputs.map((port) => [port.key, port.name, port.unit]), [[1, 'setpoint', 'degC'], [2, 'measurement', 'degC']]);
    assert.deepEqual(fmuInterface.outputs.map((port) => [port.key, port.name]), [[3, 'command']]);
    assert.deepEqual(fmuInterface.parameters, [{ sharedParameterId: 30, symbol: 'g', name: 'Gain', unit: '1/s', value: 0.5 }]);
    assert.deepEqual(fmuInterface.problems, []);
    assert.deepEqual(fmuInterface.baked, { constant: 1, live: 1 }, 'The counter\'s constant and live rates are baked; the gain, exposed, is not.');
    const { component, ...withoutPorts } = portsDocument;
    assert.equal(component.ports.length, 3);
    assert.equal(fmuExportInterface(withoutPorts), null, 'A project without ports has no interface: its export is as before.');
});

test('an in port the FMU cannot hold as an input is refused, naming it and why', () => {
    const rate = structuredClone(portsDocument);
    rate.nodes[0].states[0].kind = 'rate';
    assert.match(fmuExportInterface(rate).problems[0], /^“setpoint” is an in port on a Rate state: .* Make setpoint an Update, or make the port an out port\.$/);
    const setInside = structuredClone(portsDocument);
    setInside.edges.push({ ...structuredClone(portsDocument.edges[0]), id: 203, name: 'Feedback', source: { nodeId: 3, stateId: 13 }, target: { nodeId: 2, stateId: 12 },
        equationModel: { ...structuredClone(portsDocument.edges[0].equationModel), output: { role: 'target', stateId: 12 } } });
    assert.match(fmuExportInterface(setInside).problems[0], /^“measurement” is an in port that the model also sets inside/);
    assert.throws(() => generateFmiModel(flat(rate), { fmuInterface: fmuExportInterface(rate) }), /cannot be exported as an FMU's interface: “setpoint” is an in port on a Rate state/);
    const both = structuredClone(portsDocument);
    both.component.ports[2].direction = undefined;
    delete both.component.ports[2].direction;
    assert.deepEqual(fmuExportInterface(both).bothWays, ['command'], 'A port both ways is an output, and said so.');
});

test('value references follow the interface: outputs, inputs, exposed parameters, then locals; renaming a port moves none', () => {
    const fmuInterface = fmuExportInterface(portsDocument);
    const { stateVariables, parameterVariables, outputCount } = generateFmiModel(flat(portsDocument), { fmuInterface });
    assert.deepEqual(stateVariables.map(({ name, valueReference, causality }) => [name, valueReference, causality]), [
        ['setpoint', 1, 'input'], ['measurement', 2, 'input'], ['command', 0, 'output'], ['Counter.Count', 4, 'local']
    ]);
    assert.deepEqual(parameterVariables.map(({ name, valueReference, causality, variability, start }) => [name, valueReference, causality, variability, start]), [['g', 3, 'parameter', 'tunable', 0.5]]);
    assert.equal(outputCount, 1);
    const renamed = structuredClone(portsDocument);
    renamed.component.ports[0].name = 'reference';
    renamed.nodes.push({ id: 5, name: 'Extra', states: [{ id: 15, name: 'Extra', symbol: 'extra', initialValue: 0, kind: 'rate' }], sourceTerms: [] });
    const again = generateFmiModel(flat(renamed), { fmuInterface: fmuExportInterface(renamed) });
    assert.deepEqual(again.stateVariables.filter((variable) => variable.causality !== 'local').map(({ name, valueReference }) => [name, valueReference]),
        [['reference', 1], ['measurement', 2], ['command', 0]], 'A rename and a new state leave the interface\'s value references where they were.');
    assert.equal(again.parameterVariables[0].valueReference, 3);
});

test('the source holds a host\'s input as its port\'s state, reads the exposed gain from one member, and bakes the rest', () => {
    const { source } = generateFmiModel(flat(portsDocument), { fmuInterface: fmuExportInterface(portsDocument) });
    assert.match(source, /case 1: inputValue_1 = value; state_\[0\] = value; break;/);
    assert.match(source, /case 2: inputValue_2 = value; state_\[1\] = value; break;/);
    assert.match(source, /case 3: parameterValue_3 = value; break;/);
    assert.match(source, /double inputValue_1 = 20\.0;/);
    assert.equal((source.match(/parameterValue_3/g) ?? []).length >= 3, true, 'Both relationships read the one exposed gain.');
    assert.doesNotMatch(source, /parameterValue_(?!3)\d/, 'No other parameter is a member: the counter\'s rates are baked.');
    assert.match(source, /case 4: return state_\[3\];/, 'A local is readable.');
});

test('modelDescription.xml lists the interface in value reference order, its outputs alone as outputs, in both FMI versions', () => {
    const fmuInterface = fmuExportInterface(portsDocument);
    const fmi2 = describeFmu(flat(portsDocument), 'Ported', { fmuInterface }).xml;
    const names = [...fmi2.matchAll(/<ScalarVariable name="([^"]+)" valueReference="(\d+)" causality="(\w+)"/g)].map((match) => [match[1], Number(match[2]), match[3]]);
    assert.deepEqual(names, [['command', 0, 'output'], ['setpoint', 1, 'input'], ['measurement', 2, 'input'], ['g', 3, 'parameter'], ['Counter.Count', 4, 'local']]);
    assert.match(fmi2, /<Outputs>\n {12}<Unknown index="1"\/>\n {8}<\/Outputs>/);
    assert.match(fmi2, /name="Counter.Count" valueReference="4" causality="local" variability="continuous" initial="exact">/);
    assert.match(fmi2, /name="setpoint" valueReference="1" causality="input" variability="continuous">/);
    const fmi3 = describeFmu(flat(portsDocument), 'Ported', { fmuInterface, fmiVersion: '3.0' });
    assert.match(fmi3.xml, /<Float64 name="time" valueReference="5" causality="independent"/);
    assert.deepEqual([...fmi3.xml.matchAll(/<Output valueReference="(\d+)"\/>/g)].map((match) => Number(match[1])), [0]);
    assert.match(fmi3.source, /fmi3OutputCount = 1;/);
    assert.match(fmi3.source, /fmi3TimeValueReference = 5;/);
});

test('a model without ports exports exactly as before', () => {
    const { component, ...withoutPorts } = portsDocument;
    assert.ok(component);
    const before = describeFmu(flat(withoutPorts), 'Plain');
    assert.deepEqual(describeFmu(flat(withoutPorts), 'Plain', { fmuInterface: null }), before);
    assert.match(before.xml, /name="Setpoint.Setpoint" valueReference="0" causality="output"/, 'Every state an output, as today.');
});

test('the dialog says what a host gets, and Expose them makes the baked constant parameters tunable', () => {
    const fmuInterface = fmuExportInterface(portsDocument);
    assert.equal(fmuInterfaceSummary(fmuInterface, { stateCount: 4, globalTimeStep: 0.1 }),
        'Inputs: setpoint (degC), measurement (degC) · Outputs: command · Parameters: g (tunable) · 1 other state observable · Steps: whole multiples of 0.1 s');
    let id = 500;
    const exposed = exposeBakedParameters(portsDocument, () => id++);
    const made = exposed.sharedParameters.find((shared) => shared.id === 500);
    assert.deepEqual(made, { id: 500, name: 'Base rate', symbol: 'a', value: 1, unit: '', mode: 'constant', exposed: true });
    assert.equal(exposed.nodes[3].sourceTerms[0].parameters[0].sharedParameterId, 500);
    assert.equal(exposed.nodes[3].sourceTerms[0].parameters[1].sharedParameterId, undefined, 'A live parameter stays a knob.');
    assert.deepEqual(fmuExportInterface(exposed).baked, { constant: 0, live: 1 });
    assert.deepEqual(fmuExportInterface(exposed).parameters.map((parameter) => parameter.symbol), ['g', 'a']);
    const clash = structuredClone(portsDocument);
    clash.sharedParameters.push({ id: 31, name: 'A', symbol: 'a', value: 2, mode: 'live' });
    assert.equal(exposeBakedParameters(clash, () => 600).sharedParameters.find((shared) => shared.id === 600).symbol, 'a2', 'A symbol already taken is numbered.');
});
