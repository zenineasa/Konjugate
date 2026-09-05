/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Confirms src/fmiExport.mjs/fmiCodeGen.mjs's compiled FMU is not just internally consistent
// (tests/fmiCodeGen.test.mjs, structural assertions only) but a real, standard-compliant artifact
// that numerically matches the REAL Konjugate engine -- the actual claim the feature makes. Unlike
// codeExportFidelity.mjs's plain export, this fixture includes a live parameter driven via
// fmi2SetReal mid-run, since that is the one place FMU export's fidelity story genuinely differs
// from the plain export (a standalone program has no runtime control stream to receive a live
// value from; an FMI host's repeated SetReal/DoStep calls are exactly that). Also exercises
// rollback (fmi2Get/SetFMUstate, via FMPy's low-level FMU2Slave API, since this fixture has no
// provider and so genuinely supports it) and confirms a *constant* parameter is really tunable --
// not just declared -- by re-running the real engine with a different value for it and confirming
// the FMU matches that second run once the same value is set via fmi2SetReal.
//
// Needs a C++ compiler (to build the FMU, same as codeExportFidelity.mjs) and FMPy
// (`pip install fmpy`, PYTHON env var to select the interpreter) -- a genuine, independent,
// standard-compliant FMI simulator, not just this project's own driver, so this also confirms the
// .fmu is actually loadable by real FMI tooling, not merely self-consistent. Skips (not a failure)
// when FMPy isn't importable, so this is a separate, explicitly-invoked script rather than part of
// the npm run test:engine chain. tests/engine/fmiRoundTrip.mjs covers the same fixture with a
// dependency-free (no FMPy) dlopen-based check instead -- see that file for why both exist.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { generateFmuPackage } from '../../src/fmiExport.mjs';
import {
    absoluteTolerance, closeEnough, communicationStepSize, document, execute,
    globalTimeStep, relativeTolerance, runRealEngine, stateIds, stateNameByStateId, targetTime
} from './fixtures/fmuFidelityFixture.mjs';

