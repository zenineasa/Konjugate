// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import test from 'node:test';
import { declutterAbove, declutterLabels } from '../src/renderer/labelDeclutter.mjs';

const card = (id, left, top, more = {}) => ({ id, left, top, width: 100, height: 30, priority: 0, ...more });

test('labels that would overlap are left out, the more connected node keeping its own', () => {
    // Two cards over each other and one clear of both.
    const labels = [card(1, 0, 0, { priority: 2 }), card(2, 50, 10, { priority: 5 }), card(3, 300, 0)];
    assert.deepEqual([...declutterLabels(labels)], [1]);
    // Spread apart (zoomed in), all three are written.
    assert.deepEqual([...declutterLabels([card(1, 0, 0), card(2, 150, 0), card(3, 300, 0)])], []);
    // Cards that only touch within the gap count as overlapping.
    assert.deepEqual([...declutterLabels([card(1, 0, 0, { priority: 1 }), card(2, 101, 0)])], [2]);
});

test('a label that must stay is written whatever it overlaps, and takes its place first', () => {
    const labels = [card(1, 0, 0, { priority: 9 }), card(2, 50, 10, { keep: true }), card(3, 60, 20, { keep: true })];
    assert.deepEqual([...declutterLabels(labels)], [1]);
});

test('between equals the label already written stays, so labels do not flicker as the camera moves', () => {
    assert.deepEqual([...declutterLabels([card(1, 0, 0), card(2, 50, 10, { shown: true })])], [1]);
    assert.deepEqual([...declutterLabels([card(1, 0, 0), card(2, 50, 10)])], [2]);
});

test('a pile of a hundred labels comes down to those with room, and a small model is left alone by the caller', () => {
    const pile = Array.from({ length: 100 }, (_, index) => card(index, (index % 10) * 40, Math.floor(index / 10) * 12, { priority: index % 7 }));
    const hidden = declutterLabels(pile);
    const written = pile.filter((label) => !hidden.has(label.id));
    assert.ok(written.length >= 4 && written.length < 30, `${written.length} written`);
    for (const a of written) for (const b of written) if (a !== b) assert.ok(a.left + 100 < b.left || b.left + 100 < a.left || a.top + 30 < b.top || b.top + 30 < a.top, 'no two written labels overlap');
    assert.equal(declutterAbove, 30);
});
