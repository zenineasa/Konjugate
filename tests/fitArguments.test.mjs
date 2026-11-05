/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fitArguments } from '../src/fitArguments.mjs';

const paths = { inputPath: 'in.kjt', csvPath: 'm.csv', reportPath: 'r.bin' };

test('a plain fit has only its files and the options that were chosen', () => {
    assert.deepEqual(fitArguments(paths), ['fit', 'in.kjt', 'm.csv', '--report', 'r.bin']);
    assert.deepEqual(fitArguments(paths, { backend: 'nlopt-bobyqa', maxIterations: 50, maxSeconds: 0 }), ['fit', 'in.kjt', 'm.csv', '--report', 'r.bin', '--backend', 'nlopt-bobyqa', '--max-iterations', '50']);
});

test('the desktop engine is also asked for progress and given a stop file, and a time limit is passed on', () => {
    assert.deepEqual(fitArguments({ ...paths, stopPath: 'stop', progress: true }, { maxSeconds: 90 }),
        ['fit', 'in.kjt', 'm.csv', '--report', 'r.bin', '--progress-stream', '--stop-file', 'stop', '--max-seconds', '90']);
});

test('an objective is always passed as a file, in either edition, and cannot be forgotten', () => {
    const args = fitArguments({ ...paths, objectivePath: 'o.json' }, { objective: { expression: 'final(a)' } });
    assert.deepEqual(args.slice(-2), ['--objective-file', 'o.json']);
    assert.throws(() => fitArguments(paths, { objective: { expression: 'final(a)' } }), /somewhere to write the objective/);
});
