/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createMd5 } from '../src/md5.mjs';

test('the sum matches the platform\'s for empty, short, block-sized and long input, however it is cut into pieces', () => {
    for (const size of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100003]) {
        const bytes = randomBytes(size);
        const expected = createHash('md5').update(bytes).digest('hex');
        assert.equal(createMd5().update(bytes).digest(), expected, `${size} bytes at once`);
        const pieces = createMd5();
        for (let at = 0; at < size; at += 7) pieces.update(bytes.subarray(at, Math.min(size, at + 7)));
        assert.equal(pieces.digest(), expected, `${size} bytes in sevens`);
        const uneven = createMd5();
        let at = 0;
        for (let step = 1; at < size; step = (step * 3 + 1) % 200) { uneven.update(bytes.subarray(at, Math.min(size, at + step))); at += step; }
        assert.equal(uneven.digest(), expected, `${size} bytes in uneven pieces`);
    }
    assert.equal(createMd5().update(new TextEncoder().encode('abc')).digest(), '900150983cd24fb0d6963f7d28e17f72');
});
