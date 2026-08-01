/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { eligibleEndpointIds, virtualKeyboardInset } from '../src/renderer/viewportLayout.mjs';

test('virtualKeyboardInset reserves only visible keyboard space', () => {
    assert.equal(virtualKeyboardInset(900, { top: 620 }, true), 280);
    assert.equal(virtualKeyboardInset(900, { top: 620 }, false), 0);
    assert.equal(virtualKeyboardInset(900, null, true), 0);
});

test('eligibleEndpointIds excludes the opposite endpoint and hidden nodes', () => {
    const nodes = [{ id: 'source' }, { id: 'target' }, { id: 'hidden' }];
    assert.deepEqual(
        eligibleEndpointIds(nodes, 'source', (node) => node.id !== 'hidden'),
        ['target']
    );
});
