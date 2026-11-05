/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes the shipped examples' ownership block (scripts/exampleOwnership.mjs) into every examples/*.kjt, in place of the notice the
// application used to write into every project it saved. Run it after adding an example or changing the block:
//   node scripts/stampExampleOwnership.mjs
// Each file keeps its model exactly as it was; only the top-level `copyright` string goes and `ownership` takes its place. A file that
// already carries the block is left untouched, so running it again changes nothing.

import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeProjectBundle, encodeProjectFile } from '../src/projectFile.mjs';
import { exampleOwnership, exampleTitle } from './exampleOwnership.mjs';

const directory = join(import.meta.dirname, '..', 'examples');
const changed = [];

for (const name of (await readdir(directory)).filter((file) => file.endsWith('.kjt')).sort()) {
    const path = join(directory, name);
    const bundle = await decodeProjectBundle(await readFile(path));
    if (bundle.resultBranches?.length || bundle.result) throw new Error(`${name} carries a result; this script only stamps model-only examples.`);
    const document = JSON.parse(bundle.content);
    const title = exampleTitle(await readFile(join(directory, name.replace(/\.kjt$/, '.md')), 'utf8'));
    const ownership = exampleOwnership(title);
    if (JSON.stringify(document.ownership) === JSON.stringify(ownership) && document.copyright === undefined) continue;
    // Keep the key order: the block takes the place of the old notice, right after the version.
    const stamped = {};
    for (const [key, value] of Object.entries(document)) {
        if (key === 'copyright' || key === 'ownership') continue;
        stamped[key] = value;
        if (key === 'version') stamped.ownership = ownership;
    }
    const compact = !/\n/.test(bundle.content);
    const content = compact ? JSON.stringify(stamped) : `${JSON.stringify(stamped, null, 4)}\n`;
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, await encodeProjectFile(content));
    await rename(temporaryPath, path);
    changed.push(name);
}
console.log(changed.length ? `Stamped ${changed.length} example${changed.length === 1 ? '' : 's'}: ${changed.join(', ')}` : 'Every example already carries the block.');
