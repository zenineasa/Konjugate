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

test('Ollama adapter fixes sampling and widens the context', async () => {
    let body;
    const adapter = provider('ollama', async (url, options) => {
        body = JSON.parse(options.body);
        return jsonResponse({ message: { content: '{}' } });
    });
    await adapter.generateProposal(input('ollama'));
    assert.deepEqual(body.options, { temperature: 0, num_ctx: 8192, num_predict: 4096 });
    assert.equal('think' in body, false);
    await adapter.generateProposal(input('ollama', { configuration: { provider: 'ollama', endpoint: '', model: 'test-model', think: false } }));
    assert.equal(body.think, false);
}); 

test('A quoted numeric entity id is read as the id, and a temporary ref is left alone', async () => {
    const quoted = { proposalVersion: 1, operations: [
        { kind: 'updateState', stateRef: '2', initialValue: 12 },
        { kind: 'addState', ref: 'voltage', nodeRef: '15', name: 'Voltage' },
        { kind: 'updateParameter', parameterRef: 'bias', value: 1 },
        { kind: 'removeEntity', entityRef: '0012' }
    ] };
    const adapter = provider('ollama', async () => jsonResponse({ message: { content: JSON.stringify(quoted) } }));
    const { operations } = await adapter.generateProposal(input('ollama'));
    assert.equal(operations[0].stateRef, 2);
    assert.equal(operations[1].nodeRef, 15);
    assert.equal(operations[1].ref, 'voltage');
    assert.equal(operations[2].parameterRef, 'bias');
    assert.equal(operations[3].entityRef, '0012');
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

test('an HTML error page is transport trouble; a reply with no text is the model\'s empty output', async () => {
    const html = provider('openAi', async () => new Response('<html>502 Bad Gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await assert.rejects(() => html.generateProposal(input('openAi')), (error) => error.code === 'invalidProviderResponse');
    const empty = provider('openAi', async () => jsonResponse({ choices: [{ message: { content: null } }] }));
    await assert.rejects(() => empty.generateProposal(input('openAi')), (error) => error.code === 'emptyProviderOutput');
    const silentStream = provider('ollama', async () => streamed(['{"done":true}\n'], 'application/x-ndjson'));
    await assert.rejects(() => silentStream.generateProposal(input('ollama')), (error) => error.code === 'emptyProviderOutput');
});

test('OpenAI falls back to plain JSON mode once when it refuses the schema, and not for other failures', async () => {
    const formats = [];
    const text = JSON.stringify(proposal);
    const adapter = provider('openAi', async (url, options) => {
        const format = JSON.parse(options.body).response_format;
        formats.push(format.type);
        if (format.type === 'json_schema') {
            return jsonResponse({ error: { message: "Invalid schema for response_format 'konjugate_proposal': schema must be a JSON Schema of 'type: \"object\"'." } }, 400);
        }
        return jsonResponse({ choices: [{ message: { content: text } }] });
    });
    assert.deepEqual(await adapter.generateProposal(input('openAi')), proposal);
    assert.deepEqual(formats, ['json_schema', 'json_object']);

    // A 400 about something else (a bad model name) is the user's to fix, not retried in another mode.
    const badModel = [];
    const wrongModel = provider('openAi', async (url, options) => {
        badModel.push(JSON.parse(options.body).response_format.type);
        return jsonResponse({ error: { message: 'The model `nope` does not exist.' } }, 400);
    });
    await assert.rejects(() => wrongModel.generateProposal(input('openAi')), /does not exist/);
    assert.deepEqual(badModel, ['json_schema']);

    // Other providers already use plain JSON mode, so there is nothing to fall back from.
    const nvidiaCalls = [];
    const nvidia = provider('nvidia', async (url, options) => {
        nvidiaCalls.push(JSON.parse(options.body).response_format.type);
        return jsonResponse({ error: { message: 'Invalid schema' } }, 400);
    });
    await assert.rejects(() => nvidia.generateProposal(input('nvidia')), /HTTP 400/);
    assert.deepEqual(nvidiaCalls, ['json_object']);
});

test('a Gemini 401 explains that Google is retiring standard API keys, and other providers\' 401 do not say so', async () => {
    const unauthorized = () => jsonResponse({ error: { message: 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.' } }, 401);
    const gemini = provider('gemini', async () => unauthorized());
    for (const call of [() => gemini.generateProposal(input('gemini')), () => gemini.listModels(input('gemini'))]) {
        await assert.rejects(call, (error) => /HTTP 401/.test(error.message) && /Expected OAuth 2/.test(error.message)
            && /phasing out standard API keys/.test(error.message) && /Google AI Studio/.test(error.message) && error.status === 401);
    }
    const openAi = provider('openAi', async () => unauthorized());
    await assert.rejects(() => openAi.generateProposal(input('openAi')), (error) => /HTTP 401/.test(error.message) && !/AI Studio/.test(error.message));
});

test('OpenRouter lists the models its key may use and names Konjugate on requests', async () => {
    const calls = [];
    const adapter = provider('openRouter', async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith('/models/user')) return jsonResponse({ data: [{ id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5' }] });
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(proposal) } }] });
    });
    assert.deepEqual(await adapter.listModels(input('openRouter')), [{ id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5' }]);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/models/user');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
    assert.deepEqual(await adapter.generateProposal(input('openRouter')), proposal);
    assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[1].options.headers['X-OpenRouter-Title'], 'Konjugate');
    assert.equal(JSON.parse(calls[1].options.body).response_format.type, 'json_object');
});

test('Signing in to OpenRouter exchanges the code with its PKCE verifier for a key', async () => {
    const calls = [];
    const adapter = provider('openRouter', async (url, options = {}) => {
        calls.push({ url, options });
        return jsonResponse({ key: 'sk-or-v1-from-sign-in', user_id: 'user_1' });
    });
    let authorization;
    const result = await adapter.signIn({
        openExternal: async (address) => {
            authorization = new URL(address);
            const back = authorization.searchParams.get('callback_url');
            setImmediate(() => fetch(`${back.replace('localhost', '127.0.0.1')}?code=code-1&state=${authorization.searchParams.get('state')}`).catch(() => {}));
        }
    });
    assert.deepEqual(result, { credential: 'sk-or-v1-from-sign-in' });
    assert.equal(authorization.origin + authorization.pathname, 'https://openrouter.ai/auth');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorization.searchParams.get('callback_url'), /^http:\/\/localhost:\d+\/callback$/);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/auth/keys');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.code, 'code-1');
    assert.equal(body.code_challenge_method, 'S256');
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
});

test('A refused OpenRouter code exchange is reported, not turned into a key', async () => {
    const adapter = provider('openRouter', async () => jsonResponse({ error: { message: 'Invalid code or code_verifier' } }, 403));
    await assert.rejects(adapter.signIn({
        openExternal: async (address) => {
            const authorization = new URL(address);
            setImmediate(() => fetch(`${authorization.searchParams.get('callback_url').replace('localhost', '127.0.0.1')}?code=bad`).catch(() => {}));
        }
    }), /HTTP 403: Invalid code or code_verifier/);
});

test('A sign-in starts with the newest model of the first family the account offers', async () => {
    const { suggestedModel } = await import('../src/aiRemoteProviders.mjs');
    const models = ['openai/gpt-6.1', 'anthropic/claude-opus-5', 'anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5:thinking', 'meta/llama-5']
        .map((id) => ({ id, name: id }));
    assert.equal(suggestedModel(models), 'anthropic/claude-sonnet-5');
    assert.equal(suggestedModel(models.filter((model) => !model.id.startsWith('anthropic/claude-sonnet'))), 'openai/gpt-6.1');
    assert.equal(suggestedModel([{ id: 'meta/llama-5' }]), 'meta/llama-5');
    assert.equal(suggestedModel([]), '');
});

// A Messages API stream as Anthropic sends it: server-sent events, each named by its type.
const anthropicStream = (text, { thinking = '', stopReason = 'end_turn' } = {}) => {
    const events = [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'ping' },
        ...(thinking ? [
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
            { type: 'content_block_stop', index: 0 }
        ] : []),
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        ...[text.slice(0, 10), text.slice(10)].map((part) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: part } })),
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } },
        { type: 'message_stop' }
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
};

