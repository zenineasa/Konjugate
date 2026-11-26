/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    componentDocumentOf, declarePort, describeComponentDocument, expandInstance, exposeParameter, extractComponent, instanceCount,
    instanceParameters, instancePorts, migrateLegacySubsystems, placeAnotherInstance, placeComponent, separateInstance,
    refreshDefinition, setInstanceParameter, stripComponents, subsystemPath, syncDefinitions
} from '../src/components.mjs';
import { executionProjectDocument } from '../src/subsystems.mjs';

const state = (id, symbol, initialValue = 0) => ({ id, name: symbol, symbol, initialValue, unit: 'K' });
const node = (id, name, states, subsystemId, position = [0, 0, 0]) => ({
    id, name, position, states, sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#888888' },
    ...(subsystemId ? { subsystemId } : {})
});
const edge = (id, name, [sourceNodeId, sourceStateId], [targetNodeId, targetStateId], parameters = []) => ({
    id, name, source: { nodeId: sourceNodeId, stateId: sourceStateId }, target: { nodeId: targetNodeId, stateId: targetStateId },
    directionality: 'directed', equation: 'k', equationModel: { latex: 'k', output: { role: 'target', stateId: targetStateId } }, parameters
});

// Heater (outside) heats Tank, inside Plant; Tank warms Wall, inside Plant too; Wall's loss uses the shared coefficient.
function project() {
    return {
        format: 'konjugate', version: 1, metadata: { units: 'SI' },
        sharedParameters: [{ id: 30, name: 'Loss', symbol: 'loss', value: 0.1, unit: '1/s' }],
        nodes: [
            node(1, 'Tank', [state(2, 'temperature', 300)], 20, [-1, 0, 0]),
            node(3, 'Wall', [state(4, 'temperature', 290)], 20, [1, 0, 0]),
            node(5, 'Heater', [state(6, 'power', 10)], null, [-6, 0, 0])
        ],
        edges: [
            edge(10, 'Conduct', [1, 2], [3, 4], [{ id: 11, name: 'k', symbol: 'k', value: 0.2, sharedParameterId: 30 }]),
            edge(12, 'Heat', [5, 6], [1, 2])
        ],
        subsystems: [{ id: 20, name: 'Plant', parentSubsystemId: null, position: [0, 0, 0] }],
        edgeGroups: []
    };
}

const flat = (document) => {
    const result = executionProjectDocument(document);
    // Order is not meaning: compared by id.
    const byId = (list) => [...(list ?? [])].sort((a, b) => a.id - b.id);
    return { nodes: byId(result.nodes), edges: byId(result.edges), sharedParameters: byId(result.sharedParameters) };
};

test('a project from before components becomes an instance of a local definition with every id and the flat graph unchanged', () => {
    const before = project();
    const after = migrateLegacySubsystems(structuredClone(before));
    const plant = after.subsystems.find((item) => item.id === 20);
    assert.ok(plant.definitionId, 'Plant has a definition.');
    assert.equal(after.subsystemDefinitions.length, 1);
    const definition = after.subsystemDefinitions[0].document;
    assert.deepEqual(definition.nodes.map((item) => item.id), [1, 3], 'The definition uses the entities\' own ids.');
    assert.deepEqual(definition.edges.map((item) => item.id), [10], 'Only the relationship inside goes in.');
    assert.equal(definition.component.name, 'Plant');
    assert.equal(after.nodes.find((item) => item.id === 1).definitionKey, 1);
    assert.equal(after.nodes.find((item) => item.id === 5).definitionKey, undefined, 'Outside nodes are not keyed.');
    assert.deepEqual(flat(after), flat(before), 'The engine sees the same flat graph.');
});

test('expanding an instance again keeps every id, and another instance gets the same ids every time', () => {
    const migrated = migrateLegacySubsystems(project());
    const { document: same } = expandInstance(migrated, 20);
    assert.deepEqual(flat(same), flat(migrated), 'Expanding from the definition reproduces the instance.');
    const first = placeAnotherInstance(migrated, 20);
    const second = placeAnotherInstance(migrated, 20);
    assert.deepEqual(first.document, second.document, 'The same document expands to the same ids.');
    const copy = first.document.nodes.filter((item) => item.subsystemId === first.subsystemId);
    assert.deepEqual(copy.map((item) => item.name), ['Tank', 'Wall']);
    assert.ok(copy.every((item) => item.id > 30), 'New ids are fresh.');
    assert.equal(instanceCount(first.document, 20), 2);
    assert.equal(first.document.edges.filter((item) => item.name === 'Conduct').length, 2, 'The relationship inside is made again; the one from outside is not.');
});

