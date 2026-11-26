/* Copyright © 2026 Zenin Easa Panthakkalakath */

// FMU nodes and component instances as boxes with ports (docs/proposals/rootPorts.md, stage 5): their terminals, what each says,
// and what a drag writes: an FMU input's binding, or a one-way relationship setting an Update.

import assert from 'node:assert/strict';
import test from 'node:test';
import { boxDropProblem, distinctPartName, fmuBoxPorts, fmuPortsRetryMs, shouldAskFmuPorts, fmuInputBinding, inputTerminalText, instanceBoxPorts, placementBeside, settingRefusal, settingRelationship } from '../src/boxPorts.mjs';
import { fmiNodeFromPorts } from '../src/nodeProgram.mjs';
import { readFile } from 'node:fs/promises';

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

// ---- A second FMU, or a second instance, beside the first (the bug hunt) -------------------------------------------------------
test('a part placed beside one of the same name is numbered; one named by the person keeps its name', () => {
    assert.equal(distinctPartName('PidController', ['Room', 'Setpoint']), 'PidController');
    assert.equal(distinctPartName('PidController', ['PidController', 'PidController 2']), 'PidController 3');
    const ports = { name: 'PidController', inputs: [], outputs: [{ key: 'command', name: 'command', start: 0 }] };
    const fresh = { id: 9, title: 'New node', states: [] };
    assert.equal(fmiNodeFromPorts(fresh, { guid: 'g', version: '1', ports, newId: () => 10, takenNames: ['PidController'] }).name, 'PidController 2');
    assert.equal(fmiNodeFromPorts({ ...fresh, title: 'My controller' }, { guid: 'g', version: '1', ports, newId: () => 10, takenNames: ['My controller'] }).name, 'My controller', 'Its own name is never changed.');
});

test('placed beside the drawn model, a box stands clear of every label and terminal at the current zoom, never nearer than its step', () => {
    // 40 pixels a unit: the first FMU's label and terminals reach 300 px right of it, so 7.5 units (300 px) was not enough.
    const x = placementBeside({ atX: 2, atScreenX: 900, pixelsPerUnit: 40, drawnRightPx: 1200, minimumStep: 7.5 });
    assert.ok(x > 2 + 7.5, `Placed at ${x}.`);
    const leftTerminalsPx = (x - 0.75 - 2) * 40 - 300;
    assert.ok(leftTerminalsPx >= 230, 'Its input terminals have room right of what is drawn.');
    // Zoomed in, with little drawn right of it, the step is enough on its own.
    assert.equal(placementBeside({ atX: 2, atScreenX: 900, pixelsPerUnit: 100, drawnRightPx: 950, minimumStep: 7.5 }), 9.5);
    // Nothing measured (a hidden canvas): the step.
    assert.equal(placementBeside({ atX: 2, atScreenX: NaN, pixelsPerUnit: 0, drawnRightPx: NaN, minimumStep: 4 }), 6);
});

