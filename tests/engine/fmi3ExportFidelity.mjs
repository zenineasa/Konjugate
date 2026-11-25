/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The FMI 3.0 Co-Simulation export (src/fmiExport.mjs, engine/src/fmi3Glue.cpp) checked with FMPy, an independent FMI simulator, as
// tests/engine/fmiExportFidelity.mjs checks the FMI 2.0 one. For a set of models -- a thermal network with tunable parameters
// (ThermalEquilibrium), an oscillator (SpringMassDamper), a program in the current format (HeatedRoom's PID), the FMU fidelity fixture
// (a live input, a tunable constant, stored schedules, a bidirectional edge, several substeps) and that fixture under Stiff (Rodas4,
// Rodas5P, BDF) -- each FMI 3.0 FMU is:
//
//   - validated by FMPy (fmpy.validation.validate_fmu: the FMI 3.0 XML schema and FMPy's own rules), with no problem found;
//   - simulated by FMPy and compared, every output at every communication point, with the FMI 2.0 export of the same model simulated
//     the same way: equal bit for bit (the model is the same compiled code; only the FMI layer differs);
//   - compared with the Konjugate engine's own run of the model: bit for bit for the example models, as tests/engine/fmiExamples.mjs
//     finds for the FMI 2.0 example FMUs; the fixture to its last bits (below); under Stiff to the same tolerance as the FMI 2.0 check
//     (the FMU's step times are summed as the host steps);
//   - where it offers an FMU state (all but Stiff), driven through FMPy's FMU3Slave: a state taken mid-run, serialized and
//     deserialized, gives back the outputs and "time" exactly, and the run continued from it repeats the original to the bit;
//   - for a tunable parameter, set through fmi3SetFloat64 and compared with the engine's run of the project with that value.
//
// FMPy (pip install fmpy; PYTHON names the interpreter) supports FMI 3.0. Skipped, not failed, when FMPy is not importable, like the FMI
// 2.0 check; scripts/runReleaseChecks.mjs --require fmpy makes that a failure on release runners.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { generateFmuPackage } from '../../src/fmiExport.mjs';
import { parseModelDescription } from '../../src/fmiModelDescription.mjs';
import { engineReference, exportDocument, fmiExamples } from '../../scripts/fmiExamples.mjs';
import {
    communicationStepSize, document as fixtureDocument, execute, globalTimeStep, runRealEngine, stateNameByStateId, targetTime
} from './fixtures/fmuFidelityFixture.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const python = process.env.PYTHON || 'python3';
const engineOptions = { applicationPath: root, resourcesPath: '', packaged: false };

// One driver for every FMPy call, its request as JSON in argv[1], its answer as JSON on the last line of stdout. Floats go through
// Python's repr, which round-trips, so the numbers compared here are FMPy's own bits.
const driver = `
import json, shutil, sys
from fmpy import extract, read_model_description, simulate_fmu
from fmpy.validation import validate_fmu
request = json.loads(sys.argv[1])
path = request['path']
if request['mode'] == 'version':
    import fmpy
    print(json.dumps(fmpy.__version__))
elif request['mode'] == 'validate':
    print(json.dumps([str(problem) for problem in validate_fmu(path)]))
elif request['mode'] == 'simulate':
    result = simulate_fmu(path, start_time=0.0, stop_time=request['stop'], output_interval=request['step'],
        start_values=request.get('startValues', {}), output=request['outputs'])
    print(json.dumps([[float(value) for value in row] for row in result]))
elif request['mode'] == 'state':
    from fmpy.fmi3 import FMU3Slave
    md = read_model_description(path)
    vr = {v.name: v.valueReference for v in md.modelVariables}
    refs = [vr[name] for name in request['outputs']] + [vr['time']]
    unzipdir = extract(path)
    fmu = FMU3Slave(guid=md.guid, unzipDirectory=unzipdir, modelIdentifier=md.coSimulation.modelIdentifier, instanceName='state')
    fmu.instantiate()
    fmu.enterInitializationMode(startTime=0.0)
    for name, value in request.get('startValues', {}).items():
        fmu.setFloat64([vr[name]], [value])
    fmu.exitInitializationMode()
    step, count, at = request['step'], request['count'], request['at']
    rows, time = [], 0.0
    for index in range(count):
        fmu.doStep(currentCommunicationPoint=time, communicationStepSize=step)
        time = (index + 1) * step
        rows.append(fmu.getFloat64(refs))
        if index == at:
            serialized = bytes(fmu.serializeFMUState(fmu.getFMUState()))
            taken = list(rows[-1])
    fmu.setFMUState(fmu.deserializeFMUState(serialized))
    restored = fmu.getFloat64(refs)
    again, time = [], (at + 1) * step
    for index in range(at + 1, count):
        fmu.doStep(currentCommunicationPoint=time, communicationStepSize=step)
        time = (index + 1) * step
        again.append(fmu.getFloat64(refs))
    fmu.terminate()
    fmu.freeInstance()
    shutil.rmtree(unzipdir, ignore_errors=True)
    print(json.dumps({'taken': taken, 'restored': restored, 'onwards': rows[at + 1:], 'again': again, 'bytes': len(serialized)}))
elif request['mode'] == 'badStep':
    from fmpy.fmi3 import FMU3Slave
    md = read_model_description(path)
    unzipdir = extract(path)
    messages = []
    def logger(environment, status, category, message):
        messages.append(message.decode())
    fmu = FMU3Slave(guid=md.guid, unzipDirectory=unzipdir, modelIdentifier=md.coSimulation.modelIdentifier, instanceName='bad')
    fmu.instantiate(logMessage=logger)
    fmu.enterInitializationMode(startTime=0.0)
    fmu.exitInitializationMode()
    try:
        fmu.doStep(currentCommunicationPoint=0.0, communicationStepSize=request['step'])
        refused = False
    except Exception:
        refused = True
    fmu.freeInstance()
    shutil.rmtree(unzipdir, ignore_errors=True)
    print(json.dumps({'refused': refused, 'messages': messages}))
`;

