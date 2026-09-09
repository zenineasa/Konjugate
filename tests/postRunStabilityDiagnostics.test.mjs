/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { detectInstabilityFingerprint, recommendedSubstepFixProposal } from '../src/postRunStabilityDiagnostics.mjs';
import { applyAssistantProposal } from '../src/assistantOperations.mjs';

// Synthesizes a result whose stateId=11 trajectory alternates sign and doubles in magnitude every
// sample -- the textbook Explicit Euler instability shape for a real negative eigenvalue past the
// `|1 + stepSize·λ| ≤ 1` boundary.
function growingSawtoothResult(sampleCount = 10) {
    const samples = [];
    let value = 1;
    for (let index = 0; index < sampleCount; index += 1) {
        samples.push({ time: index * 0.1, states: [{ stateId: 11, value }] });
        value *= -2;
    }
    return { samples };
}

function boundedOscillationResult(sampleCount = 10) {
    const samples = [];
    for (let index = 0; index < sampleCount; index += 1) {
        samples.push({ time: index * 0.1, states: [{ stateId: 11, value: Math.sin(index) }] });
    }
    return { samples };
}

function documentWithOneNode(substeps) {
    return {
        format: 'konjugate', version: 1,
        nodes: [{ id: 1, name: 'Node', states: [{ id: 11, name: 'X', symbol: 'x' }], sourceTerms: [], numerics: { substepsPerGlobalStep: substeps } }],
        edges: []
    };
}

test('detectInstabilityFingerprint flags a growing, sign-alternating trajectory on a single-substep node as the classic sawtooth', () => {
    const findings = detectInstabilityFingerprint(growingSawtoothResult(), documentWithOneNode(1));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].nodeId, 1);
    assert.equal(findings[0].stateId, 11);
    assert.equal(findings[0].classicSawtoothFingerprint, true);
    assert.ok(findings[0].alternatingSignFraction > 0.9);
});

test('detectInstabilityFingerprint still flags growth on a multi-substep node, but not as the classic sawtooth', () => {
    const findings = detectInstabilityFingerprint(growingSawtoothResult(), documentWithOneNode(4));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].classicSawtoothFingerprint, false,
        'The classic single-step sawtooth fingerprint should not be claimed for a node stepped internally more than once per recorded sample.');
});

test('detectInstabilityFingerprint reports nothing for a bounded, non-growing trajectory', () => {
    const findings = detectInstabilityFingerprint(boundedOscillationResult(), documentWithOneNode(1));
    assert.deepEqual(findings, []);
});

test('detectInstabilityFingerprint reports nothing when the result is too short to judge a sustained trend', () => {
    const findings = detectInstabilityFingerprint(growingSawtoothResult(3), documentWithOneNode(1));
    assert.deepEqual(findings, []);
});

test('recommendedSubstepFixProposal reuses the existing updateNode operation and actually applies through applyAssistantProposal', () => {
    const proposal = recommendedSubstepFixProposal(1, 16);
    assert.deepEqual(proposal, { proposalVersion: 1, operations: [{ kind: 'updateNode', nodeRef: 1, substepsPerGlobalStep: 16 }] });

    const { document } = applyAssistantProposal(documentWithOneNode(1), proposal);
    assert.equal(document.nodes[0].numerics.substepsPerGlobalStep, 16);
});
