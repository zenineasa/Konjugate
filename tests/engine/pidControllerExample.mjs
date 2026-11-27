/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The controller example (examples/pidController, docs/proposals/rootPorts.md stage 7), checked against the real engine:
//   - the committed PidController.fmu, a PI controller drawn from the Modelica Standard Library in OpenModelica, run in Konjugate with
//     its setpoint and measurement read from states that follow the committed input series: its command equals FMPy's run of the same
//     FMU against the same series (PidController_ref.csv, written by generate.mjs) at every communication point, bit for bit;
//   - the shipped project HeatedRoomPid.kjt, run as it is (its FMU installed from the project's own file): the room the FMU controls
//     follows the room controlled by the same PI controller written in Konjugate within the stated tolerance, and both reach the
//     setpoint;
//   - the same FMU with its binaries taken out, built here from its sources with Konjugate's OpenModelica recipe
//     (docs/proposals/sourceFmuImport.md, stage 4): its command equals FMPy's run at every communication point, bit for bit where the
//     committed binary is this compiler's (Apple clang on macOS arm64, its darwin64 binary), and elsewhere any difference is said with its
//     size; the recipe compiles what OpenModelica's own CMakeLists compiles, with its definitions.
// The committed FMU's only binary is for Apple Silicon. On a computer it cannot run on (an Intel Mac, Linux), the first two checks run
// the FMU built here from its sources instead, as Konjugate itself does, and the first says how far that build is from FMPy's run of
// the committed binary rather than claiming the bits; with no C compiler there, they say they were not checked.
//
//   node tests/engine/pidControllerExample.mjs [path/to/konjugateEngine, which builds the sources]

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithEngine } from '../../src/engineAdapter.mjs';
import { fmiNodeFromPorts, implementationForFile } from '../../src/nodeProgram.mjs';
import { decodeProjectBundle } from '../../src/projectFile.mjs';
import { executionProjectDocument } from '../../src/subsystems.mjs';
import { stripEdgeGroups } from '../../src/edgeGroups.mjs';
import { installedPidController } from '../../examples/pidController/buildProject.mjs';
import { unzipSync, zipSync } from 'fflate';
import { exporterRecipe } from '../../src/fmuRecipes.mjs';
import { buildInstalledFmu } from '../../src/fmuBuilds.mjs';
import { findCCompiler } from '../../src/fmuSourceBuild.mjs';
import { chooseFmuBinary, platformTuple } from '../../src/fmiBinary.mjs';
import { parseModelDescription } from '../../src/fmiModelDescription.mjs';

const example = join(import.meta.dirname, '..', '..', 'examples', 'pidController');
const engineOptions = { applicationPath: join(import.meta.dirname, '..', '..'), resourcesPath: '', packaged: false };
// The two rooms' largest temperature difference allowed over the run: the FMU reads the room's temperature at the start of each 10 s
// step and integrates its own way inside, Konjugate's controller reads it as its Updates are worked out, so they differ by a little.
const closedLoopTolerance = 0.05;

const csv = async (name) => (await readFile(join(example, name), 'utf8')).trim().split('\n').slice(1).map((line) => line.split(',').map(Number));

// A series of rows (time, value, …) as a held schedule of column `column`: a value from the time it is first given.
function heldSchedule(rows, column) {
    const samples = [];
    for (const row of rows) {
        const [time, value] = [row[0], row[column]];
        if (samples.length && samples.at(-1)[0] === time) samples.at(-1)[1] = value;
        else if (!samples.length || samples.at(-1)[1] !== value) samples.push([time, value]);
    }
    return { interpolation: 'hold', samples };
}