test('an edit inside one instance reaches the others; undoing it puts them back', () => {
    let document = placeAnotherInstance(migrateLegacySubsystems(project()), 20).document;
    const other = document.subsystems.find((item) => item.id !== 20).id;
    const otherWall = () => document.nodes.find((item) => item.subsystemId === other && item.name === 'Wall');
    const wallId = otherWall().id;
    const before = structuredClone(document);
    document.nodes.find((item) => item.id === 3).states[0].initialValue = 250;
    syncDefinitions(document, { preferredSubsystemId: 20 });
    assert.equal(otherWall().states[0].initialValue, 250);
    assert.equal(otherWall().id, wallId, 'The other instance keeps its ids.');
    // Undo restores the edited instance; the others follow it back.
    document = structuredClone(before);
    syncDefinitions(document);
    assert.equal(otherWall().states[0].initialValue, 290);
});

test('a node added inside one instance is added to the others; one removed goes, with relationships from outside to it', () => {
    const document = placeAnotherInstance(migrateLegacySubsystems(project()), 20).document;
    const other = document.subsystems.find((item) => item.id !== 20).id;
    document.nodes.push(node(900, 'Lid', [state(901, 'temperature', 280)], 20));
    syncDefinitions(document, { preferredSubsystemId: 20 });
    assert.ok(document.nodes.some((item) => item.subsystemId === other && item.name === 'Lid'), 'The other instance has the new node.');
    assert.equal(document.nodes.find((item) => item.id === 900).definitionKey !== undefined, true, 'The new node is keyed where it was added.');
    // A relationship from outside into the other instance's Wall, then Wall removed from the first instance.
    const otherWall = document.nodes.find((item) => item.subsystemId === other && item.name === 'Wall');
    document.edges.push(edge(950, 'Probe', [5, 6], [otherWall.id, otherWall.states[0].id]));
    document.nodes = document.nodes.filter((item) => item.id !== 3);
    document.edges = document.edges.filter((item) => item.id !== 10);
    const report = syncDefinitions(document, { preferredSubsystemId: 20 });
    assert.equal(document.nodes.some((item) => item.subsystemId === other && item.name === 'Wall'), false);
    assert.deepEqual(report.removedEdgeIds, [950], 'The relationship from outside to the removed node is removed.');
});

test('a separate instance keeps its own definition', () => {
    const placed = placeAnotherInstance(migrateLegacySubsystems(project()), 20);
    const document = separateInstance(placed.document, placed.subsystemId);
    assert.equal(document.subsystemDefinitions.length, 2);
    assert.equal(instanceCount(document, 20), 1);
    document.nodes.find((item) => item.id === 3).states[0].initialValue = 1;
    syncDefinitions(document, { preferredSubsystemId: 20 });
    assert.equal(document.nodes.find((item) => item.subsystemId === placed.subsystemId && item.name === 'Wall').states[0].initialValue, 290);
});

test('a linked instance changed on the canvas is put back from its definition', () => {
    const document = migrateLegacySubsystems(project());
    document.subsystemDefinitions[0].link = { kind: 'file', fileName: 'Plant.kjt' };
    document.nodes.find((item) => item.id === 3).states[0].initialValue = 1;
    const report = syncDefinitions(document);
    assert.deepEqual(report.reverted, [20]);
    assert.equal(document.nodes.find((item) => item.id === 3).states[0].initialValue, 290);
});

test('a shared parameter used inside and outside becomes an exposed parameter bound to the parent', () => {
    const document = project();
    document.nodes[2].sourceTerms = [{ id: 40, state: 'power', expression: 'loss', parameters: [{ id: 41, name: 'loss', symbol: 'loss', value: 0, sharedParameterId: 30 }] }];
    const { document: component, parameterValues } = extractComponent(document, 20);
    const exposed = component.sharedParameters.find((item) => item.exposed);
    assert.equal(exposed.symbol, 'loss');
    assert.deepEqual(parameterValues, [{ parameterKey: exposed.id, sharedParameterId: 30 }]);
    const before = structuredClone(document);
    const migrated = migrateLegacySubsystems(document);
    assert.deepEqual(flat(migrated), flat(before), 'Binding it leaves the numbers unchanged.');
});