test('Anthropic lists models through its own API with the key, and streams a proposal with the schema as its output format', async () => {
    const calls = [];
    const events = [];
    const adapter = provider('anthropic', async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).includes('/v1/models')) return jsonResponse({ data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-10-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' });
        return anthropicStream(JSON.stringify(proposal), { thinking: 'Considering the node.' });
    });
    assert.deepEqual(await adapter.listModels(input('anthropic')), [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }]);
    assert.match(calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/models/);
    const headers = new Headers(calls[0].options.headers);
    // The SDK sends a Console key as a bearer token; the key passed in is the only credential it uses.
    assert.equal(headers.get('authorization'), 'Bearer secret');
    assert.ok(headers.get('anthropic-version'));
    assert.deepEqual(await adapter.generateProposal(input('anthropic', { onEvent: (event) => events.push(event) })), proposal);
    assert.equal(calls[1].url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(calls[1].options.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, true);
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal('thinking' in body, false);
    assert.match(body.messages.at(-1).content, /OPERATION SCHEMA/);
    assert.deepEqual(events.filter((event) => event.type === 'thinking').map((event) => event.text), ['Considering the node.']);
    assert.equal(events.filter((event) => event.type === 'output').map((event) => event.text).join(''), JSON.stringify(proposal));
});

