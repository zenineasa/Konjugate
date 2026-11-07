/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How the twin's matcher (src/signalMatching.mjs) does on signals named as plants, vendors and labs name them
// (tests/fixtures/plantSignalNames.mjs): right, filled in by itself (75% or more), and never filled in wrong. The held-out names were
// written after the matcher was settled, so they say how it does on names it was not fitted to.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeProjectBundle } from '../src/projectFile.mjs';
import { abbreviates, nameWords, suggestMapping } from '../src/signalMatching.mjs';
import { heldOutSignalNames, plantSignalNames } from './fixtures/plantSignalNames.mjs';

async function measure(sets) {
    const tally = { expected: 0, right: 0, filled: 0, filledWrong: [], distractors: 0, distractorsFilled: [] };
    for (const set of sets) {
        const document = JSON.parse((await decodeProjectBundle(await readFile(join(import.meta.dirname, '..', 'examples', set.model)))).content);
        const suggestions = suggestMapping(set.signals.map((signal, index) => ({ id: String(index), name: signal.name, unit: signal.unit ?? '', role: signal.role })), document);
        set.signals.forEach((signal, index) => {
            const { target, confidence } = suggestions[index];
            const label = target?.label ?? null;
            const filled = confidence >= 0.75;
            if (signal.expected === null) {
                tally.distractors += 1;
                if (label && filled) tally.distractorsFilled.push(`${signal.name} → ${label}`);
                return;
            }
            tally.expected += 1;
            if (label === signal.expected) {
                tally.right += 1;
                if (filled) tally.filled += 1;
            } else if (filled) {
                tally.filledWrong.push(`${signal.name} → ${label}`);
            }
        });
    }
    return tally;
}

test('the names the matcher was settled on: all of them right, most filled in by themselves, none filled in wrong', async () => {
    const tally = await measure(plantSignalNames);
    assert.ok(tally.right >= tally.expected - 2, `${tally.right} of ${tally.expected} right.`);
    assert.ok(tally.filled >= 0.7 * tally.expected, `${tally.filled} of ${tally.expected} filled in by themselves.`);
    assert.deepEqual(tally.filledWrong, [], 'A suggestion filled in by itself is right.');
    assert.deepEqual(tally.distractorsFilled, [], 'A signal the model has nothing for is not filled in.');
});

test('names it was not fitted to: most right, and none filled in wrong', async () => {
    const tally = await measure(heldOutSignalNames);
    assert.ok(tally.right >= 0.8 * tally.expected, `${tally.right} of ${tally.expected} right.`);
    assert.ok(tally.filled >= 0.5 * tally.expected, `${tally.filled} of ${tally.expected} filled in by themselves.`);
    assert.deepEqual(tally.filledWrong, [], 'A suggestion filled in by itself is right.');
    assert.deepEqual(tally.distractorsFilled, []);
});

test('a word shortening another, by its first letters or its consonants', () => {
    assert.equal(abbreviates('disp', 'displacement'), true);
    assert.equal(abbreviates('trq', 'torque'), true);
    assert.equal(abbreviates('rm', 'room'), true);
    assert.equal(abbreviates('hsg', 'housing'), true);
    assert.equal(abbreviates('pt', 'position'), false, 'Two consonants are not enough for a long word.');
    assert.equal(abbreviates('tank', 'temperature'), false);
    assert.equal(abbreviates('dis', 'displacement'), true);
    assert.equal(abbreviates('di', 'displacement'), false);
});

test('a name\'s numbers are read, an instrument\'s loop number aside', () => {
    assert.deepEqual(nameWords('SuctionLine3_Q').numbers, [3]);
    assert.deepEqual(nameWords('TK1_TT101_PV').numbers, [1], 'The tank\'s number, not the transmitter\'s loop.');
    assert.deepEqual(nameWords('BMS_SOC').words.sort(), ['battery', 'charge', 'state']);
    assert.deepEqual(nameWords('OAT').words.sort(), ['ambient', 'temperature']);
});