let driverPath;
async function fmpy(request) {
    const run = await execute(python, [driverPath, JSON.stringify(request)]);
    assert.equal(run.code, 0, `FMPy (${request.mode}) failed on ${request.path}: ${run.stderr}`);
    return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

// Both exports of one model, written to the work directory: { fmi2, fmi3 } paths and the FMI 3.0 model description, parsed.
async function exportBoth(directory, document, modelName) {
    const paths = {};
    for (const fmiVersion of ['2.0', '3.0']) {
        const bytes = await generateFmuPackage(document, { modelName, engineOptions, fmiVersion });
        const path = join(directory, `${modelName}-${fmiVersion}.fmu`);
        await writeFile(path, bytes);
        paths[fmiVersion] = path;
        if (fmiVersion === '3.0') paths.description = parseModelDescription(Buffer.from(unzipSync(bytes)['modelDescription.xml']).toString('utf8'));
    }
    return paths;
}

const bitwiseEqual = (a, b) => a.length === b.length && a.every((row, index) => row.length === b[index].length && row.every((value, column) => Object.is(value, b[index][column])));
const relativeDifference = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));

// Validates the FMI 3.0 FMU, simulates both exports and checks they are equal bit for bit. Returns the FMI 3.0 rows ([time, ...outputs]).
async function checkAgainstFmi2(label, paths, { stop, step, outputs, startValues = {} }) {
    const problems = await fmpy({ mode: 'validate', path: paths['3.0'] });
    assert.deepEqual(problems, [], `FMPy finds problems in the FMI 3.0 ${label}: ${problems.join('; ')}`);
    const request = { mode: 'simulate', stop, step, outputs, startValues };
    const fmi3Rows = await fmpy({ ...request, path: paths['3.0'] });
    const fmi2Rows = await fmpy({ ...request, path: paths['2.0'] });
    assert.equal(fmi3Rows.length, Math.round(stop / step) + 1, `FMPy gave ${fmi3Rows.length} rows for the FMI 3.0 ${label}.`);
    assert.ok(bitwiseEqual(fmi3Rows, fmi2Rows), `The FMI 3.0 ${label} must give the FMI 2.0 export's numbers bit for bit.`);
    return fmi3Rows;
}

// A state taken mid-run, serialized and deserialized, gives back the outputs and time exactly, and the run from it repeats the original.
async function checkState(label, path, { step, count, outputs, startValues = {} }) {
    const at = Math.floor(count / 2);
    const state = await fmpy({ mode: 'state', path, step, count, at, outputs, startValues });
    assert.deepEqual(state.restored, state.taken, `The FMI 3.0 ${label} restored from a serialized state must give back its outputs and time exactly.`);
    assert.ok(Math.abs(state.taken.at(-1) - (at + 1) * step) < 1e-9, `"time" must read the time the state was taken at, not ${state.taken.at(-1)}.`);
    assert.notDeepEqual(state.onwards[0], state.taken, 'Sanity check: the run moved on after the state was taken.');
    assert.deepEqual(state.again, state.onwards, `The FMI 3.0 ${label} continued from a restored state must repeat the original run to the bit.`);
    return state.bytes;
}

