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
