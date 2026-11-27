/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Imports the FMI Reference FMUs (github.com/modelica/Reference-FMUs, BSD-2-Clause) into Konjugate and compares every
// output, at every communication point, with what FMPy computes for the same FMU binary (fmpyReferenceRuns below, from the
// cases in referenceFmus/cases.json). Shared by tests/engine/fmiImportFidelity.mjs (FMI 2.0), fmi3ImportFidelity.mjs (FMI 3.0)
// and fmiStartValues.mjs.
//
// FMPy's runs are of the binary this computer runs, so they are made here, by referenceFmus/fmpyReference.py, except on
// Apple Silicon, where the committed referenceFmus/fmpyReference.json is FMPy's run of the very aarch64-darwin binaries this
// computer runs (and needs no FMPy). The release's binaries differ in their arithmetic: its macOS arm64 binaries were compiled
// with fused multiply-add (Apple clang contracts BouncingBall's Euler step x += dt * dx into one fmadd), its Linux and Windows
// binaries without, so BouncingBall's h differs in its last bits between them (0.9826363000000012 against 0.9826363000000014 at
// t = 0.06) in FMPy as in Konjugate. Where the release has no binary for this computer (Intel macOS: release 0.0.42 has none
// for x86_64-darwin), each FMU is built here from its sources and FMPy runs that same build.
//
// KONJUGATE_FMPY_REFERENCE=here makes FMPy's runs here on Apple Silicon too; KONJUGATE_REFERENCE_FMUS_FROM_SOURCES=1 installs the
// FMUs with their binaries taken out, so they are built here and FMPy runs those builds, as on an Intel Mac.
//
// The release zip is not in the repository: it is downloaded once, checked against its SHA-256, and kept in the
// system's temporary directory (or read from KONJUGATE_REFERENCE_FMUS_ZIP, a path to the same zip, for a machine
// without network access).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { installFmuArchive } from '../../../src/fmuPackage.mjs';
import { describeInstalledFmuPorts } from '../../../src/fmiResolver.mjs';
import { runWithEngine } from '../../../src/engineAdapter.mjs';
import { buildInstalledFmu } from '../../../src/fmuBuilds.mjs';
import { findCCompiler } from '../../../src/fmuSourceBuild.mjs';

const root = join(import.meta.dirname, '..', '..', '..');
const here = join(import.meta.dirname, 'referenceFmus');
export const referenceCases = JSON.parse(await readFile(join(here, 'cases.json'), 'utf8'));
const fromSources = process.env.KONJUGATE_REFERENCE_FMUS_FROM_SOURCES === '1';
const committedReference = process.platform === 'darwin' && process.arch === 'arm64' && process.env.KONJUGATE_FMPY_REFERENCE !== 'here' && !fromSources;

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

// The library each FMU built here from its sources runs, by `${fmiVersion}/${name}`, for FMPy to run the same build.
const builtHere = new Map();
let compiler;

// Installs one Reference FMU; one with no binary for this computer is built here from its sources (as Konjugate asks to on a run).
export async function installReferenceFmu(fmiVersion, name, packagesDirectory) {
    let archive = await referenceFmuArchive(fmiVersion, name);
    if (fromSources) archive = zipSync(Object.fromEntries(Object.entries(unzipSync(archive)).filter(([entry]) => !entry.startsWith('binaries/'))));
    const installed = await installFmuArchive(Buffer.from(archive), { directory: packagesDirectory, version: referenceCases.release, overwrite: true });
    let ports = await describeInstalledFmuPorts(packagesDirectory, installed.guid, installed.version);
    if (!ports.about.hasOwnBinary) {
        compiler ??= await findCCompiler();
        if (compiler.message) throw new Error(`The Reference FMU ${fmiVersion}/${name} has no binary for this computer and cannot be built here: ${compiler.message}`);
        const outcome = await buildInstalledFmu({
            fmuDirectory: packagesDirectory, guid: installed.guid, version: installed.version, compiler, sdkPath: join(root, 'engine'),
            engine: join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine')
        });
        if (!['built', 'cached'].includes(outcome.status)) throw new Error(`Building the Reference FMU ${fmiVersion}/${name} here failed: ${outcome.message ?? outcome.status}\n${outcome.log ?? ''}`);
        builtHere.set(`${fmiVersion}/${name}`, outcome.libraryPath);
        ports = await describeInstalledFmuPorts(packagesDirectory, installed.guid, installed.version);
    }
    return { installed, ports };
}