test('each instance gives an exposed parameter its own value, or binds it to the parent\'s', () => {
    let document = migrateLegacySubsystems(project());
    document = exposeParameter(document, 20, 30);
    const placed = placeAnotherInstance(document, 20);
    document = setInstanceParameter(placed.document, placed.subsystemId, instanceParameters(placed.document, 20)[0].key, 0.5);
    const [mine] = instanceParameters(document, 20);
    const [theirs] = instanceParameters(document, placed.subsystemId);
    assert.deepEqual([mine.value, theirs.value, theirs.defaultValue], [0.1, 0.5, 0.1]);
    assert.notEqual(mine.sharedParameterId, theirs.sharedParameterId, 'Each instance has its own copy.');
    const theirConduct = document.edges.find((item) => item.name === 'Conduct' && item.parameters[0].sharedParameterId === theirs.sharedParameterId);
    assert.ok(theirConduct, 'The other instance\'s relationship reads its own copy.');
    document.sharedParameters.push({ id: 999, name: 'Ambient loss', symbol: 'ambientLoss', value: 0.3 });
    document = setInstanceParameter(document, placed.subsystemId, theirs.key, { sharedParameterId: 999 });
    assert.equal(instanceParameters(document, placed.subsystemId)[0].boundTo, 999);
    assert.ok(document.edges.some((item) => item.name === 'Conduct' && item.parameters[0].sharedParameterId === 999), 'Bound, it reads the parent\'s.');
});

test('ports: derived from what crosses the boundary, declared and named, and all declared in a component document', () => {
    let document = migrateLegacySubsystems(project());
    const [heated] = instancePorts(document, 20);
    assert.deepEqual([heated.declared, heated.connected, heated.name, heated.unit], [false, true, 'Tank · temperature', 'K']);
    document = declarePort(document, 20, { stateId: 4, name: 'Wall temperature', direction: 'out' });
    const ports = instancePorts(document, 20);
    assert.deepEqual(ports.map((port) => [port.name, port.declared, port.connected]), [['Wall temperature', true, false], ['Tank · temperature', false, true]]);
    const component = componentDocumentOf(document, 20);
    assert.deepEqual(component.component.ports.map((port) => [port.key, port.stateId, port.name ?? null]), [[1, 4, 'Wall temperature'], [2, 2, null]]);
    assert.deepEqual(component.nodes.map((item) => item.position), [[-1, 0, 0], [1, 0, 0]], 'Centred on its own middle.');
    const description = describeComponentDocument(component);
    assert.deepEqual(description.ports.map((port) => [port.name, port.direction]), [['Wall temperature', 'out'], ['Tank · temperature', 'both']]);
});

test('a component placed into another project is a new instance with fresh ids and runs as the same flat graph', () => {
    const component = componentDocumentOf(migrateLegacySubsystems(project()), 20);
    const target = { format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], nodes: [node(1, 'Other', [state(2, 'x')])], edges: [], subsystems: [], edgeGroups: [] };
    const { document, subsystemId } = placeComponent(target, component, { position: [4, 0, 0] });
    const placed = document.nodes.filter((item) => item.subsystemId === subsystemId);
    assert.deepEqual(placed.map((item) => item.name), ['Tank', 'Wall']);
    assert.ok(placed.every((item) => item.id !== 1 && item.id !== 2), 'Ids do not clash with the project\'s.');
    assert.equal(document.subsystems.find((item) => item.id === subsystemId).name, 'Plant');
    assert.equal(subsystemPath(document, subsystemId), 'Plant');
    const engine = executionProjectDocument(document);
    assert.equal(engine.nodes.length, 3);
    assert.ok(engine.nodes.every((item) => item.definitionKey === undefined && item.subsystemId === undefined));
    assert.equal(engine.subsystemDefinitions, undefined);
});

test('what reaches the engine has no components left in it', () => {
    const migrated = migrateLegacySubsystems(project());
    const stripped = stripComponents(migrated);
    assert.equal(JSON.stringify(stripped).includes('definitionKey'), false);
    assert.equal(stripped.subsystemDefinitions, undefined);
});

