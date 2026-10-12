/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { describeOutdated, outdatedCountsByType, outdatedEntries, summarizeUpdateAll, updatePlan } from '../src/renderer/extensionUpdates.mjs';

const entries = [
    { packageId: 'a.one', name: 'Alpha', packageType: 'addon' },
    { packageId: 'a.two', name: 'Beta', packageType: 'addon' },
    { packageId: 'p.one', name: 'Gamma', packageType: 'plugin' },
    { packageId: 'f.one', name: 'Delta', packageType: 'fmu' }
];
const updateFor = (...ids) => (packageId) => (ids.includes(packageId) ? { latestVersion: '2.0.0' } : null);

test('the outdated entries are the installed ones with an update, in list order, across types', () => {
    assert.deepEqual(outdatedEntries(entries, updateFor('p.one', 'a.one')).map((entry) => entry.packageId), ['a.one', 'p.one']);
    assert.deepEqual(outdatedEntries(entries, updateFor()), []);
});

test('counts are per type, and only for types that have updates', () => {
    assert.deepEqual(outdatedCountsByType(outdatedEntries(entries, updateFor('a.one', 'a.two', 'p.one'))), { addon: 2, plugin: 1 });
    assert.deepEqual(outdatedCountsByType([]), {});
});

test('the strip names a few updates and counts the rest', () => {
    const named = (...names) => names.map((name) => ({ name }));
    assert.equal(describeOutdated([]), '');
    assert.equal(describeOutdated(named('A')), '1 update available: A');
    assert.equal(describeOutdated(named('A', 'B')), '2 updates available: A and B');
    assert.equal(describeOutdated(named('A', 'B', 'C')), '3 updates available: A, B and C');
    assert.equal(describeOutdated(named('A', 'B', 'C', 'D', 'E')), '5 updates available: A, B, C and 2 more');
});

test('a bundle with several outdated packages is one install', () => {
    const updates = new Map([
        ['fintech', { latestVersion: '1.2.0', outdated: [{ packageId: 'f.addon' }, { packageId: 'f.plugin' }] }],
        ['pose', { latestVersion: '1.0.3', outdated: [{ packageId: 'p.addon' }] }],
        ['uptodate', { latestVersion: '1.0.0', outdated: [] }]
    ]);
    assert.deepEqual(updatePlan(updates), [{ prefix: 'fintech', latestVersion: '1.2.0' }, { prefix: 'pose', latestVersion: '1.0.3' }]);
    assert.deepEqual(updatePlan(new Map()), []);
});

test('Update all reports what changed, asks for one restart, and is quiet about severity when all went well', () => {
    const summary = summarizeUpdateAll([
        { prefix: 'fintech', latestVersion: '1.2.0', results: [{ packageId: 'f.addon', version: '1.2.0' }, { packageId: 'f.plugin', version: '1.2.0' }] },
        { prefix: 'pose', latestVersion: '1.0.3', results: [{ packageId: 'p.addon', version: '1.0.3' }] }
    ]);
    assert.equal(summary.message, 'Updated f.addon 1.2.0, f.plugin 1.2.0, p.addon 1.0.3. Restart Konjugate to activate them.');
    assert.equal(summary.severity, null);
    assert.equal(summary.updatedCount, 3);
});

test('a failure is reported by name, does not hide what did update, and makes the notice an error', () => {
    const summary = summarizeUpdateAll([
        { prefix: 'fintech', latestVersion: '1.2.0', error: 'Download failed.' },
        { prefix: 'pose', latestVersion: '1.0.3', results: [{ packageId: 'p.addon', version: '1.0.3' }] }
    ]);
    assert.match(summary.message, /^Updated p\.addon 1\.0\.3\. Could not update fintech: Download failed\. Restart Konjugate/);
    assert.equal(summary.severity, 'error');
    assert.equal(summary.updatedCount, 1);
});

test('a release tagged newer than its package is reported as nothing updated, with no restart asked for', () => {
    const summary = summarizeUpdateAll([{ prefix: 'pose', latestVersion: '1.0.3', results: [{ packageId: 'p.addon', version: '1.0.2' }] }]);
    assert.match(summary.message, /p\.addon 1\.0\.2 is still at that version/);
    assert.ok(!summary.message.includes('Restart'));
    assert.equal(summary.severity, 'warning');
    assert.equal(summary.updatedCount, 0);
});

test('nothing planned gives an empty, harmless summary', () => {
    assert.deepEqual(summarizeUpdateAll([]), { message: '', severity: null, updatedCount: 0 });
});
