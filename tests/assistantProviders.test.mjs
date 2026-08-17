/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { generateAssistantProposal, localAssistantProvider } from '../src/assistantProviders.mjs';

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

test('local provider creates an ambient thermal proposal using explicit values', async () => {
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

test('local provider reports defaults as assumptions', async () => {
    const proposal = await generateAssistantProposal(localAssistantProvider, {
        context, request: 'Connect an ambient thermal boundary to the battery.'
    });
    assert.equal(proposal.assumptions.length, 2);
    assert.equal(proposal.operations[1].initialValue, 293.15);
    assert.equal(proposal.operations[3].value, 10);
});

test('local provider creates a state update proposal for an existing node', async () => {
    const proposal = await generateAssistantProposal(localAssistantProvider, {
        context, request: 'Set the battery initial temperature to 325 K.'
    });
    assert.equal(proposal.responseKind, 'proposal');
    assert.deepEqual(proposal.operations, [
        { kind: 'updateState', stateRef: 'battery-temperature', initialValue: 325, unit: 'K' }
    ]);
    assert.match(proposal.summary, /Battery module/);
});

test('local provider asks a clarifying question when the temperature target is ambiguous', async () => {
    const response = await generateAssistantProposal(localAssistantProvider, {
        context: twoNodeContext, request: 'Set the temperature to 325 K.'
    });
    assert.equal(response.responseKind, 'clarification');
    assert.deepEqual(response.suggestions, ['Battery module', 'Enclosed air']);
});

test('local provider still resolves an explicitly named target among several candidates', async () => {
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

test('local provider asks a clarifying question when the temperature value is missing', async () => {
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

test('local provider asks a clarifying question when the disable/enable target is missing', async () => {
    const response = await generateAssistantProposal(localAssistantProvider, {
        context: twoNodeContext, request: 'Disable it.'
    });
    assert.equal(response.responseKind, 'clarification');
    assert.deepEqual(response.suggestions, ['Battery module', 'Enclosed air', 'Heat source']);
});

test('local provider rejects unsupported requests and missing model context', async () => {
    await assert.rejects(() => generateAssistantProposal(localAssistantProvider, {
        context, request: 'Create a gearbox.'
    }), /currently supports adding an ambient thermal boundary/);
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