test('every shipped example, folded into nested subsystems, becomes components with the same flat graph it runs today', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { decodeProjectFile } = await import('../src/projectFile.mjs');
    const examples = join(import.meta.dirname, '..', 'examples');
    const files = (await readdir(examples)).filter((file) => file.endsWith('.kjt')).sort();
    assert.ok(files.length > 5);
    for (const file of files) {
        const original = JSON.parse(await decodeProjectFile(await readFile(join(examples, file))));
        if ((original.nodes ?? []).length < 2) continue;
        // No example has subsystems, so each is given two: half its nodes in one, and the first of those a level deeper.
        const folded = structuredClone(original);
        const top = 9_000_001;
        const inner = 9_000_002;
        folded.subsystems = [{ id: top, name: 'Outer', parentSubsystemId: null, position: [0, 0, 0] }, { id: inner, name: 'Inner', parentSubsystemId: top, position: [0, 0, 0] }];
        const half = folded.nodes.slice(0, Math.ceil(folded.nodes.length / 2));
        half.forEach((item, index) => { item.subsystemId = index === 0 ? inner : top; });
        const migrated = migrateLegacySubsystems(structuredClone(folded));
        assert.deepEqual(flat(migrated), flat(original), `${file} runs differently once its subsystems are components.`);
        syncDefinitions(migrated);
        assert.deepEqual(flat(migrated), flat(original), `${file} changed when its definitions were brought in step.`);
        const placed = placeAnotherInstance(migrated, top);
        const engine = executionProjectDocument(placed.document);
        const ids = engine.nodes.flatMap((item) => [item.id, ...(item.states ?? []).map((entry) => entry.id)]);
        assert.equal(new Set(ids).size, ids.length, `${file}: a second instance reuses an id.`);
        assert.equal(engine.nodes.length, original.nodes.length + half.length, `${file}: the second instance has the wrong nodes.`);
    }
});

test('every instance\'s copy of a shared parameter has a symbol of its own in the project, and the component keeps its own', () => {
    let document = exposeParameter(migrateLegacySubsystems(project()), 20, 30);
    document = placeAnotherInstance(document, 20).document;
    document = placeAnotherInstance(document, 20).document;
    const symbols = document.sharedParameters.map((shared) => shared.symbol).sort();
    assert.deepEqual(symbols, ['loss', 'loss2', 'loss3']);
    assert.equal(new Set(symbols).size, symbols.length);
    syncDefinitions(document);
    assert.deepEqual(document.subsystemDefinitions[0].document.sharedParameters.map((shared) => shared.symbol), ['loss'], 'The component\'s own symbol is kept.');
    const again = structuredClone(document);
    syncDefinitions(again);
    assert.deepEqual(again.sharedParameters.map((shared) => shared.symbol).sort(), symbols, 'Each copy keeps its symbol.');
});

test('a linked component\'s new version: compatible changes reach every instance, a moved port takes its relationships, a removed one is a conflict', async () => {
    const { interfaceChanges, linkConflicts, refreshDefinition, linkCycle } = await import('../src/components.mjs');
    let document = migrateLegacySubsystems(project());
    document = declarePort(document, 20, { stateId: 2, name: 'Inlet' });
    document = placeAnotherInstance(document, 20).document;
    const definition = document.subsystemDefinitions[0];
    definition.link = { kind: 'file', fileName: 'Plant.kjt', path: '/models/Plant.kjt', sha256: 'old' };
    const other = document.subsystems.find((item) => item.id !== 20).id;

    // Compatible: a value changed inside, the port renamed. Every instance follows; ids are kept.
    const renamed = structuredClone(definition.document);
    renamed.nodes.find((item) => item.name === 'Wall').states[0].initialValue = 111;
    renamed.component.ports[0].name = 'Heat in';
    assert.equal(interfaceChanges(definition.document, renamed).compatible, true);
    const wallIds = document.nodes.filter((item) => item.name === 'Wall').map((item) => item.id).sort();
    let refreshed = refreshDefinition(document, definition.id, renamed, { link: { sha256: 'new' } }).document;
    assert.deepEqual(refreshed.nodes.filter((item) => item.name === 'Wall').map((item) => [item.id, item.states[0].initialValue]).sort((a, b) => a[0] - b[0]), wallIds.map((id) => [id, 111]));
    assert.equal(refreshed.subsystemDefinitions[0].link.sha256, 'new');

    // The port moved to Wall's temperature (same symbol and unit): Heat, from outside, now ends at each instance's Wall.
    const moved = structuredClone(definition.document);
    moved.component.ports[0].stateId = moved.nodes.find((item) => item.name === 'Wall').states[0].id;
    assert.equal(interfaceChanges(definition.document, moved).compatible, true);
    refreshed = refreshDefinition(document, definition.id, moved).document;
    const heat = refreshed.edges.find((item) => item.name === 'Heat');
    assert.equal(heat.target.nodeId, 3, 'The relationship follows the port to Wall.');
    assert.equal(heat.equationModel.output.stateId, 4);

    // Removed: a conflict, listed per instance; "Update and remove" removes what was connected to it.
    const removed = structuredClone(definition.document);
    removed.component.ports = [];
    assert.deepEqual(interfaceChanges(definition.document, removed).conflicts.map((item) => [item.kind, item.change]), [['port', 'removed']]);
    const conflicts = linkConflicts(document, definition.id, removed);
    assert.deepEqual(conflicts.map((item) => [item.subsystemId, item.edgeIds]), [[20, [12]]]);
    refreshed = refreshDefinition(document, definition.id, removed, { removeConflicts: true }).document;
    assert.equal(refreshed.edges.some((item) => item.name === 'Heat'), false);
    assert.ok(refreshed.subsystems.some((item) => item.id === other));

    // A file that would contain itself is refused, with the chain named.
    const nested = { component: { name: 'Outer' }, subsystemDefinitions: [{ id: 1, link: { kind: 'file', fileName: 'Plant.kjt', path: '/models/Plant.kjt' }, document: { component: { name: 'Plant' } } }] };
    assert.deepEqual(linkCycle(nested, { path: '/models/Plant.kjt' }, { source: { fileName: 'Outer.kjt', path: '/models/Outer.kjt' } }), ['Outer.kjt', 'Plant.kjt']);
    assert.equal(linkCycle(nested, { path: '/models/Other.kjt' }), null);
});