const executable = process.argv[2] ?? join(import.meta.dirname, '..', '..', 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const python = process.env.PYTHON || 'python3';

const directory = await mkdtemp(join(tmpdir(), 'konjugateFmuFidelity-'));
try {
    if ((await execute(python, ['-c', 'import fmpy'])).code !== 0) {
        console.log('  (skipping FMU fidelity check: fmpy not importable -- pip install fmpy)');
    } else {
        // --- 1. run the real engine, with the same live-parameter override an FMI host would apply ---
        const engineResult = await runRealEngine(executable, directory, document, 'fixture');

        // --- 2. build the real FMU ---
        const documentWithRunConfig = { ...document, runConfigurations: [{ id: 900, globalTimeStep, outputInterval: communicationStepSize }], activeRunConfigurationId: 900 };
        const fmuBuffer = await generateFmuPackage(documentWithRunConfig, {
            modelName: 'fmuFidelityFixture',
            engineOptions: { applicationPath: join(import.meta.dirname, '..', '..'), resourcesPath: '', packaged: false }
        });
        const fmuPath = join(directory, 'fixture.fmu');
        await writeFile(fmuPath, fmuBuffer);

        // This fixture has no provider, so it must declare (and actually support) rollback.
        const xml = Buffer.from(unzipSync(fmuBuffer)['modelDescription.xml']).toString('utf8');
        assert.match(xml, /canGetAndSetFMUstate="true"/, 'A providerless FMU should declare rollback support.');
        // The XML variable name is the parameter's own symbol ("c"), not its display name.
        assert.match(xml, /name="c"[^>]*causality="parameter"[^>]*variability="tunable"/,
            'The constant "coupling" parameter should be exposed as a tunable FMI parameter.');

        // --- 3. simulate the FMU with FMPy (an independent, standard-compliant FMI simulator) ---
        const driverPath = join(directory, 'driveFmu.py');
        await writeFile(driverPath, `
import json
from fmpy import simulate_fmu, read_model_description

md = read_model_description(${JSON.stringify(fmuPath)})
names = [v.name for v in md.modelVariables]
result = simulate_fmu(${JSON.stringify(fmuPath)}, start_time=0.0, stop_time=${targetTime},
    output_interval=${communicationStepSize}, start_values={'k': 0.2},
    output=[n for n in names if n != 'k'])
rows = [dict(zip(result.dtype.names, [float(v) for v in row])) for row in result]
print(json.dumps(rows))
`, 'utf8');
        const simulation = await execute(python, [driverPath]);
        assert.equal(simulation.code, 0, 'FMPy must simulate the exported FMU successfully.');
        const rows = JSON.parse(simulation.stdout.trim().split('\n').at(-1));

        // --- 4. compare FMPy's simulation against the real engine at every sampled time ---
        let comparisons = 0;
        for (const engineSample of engineResult.samples) {
            const row = rows.find((candidate) => Math.abs(candidate.time - engineSample.time) < 1e-6);
            assert.ok(row, `FMPy did not report a row at t=${engineSample.time}.`);
            for (const state of engineSample.states) {
                const name = stateNameByStateId[state.stateId];
                const fmuValue = row[name];
                assert.ok(Number.isFinite(fmuValue), `FMU did not report a finite value for ${name} at t=${engineSample.time}.`);
                assert.ok(closeEnough(fmuValue, state.value, absoluteTolerance, relativeTolerance),
                    `FMU diverges from the real engine for ${name} at t=${engineSample.time}: engine=${state.value}, fmu=${fmuValue}.`);
                comparisons += 1;
            }
        }
        assert.ok(comparisons >= 4 * (engineResult.samples.length), 'Expected all 4 states compared at every sampled time.');

        // --- 5. rollback: capture state mid-run, step further, roll back, confirm an exact match ---
        // via FMPy's low-level FMU2Slave API (the high-level simulate_fmu wrapper has no get/set
        // FMU state support), a real, independent implementation of fmi2Get/SetFMUstate -- not
        // just this project's own dlopen-based driver (see fmiRoundTrip.mjs).
        const rollbackDriverPath = join(directory, 'driveRollback.py');
        await writeFile(rollbackDriverPath, `
import json, shutil
from fmpy import read_model_description, extract
from fmpy.fmi2 import FMU2Slave

fmu_path = ${JSON.stringify(fmuPath)}
md = read_model_description(fmu_path)
vr_by_name = {v.name: v.valueReference for v in md.modelVariables}
unzipdir = extract(fmu_path)
fmu = FMU2Slave(guid=md.guid, unzipDirectory=unzipdir, modelIdentifier=md.coSimulation.modelIdentifier, instanceName='rollback')
fmu.instantiate()
fmu.setupExperiment(startTime=0.0)
fmu.enterInitializationMode()
fmu.exitInitializationMode()
fmu.setReal([vr_by_name['k']], [0.2])  # matches the baseline run above

# Looked up by name rather than hardcoded, so this can't silently drift from whatever order
# assignValueReferences() (src/fmiCodeGen.mjs) actually assigns.
value_references = [vr_by_name[name] for name in ('Source.Level', 'Squarer.Value', 'Adder.Value', 'Coupled.Value')]
step = ${communicationStepSize}
for _ in range(3): fmu.doStep(currentCommunicationPoint=0, communicationStepSize=step)
captured = fmu.getReal(value_references)
snapshot = fmu.getFMUstate()
fmu.doStep(currentCommunicationPoint=0, communicationStepSize=step)
moved = fmu.getReal(value_references)
fmu.setFMUstate(snapshot)
restored = fmu.getReal(value_references)
fmu.freeFMUstate(snapshot)
fmu.terminate()
fmu.freeInstance()
shutil.rmtree(unzipdir, ignore_errors=True)
print(json.dumps({'captured': captured, 'moved': moved, 'restored': restored}))
`, 'utf8');
        const rollbackRun = await execute(python, [rollbackDriverPath]);
        assert.equal(rollbackRun.code, 0, "FMPy's low-level rollback driver must run successfully.");
        const rollback = JSON.parse(rollbackRun.stdout.trim().split('\n').at(-1));
        assert.notDeepEqual(rollback.moved, rollback.captured, 'Sanity check: state should have moved further before rollback.');
        for (let index = 0; index < rollback.captured.length; index += 1) {
            assert.ok(closeEnough(rollback.restored[index], rollback.captured[index], absoluteTolerance, relativeTolerance),
                `Rollback did not restore state index ${index} exactly: captured=${rollback.captured[index]}, restored=${rollback.restored[index]}.`);
        }
        console.log('✓ FMU rollback: fmi2Get/SetFMUstate round-tripped correctly via FMPy\'s independent FMI2Slave.');

        // --- 6. a *constant* parameter is genuinely tunable, not just declared: re-run the real
        // engine with a different "coupling" value, then confirm the FMU matches that second run
        // once the same value is set via fmi2SetReal (not the value baked in at export time) ---
        const tunedCoupling = 0.35; // export baked 0.15 (see paramIds.coupling above)
        const tunedDocument = structuredClone(document);
        tunedDocument.edges.find((edge) => edge.id === 202).parameters[0].value = tunedCoupling;
        const tunedEngineResult = await runRealEngine(executable, directory, tunedDocument, 'tuned');
        const tunedFinal = tunedEngineResult.samples.at(-1).states.find((state) => state.stateId === stateIds.coupled).value;

        const tunedDriverPath = join(directory, 'driveTuned.py');
        await writeFile(tunedDriverPath, `
from fmpy import simulate_fmu
result = simulate_fmu(${JSON.stringify(fmuPath)}, start_time=0.0, stop_time=${targetTime},
    output_interval=${communicationStepSize}, start_values={'k': 0.2, 'c': ${tunedCoupling}},
    output=['Coupled.Value'])
print(float(result[-1]['Coupled.Value']))
`, 'utf8');
        const tunedRun = await execute(python, [tunedDriverPath]);
        assert.equal(tunedRun.code, 0, 'FMPy must simulate the FMU with the tuned parameter successfully.');
        const tunedFmuFinal = Number(tunedRun.stdout.trim().split('\n').at(-1));
        assert.ok(closeEnough(tunedFmuFinal, tunedFinal, absoluteTolerance, relativeTolerance),
            `Setting the "coupling" parameter via fmi2SetReal should reproduce the real engine's run with that same value: engine=${tunedFinal}, fmu=${tunedFmuFinal}.`);
        console.log('✓ FMU tunable parameter: setting "coupling" via fmi2SetReal matched a real engine run using that same value, not the value baked in at export time.');

        console.log(`✓ FMU export fidelity: FMPy's simulation of the real .fmu matched the real engine across ${comparisons} state/time comparisons.`);
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
