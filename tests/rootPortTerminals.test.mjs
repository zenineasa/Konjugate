/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Root port terminals (docs/proposals/rootPorts.md, stage 2): what each says, where it stands, and the node Add › Input port
// and Output port make.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    layoutRootPortTerminals, placedTerminalPositions, portBadge, portCountText, portNodeDocument, portSide, portSymbolFromName, rootPortStatus, rootPortTerminalText
} from '../src/rootPortTerminals.mjs';

const port = (key, direction, extra = {}) => ({ key, nodeId: 10 + key, stateId: 20 + key, name: `p${key}`, symbol: `s${key}`, unit: '°C', direction, reached: false, startValue: 20, ...extra });

test('an in port nothing reaches says it stays at its start; one reached, or an out port, names its state', () => {
    assert.equal(rootPortStatus(port(1, 'in'), '20 °C'), 'nothing connected · stays at 20 °C');
    assert.equal(rootPortStatus(port(1, 'both'), '20 °C'), 'nothing connected · stays at 20 °C', 'A port both ways takes a value from outside too.');
    assert.equal(rootPortStatus(port(1, 'in', { reached: true }), '20 °C'), '');
    assert.equal(rootPortStatus(port(1, 'out'), '20 °C'), '');
    const text = rootPortTerminalText(port(1, 'in', { name: 'setpoint' }), { startText: '20 °C' });
    assert.deepEqual([text.badge, text.name, text.detail], ['→ In', 'setpoint', 'nothing connected · stays at 20 °C']);
    assert.match(text.tooltip, /^Input port “setpoint”, offering s1 \(°C\) outside\. When this model runs on its own, nothing is connected to it, so it stays at 20 °C\./);
    const out = rootPortTerminalText(port(2, 'out', { unit: '' }), { startText: '0' });
    assert.deepEqual([out.badge, out.detail], ['Out →', 's2']);
    assert.equal(portBadge('both'), '⇄ Both');
    assert.deepEqual(['in', 'out', 'both'].map(portSide), ['left', 'right', 'right']);
});

test('terminals stand beyond the model, in ports left and the others right, stacked by their nodes\' heights', () => {
    const ports = [port(1, 'in'), port(2, 'in'), port(3, 'out'), port(4, 'both')];
    const heights = { 11: -2, 12: 3, 13: 0, 14: 1 };
    const layout = layoutRootPortTerminals(ports, { bounds: { min: [-5, -3, 0], max: [5, 3, 0], centre: [0, 0, 0] }, nodeHeight: (id) => heights[id] });
    assert.deepEqual(layout.get(2), { position: [-9, 0.675, 0], side: 'left' }, 'The higher node\'s terminal is higher.');
    assert.deepEqual(layout.get(1), { position: [-9, -0.675, 0], side: 'left' });
    assert.deepEqual(layout.get(4).position, [9, 0.675, 0]);
    assert.deepEqual(layout.get(3).position, [9, -0.675, 0]);
    const lone = layoutRootPortTerminals([port(5, 'out')], { bounds: { min: [0, 0, 0], max: [0, 0, 0], centre: [0, 0, 0] } });
    assert.deepEqual(lone.get(5).position, [4, 0, 0], 'One terminal on a side stands level with the middle.');
    const down = layoutRootPortTerminals([port(1, 'in'), port(2, 'in')], { bounds: { min: [0, 0, 0], max: [0, 0, 0], centre: [0, 0, 0] }, stackAxis: 2, stackSign: -1, nodeHeight: (id) => (id === 11 ? 1 : 0) });
    assert.deepEqual([down.get(1).position, down.get(2).position], [[-4, 0, 0.675], [-4, 0, -0.675]], 'Looked down on, terminals stack along z.');
});

test('a terminal put somewhere stays there, and is put back to the layout with its entry gone', () => {
    const saved = placedTerminalPositions(undefined, 2, [1, 2, 3]);
    assert.deepEqual(saved, [{ portKey: 2, position: [1, 2, 3] }]);
    const layout = layoutRootPortTerminals([port(1, 'in'), port(2, 'out')], { bounds: { min: [0, 0, 0], max: [0, 0, 0], centre: [0, 0, 0] }, saved: [...saved, { portKey: 1, position: [Number.NaN, 0, 0] }] });
    assert.deepEqual(layout.get(2).position, [1, 2, 3]);
    assert.deepEqual(layout.get(1).position, [-4, 0, 0], 'An entry that cannot be used is passed over.');
    assert.deepEqual(placedTerminalPositions(saved, 2, [4, 5, 6]), [{ portKey: 2, position: [4, 5, 6] }]);
    assert.equal(placedTerminalPositions(saved, 2, null), undefined, 'Nothing placed: the field is left out.');
});

test('the node a new port makes holds one state named for it, with a symbol made from its name', () => {
    assert.equal(portSymbolFromName('Room temperature'), 'roomTemperature');
    assert.equal(portSymbolFromName('2nd input'), 'u2ndInput');
    assert.equal(portSymbolFromName('heater command', 'out'), 'heaterCommand');
    assert.equal(portSymbolFromName('Température'), 'temperature');
    assert.equal(portSymbolFromName('°', 'out'), 'y');
    const node = portNodeDocument({ name: ' setpoint ', unit: '°C', direction: 'in', position: [-3, 0, 0], ids: { nodeId: 7, stateId: 8 } });
    assert.deepEqual(node.states, [{ id: 8, name: 'setpoint', symbol: 'setpoint', initialValue: 0, unit: '°C', kind: 'update' }]);
    assert.equal(node.name, 'setpoint');
    assert.equal(portNodeDocument({ name: '', direction: 'out', position: [0, 0, 0], ids: { nodeId: 1, stateId: 2 }, saysKinds: false }).states[0].kind, undefined, 'In a model that says no kinds, the state says none either.');
    assert.equal(portCountText([port(1, 'in'), port(2, 'in'), port(3, 'out')]), '2 in, 1 out');
    assert.equal(portCountText([port(1, 'both')]), '1 in and out');
    assert.equal(portCountText([]), '');
});

test('the component bar says a model\'s interface, and what saving an interface change will ask of the models linked to it', async () => {
    const { componentInterfaceLine, linkedChangeWarning } = await import('../src/rootPortTerminals.mjs');
    assert.equal(componentInterfaceLine('PID controller', [port(1, 'in'), port(2, 'in'), port(3, 'out')], 3), 'PID controller is a component: 2 in ports, 1 out port, 3 exposed parameters.');
    assert.equal(componentInterfaceLine('Plant', [port(1, 'both')], 1), 'Plant is a component: 1 port in and out, 1 exposed parameter.');
    assert.equal(componentInterfaceLine('Model', []), 'Model is a component: no ports yet.');
    assert.equal(linkedChangeWarning([]), '');
    const removed = [{ kind: 'port', key: 2, name: 'measurement', change: 'removed' }];
    assert.equal(linkedChangeWarning(removed), 'Saving changes its interface: models that link this file will be asked about removing ‘measurement’.');
    assert.equal(linkedChangeWarning(removed, ['Heated room']), 'Saving changes its interface: 1 open project linked to this file (Heated room) will be asked about removing ‘measurement’.');
    assert.equal(linkedChangeWarning([...removed, { kind: 'port', key: 1, name: 'setpoint', change: 'changed' }], ['Heated room', 'Office', 'Lab']),
        'Saving changes its interface: 3 open projects linked to this file (Heated room, Office and Lab) will be asked about removing ‘measurement’ and the change to ‘setpoint’.');
});
