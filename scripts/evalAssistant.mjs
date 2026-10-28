/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Scores a model provider on the assistant's job: turn a request into a proposal that, applied to a model,
// passes the host and native validators AND leaves the model the way the request asked. It goes through the same
// registry and adapters as the app, so what it measures is what a user gets. Cases are in evals/assistant/cases/ (one file per domain);
// the scoring is in src/assistantEval.mjs.
//
//   node scripts/evalAssistant.mjs <provider> <model> [--endpoint <url>] [--cases <id|family|domain|style>,...] [--cases-file <path>]
//                                  [--repeat <n>] [--think true|false] [--timeout <seconds>] [--out <results.json>] [--no-native] [--verbose]
//   node scripts/evalAssistant.mjs --compare <before.json> <after.json>
//
// <provider> is one of: reference (replays the recorded known-good answers, to check the harness and the cases), localDemonstration, ollama, openAi, nvidia, huggingFace, gemini (the key, if one is needed, is
// read from KONJUGATE_AI_KEY and never printed). Native validation uses out/engine/konjugateEngine when it is built
// (`npm run build:engine`) and is skipped with a note when it is not.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAIProviderRegistry } from '../src/aiProviderRegistry.mjs';
import { createRemoteAIProviders } from '../src/aiRemoteProviders.mjs';
import { blankEvalDocument, runEvalCase, summarizeEvalResults } from '../src/assistantEval.mjs';
import { loadEvalBase, loadEvalCases, loadReferenceProvider } from '../src/assistantEvalFiles.mjs';
import { validateWithEngine } from '../src/engineAdapter.mjs';

const root = join(import.meta.dirname, '..');
const percent = (value) => `${(value * 100).toFixed(0)}%`.padStart(4);

const groupings = [['byFamily', 'Family'], ['byDomain', 'Domain'], ['byStyle', 'Phrasing']];

function printSummary(summary) {
    const row = (label, group) => console.log(
        `${label.padEnd(18)} ${String(group.passed).padStart(3)}/${String(group.cases).padEnd(3)} pass ${percent(group.passRate)}  first-attempt ${percent(group.firstAttemptPassRate)}  attempts ${group.meanAttempts.toFixed(2)}  median ${group.medianSeconds.toFixed(1).padStart(5)} s` +
        (Object.keys(group.failuresByStage).length ? `  fails: ${Object.entries(group.failuresByStage).map(([stage, count]) => `${stage} ${count}`).join(', ')}` : ''));
    for (const [key, title] of groupings) {
        console.log(`${title}:`);
        for (const [value, group] of Object.entries(summary[key])) row(`  ${value}`, group);
        console.log('');
    }
    row('overall', summary.overall);
    const { conduct } = summary;
    if (conduct) {
        console.log(`\nConduct (which way it errs):`);
        console.log(`  acted when it should have asked   ${conduct.wrongProceed}/${conduct.shouldAsk} (${percent(conduct.wrongProceedRate).trim()})   <- the dangerous direction`);
        console.log(`  asked when it should have acted   ${conduct.needlessAsk}/${conduct.shouldAct} (${percent(conduct.needlessAskRate).trim()})`);
        console.log(`  valid but wrong edit              ${conduct.confidentWrong}/${conduct.shouldAct} (${percent(conduct.confidentWrongRate).trim()})   <- the dangerous direction`);
    }
}

