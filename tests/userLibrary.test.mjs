/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { remapGraphFragment } from '../src/graphClipboard.mjs';
import { buildUserTemplate, changeUserTemplate, UnstorableSelectionError, userTemplateId } from '../src/userLibrary.mjs';

// A plant, and a controller whose C++ program reads the plant's state and a shared parameter, with a relationship between.
const appearance = { type: 'primitive', shape: 'box', color: '#123456' };
const documentWith = (controller = {}) => ({
    format: 'konjugate', version: 1,
    sharedParameters: [{ id: 50, name: 'Setpoint', symbol: 'setpoint', value: 1, mode: 'live', control: { minimum: 0, maximum: 5, step: 0.1 } }, { id: 51, name: 'Unused', symbol: 'unused', value: 0 }],
    nodes: [
        { id: 1, name: 'Plant', position: [4, 0, 2], subsystemId: 90, states: [{ id: 2, name: 'Level', symbol: 'level', initialValue: 0 }], sourceTerms: [], appearance },
        {
            id: 10, name: 'Controller', position: [6, 0, 4], states: [{ id: 11, name: 'Measurement', symbol: 'measurement', initialValue: 0 }, { id: 12, name: 'Output', symbol: 'output', initialValue: 0 }], sourceTerms: [], appearance,
            implementation: {
                kind: 'cpp', providerApiVersion: 1, source: 'int x;',
                bindings: [{ key: 'measurement', kind: 'state', nodeId: 1, stateId: 2 }, { key: 'setpoint', kind: 'parameter', sharedParameterId: 50 }],
                outputs: [{ key: 'control', stateId: 12, setsValue: true }]
            },
            ...controller
        }
    ],
    edges: [{
        id: 20, groupId: 70, name: 'Actuation', source: { nodeId: 10, stateId: 12 }, target: { nodeId: 1, stateId: 2 }, parameters: [],
        equationModel: { latex: 'x', output: { role: 'target', stateId: 2 }, bindings: [{ kind: 'state', role: 'source', nodeId: 10, stateId: 12, symbol: 'x' }], mathJson: 'x' },
        appearance: { color: '#abcdef', offset: 0, waypoints: [[1, 2, 3]] }
    }]
});

test('a selection becomes a template that stands alone, centred, with what it linked to', () => {
    const template = buildUserTemplate({ document: documentWith(), selectedNodeIds: [1, 10], name: '  Level control  ', description: 'Holds a level.', section: ['Control', 'Loops'] });
    assert.equal(template.kind, 'fragment');
    assert.equal(template.id, 'user_level_control');
    assert.equal(template.name, 'Level control');
    assert.deepEqual(template.section, ['Control', 'Loops']);
    assert.equal(template.description, 'Holds a level.');
    assert.deepEqual(template.domains, ['custom']);
    assert.equal(template.color, '#123456');
    // The shared parameter it links to travels with it, the one it does not link to does not, and it is made afresh each time.
    assert.deepEqual(template.fragment.sharedParameters.map(({ symbol, scope }) => [symbol, scope]), [['setpoint', 'instance']]);
    // Centred on its own middle, out of the subsystem and the edge group it was in, and without the route its edge took.
    assert.deepEqual(template.fragment.nodes.map(({ position }) => position), [[-1, 0, -1], [1, 0, 1]]);
    assert.ok(template.fragment.nodes.every((node) => !('subsystemId' in node)));
    assert.ok(template.fragment.edges.every((edge) => !('groupId' in edge) && edge.appearance.waypoints.length === 0));
});

test('what the template was made from is untouched, and what it holds shares nothing with it', () => {
    const document = documentWith();
    const before = structuredClone(document);
    const template = buildUserTemplate({ document, selectedNodeIds: [1, 10], name: 'A' });
    assert.deepEqual(document, before);
    template.fragment.nodes[0].name = 'changed';
    assert.equal(document.nodes[0].name, 'Plant');
});

test('placing a saved template gives its program the new ids of what it reads', () => {
    const template = buildUserTemplate({ document: documentWith(), selectedNodeIds: [1, 10], name: 'A' });
    const placed = remapGraphFragment(template.fragment, 1000, [0, 0, 0], { nameSuffix: '' });
    const controller = placed.nodes.find((node) => node.name === 'Controller');
    const plant = placed.nodes.find((node) => node.name === 'Plant');
    const [measurement, setpoint] = controller.implementation.bindings;
    assert.deepEqual([measurement.nodeId, measurement.stateId], [plant.id, plant.states[0].id]);
    assert.equal(setpoint.sharedParameterId, placed.sharedParameters[0].id);
});

test('a selection that reads something outside it is refused, saying what and whose', () => {
    assert.throws(() => buildUserTemplate({ document: documentWith(), selectedNodeIds: [10], name: 'A' }), (error) => {
        assert.ok(error instanceof UnstorableSelectionError);
        assert.match(error.problems.join(' '), /Node "Controller" refers to the node "Plant"/);
        assert.match(error.problems.join(' '), /the state "Level" of the node "Plant"/);
        return true;
    });
});

test('a selection that uses something installed on one machine is refused', () => {
    const fmu = { implementation: { kind: 'fmi', fmuId: 'guid', fmuVersion: '1', bindings: [], outputs: [] } };
    assert.throws(() => buildUserTemplate({ document: documentWith(fmu), selectedNodeIds: [1, 10], name: 'A' }), /not inline cpp or python source/);
});

test('a template needs a name, a usable section and something selected', () => {
    assert.throws(() => buildUserTemplate({ document: documentWith(), selectedNodeIds: [1], name: '   ' }), /needs a name/);
    assert.throws(() => buildUserTemplate({ document: documentWith(), selectedNodeIds: [1], name: 'A', section: ['a/b'] }), /cannot contain/);
    assert.throws(() => buildUserTemplate({ document: documentWith(), selectedNodeIds: [], name: 'A' }), /Select at least one node/);
});

test('an id comes from the name and avoids the ones taken', () => {
    assert.equal(userTemplateId('My Pump (v2)!', []), 'user_my_pump_v2');
    assert.equal(userTemplateId('My Pump', ['user_my_pump', 'user_my_pump_2']), 'user_my_pump_3');
    assert.equal(userTemplateId('???', []), 'user_template');
    assert.match(userTemplateId('Ünïcödé', []), /^user_[a-z0-9_]+$/);
});

test('a template can be renamed, described and moved, keeping everything else', () => {
    const template = buildUserTemplate({ document: documentWith(), selectedNodeIds: [1, 10], name: 'A', description: 'old', section: ['One'] });
    const changed = changeUserTemplate(template, { name: 'B', description: '', section: ['Two', 'Deeper'] });
    assert.equal(changed.id, template.id);
    assert.deepEqual([changed.name, changed.section, 'description' in changed], ['B', ['Two', 'Deeper'], false]);
    assert.deepEqual(changed.fragment, template.fragment);
    assert.deepEqual(changeUserTemplate(changed, { section: [] }).section, undefined);
    assert.equal(changeUserTemplate(template, { name: 'C' }).description, 'old');
    assert.throws(() => changeUserTemplate(template, { name: ' ' }), /needs a name/);
});
