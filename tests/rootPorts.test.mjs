/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Root ports (docs/proposals/rootPorts.md, stage 1): a project's top-level ports are its own component block, declared,
// renamed, pointed at another state and removed by pure functions; a project without them is untouched byte for byte, and a
// component file an older release wrote keeps its block, keys and ports.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentInterface, declareRootPort, describeComponentDocument, pruneRootPorts, removeRootPort, rootPorts } from '../src/components.mjs';
import { decodeProjectBundle } from '../src/projectFile.mjs';
import { executionProjectDocument } from '../src/subsystems.mjs';
import { nodeFromDocument, nodeToDocument, relationshipFromDocument, relationshipToDocument } from '../src/modelCodec.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));

const state = (id, symbol, initialValue = 0, extra = {}) => ({ id, name: symbol, symbol, initialValue, unit: '°C', ...extra });
const node = (id, name, states) => ({ id, name, position: [0, 0, 0], states, sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#888888' } });

// A controller: setpoint and measurement nodes nothing reaches, an error relationship into the controller's command.
function controller() {
    return {
        format: 'konjugate', version: 1, metadata: { units: 'SI' },
        nodes: [
            node(1, 'Setpoint', [state(2, 'r', 20, { kind: 'update' })]),
            node(3, 'Measurement', [state(4, 'y', 20, { kind: 'update' })]),
            node(5, 'Controller', [state(6, 'u', 0, { kind: 'update', unit: '' })])
        ],
        edges: [{
            id: 10, name: 'Error', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 5, stateId: 6 }, directionality: 'directed',
            equation: 'r', equationModel: { latex: 'r', output: { role: 'target', stateId: 6 } }, parameters: []
        }],
        subsystems: [], edgeGroups: []
    };
}

test('the first root port makes the project\'s component block; later ones take the next key', () => {
    const { document: one, key } = declareRootPort(controller(), { stateId: 2, name: 'setpoint', direction: 'in', componentName: 'PID controller' });
    assert.equal(key, 1);
    assert.deepEqual(one.component, { name: 'PID controller', ports: [{ key: 1, stateId: 2, name: 'setpoint', direction: 'in' }] });
    const { document: two, key: second } = declareRootPort(one, { stateId: 6, direction: 'out' });
    assert.equal(second, 2);
    assert.deepEqual(two.component.ports[1], { key: 2, stateId: 6, direction: 'out' }, 'No name is written until one is given.');
    assert.equal(controller().component, undefined, 'The document given is not changed.');
    assert.equal(declareRootPort(controller(), { stateId: 2 }).document.component.name, 'Model', 'Without a name, the block is the Model\'s.');
});

test('declaring the same state again renames it or changes its direction; with a key it points the port at another state', () => {
    let { document } = declareRootPort(controller(), { stateId: 2, name: 'setpoint', direction: 'in' });
    ({ document } = declareRootPort(document, { stateId: 2, name: 'reference' }));
    assert.deepEqual(document.component.ports, [{ key: 1, stateId: 2, name: 'reference', direction: 'in' }]);
    ({ document } = declareRootPort(document, { stateId: 2, name: '', direction: 'both' }));
    assert.deepEqual(document.component.ports, [{ key: 1, stateId: 2 }], 'An empty name and "both" are left out, as a component port\'s are.');
    ({ document } = declareRootPort(document, { stateId: 4, key: 1 }));
    assert.deepEqual(document.component.ports, [{ key: 1, stateId: 4 }], 'Redirected: same key, another state.');
    ({ document } = declareRootPort(document, { stateId: 2 }));
    assert.throws(() => declareRootPort(document, { stateId: 2, key: 1 }), /already a port/);
    assert.throws(() => declareRootPort(document, { stateId: 99 }), /state of the project/);
    assert.throws(() => declareRootPort(document, { stateId: 2, direction: 'sideways' }), /in, out or both/);
    assert.throws(() => declareRootPort(document, { stateId: 2, key: 7 }), /No port 7/);
});

test('rootPorts describes each port with its state, kind, start value and whether anything reaches it', () => {
    let { document } = declareRootPort(controller(), { stateId: 2, name: 'setpoint', direction: 'in' });
    ({ document } = declareRootPort(document, { stateId: 4, direction: 'in' }));
    ({ document } = declareRootPort(document, { stateId: 6, name: 'command', direction: 'out' }));
    const ports = rootPorts(document);
    assert.deepEqual(ports.map((port) => [port.key, port.name, port.named, port.direction, port.kind, port.startValue, port.reached]), [
        [1, 'setpoint', true, 'in', 'update', 20, false],
        [2, 'Measurement · y', false, 'in', 'update', 20, false],
        [3, 'command', true, 'out', 'update', 0, true]
    ]);
    assert.equal(ports[0].unit, '°C');
    assert.equal(ports[0].nodeId, 1);
    assert.deepEqual(rootPorts(controller()), [], 'A project without a block has no ports.');
    const gone = structuredClone(document);
    gone.nodes = gone.nodes.filter((item) => item.id !== 3);
    assert.deepEqual(rootPorts(gone).map((port) => port.key), [1, 3], 'A port whose state is gone is not described.');
    assert.deepEqual(pruneRootPorts(gone).component.ports.map((port) => port.key), [1, 3], 'and pruning takes it off.');
    assert.equal(pruneRootPorts(document), document, 'Nothing to prune: the same document.');
});

test('removing the last root port removes the block it made, but keeps a component\'s own block', () => {
    const { document } = declareRootPort(controller(), { stateId: 2, componentName: 'PID' });
    assert.equal(JSON.stringify(removeRootPort(document, 1)), JSON.stringify(controller()), 'Back to the project as it was, byte for byte.');
    assert.deepEqual(removeRootPort(document, 1, { keepBlock: true }).component, { name: 'PID', ports: [] }, 'A component file keeps its block.');
    const described = structuredClone(document);
    described.component.description = 'A controller.';
    assert.deepEqual(removeRootPort(described, 1).component, { name: 'PID', description: 'A controller.', ports: [] }, 'A block holding more than its ports stays.');
    const placed = structuredClone(document);
    placed.component.terminalPositions = [{ portKey: 1, position: [-4, 0, 0] }];
    assert.equal(removeRootPort(placed, 1).component, undefined, 'Where its terminal was put goes with the port.');
    assert.equal(removeRootPort(controller(), 1).component, undefined, 'Nothing to remove: still no block.');
});

test('the engine sees the same flat graph with root ports as without', () => {
    let { document } = declareRootPort(controller(), { stateId: 2, direction: 'in' });
    ({ document } = declareRootPort(document, { stateId: 6, direction: 'out' }));
    assert.deepEqual(executionProjectDocument(document), executionProjectDocument(controller()));
});

async function kjtFiles(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...await kjtFiles(path));
        else if (entry.name.endsWith('.kjt')) found.push(path);
    }
    return found.sort();
}