async function compare(beforePath, afterPath) {
    const [before, after] = await Promise.all([beforePath, afterPath].map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
    console.log(`before: ${before.provider} ${before.model} (${before.date})\nafter:  ${after.provider} ${after.model} (${after.date})\n`);
    const delta = (a, b) => `${percent(a)} → ${percent(b)} (${b - a >= 0 ? '+' : ''}${((b - a) * 100).toFixed(0)})`;
    for (const [key, title] of groupings) {
        console.log(`${title}:`);
        const values = new Set([...Object.keys(before.summary[key] ?? {}), ...Object.keys(after.summary[key] ?? {})]);
        for (const value of [...values].sort()) {
            const a = before.summary[key]?.[value], b = after.summary[key]?.[value];
            console.log(`  ${value.padEnd(16)} pass ${a && b ? delta(a.passRate, b.passRate) : 'only in one run'}   first-attempt ${a && b ? delta(a.firstAttemptPassRate, b.firstAttemptPassRate) : ''}`);
        }
        console.log('');
    }
    if (before.summary.conduct && after.summary.conduct) {
        console.log('Conduct:');
        for (const [key, label] of [['wrongProceedRate', 'acted when it should have asked'], ['needlessAskRate', 'asked when it should have acted'], ['confidentWrongRate', 'valid but wrong edit']]) {
            console.log(`  ${label.padEnd(34)} ${delta(before.summary.conduct[key], after.summary.conduct[key])}`);
        }
        console.log('');
    }
    const a = before.summary.overall, b = after.summary.overall;
    console.log(`${'overall'.padEnd(18)} pass ${delta(a.passRate, b.passRate)}   first-attempt ${delta(a.firstAttemptPassRate, b.firstAttemptPassRate)}`);
    const passedBefore = new Map();
    for (const result of before.results) passedBefore.set(result.id, (passedBefore.get(result.id) ?? 0) + (result.passed ? 1 : 0));
    const passedAfter = new Map();
    for (const result of after.results) passedAfter.set(result.id, (passedAfter.get(result.id) ?? 0) + (result.passed ? 1 : 0));
    const regressions = [...passedBefore].filter(([id, count]) => (passedAfter.get(id) ?? 0) < count).map(([id]) => id);
    const fixes = [...passedAfter].filter(([id, count]) => (passedBefore.get(id) ?? 0) < count).map(([id]) => id);
    if (regressions.length) console.log(`\nRegressed: ${regressions.join(', ')}`);
    if (fixes.length) console.log(`Newly passing: ${fixes.join(', ')}`);
}

const args = process.argv.slice(2);
const flag = (name, takesValue = true) => {
    const index = args.indexOf(name);
    if (index < 0) return takesValue ? undefined : false;
    return takesValue ? args.splice(index, 2)[1] : (args.splice(index, 1), true);
};

if (args[0] === '--compare') {
    if (args.length !== 3) {
        console.error('Usage: node scripts/evalAssistant.mjs --compare <before.json> <after.json>');
        process.exit(2);
    }
    await compare(args[1], args[2]);
    process.exit(0);
}

const endpoint = flag('--endpoint') ?? '';
const selection = flag('--cases');
const casesFile = flag('--cases-file');
const repeat = Number.parseInt(flag('--repeat') ?? '1', 10);
const outPath = flag('--out');
const skipNative = flag('--no-native', false);
const verbose = flag('--verbose', false);
const timeoutSeconds = Number.parseFloat(flag('--timeout') ?? '240');   // per case, so one runaway generation cannot stall a run
const think = flag('--think');   // true | false: Ollama's `think` for models that can reason; unset leaves the model's default
const [provider, model = ''] = args;
const knownProviders = ['reference', 'localDemonstration', 'ollama', 'openAi', 'nvidia', 'huggingFace', 'gemini'];
if (!knownProviders.includes(provider) || (!['reference', 'localDemonstration'].includes(provider) && !model) || !(repeat >= 1)) {
    console.error(`Usage: node scripts/evalAssistant.mjs <${knownProviders.join('|')}> <model> [--endpoint <url>] [--cases <id|family|domain|style>,...] [--cases-file <path>] [--repeat <n>] [--out <results.json>] [--no-native] [--verbose]\n       node scripts/evalAssistant.mjs --compare <before.json> <after.json>`);
    process.exit(2);
}
const credential = process.env.KONJUGATE_AI_KEY ?? '';
if (!['reference', 'localDemonstration', 'ollama'].includes(provider) && !credential) {
    console.error('Set KONJUGATE_AI_KEY to the provider API key.');
    process.exit(2);
}

const operationSchema = JSON.parse(await readFile(join(root, 'schemas', 'assistantOperations.schema.json'), 'utf8'));
const allCases = await loadEvalCases(casesFile);
// `reference` replays the recorded known-good answers, and so runs only the cases that have one.
const reference = provider === 'reference' ? await loadReferenceProvider(allCases) : null;
const registry = createAIProviderRegistry(reference ? [reference.provider] : createRemoteAIProviders({ operationSchema }));
const wanted = selection?.split(',').map((item) => item.trim()).filter(Boolean);
const cases = (reference ? allCases.filter((item) => reference.caseIds.has(item.id)) : allCases).filter((item) => !wanted || [item.id, item.family, item.domain, item.style].some((value) => wanted.includes(value)));
if (!cases.length) {
    console.error(`No case or family matches “${selection}”.`);
    process.exit(2);
}

const engineOptions = { applicationPath: root, resourcesPath: '', packaged: false };
const nativeValidator = async (document) => {
    const validation = await validateWithEngine(JSON.stringify(document), engineOptions);
    if (!validation.available) return { available: false, errors: [] };
    return { available: true, errors: validation.report.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message) };
};
const nativeAvailable = !skipNative && (await nativeValidator(blankEvalDocument())).available;
if (!skipNative && !nativeAvailable) console.log('The native engine is not built (npm run build:engine); skipping native validation.\n');

const bases = new Map();
async function baseFor(modelId) {
    if (!bases.has(modelId)) {
        const document = await loadEvalBase(modelId);
        const baselineErrors = nativeAvailable ? (await nativeValidator(document)).errors : [];
        bases.set(modelId, { document, baselineErrors });
    }
    return bases.get(modelId);
}

const configuration = { provider, model, endpoint, ...(think === 'true' || think === 'false' ? { think: think === 'true' } : {}) };
console.log(`Provider ${provider}${model ? `, model ${model}` : ''}; ${cases.length} case(s)${repeat > 1 ? ` x ${repeat}` : ''}.\n`);
const results = [];
for (let round = 1; round <= repeat; round += 1) {
    for (const evalCase of cases) {
        const { document, baselineErrors } = await baseFor(evalCase.model);
        const result = await runEvalCase(evalCase, {
            base: document, registry, configuration, credential, baselineErrors,
            validateNative: nativeAvailable ? nativeValidator : null,
            signal: AbortSignal.timeout(timeoutSeconds * 1000)
        });
        results.push({ ...result, round });
        console.log(`${result.passed ? 'pass' : 'FAIL'}  ${evalCase.id.padEnd(26)} ${String(result.attempts)} attempt(s)  ${result.seconds.toFixed(1).padStart(6)} s${result.passed ? '' : `  [${result.stage}]`}`);
        if (!result.passed && (verbose || result.stage !== 'pass')) {
            for (const message of result.messages) console.log(`        ${credential ? message.replaceAll(credential, '[redacted]') : message}`);
        }
    }
}

const summary = summarizeEvalResults(results);
console.log('');
printSummary(summary);
if (outPath) {
    await writeFile(outPath, `${JSON.stringify({ provider, model, endpoint, date: new Date().toISOString(), native: nativeAvailable, repeat, summary, results }, null, 2)}\n`);
    console.log(`\nResults written to ${outPath}.`);
}
