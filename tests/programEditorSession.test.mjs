/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
    confirmLeave, createEditorSession, formatLabel, leaveQuestion, portDeclarationLine, problemCountText, programEditorTitle, sameTarget
} from '../src/providerEditor/editorSession.mjs';

test('a loaded program has nothing to apply; typing makes it unsaved, and typing it back makes it saved again', () => {
    const session = createEditorSession();
    session.load('a');
    assert.equal(session.applyState, 'clean');
    assert.equal(session.dirty, false);
    session.edit('ab');
    assert.equal(session.applyState, 'dirty');
    assert.equal(session.closeAction(), 'ask');
    session.edit('a');
    assert.equal(session.applyState, 'clean');
    assert.equal(session.closeAction(), 'close');
});

test('Apply sends the source once, refuses a second while one is in flight, and saves what was sent', () => {
    const session = createEditorSession();
    session.load('a');
    assert.equal(session.beginApply(), null, 'nothing to apply');
    session.edit('b');
    assert.equal(session.beginApply(), 'b');
    assert.equal(session.applyState, 'applying');
    assert.equal(session.beginApply(), null, 'a second apply would race the first');
    session.edit('bc'); // typed while the apply was in flight
    assert.equal(session.finishApply({ applied: true }), true);
    assert.equal(session.applyState, 'dirty', 'the newer keystrokes are still unsaved');
    session.edit('b');
    assert.equal(session.applyState, 'clean');
});

test('a refused apply keeps the changes unsaved and says why', () => {
    const session = createEditorSession();
    session.load('a');
    session.edit('b');
    session.beginApply();
    assert.equal(session.finishApply({ applied: false, error: 'This relationship no longer exists.' }), false);
    assert.equal(session.applyState, 'failed');
    assert.equal(session.failure, 'This relationship no longer exists.');
    assert.equal(session.dirty, true);
    assert.equal(session.closeAction(), 'ask');
});

test('leaving: nothing unsaved leaves without asking', async () => {
    const session = createEditorSession();
    session.load('a');
    let asked = false;
    assert.equal(await confirmLeave(session, { ask: async () => { asked = true; return 'keep'; }, apply: async () => ({ applied: true }) }), true);
    assert.equal(asked, false);
});

test('leaving with unsaved changes: Keep editing stays, Don\'t apply leaves the model unchanged, Apply leaves once applied', async () => {
    const applied = [];
    const apply = async (source) => { applied.push(source); return { applied: true }; };
    const session = createEditorSession();
    session.load('a');
    session.edit('b');
    assert.equal(await confirmLeave(session, { ask: async () => 'keep', apply }), false);
    assert.equal(session.dirty, true);
    assert.equal(await confirmLeave(session, { ask: async () => 'discard', apply }), true);
    assert.deepEqual(applied, [], 'Don\'t apply sends nothing to the model');
    assert.equal(await confirmLeave(session, { ask: async () => 'apply', apply }), true);
    assert.deepEqual(applied, ['b']);
    assert.equal(session.dirty, false);
});

test('leaving with Apply stays when the project refuses the change', async () => {
    const session = createEditorSession();
    session.load('a');
    session.edit('b');
    assert.equal(await confirmLeave(session, { ask: async () => 'apply', apply: async () => ({ applied: false, error: 'Results are locked' }) }), false);
    assert.equal(session.applyState, 'failed');
    assert.equal(await confirmLeave(session, { ask: async () => 'apply', apply: async () => { throw new Error('gone'); } }), false);
    assert.equal(session.failure, 'gone');
});

test('the words: title, question, format and problem count', () => {
    assert.equal(programEditorTitle('Heater'), 'Heater · Program');
    assert.equal(programEditorTitle('Wall → Room'), 'Wall → Room · Program');
    assert.equal(programEditorTitle(''), 'Program');
    assert.equal(leaveQuestion('Heater'), 'Apply your changes to Heater’s program?');
    assert.equal(formatLabel('cpp', 2), 'C++ · version 2');
    assert.equal(formatLabel('python', 1), 'Python · older format');
    assert.equal(formatLabel('python', 1, false), 'Python');
    assert.equal(problemCountText(0), 'No problems');
    assert.equal(problemCountText(1), '1 problem');
    assert.equal(problemCountText(3), '3 problems');
});

test('targets and port lines', () => {
    assert.equal(sameTarget({ type: 'node', nodeId: 3 }, { type: 'node', nodeId: 3 }), true);
    assert.equal(sameTarget({ type: 'node', nodeId: 3 }, { type: 'node', nodeId: 4 }), false);
    assert.equal(sameTarget(null, null), true);
    const source = 'class P : public k::Node {\n    k::Input setpoint{this, "setpoint", "K"};\n    k::Input measurement{this, "measurement", "K"};\n};';
    assert.equal(portDeclarationLine(source, 'measurement'), 3);
    assert.equal(portDeclarationLine("    power = k.Output('power', 'W')", 'power'), 1);
    assert.equal(portDeclarationLine(source, 'missing'), null);
    assert.equal(portDeclarationLine('class P(Node):\n    measurement = Input("K")\n    power = Output("W")\n', 'power'), 3);
    assert.equal(portDeclarationLine('    y.power = 3\n    power = Output("W")\n', 'power'), 2, 'a use is not a declaration');
    assert.equal(portDeclarationLine(source, ''), null);
});

test('the editor core runs without Electron globals: it loads in plain Node and names no Electron bridge', async () => {
    const directory = join(import.meta.dirname, '..', 'src', 'providerEditor');
    for (const file of ['editorCore.mjs', 'editorSession.mjs']) {
        const text = await readFile(join(directory, file), 'utf8');
        assert.doesNotMatch(text.replace(/^\s*\/\/.*$/gm, ''), /\bwindow\.|windowControls|providerEditorWindow|require\(|ipcRenderer|electron/, `${file} must take everything from its host`);
    }
    const core = await import('../src/providerEditor/editorCore.mjs');
    assert.equal(typeof core.createProgramEditor, 'function');
});