test('Claude\'s output schema is the operation schema without what structured outputs do not take', async () => {
    const { claudeOutputSchema } = await import('../src/aiRemoteProviders.mjs');
    const reduced = claudeOutputSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'T', oneOf: [{ $ref: '#/$defs/a' }],
        $defs: { a: { type: 'object', additionalProperties: false, properties: { pattern: { type: 'string', pattern: '^x', minLength: 1 }, n: { type: 'number', minimum: 0 } } } }
    });
    assert.deepEqual(reduced, {
        anyOf: [{ $ref: '#/$defs/a' }],
        $defs: { a: { type: 'object', additionalProperties: false, properties: { pattern: { type: 'string' }, n: { type: 'number' } } } }
    });
});

test('Anthropic asks again without the output format when the API refuses the schema, and reports a refusal plainly', async () => {
    const bodies = [];
    const adapter = provider('anthropic', async (url, options = {}) => {
        bodies.push(JSON.parse(options.body));
        if (bodies.length === 1) return jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format: schema is too complex' } }, 400);
        return anthropicStream(JSON.stringify(proposal));
    });
    assert.deepEqual(await adapter.generateProposal(input('anthropic')), proposal);
    assert.equal('output_config' in bodies[1], false);

    const declining = provider('anthropic', async () => anthropicStream('', { stopReason: 'refusal' }));
    await assert.rejects(declining.generateProposal(input('anthropic')), { code: 'providerRefused' });
    const unauthorized = provider('anthropic', async () => jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401));
    await assert.rejects(unauthorized.listModels(input('anthropic')), (error) => error.code === 'providerHttpError' && error.status === 401 && /invalid x-api-key/.test(error.message));
    await assert.rejects(provider('anthropic', async () => jsonResponse({})).generateProposal(input('anthropic', { credential: '' })), { code: 'credentialRequired' });
});

