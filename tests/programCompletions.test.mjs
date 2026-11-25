/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { completionContext, programCompletions, programDocsUrl, programHover, programSnippets } from '../src/providerEditor/completions.mjs';
import { sourceMemory, sourcePorts } from '../src/providerEditor/sourcePorts.mjs';

const example = (name) => readFile(join(import.meta.dirname, '..', 'examples', 'providers', name), 'utf8');
const declaredOf = (kind, source) => ({ ...sourcePorts(kind, source), memory: sourceMemory(kind, source) });
const labels = (answer) => answer?.options.map((option) => option.label) ?? null;
const bindings = { measurement: { label: 'Room · Temperature', value: 293.15 }, setpoint: { label: 'Setpoint', value: 295 } };

test('the context at the cursor: after x. or x[, m., setup., y[ and k::, or a word', () => {
    assert.deepEqual(completionContext('python', '        return x.mea'), { what: 'inputsAndMemory', prefix: 'mea', from: 17 });
    assert.equal(completionContext('python', '        m.').what, 'memory');
    assert.equal(completionContext('python', '        k = setup.').what, 'constants');
    assert.equal(completionContext('python', '        x["').what, 'keys');
    assert.equal(completionContext('cpp', '        y[power] = x[').what, 'inputsAndMemory');
    assert.equal(completionContext('cpp', '        y[').what, 'outputs');
    assert.equal(completionContext('cpp', '    k::Mem').what, 'sdk');
    assert.equal(completionContext('cpp', '    clo').what, 'word');
    assert.equal(completionContext('python', '        self.outputs('), null, 'Nothing is being typed.');
});

test('x[ in C++ offers the program\'s own ports and memory, each with its unit and what the model binds it to', async () => {
    const source = await example('pidController.cpp');
    const answer = programCompletions({ kind: 'cpp', before: '        const double e = x[', declared: declaredOf('cpp', source), bindings });
    assert.deepEqual(labels(answer), ['measurement', 'setpoint', 'kp', 'ki', 'kd', 'maxPower', 'sensorNoise', 'integral', 'previousError', 'held'],
        'A random stream is drawn through m, not read through x.');
    const measurement = answer.options[0];
    assert.equal(measurement.detail, 'K · Room · Temperature · = 293.15');
    assert.equal(measurement.info, 'Input measurement');
    assert.equal(answer.options.find((option) => option.label === 'kp').detail, 'W/K · not bound');
    assert.deepEqual(labels(programCompletions({ kind: 'cpp', before: 'y[', declared: declaredOf('cpp', source) })), ['power']);
    assert.deepEqual(labels(programCompletions({ kind: 'cpp', before: 'm[', declared: declaredOf('cpp', source) })), ['integral', 'previousError', 'held', 'noise']);
});

test('x. in Python offers the attributes the code reads, x[" their keys, setup. the constants', async () => {
    const source = await example('pidController.py');
    const declared = declaredOf('python', source);
    assert.ok(labels(programCompletions({ kind: 'python', before: 'x.', declared })).includes('sensor_noise'));
    assert.ok(labels(programCompletions({ kind: 'python', before: 'x["', declared })).includes('sensorNoise'));
    assert.deepEqual(labels(programCompletions({ kind: 'python', before: 'setup.', declared })), ['kp', 'ki', 'kd', 'max_power', 'sensor_noise']);
    assert.deepEqual(labels(programCompletions({ kind: 'python', before: '        m.', declared })), ['integral', 'previous_error', 'held', 'noise']);
});

test('k:: offers the SDK\'s names with their documentation; a word offers the snippets, inserted only when chosen', () => {
    const sdk = programCompletions({ kind: 'cpp', before: 'k::', declared: {} });
    const input = sdk.options.find((option) => option.label === 'Input');
    assert.ok(input && input.info.length > 5);
    assert.ok(labels(sdk).includes('OutOfDomain') && labels(sdk).includes('optional'));
    assert.equal(programCompletions({ kind: 'cpp', before: '    c', declared: {} }), null, 'One letter offers nothing unless asked.');
    const words = programCompletions({ kind: 'cpp', before: '    c', declared: {}, explicit: true });
    assert.deepEqual(words.options.filter((option) => option.snippet).map((option) => option.label), programSnippets.cpp.map((snippet) => snippet.label));
    assert.deepEqual(programSnippets.python.map((snippet) => snippet.label), ['memory with advance()', 'clock', 'OutOfDomain for a lookup', 'jacobian()']);
    assert.ok(labels(programCompletions({ kind: 'python', before: '    Me', declared: {} })).includes('Memory'), 'Python\'s SDK names as words.');
});

test('hover: an SDK name says what it is and links to where it is explained; a port says its unit, binding and value', async () => {
    const source = await example('pidController.cpp');
    const declared = declaredOf('cpp', source);
    const sdk = programHover({ kind: 'cpp', name: 'OutOfDomain', before: '    throw k::', declared });
    assert.equal(sdk.title, 'k::OutOfDomain');
    assert.equal(sdk.link, `${programDocsUrl}#errors-and-outofdomain`);
    assert.equal(programHover({ kind: 'cpp', name: 'OutOfDomain', before: '    throw ', declared }), null, 'Not the SDK\'s without k::.');
    assert.deepEqual(programHover({ kind: 'cpp', name: 'measurement', before: '    x[', declared, bindings }),
        { title: 'Input measurement', text: 'K · Room · Temperature · = 293.15', link: null, linkText: null });
    assert.equal(programHover({ kind: 'cpp', name: 'integral', declared }).title, 'Memory integral');
    assert.equal(programHover({ kind: 'cpp', name: 'nothing', declared }), null);
});
