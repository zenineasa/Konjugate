/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A fake Ollama server for tests: it speaks the parts of Ollama's HTTP API that Konjugate uses, so the app's own
// Ollama provider, its streaming, parsing, repair and validation are all run, with answers that never change.
// `/api/chat` reads the model context and the request out of the prompt the app sends and answers by the rules in
// tests/fixtures/demonstrationAssistant.mjs, streamed as Ollama streams. `/api/pull` reports progress and adds the model
// to those `/api/tags` lists. Every request is kept in `requests`, so a test can see what the app sent.
// `startFakeOllama({ models, pullSteps, pullDelayMilliseconds })` → { endpoint, requests, models, close() }.

import { createServer } from 'node:http';
import { demonstrationAnswer } from './demonstrationAssistant.mjs';

const json = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
};

const readBody = (request) => new Promise((resolve, reject) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => {
        try { resolve(text ? JSON.parse(text) : {}); } catch (error) { reject(error); }
    });
    request.on('error', reject);
});

// What the app put in its prompt (src/aiRemoteProviders.mjs): the turns so far, the model context and the request.
export function readPrompt(content) {
    const contextStart = content.indexOf('MODEL CONTEXT:\n');
    const requestStart = content.indexOf('\n\nUSER REQUEST:\n');
    if (contextStart < 0 || requestStart < 0) throw new Error('The prompt has no model context or request.');
    const context = JSON.parse(content.slice(contextStart + 'MODEL CONTEXT:\n'.length, requestStart));
    const request = content.slice(requestStart + '\n\nUSER REQUEST:\n'.length).split('\n\nCORRECTION REQUIRED:')[0];
    const history = [];
    const conversation = /^CONVERSATION SO FAR:\n([\s\S]*?)\n\n/.exec(content);
    for (const match of (conversation?.[1] ?? '').matchAll(/^User: (.*)\nAssistant: (.*)$/gm)) history.push({ request: match[1], outcome: match[2] });
    return { context, request, history };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function startFakeOllama({ models = ['qwen3.5:4b'], pullSteps = 4, pullDelayMilliseconds = 20, version = '0.12.0' } = {}) {
    const installed = new Set(models);
    const requests = [];
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        let body = {};
        try { body = request.method === 'POST' || request.method === 'DELETE' ? await readBody(request) : {}; } catch { return json(response, 400, { error: 'invalid JSON' }); }
        requests.push({ method: request.method, path: url.pathname, body });
        if (url.pathname === '/api/version') return json(response, 200, { version });
        if (url.pathname === '/api/tags') {
            return json(response, 200, { models: [...installed].map((name) => ({ name, model: name, size: 3_400_000_000 })) });
        }
        if (url.pathname === '/api/pull' && request.method === 'POST') {
            const name = String(body.model ?? body.name ?? '');
            if (!name) return json(response, 400, { error: 'model is required' });
            if (name.includes('missing')) return json(response, 500, { error: 'pull model manifest: file does not exist' });
            response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            const total = 1000;
            response.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
            let closed = false;
            request.on('close', () => { closed = true; });
            response.on('close', () => { closed = true; });
            for (let step = 1; step <= pullSteps && !closed; step += 1) {
                await sleep(pullDelayMilliseconds);
                response.write(`${JSON.stringify({ status: 'pulling layer', digest: 'sha256:fake', total, completed: Math.round((total * step) / pullSteps) })}\n`);
            }
            if (closed) return undefined;
            installed.add(name);
            response.end(`${JSON.stringify({ status: 'success' })}\n`);
            return undefined;
        }
        if (url.pathname === '/api/chat' && request.method === 'POST') {
            let answer;
            try {
                answer = demonstrationAnswer(readPrompt(body.messages?.at(-1)?.content ?? ''));
            } catch (error) {
                return json(response, 500, { error: error.message });
            }
            response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            if (body.think === true) response.write(`${JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'Reading the request.' }, done: false })}\n`);
            const text = JSON.stringify(answer);
            const half = Math.ceil(text.length / 2);
            for (const piece of [text.slice(0, half), text.slice(half)]) {
                response.write(`${JSON.stringify({ message: { role: 'assistant', content: piece }, done: false })}\n`);
            }
            response.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true })}\n`);
            return undefined;
        }
        return json(response, 404, { error: 'not found' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        endpoint: `http://127.0.0.1:${server.address().port}`,
        requests,
        models: installed,
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })
    };
}
