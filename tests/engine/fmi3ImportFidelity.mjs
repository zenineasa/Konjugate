/* Copyright © 2026 Zenin Easa Panthakkalakath */

// End-to-end fidelity check for FMI 3.0 import (Phase 3). Two "known good" FMUs are imported. The
// first is a hand-authored real fmi3* Co-Simulation shared library (fixtures/fmi3DecayFixture.cpp)
// standing in for a third-party vendor FMU -- compiled directly (not through Konjugate's own build
// machinery, which plays no role in producing a vendor's own FMU), zipped into a real .fmu shape,
// installed exactly like the Extensions UI would, then imported into a host project and compared
// against a hand-computed Euler trajectory using the exact same expression order as the fixture's
// own fmi3DoStep, so the comparison is exact rather than approximate. The second is Konjugate's own
// FMI 3.0 export of a decay model (src/fmiExport.mjs), round-tripped as tests/engine/fmiImportFidelity.mjs
// round-trips the FMI 2.0 one: exported, installed, imported into a host project, and compared with
// the engine's own run of the model it was exported from.
//
// It then checks the importer against FMUs it did not write: the FMI 3.0 Reference FMUs, every
// output at every communication point compared bit for bit with FMPy (fixtures/referenceFmuFidelity.mjs),
// and the errors a person sees when an FMU refuses a value, when a fixed parameter's binding
// changes during a run, and when an integer input is given a number outside its type.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { installFmuArchive } from '../../src/fmuPackage.mjs';
import { runWithEngine } from '../../src/engineAdapter.mjs';
import { generateFmuPackage, libraryExtension } from '../../src/fmiExport.mjs';
import { binaryDirectoryCandidates } from '../../src/fmiBinary.mjs';
import { closeEnough } from './fixtures/fmuFidelityFixture.mjs';
import { checkReferenceFmus, engineOptionsFor, installReferenceFmu, referenceHostDocument } from './fixtures/referenceFmuFidelity.mjs';

const globalTimeStep = 0.1;
const targetTime = 1.0;
const decayRate = 0.3;
const initialLevel = 10.0;
const instantiationToken = 'fmi3-decay-fixture-token';
const modelIdentifier = 'fmi3DecayFixture';
const absoluteTolerance = 1e-9;
const relativeTolerance = 1e-9;

