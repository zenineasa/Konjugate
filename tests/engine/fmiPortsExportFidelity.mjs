/* Copyright © 2026 Zenin Easa Panthakkalakath */

// FMU export with a declared interface (docs/proposals/rootPorts.md, stage 4), checked as a real FMU in an independent FMI
// simulator: a model with two in ports, one out port, an exposed parameter linked from two relationships, and a counter whose
// constant and live rates are baked (tests/engine/fixtures/fmuPortsFixture.mjs) is exported as FMI 2.0 and FMI 3.0, each
// validated by FMPy (no problem found) and simulated there with the host setting both inputs and the gain; its out port and its
// local state must equal Konjugate's own run of the same model, with the inputs as the ports' values and the same gain, to the
// bit, at every sample.
//
// Needs a C++ compiler (to build the FMU) and FMPy (`pip install fmpy`, PYTHON to choose the interpreter); skips, not fails,
// when FMPy is not importable, as tests/engine/fmiExportFidelity.mjs does.
//
//   node tests/engine/fmiPortsExportFidelity.mjs [engine executable]

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { generateFmuPackage } from '../../src/fmiExport.mjs';
import { fmuExportInterface } from '../../src/fmuInterface.mjs';
import { executionProjectDocument } from '../../src/subsystems.mjs';
import { stripEdgeGroups } from '../../src/edgeGroups.mjs';
import { execute, runRealEngine, targetTime, fmpyPlatforms } from './fixtures/fmuFidelityFixture.mjs';
import { portsDocument, portsStateIds } from './fixtures/fmuPortsFixture.mjs';

const executable = process.argv[2] ?? join(import.meta.dirname, '..', '..', 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const python = process.env.PYTHON || 'python3';
const inputs = { setpoint: 21, measurement: 17.5, g: 0.8 };
const step = 0.2;

const directory = await mkdtemp(join(tmpdir(), 'konjugateFmuPorts-'));
try {
    if ((await execute(python, ['-c', 'import fmpy'])).code !== 0) {
        console.log('  (skipping FMU ports check: fmpy not importable -- pip install fmpy)');
    } else {
        // Konjugate's own run: the in ports hold the values a host would set, and the gain is the host's.
        const engineDocument = structuredClone(portsDocument);
        engineDocument.nodes[0].states[0].initialValue = inputs.setpoint;
        engineDocument.nodes[1].states[0].initialValue = inputs.measurement;
        engineDocument.sharedParameters[0].value = inputs.g;
        const engine = await runRealEngine(executable, directory, stripEdgeGroups(executionProjectDocument(engineDocument)), 'ports');
        const fmuInterface = fmuExportInterface(portsDocument);
        const driverPath = join(directory, 'drive.py');
        await writeFile(driverPath, `
import json, sys
${fmpyPlatforms}
from fmpy import simulate_fmu
from fmpy.validation import validate_fmu
request = json.loads(sys.argv[1])
problems = [str(problem) for problem in validate_fmu(request['path'])]
result = simulate_fmu(request['path'], start_time=0.0, stop_time=request['stop'], output_interval=request['step'],
    start_values=request['start'], output=request['outputs'])
rows = [dict(zip(result.dtype.names, [float(value) for value in row])) for row in result]
print(json.dumps({ 'problems': problems, 'rows': rows }))
`, 'utf8');
        for (const fmiVersion of ['2.0', '3.0']) {
            const buffer = await generateFmuPackage(stripEdgeGroups(executionProjectDocument(portsDocument)), {
                modelName: 'PortedController', fmiVersion, fmuInterface,
                engineOptions: { applicationPath: join(import.meta.dirname, '..', '..'), resourcesPath: '', packaged: false }
            });
            const path = join(directory, `ported${fmiVersion}.fmu`);
            await writeFile(path, buffer);
            const xml = Buffer.from(unzipSync(buffer)['modelDescription.xml']).toString('utf8');
            assert.match(xml, /name="setpoint" valueReference="1" causality="input"/, `FMI ${fmiVersion}: setpoint is an input.`);
            assert.match(xml, /name="command" valueReference="0" causality="output"/, `FMI ${fmiVersion}: command is the output.`);
            assert.match(xml, /name="Counter.Count" valueReference="4" causality="local"/, `FMI ${fmiVersion}: the counter is observable.`);
            assert.doesNotMatch(xml, /name="[ab]"/, `FMI ${fmiVersion}: the baked rates are not variables.`);
            const run = await execute(python, [driverPath, JSON.stringify({ path, stop: targetTime, step, start: inputs, outputs: ['command', 'Counter.Count'] })]);
            assert.equal(run.code, 0, `FMI ${fmiVersion}: FMPy must validate and simulate the FMU.`);
            const { problems, rows } = JSON.parse(run.stdout.trim().split('\n').at(-1));
            assert.deepEqual(problems, [], `FMI ${fmiVersion}: FMPy found problems: ${problems.join('; ')}`);
            let compared = 0;
            for (const sample of engine.samples) {
                const row = rows.find((candidate) => Math.abs(candidate.time - sample.time) < 1e-9);
                assert.ok(row, `FMI ${fmiVersion}: no FMPy row at t=${sample.time}.`);
                for (const [name, stateId] of [['command', portsStateIds.integral], ['Counter.Count', portsStateIds.count]]) {
                    const expected = sample.states.find((state) => state.stateId === stateId).value;
                    assert.equal(row[name], expected, `FMI ${fmiVersion}: ${name} at t=${sample.time} is ${row[name]} in the FMU and ${expected} in Konjugate.`);
                    compared += 1;
                }
            }
            assert.ok(compared >= 2 * 10, `FMI ${fmiVersion}: too few samples compared (${compared}).`);
            console.log(`  FMI ${fmiVersion}: validated by FMPy; command and Counter.Count equal Konjugate's run to the bit at ${compared / 2} samples`);
        }
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
