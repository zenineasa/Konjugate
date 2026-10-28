/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Checks a file of requests written by an agent (see evals/assistant/requestGenerationPrompt.md): the tags must be the
// ones the evaluation uses, the model must belong to the domain, and, to keep a training pool clear of the test set,
// nothing may repeat or nearly repeat a test request, and a training request may not use a model reserved for the test.
// Prints what was rejected and why, then warnings for a person to look at (an expected outcome that gives a node a state
// it does not have; too many requests that quote long catalog names word for word), and writes the accepted requests when
// --out is given. Warnings do not reject anything.
//
//   node scripts/checkGeneratedRequests.mjs <requests.json> [--for train|test] [--out <accepted.json>]
//
// The file is a JSON array of { domain, model, family, style, request, expectedOutcome, history? }.

import { readFile, writeFile } from 'node:fs/promises';
import { checkGeneratedRequests, reviewGeneratedRequests } from '../evals/assistant/assistantEvalRequests.mjs';
import { loadEvalBase, loadEvalCases } from '../evals/assistant/assistantEvalFiles.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args.splice(index, 2)[1];
};
const purpose = flag('--for') ?? 'train';
const outPath = flag('--out');
const [inputPath] = args;
if (!inputPath || !['train', 'test'].includes(purpose)) {
    console.error('Usage: node scripts/checkGeneratedRequests.mjs <requests.json> [--for train|test] [--out <accepted.json>]');
    process.exit(2);
}

const items = JSON.parse(await readFile(inputPath, 'utf8'));
if (!Array.isArray(items)) {
    console.error('The file must be a JSON array of requests.');
    process.exit(2);
}
const { accepted, rejected } = checkGeneratedRequests(items, { testCases: await loadEvalCases(), purpose });
for (const { item, reasons } of rejected) console.log(`rejected: ${JSON.stringify(item?.request ?? item)}\n    ${reasons.join('; ')}`);
const documents = {};
for (const model of new Set(accepted.map((item) => item.model))) if (model !== 'blank') documents[model] = await loadEvalBase(model);
const { warnings } = reviewGeneratedRequests(accepted, documents);
for (const { item, message } of warnings) console.log(`warning: ${item ? `${JSON.stringify(item.request)}\n    ` : ''}${message}`);
const count = (key) => Object.entries(accepted.reduce((totals, item) => ({ ...totals, [item[key]]: (totals[item[key]] ?? 0) + 1 }), {})).sort().map(([value, total]) => `${value} ${total}`).join(', ');
console.log(`\n${accepted.length} accepted, ${rejected.length} rejected, ${warnings.length} warning(s) (for ${purpose}).`);
if (accepted.length) for (const key of ['domain', 'family', 'style']) console.log(`${key}: ${count(key)}`);
if (outPath) {
    await writeFile(outPath, `${JSON.stringify(accepted, null, 2)}\n`);
    console.log(`Accepted requests written to ${outPath}.`);
}
