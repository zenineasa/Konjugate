/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Imports the FMI Reference FMUs (github.com/modelica/Reference-FMUs, BSD-2-Clause) into Konjugate and compares every
// output, at every communication point, with what FMPy computes for the same FMU (referenceFmus/fmpyReference.json,
// written by referenceFmus/fmpyReference.py from the cases in referenceFmus/cases.json). Shared by
// tests/engine/fmiImportFidelity.mjs (FMI 2.0) and fmi3ImportFidelity.mjs (FMI 3.0).
//
// The release zip is not in the repository: it is downloaded once, checked against its SHA-256, and kept in the
// system's temporary directory (or read from KONJUGATE_REFERENCE_FMUS_ZIP, a path to the same zip, for a machine
// without network access).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { installFmuArchive } from '../../../src/fmuPackage.mjs';
import { describeInstalledFmuPorts } from '../../../src/fmiResolver.mjs';
import { runWithEngine } from '../../../src/engineAdapter.mjs';

const here = join(import.meta.dirname, 'referenceFmus');
export const referenceCases = JSON.parse(await readFile(join(here, 'cases.json'), 'utf8'));
const fmpyReference = JSON.parse(await readFile(join(here, 'fmpyReference.json'), 'utf8'));

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

let releaseZip;
async function referenceReleaseZip() {
    if (releaseZip) return releaseZip;
    const cached = process.env.KONJUGATE_REFERENCE_FMUS_ZIP || join(tmpdir(), `konjugateReferenceFmus-${referenceCases.release}.zip`);
    let bytes = await readFile(cached).catch(() => null);
    if (!bytes || sha256(bytes) !== referenceCases.sha256) {
        const response = await fetch(referenceCases.url);
        if (!response.ok) throw new Error(`Downloading the FMI Reference FMUs from ${referenceCases.url} failed: HTTP ${response.status}.`);
        bytes = Buffer.from(await response.arrayBuffer());
        if (sha256(bytes) !== referenceCases.sha256) {
            throw new Error(`The downloaded FMI Reference FMUs zip does not have the expected SHA-256 ${referenceCases.sha256}.`);
        }
        if (!process.env.KONJUGATE_REFERENCE_FMUS_ZIP) {
            const partial = `${cached}.${process.pid}.partial`;
            await writeFile(partial, bytes);
            await rename(partial, cached);
        }
    }
    releaseZip = unzipSync(new Uint8Array(bytes));
    return releaseZip;
}

export async function referenceFmuArchive(fmiVersion, name) {
    const archive = (await referenceReleaseZip())[`${fmiVersion}/${name}.fmu`];
    if (!archive) throw new Error(`The Reference FMUs zip has no ${fmiVersion}/${name}.fmu.`);
    return archive;
}

// A host project with one node running the installed FMU: a constant state per input or parameter, holding the case's
// value for it (or 0), and a state per output, set by the FMU.
export function referenceHostDocument({ guid, version, ports, values, stepSize }) {
    const inputStates = ports.inputs.map((port, index) => ({
        id: 100 + index, name: port.name, symbol: `i${index}`, initialValue: values[port.name] ?? 0, unit: ''
    }));
    const outputStates = ports.outputs.map((port, index) => ({ id: 200 + index, name: port.name, symbol: `o${index}`, initialValue: 0, unit: '' }));
    return {
        format: 'konjugate', version: 1, metadata: { projectName: `Reference FMU ${ports.name}` },
        nodes: [{
            id: 1, name: ports.name,
            states: [...inputStates, ...outputStates],
            numerics: { substepsPerGlobalStep: 1 },
            sourceTerms: [],
            implementation: {
                kind: 'fmi', fmuId: guid, fmuVersion: version, providerApiVersion: 1,
                bindings: ports.inputs.map((port, index) => ({ key: port.key, kind: 'state', stateId: inputStates[index].id })),
                outputs: ports.outputs.map((port, index) => ({ key: port.key, stateId: outputStates[index].id }))
            }
        }],
        edges: [],
        runConfigurations: [{ id: 900, globalTimeStep: stepSize, outputInterval: stepSize }],
        activeRunConfigurationId: 900
    };
}

