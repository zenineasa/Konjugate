/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizePacing } from '../src/engineAdapter.mjs';
import {
    causalMappingCreateValue,
    causalMappingValue,
    equationOutputValue,
    pacingFromValue,
    parseCausalMappingValue,
    parseEquationOutput,
    parseProviderReference,
    providerReferenceValue
} from '../src/selectValues.mjs';

const roles = ['source', 'target'];
// Includes 0, a multi-digit id, and the largest integers a number holds exactly.
const ids = [0, 1, 7, 12, 255, 99999, 2 ** 31, Number.MAX_SAFE_INTEGER];
const notStrings = [undefined, null, 7, 0, true, {}, [], ['target:7'], () => 'target:7'];

// A fixed-seed generator, so a failing fuzz case is reproducible rather than a flake.
function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// Half the cases are random concatenations of pieces that mean something to the parsers; the other
// half start from a VALID value and apply zero to two small mutations (drop, insert, swap or repeat a
// character). The second kind is what probes the edges: values one character away from acceptable.
const fuzzPieces = ['source', 'target', 'state', 'parameter', 'create', 'realTime', 'builderParameter0', ':', ':', ':', '0', '1', '7', '12',
    '07', '-1', '1.5', '1e3', ' ', '', 'x', 'Infinity', '9007199254740993'];
const mutationAlphabet = ':0123456789 -+.eExst';
function validValue(random) {
    const pick = (list) => list[Math.floor(random() * list.length)];
    const id = () => String(Math.floor(random() * 50));
    switch (Math.floor(random() * 5)) {
        case 0: return `${pick(roles)}:${id()}`;
        case 1: return `state:${pick(roles)}:${id()}:${id()}`;
        case 2: return `parameter:${id()}`;
        case 3: return `${id()}:${id()}`;
        default: return pick(['create', 'realTime', 'fastest', `limitedRatio:${id()}`]);
    }
}
function mutate(value, random) {
    const at = Math.floor(random() * (value.length + 1));
    const character = mutationAlphabet[Math.floor(random() * mutationAlphabet.length)];
    switch (Math.floor(random() * 4)) {
        case 0: return value.slice(0, at) + value.slice(at + 1);
        case 1: return value.slice(0, at) + character + value.slice(at);
        case 2: return value.slice(0, at) + character + value.slice(at + 1);
        default: return value.slice(0, at) + value.slice(at, at + 1) + value.slice(at);
    }
}
function fuzzString(random) {
    if (random() < 0.5) {
        const count = Math.floor(random() * 7);
        return Array.from({ length: count }, () => fuzzPieces[Math.floor(random() * fuzzPieces.length)]).join('');
    }
    let value = validValue(random);
    for (let mutations = Math.floor(random() * 3); mutations > 0; mutations -= 1) value = mutate(value, random);
    return value;
}

// ---- "Updates" dropdown

// Regression: the relationship editor's "Updates" dropdown stored the picked state id as the STRING
// "7" while every state id in the model is the number 7, and the output was then validated with
// ===, so the pick silently fell back to the target's first state (always showing target.x).
test('equation output: the decoded state id is a number that matches the model\'s own ids', () => {
    const picked = parseEquationOutput('target:7');
    assert.deepEqual(picked, { role: 'target', stateId: 7 });
    assert.equal(typeof picked.stateId, 'number');
    const states = [{ id: 6, symbol: 'x' }, { id: 7, symbol: 'vx' }];
    assert.equal(states.find((state) => state.id === picked.stateId)?.symbol, 'vx');
    // What the old parsing produced -- a string -- never matches a numeric id under ===.
    assert.equal(states.some((state) => state.id === 'target:7'.split(':')[1]), false);
});

test('equation output: every role and id round-trips through the encoder and decoder', () => {
    for (const role of roles) {
        for (const stateId of ids) {
            const value = equationOutputValue(role, stateId);
            assert.deepEqual(parseEquationOutput(value), { role, stateId }, value);
            assert.equal(typeof parseEquationOutput(value).stateId, 'number');
        }
    }
});

test('equation output: the encoder tolerates a missing state (a provider with no output yet) and the decoder refuses it', () => {
    assert.equal(equationOutputValue('target', null), 'target:');
    assert.equal(equationOutputValue('target', undefined), 'target:');
    assert.equal(parseEquationOutput('target:'), null);
});

