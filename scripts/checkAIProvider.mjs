/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Tries one model provider against the real service, through the same registry and adapter code the app
// uses, and says what it saw: whether the request was accepted, whether the reply streamed, whether the
// provider sent reasoning, and whether the proposal passed validation. The unit tests use mocked
// responses; this is the check that a provider's actual behaviour still matches them.
//
//   KONJUGATE_AI_KEY=... node scripts/checkAIProvider.mjs <provider> <model> [--endpoint <url>] [request...]
//
// <provider> is one of: ollama, openAi, nvidia, huggingFace, gemini. Ollama needs no key. The key is read
// from the environment, never from an argument (which a shell would keep in its history), and is never
// printed.

import { readFile } from 'node:fs/promises';
import { createAIProviderRegistry } from '../src/aiProviderRegistry.mjs';
import { createRemoteAIProviders } from '../src/aiRemoteProviders.mjs';

const knownProviders = ['ollama', 'openAi', 'nvidia', 'huggingFace', 'gemini'];
const [provider, model, ...rest] = process.argv.slice(2);
if (!knownProviders.includes(provider) || !model) {
    console.error(`Usage: KONJUGATE_AI_KEY=... node scripts/checkAIProvider.mjs <${knownProviders.join('|')}> <model> [--endpoint <url>] [request...]`);
    process.exit(2);
}
const endpointFlag = rest.indexOf('--endpoint');
const endpoint = endpointFlag >= 0 ? rest.splice(endpointFlag, 2)[1] ?? '' : '';
const request = rest.join(' ') || 'Add a node named Battery with a temperature state of 300 K.';
const credential = process.env.KONJUGATE_AI_KEY ?? '';
if (provider !== 'ollama' && !credential) {
    console.error('Set KONJUGATE_AI_KEY to the provider API key.');
    process.exit(2);
}

const operationSchema = JSON.parse(await readFile(new URL('../schemas/assistantOperations.schema.json', import.meta.url), 'utf8'));
const registry = createAIProviderRegistry(createRemoteAIProviders({ operationSchema }));
const context = { format: 'konjugate', version: 1, units: 'SI', nodes: [], edges: [] };

const started = performance.now();
const seconds = () => ((performance.now() - started) / 1000).toFixed(1);
let last = { attempt: 0, phase: '' };
let firstOutputAt = null;
let firstThinkingAt = null;
let final = null;
const onProgress = (progress) => {
    if (progress.thinking && firstThinkingAt === null) firstThinkingAt = seconds();
    if (progress.outputCharacters > 0 && firstOutputAt === null) firstOutputAt = seconds();
    if (progress.attempt !== last.attempt || progress.phase !== last.phase) {
        console.log(`[${seconds()} s] attempt ${progress.attempt} of ${progress.attempts}: ${progress.phase}${progress.repairReason ? ` (after: ${progress.repairReason})` : ''}`);
    }
    last = progress;
    final = progress;
};

console.log(`Provider ${provider}, model ${model}${endpoint ? `, endpoint ${endpoint}` : ''}`);
console.log(`Request: ${request}\n`);
try {
    const response = await registry.generate({
        configuration: { provider, model, endpoint },
        credential,
        context,
        request,
        history: [],
        onProgress
    });
    console.log(`\nAccepted after ${seconds()} s, in ${final?.attempt ?? 1} attempt(s).`);
    console.log(`First reasoning text: ${firstThinkingAt === null ? 'none (the provider sent no reasoning)' : `${firstThinkingAt} s`}`);
    console.log(`First proposal text:  ${firstOutputAt === null ? 'none seen as a stream (the reply came whole, at the end)' : `${firstOutputAt} s`}`);
    console.log(`Response kind: ${response.responseKind ?? 'proposal'}; ${response.operations?.length ?? 0} operation(s).`);
    console.log(response.summary ? `Summary: ${response.summary}` : response.question ? `Question: ${response.question}` : '');
} catch (error) {
    const message = credential ? String(error.message).replaceAll(credential, '[redacted]') : String(error.message);
    console.error(`\nFailed after ${seconds()} s${error.code ? ` (${error.code})` : ''}: ${message}`);
    process.exit(1);
}
