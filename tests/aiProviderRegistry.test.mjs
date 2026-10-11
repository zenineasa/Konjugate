/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAIProviderRegistry } from '../src/aiProviderRegistry.mjs';

test('provider registry dispatches generation without exposing provider details to callers', async () => {
    const provider = {
        id: 'testProvider', name: 'Test provider',
        generateProposal: async ({ request, credential }) => ({
            proposalVersion: 1, summary: `${request}:${credential === 'secret'}`,
            operations: [{ kind: 'addNode', ref: 'testNode', name: 'Test node' }]
        })
    };
    const registry = createAIProviderRegistry([provider]);
    const result = await registry.generate({
        configuration: { provider: 'testProvider' }, credential: 'secret', context: { nodes: [] }, request: 'Build it'
    });
    assert.equal(result.summary, 'Build it:true');
    assert.deepEqual(registry.descriptors().find((item) => item.id === 'testProvider'), {
        id: 'testProvider', name: 'Test provider', defaultEndpoint: '', defaultTimeoutSeconds: 60,
        credentialRequired: false, locality: 'local'
    });
});

test('provider registry rejects malformed provider output', async () => {
    let calls = 0;
    const registry = createAIProviderRegistry([{ id: 'broken', name: 'Broken', generateProposal: async () => {
        calls += 1;
        return { text: 'not operations' };
    } }]);
    await assert.rejects(() => registry.generate({
        configuration: { provider: 'broken' }, context: { nodes: [] }, request: 'Build it'
    }), /proposalVersion/);
    assert.equal(calls, 3);
});

test('provider registry returns validation feedback for automatic proposal repair', async () => {
    const requests = [];
    const registry = createAIProviderRegistry([{
        id: 'repairable', name: 'Repairable', generateProposal: async (request) => {
            requests.push(request);
            if (!request.repair) return { proposalVersion: 2, operations: [] };
            return {
                proposalVersion: 1,
                operations: [{ kind: 'addNode', ref: 'repairedNode', name: 'Repaired node' }]
            };
        }
    }]);
    const proposal = await registry.generate({
        configuration: { provider: 'repairable' }, context: { nodes: [] }, request: 'Build it'
    });
    assert.equal(proposal.proposalVersion, 1);
    assert.equal(requests.length, 2);
    assert.match(requests[1].repair.error, /proposalVersion must be 1/);
    assert.equal(requests[1].repair.proposal.proposalVersion, 2);
});

test('provider registry retries malformed provider output before reporting it', async () => {
    const requests = [];
    const registry = createAIProviderRegistry([{
        id: 'malformedOnce', name: 'Malformed once', generateProposal: async (request) => {
            requests.push(request);
            if (!request.repair) throw Object.assign(new Error('Malformed proposal JSON.'), { code: 'invalidProposalJson' });
            return {
                proposalVersion: 1,
                operations: [{ kind: 'addNode', ref: 'recoveredNode', name: 'Recovered node' }]
            };
        }
    }]);
    const proposal = await registry.generate({
        configuration: { provider: 'malformedOnce' }, context: { nodes: [] }, request: 'Build it'
    });
    assert.equal(proposal.operations[0].ref, 'recoveredNode');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].repair.proposal, null);
});

test('provider registry redacts credentials from provider errors', async () => {
    const registry = createAIProviderRegistry([{
        id: 'leaky', name: 'Leaky', generateProposal: async ({ credential }) => { throw new Error(`Rejected ${credential}`); }
    }]);
    await assert.rejects(() => registry.generate({
        configuration: { provider: 'leaky' }, credential: 'top-secret', context: { nodes: [] }, request: 'Build it'
    }), (error) => error.message === 'Rejected [redacted]');
});

test('provider registry rejects unknown providers', async () => {
    const registry = createAIProviderRegistry([]);
    await assert.rejects(() => registry.generate({
        configuration: { provider: 'missing' }, context: { nodes: [] }, request: 'Build it'
    }), /unavailable/);
});

