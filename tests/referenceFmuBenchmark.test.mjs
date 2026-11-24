/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Which of the committed Reference FMUs (benchmarks/fmi/referenceFmus/fmus/) the benchmark imports on each computer the release checks
// run on: the app's own choice of binary, and the FMU's FMI 3.0 directory for that computer, agree. They ship no x86_64-darwin binary,
// so on an Intel Mac none is imported, and the benchmark says so rather than failing.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { benchmarkMachine, binaryAvailability, fmuNames } from '../benchmarks/fmi/referenceFmus/problem.mjs';

const fmus = join(import.meta.dirname, '..', 'benchmarks', 'fmi', 'referenceFmus', 'fmus');

test('the Reference FMUs run on Apple Silicon, Linux and Windows, and not on an Intel Mac', async () => {
    const machines = {
        'darwin-arm64': true, 'linux-x64': true, 'linux-arm64': true, 'win32-x64': true, 'win32-ia32': true, 'darwin-x64': false
    };
    for (const name of fmuNames) {
        const archive = await readFile(join(fmus, `${name}.fmu`));
        for (const [machineName, runnable] of Object.entries(machines)) {
            const availability = await binaryAvailability(archive, benchmarkMachine(machineName));
            assert.equal(availability.runnable, runnable, `${name} on ${machineName}`);
            assert.equal(availability.shipped, runnable, `${name} ships a binary under FMI 3.0's name for ${machineName}`);
        }
        const intelMac = await binaryAvailability(archive, benchmarkMachine('darwin-x64'));
        assert.equal(intelMac.machine, 'x86_64-darwin');
        assert.equal(intelMac.reason, 'it has no binary this computer (x86_64-darwin) can run');
        assert.ok(intelMac.platforms.includes('aarch64-darwin') && !intelMac.platforms.includes('x86_64-darwin'));
    }
});

test('the benchmark decides for this computer unless another is named', () => {
    assert.deepEqual(benchmarkMachine(undefined), { platform: process.platform, arch: process.arch });
    assert.deepEqual(benchmarkMachine('darwin-x64'), { platform: 'darwin', arch: 'x64' });
    assert.throws(() => benchmarkMachine('macos-intel'), /darwin-x64/);
});
