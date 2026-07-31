/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DocumentController } from '../src/renderer/documentController.mjs';

test('tracks undo, redo, and saved state', () => {
    const document = new DocumentController();
    let value = 1;
    document.record({ undo: () => { value = 0; }, redo: () => { value = 1; } });
    assert.equal(document.dirty, true);
    assert.equal(document.undo(), true);
    assert.equal(value, 0);
    assert.equal(document.redo(), true);
    assert.equal(value, 1);
    document.markSaved();
    assert.equal(document.dirty, false);
});

test('invalidates a saved branch when recording after undo', () => {
    const document = new DocumentController();
    let value = 0;
    const recordValue = (next) => {
        const previous = value;
        value = next;
        document.record({ undo: () => { value = previous; }, redo: () => { value = next; } });
    };
    recordValue(1);
    recordValue(2);
    document.markSaved();
    document.undo();
    recordValue(3);
    assert.equal(document.canRedo, false);
    assert.equal(document.dirty, true);
    assert.equal(value, 3);
});
