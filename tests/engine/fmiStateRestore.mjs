/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Saved state restored into a fresh exported FMU (FMI review #2), in FMI 2.0 and FMI 3.0, checked with FMPy: a model whose relationship is
// a program (the conduction example, the room starting at 285 K) is run for a while, its state saved and serialized; a fresh instance of
// the same FMU is initialized, given that state, and then a parameter is set, as a host does before its next step; the step it takes then
// equals the step the first instance takes from the same point. Before the fix, setting the parameter restarted the restored model from
// its initial values (the room went back to 285 K).
//
//   node tests/engine/fmiStateRestore.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateFmuPackage } from '../../src/fmiExport.mjs';
import { executionProjectDocument } from '../../src/subsystems.mjs';
import { stripEdgeGroups } from '../../src/edgeGroups.mjs';
import { fmpyPlatforms } from './fixtures/fmuFidelityFixture.mjs';

const root = join(import.meta.dirname, '..', '..');
const python = process.env.PYTHON || 'python3';
const execute = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
});

const conduction = await readFile(join(root, 'examples', 'providers', 'conduction.cpp'), 'utf8');
const document = {
    format: 'konjugate', version: 1, metadata: { projectName: 'Conduction' },
    nodes: [
        { id: 1, name: 'Wall', states: [{ id: 11, name: 'Temperature', symbol: 'temperature', initialValue: 310, unit: 'K' }], sourceTerms: [] },
        { id: 2, name: 'Room', states: [{ id: 21, name: 'Temperature', symbol: 'temperature', initialValue: 285, unit: 'K' }], sourceTerms: [] }
    ],
    edges: [{
        id: 31, name: 'Conduction', source: { nodeId: 1, stateId: 11 }, target: { nodeId: 2, stateId: 21 }, directionality: 'directed', equation: '',
        parameters: [{ id: 41, name: 'Conductance', symbol: 'conductance', value: 4, unit: 'W/K', mode: 'constant' }, { id: 42, name: 'Capacity', symbol: 'capacity', value: 2, unit: 'J/K', mode: 'constant' }],
        implementation: {
            kind: 'cpp', providerApiVersion: 2, source: conduction,
            bindings: [
                { key: 'hot', kind: 'state', nodeId: 1, stateId: 11 }, { key: 'cold', kind: 'state', nodeId: 2, stateId: 21 },
                { key: 'conductance', kind: 'parameter', parameterId: 41 }, { key: 'capacity', kind: 'parameter', parameterId: 42 }
            ],
            output: { role: 'target', key: 'warming', stateId: 21 }
        }
    }],
    runConfigurations: [{ id: 900, globalTimeStep: 0.01, outputInterval: 0.1 }],
    activeRunConfigurationId: 900
};

// Runs the FMU at `path` with FMPy: 50 steps, the state saved and serialized; a fresh instance given it, the conductance set, one step;
// the first instance's next step with the same conductance. Prints the two rooms and the room before.
const script = `
import json, sys
${fmpyPlatforms}
from fmpy import read_model_description, extract
from fmpy.fmi2 import FMU2Slave
from fmpy.fmi3 import FMU3Slave
path, version = sys.argv[1], sys.argv[2]
description = read_model_description(path)
unzipped = extract(path)
vr = {variable.name: variable.valueReference for variable in description.modelVariables}
room, conductance = vr['Room.Temperature'], vr['conductance']
h = 0.01
def make():
    if version == '2.0':
        fmu = FMU2Slave(guid=description.guid, unzipDirectory=unzipped, modelIdentifier=description.coSimulation.modelIdentifier, instanceName='a')
        fmu.instantiate(); fmu.setupExperiment(startTime=0.0); fmu.enterInitializationMode(); fmu.exitInitializationMode()
    else:
        fmu = FMU3Slave(guid=description.guid, unzipDirectory=unzipped, modelIdentifier=description.coSimulation.modelIdentifier, instanceName='a')
        fmu.instantiate(); fmu.enterInitializationMode(startTime=0.0); fmu.exitInitializationMode()
    return fmu
def get(fmu, ref): return (fmu.getReal if version == '2.0' else fmu.getFloat64)([ref])[0]
def put(fmu, ref, value): (fmu.setReal if version == '2.0' else fmu.setFloat64)([ref], [value])
def save(fmu):
    if version == '2.0': return fmu.serializeFMUstate(fmu.getFMUstate())
    return fmu.serializeFMUState(fmu.getFMUState())
def load(fmu, data):
    if version == '2.0': fmu.setFMUstate(fmu.deSerializeFMUstate(data))
    else: fmu.setFMUState(fmu.deserializeFMUState(data))
first = make()
t = 0.0
for _ in range(50):
    first.doStep(t, h); t += h
saved = bytes(save(first))
before = get(first, room)
fresh = make()
load(fresh, saved)
put(fresh, conductance, 4.0)
fresh.doStep(t, h)
put(first, conductance, 4.0)
first.doStep(t, h)
print(json.dumps({'before': before, 'restored': get(fresh, room), 'continued': get(first, room)}))
`;

const directory = await mkdtemp(join(tmpdir(), 'konjugateFmiStateRestore-'));
try {
    if ((await execute(python, ['-c', 'import fmpy'])).code !== 0) {
        console.log('  (skipping the FMU state restore check: fmpy not importable -- pip install fmpy)');
    } else {
        await writeFile(join(directory, 'restore.py'), script);
        for (const fmiVersion of ['2.0', '3.0']) {
            const buffer = await generateFmuPackage(stripEdgeGroups(executionProjectDocument(document)), {
                modelName: 'Conduction', fmiVersion,
                engineOptions: { applicationPath: root, resourcesPath: '', packaged: false }
            });
            const path = join(directory, `conduction${fmiVersion}.fmu`);
            await writeFile(path, buffer);
            const outcome = await execute(python, [join(directory, 'restore.py'), path, fmiVersion]);
            assert.equal(outcome.code, 0, `FMPy could not run the FMI ${fmiVersion} export:\n${outcome.stderr}`);
            const { before, restored, continued } = JSON.parse(outcome.stdout.trim().split('\n').at(-1));
            assert.ok(before > 285.5, `FMI ${fmiVersion}: the room should have warmed before its state was saved (${before} K).`);
            assert.ok(Object.is(restored, continued), `FMI ${fmiVersion}: restored and given a parameter, the FMU went to ${restored} K, not ${continued} K as the instance it was saved from did (the room was ${before} K).`);
        }
        console.log('✓ FMU state restore: a fresh FMI 2.0 and FMI 3.0 export given a saved state, then a parameter, steps exactly as the instance it was saved from.');
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
