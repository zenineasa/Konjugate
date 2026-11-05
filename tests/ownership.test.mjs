/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    exportNoticeLines, expandCopyright, fmiAttributes, hasUserDetails, isSomeoneElses, legacyAutomaticCopyright, licenseText,
    makeOwnershipMine, normalizeOwnership, normalizeOwnershipDefaults, seedOwnership, stampOwnership, suggestsEncryption
} from '../src/ownership.mjs';

test('an absent or empty block is nothing', () => {
    assert.equal(normalizeOwnership(undefined), null);
    assert.equal(normalizeOwnership({}), null);
    assert.equal(normalizeOwnership([]), null);
    assert.equal(normalizeOwnership('owner'), null);
});

test('a block is cleaned on the way in and unusable fields are dropped', () => {
    const block = normalizeOwnership({
        owner: '  Acme Thermal Ltd ', copyright: 5, license: { id: 'CC-BY-4.0', text: 'ignored' }, contact: '', confidential: 'yes',
        firstSavedAt: 'not a time', lastSavedAt: '2026-11-12T16:40:31.789Z', savedWith: '1.4.0', unknown: 1
    });
    assert.deepEqual(block, { owner: 'Acme Thermal Ltd', license: { id: 'CC-BY-4.0' }, lastSavedAt: '2026-11-12T16:40:31Z', savedWith: '1.4.0' });
});

test('a license with its own words and no known id is a custom one', () => {
    assert.deepEqual(normalizeOwnership({ license: { text: 'Internal use only' } }).license, { id: 'custom', text: 'Internal use only' });
    assert.deepEqual(normalizeOwnership({ license: { id: 'custom', url: 'https://example.com/terms' } }).license, { id: 'custom', url: 'https://example.com/terms' });
    assert.equal(normalizeOwnership({ license: { id: 'WTFPL' } }), null);
});

test('the notice the application used to write itself is not read as a claim', () => {
    assert.equal(normalizeOwnership(undefined, legacyAutomaticCopyright), null);
    assert.deepEqual(normalizeOwnership(undefined, 'Copyright © 2020 Someone Else'), { copyright: 'Copyright © 2020 Someone Else' });
    // A block that is there wins over the old string.
    assert.deepEqual(normalizeOwnership({ owner: 'A' }, 'Copyright © 2020 Someone Else'), { owner: 'A' });
});

test('{year} is worked out when a project is saved', () => {
    assert.equal(expandCopyright('Copyright © {year} Acme, {year}', new Date('2027-03-01T00:00:00Z')), 'Copyright © 2027 Acme, 2027');
    const stamped = stampOwnership({ copyright: 'Copyright © {year} Acme' }, { now: new Date('2027-03-01T10:00:00Z') });
    assert.equal(stamped.copyright, 'Copyright © 2027 Acme');
});

test('the first save time is written once and the last save time every time', () => {
    const first = stampOwnership(null, { now: new Date('2026-11-05T09:14:02Z'), version: '1.4.0' });
    assert.deepEqual(first, { firstSavedAt: '2026-11-05T09:14:02Z', lastSavedAt: '2026-11-05T09:14:02Z', savedWith: '1.4.0' });
    const second = stampOwnership(first, { now: new Date('2026-11-12T16:40:31Z'), version: '1.5.0' });
    assert.equal(second.firstSavedAt, '2026-11-05T09:14:02Z');
    assert.equal(second.lastSavedAt, '2026-11-12T16:40:31Z');
    assert.equal(second.savedWith, '1.5.0');
});

test('save times alone are not details a person wrote', () => {
    assert.equal(hasUserDetails(stampOwnership(null, { now: new Date() })), false);
    assert.equal(hasUserDetails({ owner: 'A' }), true);
    assert.equal(hasUserDetails(null), false);
});

test('defaults start empty and seed a new project only with what was set', () => {
    assert.deepEqual(normalizeOwnershipDefaults(undefined), {});
    assert.equal(seedOwnership({}), null);
    assert.deepEqual(seedOwnership({ owner: 'Acme', license: { id: 'MIT' }, revision: '9', firstSavedAt: '2026-01-01T00:00:00Z' }), { owner: 'Acme', license: { id: 'MIT' } });
});

test('another owner is kept, and "make this my own" keeps where the work came from', () => {
    const theirs = { owner: 'Konjugate contributors', title: 'Heat Exchanger', license: { id: 'MPL-2.0' }, firstSavedAt: '2026-01-01T00:00:00Z' };
    assert.equal(isSomeoneElses(theirs, { owner: 'Me' }), true);
    assert.equal(isSomeoneElses(theirs, { owner: 'Konjugate contributors' }), false);
    assert.equal(isSomeoneElses({ title: 'x' }, { owner: 'Me' }), false);
    const mine = makeOwnershipMine(theirs, { owner: 'Me', license: { id: 'MIT' } });
    assert.equal(mine.owner, 'Me');
    assert.deepEqual(mine.license, { id: 'MIT' });
    assert.equal(mine.derivedFrom, 'Heat Exchanger, by Konjugate contributors, license MPL-2.0');
    assert.equal(mine.firstSavedAt, '2026-01-01T00:00:00Z');
    const again = makeOwnershipMine({ owner: 'Me', derivedFrom: 'Earlier work' }, {});
    assert.equal(again.derivedFrom, 'by Me; Earlier work');
});

test('exports name the owner, copyright and license, and say nothing when there is nothing to say', () => {
    const block = { owner: 'Acme', copyright: 'Copyright © {year} Acme', license: { id: 'custom', text: 'Internal use only' }, contact: 'models@acme.example' };
    const now = new Date('2027-01-01T00:00:00Z');
    assert.deepEqual(exportNoticeLines(block, now), ['Copyright © 2027 Acme', 'License: Internal use only', 'Contact: models@acme.example']);
    assert.deepEqual(exportNoticeLines({ owner: 'Acme' }), ['Owner: Acme']);
    assert.deepEqual(exportNoticeLines(null), []);
    assert.deepEqual(exportNoticeLines({ revision: '2' }), []);
    assert.deepEqual(fmiAttributes(block, now), { author: 'Acme', copyright: 'Copyright © 2027 Acme', license: 'Internal use only' });
    assert.deepEqual(fmiAttributes(null), {});
    assert.equal(licenseText({ id: 'all-rights-reserved' }), 'All rights reserved');
    assert.equal(licenseText({ id: 'MIT' }), 'MIT');
});

test('encrypting is suggested for reserved or confidential models that are not encrypted', () => {
    assert.equal(suggestsEncryption({ license: { id: 'all-rights-reserved' } }, false), true);
    assert.equal(suggestsEncryption({ confidential: true }, false), true);
    assert.equal(suggestsEncryption({ confidential: true }, true), false);
    assert.equal(suggestsEncryption({ license: { id: 'MIT' } }, false), false);
    assert.equal(suggestsEncryption(null, false), false);
});
