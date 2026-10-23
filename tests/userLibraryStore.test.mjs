/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserLibraryStore } from '../src/userLibraryStore.mjs';

const template = (id, name, section = []) => ({
    id, kind: 'fragment', name, domains: ['custom'], ...(section.length ? { section } : {}),
    fragment: {
        format: 'konjugateGraphFragment', version: 1, edges: [],
        nodes: [{ id: 1, name, position: [0, 0, 0], states: [{ id: 2, name: 'Level', symbol: 'level', initialValue: 0 }], sourceTerms: [] }]
    }
});

// Storage held in memory, standing in for a folder of files or a browser database.
function memoryStore(initial = [], others = ['thermalMass']) {
    const saved = new Map(initial.map((item) => [item.id, structuredClone(item)]));
    const writes = [];
    const store = createUserLibraryStore({
        readAll: async () => [...saved.values()].map((item) => structuredClone(item)),
        write: async (item) => { writes.push(item.id); saved.set(item.id, structuredClone(item)); },
        remove: async (id) => { saved.delete(id); },
        otherTemplateIds: async () => others
    });
    return { store, saved, writes };
}

test('a saved template is kept, and listed back as it was saved', async () => {
    const { store, saved } = memoryStore();
    const result = await store.save(template('user_pump', 'Pump', ['Fluid']));
    assert.equal(result.id, 'user_pump');
    assert.deepEqual(saved.get('user_pump').section, ['Fluid']);
});

test('only a selection of nodes and relationships can be saved, and a malformed one is refused', async () => {
    const { store, saved } = memoryStore();
    await assert.rejects(store.save({ id: 'user_x', kind: 'node', name: 'X', domains: ['custom'], states: [{ label: 'A', symbol: 'a' }] }), /Only a selection/);
    await assert.rejects(store.save({ ...template('user_y', 'Y'), fragment: { nodes: [] } }), /valid graph fragment/);
    assert.equal(saved.size, 0);
});

test('a template never takes an id that a bundled or an earlier template already has', async () => {
    const { store } = memoryStore([template('user_pump', 'Pump')]);
    assert.equal((await store.save(template('user_pump', 'Pump'))).id, 'user_pump_2');
    assert.equal((await store.save(template('thermalMass', 'Thermal mass'))).id, 'user_thermal_mass');
});

test('a template can be renamed, described and moved, and one that is not there cannot', async () => {
    const { store, saved } = memoryStore([template('user_pump', 'Pump', ['Fluid'])]);
    const changed = await store.update('user_pump', { name: 'Big pump', description: 'Moves water.', section: ['Fluid', 'Pumps'] });
    assert.deepEqual([changed.name, changed.description, changed.section], ['Big pump', 'Moves water.', ['Fluid', 'Pumps']]);
    assert.equal(saved.get('user_pump').name, 'Big pump');
    await assert.rejects(store.update('missing', { name: 'X' }), /not in your library/);
    await assert.rejects(store.update('user_pump', { name: ' ' }), /needs a name/);
});

test('renaming a section files everything in it and below it under the new name, and nothing else', async () => {
    const { store, saved } = memoryStore([
        template('user_a', 'A', ['Fluid']), template('user_b', 'B', ['Fluid', 'Pumps']), template('user_c', 'C', ['Fluidic']), template('user_d', 'D')
    ]);
    assert.deepEqual((await store.moveSection(['Fluid'], ['Liquids'])).sort(), ['user_a', 'user_b']);
    assert.deepEqual(saved.get('user_a').section, ['Liquids']);
    assert.deepEqual(saved.get('user_b').section, ['Liquids', 'Pumps']);
    assert.deepEqual(saved.get('user_c').section, ['Fluidic']);
    assert.equal(saved.get('user_d').section, undefined);
});

test('a section move that cannot be made changes nothing', async () => {
    const { store, writes } = memoryStore([template('user_a', 'A', ['Fluid'])]);
    await assert.rejects(store.moveSection(['Fluid'], ['Fluid', 'Inner']), /into itself/);
    await assert.rejects(store.moveSection(['Fluid'], ['a/b']), /cannot contain/);
    await assert.rejects(store.moveSection([], ['Anywhere']), /top level/);
    assert.deepEqual(writes, []);
});

test('a template can be deleted, and one that is not there cannot', async () => {
    const { store, saved } = memoryStore([template('user_a', 'A')]);
    await store.remove('user_a');
    assert.equal(saved.size, 0);
    await assert.rejects(store.remove('user_a'), /not in your library/);
});
