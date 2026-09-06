/* Copyright © 2026 Zenin Easa Panthakkalakath */

// End-to-end fidelity check for FMI 3.0 import (Phase 3): unlike tests/engine/fmiImportFidelity.mjs
// (FMI 2.0), Konjugate cannot export FMI 3.0 itself, so the "known good" FMU here is a
// hand-authored real fmi3* Co-Simulation shared library (fixtures/fmi3DecayFixture.cpp) standing
// in for a third-party vendor FMU -- compiled directly (not through Konjugate's own build
// machinery, which plays no role in producing a vendor's own FMU), zipped into a real .fmu shape,
// installed exactly like the Extensions UI would, then imported into a host project and compared
// against a hand-computed Euler trajectory using the exact same expression order as the fixture's
// own fmi3DoStep, so the comparison is exact rather than approximate.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { installFmuArchive } from '../../src/fmuPackage.mjs';
import { runWithEngine } from '../../src/engineAdapter.mjs';
import { platformDirectory, libraryExtension } from '../../src/fmiExport.mjs';
import { closeEnough } from './fixtures/fmuFidelityFixture.mjs';

const globalTimeStep = 0.1;
const targetTime = 1.0;
const decayRate = 0.3;
const initialLevel = 10.0;
const instantiationToken = 'fmi3-decay-fixture-token';
const modelIdentifier = 'fmi3DecayFixture';
const absoluteTolerance = 1e-9;
const relativeTolerance = 1e-9;

function hostDocument({ fmuId, fmuVersion }) {
    return {
        format: 'konjugate', version: 1, metadata: { projectName: 'FMI3 import fixture: host' },
        nodes: [{
            id: 1, name: 'Imported',
            states: [
                { id: 11, name: 'K', symbol: 'k', initialValue: decayRate, unit: '' },
                { id: 12, name: 'Level', symbol: 'level', initialValue: 0, unit: '' } // deliberately mismatched, see fmiImportFidelity.mjs
            ],
            numerics: { substepsPerGlobalStep: 1 },
            sourceTerms: [],
            implementation: {
                kind: 'fmi', fmuId, fmuVersion, providerApiVersion: 1,
                bindings: [{ key: 'k', kind: 'state', stateId: 11 }],
                outputs: [{ key: 'decayLevel', stateId: 12 }]
            }
        }],
        edges: [],
        runConfigurations: [{ id: 900, globalTimeStep, outputInterval: globalTimeStep }],
        activeRunConfigurationId: 900
    };
}

function expectedTrajectory() {
    const values = [initialLevel];
    let x = initialLevel;
    const steps = Math.round(targetTime / globalTimeStep);
    for (let step = 0; step < steps; step += 1) {
        // Exactly mirrors fmi3DecayFixture.cpp's fmi3DoStep: x += (-k * x) * dt.
        x = x + (-(decayRate * x)) * globalTimeStep;
        values.push(x);
    }
    return values;
}

function compileFixtureLibrary(sourcePath, outputPath) {
    const sharedFlag = process.platform === 'win32' ? '/LD' : '-shared';
    const includeFlag = `-I${join(import.meta.dirname, '..', '..', 'engine', 'include')}`;
    if (process.platform === 'win32') {
        execFileSync('cl.exe', ['/std:c++20', '/EHsc', '/nologo', includeFlag, sharedFlag, sourcePath, `/Fe${outputPath}`], { stdio: 'inherit' });
    } else {
        const args = ['-std=c++20', '-O1', '-fPIC', includeFlag, sharedFlag, sourcePath, '-o', outputPath];
        if (process.platform === 'darwin') args.push('-mmacosx-version-min=11.0');
        execFileSync('c++', args, { stdio: 'inherit' });
    }
}

async function main() {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateFmi3ImportFidelity-'));
    try {
        const sourcePath = join(import.meta.dirname, 'fixtures', 'fmi3DecayFixture.cpp');
        const libraryPath = join(directory, `${modelIdentifier}${libraryExtension()}`);
        compileFixtureLibrary(sourcePath, libraryPath);
        const libraryBytes = await readFile(libraryPath);

        const xml = `<?xml version="1.0"?>
<fmiModelDescription fmiVersion="3.0" modelName="Fmi3 Decay Fixture" instantiationToken="${instantiationToken}">
    <CoSimulation modelIdentifier="${modelIdentifier}" canGetAndSetFMUState="true" canSerializeFMUState="true"/>
    <ModelVariables>
        <Float64 name="Decay.Level" valueReference="0" causality="output" start="${initialLevel}"/>
        <Float64 name="k" valueReference="1" causality="input" start="${decayRate}"/>
    </ModelVariables>
</fmiModelDescription>`;
        const archive = zipSync({
            'modelDescription.xml': new TextEncoder().encode(xml),
            [`binaries/${platformDirectory()}/${modelIdentifier}${libraryExtension()}`]: new Uint8Array(libraryBytes)
        }, { level: 0 });

        const installed = await installFmuArchive(archive, { directory: join(directory, 'packages'), version: '1.0.0' });
        assert.equal(installed.description.fmiVersion, '3.0');
        assert.deepEqual(installed.description.variables.map((v) => v.name).sort(), ['Decay.Level', 'k']);

        const engineOptions = { applicationPath: join(import.meta.dirname, '..', '..'), resourcesPath: '', packaged: false };
        const importRun = await runWithEngine(
            JSON.stringify(hostDocument({ fmuId: installed.guid, fmuVersion: installed.version })),
            { targetTime, globalTimeStep, outputInterval: globalTimeStep, pacing: { mode: 'fastest' } },
            { ...engineOptions, fmuDirectory: join(directory, 'packages'), disabledFmuKeys: [] }
        );
        if (!importRun.available) throw new Error('The FMI3-import engine run was not available.');

        const expected = expectedTrajectory();
        const importSamples = importRun.result.samples;
        assert.equal(importSamples.length, expected.length, 'The imported FMI3 run produced an unexpected number of samples.');

        const importedLevelOf = (sample) => sample.states.find((state) => state.stateId === 12).value;

        // Sample 0 is the pre-simulation initial condition, deliberately mismatched (0 vs. the
        // fixture's real initial 10) -- comparison starts at sample 1.
        let compared = 0;
        for (let index = 1; index < expected.length; index += 1) {
            const importedValue = importedLevelOf(importSamples[index]);
            assert.ok(
                closeEnough(importedValue, expected[index], absoluteTolerance, relativeTolerance),
                `Sample ${index}: imported FMI3 level ${importedValue} did not match the expected ${expected[index]}.`
            );
            compared += 1;
        }
        assert.ok(compared > 5, 'Test setup produced too few samples to be a meaningful comparison.');
        assert.ok(
            closeEnough(importedLevelOf(importSamples[1]), expected[1], absoluteTolerance, relativeTolerance),
            'The imported FMI3 state did not snap to the FMU-reported value on the very first substep.'
        );

        console.log(`✓ FMI3 import fidelity: imported-FMU run matched the hand-computed trajectory across ${compared} samples, including a mismatched-initial-value first step.`);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
