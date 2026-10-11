/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteAIProviders } from '../src/aiRemoteProviders.mjs';

const schema = { type: 'object', required: ['proposalVersion', 'operations'], properties: {
    proposalVersion: { const: 1 }, operations: { type: 'array' }
} };
const proposal = { proposalVersion: 1, operations: [{ kind: 'addNode', ref: 'newNode', name: 'New node' }] };
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const provider = (id, fetchImpl) => createRemoteAIProviders({ operationSchema: schema, fetchImpl }).find((item) => item.id === id);
const input = (id, overrides = {}) => ({
    configuration: { provider: id, endpoint: '', model: 'test-model' }, credential: 'secret',
    context: { nodes: [], edges: [] }, request: 'Add a node', ...overrides
});

test('Ollama adapter discovers models and requests portable JSON output', async () => {
    const calls = [];
    const adapter = provider('ollama', async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'small-model' }] });
        return jsonResponse({ message: { content: JSON.stringify(proposal) } });
    });
    assert.deepEqual(await adapter.listModels(input('ollama')), [{ id: 'small-model', name: 'small-model' }]);
    assert.deepEqual(await adapter.generateProposal(input('ollama')), proposal);
    const body = JSON.parse(calls[1].options.body);
    assert.equal(body.format, 'json');
    assert.match(body.messages[0].content, /OPERATION SCHEMA/);
    assert.equal(calls[1].url, 'http://127.0.0.1:11434/api/chat');
});

test('OpenAI-compatible adapters use bearer authentication and provider endpoints', async () => {
    for (const [id, expectedHost] of [['openAi', 'api.openai.com'], ['nvidia', 'integrate.api.nvidia.com'], ['huggingFace', 'router.huggingface.co']]) {
        let call;
        const adapter = provider(id, async (url, options) => {
            call = { url, options };
            return jsonResponse({ choices: [{ message: { content: JSON.stringify(proposal) } }] });
        });
        assert.deepEqual(await adapter.generateProposal(input(id)), proposal);
        assert.equal(new URL(call.url).host, expectedHost);
        assert.equal(call.options.headers.Authorization, 'Bearer secret');
        assert.equal(call.url.endsWith('/v1/chat/completions'), true);
        const responseFormat = JSON.parse(call.options.body).response_format;
        assert.equal(responseFormat.type, id === 'openAi' ? 'json_schema' : 'json_object');
        if (id === 'openAi') assert.equal(responseFormat.json_schema.strict, false);
    }
});

test('Gemini adapter uses API-key authentication and JSON generation config', async () => {
    let call;
    const adapter = provider('gemini', async (url, options) => {
        call = { url, options };
        return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(proposal) }] } }] });
    });
    assert.deepEqual(await adapter.generateProposal(input('gemini')), proposal);
    assert.equal(call.options.headers['x-goog-api-key'], 'secret');
    assert.deepEqual(JSON.parse(call.options.body).generationConfig, { responseMimeType: 'application/json' });
});

test('OpenAI-compatible adapters expand conversation history into real prior messages', async () => {
    let call;
    const adapter = provider('openAi', async (url, options) => {
        call = { url, options };
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(proposal) } }] });
    });
    const history = [{ request: 'Earlier request', outcome: 'Applied something.' }];
    await adapter.generateProposal(input('openAi', { history }));
    const messages = JSON.parse(call.options.body).messages;
    assert.deepEqual(messages[1], { role: 'user', content: 'Earlier request' });
    assert.deepEqual(messages[2], { role: 'assistant', content: 'Applied something.' });
    assert.match(messages[3].content, /USER REQUEST/);
});

test('Ollama and Gemini adapters prepend conversation history as text', async () => {
    const history = [{ request: 'Earlier request', outcome: 'Applied something.' }];
    let ollamaBody;
    const ollamaAdapter = provider('ollama', async (url, options) => {
        if (url.endsWith('/api/chat')) ollamaBody = JSON.parse(options.body);
        return jsonResponse({ models: [] , message: { content: JSON.stringify(proposal) } });
    });
    await ollamaAdapter.generateProposal(input('ollama', { history }));
    assert.match(ollamaBody.messages[0].content, /CONVERSATION SO FAR:\nUser: Earlier request\nAssistant: Applied something\./);

    let geminiBody;
    const geminiAdapter = provider('gemini', async (url, options) => {
        geminiBody = JSON.parse(options.body);
        return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(proposal) }] } }] });
    });
    await geminiAdapter.generateProposal(input('gemini', { history }));
    assert.match(geminiBody.contents[0].parts[0].text, /CONVERSATION SO FAR:\nUser: Earlier request\nAssistant: Applied something\./);
});

test('remote adapters reject insecure non-local endpoints and missing credentials', async () => {
    const adapter = provider('openAi', async () => jsonResponse({}));
    await assert.rejects(() => adapter.generateProposal(input('openAi', {
        configuration: { provider: 'openAi', endpoint: 'http://example.com', model: 'test' }
    })), /must use HTTPS/);
    await assert.rejects(() => adapter.generateProposal(input('openAi', { credential: null })), /requires an API key/);
});

