/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs one importer in a worker thread (see src/launcherHost.mjs). The importer is a pure function of
// the file texts it is given: it receives no file or network handle of its own, only two of
// Konjugate's own equation helpers and a reader for JSON files inside its own package.
//
// A worker limits accidents (a runaway loop, a memory blow-up); it is not a hardening boundary
// against hostile code. Importers ship in packages the user chose to install, with the same
// install-time trust plugins have (docs/proposals/launcherAddons.md, "Part 4: importers").

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { reconcileEquationBindings, validateEquationLatex } from './equationModel.mjs';

const { entry, packageRoot, files } = workerData;
const root = resolve(packageRoot);

const helpers = {
    reconcileEquationBindings,
    validateEquationLatex,
    async readPackageJson(relativePath) {
        const target = resolve(root, relativePath);
        if (isAbsolute(relativePath) || !target.startsWith(`${root}${sep}`) || !target.endsWith('.json')) throw new Error('An importer may read only JSON files inside its own package.');
        return JSON.parse(await readFile(target, 'utf8'));
    }
};

try {
    const module = await import(pathToFileURL(join(root, entry)).href);
    if (typeof module.default !== 'function') throw new Error('An importer must export a default function.');
    parentPort.postMessage({ ok: true, result: await module.default({ files, helpers }) });
} catch (error) {
    parentPort.postMessage({ ok: false, message: error.message });
}
