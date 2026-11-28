/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { autoDockBelow, preferredMode, resizedBox } from '../src/renderer/assistantPanelLayout.mjs';

test('The assistant docks by itself in a small window, floats in a large one, and a chosen mode wins either way', () => {
    assert.equal(preferredMode({ mode: 'auto' }, { width: 1920, height: 1050 }), 'floating');
    assert.equal(preferredMode({ mode: 'auto' }, { width: 1200, height: 760 }), 'floating', 'The window Konjugate opens with keeps a floating panel.');
    assert.equal(preferredMode({ mode: 'auto' }, { width: autoDockBelow.width - 1, height: 900 }), 'docked');
    assert.equal(preferredMode({ mode: 'auto' }, { width: 1600, height: autoDockBelow.height - 1 }), 'docked');
    assert.equal(preferredMode({ mode: 'floating' }, { width: 800, height: 500 }), 'floating');
    assert.equal(preferredMode({ mode: 'docked' }, { width: 1920, height: 1050 }), 'docked');
});

test('Dragging an edge or a corner resizes the panel within the window and no smaller than its minimum', () => {
    const start = { left: 1000, top: 100, width: 420, height: 600 };
    const area = { left: 10, top: 90, right: 1910, bottom: 1040 };
    assert.deepEqual(resizedBox(start, 'w', -100, 0, area), { left: 900, top: 100, width: 520, height: 600 }, 'The left edge grows it leftwards, keeping its right edge.');
    assert.deepEqual(resizedBox(start, 'se', 50, 40, area), { left: 1000, top: 100, width: 470, height: 640 });
    assert.deepEqual(resizedBox(start, 'n', 0, -50, area), { left: 1000, top: 90, width: 420, height: 610 }, 'The top edge stops at the top of the canvas.');
    assert.deepEqual(resizedBox(start, 'e', -400, 0, area), { left: 1000, top: 100, width: 300, height: 600 }, 'Not narrower than its minimum.');
    assert.deepEqual(resizedBox(start, 'w', 400, 0, area), { left: 1120, top: 100, width: 300, height: 600 }, 'From the left edge too, keeping its right edge where it was.');
    assert.deepEqual(resizedBox(start, 'se', 2000, 2000, area), { left: 1000, top: 100, width: 910, height: 940 }, 'Not past the window.');
});
