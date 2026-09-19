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
import { applyAssistantProposal } from './assistantOperations.mjs';
import { reconcileEquationBindings, validateEquationLatex } from './equationModel.mjs';

const { entry, packageRoot, files, options } = workerData;
const root = resolve(packageRoot);

const helpers = {
    reconcileEquationBindings,
    validateEquationLatex,
    // Builds a model from Konjugate's own construction operations (the ones its assistant and its causal-inference
    // import use), starting from an empty project, and returns the project document with the temporary references
    // each operation named mapped to the identifiers they were given.
    applyOperations(operations) {
        const empty = {
            format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath', metadata: { units: 'SI' },
            runConfigurations: [], sharedParameters: [], nodes: [], edges: [], subsystems: [], edgeGroups: []
        };
        const { document, temporaryReferences } = applyAssistantProposal(empty, { proposalVersion: 1, operations });
        return { document, references: temporaryReferences };
    },
    async readPackageJson(relativePath) {
        const target = resolve(root, relativePath);
        if (isAbsolute(relativePath) || !target.startsWith(`${root}${sep}`) || !target.endsWith('.json')) throw new Error('An importer may read only JSON files inside its own package.');
        return JSON.parse(await readFile(target, 'utf8'));
    }
};

try {
    const module = await import(pathToFileURL(join(root, entry)).href);
    if (typeof module.default !== 'function') throw new Error('An importer must export a default function.');
    parentPort.postMessage({ ok: true, result: await module.default({ files, helpers, options }) });
} catch (error) {
    parentPort.postMessage({ ok: false, message: error.message });
}
