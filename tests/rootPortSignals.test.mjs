/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Test signals for in ports (docs/proposals/rootPorts.md, stage 6): kept on the project's own port, said in `requires`, applied by the
// host only when the project itself runs; never in an instance placed elsewhere, nor in an FMU export.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyRootPortSignals, contentForEngine, placeComponent, rootPortRequires, rootPortSignalProblem, rootPortSignalUsable, rootPorts, setRootPortSignal
} from '../src/components.mjs';
import { describeFmu } from '../src/fmiExport.mjs';
import { fmuExportInterface } from '../src/fmuInterface.mjs';
import { executionProjectDocument } from '../src/subsystems.mjs';
import { stripEdgeGroups } from '../src/edgeGroups.mjs';
import { portsDocument } from './engine/fixtures/fmuPortsFixture.mjs';

const step = { kind: 'schedule', interpolation: 'hold', samples: [[0, 20], [1, 21]] };

test('a port\'s signal is a constant or a schedule, kept on the port; anything else is refused, said why', () => {
    const constant = setRootPortSignal(portsDocument, 1, { kind: 'constant', value: '21' });
    assert.deepEqual(constant.component.ports[0], { key: 1, stateId: 11, name: 'setpoint', direction: 'in', signal: { kind: 'constant', value: 21 } });
    assert.deepEqual(setRootPortSignal(constant, 1, null).component.ports[0], portsDocument.component.ports[0], 'Taken off, the port is as it was.');
    assert.deepEqual(setRootPortSignal(portsDocument, 1, step).component.ports[0].signal, step);
    assert.match(rootPortSignalProblem({ kind: 'constant', value: 'warm' }), /needs a number/);
    assert.throws(() => setRootPortSignal(portsDocument, 1, { kind: 'schedule', interpolation: 'hold', samples: [[1, 20], [0, 21]] }));
    assert.deepEqual(rootPorts(constant)[0].signal, { kind: 'constant', value: 21 });
    assert.equal(portsDocument.component.ports[0].signal, undefined, 'The document given is not changed.');
});

test('a document with a signal says rootPortSignals in its requires, and one without does not', () => {
    const signalled = setRootPortSignal(portsDocument, 1, step);
    assert.deepEqual(rootPortRequires(['fmuStartValues'], signalled.component), ['fmuStartValues', 'rootPortSignals']);
    assert.deepEqual(rootPortRequires(['fmuStartValues', 'rootPortSignals'], portsDocument.component), ['fmuStartValues']);
    assert.deepEqual(rootPortRequires(undefined, undefined), []);
});

test('a signal is used on an in port on an Update nothing reaches; on any other it is kept and said not to be used', () => {
    const [setpoint, , command] = rootPorts(portsDocument);
    assert.equal(rootPortSignalUsable(setpoint), '');
    assert.match(rootPortSignalUsable(command), /out port/);
    assert.match(rootPortSignalUsable({ ...setpoint, kind: 'rate' }), /is a Rate/);
    assert.match(rootPortSignalUsable({ ...setpoint, reached: true }), /set inside the model already/);
});

test('run on its own, a constant sets the port\'s Update and a schedule makes a shared parameter following it; requires is taken off', () => {
    let document = setRootPortSignal(portsDocument, 1, { kind: 'constant', value: 21 });
    document = setRootPortSignal(document, 2, step);
    document.requires = rootPortRequires(document.requires, document.component);
    const applied = applyRootPortSignals(document);
    assert.equal(applied.requires, undefined, 'The host has applied it: the engine never sees the requirement.');
    const [setpointTerm] = applied.nodes[0].sourceTerms;
    assert.deepEqual([setpointTerm.state, setpointTerm.setsValue, setpointTerm.expressionModel.mathJson, setpointTerm.expressionModel.output], ['setpoint', true, 21, { stateId: 11 }]);
    const [measurementTerm] = applied.nodes[1].sourceTerms;
    const shared = applied.sharedParameters.find((item) => item.symbol === 'measurementSignal');
    assert.deepEqual(shared.schedule, { interpolation: 'hold', samples: [[0, 20], [1, 21]] });
    assert.equal(shared.name, 'measurement signal');
    assert.equal(measurementTerm.parameters[0].sharedParameterId, shared.id);
    assert.equal(measurementTerm.expressionModel.mathJson, 'measurementSignal');
    const ids = new Set();
    for (const node of applied.nodes) for (const term of node.sourceTerms) { assert.ok(!ids.has(term.id)); ids.add(term.id); }
    assert.equal(applyRootPortSignals(portsDocument), portsDocument, 'A document without signals is given back as it is.');
    const content = JSON.stringify(portsDocument);
    assert.equal(contentForEngine(content), content, 'Content without signals reaches the engine string for string.');
    assert.equal(JSON.parse(contentForEngine(JSON.stringify(document))).requires, undefined);
});

test('a signal is never applied where the component is placed, nor in its FMU export', () => {
    const signalled = setRootPortSignal(portsDocument, 1, { kind: 'constant', value: 99 });
    const room = { format: 'konjugate', version: 1, nodes: [{ id: 1, name: 'Room', states: [{ id: 2, name: 'T', symbol: 'temperature', initialValue: 18, kind: 'rate' }], sourceTerms: [] }], edges: [] };
    const { document: placed } = placeComponent(room, signalled, { position: [0, 0, 0], name: 'Controller' });
    const run = applyRootPortSignals(placed);
    assert.equal(run, placed, 'The placing project has no signals of its own: nothing is applied.');
    assert.ok(executionProjectDocument(placed).nodes.every((node) => !(node.sourceTerms ?? []).some((term) => term.expressionModel?.mathJson === 99)), 'Outside drives the port.');
    const plain = describeFmu(stripEdgeGroups(executionProjectDocument(portsDocument)), 'C', { fmuInterface: fmuExportInterface(portsDocument) });
    const withSignal = describeFmu(stripEdgeGroups(executionProjectDocument(signalled)), 'C', { fmuInterface: fmuExportInterface(signalled) });
    assert.deepEqual(withSignal, plain, 'The FMU is the same with a signal as without: its host drives its inputs.');
});