test('every shipped example has no root ports, and declaring then removing one leaves it byte-identical', async () => {
    const paths = await kjtFiles(join(repository, 'examples'));
    assert.ok(paths.length >= 15, 'The shipped examples are missing.');
    for (const path of paths) {
        const content = (await decodeProjectBundle(await readFile(path))).content;
        const document = JSON.parse(content);
        assert.deepEqual(rootPorts(document), [], `${path} has root ports`);
        const firstState = (document.nodes ?? []).flatMap((item) => item.states ?? [])[0];
        if (!firstState) continue;
        const { document: withPort, key } = declareRootPort(document, { stateId: firstState.id, direction: 'in' });
        assert.equal(JSON.stringify(removeRootPort(withPort, key)), JSON.stringify(document), `${path} is not given back as it was`);
        assert.deepEqual(executionProjectDocument(withPort), executionProjectDocument(document), `${path} runs differently with a root port`);
    }
});

// The canvas's normalisers, replaced by stand-ins that change nothing, as in tests/olderVersions.test.mjs.
const context = {
    geometryFromDocument: (mesh) => ({ mesh }), serializeGeometry: (geometry) => geometry.mesh, stateValueText: (value) => ({ text: String(value), exact: true }),
    transformOf: (definition) => ({ position: definition.position, rotation: definition.rotation, scale: definition.scale }), newId: () => 9999,
    sourceTermExpressionModel: (definition, term) => term.expressionModel ?? { latex: term.expression }, relationshipEquationModel: (definition) => definition.equationModel
};

