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
    assert.deepEqual(proposal.operations, [
        { kind: 'updateState', stateRef: 'battery-temperature', initialValue: 325, unit: 'K' }
    ]);
    assert.match(proposal.summary, /Battery module/);
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