test('provider registry returns a clarification response directly, bypassing repair', async () => {
    let calls = 0;
    const registry = createAIProviderRegistry([{
        id: 'asksQuestions', name: 'Asks questions', generateProposal: async () => {
            calls += 1;
            return { responseKind: 'clarification', question: 'Which node?', suggestions: ['A', 'B'] };
        }
    }]);
    const response = await registry.generate({
        configuration: { provider: 'asksQuestions' }, context: { nodes: [] }, request: 'Set the temperature.'
    });
    assert.deepEqual(response, { responseKind: 'clarification', question: 'Which node?', suggestions: ['A', 'B'] });
    assert.equal(calls, 1);
});

test('provider registry rejects a malformed clarification response', async () => {
    const registry = createAIProviderRegistry([{
        id: 'badClarification', name: 'Bad clarification',
        generateProposal: async () => ({ responseKind: 'clarification' })
    }]);
    await assert.rejects(() => registry.generate({
        configuration: { provider: 'badClarification' }, context: { nodes: [] }, request: 'Build it'
    }), /requires a question/);
});

test('provider registry forwards conversation history to the provider', async () => {
    let receivedHistory;
    const registry = createAIProviderRegistry([{
        id: 'historyAware', name: 'History aware', generateProposal: async ({ history }) => {
            receivedHistory = history;
            return { proposalVersion: 1, operations: [{ kind: 'addNode', ref: 'testNode', name: 'Test node' }] };
        }
    }]);
    const history = [{ request: 'Earlier request', outcome: 'Applied something.' }];
    await registry.generate({
        configuration: { provider: 'historyAware' }, context: { nodes: [] }, request: 'Build it', history
    });
    assert.deepEqual(receivedHistory, history);
});

test('provider registry publishes progress: each attempt, the model\'s reasoning and output, validation and why it repaired', async () => {
    const snapshots = [];
    const registry = createAIProviderRegistry([{
        id: 'streaming', name: 'Streaming', generateProposal: async ({ repair, onEvent }) => {
            onEvent({ type: 'thinking', text: 'Considering' });
            onEvent({ type: 'output', text: '{"a":' });
            onEvent({ type: 'activity' });
            if (!repair) return { proposalVersion: 2, operations: [] };
            return { proposalVersion: 1, operations: [{ kind: 'addNode', ref: 'fixedNode', name: 'Fixed node' }] };
        }
    }]);
    await registry.generate({
        configuration: { provider: 'streaming' }, context: { nodes: [] }, request: 'Build it', onProgress: (progress) => snapshots.push(progress)
    });
    assert.deepEqual([...new Set(snapshots.map((progress) => progress.attempt))], [1, 2]);
    assert.ok(snapshots.every((progress) => progress.attempts === 3));
    assert.equal(snapshots[0].phase, 'sending');
    const firstValidation = snapshots.find((progress) => progress.phase === 'validating');
    assert.equal(firstValidation.attempt, 1);
    assert.equal(firstValidation.thinking, 'Considering');
    assert.equal(firstValidation.outputCharacters, 5);
    const secondAttempt = snapshots.find((progress) => progress.attempt === 2);
    assert.equal(secondAttempt.thinking, '');
    assert.equal(secondAttempt.outputCharacters, 0);
    assert.match(secondAttempt.repairReason, /proposalVersion/);
});

test('provider registry keeps progress text bounded and redacts the credential from repair reasons', async () => {
    const snapshots = [];
    const registry = createAIProviderRegistry([{
        id: 'chatty', name: 'Chatty', generateProposal: async ({ onEvent }) => {
            for (let index = 0; index < 100; index += 1) onEvent({ type: 'thinking', text: 'x'.repeat(1000) });
            const error = new Error('Bad output containing secret-key');
            error.code = 'invalidProposalJson';
            throw error;
        }
    }]);
    await assert.rejects(() => registry.generate({
        configuration: { provider: 'chatty' }, credential: 'secret-key', context: { nodes: [] }, request: 'x', onProgress: (progress) => snapshots.push(progress)
    }));
    assert.ok(snapshots.every((progress) => progress.thinking.length <= 8000));
    assert.ok(snapshots.some((progress) => progress.repairReason.includes('[redacted]')));
    assert.ok(!snapshots.some((progress) => progress.repairReason.includes('secret-key')));
});