// The fixture was saved by the Konjugate v2.0.4 app itself (a tree from `git archive v2.0.4`, run in interaction-test mode): a
// plain project's Plant subsystem given an in port, an out port and a port both ways, named and directed, and an exposed
// parameter, through Plant's card, then Save as component file…, its save dialog answered by the app's own test driver.
test('a component file v2.0.4 wrote keeps its block, keys and ports, and its ports are its root ports', async () => {
    const path = join(repository, 'tests/fixtures/olderVersions/v2.0.4/components/plant.kjt');
    const content = (await decodeProjectBundle(await readFile(path))).content;
    const document = JSON.parse(content);
    const block = structuredClone(document.component);
    assert.deepEqual(block.ports.map((port) => port.key), [1, 2, 3]);
    assert.deepEqual(rootPorts(document).map((port) => [port.key, port.name, port.direction, port.symbol, port.reached]), [
        [1, 'heater', 'in', 'power', false], [2, 'temperature', 'out', 'temperature', true], [3, 'Wall · Temperature', 'both', 'wallTemperature', true]
    ]);
    // Its entities through the codec as opening and saving does: saving again is stable.
    const saved = (items) => ({
        nodes: items.nodes.map((item) => nodeToDocument(nodeFromDocument(item, context), context)),
        edges: items.edges.map((item) => relationshipToDocument(relationshipFromDocument(item, context), context))
    });
    const once = saved(document);
    assert.deepEqual(saved(once), once);
    assert.deepEqual(once.nodes.map((item) => item.states.map((entry) => entry.id)), [[2], [4], [8]], 'Every state keeps the id its port names.');
    // A port added at the top takes the next key, and taking it off again gives the file back byte for byte, block kept.
    const { document: withPort, key } = declareRootPort(document, { stateId: 4, direction: 'out' });
    assert.equal(key, 3, 'The wall state is already port 3: declaring it again only changes its direction.');
    const { document: renamed } = declareRootPort(document, { stateId: 2, name: 'tank temperature' });
    assert.deepEqual(componentInterface(renamed).ports.map((port) => port.key), [1, 2, 3], 'Renaming keeps every key.');
    assert.notEqual(JSON.stringify(withPort), content);
    let emptied = document;
    for (const port of block.ports) emptied = removeRootPort(emptied, port.key, { keepBlock: true });
    assert.deepEqual(emptied.component, { name: 'Plant', ports: [] }, 'A component file keeps its block with its last port gone.');
    assert.deepEqual(describeComponentDocument(document).ports.map((port) => port.key), [1, 2, 3]);
    assert.equal(JSON.stringify(document.component), JSON.stringify(block), 'Reading never changes the block.');
});

test('a whole model with ports becomes a library component: its model and block, laid out around its middle, without what is the project\'s own', async () => {
    const { projectComponentDocument } = await import('../src/components.mjs');
    assert.throws(() => projectComponentDocument(controller()), /once it has ports/);
    let { document } = declareRootPort(controller(), { stateId: 2, direction: 'in', componentName: 'PID' });
    document.ownership = { owner: 'Someone' };
    document.scenarios = [{ id: 1 }];
    document.nodes[0].position = [-2, 0, 0];
    document.nodes[1].position = [0, 2, 0];
    document.nodes[2].position = [2, 1, 3];
    document.component.terminalPositions = [{ portKey: 1, position: [-6, 1, 1] }];
    const component = projectComponentDocument(document, { name: 'Room controller' });
    assert.equal(component.ownership, undefined);
    assert.equal(component.scenarios, undefined);
    assert.equal(component.component.name, 'Room controller');
    assert.deepEqual(component.nodes.map((item) => item.position), [[-2, -1, -1], [0, 1, -1], [2, 0, 2]]);
    assert.deepEqual(component.component.terminalPositions, [{ portKey: 1, position: [-6, 0, 0] }], 'Placed terminals move with the model.');
    assert.equal(document.component.name, 'PID', 'The project is not changed.');
    assert.deepEqual(component.edges, document.edges, 'Its relationships are as they are.');
});
