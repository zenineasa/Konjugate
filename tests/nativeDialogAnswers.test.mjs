/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeDialogAnswers, describeDialog, normalizeAnswer } from './drivers/nativeDialogAnswers.mjs';

// The prompt main.mjs shows before a modified project is replaced.
const discardPrompt = {
    kind: 'message',
    title: 'Unsaved changes',
    message: 'Discard unsaved changes?',
    detail: 'Unsaved model changes or simulation results cannot be recovered after closing or opening another project.',
    buttons: ['Cancel', 'Discard changes'],
    cancelId: 0
};

test('a dialog with no answer queued is cancelled, as a person backing out would', () => {
    const answers = createNativeDialogAnswers();
    assert.deepEqual(answers.answer(discardPrompt).result, { response: 0, checkboxChecked: false });
    assert.deepEqual(answers.answer({ kind: 'save', title: 'Save project' }).result, { canceled: true, filePath: '' });
    assert.deepEqual(answers.answer({ kind: 'open', title: 'Open project' }).result, { canceled: true, filePaths: [] });
    assert.equal(answers.answer({ kind: 'confirm', message: 'Delete it?', source: 'renderer' }).result, false);
    assert.equal(answers.answer({ kind: 'alert', message: 'Too many', source: 'renderer' }).result, undefined);
    assert.equal(answers.answer({ kind: 'prompt', message: 'Name?', source: 'renderer' }).result, null);
    // With no cancel button named, one labelled as backing out; else the first.
    assert.equal(answers.answer({ kind: 'message', message: 'Install?', buttons: ['Install', 'Don\'t install'] }).result.response, 1);
    assert.equal(answers.answer({ kind: 'message', message: 'Done', buttons: ['OK'] }).result.response, 0);
    assert.ok(answers.records().every((record) => /^cancelled/.test(record.answer)));
});

test('a message box is answered by the label of a button', () => {
    const answers = createNativeDialogAnswers();
    answers.queue({ button: 'Discard changes' });
    const { result, record } = answers.answer(discardPrompt);
    assert.deepEqual(result, { response: 1, checkboxChecked: false });
    assert.equal(record.answer, 'pressed "Discard changes"');
    assert.deepEqual(record.buttons, ['Cancel', 'Discard changes']);
    assert.equal(record.message, 'Discard unsaved changes?');
    assert.equal(record.detail, discardPrompt.detail);
    assert.equal(record.error, undefined);
});

test('a label the dialog does not offer is an error naming the buttons it does, and the dialog is cancelled', () => {
    const answers = createNativeDialogAnswers();
    answers.queue({ button: 'Discard' });
    const { result, record } = answers.answer(discardPrompt);
    assert.equal(result.response, 0);
    assert.match(record.error, /"Discard unsaved changes\?" has no "Discard" button; it offers "Cancel", "Discard changes"/);
});

test('a response by index, and a checkbox', () => {
    const answers = createNativeDialogAnswers();
    answers.queue({ response: 1, checkboxChecked: true });
    assert.deepEqual(answers.answer({ ...discardPrompt, checkboxLabel: 'Remember' }).result, { response: 1, checkboxChecked: true });
    answers.queue({ response: 5 });
    assert.match(answers.answer(discardPrompt).record.error, /has no button 5; it offers "Cancel", "Discard changes"/);
});

test('a window\'s confirm and alert take message answers, with Electron\'s OK and Cancel buttons', () => {
    const answers = createNativeDialogAnswers();
    answers.queue({ button: 'OK' });
    answers.queue({ button: 'Cancel' });
    answers.queue({ button: 'OK' });
    assert.equal(answers.answer({ kind: 'confirm', message: 'Delete it?', source: 'renderer' }).result, true);
    assert.equal(answers.answer({ kind: 'confirm', message: 'Delete it?', source: 'renderer' }).result, false);
    const alert = answers.answer({ kind: 'alert', message: 'Too many', source: 'renderer' });
    assert.equal(alert.record.answer, 'pressed "OK"');
    assert.deepEqual(alert.record.buttons, ['OK']);
    assert.equal(alert.record.source, 'renderer');
});

test('answers are queued per kind and used in order', () => {
    const answers = createNativeDialogAnswers();
    answers.queue({ filePath: '/tmp/a.kjt' });
    answers.queue({ filePaths: ['/tmp/b.kjt', '/tmp/c.kjt'] });
    answers.queue({ filePath: '/tmp/d.kjt' });
    answers.queue({ text: 'Plant' });
    // A message box comes first: no message answer is queued, so it is cancelled, and the file answers wait for their own kinds.
    assert.equal(answers.answer(discardPrompt).result.response, 0);
    assert.deepEqual(answers.answer({ kind: 'open', title: 'Open' }).result, { canceled: false, filePaths: ['/tmp/b.kjt', '/tmp/c.kjt'] });
    assert.deepEqual(answers.answer({ kind: 'save', title: 'Save' }).result, { canceled: false, filePath: '/tmp/a.kjt' });
    assert.deepEqual(answers.answer({ kind: 'save', title: 'Save' }).result, { canceled: false, filePath: '/tmp/d.kjt' });
    assert.deepEqual(answers.answer({ kind: 'save', title: 'Save' }).result, { canceled: true, filePath: '' });
    assert.equal(answers.answer({ kind: 'prompt', message: 'Name?' }).result, 'Plant');
    assert.deepEqual(answers.queued(), []);
});