const streamed = (chunks, contentType) => new Response(new ReadableStream({
    start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
    }
}), { headers: { 'Content-Type': contentType } });
const sse = (...events) => events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const collect = () => {
    const events = [];
    return { events, onEvent: (event) => events.push(event) };
};

test('OpenAI-compatible adapters stream: reasoning and output are reported as they arrive, split mid-event', async () => {
    const text = JSON.stringify(proposal);
    const wire = sse(
        { choices: [{ delta: { reasoning_content: 'Think' } }] },
        { choices: [{ delta: { reasoning: 'ing' } }] },
        { choices: [{ delta: { content: text.slice(0, 20) } }] },
        { choices: [{ delta: { content: null } }] },
        { choices: [{ delta: { content: text.slice(20) } }] },
        '[DONE]'
    );
    let body;
    const adapter = provider('nvidia', async (url, options) => {
        body = JSON.parse(options.body);
        return streamed([`: keep-alive\n\n${wire.slice(0, 37)}`, wire.slice(37, 140), wire.slice(140)], 'text/event-stream');
    });
    const { events, onEvent } = collect();
    assert.deepEqual(await adapter.generateProposal(input('nvidia', { onEvent })), proposal);
    assert.equal(body.stream, true);
    assert.equal(events.filter((event) => event.type === 'thinking').map((event) => event.text).join(''), 'Thinking');
    assert.equal(events.filter((event) => event.type === 'output').map((event) => event.text).join(''), text);
    assert.ok(events.some((event) => event.type === 'activity'));
});

test('Ollama streams newline-delimited JSON, with its thinking field reported separately', async () => {
    const text = JSON.stringify(proposal);
    const lines = [
        { message: { thinking: 'Hmm' } },
        { message: { content: text.slice(0, 10) } },
        { message: { content: text.slice(10) }, done: true }
    ].map((line) => `${JSON.stringify(line)}\n`);
    const adapter = provider('ollama', async () => streamed([lines[0] + lines[1].slice(0, 5), lines[1].slice(5) + lines[2]], 'application/x-ndjson'));
    const { events, onEvent } = collect();
    assert.deepEqual(await adapter.generateProposal(input('ollama', { onEvent })), proposal);
    assert.deepEqual(events.find((event) => event.type === 'thinking'), { type: 'thinking', text: 'Hmm' });
});

test('Gemini streams server-sent events from streamGenerateContent and separates thought parts', async () => {
    const text = JSON.stringify(proposal);
    let url;
    const adapter = provider('gemini', async (requestUrl) => {
        url = requestUrl;
        return streamed([sse(
            { candidates: [{ content: { parts: [{ thought: true, text: 'Planning' }] } }] },
            { candidates: [{ content: { parts: [{ text: text.slice(0, 15) }] } }] },
            { candidates: [{ content: { parts: [{ text: text.slice(15) }] } }] }
        )], 'text/event-stream');
    });
    const { events, onEvent } = collect();
    assert.deepEqual(await adapter.generateProposal(input('gemini', { onEvent })), proposal);
    assert.match(url, /:streamGenerateContent\?alt=sse$/);
    assert.deepEqual(events.find((event) => event.type === 'thinking'), { type: 'thinking', text: 'Planning' });
});

test('a server that answers with a plain JSON body still works and reports its content at the end', async () => {
    const { events, onEvent } = collect();
    const adapter = provider('openAi', async () => jsonResponse({ choices: [{ message: { content: JSON.stringify(proposal), reasoning_content: 'Because' } }] }));
    assert.deepEqual(await adapter.generateProposal(input('openAi', { onEvent })), proposal);
    assert.deepEqual(events.map((event) => event.type), ['thinking', 'output']);
});

test('an error event inside a stream, or a malformed one, becomes a provider error', async () => {
    const failing = provider('openAi', async () => streamed([sse({ error: { message: 'Overloaded' } })], 'text/event-stream'));
    await assert.rejects(() => failing.generateProposal(input('openAi')), /reported an error: Overloaded/);
    const malformed = provider('ollama', async () => streamed(['{not json\n'], 'application/x-ndjson'));
    await assert.rejects(() => malformed.generateProposal(input('ollama')), /malformed stream event/);
});

test('cancelling aborts a stream that is mid-read', async () => {
    const controller = new AbortController();
    const adapter = provider('openAi', async (url, options) => new Response(new ReadableStream({
        start(stream) {
            stream.enqueue(new TextEncoder().encode(sse({ choices: [{ delta: { content: '{' } }] })));
            options.signal.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')));
        }
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const pending = adapter.generateProposal(input('openAi', { signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(() => pending, (error) => error.name === 'AbortError');
});