test('a result records the version of every component it ran with, linked or local, and a changed component reads differently', async () => {
    const { componentVersions } = await import('../src/components.mjs');
    const { createHash } = await import('node:crypto');
    const hash = async (text) => createHash('sha256').update(text).digest('hex');
    let document = placeAnotherInstance(migrateLegacySubsystems(project()), 20).document;
    document.subsystemDefinitions[0].link = { kind: 'file', fileName: 'Plant.kjt', path: '/p/Plant.kjt', sha256: 'abc' };
    const [version] = await componentVersions(document, hash);
    assert.deepEqual({ ...version, sha256: version.sha256.length }, { definitionId: document.subsystemDefinitions[0].id, name: 'Plant', sha256: 64, instances: 2, link: { kind: 'file', fileName: 'Plant.kjt', sha256: 'abc' } });
    document.subsystemDefinitions[0].document.nodes[0].states[0].initialValue = 1;
    const [changed] = await componentVersions(document, hash);
    assert.notEqual(changed.sha256, version.sha256);
    assert.deepEqual(await componentVersions(project(), hash), [], 'A project without components records none.');
});

// A plant whose nested pump has a terminal moved: Fill, from the pump's motor to the plant's tank, crosses the pump.
function nestedProject() {
    return {
        format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [],
        nodes: [node(1, 'Tank', [state(2, 'level')], 20), node(3, 'Pump motor', [state(4, 'speed')], 21), node(5, 'Heater', [state(6, 'power')])],
        edges: [edge(14, 'Fill', [3, 4], [1, 2]), edge(12, 'Heat', [5, 6], [1, 2])],
        subsystems: [
            { id: 20, name: 'Plant', parentSubsystemId: null, position: [0, 0, 0], terminalPositions: [{ edgeId: 12, position: [-5, 0, 0] }] },
            { id: 21, name: 'Pump', parentSubsystemId: 20, position: [2, 0, 0], terminalPositions: [{ edgeId: 14, position: [7, 1, 0] }] }
        ],
        edgeGroups: []
    };
}