export async function installReferenceFmu(fmiVersion, name, packagesDirectory) {
    const installed = await installFmuArchive(await referenceFmuArchive(fmiVersion, name), { directory: packagesDirectory, version: referenceCases.release, overwrite: true });
    const ports = await describeInstalledFmuPorts(packagesDirectory, installed.guid, installed.version);
    return { installed, ports };
}

export function engineOptionsFor(packagesDirectory) {
    return { applicationPath: join(import.meta.dirname, '..', '..', '..'), resourcesPath: '', packaged: false, fmuDirectory: packagesDirectory, disabledFmuKeys: [] };
}

// Runs one case in Konjugate and compares each output with FMPy's, bit for bit, at every communication point from the
// start: at t = 0 too, where an FMU's outputs are those it has once initialized (FMI review #6). Where FMPy stopped because
// the FMU asked to end the simulation, Konjugate's run goes on with the FMU's outputs held at their last values.
export async function checkReferenceCase(fmiVersion, testCase, packagesDirectory) {
    const { installed, ports } = await installReferenceFmu(fmiVersion, testCase.name, packagesDirectory);
    const expected = fmpyReference.runs.find((run) => run.fmiVersion === fmiVersion && run.name === testCase.name);
    assert.ok(expected, `fmpyReference.json has no ${fmiVersion} ${testCase.name} run.`);
    const document = referenceHostDocument({ guid: installed.guid, version: installed.version, ports, values: testCase.values, stepSize: testCase.stepSize });
    const run = await runWithEngine(JSON.stringify(document),
        { targetTime: testCase.stopTime, globalTimeStep: testCase.stepSize, outputInterval: testCase.stepSize, pacing: { mode: 'fastest' } },
        engineOptionsFor(packagesDirectory));
    if (!run.available) throw new Error(`The ${fmiVersion} ${testCase.name} run was not available.`);
    if (run.error || !run.result) throw new Error(`The ${fmiVersion} ${testCase.name} run failed: ${run.error ?? run.diagnostics ?? 'no result'}`);
    const samples = run.result.samples;
    const steps = Math.round(testCase.stopTime / testCase.stepSize);
    assert.equal(samples.length, steps + 1, `${fmiVersion} ${testCase.name}: Konjugate's run has ${samples.length} samples, not ${steps + 1}.`);
    let compared = 0;
    ports.outputs.forEach((port, outputIndex) => {
        const reference = expected.outputs[port.name];
        assert.ok(reference, `${fmiVersion} ${testCase.name}: FMPy has no output '${port.name}'.`);
        const valueAt = (sample) => sample.states.find((state) => state.stateId === 200 + outputIndex).value;
        for (let index = 0; index < samples.length; index += 1) {
            const fmpyIndex = Math.min(index, reference.length - 1);
            const konjugate = valueAt(samples[index]);
            assert.ok(Object.is(konjugate, reference[fmpyIndex]),
                `${fmiVersion} ${testCase.name}: output '${port.name}' at t = ${samples[index].time} is ${konjugate} in Konjugate but ${reference[fmpyIndex]} in FMPy${index > fmpyIndex ? ' (held since the FMU ended the simulation)' : ''}.`);
            compared += 1;
        }
    });
    return { compared, ports, endedAt: expected.time.length - 1 < steps ? expected.time.at(-1) : null };
}

// Every case for one FMI version; returns a line for the test's summary.
export async function checkReferenceFmus(fmiVersion, packagesDirectory) {
    await mkdir(packagesDirectory, { recursive: true });
    const lines = [];
    for (const testCase of referenceCases.cases) {
        const { compared, ports, endedAt } = await checkReferenceCase(fmiVersion, testCase, packagesDirectory);
        lines.push(`${testCase.name} (${ports.outputs.length} outputs, ${compared} values${endedAt === null ? '' : `, ended by the FMU at t = ${endedAt}`})`);
    }
    return `FMI ${fmiVersion} Reference FMUs ${referenceCases.release} match FMPy ${fmpyReference.fmpy} bit for bit: ${lines.join('; ')}.`;
}
