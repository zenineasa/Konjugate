/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { isSectionWithin, maximumSectionDepth, moveSection, parseSectionPath, sectionPathProblem, sectionPaths, sectionPathText, sectionTree } from '../src/librarySections.mjs';

const template = (id, name, section) => ({ id, name, section });

test('a typed section path drops the spaces around each name and ignores empty names', () => {
    assert.deepEqual(parseSectionPath('  Pumps /Centrifugal / '), ['Pumps', 'Centrifugal']);
    assert.deepEqual(parseSectionPath(''), []);
    assert.deepEqual(parseSectionPath('//'), []);
    assert.equal(sectionPathText(['Pumps', 'Centrifugal']), 'Pumps / Centrifugal');
});

test('a section that is too deep or too long is refused with a reason', () => {
    assert.throws(() => parseSectionPath('a/b/c/d/e'), new RegExp(`at most ${maximumSectionDepth} deep`));
    assert.throws(() => parseSectionPath('x'.repeat(61)), /at most 60 characters/);
    assert.match(sectionPathProblem(['ok', ' padded']), /leading or trailing/);
    assert.match(sectionPathProblem(['a/b']), /cannot contain/);
    assert.match(sectionPathProblem('Pumps'), /list of names/);
    assert.equal(sectionPathProblem(['Pumps', 'Centrifugal']), null);
});

test('the tree files each template in its own section, with sections and templates in name order', () => {
    const tree = sectionTree([
        template('a', 'Zeta', []), template('b', 'Impeller', ['Pumps', 'Centrifugal']), template('c', 'Gear', ['Pumps']),
        template('d', 'Alpha', []), template('e', 'Valve', ['Fluid']), template('f', 'Casing', ['Pumps', 'Centrifugal'])
    ]);
    assert.deepEqual(tree.templates.map(({ name }) => name), ['Alpha', 'Zeta']);
    assert.deepEqual(tree.children.map(({ name }) => name), ['Fluid', 'Pumps']);
    const pumps = tree.children[1];
    assert.deepEqual(pumps.templates.map(({ name }) => name), ['Gear']);
    assert.deepEqual(pumps.children.map(({ name, path }) => [name, path]), [['Centrifugal', ['Pumps', 'Centrifugal']]]);
    assert.deepEqual(pumps.children[0].templates.map(({ name }) => name), ['Casing', 'Impeller']);
});

test('a section with only a subsection in it still appears, and one with nothing in it does not exist', () => {
    const tree = sectionTree([template('a', 'Deep', ['Outer', 'Inner'])]);
    assert.deepEqual(tree.children.map(({ name }) => name), ['Outer']);
    assert.deepEqual(tree.children[0].templates, []);
    assert.deepEqual(sectionPaths([template('a', 'Deep', ['Outer', 'Inner'])]), [['Outer'], ['Outer', 'Inner']]);
    assert.deepEqual(sectionPaths([]), []);
});

test('renaming a section moves every template in it and below it, and nothing else', () => {
    const templates = [template('a', 'A', ['Pumps']), template('b', 'B', ['Pumps', 'Centrifugal']), template('c', 'C', ['Pumpsets']), template('d', 'D', [])];
    assert.deepEqual(moveSection(templates, ['Pumps'], ['Fluid', 'Pumps']), [
        { id: 'a', section: ['Fluid', 'Pumps'] }, { id: 'b', section: ['Fluid', 'Pumps', 'Centrifugal'] }
    ]);
    assert.deepEqual(moveSection(templates, ['Pumps', 'Centrifugal'], ['Pumps']), [{ id: 'b', section: ['Pumps'] }]);
});

test('a section cannot be moved into itself, and the top level cannot be moved', () => {
    const templates = [template('a', 'A', ['Pumps'])];
    assert.throws(() => moveSection(templates, ['Pumps'], ['Pumps', 'Inner']), /into itself/);
    assert.throws(() => moveSection(templates, [], ['Anywhere']), /top level/);
    assert.deepEqual(moveSection(templates, ['Pumps'], ['Pumps']), [{ id: 'a', section: ['Pumps'] }]);
    assert.equal(isSectionWithin(['Pumps', 'X'], ['Pumps']), true);
    assert.equal(isSectionWithin(['Pumpsets'], ['Pumps']), false);
});
