/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { availableSettingsPages, defaultSettingsPage, matchingSettingsPages, settingsPage, settingsPages } from '../src/renderer/settingsPages.mjs';

test('Settings has one entry per page, each with an id, a title, an icon and the words a search finds it by', () => {
    assert.deepEqual(settingsPages.map((page) => page.id), ['general', 'assistant', 'providers', 'controllers', 'pushService', 'newProjects'], 'The Extensions Explorer is not a page of Settings.');
    assert.equal(new Set(settingsPages.map((page) => page.id)).size, settingsPages.length);
    for (const page of settingsPages) {
        assert.ok(page.title && page.icon && page.keywords.length, `${page.id} is missing its title, icon or keywords.`);
        assert.ok(Object.isFrozen(page));
    }
    assert.equal(settingsPage(defaultSettingsPage).title, 'General');
    assert.equal(settingsPage('nonexistent'), null);
});

test('a search finds pages by title, keyword or what the page says, every word typed, in any case and accent', () => {
    const ids = (query, textOf) => matchingSettingsPages(query, textOf).map((page) => page.id);
    assert.deepEqual(ids(''), settingsPages.map((page) => page.id), 'An empty search finds every page.');
    assert.deepEqual(ids('  '), settingsPages.map((page) => page.id));
    assert.deepEqual(ids('MIDI'), ['controllers']);
    assert.deepEqual(ids('python'), ['providers']);
    assert.deepEqual(ids('license'), ['newProjects']);
    assert.deepEqual(ids('model'), ['assistant'], 'A title is searched as well as the keywords.');
    assert.deepEqual(ids('api key'), ['assistant'], 'Every word must be found.');
    assert.deepEqual(ids('python midi'), []);
    // What the page itself says is searched too, so a label on a page finds it without a keyword for it.
    assert.deepEqual(ids('dead zone', (id) => (id === 'controllers' ? 'A stick’s dead zone around its centre' : '')), ['controllers']);
    assert.deepEqual(ids('écran', (id) => (id === 'general' ? 'Taille de l’ecran' : '')), ['general'], 'Accents do not matter.');
});

test('a page that needs what a window lacks is not offered: the push service only where the app can listen on a port', () => {
    const ids = (has) => availableSettingsPages(has).map((page) => page.id);
    assert.deepEqual(ids(() => true), settingsPages.map((page) => page.id));
    assert.deepEqual(ids((requirement) => requirement !== 'pushService'), ['general', 'assistant', 'providers', 'controllers', 'newProjects']);
    assert.equal(settingsPage('pushService').requires, 'pushService');
    assert.deepEqual(matchingSettingsPages('certificate').map((page) => page.id), ['pushService'], 'The old name, and what the page is about, find it.');
    assert.deepEqual(matchingSettingsPages('connections').map((page) => page.id), ['pushService']);
});
