/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { groupRelationshipBundles } from '../src/relationshipBundles.mjs';

test('creates a relationship card for every connected node pair', () => {
    const relationships = [
        { id: 'ab1', source: 'a', target: 'b' },
        { id: 'ab2', source: 'b', target: 'a' },
        { id: 'ac1', source: 'a', target: 'c' },
        { id: 'ac2', source: 'a', target: 'c' }
    ];
    const bundles = groupRelationshipBundles(relationships);
    assert.equal(bundles.length, 2);
    assert.deepEqual(bundles.map((bundle) => bundle.relationships.map((edge) => edge.id)), [
        ['ab1', 'ab2'],
        ['ac1', 'ac2']
    ]);
});

test('shows a relationship card when a node pair has one visible relationship', () => {
    const relationships = [
        { id: 'visible', source: 'a', target: 'b', visible: true },
        { id: 'deleted', source: 'a', target: 'b', visible: false }
    ];
    const bundles = groupRelationshipBundles(relationships, (edge) => edge.visible);
    assert.equal(bundles.length, 1);
    assert.deepEqual(bundles[0].relationships.map((edge) => edge.id), ['visible']);
});

test('does not leave a card when no relationships remain visible', () => {
    const relationships = [{ id: 'deleted', source: 'a', target: 'b', visible: false }];
    assert.deepEqual(groupRelationshipBundles(relationships, (edge) => edge.visible), []);
});
