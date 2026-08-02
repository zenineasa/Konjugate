/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const examplesDirectory = join(import.meta.dirname, '..', 'examples');

test('every bundled example has one companion guide', async () => {
    const files = await readdir(examplesDirectory);
    const exampleStems = files.filter((file) => file.endsWith('.konjugate.json')).map((file) => file.replace(/\.konjugate\.json$/, '')).sort();
    const guideStems = files.filter((file) => file.endsWith('.md')).map((file) => file.replace(/\.md$/, '')).sort();
    assert.deepEqual(guideStems, exampleStems);

    for (const stem of guideStems) {
        const guide = await readFile(join(examplesDirectory, `${stem}.md`), 'utf8');
        assert.match(guide, /^<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->/);
        for (const heading of ['Overview', 'Model structure', 'Expected behaviour', 'Simplifications']) {
            assert.match(guide, new RegExp(`^## ${heading}$`, 'm'), `${stem}.md is missing its ${heading} section.`);
        }
    }
});