test('equation output: anything that is not exactly "<source|target>:<canonical id>" is refused', () => {
    const rejected = ['', ':', 'target', 'target:', ':7', 'sideways:7', 'TARGET:7', 'Target:7', 'target:abc', 'target:7.5', 'target:-1', 'target:+7',
        'target:1e3', 'target: 7', 'target:7 ', 'target:07', 'target:0x10', 'target:7:8', 'target::7', 'target:Infinity', 'target:NaN',
        `target:${Number.MAX_SAFE_INTEGER + 2}`, 'state:target:1:2', 'target;7', 'target.7'];
    for (const value of rejected) assert.equal(parseEquationOutput(value), null, JSON.stringify(value));
    for (const value of notStrings) assert.equal(parseEquationOutput(value), null, String(value));
});

// ---- Provider "Reference" dropdown

test('provider reference: state references round-trip for every role and id', () => {
    for (const role of roles) {
        for (const nodeId of ids) {
            for (const stateId of [0, 3, Number.MAX_SAFE_INTEGER]) {
                const value = providerReferenceValue({ kind: 'state', role, nodeId, stateId });
                assert.deepEqual(parseProviderReference(value), { kind: 'state', role, nodeId, stateId }, value);
            }
        }
    }
});

test('provider reference: a real parameter id comes back as a number, a builder placeholder as its text', () => {
    for (const parameterId of ids) {
        const parsed = parseProviderReference(providerReferenceValue({ kind: 'parameter', parameterId }));
        assert.deepEqual(parsed, { kind: 'parameter', parameterId });
        assert.equal(typeof parsed.parameterId, 'number');
    }
    // The relationship builder refers to parameters that don't exist yet by placeholder names and
    // maps them to real ids afterwards, so these must survive as text.
    assert.deepEqual(parseProviderReference('parameter:builderParameter0'), { kind: 'parameter', parameterId: 'builderParameter0' });
    assert.deepEqual(parseProviderReference(providerReferenceValue({ kind: 'parameter', parameterId: 'builderParameter12' })), { kind: 'parameter', parameterId: 'builderParameter12' });
});

test('provider reference: malformed references are refused', () => {
    const rejected = ['', 'parameter', 'parameter:', 'parameter:a:b', 'state', 'state:target', 'state:target:1', 'state:target:1:2:3', 'state:sideways:1:2',
        'state:target:a:2', 'state:target:1:b', 'state:target:-1:2', 'state:target:1:2.5', 'state:target:01:2', 'state:target::2', 'State:target:1:2',
        'Parameter:1', 'target:1', 'time', ':state:target:1:2'];
    for (const value of rejected) assert.equal(parseProviderReference(value), null, JSON.stringify(value));
    for (const value of notStrings) assert.equal(parseProviderReference(value), null, String(value));
});

// ---- Causal-inference column mapping dropdown

test('causal mapping: "create" and node/state pairs round-trip', () => {
    assert.deepEqual(parseCausalMappingValue(causalMappingCreateValue), { createNew: true });
    for (const nodeId of ids) {
        for (const stateId of [0, 9, Number.MAX_SAFE_INTEGER]) {
            assert.deepEqual(parseCausalMappingValue(causalMappingValue(nodeId, stateId)), { createNew: false, nodeId, stateId });
        }
    }
});

test('causal mapping: only exactly "create" or "<node>:<state>" is accepted', () => {
    const rejected = ['', 'Create', 'create:1', 'create ', '1', '1:', ':1', '1:2:3', '-1:2', '1:-2', '1.5:2', 'a:b', ' 1:2', '01:2', '1:02', 'node:1'];
    for (const value of rejected) assert.equal(parseCausalMappingValue(value), null, JSON.stringify(value));
    for (const value of notStrings) assert.equal(parseCausalMappingValue(value), null, String(value));
});

// ---- Pacing dropdown

