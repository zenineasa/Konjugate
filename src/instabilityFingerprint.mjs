/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The pure-arithmetic half of src/postRunStabilityDiagnostics.mjs's post-run phase, split into its
// own dependency-free module specifically so it can be imported directly from the renderer
// (contextIsolation: true, nodeIntegration: false -- no node: builtins available there), unlike
// postRunStabilityDiagnostics.mjs itself, which pulls in node:fs/node:child_process for
// checkSubstepConvergence()'s real engine re-runs. postRunStabilityDiagnostics.mjs re-exports this
// function, so every existing import of it from there keeps working unchanged.

function nodeContainingState(document, stateId) {
    return document.nodes.find((node) => node.states.some((state) => state.id === stateId));
}

// The classic Explicit Euler instability fingerprint -- a first difference that grows AND
// alternates sign every step, from an eigenvalue past the `|1 + stepSize·λ| ≤ 1` boundary on the
// negative side -- is only a meaningful read on a node stepped once per recorded output sample.
// A node substepped internally (numerics.substepsPerGlobalStep > 1) can still be genuinely
// unstable at the substep level without that alternation surviving into its once-per-global-step
// recorded output, so this function reports growth generally (the substep-count-agnostic signal)
// and only additionally claims the specific "classic sawtooth" fingerprint when substeps === 1.
// Sustained growth alone cannot distinguish a numerically-unstable-but-physically-stable model
// from a model whose underlying physics is genuinely, correctly unstable (an inverted pendulum
// falling over is not a numerics bug) -- this is a heuristic finding, not a diagnosis, exactly
// like the pre-run phase's own Jacobian check in the parent proposal.
export function detectInstabilityFingerprint(result, document, {
    minimumConsecutiveGrowthSteps = 4,
    growthRatioThreshold = 1.05,
    negligibleDifference = 1e-9,
    sawtoothSignFlipFraction = 0.7
} = {}) {
    if (result.samples.length < minimumConsecutiveGrowthSteps + 2) return [];
    const stateIds = result.samples[0].states.map((state) => state.stateId);
    const findings = [];
    for (const stateId of stateIds) {
        const values = result.samples.map((sample) => sample.states.find((state) => state.stateId === stateId).value);
        const differences = [];
        for (let index = 1; index < values.length; index += 1) differences.push(values[index] - values[index - 1]);

        let longestGrowthRun = 0;
        let currentGrowthRun = 0;
        let signFlips = 0;
        let comparableSteps = 0;
        for (let index = 1; index < differences.length; index += 1) {
            const previous = differences[index - 1];
            const current = differences[index];
            if (Math.abs(previous) < negligibleDifference) { currentGrowthRun = 0; continue; }
            comparableSteps += 1;
            if (Math.sign(current) !== 0 && Math.sign(current) !== Math.sign(previous)) signFlips += 1;
            if (Math.abs(current) > growthRatioThreshold * Math.abs(previous)) {
                currentGrowthRun += 1;
                longestGrowthRun = Math.max(longestGrowthRun, currentGrowthRun);
            } else {
                currentGrowthRun = 0;
            }
        }
        if (longestGrowthRun < minimumConsecutiveGrowthSteps) continue;

        const node = nodeContainingState(document, stateId);
        const substeps = node?.numerics?.substepsPerGlobalStep ?? 1;
        const alternatingSignFraction = comparableSteps ? signFlips / comparableSteps : 0;
        findings.push({
            nodeId: node?.id ?? null,
            stateId,
            longestGrowthRun,
            alternatingSignFraction,
            classicSawtoothFingerprint: substeps === 1 && alternatingSignFraction >= sawtoothSignFlipFraction
        });
    }
    return findings;
}
