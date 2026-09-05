/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A narrow, dependency-free companion to fmiExportFidelity.mjs: confirms the same FMU export is
// correct WITHOUT needing FMPy (`pip install fmpy`) or any third-party FMI tool at all. Builds the
// real FMU, extracts its own compiled shared library, and drives it through the real FMI 2.0 C API
// via the engine's new `runFmu` command (engine/src/fmiRoundTrip.cpp -- dlopen()/LoadLibrary(),
// mirroring providerRuntime.cpp's InProcessProviderBackend), comparing the result against the real
// engine's own run of the same model. Also exercises fmi2Get/SetFMUstate (rollback) entirely on
// the engine side via `runFmu --verify-rollback`.
//
// This is deliberately NOT a general FMI import feature -- it only ever loads a shared library
// Konjugate's own exporter just built, using a state count Konjugate itself already knows, not an
// arbitrary vendor FMU. It also can't catch a spec misunderstanding shared between our own
// exporter and this same dlopen-based driver (an independent implementation, like FMPy, is what
// would catch that) -- fmiExportFidelity.mjs stays the periodic "real" cross-check; this one is
// the fast, always-available check that needs nothing beyond a C++ compiler (the same requirement
// building the FMU itself already has), so it can run every time.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { generateFmuPackage } from '../../src/fmiExport.mjs';
import {
    absoluteTolerance, closeEnough, communicationStepSize, document, execute,
    globalTimeStep, orderedStateNames, relativeTolerance, runRealEngine, stateNameByStateId, targetTime
} from './fixtures/fmuFidelityFixture.mjs';

function libraryExtension() {
    if (process.platform === 'win32') return '.dll';
    if (process.platform === 'darwin') return '.dylib';
    return '.so';
}

function parseCsv(text) {
    return text.trim().split('\n').map((line) => line.split(',').map(Number));
}

const executable = process.argv[2] ?? join(import.meta.dirname, '..', '..', 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');

const directory = await mkdtemp(join(tmpdir(), 'konjugateFmuRoundTrip-'));
try {
    // --- 1. run the real engine, with the same live-parameter value the FMU bakes as its default ---
    const engineResult = await runRealEngine(executable, directory, document, 'fixture');

    // --- 2. build the real FMU ---
    const documentWithRunConfig = { ...document, runConfigurations: [{ id: 900, globalTimeStep, outputInterval: communicationStepSize }], activeRunConfigurationId: 900 };
    const fmuBuffer = await generateFmuPackage(documentWithRunConfig, {
        modelName: 'fmuRoundTripFixture',
        engineOptions: { applicationPath: join(import.meta.dirname, '..', '..'), resourcesPath: '', packaged: false }
    });

    // --- 3. extract just the compiled shared library -- no XML parsing needed on either side,
    // since the round trip only needs the binary and a known state count. ---
    const entries = unzipSync(fmuBuffer);
    const binaryEntryName = Object.keys(entries).find((name) => name.startsWith('binaries/') && name.endsWith(libraryExtension()));
    assert.ok(binaryEntryName, `The .fmu is missing a binaries/<platform>/*${libraryExtension()} shared library for this platform.`);
    const libraryPath = join(directory, `fixture${libraryExtension()}`);
    await writeFile(libraryPath, entries[binaryEntryName]);

    // --- 4. drive it via the engine's dlopen-based runFmu command ---
    const runConfigurationPath = join(directory, 'runFmuConfiguration.json');
    const roundTripCsvPath = join(directory, 'roundtrip.csv');
    await writeFile(runConfigurationPath, JSON.stringify({ targetTime, globalTimeStep, outputInterval: communicationStepSize }));
    const runFmuResult = await execute(executable, [
        'runFmu', libraryPath,
        '--state-count', String(orderedStateNames.length),
        '--configuration', runConfigurationPath,
        '--output', roundTripCsvPath,
        '--verify-rollback'
    ]);
    assert.equal(runFmuResult.code, 0, 'runFmu must drive the exported FMU successfully (including its rollback self-check).');
    const rows = parseCsv(await readFile(roundTripCsvPath, 'utf8'));

    // --- 5. compare against the real engine at every sampled time, positionally: state value
    // references are always 0..stateCount-1 in document.nodes flattened order (assignValueReferences
    // in src/fmiCodeGen.mjs), the same convention codeExportFidelity.mjs already relies on. ---
    let comparisons = 0;
    for (const engineSample of engineResult.samples) {
        const row = rows.find((candidate) => Math.abs(candidate[0] - engineSample.time) < 1e-6);
        assert.ok(row, `runFmu did not emit a row at t=${engineSample.time}.`);
        for (const state of engineSample.states) {
            const name = stateNameByStateId[state.stateId];
            const index = orderedStateNames.indexOf(name);
            const fmuValue = row[index + 1];
            assert.ok(Number.isFinite(fmuValue), `runFmu did not report a finite value for ${name} at t=${engineSample.time}.`);
            assert.ok(closeEnough(fmuValue, state.value, absoluteTolerance, relativeTolerance),
                `runFmu diverges from the real engine for ${name} at t=${engineSample.time}: engine=${state.value}, fmu=${fmuValue}.`);
            comparisons += 1;
        }
    }
    assert.ok(comparisons >= 4 * engineResult.samples.length, 'Expected all 4 states compared at every sampled time.');
    console.log(`✓ FMU round trip (no third-party FMI tool): runFmu matched the real engine across ${comparisons} state/time comparisons, rollback self-check passed.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