test('a terminal let go where it connects nothing says so', () => {
    const first = { key: 'n1', name: 'PidController' };
    const second = { key: 'n2', name: 'PidController 2' };
    const setpoint = { key: 'setpoint', name: 'setpoint' };
    const drag = { box: first, role: 'input', terminal: setpoint };
    assert.equal(boxDropProblem(drag, { kind: 'terminal', box: second, role: 'input', terminal: { key: 'measurement', name: 'measurement' } }),
        'Nothing was connected: PidController 2\'s measurement is an input too. Drop PidController\'s setpoint on an output, a node or one of its states.');
    assert.match(boxDropProblem(drag, null), /^Nothing was connected: drop PidController's setpoint on an output/);
    assert.match(boxDropProblem(drag, { kind: 'terminal', box: first, role: 'input', terminal: setpoint }), /let go where it started/);
    assert.equal(boxDropProblem(drag, { kind: 'terminal', box: second, role: 'output', terminal: { key: 'command', name: 'command' } }), '');
    assert.equal(boxDropProblem(drag, { kind: 'node', node: { id: 3 } }), '');
    assert.match(boxDropProblem({ box: first, role: 'output', terminal: { key: 'command', name: 'command' } }, { kind: 'terminal', box: second, role: 'output', terminal: { key: 'command', name: 'command' } }), /is an output too\. Drop PidController's command on an input/);
});

// The bug hunt: a project opened with its results showed its FMU without terminals until the node was edited. Its ports were asked for
// while its FMU was still being installed from the file, the failure was kept, and never asked again.
test('an FMU\'s ports that could not be read are asked for again after a short wait; known ones never', () => {
    assert.equal(shouldAskFmuPorts(undefined, undefined, 0), true, 'Asked at first.');
    assert.equal(shouldAskFmuPorts(undefined, 'pending', 10), false, 'Not twice at once.');
    assert.equal(shouldAskFmuPorts({ error: 'not installed yet' }, 1000, 1000 + fmuPortsRetryMs - 1), false);
    assert.equal(shouldAskFmuPorts({ error: 'not installed yet' }, 1000, 1000 + fmuPortsRetryMs), true, 'A failed lookup is tried again.');
    assert.equal(shouldAskFmuPorts({ inputs: [], outputs: [] }, 1000, 1e9), false, 'Known ports are kept.');
});

test('the project window draws FMU terminals in results mode too, and draws the canvas again when an FMU\'s ports become known', async () => {
    const renderer = await readFile(new URL('../src/renderer/renderer.mjs', import.meta.url), 'utf8');
    const sync = renderer.slice(renderer.indexOf('function syncBoxTerminals('), renderer.indexOf('function syncBoxTerminals(') + 400);
    assert.doesNotMatch(sync, /activeResult/, 'Terminals are drawn whether or not results are open.');
    assert.equal(renderer.split('fmuPortsCache.set(').length - 1, 1, 'Every lookup is kept through rememberFmuPorts, which draws the canvas again.');
});

// The bug hunt: the card offered "this.command" for an FMU's input and accepted it, while a drag of the same output to the same input was
// refused. One rule now: the drag writes the very entry the card writes, and the terminal says what it reads.
test('an FMU\'s own output dragged to its input is the card\'s "this." binding, and its terminal says so', () => {
    assert.deepEqual(fmuInputBinding('measurement', { nodeId: 5, stateId: 6 }, 5), { key: 'measurement', kind: 'state', stateId: 6 });
    assert.deepEqual(fmuInputBinding('measurement', { nodeId: 1, stateId: 2 }, 5), { key: 'measurement', kind: 'state', nodeId: 1, stateId: 2 });
    const node = { id: 5, title: 'PidController', states: [{ id: 6, symbol: 'command' }], implementation: { kind: 'fmi', bindings: [{ key: 'measurement', kind: 'state', stateId: 6 }, { key: 'setpoint', kind: 'state', stateId: null }], outputs: [] } };
    const ports = { inputs: [{ key: 'measurement', causality: 'input' }, { key: 'setpoint', causality: 'input' }], outputs: [] };
    const [measurement, setpoint] = fmuBoxPorts(node, ports, [node]).inputs;
    assert.deepEqual(measurement.reads, { nodeId: 5, stateId: 6, text: 'this.command' });
    assert.equal(setpoint.reads, null, 'One reading nothing keeps the FMU\'s own start.');
});

test('a terminal dropped on a switched-off node is refused, said why', () => {
    const drag = { box: { key: 'n1', name: 'PidController' }, role: 'input', terminal: { key: 'measurement', name: 'measurement' } };
    assert.equal(boxDropProblem(drag, { kind: 'node', node: { id: 3, title: 'Room with Konjugate PI', enabled: false } }),
        'Nothing was connected: Room with Konjugate PI is switched off. Switch it on to connect PidController\'s measurement to it.');
});
