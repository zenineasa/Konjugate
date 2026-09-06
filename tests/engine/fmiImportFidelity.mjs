/* Copyright © 2026 Zenin Easa Panthakkalakath */

// End-to-end fidelity check for general FMI import (Phase 2 of the plan): exports a small
// single-state/single-live-parameter model as a real FMU (reusing the already-proven export
// path unchanged), installs it exactly like the Extensions UI would, then builds a SEPARATE host
// project that imports that FMU as a `kind: "fmi"` node -- and confirms the two run to matching
// numbers. This exercises the entire new stack in one pass: fmuPackage.mjs's install,
// fmiModelDescription.mjs's XML parsing, fmiResolver.mjs's codegen (including the pseudo-derivative
// output trick -- see that file's header comment), real compilation through buildCppProvider, and
// real execution through engine/src/providerInProcessNodeShim.cpp.
//
// The host model's own "Level" state is deliberately given a DIFFERENT initial value than the
// exported model's (0 instead of 10), specifically to prove the pseudo-derivative feedback binding
// self-corrects to the FMU's real reported value starting from the very first substep, not just
// "eventually converges" -- a wrong feedback wiring would show up as a persistent offset instead.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateFmuPackage } from '../../src/fmiExport.mjs';
import { installFmuArchive } from '../../src/fmuPackage.mjs';
import { runWithEngine } from '../../src/engineAdapter.mjs';
import { closeEnough } from './fixtures/fmuFidelityFixture.mjs';

const globalTimeStep = 0.1;
const targetTime = 1.0;
const decayRate = 0.3;
const absoluteTolerance = 1e-9;
const relativeTolerance = 1e-9;

const exportDocument = {
    format: 'konjugate', version: 1, metadata: { projectName: 'FMI import fixture: decay' },
    nodes: [{
        id: 1, name: 'Decay',
        states: [{ id: 11, name: 'Level', symbol: 'level', initialValue: 10, unit: '' }],
        numerics: { substepsPerGlobalStep: 1 },
        sourceTerms: [{
            id: 101, state: 'level', expression: '-k level',
            expressionModel: {
                latex: '-k x', bindings: [
                    { kind: 'state', nodeId: 1, stateId: 11, symbol: 'x' },
                    { kind: 'parameter', parameterId: 21, symbol: 'k' }
                ],
                output: { stateId: 11 }, mathJson: ['Multiply', ['Negate', 'k'], 'x']
            },
            parameters: [{ id: 21, name: 'Decay rate', symbol: 'k', value: decayRate, mode: 'live', control: { minimum: 0, maximum: 1, step: 0.01 } }]
        }]
    }],
    edges: [],
    runConfigurations: [{ id: 900, globalTimeStep, outputInterval: globalTimeStep }],
    activeRunConfigurationId: 900
};

function hostDocument({ fmuId, fmuVersion }) {
    return {
        format: 'konjugate', version: 1, metadata: { projectName: 'FMI import fixture: host' },
        nodes: [{
            id: 1, name: 'Imported',
            states: [
                { id: 11, name: 'K', symbol: 'k', initialValue: decayRate, unit: '' },
                // Deliberately mismatched vs. the exported model's initialValue (10) -- see file header.
                { id: 12, name: 'Level', symbol: 'level', initialValue: 0, unit: '' }
            ],
            numerics: { substepsPerGlobalStep: 1 },
            sourceTerms: [],
            implementation: {
                kind: 'fmi', fmuId, fmuVersion, providerApiVersion: 1,
                bindings: [{ key: 'k', kind: 'state', stateId: 11 }],
                // "Decay.Level" (the FMU's own variable name) sanitizes to "decayLevel" -- see
                // fmiResolver.mjs's sanitizeToLowerCamelCase(), which every binding/output key
                // for an FMI implementation must be derived through, matching Konjugate's own
                // lower-camel-case requirement for provider port keys.
                outputs: [{ key: 'decayLevel', stateId: 12 }]
            }
        }],
        edges: [],
        runConfigurations: [{ id: 900, globalTimeStep, outputInterval: globalTimeStep }],
        activeRunConfigurationId: 900
    };
}

async function main() {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateFmiImportFidelity-'));
    try {
        const engineOptions = { applicationPath: join(import.meta.dirname, '..', '..'), resourcesPath: '', packaged: false };

        const fmuBuffer = await generateFmuPackage(exportDocument, { modelName: 'decayFixture', engineOptions });
        const installed = await installFmuArchive(fmuBuffer, { directory: join(directory, 'packages'), version: '1.0.0' });
        assert.equal(installed.description.fmiVersion, '2.0');
        assert.deepEqual(installed.description.variables.map((v) => v.name).sort(), ['Decay.Level', 'k']);

        const referenceRun = await runWithEngine(JSON.stringify(exportDocument), { targetTime, globalTimeStep, outputInterval: globalTimeStep, pacing: { mode: 'fastest' } }, engineOptions);
        if (!referenceRun.available) throw new Error('The reference (non-FMU) engine run was not available.');

        const importRun = await runWithEngine(
            JSON.stringify(hostDocument({ fmuId: installed.guid, fmuVersion: installed.version })),
            { targetTime, globalTimeStep, outputInterval: globalTimeStep, pacing: { mode: 'fastest' } },
            { ...engineOptions, fmuDirectory: join(directory, 'packages'), disabledFmuKeys: [] }
        );
        if (!importRun.available) throw new Error('The FMI-import engine run was not available.');

        const referenceSamples = referenceRun.result.samples;
        const importSamples = importRun.result.samples;
        assert.equal(importSamples.length, referenceSamples.length, 'The imported-FMU run produced a different number of samples than the reference run.');

        const referenceLevelOf = (sample) => sample.states.find((state) => state.stateId === 11).value;
        const importedLevelOf = (sample) => sample.states.find((state) => state.stateId === 12).value;

        // Sample 0 is the pre-simulation initial condition, deliberately mismatched (see above) --
        // comparison starts at sample 1, the first point the pseudo-derivative trick has had a
        // chance to act.
        let compared = 0;
        for (let index = 1; index < referenceSamples.length; index += 1) {
            const referenceValue = referenceLevelOf(referenceSamples[index]);
            const importedValue = importedLevelOf(importSamples[index]);
            assert.ok(
                closeEnough(importedValue, referenceValue, absoluteTolerance, relativeTolerance),
                `Sample ${index} (t=${referenceSamples[index].time}): imported FMU level ${importedValue} did not match the reference ${referenceValue}.`
            );
            compared += 1;
        }
        assert.ok(compared > 5, 'Test setup produced too few samples to be a meaningful comparison.');

        // The very first sample after t=0 is the strongest proof the pseudo-derivative feedback
        // binding is wired correctly: the host's own initial value (0) is nowhere close to the
        // reference's first real step, so a silent feedback-binding bug would show up here first.
        assert.ok(
            closeEnough(importedLevelOf(importSamples[1]), referenceLevelOf(referenceSamples[1]), absoluteTolerance, relativeTolerance),
            'The imported FMU state did not snap to the FMU-reported value on the very first substep.'
        );

        console.log(`✓ FMI import fidelity: imported-FMU run matched the reference engine run across ${compared} samples, including a mismatched-initial-value first step.`);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
