/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Permanent regression test for src/postRunStabilityDiagnostics.mjs (the post-run phase of
// docs/proposals/numericalStabilityDiagnostics.md), run against the real compiled engine binary --
// not a hand-rolled re-simulation, so this actually exercises the same executionPlan.cpp code path
// a real run does. Fixture: a single state x with dx/dt = -k*x (a self-referencing source term),
// k and the global timestep chosen so substeps=1 is genuinely unstable per Explicit Euler's own
// stability condition (k·globalTimeStep = 2.1, just past the |1 + stepSize·λ| ≤ 1 boundary) --
// exact, hand-verifiable numbers, not a guess: the per-substep decay factor is (1 - k·stepSize),
// and the model is stable iff |1 - k·stepSize| ≤ 1.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { decodeValidationReport } from '../../src/reportProtocol.mjs';
import { applyAssistantProposal } from '../../src/assistantOperations.mjs';
import {
    detectInstabilityFingerprint, checkSubstepConvergence, recommendedSubstepFixProposal
} from '../../src/postRunStabilityDiagnostics.mjs';

function execute(command, args) {
    return new Promise((resolveExec, reject) => {
        const child = spawn(command, args, { stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code) => resolveExec(code));
    });
}

// k·globalTimeStep = 2.1 at substeps=1: per-substep factor 1 - 2.1 = -1.1, |factor| = 1.1 > 1 --
// unstable, growing and alternating sign every global step (the classic sawtooth).
const decayRate = 21;
const globalTimeStep = 0.1;

function decayDocument(substeps) {
    return {
        format: 'konjugate', version: 1,
        nodes: [{
            id: 1, name: 'Decay',
            states: [{ id: 11, name: 'X', symbol: 'x', initialValue: 1 }],
            sourceTerms: [{
                id: 21, state: 'x', expression: '-\\mathrm{decayRate} \\cdot x',
                parameters: [{ id: 22, name: 'Decay rate', symbol: 'decayRate', value: decayRate, mode: 'constant' }],
                expressionModel: {
                    latex: '-\\mathrm{decayRate} \\cdot x', output: { stateId: 11 },
                    bindings: [
                        { kind: 'state', stateId: 11, symbol: 'x', label: 'x' },
                        { kind: 'parameter', parameterId: 22, symbol: 'decayRate', label: 'decayRate' }
                    ],
                    mathJson: ['Multiply', ['Negate', 'decayRate'], 'x']
                }
            }],
            numerics: { substepsPerGlobalStep: substeps }
        }],
        edges: []
    };
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');

const directory = await mkdtemp(join(tmpdir(), 'konjugatePostRunStabilityDiagnostics-'));
try {
    const unstableDocument = decayDocument(1);
    const validateReportPath = join(directory, 'validate.bin');

    const inputPath = join(directory, 'unstable.kjt');
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(unstableDocument)));
    assert.equal(await execute(executable, ['validate', inputPath, '--report', validateReportPath]), 0, 'validate must succeed.');
    const validation = decodeValidationReport(await readFile(validateReportPath));
    assert.equal(validation.valid, true, `The fixture must be a valid model (${JSON.stringify(validation.issues)}).`);

    const runConfiguration = { name: 'postRunStabilityDiagnostics', targetTime: 1, globalTimeStep, outputInterval: globalTimeStep };
    const configPath = join(directory, 'unstable.config.json');
    const outputPath = join(directory, 'unstable.result.bin');
    await writeFile(configPath, JSON.stringify(runConfiguration));
    assert.equal(await execute(executable, ['run', inputPath, '--configuration', configPath, '--output', outputPath]), 0, 'run must succeed.');
    const unstableResult = decodeResultFile(await readFile(outputPath));

    const findings = detectInstabilityFingerprint(unstableResult, unstableDocument);
    assert.equal(findings.length, 1, 'The unstable fixture must be flagged.');
    assert.equal(findings[0].nodeId, 1);
    assert.equal(findings[0].stateId, 11);
    assert.equal(findings[0].classicSawtoothFingerprint, true,
        'A single-substep node with a real negative eigenvalue past the stability boundary should show the classic growing, sign-alternating fingerprint.');
    console.log(`✓ detectInstabilityFingerprint flags the unstable fixture: growthRun=${findings[0].longestGrowthRun}, alternatingSignFraction=${findings[0].alternatingSignFraction.toFixed(3)}`);

    const convergence = await checkSubstepConvergence({
        executable, document: unstableDocument, runConfiguration, nodeIds: [1], directory
    });
    assert.equal(convergence.length, 1);
    const [nodeConvergence] = convergence;
    assert.equal(nodeConvergence.converged, true,
        `The convergence search should find a stable, converged substep count within the default bound (reached multiplier ${nodeConvergence.multiplierReached}, relative difference ${nodeConvergence.achievedRelativeDifference}).`);
    assert.ok(nodeConvergence.recommendedSubsteps > 1, 'The recommended substep count must actually be higher than the unstable baseline.');
    console.log(`✓ checkSubstepConvergence finds substeps=${nodeConvergence.recommendedSubsteps} converges to within its relative tolerance (relative difference ${nodeConvergence.achievedRelativeDifference.toFixed(5)}).`);

    // Auto-apply the fix through the SAME path a real assistant-driven or UI-driven edit would use
    // -- no bespoke mutation, per recommendedSubstepFixProposal's own file-header comment.
    const proposal = recommendedSubstepFixProposal(1, nodeConvergence.recommendedSubsteps);
    const { document: fixedDocument } = applyAssistantProposal(unstableDocument, proposal);
    assert.equal(fixedDocument.nodes[0].numerics.substepsPerGlobalStep, nodeConvergence.recommendedSubsteps);

    const fixedInputPath = join(directory, 'fixed.kjt');
    const fixedOutputPath = join(directory, 'fixed.result.bin');
    await writeFile(fixedInputPath, await encodeProjectFile(JSON.stringify(fixedDocument)));
    assert.equal(await execute(executable, ['run', fixedInputPath, '--configuration', configPath, '--output', fixedOutputPath]), 0, 'the fixed model must still run.');
    const fixedResult = decodeResultFile(await readFile(fixedOutputPath));
    const fixedFindings = detectInstabilityFingerprint(fixedResult, fixedDocument);
    assert.deepEqual(fixedFindings, [], 'Once the recommended fix is applied, the diagnostic should no longer flag the model.');
    console.log('✓ applying the recommended fix (via the existing updateNode operation) produces a run the diagnostic no longer flags.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