test('a copied subsystem takes the moved terminals of the subsystems inside it, renumbered with the relationships they belong to', () => {
    const source = migrateLegacySubsystems(nestedProject());
    const component = componentDocumentOf(source, 20);
    const target = { format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], nodes: [node(1, 'Other', [state(2, 'x')])], edges: [], subsystems: [], edgeGroups: [] };
    const { document, subsystemId } = placeComponent(target, component);
    const pump = document.subsystems.find((item) => item.parentSubsystemId === subsystemId);
    const fill = document.edges.find((item) => item.name === 'Fill');
    assert.deepEqual(pump.terminalPositions, [{ edgeId: fill.id, position: [7, 1, 0] }], 'The pump\'s moved terminal follows the copied Fill.');
    assert.notEqual(fill.id, 14);
    assert.equal(document.subsystems.find((item) => item.id === subsystemId).terminalPositions, undefined, 'The plant\'s own terminal was for a relationship outside it, which is not copied.');
    // A second instance of the same component too.
    const twice = placeAnotherInstance(document, subsystemId).document;
    const pumps = twice.subsystems.filter((item) => item.name === 'Pump');
    assert.equal(pumps.length, 2);
    pumps.forEach((item) => {
        const own = twice.edges.find((edge) => edge.id === item.terminalPositions[0].edgeId);
        assert.equal(own.name, 'Fill');
        assert.equal(twice.nodes.find((entry) => entry.id === own.source.nodeId).subsystemId, item.id, 'Each pump\'s terminal names its own Fill.');
    });
});

test('a pasted instance keeps its own parameter values, and a pasted linked instance is another instance of the same link', async () => {
    const { pasteComponentCopy, componentCopyOf } = await import('../src/components.mjs');
    let document = exposeParameter(migrateLegacySubsystems(project()), 20, 30);
    const [parameter] = instanceParameters(document, 20);
    document = setInstanceParameter(document, 20, parameter.key, 0.7);
    // Into another project: a copy of its own, with this instance's value.
    const copy = componentCopyOf(document, 20);
    const target = { format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], nodes: [], edges: [], subsystems: [], edgeGroups: [] };
    const pasted = pasteComponentCopy(target, copy, { position: [0, 0, 0] });
    assert.equal(instanceParameters(pasted.document, pasted.subsystemId)[0].value, 0.7);
    // A linked instance pasted into its own project is another instance of the same linked definition.
    document.subsystemDefinitions[0].link = { kind: 'file', fileName: 'Plant.kjt', path: '/p/Plant.kjt', sha256: 'abc' };
    const linkedCopy = componentCopyOf(document, 20);
    const again = pasteComponentCopy(document, linkedCopy, { position: [3, 0, 0] });
    assert.equal(again.document.subsystemDefinitions.length, 1, 'No second definition.');
    assert.equal(instanceCount(again.document, again.subsystemId), 2);
    // Into another project it arrives linked, with its cached copy.
    const elsewhere = pasteComponentCopy(target, linkedCopy, { position: [0, 0, 0] });
    assert.equal(elsewhere.document.subsystemDefinitions[0].link.path, '/p/Plant.kjt');
});

// docs/proposals/unifiedEntityEditors.md, decision 14: a linked component whose file says no kinds, in a model that says them.
test('a linked component whose file says no kinds says them in a model that does, as its file is read, and keeps saying them', () => {
    // Inside Gauge: Sensor's reading is set from Source's level by a relationship's equations, so it is an Update.
    const gauge = migrateLegacySubsystems({
        format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], edgeGroups: [],
        nodes: [node(1, 'Source', [state(2, 'level', 1)], 20), node(3, 'Sensor', [state(4, 'reading')], 20)],
        edges: [{
            id: 10, name: 'Read', directionality: 'directed', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 3, stateId: 4 }, parameters: [],
            equationModel: { bindings: [{ symbol: 'level', kind: 'state', role: 'source', nodeId: 1, stateId: 2 }], outputs: [{ role: 'target', stateId: 4, mathJson: 'level', setsValue: true }] }
        }],
        subsystems: [{ id: 20, name: 'Gauge', parentSubsystemId: null, position: [0, 0, 0] }]
    });
    const component = componentDocumentOf(gauge, 20);
    const target = { format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], nodes: [node(1, 'Other', [{ ...state(2, 'x'), kind: 'rate' }])], edges: [], subsystems: [], edgeGroups: [] };
    const { document, subsystemId, definitionId } = placeComponent(target, component, { link: { kind: 'file', fileName: 'Gauge.kjt' } });
    const placed = () => document.nodes.filter((item) => item.subsystemId === subsystemId);
    const kindsOf = () => placed().map((item) => [item.name, item.states[0].kind, item.updates]);
    assert.deepEqual(kindsOf(), [['Source', 'rate', undefined], ['Sensor', 'update', 'settle']], 'Placed, it says its kinds as its file is read: every node holding an Update settling.');
    const definition = () => document.subsystemDefinitions.find((item) => item.id === definitionId).document;
    assert.ok(definition().nodes.every((item) => item.states.every((entry) => entry.kind === undefined)), 'Its definition stays as its file has it.');
    const report = syncDefinitions(document);
    assert.deepEqual(report.reverted, [], 'Saying its kinds is not a change to put back.');
    assert.deepEqual(kindsOf(), [['Source', 'rate', undefined], ['Sensor', 'update', 'settle']]);
    // A change of its own is still put back, and it says its kinds again.
    placed().find((item) => item.name === 'Source').states[0].initialValue = 5;
    assert.deepEqual(syncDefinitions(document).reverted, [subsystemId]);
    assert.equal(placed().find((item) => item.name === 'Source').states[0].initialValue, 1);
    assert.deepEqual(kindsOf(), [['Source', 'rate', undefined], ['Sensor', 'update', 'settle']]);
    // In a model that says none, it says none, as before.
    const legacy = placeComponent({ ...target, nodes: [node(1, 'Other', [state(2, 'x')])] }, component, { link: { kind: 'file', fileName: 'Gauge.kjt' } });
    assert.ok(legacy.document.nodes.every((item) => item.states.every((entry) => entry.kind === undefined) && item.updates === undefined));
});

