/* Copyright © 2026 Zenin Easa Panthakkalakath */

// FMU nodes and component instances as boxes with ports (docs/proposals/rootPorts.md, stage 5): their terminals, what each says,
// and what a drag writes: an FMU input's binding, or a one-way relationship setting an Update.

import assert from 'node:assert/strict';
import test from 'node:test';
import { fmuBoxPorts, fmuInputBinding, inputTerminalText, instanceBoxPorts, settingRefusal, settingRelationship } from '../src/boxPorts.mjs';

const room = { id: 1, title: 'Room', states: [{ id: 2, label: 'Temperature', symbol: 'temperature', initialValue: 18, unit: '°C', kind: 'rate' }, { id: 3, label: 'Heater', symbol: 'heater', initialValue: 0, unit: '', kind: 'update' }], sourceTerms: [] };
const pid = {
    id: 5, title: 'PidController', states: [{ id: 6, label: 'command', symbol: 'command', initialValue: 0, unit: '', kind: 'update' }], sourceTerms: [],
    implementation: { kind: 'fmi', fmuId: 'g', fmuVersion: '1', bindings: [{ key: 'measurement', kind: 'state', nodeId: 1, stateId: 2 }, { key: 'k', kind: 'value', value: 2 }], outputs: [{ key: 'command', stateId: 6, setsValue: true }] }
};
const ports = {
    inputs: [
        { key: 'setpoint', name: 'setpoint', causality: 'input', unit: '°C', start: 20 },
        { key: 'measurement', name: 'measurement', causality: 'input', unit: '°C', start: 20 },
        { key: 'k', name: 'k', causality: 'parameter', variability: 'tunable', start: 0.5 }
    ],
    outputs: [{ key: 'command', name: 'command', unit: '' }]
};

test('an FMU node\'s terminals are its inputs, each with what it reads, and its outputs, each with its state; its parameters stay on its card', () => {
    const terminals = fmuBoxPorts(pid, ports, [room, pid]);
    assert.deepEqual(terminals.inputs.map((input) => [input.key, input.unit, input.reads?.text ?? null]), [['setpoint', '°C', null], ['measurement', '°C', 'Room.temperature']]);
    assert.deepEqual(terminals.outputs, [{ key: 'command', name: 'command', unit: '', stateId: 6 }]);
    assert.deepEqual(fmuBoxPorts(room, ports), { inputs: [], outputs: [] }, 'A node that is not an FMU has none.');
    assert.deepEqual(fmuBoxPorts(pid, null), { inputs: [], outputs: [] }, 'Nor does an FMU whose ports are not known yet.');
});

test('an input says the FMU\'s own start when it reads nothing, and when it reads a state, that it is read a step late', () => {
    const [setpoint, measurement] = fmuBoxPorts(pid, ports, [room, pid]).inputs;
    assert.equal(inputTerminalText(setpoint, { kind: 'fmu', startText: '20 °C' }).detail, 'the FMU\'s own start · 20 °C');
    const reading = inputTerminalText(measurement, { kind: 'fmu' });
    assert.equal(reading.detail, 'reads Room.temperature');
    assert.match(reading.tooltip, /at the start of each step: one step late/);
    assert.equal(inputTerminalText({ name: 'setpoint', connected: false }, { kind: 'instance', startText: '20 °C' }).detail, 'nothing connected · stays at 20 °C');
    assert.equal(inputTerminalText({ name: 'setpoint', connected: true }, { kind: 'instance' }).detail, 'connected');
});

test('an instance\'s terminals are its declared ports: in ports left, out ports and ports both ways right', () => {
    const terminals = instanceBoxPorts([
        { key: 1, name: 'setpoint', unit: '°C', stateId: 11, nodeId: 10, direction: 'in', declared: true, connected: false },
        { key: 2, name: 'command', unit: '', stateId: 13, nodeId: 12, direction: 'out', declared: true, connected: true },
        { key: 3, name: 'flow', unit: '', stateId: 15, nodeId: 14, direction: 'both', declared: true, connected: false },
        { stateId: 16, nodeId: 14, name: 'derived', direction: 'both', declared: false, connected: true }
    ]);
    assert.deepEqual(terminals.inputs.map((port) => port.key), [1]);
    assert.deepEqual(terminals.outputs.map((port) => port.key), [2, 3], 'A port found only from what is connected is not a terminal.');
});

test('a drag to an FMU input writes the binding Connect to… writes', () => {
    assert.deepEqual(fmuInputBinding('setpoint', { nodeId: 1, stateId: 2 }), { key: 'setpoint', kind: 'state', nodeId: 1, stateId: 2 });
});

test('a value set on an Update is a one-way relationship written as the editor writes one; a Rate, or an Update already set, is refused', () => {
    const edge = settingRelationship({ id: 40, source: { nodeId: 5, stateId: 6 }, target: { nodeId: 1, stateId: 3 }, nodes: [room, pid] });
    assert.equal(edge.name, 'Room.heater = PidController.command');
    assert.deepEqual([edge.directionality, edge.equation, edge.equationModel.mathJson], ['directed', '\\mathrm{sourceCommand}', 'sourceCommand']);
    assert.deepEqual(edge.equationModel.bindings, [{ kind: 'state', role: 'source', nodeId: 5, stateId: 6, symbol: 'sourceCommand' }]);
    assert.deepEqual(edge.equationModel.output, { role: 'target', stateId: 3 });
    assert.equal(settingRefusal({ nodeId: 1, stateId: 3 }, [room, pid], []), null);
    assert.match(settingRefusal({ nodeId: 1, stateId: 2 }, [room, pid], []), /^Room\.temperature is a Rate: a relationship would add to its rate, not set it/);
    const existing = { id: 41, title: 'Heat', source: 5, sourceStateId: 6, target: 1, targetStateId: 3, directionality: 'directed', equationModel: { latex: 'x', output: { role: 'target', stateId: 3 } } };
    assert.match(settingRefusal({ nodeId: 1, stateId: 3 }, [room, pid], [existing]), /is already set by “Heat”/);
    assert.equal(settingRefusal({ nodeId: 1, stateId: 99 }, [room, pid], []), 'That state is no longer there.');
});
