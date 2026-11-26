/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The controller example (examples/pidController, docs/proposals/rootPorts.md stage 7), checked against the real engine:
//   - the committed PidController.fmu, a PI controller drawn from the Modelica Standard Library in OpenModelica, run in Konjugate with
//     its setpoint and measurement read from states that follow the committed input series: its command equals FMPy's run of the same
//     FMU against the same series (PidController_ref.csv, written by generate.mjs) at every communication point, bit for bit;
//   - the shipped project HeatedRoomPid.kjt, run as it is (its FMU installed from the project's own file): the room the FMU controls
//     follows the room controlled by the same PI controller written in Konjugate within the stated tolerance, and both reach the
//     setpoint.
//
//   node tests/engine/pidControllerExample.mjs

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

const directory = await mkdtemp(join(tmpdir(), 'konjugatePidExample-'));
try {
    // 1. The FMU alone, its inputs following the committed series, against FMPy's run of it.
    const archive = await readFile(join(example, 'PidController.fmu'));
    const packages = join(directory, 'packages');
    const fmu = await installedPidController(archive, packages);
    const inputs = await csv('PidController_inputs.csv');
    const reference = await csv('PidController_ref.csv');
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
    const alone = await runWithEngine(JSON.stringify(host), { targetTime: 14400, globalTimeStep: 10, outputInterval: 10, pacing: { mode: 'fastest' } }, { ...engineOptions, fmuDirectory: packages, disabledFmuKeys: [] });
    assert.ok(alone.available, 'The engine run of the FMU was not available.');
    const expected = new Map(reference.map(([time, value]) => [time, value]));
    let compared = 0;
    for (const sample of alone.result.samples) {
        if (sample.time === 0 || !expected.has(sample.time)) continue;
        const value = sample.states.find((state) => state.stateId === commandId).value;
        assert.equal(value, expected.get(sample.time), `At t=${sample.time} the FMU's command is ${value} in Konjugate and ${expected.get(sample.time)} in FMPy.`);
        compared += 1;
    }
    assert.ok(compared >= 1400, `Too few samples compared (${compared}).`);
    console.log(`✓ PidController.fmu in Konjugate equals FMPy's run of it, bit for bit, at ${compared} communication points of the committed input series.`);

    // 2. The shipped project, run as it is, its FMU installed from the project's own file.
    const bundle = await decodeProjectBundle(await readFile(join(example, 'HeatedRoomPid.kjt')));
    assert.equal(bundle.attachments.length, 1, 'The project keeps its FMU.');
    const projectPackages = join(directory, 'projectPackages');
    await installedPidController(bundle.attachments[0].buffer, projectPackages);
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
} finally {
    await rm(directory, { recursive: true, force: true });
}