test('a linked component\'s new version that says kinds makes a model that says none say them, so nothing outside it changes', () => {
    const document = migrateLegacySubsystems(project());
    document.subsystemDefinitions[0].link = { kind: 'file', fileName: 'Plant.kjt' };
    const next = structuredClone(document.subsystemDefinitions[0].document);
    next.nodes.forEach((item) => item.states.forEach((entry) => { entry.kind = 'rate'; }));
    const { document: refreshed } = refreshDefinition(document, document.subsystemDefinitions[0].id, next);
    const heater = refreshed.nodes.find((item) => item.name === 'Heater');
    assert.equal(heater.states[0].kind, 'rate', 'The node outside says its kind too.');
    assert.deepEqual(syncDefinitions(refreshed).reverted, []);
});

test('a component settles its nodes\' updates as its instance says, in every instance, and keeps it in its document', () => {
    const document = migrateLegacySubsystems(project());
    document.subsystems[0].updates = 'settle';
    document.subsystems[0].updatesLimit = 40;
    syncDefinitions(document, { preferredSubsystemId: 20 });
    const definition = document.subsystemDefinitions[0];
    assert.deepEqual([definition.document.component.updates, definition.document.component.updatesLimit], ['settle', 40]);
    const { document: twice, subsystemId } = placeAnotherInstance(document, 20);
    const other = twice.subsystems.find((item) => item.id === subsystemId);
    assert.deepEqual([other.updates, other.updatesLimit], ['settle', 40], 'Another instance settles too.');
    const placed = placeComponent({ format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], nodes: [], edges: [], subsystems: [], edgeGroups: [] }, componentDocumentOf(document, 20));
    assert.equal(placed.document.subsystems.find((item) => item.id === placed.subsystemId).updates, 'settle', 'Placed elsewhere, it settles.');
    // Saying nothing again is a change to the component too.
    delete document.subsystems[0].updates;
    delete document.subsystems[0].updatesLimit;
    syncDefinitions(document, { preferredSubsystemId: 20 });
    assert.equal(document.subsystemDefinitions[0].document.component.updates, undefined);
});

// The bug hunt: the same component placed twice from My library gave two instances of the same name, so its card and the refusals
// about it did not say which one was meant.
test('the same component placed twice is numbered, as the same FMU added twice is; an instance elsewhere keeps its name', () => {
    const component = componentDocumentOf(migrateLegacySubsystems(project()), 20);
    const target = { format: 'konjugate', version: 1, metadata: { units: 'SI' }, sharedParameters: [], nodes: [node(1, 'Other', [state(2, 'x')])], edges: [], subsystems: [], edgeGroups: [] };
    const first = placeComponent(target, component, { position: [4, 0, 0] });
    const second = placeComponent(first.document, component, { position: [9, 0, 0] });
    const third = placeComponent(second.document, component, { position: [14, 0, 0] });
    assert.deepEqual(third.document.subsystems.map((item) => item.name), ['Plant', 'Plant 2', 'Plant 3']);
    // Inside the first instance, a Plant of its own is not beside the others: it keeps its name.
    const inside = placeComponent(first.document, component, { parentSubsystemId: first.subsystemId });
    assert.equal(inside.document.subsystems.find((item) => item.id === inside.subsystemId).name, 'Plant');
});
