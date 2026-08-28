/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { decodeResultFile } from '../../src/engineProtocol.mjs';

function execute(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

function closeEnough(actual, expected, absoluteTolerance, relativeTolerance) {
    return Math.abs(actual - expected) <= absoluteTolerance + relativeTolerance * Math.max(Math.abs(actual), Math.abs(expected));
}

function stateMap(sample) {
    return new Map(sample.states.map((state) => [state.stateId, state.value]));
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const expectations = JSON.parse(await readFile(new URL('./expected/exampleResults.json', import.meta.url), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'konjugateNumericalRegression-'));

try {
    for (const testCase of expectations.cases) {
        const content = await readFile(new URL(`../../examples/${testCase.example}.kjt`, import.meta.url));
        const inputPath = join(directory, `${testCase.example}.kjt`);
        const configurationPath = join(directory, `${testCase.example}Configuration.json`);
        const outputPath = join(directory, `${testCase.example}Result.bin`);
        const validationPath = join(directory, `${testCase.example}Validation.bin`);
        await writeFile(inputPath, content);
        await writeFile(configurationPath, JSON.stringify({ name: testCase.example, ...testCase.configuration }, null, 4));
        assert.equal(await execute(executable, ['validate', inputPath, '--report', validationPath]), 0, `${testCase.example} must validate`);
        assert.equal(await execute(executable, ['run', inputPath, '--configuration', configurationPath, '--output', outputPath]), 0, `${testCase.example} must run`);
        const result = decodeResultFile(await readFile(outputPath));
        for (const expectedSample of testCase.samples) {
            const actualSample = result.samples.find((sample) => Math.abs(sample.time - expectedSample.time) < 1e-12);
            assert.ok(actualSample, `${testCase.example} did not emit its ${expectedSample.time} s sample`);
            const values = stateMap(actualSample);
            for (const [stateId, expectedValue] of Object.entries(expectedSample.states)) {
                const actualValue = values.get(Number(stateId));
                assert.ok(Number.isFinite(actualValue), `${testCase.example} did not produce state ${stateId}`);
                assert.ok(closeEnough(actualValue, expectedValue, expectations.absoluteTolerance, expectations.relativeTolerance),
                    `${testCase.example} state ${stateId} at ${expectedSample.time} s: expected ${expectedValue}, received ${actualValue}`);
            }
        }

        const dynamicSeries = result.samples.map(stateMap);
        if (testCase.example === 'thermalManagement') {
            const final = dynamicSeries.at(-1);
            const energyChange = 1000 * (final.get(2) - 353.2)
                + 5025 * (final.get(5) - 293.15);
            assert.ok(Math.abs(energyChange - 420) < 1e-8, 'Thermal management must conserve transferred energy.');
        } else if (testCase.example === 'heatedWaterTank') {
            const temperatures = dynamicSeries.map((states) => states.get(2));
            assert.ok(temperatures.every((value, index) => !index || value > temperatures[index - 1]), 'The heated tank must warm monotonically.');
        } else if (testCase.example === 'springMassDamper') {
            const energy = (states) => 2 * states.get(2) ** 2
                + 0.5 * states.get(3) ** 2;
            assert.ok(energy(dynamicSeries.at(-1)) < energy(dynamicSeries[0]), 'Damping must reduce mechanical energy.');
        } else if (testCase.example === 'singleJointActuator') {
            const final = dynamicSeries.at(-1);
            assert.ok(Math.abs(final.get(4) - 9.8) < 1e-4);
            assert.ok(Math.abs(final.get(5) - 44) < 1e-3);
        } else if (testCase.example === 'twoRoomBuilding') {
            assert.ok(dynamicSeries.every((states) => states.get(2)
                > states.get(4)), 'The initially warmer room must remain warmer during this run.');
        } else if (testCase.example === 'thermalEquilibrium') {
            // Validates that a bidirectional edge applies a genuinely reciprocal contribution:
            // the hot and cold bodies share a thermal capacitance, so their combined temperature
            // must stay exactly constant (energy conservation), while their difference decays
            // toward the shared equilibrium value instead of only one side ever moving.
            const combined = dynamicSeries.map((states) => states.get(2) + states.get(4));
            assert.ok(combined.every((value) => Math.abs(value - 640) < 1e-8),
                'The hot and cold bodies must conserve their combined temperature.');
            const differences = dynamicSeries.map((states) => states.get(2) - states.get(4));
            assert.ok(differences.every((value, index) => !index || value < differences[index - 1]),
                'The temperature difference must shrink monotonically toward equilibrium.');
            assert.ok(differences.at(-1) < 0.2, 'The two bodies must have nearly equalized by the end of the run.');
        }
        console.log(`✓ numerical regression: ${testCase.example}`);
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
