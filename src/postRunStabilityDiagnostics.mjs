/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Post-run phase of docs/proposals/numericalStabilityDiagnostics.md's three-phase numerical
// stability diagnostic -- analysis of a result that already exists, not a new engine capability.
// detectInstabilityFingerprint() costs nothing beyond arithmetic over an already-decoded result;
// checkSubstepConvergence() costs a small, caller-bounded number of extra runs (a substep-doubling
// search), used only when the fingerprint check (or a caller's own suspicion) flags a candidate
// node. Neither phase changes the engine or the project schema -- see that proposal's "What can
// actually be recommended" section for why a schema change isn't needed: the fix this module
// recommends is expressed entirely through the existing `numerics.substepsPerGlobalStep` field via
// assistantOperations.mjs's existing `updateNode` operation, not a new mutation path.
//
// Caller responsibility: `document` passed to either export must already be the fully RESOLVED
// project JSON (kind:"plugin"/kind:"fmi" implementations already turned into kind:"cpp"/"python"
// by resolveInstalledPlugins()/resolveInstalledFmus(), exactly as engineAdapter.mjs's own
// validateWithEngine()/startEngineRun() already do before writing a .kjt) -- this module does not
// perform that resolution itself, since doing so needs Electron-main-process-only paths
// (userData plugin/FMU directories) this module has no reason to depend on.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runEngine } from './engineAdapter.mjs';
import { encodeProjectFile } from './projectFile.mjs';
import { decodeResultFile } from './engineProtocol.mjs';
import { detectInstabilityFingerprint, recommendedSubstepFixProposal } from './instabilityFingerprint.mjs';

// Re-exported, not defined here: see instabilityFingerprint.mjs's own file header for why these
// live in their own dependency-free module (the renderer imports them directly).
export { detectInstabilityFingerprint, recommendedSubstepFixProposal };

async function runOnce(executable, document, runConfiguration, directory, label) {
    const inputPath = join(directory, `${label}.kjt`);
    const configurationPath = join(directory, `${label}.config.json`);
    const outputPath = join(directory, `${label}.result.bin`);
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(document)));
    await writeFile(configurationPath, JSON.stringify(runConfiguration));
    const execution = await runEngine(executable, ['run', inputPath, '--configuration', configurationPath, '--output', outputPath]);
    if (execution.code !== 0) {
        throw new Error(execution.diagnostics || `The engine exited with code ${execution.code} while checking substep convergence.`);
    }
    return decodeResultFile(await readFile(outputPath));
}

// Root-mean-square difference between two same-shaped results, over one node's own states only,
// normalized by that node's own RMS magnitude in the (presumably more accurate, higher-substep)
// second result -- a relative rather than absolute tolerance, so this works the same way for a
// state that settles near 0.001 as one that settles near 1000. Assumes both results were produced
// from the identical runConfiguration (same targetTime/outputInterval), so their sample times line
// up index-for-index; this module never compares results sampled at different cadences.
function relativeRmsDifference(resultA, resultB, stateIds) {
    let sumSquaredDifference = 0;
    let sumSquaredScale = 0;
    let count = 0;
    const sampleCount = Math.min(resultA.samples.length, resultB.samples.length);
    for (let index = 0; index < sampleCount; index += 1) {
        for (const stateId of stateIds) {
            const a = resultA.samples[index].states.find((state) => state.stateId === stateId)?.value;
            const b = resultB.samples[index].states.find((state) => state.stateId === stateId)?.value;
            if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
            sumSquaredDifference += (a - b) ** 2;
            sumSquaredScale += b * b;
            count += 1;
        }
    }
    if (!count) return Infinity;
    const scale = Math.sqrt(sumSquaredScale / count);
    return Math.sqrt(sumSquaredDifference / count) / (scale || 1);
}

// For each candidate node, doubles its own substep count repeatedly (independent of every other
// node's substeps, which stay at the document's own values) and compares consecutive doublings'
// trajectories until they agree within relativeTolerance -- a Richardson-extrapolation-style
// convergence check, not just a "did it blow up" check: a run that stays finite but hasn't
// converged is still numerically wrong, and this is what tells the two apart (see the parent
// proposal's post-run section). Bounded by design: at most log2(maxSubstepMultiplier) extra runs
// per candidate node, and only for nodes the caller actually passes -- typically the ones
// detectInstabilityFingerprint() (or a pre-run check, once one exists) already flagged, not every
// node in the graph.
// Defaults reflect Explicit Euler's own first-order accuracy, not an arbitrary choice: halving the
// step size only halves the error, so consecutive doublings' relative difference shrinks as O(1/N)
// -- reaching much tighter than roughly 1% agreement can require several hundred substeps even for
// a mild, freshly-stabilized case (verified directly against the real engine on a single-state
// exponential-decay fixture; see tests/engine/postRunStabilityDiagnostics.mjs). 1% is a realistic
// "good enough" bar for this method, not a compromise -- and maxSubstepMultiplier bounds the search
// regardless, per the parent proposal's cost-bounding discussion.
export async function checkSubstepConvergence({
    executable, document, runConfiguration, nodeIds, directory,
    maxSubstepMultiplier = 256, relativeTolerance = 1e-2
}) {
    const findings = [];
    for (const nodeId of nodeIds) {
        const node = document.nodes.find((candidate) => candidate.id === nodeId);
        if (!node) continue;
        const baseSubsteps = node.numerics?.substepsPerGlobalStep ?? 1;
        const stateIds = node.states.map((state) => state.id);

        let multiplier = 1;
        let previousResult = await runOnce(executable, document, runConfiguration, directory, `stability-node${nodeId}-x${multiplier}`);
        let converged = false;
        let recommendedSubsteps = null;
        let achievedRelativeDifference = Infinity;

        while (multiplier < maxSubstepMultiplier) {
            multiplier *= 2;
            const candidateDocument = structuredClone(document);
            const candidateNode = candidateDocument.nodes.find((candidate) => candidate.id === nodeId);
            candidateNode.numerics = { ...candidateNode.numerics, substepsPerGlobalStep: baseSubsteps * multiplier };
            const candidateResult = await runOnce(executable, candidateDocument, runConfiguration, directory, `stability-node${nodeId}-x${multiplier}`);
            achievedRelativeDifference = relativeRmsDifference(previousResult, candidateResult, stateIds);
            if (achievedRelativeDifference <= relativeTolerance) {
                converged = true;
                recommendedSubsteps = baseSubsteps * multiplier;
                break;
            }
            previousResult = candidateResult;
        }
        findings.push({ nodeId, baseSubsteps, converged, recommendedSubsteps, multiplierReached: multiplier, achievedRelativeDifference });
    }
    return findings;
}
