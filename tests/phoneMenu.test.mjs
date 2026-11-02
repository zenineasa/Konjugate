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

test('a button that states its own meaning is listed under it, the others under the entry\'s label', () => {
    const buttons = { offlineButton: { dataset: { menuLabel: 'Saving for offline use… 40%' } }, saveButton: { dataset: {} } };
    const shown = visiblePhoneMenuEntries((id) => buttons[id]);
    assert.deepEqual(shown.map((entry) => entry.label), ['Save project', 'Saving for offline use… 40%']);
});

test('a button whose title says its state is listed under its title, when the entry asks for that', () => {
    const buttons = { nodeLabelsButton: { title: 'Node labels: compact · click for expanded' }, edgeLabelsButton: { title: '' } };
    const shown = visiblePhoneMenuEntries((id) => buttons[id]);
    assert.deepEqual(shown.map((entry) => entry.label), ['Node labels: compact · click for expanded', 'Relationship labels']);
});

test('what the strip no longer carries on a phone is in the menu', () => {
    const ids = phoneMenuEntries.map((entry) => entry.id);
    for (const id of ['causalInferenceButton', 'parameterTuningButton', 'nodeLabelsButton', 'edgeLabelsButton']) assert.ok(ids.includes(id), id);
});
