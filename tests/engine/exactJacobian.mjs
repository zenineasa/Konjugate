/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Contract for the stiff methods' exact Jacobian (docs/proposals/integrators.md, Jacobians for Rodas4 and BDF):
//   - under Stiff, Rodas4 and BDF, every column whose terms are all equations is worked out from the equations' derivatives, so no
//     model evaluation goes on finite differences, and the result says so (jacobian, exactColumns, jacobianColours 0);
//   - every operation an equation can use is differentiated right: under jacobian "check", each Jacobian of a model using them all is
//     compared with finite differences, and they agree to the differences' own error;
//   - "check" steps with the exact Jacobian: its run is the analytic run's, to the bit;
//   - "finiteDifference" works the Jacobian out by finite differences, as Stiff first did, and its answer agrees with the exact one's;
//   - the same bits on every backend;
//   - an unknown jacobian, or one given to a method that works out no Jacobian, is refused by name.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { everyOperationDocument } from './fixtures/everyOperationFixture.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');

function execute(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, diagnostics }));
    });
}

const directory = await mkdtemp(join(tmpdir(), 'konjugateExactJacobian-'));
let runs = 0;
async function attempt(model, configuration) {
    const index = runs++;
    const configurationPath = join(directory, `run${index}.json`);
    const outputPath = join(directory, `run${index}.kjr`);
    await writeFile(configurationPath, JSON.stringify({ name: `run${index}`, ...configuration }));
    const { code, diagnostics } = await execute(['run', model, '--configuration', configurationPath, '--output', outputPath]);
    return { code, diagnostics, result: code === 0 ? decodeResultFile(await readFile(outputPath)) : null };
}
async function run(model, configuration) {
    const { code, diagnostics, result } = await attempt(model, configuration);
    assert.equal(code, 0, `The run must succeed: ${diagnostics}`);
    return result;
}
const valuesOf = (result) => result.samples.flatMap((sample) => sample.states.map((state) => state.value));
const sameBits = (left, right) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

try {
    const model = join(directory, 'everything.kjt');
    await writeFile(model, await encodeProjectFile(JSON.stringify(everyOperationDocument())));
    const timing = { targetTime: 2, globalTimeStep: 0.25, outputInterval: 0.25 };
    for (const method of ['rodas4', 'bdf']) {
        const stiff = { ...timing, method, tolerance: { relative: 1e-8, absolute: 1e-10 } };
        const analytic = await run(model, stiff);
        assert.equal(analytic.integration.jacobian, 'analytic', 'The exact Jacobian is the default.');
        assert.equal(analytic.integration.exactColumns, 3, 'Every column is an equation\'s: every column exact.');
        assert.equal(analytic.integration.jacobianColours, 0, 'No evaluation goes on finite differences.');

        const checked = await run(model, { ...stiff, jacobian: 'check' });
        const check = checked.integration.jacobianCheck;
        assert.ok(check.checks >= 1 && check.checks === checked.integration.jacobians, `Every Jacobian is checked: ${JSON.stringify(check)}.`);
        assert.ok(check.largestDifference < 1e-5, `Each operation's derivative must agree with finite differences to their own error: ${JSON.stringify(check)}.`);
        assert.ok(sameBits(valuesOf(checked), valuesOf(analytic)), `"check" steps with the exact Jacobian (${method}).`);

        const differenced = await run(model, { ...stiff, jacobian: 'finiteDifference' });
        assert.equal(differenced.integration.jacobian, 'finiteDifference');
        assert.equal(differenced.integration.exactColumns, 0);
        assert.ok(differenced.integration.jacobianColours > 0);
        const exactEnd = analytic.samples.at(-1).states.map((state) => state.value);
        differenced.samples.at(-1).states.forEach((state, index) => assert.ok(Math.abs(state.value - exactEnd[index]) <= 1e-6 * Math.max(1, Math.abs(exactEnd[index])),
            `The finite-difference run must agree with the exact one within the tolerance's reach (${method}).`));

        for (const execution of [{ backend: 'threadPool', workerThreads: 3 }, { backend: 'partitioned', partitionCount: 2, workerThreads: 2 }]) {
            assert.ok(sameBits(valuesOf(await run(model, { ...stiff, execution })), valuesOf(analytic)), `${execution.backend} must give the serial bits (${method}).`);
        }
    }

    const unknown = await attempt(model, { ...timing, method: 'rodas4', jacobian: 'symbolic' });
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.diagnostics, /The run's jacobian "symbolic" is not one this version of Konjugate knows/);
    const misplaced = await attempt(model, { ...timing, method: 'rungeKutta4', jacobian: 'analytic' });
    assert.notEqual(misplaced.code, 0);
    assert.match(misplaced.diagnostics, /jacobian applies to the stiff methods/);

    console.log('✓ exact Jacobian: under Rodas4 and BDF every equation\'s column exact, every operation agreeing with finite differences, '
        + '"check" stepping as the exact Jacobian does, finite differences still chosen by name, the same bits on every backend, and its refusals.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