test('pacing: every option the page offers is accepted by the engine\'s own validator', async () => {
    const html = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
    const select = /<select id="simulationPacing"[^>]*>([\s\S]*?)<\/select>/.exec(html);
    assert.ok(select, 'the simulationPacing select was not found in index.html');
    const values = [...select[1].matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
    assert.ok(values.length >= 3, 'expected the pacing options to be found');
    for (const value of values) {
        const pacing = normalizePacing(pacingFromValue(value));
        assert.ok(['fastest', 'realTime', 'limitedRatio'].includes(pacing.mode), value);
        assert.ok(Number.isFinite(pacing.simulationSecondsPerWallSecond) && pacing.simulationSecondsPerWallSecond > 0, value);
    }
    // And the value an option names is the one that reaches the engine.
    assert.ok(values.includes('realTime'));
    assert.ok(values.some((value) => value.startsWith('limitedRatio:')));
});

test('pacing: values are shaped as the engine expects', () => {
    assert.deepEqual(pacingFromValue('realTime'), { mode: 'realTime', simulationSecondsPerWallSecond: 1 });
    assert.deepEqual(pacingFromValue('limitedRatio:0.5'), { mode: 'limitedRatio', simulationSecondsPerWallSecond: 0.5 });
    assert.deepEqual(pacingFromValue('limitedRatio:10'), { mode: 'limitedRatio', simulationSecondsPerWallSecond: 10 });
    assert.deepEqual(pacingFromValue('fastest'), { mode: 'fastest', simulationSecondsPerWallSecond: 1 });
    assert.deepEqual(pacingFromValue('limitedRatio'), { mode: 'limitedRatio', simulationSecondsPerWallSecond: 1 });
    assert.doesNotThrow(() => pacingFromValue(undefined));
    assert.doesNotThrow(() => pacingFromValue(null));
});

test('pacing: a malformed value is left for the engine\'s validator to reject, not silently repaired', () => {
    assert.ok(Number.isNaN(pacingFromValue('limitedRatio:abc').simulationSecondsPerWallSecond));
    assert.throws(() => normalizePacing(pacingFromValue('limitedRatio:abc')), /finite positive ratio/);
    assert.throws(() => normalizePacing(pacingFromValue('limitedRatio:-2')), /finite positive ratio/);
    assert.throws(() => normalizePacing(pacingFromValue('bogus:2')), /Unsupported simulation pacing mode/);
});

// ---- Properties over arbitrary input

// The parsers are strict decoders: whatever string one accepts must be exactly what its encoder
// produces for the decoded value. If that holds for every string, no two different strings decode to
// the same thing, and nothing "close enough" -- padding, signs, exponents -- gets through.
test('fuzz: whatever a decoder accepts re-encodes to exactly the same string, and nothing ever throws', () => {
    const random = seededRandom(0xc0ffee);
    let accepted = { output: 0, reference: 0, mapping: 0 };
    for (let iteration = 0; iteration < 40000; iteration += 1) {
        const value = fuzzString(random);
        const output = parseEquationOutput(value);
        if (output) {
            accepted.output += 1;
            assert.equal(equationOutputValue(output.role, output.stateId), value);
        }
        const reference = parseProviderReference(value);
        if (reference) {
            accepted.reference += 1;
            assert.equal(providerReferenceValue(reference), value);
        }
        const mapping = parseCausalMappingValue(value);
        if (mapping) {
            accepted.mapping += 1;
            assert.equal(mapping.createNew ? causalMappingCreateValue : causalMappingValue(mapping.nodeId, mapping.stateId), value);
        }
        assert.doesNotThrow(() => pacingFromValue(value));
    }
    // The generator really does reach each decoder's accepting path, so the property above is not vacuous.
    assert.ok(accepted.output > 1000 && accepted.reference > 1000 && accepted.mapping > 1000, JSON.stringify(accepted));
});

test('fuzz: randomly built valid values always decode back to what built them', () => {
    const random = seededRandom(0x5eed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const randomId = () => (random() < 0.2 ? Math.floor(random() * Number.MAX_SAFE_INTEGER) : Math.floor(random() * 1000));
    for (let iteration = 0; iteration < 5000; iteration += 1) {
        const role = pick(roles);
        const nodeId = randomId();
        const stateId = randomId();
        assert.deepEqual(parseEquationOutput(equationOutputValue(role, stateId)), { role, stateId });
        assert.deepEqual(parseProviderReference(providerReferenceValue({ kind: 'state', role, nodeId, stateId })), { kind: 'state', role, nodeId, stateId });
        assert.deepEqual(parseProviderReference(providerReferenceValue({ kind: 'parameter', parameterId: stateId })), { kind: 'parameter', parameterId: stateId });
        assert.deepEqual(parseCausalMappingValue(causalMappingValue(nodeId, stateId)), { createNew: false, nodeId, stateId });
    }
});

// ---- Guard against the original mistake coming back

// The bug was a dropdown value decoded by hand at the call site (`split(':')`, then used as if it
// were a number). Decoding belongs in selectValues.mjs, where it is tested; this fails if hand
// parsing of this kind reappears in the editor.
test('the editor does not decode dropdown values by hand', async () => {
    const source = await readFile(new URL('../src/renderer/renderer.mjs', import.meta.url), 'utf8');
    const handParsing = source.split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => /\.split\(\s*['"`]:['"`]\s*\)/.test(line) && !line.startsWith('//'));
    assert.deepEqual(handParsing, [], 'decode dropdown values with the functions in src/selectValues.mjs instead');
});
