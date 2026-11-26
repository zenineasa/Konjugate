/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Test signals for in ports (docs/proposals/rootPorts.md, stage 6), checked against the real engine: a document that carries one says
// rootPortSignals in its `requires`, which an engine that does not apply signals itself (every 2.0.x engine; this one too, since the host
// applies them) refuses by name, so a Konjugate from before never runs it differently; and with the host's transform applied, the
// setpoint follows its step schedule, the measurement holds its constant, and the controller integrates gain × (setpoint −
// measurement) from those values, step by step.
//
//   node tests/engine/rootPortSignals.mjs [engine executable]

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRootPortSignals, rootPortRequires, setRootPortSignal } from '../../src/components.mjs';
import { executionProjectDocument } from '../../src/subsystems.mjs';
import { stripEdgeGroups } from '../../src/edgeGroups.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { spawn } from 'node:child_process';
import { runRealEngine } from './fixtures/fmuFidelityFixture.mjs';
import { portsDocument, portsStateIds } from './fixtures/fmuPortsFixture.mjs';

const executable = process.argv[2] ?? join(import.meta.dirname, '..', '..', 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const directory = await mkdtemp(join(tmpdir(), 'konjugateRootPortSignals-'));
try {
    let document = setRootPortSignal(portsDocument, 1, { kind: 'schedule', interpolation: 'hold', samples: [[0, 20], [1, 21]] });
    document = setRootPortSignal(document, 2, { kind: 'constant', value: 17 });
    document.requires = rootPortRequires(document.requires, document.component);
    assert.deepEqual(document.requires, ['rootPortSignals']);

    // As a Konjugate from before would give it to its engine: flattened, the signals not applied, the requirement still there. The
    // engine refuses it as it compiles the run, naming what it does not know.
    const olderPath = join(directory, 'older.kjt');
    const configurationPath = join(directory, 'older.json');
    await writeFile(olderPath, await encodeProjectFile(JSON.stringify(stripEdgeGroups(executionProjectDocument(document)))));
    await writeFile(configurationPath, JSON.stringify({ name: 'older', targetTime: 1, globalTimeStep: 0.1, outputInterval: 0.1 }));
    const refused = await new Promise((resolve, reject) => {
        const child = spawn(executable, ['run', olderPath, '--configuration', configurationPath, '--output', join(directory, 'older.bin')], { stdio: ['ignore', 'pipe', 'pipe'] });
        let diagnostics = '';
        child.stdout.on('data', (chunk) => { diagnostics += chunk; });
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, diagnostics }));
    });
    assert.notEqual(refused.code, 0, 'An engine that does not apply port signals must refuse the document.');
    assert.match(refused.diagnostics, /requires "rootPortSignals", which this version of Konjugate does not know/, `The refusal must name the requirement: ${refused.diagnostics.slice(0, 400)}`);
    console.log('✓ An engine that does not apply port signals refuses a document carrying one, naming rootPortSignals.');

    // As this Konjugate runs it: the host's transform applied, the requirement taken off.
    const result = await runRealEngine(executable, directory, stripEdgeGroups(executionProjectDocument(applyRootPortSignals(document))), 'signals');
    const value = (sample, stateId) => sample.states.find((state) => state.stateId === stateId).value;
    const gain = portsDocument.sharedParameters[0].value;
    let previous = null;
    for (const sample of result.samples) {
        const setpoint = value(sample, portsStateIds.setpoint);
        const measurement = value(sample, portsStateIds.measurement);
        if (sample.time > 0) assert.equal(measurement, 17, `The measurement holds its constant at t=${sample.time}.`);
        if (sample.time > 0 && sample.time < 0.95) assert.equal(setpoint, 20, `The setpoint is 20 before its step, at t=${sample.time}.`);
        if (sample.time > 1.05) assert.equal(setpoint, 21, `The setpoint is 21 after its step, at t=${sample.time}.`);
        if (previous && previous.time > 1.05) {
            const rise = value(sample, portsStateIds.integral) - value(previous, portsStateIds.integral);
            const expected = gain * (21 - 17) * (sample.time - previous.time);
            assert.ok(Math.abs(rise - expected) < 1e-9, `The command rises by gain × (21 − 17) × Δt after the step: ${rise} against ${expected} at t=${sample.time}.`);
        }
        previous = sample;
    }
    console.log(`✓ Run on its own, the setpoint follows its step and the measurement its constant at ${result.samples.length} samples, and the controller integrates them.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
