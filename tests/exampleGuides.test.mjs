/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { decodeProjectBundle, inspectProjectFile } from '../src/projectFile.mjs';

const examplesDirectory = join(import.meta.dirname, '..', 'examples');

test('every bundled example has one companion guide', async () => {
    const files = await readdir(examplesDirectory);
    const exampleStems = files.filter((file) => file.endsWith('.kjt')).map((file) => file.replace(/\.kjt$/, '')).sort();
    const guideStems = files.filter((file) => file.endsWith('.md')).map((file) => file.replace(/\.md$/, '')).sort();
    assert.deepEqual(guideStems, exampleStems);

    for (const stem of guideStems) {
        const example = await readFile(join(examplesDirectory, `${stem}.kjt`));
        assert.deepEqual(inspectProjectFile(example), { format: 'kjt', encrypted: false, version: 1 });
        const bundle = await decodeProjectBundle(example);
        assert.equal(bundle.result, null, `${stem}.kjt should be a model-only example.`);
        assert.equal(JSON.parse(bundle.content).format, 'konjugate');
        const guide = await readFile(join(examplesDirectory, `${stem}.md`), 'utf8');
        assert.match(guide, /^<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->/);
        for (const heading of ['Overview', 'Model structure', 'Expected behaviour', 'Simplifications']) {
            assert.match(guide, new RegExp(`^## ${heading}$`, 'm'), `${stem}.md is missing its ${heading} section.`);
        }
    }
});
