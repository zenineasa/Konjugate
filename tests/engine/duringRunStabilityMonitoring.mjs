/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Permanent regression test for the during-run phase of
// docs/proposals/numericalStabilityDiagnostics.md, run against the real compiled engine binary
// end to end -- confirms the protobuf StabilityFindingReport field on ResultFile (not JSON, see
// protocol/engineProtocol.proto's own comment on why report-shaped data lives in real protobuf
// fields) round-trips correctly through the real `run` CLI and src/engineProtocol.mjs's decoder.
// Same exact-hand-verifiable fixture as tests/engine/postRunStabilityDiagnostics.mjs and
// engine/tests/duringRunStabilityMonitorTests.cpp: dx/dt = -21x, globalTimeStep=0.1 puts
// substeps=1 just past the |1 - stepSize·decayRate| <= 1 stability boundary.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';

function execute(command, args) {
    return new Promise((resolveExec, reject) => {
        const child = spawn(command, args, { stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code) => resolveExec(code));
    });
}

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

async function runOnce(executable, directory, label, document, stabilityMonitoring) {
    const inputPath = join(directory, `${label}.kjt`);
    const configPath = join(directory, `${label}.config.json`);
    const outputPath = join(directory, `${label}.result.bin`);
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(document)));
    await writeFile(configPath, JSON.stringify({
        name: label, targetTime: 2, globalTimeStep, outputInterval: globalTimeStep,
        ...(stabilityMonitoring ? { stabilityMonitoring } : {})
    }));
    assert.equal(await execute(executable, ['run', inputPath, '--configuration', configPath, '--output', outputPath]), 0, `${label}: run must succeed.`);
    return decodeResultFile(await readFile(outputPath));
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');

const directory = await mkdtemp(join(tmpdir(), 'konjugateDuringRunStabilityMonitoring-'));
try {
    const unmonitored = await runOnce(executable, directory, 'unmonitored', decayDocument(1), undefined);
    assert.deepEqual(unmonitored.stabilityFindings, [], 'An unmonitored run must never produce stability findings, however unstable the model.');
    console.log('✓ an unmonitored run (the default) produces no stability findings.');

    const monitored = await runOnce(executable, directory, 'monitored', decayDocument(1), { nodeIds: [1] });
    assert.ok(monitored.stabilityFindings.length >= 2, 'A monitored, genuinely unstable run should produce at least a Tier 1 and a Tier 2 finding.');
    const growthFinding = monitored.stabilityFindings.find((finding) => finding.code === 'duringRunGrowthTrend');
    const confirmingFinding = monitored.stabilityFindings.find((finding) => finding.code === 'duringRunPotentiallyUnstable');
    assert.ok(growthFinding, 'Tier 1 (duringRunGrowthTrend) should fire.');
    assert.ok(confirmingFinding, 'Tier 2 (duringRunPotentiallyUnstable) should fire, confirmed via the same assessNodeStability() the pre-run phase uses.');
    assert.equal(growthFinding.nodeId, 1);
    assert.equal(growthFinding.stateId, 11, 'A Tier 1 finding must identify the specific state, not just the node.');
    assert.equal(confirmingFinding.stateId, 0, 'A Tier 2 finding is about the node as a whole, not one state -- stateId 0 means "no state".');
    assert.ok(Number.isFinite(growthFinding.globalTime) && growthFinding.globalTime > 0,
        'globalTime must decode as a real, finite double through the protobuf field, not a JSON-string number.');
    console.log(`✓ a monitored, genuinely unstable run produces both tiers, correctly attributed (node ${growthFinding.nodeId}, state ${growthFinding.stateId}, at t=${growthFinding.globalTime}).`);

    const stable = await runOnce(executable, directory, 'stable', decayDocument(8), { nodeIds: [1] });
    assert.deepEqual(stable.stabilityFindings, [], 'A monitored but genuinely stable, well-substepped run should produce no findings.');
    console.log('✓ a monitored, stable run stays silent.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
