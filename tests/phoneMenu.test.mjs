/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { phoneMenuEntries, visiblePhoneMenuEntries } from '../src/renderer/phoneMenu.mjs';

test('the phone menu leaves out buttons the page has hidden or does not have, and marks disabled ones', () => {
    const buttons = { saveButton: {}, exportCsvButton: { disabled: true }, exampleGuideButton: { hidden: true } };
    const shown = visiblePhoneMenuEntries((id) => buttons[id]);
    assert.deepEqual(shown.map((entry) => [entry.id, entry.disabled]), [['saveButton', false], ['exportCsvButton', true]]);
});

test('every phone menu entry is a distinct button', () => {
    const ids = phoneMenuEntries.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
});
