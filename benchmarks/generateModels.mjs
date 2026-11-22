/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes every benchmark's .kjt models from its problem.mjs, through the same project encoder the app saves with. The runner checks the
// committed files still match what this would write, so a model and its reference cannot drift apart.
//
//   node benchmarks/generateModels.mjs

import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { encodeProjectFile } from '../src/projectFile.mjs';
import { problems } from './problems.mjs';

export function modelDocuments() {
    return problems.flatMap(({ directory, models }) => Object.entries(models).map(([name, build]) => ({ path: join(directory, `${name}.kjt`), document: build() })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    for (const { path, document } of modelDocuments()) {
        await writeFile(path, await encodeProjectFile(`${JSON.stringify(document, null, 4)}\n`));
        console.log(`Wrote ${relative(join(import.meta.dirname, '..'), path)}.`);
    }
}
