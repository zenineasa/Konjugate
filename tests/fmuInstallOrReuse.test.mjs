/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Add FMU and Replace FMU (FMI review #1): an FMU already in the library is reused only when it is the same archive; a different build
// that kept the same ID is installed beside it, and said, rather than running the old binary.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { installOrReuseFmu, listInstalledFmus } from '../src/fmuPackage.mjs';

const dahlquist = () => readFile(join(import.meta.dirname, '..', 'examples', 'tutorialFmus', 'Dahlquist.fmu'));
// The same FMU, its ID kept, with one file changed: a newer build of it.
const rebuilt = async (note) => Buffer.from(zipSync({ ...unzipSync(new Uint8Array(await dahlquist())), 'documentation/rebuilt.txt': strToU8(note) }));

test('the library copy is reused only for the same archive; a different build with the same ID is installed beside it and said', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateFmuReuse-'));
    try {
        const first = await installOrReuseFmu(directory, await dahlquist(), { sourceFileName: 'Dahlquist.fmu' });
        assert.deepEqual([first.reused, first.version, first.besideVersion], [false, '1.0.0', null]);
        const again = await installOrReuseFmu(directory, await dahlquist());
        assert.deepEqual([again.reused, again.guid, again.version], [true, first.guid, '1.0.0'], 'The same archive is the library copy.');
        const newer = await installOrReuseFmu(directory, await rebuilt('build 2'));
        assert.deepEqual([newer.reused, newer.guid, newer.version, newer.besideVersion], [false, first.guid, '1.0.1', '1.0.0'], 'A different build with the same ID is installed beside the old one.');
        const newerAgain = await installOrReuseFmu(directory, await rebuilt('build 2'));
        assert.deepEqual([newerAgain.reused, newerAgain.version], [true, '1.0.1'], 'and is reused itself next time.');
        const third = await installOrReuseFmu(directory, await rebuilt('build 3'));
        assert.equal(third.version, '1.0.2');
        assert.deepEqual((await listInstalledFmus(directory)).map((entry) => entry.version).sort(), ['1.0.0', '1.0.1', '1.0.2']);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