// A node holding one Update set by a shared parameter that follows a held schedule.
function seriesNode(id, name, symbol, schedule, sharedId) {
    return {
        id, name, states: [{ id: id + 1, name, symbol, initialValue: schedule.samples[0][1], unit: 'degC', kind: 'update' }],
        sourceTerms: [{
            id: id + 2, state: symbol, expression: `${symbol}Series`, setsValue: true,
            expressionModel: { latex: `\\mathrm{${symbol}Series}`, output: { stateId: id + 1 }, mathJson: `${symbol}Series`, bindings: [{ kind: 'parameter', parameterId: id + 3, symbol: `${symbol}Series` }] },
            parameters: [{ id: id + 3, name: `${name} series`, symbol: `${symbol}Series`, value: schedule.samples[0][1], unit: 'degC', mode: 'constant', sharedParameterId: sharedId }]
        }]
    };
}

// The largest difference between a run and FMPy's run of the committed binary, said in a sentence.
const differenceSentence = ({ compared, differences }) => {
    const largest = differences.reduce((most, item) => Math.max(most, Math.abs(item.value - item.expected)), 0);
    return `${differences.length} of ${compared} communication points differ from FMPy's run of the committed binary, largest by ${largest.toExponential(3)}`;
};

const directory = await mkdtemp(join(tmpdir(), 'konjugatePidExample-'));
try {
    const archive = await readFile(join(example, 'PidController.fmu'));
    const files = unzipSync(new Uint8Array(archive));
    const description = parseModelDescription(Buffer.from(files['modelDescription.xml']).toString('utf8'));
    const ownBinary = await chooseFmuBinary(description, async (path) => files[path] ?? null);
    // A compiler OpenModelica's sources compile with, as its recipe asks (GCC or clang; MSVC refuses its generated C, src/fmuRecipes.mjs).
    const compiler = await findCCompiler({ flavors: exporterRecipe({ id: 'openModelica', version: '1.27.1' }).recipe.compilerFlavors });
    const builder = process.argv[2] ?? join(engineOptions.applicationPath, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
    const buildHere = (fmuDirectory, fmu) => buildInstalledFmu({
        fmuDirectory, guid: fmu.fmuId, version: fmu.fmuVersion, engine: builder, sdkPath: join(engineOptions.applicationPath, 'engine'), compiler
    });
    // Where this computer cannot run the committed binary, the FMU installed in `fmuDirectory` is built from its sources, as Konjugate
    // builds it when a model needs it; the resolver then runs that build.
    const runnableHere = async (fmuDirectory, fmu) => {
        if (!ownBinary.error) return true;
        assert.ok(!compiler.message, 'Not built: no C compiler.');
        const outcome = await buildHere(fmuDirectory, fmu);
        assert.ok(['built', 'cached'].includes(outcome.status), `${outcome.message ?? outcome.status}\n${outcome.log ?? ''}`);
        return true;
    };
    if (ownBinary.error) {
        console.log(`  The committed PidController.fmu cannot run here: ${ownBinary.error}. ${compiler.message
            ? `With no C compiler here (${compiler.message}), it is not built either, so nothing below is checked.\n  (skipping the controller example: its FMU has no binary for this computer and there is no compiler here that builds OpenModelica's sources)`
            : `It is built here from its sources (${compiler.banner}, ${platformTuple()}) and that build is checked.`}`);
    }

    if (!(ownBinary.error && compiler.message)) {
        // 1. The FMU alone, its inputs following the committed series, against FMPy's run of it.
        const packages = join(directory, 'packages');
        const inputs = await csv('PidController_inputs.csv');
        const reference = await csv('PidController_ref.csv');
        // The FMU installed in `fmuDirectory` run with its inputs following the committed series, against FMPy's run: `{ compared, differences }`.
        const runAlone = async (fmu, fmuDirectory) => {
            const setpointSchedule = heldSchedule(inputs, 1);
            const measurementSchedule = heldSchedule(inputs, 2);
            let next = 100;
            const built = fmiNodeFromPorts({ name: 'PidController', states: [] }, { guid: fmu.fmuId, version: fmu.fmuVersion, ports: fmu.ports, newId: () => next++ });
            const reads = { setpoint: { nodeId: 1, stateId: 2 }, measurement: { nodeId: 10, stateId: 11 } };
            built.implementation.bindings = built.implementation.bindings.map((binding) => (reads[binding.key] ? { key: binding.key, kind: 'state', ...reads[binding.key] } : binding));
            const host = {
                format: 'konjugate', version: 1, metadata: { units: 'SI' },
                sharedParameters: [
                    { id: 90, name: 'Setpoint series', symbol: 'setpointSeries', value: setpointSchedule.samples[0][1], unit: 'degC', mode: 'constant', schedule: setpointSchedule },
                    { id: 91, name: 'Measurement series', symbol: 'measurementSeries', value: measurementSchedule.samples[0][1], unit: 'degC', mode: 'constant', schedule: measurementSchedule }
                ],
                nodes: [seriesNode(1, 'Setpoint', 'setpoint', setpointSchedule, 90), seriesNode(10, 'Measurement', 'measurement', measurementSchedule, 91), { id: 20, name: 'PidController', states: built.states, sourceTerms: [], implementation: implementationForFile(built.implementation) }],
                edges: []
            };
            const commandId = built.states[0].id;
            const alone = await runWithEngine(JSON.stringify(host), { targetTime: 14400, globalTimeStep: 10, outputInterval: 10, pacing: { mode: 'fastest' } }, { ...engineOptions, fmuDirectory, disabledFmuKeys: [] });
            assert.ok(alone.available, 'The engine run of the FMU was not available.');
            const expected = new Map(reference.map(([time, value]) => [time, value]));
            let compared = 0;
            const differences = [];
            for (const sample of alone.result.samples) {
                if (sample.time === 0 || !expected.has(sample.time)) continue;
                const value = sample.states.find((state) => state.stateId === commandId).value;
                if (!Object.is(value, expected.get(sample.time))) differences.push({ time: sample.time, value, expected: expected.get(sample.time) });
                compared += 1;
            }
            assert.ok(compared >= 1400, `Too few samples compared (${compared}).`);
            return { compared, differences };
        };
        const installed = await installedPidController(archive, packages);
        assert.ok(await runnableHere(packages, installed));
        const shipped = await runAlone(installed, packages);
        if (ownBinary.error) {
            console.log(`✓ PidController.fmu built here from its sources in Konjugate: ${differenceSentence(shipped)}.`);
        } else {
            assert.deepEqual(shipped.differences.slice(0, 3), [], `The committed FMU's command differs from FMPy's: ${JSON.stringify(shipped.differences.slice(0, 3))}`);
            console.log(`✓ PidController.fmu in Konjugate equals FMPy's run of it, bit for bit, at ${shipped.compared} communication points of the committed input series.`);
        }

        // 2. The shipped project, run as it is, its FMU installed from the project's own file.
        const bundle = await decodeProjectBundle(await readFile(join(example, 'HeatedRoomPid.kjt')));
        assert.equal(bundle.attachments.length, 1, 'The project keeps its FMU.');
        const projectPackages = join(directory, 'projectPackages');
        assert.ok(await runnableHere(projectPackages, await installedPidController(bundle.attachments[0].buffer, projectPackages)));
        const project = JSON.parse(bundle.content);
        const run = project.runConfigurations[0];
        const flat = stripEdgeGroups(executionProjectDocument(project));
        flat.requires = (flat.requires ?? []).filter((entry) => entry !== 'fmuAttachments' && entry !== 'fmuStartValues');
        const loop = await runWithEngine(JSON.stringify(flat), { targetTime: run.targetTime, globalTimeStep: run.globalTimeStep, outputInterval: run.outputInterval, pacing: { mode: 'fastest' } }, { ...engineOptions, fmuDirectory: projectPackages, disabledFmuKeys: [] });
        assert.ok(loop.available, 'The engine run of the project was not available.');
        const temperature = (sample, stateId) => sample.states.find((state) => state.stateId === stateId).value;
        let largest = 0;
        let at = 0;
        for (const sample of loop.result.samples) {
            const difference = Math.abs(temperature(sample, 11) - temperature(sample, 31));
            if (difference > largest) { largest = difference; at = sample.time; }
        }
        const last = loop.result.samples.at(-1);
        console.log(`  rooms at the end: FMU ${temperature(last, 11).toFixed(4)} °C, Konjugate PI ${temperature(last, 31).toFixed(4)} °C; largest difference ${largest.toExponential(3)} K at t=${at} s`);
        assert.ok(largest <= closedLoopTolerance, `The two rooms differ by ${largest} K at t=${at} s, more than ${closedLoopTolerance} K.`);
        for (const stateId of [11, 31]) assert.ok(Math.abs(temperature(last, stateId) - 21) < 0.1, `Room ${stateId} did not reach the 21 °C setpoint: ${temperature(last, stateId)}.`);
        console.log(`✓ HeatedRoomPid.kjt: the room the FMU controls follows the room Konjugate's PI controls within ${closedLoopTolerance} K (largest ${largest.toExponential(3)} K), both reaching 21 °C.`);

        // 3. Built here from its sources with OpenModelica's recipe (docs/proposals/sourceFmuImport.md, stage 4).
        if (compiler.message) {
            console.log(`  Not built from its sources: ${compiler.message}`);
        } else {
            const sourcesOnly = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).filter(([name]) => !name.startsWith('binaries/')))));
            const sourcePackages = join(directory, 'sourcePackages');
            const fromSources = await installedPidController(sourcesOnly, sourcePackages);
            const outcome = await buildHere(sourcePackages, fromSources);
            assert.equal(outcome.status, 'built', `${outcome.message ?? outcome.status}\n${outcome.log ?? ''}`);
            assert.deepEqual(outcome.record.recipe, { name: 'OpenModelica', version: 1 });
            // The recipe builds what OpenModelica's own CMakeLists builds: its runtime folders and the model's files, not <Model>_info.c,
            // the CVODE files or the ModelicaExternalC files <SourceFiles> also lists, with its definitions.
            const compiled = outcome.record.steps.filter((step) => step.what.startsWith('Compiling ')).map((step) => step.what.slice('Compiling '.length));
            assert.equal(compiled.length, 108);
            assert.ok(!compiled.some((file) => /^ModelicaExternalC\/|_info\.c$|cvode_solver\.c$/.test(file)), compiled.join(' '));
            const firstStep = outcome.record.steps[0].arguments.join(' ');
            for (const definition of ['OMC_MINIMAL_RUNTIME=1', 'OMC_FMI_RUNTIME=1', 'CMINPACK_NO_DLL', 'FMI2_OVERRIDE_FUNCTION_PREFIX']) assert.ok(firstStep.includes(definition), `${definition} is not defined: ${firstStep}`);
            const { compared: builtCompared, differences } = await runAlone({ ...fromSources, ports: fromSources.ports }, sourcePackages);
            if (process.platform === 'darwin' && process.arch === 'arm64') {
                assert.deepEqual(differences.slice(0, 3), [], `Built here with ${compiler.banner}, the command differs from FMPy's run of the committed clang binary: ${JSON.stringify(differences.slice(0, 3))}`);
                console.log(`✓ PidController.fmu built here from its sources with OpenModelica's recipe (${compiler.banner}) equals FMPy's run, bit for bit, at ${builtCompared} communication points, compiling what OpenModelica's own build compiles.`);
            } else {
                const largest = differences.reduce((most, item) => Math.max(most, Math.abs(item.value - item.expected)), 0);
                console.log(`✓ PidController.fmu built here from its sources with OpenModelica's recipe (${compiler.banner}): ${differences.length} of ${builtCompared} communication points differ from FMPy's run of the committed binary, largest ${largest}.`);
            }
        }
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
