/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Where the assistant evaluation finds its cases and the models they start from (see assistantEval.mjs).

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { blankEvalDocument } from './assistantEval.mjs';
import { decodeProjectFile } from '../../src/projectFile.mjs';

const root = join(import.meta.dirname, '..', '..');
export const evalCasesPath = join(root, 'evals', 'assistant', 'cases');

// A path is one file or a directory of files, each `{ "cases": [...] }`; cases keep the order of their files.
export async function loadEvalCases(path = evalCasesPath) {
    const files = (await stat(path)).isDirectory()
        ? (await readdir(path)).filter((name) => name.endsWith('.json')).sort().map((name) => join(path, name))
        : [path];
    const cases = [];
    for (const file of files) cases.push(...JSON.parse(await readFile(file, 'utf8')).cases);
    return cases;
}

// `blank`, a model kept with the evaluation (evals/assistant/models/<id>.json), or a bundled example.
export async function loadEvalBase(modelId) {
    if (modelId === 'blank') return blankEvalDocument();
    try {
        return JSON.parse(await readFile(join(root, 'evals', 'assistant', 'models', `${modelId}.json`), 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return JSON.parse(await decodeProjectFile(await readFile(join(root, 'examples', `${modelId}.kjt`))));
}

export const evalReferencePath = join(root, 'evals', 'assistant', 'reference.json');

// A provider that answers each case with its recorded known-good answer, so the cases that have one can be run through
// the whole pipeline without a model. It is how the harness itself, and those cases, are shown to be passable.
export async function loadReferenceProvider(cases) {
    const { responses } = JSON.parse(await readFile(evalReferencePath, 'utf8'));
    const byRequest = new Map(cases.filter((evalCase) => responses[evalCase.id]).map((evalCase) => [evalCase.request, responses[evalCase.id]]));
    return {
        provider: {
            id: 'reference', name: 'Reference answers',
            async generateProposal({ request }) {
                if (!byRequest.has(request)) throw new Error('No reference answer for this request.');
                return structuredClone(byRequest.get(request));
            }
        },
        caseIds: new Set(cases.filter((evalCase) => responses[evalCase.id]).map((evalCase) => evalCase.id))
    };
}