test('a queued cancel, and an answer expecting particular wording', () => {
    const answers = createNativeDialogAnswers();
    answers.queue({ kind: 'message', cancel: true, expect: 'Discard unsaved' });
    assert.equal(answers.answer(discardPrompt).record.answer, 'cancelled (as queued)');
    answers.queue({ button: 'Discard changes', expect: /cannot be recovered/ });
    assert.equal(answers.answer(discardPrompt).result.response, 1);
    answers.queue({ button: 'Discard changes', expect: 'Replace the objective' });
    const wrong = answers.answer(discardPrompt);
    assert.equal(wrong.result.response, 0);
    assert.match(wrong.record.error, /queued for a dialog saying "Replace the objective" came to the message dialog "Discard unsaved changes\?"/);
});

test('the policy for dialogs with no answer queued', () => {
    const failing = createNativeDialogAnswers({ unmatched: 'fail' });
    const { result, record } = failing.answer(discardPrompt);
    assert.equal(result.response, 0, 'Still cancelled: the app is never left waiting.');
    assert.match(record.error, /came with no answer queued for it/);
    const chosen = createNativeDialogAnswers({ unmatched: (dialog) => (dialog.message.startsWith('Discard') ? { button: 'Discard changes' } : undefined) });
    assert.equal(chosen.answer(discardPrompt).result.response, 1);
    assert.equal(chosen.answer({ kind: 'confirm', message: 'Delete it?' }).result, false);
    chosen.setUnmatched('cancel');
    assert.equal(chosen.answer(discardPrompt).result.response, 0);
    assert.throws(() => chosen.setUnmatched('accept'), /'cancel', 'fail' or a function/);
});

test('error boxes, certificate prompts and outside apps are recorded, with nothing to answer', () => {
    const answers = createNativeDialogAnswers({ unmatched: 'fail' });
    const error = answers.answer({ kind: 'error', title: 'A JavaScript error occurred in the main process', message: 'TypeError: x' });
    assert.equal(error.record.answer, 'dismissed');
    assert.equal(error.record.error, undefined);
    const outside = answers.answer({ kind: 'external', message: 'shell.openExternal https://example.com', url: 'https://example.com' });
    assert.equal(outside.record.answer, 'not opened');
    assert.match(describeDialog(outside.record), /outside app .*not opened/);
});

test('take gives the dialogs since it was last called; clearQueued drops unused answers', () => {
    const answers = createNativeDialogAnswers();
    answers.answer(discardPrompt);
    assert.equal(answers.take().length, 1);
    assert.equal(answers.take().length, 0);
    answers.answer(discardPrompt);
    answers.answer({ kind: 'save', title: 'Save' });
    assert.deepEqual(answers.take().map((record) => record.kind), ['message', 'save']);
    assert.equal(answers.records().length, 3);
    answers.queue({ button: 'OK' });
    assert.equal(answers.clearQueued().length, 1);
    assert.deepEqual(answers.queued(), []);
});

test('a mistaken answer is refused when it is queued, not when a dialog comes', () => {
    assert.throws(() => normalizeAnswer({}), /says what to answer/);
    assert.throws(() => normalizeAnswer({ button: '' }), /label of a button/);
    assert.throws(() => normalizeAnswer({ response: -1 }), /index of a button/);
    assert.throws(() => normalizeAnswer({ filePaths: [] }), /one or more paths/);
    assert.throws(() => normalizeAnswer({ filePath: 3 }), /is a path/);
    assert.throws(() => normalizeAnswer({ kind: 'colour', cancel: true }), /kind is one of/);
    assert.throws(() => normalizeAnswer({ button: 'OK', expect: 3 }), /string or a RegExp/);
    assert.equal(normalizeAnswer({ kind: 'confirm', button: 'OK' }).kind, 'message');
});

test('one line describing a dialog and its answer', () => {
    const answers = createNativeDialogAnswers();
    answers.queue({ button: 'Discard changes' });
    assert.equal(describeDialog(answers.answer(discardPrompt).record), 'a native message dialog, "Discard unsaved changes?" [Cancel | Discard changes]: pressed "Discard changes"');
    assert.equal(describeDialog(answers.answer({ kind: 'confirm', message: 'Delete it?', source: 'renderer' }).record), 'a native confirm dialog from a window, "Delete it?" [OK | Cancel]: cancelled');
});

test('a dialog the watchdog caught is noted in order with the rest, each record numbered', () => {
    const answers = createNativeDialogAnswers();
    answers.answer(discardPrompt);
    const caught = answers.note({ kind: 'confirm', source: 'renderer', message: 'Delete it?', answer: 'dismissed by the watchdog', bypassed: true, error: 'past the interception' });
    answers.answer({ kind: 'save', title: 'Save' });
    assert.deepEqual(answers.records().map((record) => record.id), [1, 2, 3]);
    assert.equal(caught.id, 2);
    assert.deepEqual(answers.take().map((record) => record.kind), ['message', 'confirm', 'save']);
    assert.match(describeDialog(answers.records()[1]), /from a window, "Delete it\?": dismissed by the watchdog -- past the interception/);
});
