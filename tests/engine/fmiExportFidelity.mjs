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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { generateFmuPackage } from '../../src/fmiExport.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import {
    absoluteTolerance, closeEnough, communicationStepSize, document, execute,
    globalTimeStep, orderedStateNames, relativeTolerance, runRealEngine, stateIds, stateNameByStateId, targetTime
} from './fixtures/fmuFidelityFixture.mjs';
import { verletDocument } from './fixtures/verletFixture.mjs';

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
        assert.ok(comparisons >= orderedStateNames.length * engineResult.samples.length, `Expected all ${orderedStateNames.length} states compared at every sampled time.`);

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

        // --- 7. A program in the current format (docs/proposals/programSdkV2.md, Export parity): the digital PID example in C++, a node's
        // program with a clock, a random sensor and memory, setting an Update. The FMU gives the engine's numbers, declares rollback, and a
        // run restored from fmi2GetFMUstate mid-run continues to the bit, its memory (the controller's integral, its held command, the
        // sensor's random stream) restored with the states ---
        {
            const root = join(import.meta.dirname, '..', '..');
            const shared = [['setpoint', 293.15, 'K'], ['kp', 50, 'W/K'], ['ki', 5, 'W/(K*s)'], ['kd', 1, 'W*s/K'], ['maxPower', 2000, 'W'], ['sensorNoise', 0.1, 'K']]
                .map(([symbol, value, unit], index) => ({ id: 500 + index, name: symbol, symbol, value, unit, mode: 'constant' }));
            const pidTimeStep = 0.005;
            const pidCommunication = 0.05;
            const pidTarget = 1;
            const pid = {
                format: 'konjugate', version: 1, metadata: { projectName: 'Heated room' }, sharedParameters: shared,
                nodes: [{
                    id: 1, name: 'Heater', updates: 'settle',
                    states: [
                        { id: 11, name: 'Temperature', symbol: 'temperature', initialValue: 285, unit: 'K', kind: 'rate' },
                        { id: 12, name: 'Power', symbol: 'power', initialValue: 0, unit: 'W', kind: 'update' }
                    ],
                    sourceTerms: [{
                        id: 101, state: 'temperature', expression: '(power - 50 (temperature - 280)) / 1000',
                        expressionModel: {
                            latex: '', output: { stateId: 11 },
                            mathJson: ['Divide', ['Add', 'power', ['Negate', ['Multiply', 50, ['Add', 'temperature', -280]]]], 1000],
                            bindings: [{ kind: 'state', nodeId: 1, stateId: 11, symbol: 'temperature' }, { kind: 'state', nodeId: 1, stateId: 12, symbol: 'power' }]
                        }
                    }],
                    implementation: {
                        kind: 'cpp', providerApiVersion: 2, source: await readFile(join(root, 'examples', 'providers', 'pidController.cpp'), 'utf8'),
                        bindings: [{ key: 'measurement', kind: 'state', nodeId: 1, stateId: 11 }, ...shared.map((parameter) => ({ key: parameter.symbol, kind: 'parameter', sharedParameterId: parameter.id }))],
                        outputs: [{ key: 'power', stateId: 12 }]
                    }
                }],
                edges: [],
                runConfigurations: [{ id: 900, globalTimeStep: pidTimeStep, outputInterval: pidCommunication }],
                activeRunConfigurationId: 900
            };
            const modelPath = join(directory, 'pid.kjt');
            const configurationPath = join(directory, 'pidConfiguration.json');
            const resultPath = join(directory, 'pidResult.bin');
            await writeFile(modelPath, await encodeProjectFile(JSON.stringify(pid)));
            await writeFile(configurationPath, JSON.stringify({ name: 'pid', targetTime: pidTarget, globalTimeStep: pidTimeStep, outputInterval: pidCommunication,
                execution: { backend: 'serial' }, providers: { cpp: { sdkPath: join(root, 'engine') } } }));
            const pidRun = await execute(executable, ['run', modelPath, '--configuration', configurationPath, '--output', resultPath]);
            assert.equal(pidRun.code, 0, `The engine must run the PID model: ${pidRun.stderr ?? ''}`);
            const pidEngine = decodeResultFile(await readFile(resultPath));
            const pidFmu = await generateFmuPackage(pid, { modelName: 'pidFidelityFixture', engineOptions: { applicationPath: root, resourcesPath: '', packaged: false } });
            const pidFmuPath = join(directory, 'pid.fmu');
            await writeFile(pidFmuPath, pidFmu);
            assert.match(Buffer.from(unzipSync(pidFmu)['modelDescription.xml']).toString('utf8'), /canGetAndSetFMUstate="true"/,
                'An FMU whose programs are all in the current format declares rollback: their memory is in its state.');
            const pidDriverPath = join(directory, 'drivePid.py');
            await writeFile(pidDriverPath, `
import json, shutil
from fmpy import read_model_description, extract
from fmpy.fmi2 import FMU2Slave

fmu_path = ${JSON.stringify(pidFmuPath)}
md = read_model_description(fmu_path)
vr = {v.name: v.valueReference for v in md.modelVariables}
refs = [vr['Heater.Temperature'], vr['Heater.Power']]
unzipdir = extract(fmu_path)
fmu = FMU2Slave(guid=md.guid, unzipDirectory=unzipdir, modelIdentifier=md.coSimulation.modelIdentifier, instanceName='pid')
fmu.instantiate()
fmu.setupExperiment(startTime=0.0)
fmu.enterInitializationMode()
fmu.exitInitializationMode()
step = ${pidCommunication}
rows = [[0.0] + fmu.getReal(refs)]
time = 0.0
for index in range(${Math.round(pidTarget / pidCommunication)}):
    fmu.doStep(currentCommunicationPoint=time, communicationStepSize=step)
    time = (index + 1) * step
    rows.append([time] + fmu.getReal(refs))
    if index == 7:
        snapshot = fmu.getFMUstate()
        snapshot_time = time
onwards = rows[9:]
fmu.setFMUstate(snapshot)
again = []
time = snapshot_time
for index in range(8, ${Math.round(pidTarget / pidCommunication)}):
    fmu.doStep(currentCommunicationPoint=time, communicationStepSize=step)
    time = (index + 1) * step
    again.append([time] + fmu.getReal(refs))
fmu.freeFMUstate(snapshot)
fmu.terminate()
fmu.freeInstance()
shutil.rmtree(unzipdir, ignore_errors=True)
print(json.dumps({'rows': rows, 'onwards': onwards, 'again': again}))
`, 'utf8');
            const pidSimulation = await execute(python, [pidDriverPath]);
            assert.equal(pidSimulation.code, 0, `FMPy must drive the PID FMU: ${pidSimulation.stderr ?? ''}`);
            const driven = JSON.parse(pidSimulation.stdout.trim().split('\n').at(-1));
            for (const sample of pidEngine.samples) {
                const row = driven.rows.find((candidate) => Math.abs(candidate[0] - sample.time) < 1e-9);
                assert.ok(row, `The PID FMU must report a row at t = ${sample.time}.`);
                sample.states.forEach((state, index) => assert.ok(Math.abs(row[index + 1] - state.value) <= 1e-12 * Math.max(1, Math.abs(state.value)),
                    `The PID FMU must give the engine's numbers: at t = ${sample.time} state ${state.stateId} is ${row[index + 1]}, the engine ${state.value}.`));
                comparisons += sample.states.length;
            }
            assert.ok(driven.rows.at(-1)[2] > 0, 'The heater must be on.');
            assert.deepEqual(driven.again, driven.onwards, 'A PID FMU restored from fmi2GetFMUstate mid-run must continue to the bit.');
            console.log('✓ FMU program in the current format: the PID example matched the engine, and a restore from fmi2GetFMUstate continued to the bit.');
        }

        // --- 8. Verlet, node by node (docs/proposals/integrators.md): an FMU of nodes integrated with Verlet steps as the engine does ---
        const verlet = { ...verletDocument(), runConfigurations: [{ id: 900, globalTimeStep, outputInterval: communicationStepSize }], activeRunConfigurationId: 900 };
        const verletEngine = await runRealEngine(executable, directory, verlet, 'verlet');
        const verletFmuPath = join(directory, 'verlet.fmu');
        await writeFile(verletFmuPath, await generateFmuPackage(verlet, {
            modelName: 'verletFidelityFixture',
            engineOptions: { applicationPath: join(import.meta.dirname, '..', '..'), resourcesPath: '', packaged: false }
        }));
        const verletDriverPath = join(directory, 'driveVerlet.py');
        await writeFile(verletDriverPath, `
import json
from fmpy import simulate_fmu
names = ['Drive.D', 'Mass.V', 'Mass.X', 'Pendulum.Angle', 'Pendulum.Rate']
result = simulate_fmu(${JSON.stringify(verletFmuPath)}, start_time=0.0, stop_time=${targetTime}, output_interval=${communicationStepSize}, output=names)
print(json.dumps([dict(zip(result.dtype.names, [float(v) for v in row])) for row in result]))
`, 'utf8');
        const verletSimulation = await execute(python, [verletDriverPath]);
        assert.equal(verletSimulation.code, 0, 'FMPy must simulate the Verlet FMU successfully.');
        const verletRows = JSON.parse(verletSimulation.stdout.trim().split('\n').at(-1));
        const verletNames = { 11: 'Drive.D', 21: 'Mass.V', 22: 'Mass.X', 31: 'Pendulum.Angle', 32: 'Pendulum.Rate' };
        let largestVerletDifference = 0;
        for (const sample of verletEngine.samples) {
            const row = verletRows.find((candidate) => Math.abs(candidate.time - sample.time) < 1e-6);
            assert.ok(row, `FMPy did not report a Verlet row at t=${sample.time}.`);
            for (const { stateId, value } of sample.states) {
                largestVerletDifference = Math.max(largestVerletDifference, Math.abs(row[verletNames[stateId]] - value) / Math.max(1, Math.abs(value)));
                comparisons += 1;
            }
        }
        assert.ok(largestVerletDifference < 1e-12, `The Verlet FMU should give the engine's numbers, differed by ${largestVerletDifference}.`);
        console.log(`✓ FMU Verlet: FMPy's simulation matched the real engine, largest relative difference ${largestVerletDifference.toExponential(2)}.`);

        // --- 8. Stiff (docs/proposals/integrators.md): an FMU under Rodas4 and under BDF takes each global step inside fmi2DoStep as the
        // engine takes it -- the same stages, exact Jacobian, error control and Updates -- with the live parameter set by the host ---
        for (const run of [{ method: 'rodas4', tolerance: { relative: 1e-8, absolute: 1e-10 } }, { method: 'bdf', tolerance: { relative: 1e-8, absolute: 1e-10 } }]) {
            const stiffDocument = { ...document, runConfigurations: [{ id: 900, globalTimeStep, outputInterval: communicationStepSize, ...run }], activeRunConfigurationId: 900 };
            const stiffEngine = await runRealEngine(executable, directory, document, run.method, run);
            assert.equal(stiffEngine.integration?.method, run.method, `The engine must run the fixture under ${run.method}.`);
            const stiffFmuBuffer = await generateFmuPackage(stiffDocument, {
                modelName: `${run.method}FidelityFixture`,
                engineOptions: { applicationPath: join(import.meta.dirname, '..', '..'), resourcesPath: '', packaged: false }
            });
            const stiffXml = Buffer.from(unzipSync(stiffFmuBuffer)['modelDescription.xml']).toString('utf8');
            assert.match(stiffXml, /canGetAndSetFMUstate="false"/, 'Under Stiff the solver\'s memory is not captured, so rollback is not declared.');
            const stiffFmuPath = join(directory, `${run.method}.fmu`);
            await writeFile(stiffFmuPath, stiffFmuBuffer);
            const stiffDriverPath = join(directory, `drive${run.method}.py`);
            await writeFile(stiffDriverPath, `
import json
from fmpy import simulate_fmu, read_model_description
md = read_model_description(${JSON.stringify(stiffFmuPath)})
names = [v.name for v in md.modelVariables]
result = simulate_fmu(${JSON.stringify(stiffFmuPath)}, start_time=0.0, stop_time=${targetTime}, output_interval=${communicationStepSize},
    start_values={'k': 0.2}, output=[n for n in names if n != 'k'])
print(json.dumps([dict(zip(result.dtype.names, [float(v) for v in row])) for row in result]))
`, 'utf8');
            const stiffSimulation = await execute(python, [stiffDriverPath]);
            assert.equal(stiffSimulation.code, 0, `FMPy must simulate the ${run.method} FMU successfully: ${stiffSimulation.stderr ?? ''}`);
            const stiffRows = JSON.parse(stiffSimulation.stdout.trim().split('\n').at(-1));
            let largest = 0;
            for (const sample of stiffEngine.samples) {
                const row = stiffRows.find((candidate) => Math.abs(candidate.time - sample.time) < 1e-6);
                assert.ok(row, `FMPy did not report a ${run.method} row at t=${sample.time}.`);
                for (const { stateId, value } of sample.states) {
                    const fmuValue = row[stateNameByStateId[stateId]];
                    largest = Math.max(largest, Math.abs(fmuValue - value) / Math.max(1, Math.abs(value)));
                    comparisons += 1;
                }
            }
            assert.ok(largest < 1e-9, `The ${run.method} FMU should give the engine's numbers, differed by ${largest}.`);
            console.log(`✓ FMU ${run.method}: FMPy's simulation matched the real engine, largest relative difference ${largest.toExponential(2)}.`);
        }

        console.log(`✓ FMU export fidelity: FMPy's simulation of the real .fmu matched the real engine across ${comparisons} state/time comparisons.`);
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