function hostDocument({ fmuId, fmuVersion, k = decayRate }) {
    return {
        format: 'konjugate', version: 1, metadata: { projectName: 'FMI3 import fixture: host' },
        nodes: [{
            id: 1, name: 'Imported',
            states: [
                { id: 11, name: 'K', symbol: 'k', initialValue: k, unit: '' },
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
            // FMI 3.0 names a binary's directory by platform tuple (aarch64-darwin, x86_64-linux, ...).
            [`binaries/${binaryDirectoryCandidates('3.0')[0]}/${modelIdentifier}${libraryExtension()}`]: new Uint8Array(libraryBytes)
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

        // From sample 0: the host's own initial value is deliberately mismatched (0 vs. the fixture's real initial 10), but at
        // t = 0 the state holds the FMU's output once it is initialized (FMI review #6).
        let compared = 0;
        for (let index = 0; index < expected.length; index += 1) {
            const importedValue = importedLevelOf(importSamples[index]);
            assert.ok(
                closeEnough(importedValue, expected[index], absoluteTolerance, relativeTolerance),
                `Sample ${index}: imported FMI3 level ${importedValue} did not match the expected ${expected[index]}.`
            );
            compared += 1;
        }
        assert.ok(compared > 5, 'Test setup produced too few samples to be a meaningful comparison.');
        assert.ok(
            Object.is(importedLevelOf(importSamples[0]), expected[0]),
            `The imported FMI3 FMU's output at t = 0 is ${importedLevelOf(importSamples[0])}, not the FMU's ${expected[0]}: the host's initial value was recorded.`
        );

        console.log(`✓ FMI3 import fidelity: imported-FMU run matched the hand-computed trajectory across ${compared} samples, including t = 0, where the host's own initial value is mismatched.`);

        const runOptions = { targetTime, globalTimeStep, outputInterval: globalTimeStep, pacing: { mode: 'fastest' } };
        await assert.rejects(
            runWithEngine(JSON.stringify(hostDocument({ fmuId: installed.guid, fmuVersion: installed.version, k: -1 })), runOptions,
                { ...engineOptions, fmuDirectory: join(directory, 'packages'), disabledFmuKeys: [] }),
            (error) => /A node program failed: The FMU 'Fmi3 Decay Fixture' refused fmi3SetFloat64 \(setting 'k'\) at t = 0: logStatusError: k must not be negative\./.test(error.message)
                && !error.message.includes('makeImportedFmu3') // the generated source is not part of what the person reads
        );
        console.log('✓ FMI3 import: a value the FMU refuses stops the run naming the FMU, the call, the variable, the time and the FMU\'s own reason.');

        await checkKonjugateExport(directory, engineOptions);

        const packages = join(directory, 'referencePackages');
        console.log(`✓ ${await checkReferenceFmus('3.0', packages)}`);
        await checkImportErrors(packages);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// Konjugate's own FMI 3.0 export of a decay model with a live parameter (an FMI 3.0 input), installed and imported back: the imported
// node gives the engine's own run of the model it was exported from, from t = 0, though the host's state starts elsewhere.
async function checkKonjugateExport(directory, engineOptions) {
    const exported = {
        format: 'konjugate', version: 1, metadata: { projectName: 'FMI 3.0 export fixture: decay' },
        nodes: [{
            id: 1, name: 'Decay',
            states: [{ id: 11, name: 'Level', symbol: 'level', initialValue: initialLevel, unit: 'm' }],
            numerics: { substepsPerGlobalStep: 1 },
            sourceTerms: [{
                id: 101, state: 'level', expression: '-k level',
                expressionModel: {
                    latex: '-k x', output: { stateId: 11 }, mathJson: ['Multiply', ['Negate', 'k'], 'x'],
                    bindings: [{ kind: 'state', nodeId: 1, stateId: 11, symbol: 'x' }, { kind: 'parameter', parameterId: 21, symbol: 'k' }]
                },
                parameters: [{ id: 21, name: 'Decay rate', symbol: 'k', value: decayRate, unit: '1/s', mode: 'live', control: { minimum: 0, maximum: 1, step: 0.01 } }]
            }]
        }],
        edges: [],
        runConfigurations: [{ id: 900, globalTimeStep, outputInterval: globalTimeStep }],
        activeRunConfigurationId: 900
    };
    const fmu = await generateFmuPackage(exported, { modelName: 'konjugateDecay', engineOptions, fmiVersion: '3.0' });
    const packages = join(directory, 'konjugatePackages');
    const installed = await installFmuArchive(fmu, { directory: packages, version: '1.0.0' });
    assert.equal(installed.description.fmiVersion, '3.0');
    assert.deepEqual(installed.description.variables.map((variable) => `${variable.name} ${variable.causality} ${variable.type}`).sort(),
        ['Decay.Level output Float64', 'k input Float64'], 'The export\'s "time" is not a port; its state and live parameter are.');

    const runOptions = { targetTime, globalTimeStep, outputInterval: globalTimeStep, pacing: { mode: 'fastest' } };
    const reference = await runWithEngine(JSON.stringify(exported), runOptions, engineOptions);
    const imported = await runWithEngine(JSON.stringify(hostDocument({ fmuId: installed.guid, fmuVersion: installed.version })), runOptions,
        { ...engineOptions, fmuDirectory: packages, disabledFmuKeys: [] });
    if (!reference.available || !imported.available) throw new Error('The engine runs of the FMI 3.0 export round trip were not available.');
    const referenceSamples = reference.result.samples;
    const importedSamples = imported.result.samples;
    assert.equal(importedSamples.length, referenceSamples.length);
    // From sample 0: the host's own initial value is deliberately different, but at t = 0 the state holds the FMU's output (FMI review #6).
    for (let index = 0; index < referenceSamples.length; index += 1) {
        const expected = referenceSamples[index].states.find((state) => state.stateId === 11).value;
        const actual = importedSamples[index].states.find((state) => state.stateId === 12).value;
        assert.ok(Object.is(actual, expected), `Sample ${index}: the imported FMI 3.0 export gives ${actual}, the engine ${expected}.`);
    }
    console.log(`✓ FMI3 import of Konjugate's own FMI 3.0 export: the imported FMU gave the engine's run of the exported model bit for bit across ${referenceSamples.length} samples, from t = 0.`);
}

// A fixed parameter bound to something that changes during the run, and an integer input given a number outside its
// type: each stops the run saying which FMU, which variable and why.
async function checkImportErrors(packages) {
    const run = (document, stopTime, stepSize) => runWithEngine(JSON.stringify(document),
        { targetTime: stopTime, globalTimeStep: stepSize, outputInterval: stepSize, pacing: { mode: 'fastest' } }, engineOptionsFor(packages));

    // Two Dahlquist nodes: the second's fixed parameter k is bound to the first's x, which decays. The second starts with the first's
    // x at the start, the FMU's 1 (FMI review #6: it was the host's initial value, 0), whichever of them comes first in the file.
    const { installed, ports } = await installReferenceFmu('3.0', 'Dahlquist', packages);
    const first = referenceHostDocument({ guid: installed.guid, version: installed.version, ports, values: { k: 1 }, stepSize: 0.1 });
    const second = structuredClone(first.nodes[0]);
    second.id = 2;
    second.name = 'Dahlquist 2';
    second.states = second.states.filter((state) => state.id >= 200).map((state) => ({ ...state, id: state.id + 100 }));
    second.implementation.bindings = [{ key: 'k', kind: 'state', nodeId: 1, stateId: 200 }];
    second.implementation.outputs = second.implementation.outputs.map((output) => ({ ...output, stateId: output.stateId + 100 }));
    first.nodes.unshift(second);
    await assert.rejects(run(first, 1, 0.1),
        /The parameter 'k' of the FMU 'Dahlquist' is fixed: it was set to 1 when the run started and cannot change during the run, but what it is bound to is now 0\.9 \(at t = 0\.1\)/);
    console.log('✓ FMI3 import: a fixed parameter whose binding changes during the run stops it, naming the parameter and both values.');

    const feedthrough = await installReferenceFmu('3.0', 'Feedthrough', packages);
    await assert.rejects(
        run(referenceHostDocument({ guid: feedthrough.installed.guid, version: feedthrough.installed.version, ports: feedthrough.ports, values: { Int8_input: 300 }, stepSize: 0.1 }), 0.2, 0.1),
        /The input 'Int8_input' of the FMU 'Feedthrough' is an Int8, a whole number from -128 to 127, but it was given 300\./
    );
    console.log('✓ FMI3 import: an integer input outside its type stops the run, naming the input, its type\'s range and the value.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
