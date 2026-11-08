/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { generateAssistantProposal } from '../src/assistantProviders.mjs';
import { createRemoteAIProviders } from '../src/aiRemoteProviders.mjs';
import { demonstrationAnswer } from './fixtures/demonstrationAssistant.mjs';
import { readPrompt, startFakeOllama } from './fixtures/fakeOllama.mjs';

// The rules the test model answers by (tests/fixtures/demonstrationAssistant.mjs), as a provider, so they are checked
// here directly; the end of this file checks the fake Ollama server that serves them to the app's own Ollama provider.
const localAssistantProvider = Object.freeze({
    id: 'demonstration',
    generateProposal: async (request) => {
        if (request.signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
        return demonstrationAnswer(request);
    }
});

const context = {
    format: 'konjugate', version: 1, units: 'SI',
    nodes: [{ id: 'battery-node', name: 'Battery module', type: 'Battery', states: [
        { id: 'battery-temperature', name: 'Temperature', symbol: 'temperature', initialValue: 350, unit: 'K' }
    ] }],
    edges: []
};

const twoNodeContext = {
    format: 'konjugate', version: 1, units: 'SI',
    nodes: [
        { id: 'battery-node', name: 'Battery module', type: 'Battery', states: [
            { id: 'battery-temperature', name: 'Temperature', symbol: 'temperature', initialValue: 350, unit: 'K' }
        ] },
        { id: 'air-node', name: 'Enclosed air', type: 'Thermal mass', states: [
            { id: 'air-temperature', name: 'Temperature', symbol: 'temperature', initialValue: 300, unit: 'K' }
        ] }
    ],
    edges: [{ id: 'heat-edge', name: 'Heat source', sourceId: 'battery-node', targetId: 'air-node' }]
};

test('the test model creates an ambient thermal proposal using explicit values', async () => {
    const proposal = await generateAssistantProposal(localAssistantProvider, {
        context,
        request: 'Add an ambient boundary at 298 K and connect it to the battery with a conductance of 15 W/K.'
    });
    assert.equal(proposal.proposalVersion, 1);
    assert.equal(proposal.assumptions.length, 0);
    assert.equal(proposal.operations[1].initialValue, 298);
    assert.equal(proposal.operations[3].value, 15);
    assert.equal(proposal.operations[4].outputStateRef, 'battery-temperature');
});

test('the test model reports defaults as assumptions', async () => {
    const proposal = await generateAssistantProposal(localAssistantProvider, {
        context, request: 'Connect an ambient thermal boundary to the battery.'
    });
    assert.equal(proposal.assumptions.length, 2);
    assert.equal(proposal.operations[1].initialValue, 293.15);
    assert.equal(proposal.operations[3].value, 10);
});

test('the test model creates a state update proposal for an existing node', async () => {
    const proposal = await generateAssistantProposal(localAssistantProvider, {
        context, request: 'Set the battery initial temperature to 325 K.'
    });
    assert.equal(proposal.responseKind, 'proposal');
    assert.deepEqual(proposal.operations, [
        { kind: 'updateState', stateRef: 'battery-temperature', initialValue: 325, unit: 'K' }
    ]);
    assert.match(proposal.summary, /Battery module/);
});

test('the test model asks a clarifying question when the temperature target is ambiguous', async () => {
    const response = await generateAssistantProposal(localAssistantProvider, {
        context: twoNodeContext, request: 'Set the temperature to 325 K.'
    });
    assert.equal(response.responseKind, 'clarification');
    assert.deepEqual(response.suggestions, ['Battery module', 'Enclosed air']);
});

test('the test model still resolves an explicitly named target among several candidates', async () => {
    const proposal = await generateAssistantProposal(localAssistantProvider, {
        context: twoNodeContext, request: 'Set the enclosed air temperature to 305 K.'
    });
    assert.equal(proposal.responseKind, 'proposal');
    assert.deepEqual(proposal.operations, [
        { kind: 'updateState', stateRef: 'air-temperature', initialValue: 305, unit: 'K' }
    ]);
});

// Regression test: an earlier version concatenated *all* history into every request
// unconditionally, so an unrelated prior turn's own number ("298 K") silently won the value
// match ahead of the current, fully self-sufficient request's own number ("325 K").
test('an unrelated prior turn in history does not change a self-sufficient new request', async () => {
    const proposal = await generateAssistantProposal(localAssistantProvider, {
        context, request: 'Set the battery initial temperature to 325 K.',
        history: [{ request: 'Add an ambient boundary at 298 K and connect it to the battery with a conductance of 15 W/K.', outcome: 'Applied: Add an ambient thermal boundary for Battery module.' }]
    });
    assert.equal(proposal.responseKind, 'proposal');
    assert.deepEqual(proposal.operations, [
        { kind: 'updateState', stateRef: 'battery-temperature', initialValue: 325, unit: 'K' }
    ]);
});

test('the test model asks a clarifying question when the temperature value is missing', async () => {
    const response = await generateAssistantProposal(localAssistantProvider, {
        context, request: 'Set the battery temperature.'
    });
    assert.equal(response.responseKind, 'clarification');
    assert.match(response.question, /Battery module/);
});

test('a clarification reply combined with the original request via history resolves the proposal', async () => {
    const response = await generateAssistantProposal(localAssistantProvider, {
        context: twoNodeContext,
        request: 'Battery module, 320K',
        history: [{ request: 'Set the temperature to 320 K.', outcome: 'Asked: Which node should I update?' }]
    });
    assert.equal(response.responseKind, 'proposal');
    assert.deepEqual(response.operations, [
        { kind: 'updateState', stateRef: 'battery-temperature', initialValue: 320, unit: 'K' }
    ]);
});

test('the test model asks a clarifying question when the disable/enable target is missing', async () => {
    const response = await generateAssistantProposal(localAssistantProvider, {
        context: twoNodeContext, request: 'Disable it.'
    });
    assert.equal(response.responseKind, 'clarification');
    assert.deepEqual(response.suggestions, ['Battery module', 'Enclosed air', 'Heat source']);
});

test('the test model rejects unsupported requests and missing model context', async () => {
    await assert.rejects(() => generateAssistantProposal(localAssistantProvider, {
        context, request: 'Create a gearbox.'
    }), /supports adding an ambient thermal boundary/);
    await assert.rejects(() => generateAssistantProposal(localAssistantProvider, {
        context: { ...context, nodes: [] }, request: 'Add an ambient thermal boundary.'
    }), /needs a node with a temperature state/);
});

test('provider dispatch rejects unavailable providers and cancellation', async () => {
    await assert.rejects(() => generateAssistantProposal(null, { context, request: 'Anything' }), /unavailable/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => generateAssistantProposal(localAssistantProvider, {
        context, request: 'Add an ambient thermal boundary.', signal: controller.signal
    }), { name: 'AbortError' });
});

const operationSchema = { type: 'object' };
const ollamaWith = (endpoint, extra = {}) => ({ provider: 'ollama', endpoint, model: 'qwen3.5:4b', ...extra });

test('the fake Ollama server answers the app\'s own Ollama provider: a proposal, streamed, and the think setting as sent', async () => {
    const fake = await startFakeOllama();
    try {
        const ollama = createRemoteAIProviders({ operationSchema }).find((provider) => provider.id === 'ollama');
        assert.equal(ollama.reasoningSetting, true);
        assert.deepEqual(await ollama.listModels({ configuration: ollamaWith(fake.endpoint) }), [{ id: 'qwen3.5:4b', name: 'qwen3.5:4b' }]);
        const events = [];
        const proposal = await ollama.generateProposal({
            configuration: ollamaWith(fake.endpoint, { think: true }), context, onEvent: (event) => events.push(event.type),
            request: 'Add an ambient boundary at 298 K and connect it to the battery with a conductance of 15 W/K.'
        });
        assert.equal(proposal.responseKind, 'proposal');
        assert.equal(proposal.operations.find((operation) => operation.kind === 'addParameter').value, 15);
        assert.ok(events.includes('thinking') && events.filter((type) => type === 'output').length >= 2, 'It streams, with reasoning when asked to reason.');
        const chat = fake.requests.filter((request) => request.path === '/api/chat');
        assert.equal(chat[0].body.think, true);
        await ollama.generateProposal({ configuration: ollamaWith(fake.endpoint, { think: false }), context, request: 'Disable the battery module.' });
        await ollama.generateProposal({ configuration: ollamaWith(fake.endpoint, { think: null }), context, request: 'Disable the battery module.' });
        const later = fake.requests.filter((request) => request.path === '/api/chat').slice(1);
        assert.equal(later[0].body.think, false);
        assert.equal('think' in later[1].body, false, 'With no setting the model decides, and nothing is sent.');
    } finally {
        await fake.close();
    }
});

test('the fake Ollama server reads the turns so far from the prompt, so a reply to a question resolves', async () => {
    const fake = await startFakeOllama();
    try {
        const ollama = createRemoteAIProviders({ operationSchema }).find((provider) => provider.id === 'ollama');
        const asked = await ollama.generateProposal({ configuration: ollamaWith(fake.endpoint), context: twoNodeContext, request: 'Set the temperature to 310 K.' });
        assert.equal(asked.responseKind, 'clarification');
        const answered = await ollama.generateProposal({
            configuration: ollamaWith(fake.endpoint), context: twoNodeContext, request: 'Enclosed air',
            history: [{ request: 'Set the temperature to 310 K.', outcome: `Asked: ${asked.question}` }]
        });
        assert.equal(answered.operations[0].stateRef, 'air-temperature');
        await assert.rejects(() => ollama.generateProposal({ configuration: ollamaWith(fake.endpoint), context, request: 'Create a gearbox.' }), /HTTP 500/);
    } finally {
        await fake.close();
    }
});

test('reading the prompt finds the context, the request and the turns, and ignores a correction note', () => {
    const prompt = 'CONVERSATION SO FAR:\nUser: first\nAssistant: Asked: which?\n\nCreate a proposal.\n\nMODEL CONTEXT:\n{"nodes":[]}\n\nUSER REQUEST:\nsecond\n\nCORRECTION REQUIRED:\nbad';
    assert.deepEqual(readPrompt(prompt), { context: { nodes: [] }, request: 'second', history: [{ request: 'first', outcome: 'Asked: which?' }] });
});
