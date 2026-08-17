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
