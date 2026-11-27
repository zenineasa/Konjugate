/* Copyright © 2026 Zenin Easa Panthakkalakath */

// An exported FMU refuses to be started under another model's identity (FMI review M1), checked with FMPy: FMI 2.0's fmi2Instantiate
// with a GUID other than its modelDescription.xml's, and FMI 3.0's fmi3InstantiateCoSimulation with another instantiationToken, return
// no instance (FMI 2.0.4 §2.1.5, FMI 3.0.2 §2.4.1), and the right one starts.
//
//   node tests/engine/fmiIdentity.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateFmuPackage } from '../../src/fmiExport.mjs';
import { document, fmpyPlatforms } from './fixtures/fmuFidelityFixture.mjs';

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

// Starts the FMU at `path` under its own identity and under another: prints whether each gave an instance.
const script = `
import json, sys
${fmpyPlatforms}
from fmpy import read_model_description, extract
from fmpy.fmi2 import FMU2Slave
from fmpy.fmi3 import FMU3Slave
path, version = sys.argv[1], sys.argv[2]
description = read_model_description(path)
unzipped = extract(path)
def start(identity):
    Slave = FMU2Slave if version == '2.0' else FMU3Slave
    fmu = Slave(guid=identity, unzipDirectory=unzipped, modelIdentifier=description.coSimulation.modelIdentifier, instanceName='a')
    try:
        fmu.instantiate()
    except Exception:
        return False
    fmu.freeInstance()
    return True
print(json.dumps({'own': start(description.guid), 'other': start('{00000000-0000-0000-0000-000000000000}')}))
`;

const directory = await mkdtemp(join(tmpdir(), 'konjugateFmiIdentity-'));
try {
    if ((await execute(python, ['-c', 'import fmpy'])).code !== 0) {
        console.log('  (skipping the FMU identity check: fmpy not importable -- pip install fmpy)');
    } else {
        await writeFile(join(directory, 'identity.py'), script);
        for (const fmiVersion of ['2.0', '3.0']) {
            const buffer = await generateFmuPackage({ ...document, runConfigurations: [{ id: 900, globalTimeStep: 0.01, outputInterval: 0.1 }], activeRunConfigurationId: 900 }, {
                modelName: 'Identity', fmiVersion, engineOptions: { applicationPath: root, resourcesPath: '', packaged: false }
            });
            const path = join(directory, `identity${fmiVersion}.fmu`);
            await writeFile(path, buffer);
            const outcome = await execute(python, [join(directory, 'identity.py'), path, fmiVersion]);
            assert.equal(outcome.code, 0, `FMPy could not load the FMI ${fmiVersion} export:\n${outcome.stderr}`);
            const started = JSON.parse(outcome.stdout.trim().split('\n').at(-1));
            assert.equal(started.own, true, `FMI ${fmiVersion}: the FMU did not start under its own identity.`);
            assert.equal(started.other, false, `FMI ${fmiVersion}: the FMU started under another model's identity.`);
        }
        console.log('✓ FMU identity: FMI 2.0 and FMI 3.0 exports start under their own GUID or instantiationToken and refuse another.');
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