test('Cancelling an Anthropic request ends it as a cancel, not an error', async () => {
    const controller = new AbortController();
    const adapter = provider('anthropic', (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const pending = adapter.generateProposal(input('anthropic', { signal: controller.signal }));
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
});

// ChatGPT plan usage. A fake of OpenAI's sign-in: the "browser" follows the authorization address back to Konjugate with a
// code (and, on a first registration, the client OpenAI issued); the token endpoint answers with an ID token for that sign-in.
const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
function fakeChatGpt({ scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', issued = 'oaiapp_123', claims = {}, onRequest = () => null } = {}) {
    const seen = { authorizations: [], tokenRequests: [], requests: [] };
    let nonce = null;
    const fetchImpl = async (url, options = {}) => {
        const address = String(url);
        seen.requests.push({ url: address, options });
        const answered = await onRequest(address, options);
        if (answered) return answered;
        if (address.endsWith('/api/accounts/oauth/token')) {
            const fields = Object.fromEntries(new URLSearchParams(options.body));
            seen.tokenRequests.push(fields);
            return jsonResponse({
                access_token: `access-${seen.tokenRequests.length}`, refresh_token: `refresh-${seen.tokenRequests.length}`, expires_in: 3600, token_type: 'Bearer', scope,
                id_token: jwt({ iss: 'https://auth.openai.com', aud: fields.client_id, nonce, sub: 'user-1', email: 'person@example.com', ...claims })
            });
        }
        throw new Error(`unexpected request ${address}`);
    };
    const openExternal = async (address) => {
        const authorization = new URL(address);
        seen.authorizations.push(authorization);
        nonce = authorization.searchParams.get('nonce');
        const back = new URL(authorization.searchParams.get('redirect_uri'));
        back.searchParams.set('code', 'code-1');
        back.searchParams.set('state', authorization.searchParams.get('state'));
        back.searchParams.set('scope', scope.replaceAll(' ', '+'));
        if (authorization.searchParams.get('client_id') === 'dynamic_agent_client') back.searchParams.set('client_id', issued);
        setImmediate(() => fetch(back).catch(() => {}));
    };
    return { fetchImpl, openExternal, seen };
}
const chatGptCredential = (overrides = {}) => JSON.stringify({ kind: 'chatGptSignIn', clientId: 'oaiapp_123', hostId: 'urn:uuid:host', sub: 'user-1', email: 'person@example.com', idToken: 'id-1', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000, scope: '', ...overrides });
const responsesStream = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });

test('Signing in with ChatGPT registers Konjugate for this installation and keeps the issued client, account and tokens', async () => {
    const fake = fakeChatGpt();
    const result = await provider('chatGpt', fake.fetchImpl).signIn({ openExternal: fake.openExternal, hostId: 'urn:uuid:host' });
    const authorization = fake.seen.authorizations[0];
    assert.equal(authorization.origin + authorization.pathname, 'https://auth.openai.com/api/accounts/authorize');
    const parameters = Object.fromEntries(authorization.searchParams);
    assert.equal(parameters.client_id, 'dynamic_agent_client');
    assert.equal(parameters.ext_agent_host_id, 'urn:uuid:host');
    assert.equal(parameters.agent_name_hint, 'Konjugate');
    assert.match(parameters.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    assert.equal(parameters.scope, 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    assert.equal(parameters.resource, 'https://api.openai.com/v1');
    assert.equal(parameters.code_challenge_method, 'S256');
    assert.ok(parameters.nonce && parameters.state);
    const exchange = fake.seen.tokenRequests[0];
    assert.deepEqual({ grant_type: exchange.grant_type, client_id: exchange.client_id, code: exchange.code, redirect_uri: exchange.redirect_uri, resource: exchange.resource },
        { grant_type: 'authorization_code', client_id: 'oaiapp_123', code: 'code-1', redirect_uri: parameters.redirect_uri, resource: 'https://api.openai.com/v1' });
    assert.equal(fake.seen.requests[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const record = JSON.parse(result.credential);
    assert.equal(result.account, 'person@example.com');
    assert.deepEqual({ clientId: record.clientId, accessToken: record.accessToken, refreshToken: record.refreshToken, sub: record.sub, hostId: record.hostId },
        { clientId: 'oaiapp_123', accessToken: 'access-1', refreshToken: 'refresh-1', sub: 'user-1', hostId: 'urn:uuid:host' });
    assert.ok(record.expiresAt > Date.now() + 3_500_000);
});

test('Signing in with ChatGPT again uses the issued client and the earlier account, without registering again', async () => {
    const fake = fakeChatGpt();
    await provider('chatGpt', fake.fetchImpl).signIn({ openExternal: fake.openExternal, hostId: 'urn:uuid:host', previous: chatGptCredential({ clientId: 'oaiapp_987' }) });
    const parameters = Object.fromEntries(fake.seen.authorizations[0].searchParams);
    assert.equal(parameters.client_id, 'oaiapp_987');
    assert.equal(parameters.id_token_hint, 'id-1');
    assert.equal('agent_name_hint' in parameters, false);
    assert.equal(fake.seen.tokenRequests[0].client_id, 'oaiapp_987');
});

test('A ChatGPT sign-in without plan usage, or whose ID token is not for this sign-in, is refused', async () => {
    const withoutPlan = fakeChatGpt({ scope: 'openid profile email offline_access' });
    await assert.rejects(provider('chatGpt', withoutPlan.fetchImpl).signIn({ openExternal: withoutPlan.openExternal, hostId: 'urn:uuid:host' }), { code: 'planUsageNotAllowed' });
    const otherNonce = fakeChatGpt({ claims: { nonce: 'someone-else' } });
    await assert.rejects(provider('chatGpt', otherNonce.fetchImpl).signIn({ openExternal: otherNonce.openExternal, hostId: 'urn:uuid:host' }), { code: 'signInFailed' });
    const otherIssuer = fakeChatGpt({ claims: { iss: 'https://example.com' } });
    await assert.rejects(provider('chatGpt', otherIssuer.fetchImpl).signIn({ openExternal: otherIssuer.openExternal, hostId: 'urn:uuid:host' }), { code: 'signInFailed' });
});

test('ChatGPT lists the plan\'s models in its own order, refreshing an expired access token and saving the replacement', async () => {
    const saved = [];
    const requests = [];
    const adapter = provider('chatGpt', async (url, options = {}) => {
        requests.push({ url: String(url), options });
        if (String(url).endsWith('/oauth/token')) return jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' });
        return jsonResponse({ models: [{ slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', visibility: 'list' }, { slug: 'internal', visibility: 'hide' }, { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }] });
    });
    const models = await adapter.listModels(input('chatGpt', { credential: chatGptCredential({ expiresAt: Date.now() - 1 }), onCredential: (value) => saved.push(JSON.parse(value)) }));
    assert.deepEqual(models, [{ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }, { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }]);
    const refresh = Object.fromEntries(new URLSearchParams(requests[0].options.body));
    assert.deepEqual(refresh, { grant_type: 'refresh_token', client_id: 'oaiapp_123', refresh_token: 'refresh-1', resource: 'https://api.openai.com/v1' });
    assert.equal(saved[0].refreshToken, 'refresh-2');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer access-2');
    assert.equal(requests[1].url, 'https://api.openai.com/v1/models');

    const ended = provider('chatGpt', async () => jsonResponse({ error: 'refresh_token_reused' }, 400));
    await assert.rejects(ended.listModels(input('chatGpt', { credential: chatGptCredential({ expiresAt: 0 }) })), { code: 'signInExpired' });
    await assert.rejects(ended.listModels(input('chatGpt', { credential: 'sk-not-a-sign-in' })), { code: 'credentialRequired' });
});

test('ChatGPT proposals use the Responses API as plan usage requires, and only a completed reply counts', async () => {
    let body;
    const events = [];
    const adapter = provider('chatGpt', async (url, options = {}) => {
        body = JSON.parse(options.body);
        return responsesStream([
            { type: 'response.created' },
            { type: 'response.reasoning_summary_text.delta', delta: 'Thinking it over.' },
            { type: 'response.output_text.delta', delta: JSON.stringify(proposal).slice(0, 12) },
            { type: 'response.output_text.delta', delta: JSON.stringify(proposal).slice(12) },
            { type: 'response.completed', response: { status: 'completed' } }
        ]);
    });
    assert.deepEqual(await adapter.generateProposal(input('chatGpt', { credential: chatGptCredential(), onEvent: (event) => events.push(event) })), proposal);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.match(body.instructions, /Konjugate modelling assistant/);
    assert.equal(body.input.at(-1).role, 'user');
    assert.equal(body.text.format.type, 'json_schema');
    for (const omitted of ['temperature', 'max_output_tokens', 'metadata', 'previous_response_id', 'user']) assert.equal(omitted in body, false);
    assert.deepEqual(events.filter((event) => event.type === 'thinking').map((event) => event.text), ['Thinking it over.']);

    const cut = provider('chatGpt', async () => responsesStream([{ type: 'response.output_text.delta', delta: '{"proposalVersion"' }]));
    await assert.rejects(cut.generateProposal(input('chatGpt', { credential: chatGptCredential() })), /ended before it finished/);
});

test('ChatGPT plan limits and refusals of the reply format are explained, not reported raw', async () => {
    const limited = provider('chatGpt', async () => responsesStream([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }]));
    await assert.rejects(limited.generateProposal(input('chatGpt', { credential: chatGptCredential() })), (error) => error.code === 'planLimitReached' && /chatgpt\.com\/settings\/usage/.test(error.message));
    const notEligible = provider('chatGpt', async () => jsonResponse({ error: { code: 'subscription_sharing_user_not_eligible', message: 'no' } }, 403));
    await assert.rejects(notEligible.generateProposal(input('chatGpt', { credential: chatGptCredential() })), { code: 'planNotEligible' });
    const detailOnly = provider('chatGpt', async () => jsonResponse({ detail: 'Unauthorized' }, 401));
    await assert.rejects(detailOnly.generateProposal(input('chatGpt', { credential: chatGptCredential() })), { code: 'signInExpired' });

    const bodies = [];
    const plain = provider('chatGpt', async (url, options) => {
        bodies.push(JSON.parse(options.body));
        if (bodies.length === 1) return jsonResponse({ error: { code: 'subscription_sharing_unsupported_capability', param: 'text.format', message: 'text.format is not supported' } }, 400);
        return responsesStream([{ type: 'response.output_text.delta', delta: JSON.stringify(proposal) }, { type: 'response.completed' }]);
    });
    assert.deepEqual(await plain.generateProposal(input('chatGpt', { credential: chatGptCredential() })), proposal);
    assert.equal('text' in bodies[1], false);
});

test('Signing out of ChatGPT revokes the refresh token at the address OpenAI publishes', async () => {
    const requests = [];
    const adapter = provider('chatGpt', async (url, options = {}) => {
        requests.push({ url: String(url), options });
        if (String(url).endsWith('/.well-known/openid-configuration')) return jsonResponse({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
        return new Response('', { status: 200 });
    });
    assert.equal(await adapter.signOut({ credential: chatGptCredential() }), true);
    assert.equal(requests[1].url, 'https://auth.openai.com/oauth/revoke');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[1].options.body)), { token: 'refresh-1', token_type_hint: 'refresh_token', client_id: 'oaiapp_123' });
    const elsewhere = provider('chatGpt', async () => jsonResponse({ revocation_endpoint: 'https://example.com/revoke' }));
    assert.equal(await elsewhere.signOut({ credential: chatGptCredential() }), false, 'A revocation address off OpenAI\'s own site was used.');
});

test('Hugging Face offers no sign-in until Konjugate\'s OAuth app is filled in, then signs in with PKCE and the inference scope', async () => {
    assert.equal(provider('huggingFace', async () => jsonResponse({})).signIn, undefined, 'Signing in was offered without a client id.');
    const previous = process.env.KONJUGATE_HUGGING_FACE_CLIENT_ID;
    process.env.KONJUGATE_HUGGING_FACE_CLIENT_ID = 'hf-client-1';
    try {
        const exchanges = [];
        const adapter = provider('huggingFace', async (url, options = {}) => {
            exchanges.push({ url: String(url), fields: Object.fromEntries(new URLSearchParams(options.body)) });
            return jsonResponse({ access_token: 'hf_oauth_token', token_type: 'bearer', expires_in: 28800, scope: 'openid profile inference-api', id_token: `e30.${Buffer.from(JSON.stringify({ preferred_username: 'someone' })).toString('base64url')}.sig` });
        });
        let authorization;
        const result = await adapter.signIn({
            openExternal: async (address) => {
                authorization = new URL(address);
                const back = new URL(authorization.searchParams.get('redirect_uri'));
                back.searchParams.set('code', 'code-1');
                back.searchParams.set('state', authorization.searchParams.get('state'));
                setImmediate(() => fetch(back).catch(() => {}));
            }
        });
        assert.deepEqual(result, { credential: 'hf_oauth_token', account: 'someone' });
        assert.equal(authorization.origin + authorization.pathname, 'https://huggingface.co/oauth/authorize');
        assert.equal(authorization.searchParams.get('client_id'), 'hf-client-1');
        assert.equal(authorization.searchParams.get('scope'), 'openid profile inference-api');
        assert.match(authorization.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(exchanges[0].url, 'https://huggingface.co/oauth/token');
        assert.deepEqual({ grant_type: exchanges[0].fields.grant_type, client_id: exchanges[0].fields.client_id, code: exchanges[0].fields.code }, { grant_type: 'authorization_code', client_id: 'hf-client-1', code: 'code-1' });
        assert.ok(exchanges[0].fields.code_verifier);
    } finally {
        if (previous === undefined) delete process.env.KONJUGATE_HUGGING_FACE_CLIENT_ID; else process.env.KONJUGATE_HUGGING_FACE_CLIENT_ID = previous;
    }
});

test('A client ChatGPT issued is kept before the exchange, reused on the next attempt, and a refused exchange says why', async () => {
    const issued = [];
    const failing = fakeChatGpt({ onRequest: (address) => (address.endsWith('/oauth/token')
        ? jsonResponse({ error: 'invalid_grant', error_description: 'The authorization code has expired.' }, 400) : null) });
    await assert.rejects(provider('chatGpt', failing.fetchImpl).signIn({ openExternal: failing.openExternal, hostId: 'urn:uuid:host', onClientIssued: (id) => issued.push(id) }),
        (error) => error.code === 'signInFailed' && /invalid_grant\): The authorization code has expired\. Try signing in again\./.test(error.message));
    assert.deepEqual(issued, ['oaiapp_123'], 'The issued client was lost with the failed exchange.');
    assert.equal(failing.seen.requests[0].options.headers.Accept, 'application/json');
    const redirect = new URL(failing.seen.authorizations[0].searchParams.get('redirect_uri'));
    assert.equal(redirect.pathname, '/auth/callback');

    const again = fakeChatGpt();
    const retried = [];
    await provider('chatGpt', again.fetchImpl).signIn({ openExternal: again.openExternal, hostId: 'urn:uuid:host', registeredClientId: 'oaiapp_123', onClientIssued: (id) => retried.push(id) });
    const parameters = Object.fromEntries(again.seen.authorizations[0].searchParams);
    assert.equal(parameters.client_id, 'oaiapp_123', 'A second attempt registered Konjugate again.');
    assert.equal('agent_name_hint' in parameters, false);
    assert.equal(again.seen.tokenRequests[0].client_id, 'oaiapp_123');
    assert.deepEqual(retried, []);
});