// FMPy's run of every case, of both FMI versions, on the binaries this computer runs: { fmpy, release, runs, madeHere }.
let fmpyReference;
export async function fmpyReferenceRuns(packagesDirectory) {
    if (fmpyReference) return fmpyReference;
    if (committedReference) {
        fmpyReference = { ...JSON.parse(await readFile(join(here, 'fmpyReference.json'), 'utf8')), madeHere: false };
        return fmpyReference;
    }
    const directory = await mkdtemp(join(tmpdir(), 'konjugateFmpyReference-'));
    try {
        const zip = await referenceReleaseZip();
        for (const fmiVersion of ['2.0', '3.0']) {
            await mkdir(join(directory, fmiVersion));
            for (const testCase of referenceCases.cases) {
                await installReferenceFmu(fmiVersion, testCase.name, packagesDirectory);
                await writeFile(join(directory, fmiVersion, `${testCase.name}.fmu`), zip[`${fmiVersion}/${testCase.name}.fmu`]);
            }
        }
        const builds = join(directory, 'builtHere.json');
        await writeFile(builds, JSON.stringify(Object.fromEntries(builtHere)));
        const output = join(directory, 'fmpyReference.json');
        const python = process.env.PYTHON || 'python3';
        const run = spawnSync(python, ['-E', join(here, 'fmpyReference.py'), directory, output, builds], { encoding: 'utf8' });
        if (run.status !== 0) {
            throw new Error(`FMPy's run of the Reference FMUs on this computer (${python} ${join(here, 'fmpyReference.py')}) failed: ${run.error?.message ?? run.stderr}`);
        }
        fmpyReference = { ...JSON.parse(await readFile(output, 'utf8')), madeHere: true };
        return fmpyReference;
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// Which binaries FMPy's runs are of, for a summary line.
export function fmpyReferenceSource(reference) {
    if (!reference.madeHere) return `FMPy ${reference.fmpy} (committed run of the release's aarch64-darwin binaries)`;
    return `FMPy ${reference.fmpy} (run here on ${builtHere.size ? 'the builds of their sources made here' : 'the release\'s binaries for this computer'})`;
}

export function engineOptionsFor(packagesDirectory) {
    return { applicationPath: join(import.meta.dirname, '..', '..', '..'), resourcesPath: '', packaged: false, fmuDirectory: packagesDirectory, disabledFmuKeys: [] };
}

// Runs one case in Konjugate and compares each output with FMPy's run of the same binary, bit for bit, at every communication point from the
// start: at t = 0 too, where an FMU's outputs are those it has once initialized (FMI review #6). Where FMPy stopped because
// the FMU asked to end the simulation, Konjugate's run goes on with the FMU's outputs held at their last values.
export async function checkReferenceCase(fmiVersion, testCase, packagesDirectory) {
    const reference = await fmpyReferenceRuns(packagesDirectory);
    const { installed, ports } = await installReferenceFmu(fmiVersion, testCase.name, packagesDirectory);
    const expected = reference.runs.find((run) => run.fmiVersion === fmiVersion && run.name === testCase.name);
    assert.ok(expected, `FMPy's reference has no ${fmiVersion} ${testCase.name} run.`);
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
    return `FMI ${fmiVersion} Reference FMUs ${referenceCases.release} match ${fmpyReferenceSource(await fmpyReferenceRuns(packagesDirectory))} bit for bit: ${lines.join('; ')}.`;
}
