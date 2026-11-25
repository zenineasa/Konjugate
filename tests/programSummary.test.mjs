/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
    bindingsLine, declaredProgramName, highlightProgramLine, programPreviewLines, programStatus, programStatusKey, programSummary
} from '../src/renderer/programSummary.mjs';
import { defaultProviderSource, olderProviderSource } from '../src/providerTemplate.mjs';

const examples = join(import.meta.dirname, '..', 'examples', 'providers');

test('a program is named by the class it declares, in C++ and Python', async () => {
    assert.equal(declaredProgramName('cpp', await readFile(join(examples, 'pidController.cpp'), 'utf8')), 'PidController');
    assert.equal(declaredProgramName('python', await readFile(join(examples, 'pidController.py'), 'utf8')), 'PidController');
    assert.equal(declaredProgramName('cpp', 'struct Conduction final : public k::Relationship {'), 'Conduction');
    assert.equal(declaredProgramName('python', 'x = 1\n'), '');
});

test('the preview starts at the class, with the lines\' own numbers, at most six', async () => {
    const source = await readFile(join(examples, 'pidController.py'), 'utf8');
    const lines = programPreviewLines('python', source);
    assert.equal(lines.length, 6);
    assert.match(lines[0].text, /^class PidController\(Node\):/);
    assert.equal(source.split('\n')[lines[0].number - 1], lines[0].text);
    assert.equal(lines[1].number, lines[0].number + 1);
    assert.deepEqual(programPreviewLines('python', '   \n'), []);
    assert.deepEqual(programPreviewLines('cpp', '\n\nint x;\n').map((line) => line.number), [3, 4]);
});

test('preview highlighting marks keywords, strings, numbers and comments', () => {
    assert.deepEqual(highlightProgramLine('python', '    power = Output("W")  # watts'), [
        { text: '    power = Output(', type: '' }, { text: '"W"', type: 'string' }, { text: ')  ', type: '' }, { text: '# watts', type: 'comment' }]);
    assert.deepEqual(highlightProgramLine('cpp', 'return 0.5; // half').map((token) => token.type), ['keyword', '', 'number', '', 'comment']);
    assert.deepEqual(highlightProgramLine('cpp', '#include <konjugate/sdk/v2/program.hpp>'), [{ text: '#include <konjugate/sdk/v2/program.hpp>', type: 'preprocessor' }]);
    assert.equal(highlightProgramLine('python', '').length, 0);
});

test('reads and sets in the model\'s names, an unbound port said plainly', () => {
    assert.deepEqual(bindingsLine([{ key: 'setpoint', label: 'Room · Setpoint' }, { key: 'measurement', label: '' }]), [
        { text: 'Room · Setpoint', unbound: false }, { text: 'measurement · not bound', unbound: true }]);
});

test('the one status: older format, a problem at its line, Check passed, or nothing', () => {
    const current = defaultProviderSource('python', [{ key: 'a' }], 'flow', 'Pipe');
    assert.equal(programStatus('python', current, null), null);
    assert.deepEqual(programStatus('python', olderProviderSource('python', [{ key: 'a' }], 'flow', 'Pipe'), null), { kind: 'older', text: 'older format · Convert to version 2 ›' });
    assert.deepEqual(programStatus('python', current, { problems: [{ line: null, message: 'a' }, { line: 17, message: 'b' }] }), { kind: 'problem', text: '2 problems · line 17 ›', line: 17 });
    assert.deepEqual(programStatus('python', current, { problems: [{ line: null, message: 'a' }] }), { kind: 'problem', text: '1 problem ›', line: null });
    assert.deepEqual(programStatus('python', current, { problems: [], checkPassed: true }), { kind: 'passed', text: '✓ passed Check' });
    assert.equal(programStatus('python', '', { checkPassed: true }), null);
    assert.notEqual(programStatusKey('python', current), programStatusKey('cpp', current), 'a status belongs to one language and one exact source');
});

test('the summary of a program and of no program yet', () => {
    const source = defaultProviderSource('cpp', [{ key: 'hot' }, { key: 'cold' }], 'flow', 'Wall');
    const summary = programSummary({ kind: 'cpp', source, reads: [{ key: 'hot', label: 'Wall · T' }], sets: [{ key: 'flow', label: 'Room · T' }] });
    assert.equal(summary.empty, false);
    assert.equal(summary.language, 'C++');
    assert.ok(summary.name);
    assert.equal(summary.reads[0].text, 'Wall · T');
    assert.equal(summary.sets[0].text, 'Room · T');
    assert.ok(summary.preview.length > 0 && summary.preview.length <= 6);
    assert.ok(summary.preview.every((line) => Array.isArray(line.tokens)));
    const empty = programSummary({ kind: 'python', source: '' });
    assert.equal(empty.empty, true);
    assert.deepEqual(empty.preview, []);
    assert.equal(empty.status, null);
});