function parametersWithSymbol(document, symbol) {
    const found = [];
    const visit = (value) => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') {
            if (value.symbol === symbol && 'value' in value && 'mode' in value) found.push(value);
            Object.values(value).forEach(visit);
        }
    };
    visit(document);
    return found;
}

const directory = await mkdtemp(join(tmpdir(), 'konjugateFmi3ExportFidelity-'));
try {
    driverPath = join(directory, 'driveFmpy.py');
    await writeFile(driverPath, driver, 'utf8');
    if ((await execute(python, ['-c', 'import fmpy'])).code !== 0) {
        console.log('  (skipping FMI 3.0 FMU export fidelity check: fmpy not importable -- pip install fmpy)');
    } else {
        const version = await fmpy({ mode: 'version', path: '' });
        let comparisons = 0;

        // --- The example models: a thermal network, an oscillator, a program in the current format. Bit for bit against the engine. ---
        for (const example of fmiExamples) {
            const document = await exportDocument(example);
            const paths = await exportBoth(directory, document, example.name);
            const reference = await engineReference(example, directory, executable);
            const rows = await checkAgainstFmi2(example.name, paths, { stop: example.stopTime, step: example.stepSize, outputs: reference.names });
            rows.forEach((row, index) => row.slice(1).forEach((value, column) => {
                assert.ok(Object.is(value, reference.rows[index][column + 1]),
                    `${example.name} (FMI 3.0) at t = ${reference.rows[index][0]}: ${reference.names[column]} is ${value}, the engine ${reference.rows[index][column + 1]}.`);
                comparisons += 1;
            }));
            assert.equal(paths.description.canGetAndSetFMUState, true, `${example.name} offers an FMU state.`);
            const bytes = await checkState(example.name, paths['3.0'], { step: example.stepSize, count: Math.round(example.stopTime / example.stepSize), outputs: reference.names });
            console.log(`✓ ${example.name} (FMI 3.0): FMPy ${version} validates it; its simulation equals the FMI 2.0 export's and the engine's bit for bit; a serialized FMU state (${bytes} bytes) restored mid-run continues to the bit.`);
        }

        // --- A tunable parameter, set through fmi3SetFloat64, against the engine's run of the project with that value. ---
        {
            const example = fmiExamples.find((candidate) => candidate.name === 'ThermalEquilibrium');
            const tuned = await exportDocument(example);
            const conductance = parametersWithSymbol(tuned, 'conductance');
            assert.ok(conductance.length > 0, 'ThermalEquilibrium has a conductance parameter.');
            for (const parameter of conductance) parameter.value = 80;
            const reference = await engineReference(example, directory, executable, tuned);
            const paths = await exportBoth(directory, await exportDocument(example), example.name);
            const rows = await checkAgainstFmi2('ThermalEquilibrium (conductance 80)', paths,
                { stop: example.stopTime, step: example.stepSize, outputs: reference.names, startValues: { conductance: 80 } });
            const untuned = await engineReference(example, directory, executable);
            assert.notDeepEqual(reference.rows.at(-1), untuned.rows.at(-1), 'Sanity check: the tuned conductance changes the run.');
            rows.forEach((row, index) => row.slice(1).forEach((value, column) => {
                assert.ok(Object.is(value, reference.rows[index][column + 1]), `Tuned ThermalEquilibrium at t = ${reference.rows[index][0]}: ${value} vs the engine's ${reference.rows[index][column + 1]}.`);
                comparisons += 1;
            }));
            console.log('✓ Tunable parameter (FMI 3.0): conductance set through fmi3SetFloat64 gives the engine\'s run of the project with that conductance, bit for bit.');
        }

        // --- The FMU fidelity fixture: a live input, a tunable constant, stored schedules, a bidirectional edge, several substeps. ---
        const outputs = Object.values(stateNameByStateId);
        const withRun = (run = {}) => ({ ...fixtureDocument, runConfigurations: [{ id: 900, globalTimeStep, outputInterval: communicationStepSize, ...run }], activeRunConfigurationId: 900 });
        {
            const paths = await exportBoth(directory, withRun(), 'fmuFidelityFixture');
            assert.ok(paths.description.variables.some((variable) => variable.name === 'k' && variable.causality === 'input'), 'The fixture\'s live parameter is an FMI 3.0 input.');
            const rows = await checkAgainstFmi2('fidelity fixture', paths, { stop: targetTime, step: communicationStepSize, outputs, startValues: { k: 0.2 } });
            const engine = await runRealEngine(executable, directory, fixtureDocument, 'fixture');
            let largest = 0;
            for (const sample of engine.samples) {
                const row = rows.find((candidate) => Math.abs(candidate[0] - sample.time) < 1e-9);
                assert.ok(row, `FMPy gave no row at t = ${sample.time}.`);
                for (const { stateId, value } of sample.states) {
                    largest = Math.max(largest, relativeDifference(row[outputs.indexOf(stateNameByStateId[stateId]) + 1], value));
                    comparisons += 1;
                }
            }
            // Its scheduled, algebraic and edge-coupled states differ from the engine's in the last bit at a few samples (at most
            // 2.2e-16 relative, found 2026-11-26), the FMI 2.0 export exactly as much: the bound below is a few units in the last place,
            // where the FMI 2.0 check allows 1e-6. The example models above match the engine exactly.
            assert.ok(largest < 1e-15, `The FMI 3.0 fidelity fixture must give the engine's numbers to the last bits; it differs by ${largest}.`);
            const bytes = await checkState('fidelity fixture', paths['3.0'], { step: communicationStepSize, count: Math.round(targetTime / communicationStepSize), outputs, startValues: { k: 0.2 } });
            const refused = await fmpy({ mode: 'badStep', path: paths['3.0'], step: 0.15 });
            assert.ok(refused.refused && refused.messages.some((message) => /fmi3DoStep: the communication step size 0\.15 is not a whole number of this FMU's fixed internal step 0\.1/.test(message)),
                `A communication step that is not a whole number of internal steps is refused, saying why: ${JSON.stringify(refused)}`);
            console.log(`✓ Fidelity fixture (FMI 3.0): validated; equal to the FMI 2.0 export bit for bit, to the engine within ${largest.toExponential(2)}; its FMU state (${bytes} bytes) round-trips; a step of 0.15 is refused through the logger.`);
        }

        // --- Stiff: the fixture under Rodas4, Rodas5P and BDF, each global step taken inside fmi3DoStep as the engine takes it. ---
        for (const run of [{ method: 'rodas4' }, { method: 'rodas5p' }, { method: 'bdf' }].map((entry) => ({ ...entry, tolerance: { relative: 1e-8, absolute: 1e-10 } }))) {
            const paths = await exportBoth(directory, withRun(run), `${run.method}FidelityFixture`);
            assert.equal(paths.description.canGetAndSetFMUState, false, `Under ${run.method} the solver's memory is not in an FMU state, so none is offered.`);
            const rows = await checkAgainstFmi2(`${run.method} fixture`, paths, { stop: targetTime, step: communicationStepSize, outputs, startValues: { k: 0.2 } });
            const engine = await runRealEngine(executable, directory, fixtureDocument, run.method, run);
            assert.equal(engine.integration?.method, run.method, `The engine must run the fixture under ${run.method}.`);
            let largest = 0;
            for (const sample of engine.samples) {
                const row = rows.find((candidate) => Math.abs(candidate[0] - sample.time) < 1e-9);
                assert.ok(row, `FMPy gave no ${run.method} row at t = ${sample.time}.`);
                for (const { stateId, value } of sample.states) {
                    largest = Math.max(largest, relativeDifference(row[outputs.indexOf(stateNameByStateId[stateId]) + 1], value));
                    comparisons += 1;
                }
            }
            // The same bound as the FMI 2.0 check (tests/engine/fmiExportFidelity.mjs): the FMU sums its step times as the host steps.
            assert.ok(largest < 1e-9, `The FMI 3.0 ${run.method} fixture should give the engine's numbers; it differs by ${largest}.`);
            console.log(`✓ ${run.method} (FMI 3.0): validated; equal to the FMI 2.0 export bit for bit; largest relative difference from the engine ${largest.toExponential(2)}.`);
        }

        console.log(`✓ FMI 3.0 FMU export fidelity: FMPy ${version} validated and simulated every FMI 3.0 export, matching the FMI 2.0 exports bit for bit and the engine across ${comparisons} output/time comparisons.`);
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
