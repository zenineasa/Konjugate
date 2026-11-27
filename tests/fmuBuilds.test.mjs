/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The builds of FMUs from their sources kept on this computer (docs/proposals/sourceFmuImport.md, stage 3), without a compiler; building
// and running the Reference FMUs is tests/engine/fmuSourceImport.mjs.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { buildInstalledFmu, confirmedArchives, rememberConfirmedArchive, buildKey, buildsDirectoryOf, cachedBuild, currentBuildFor, firstError, portableSteps, removeBuilds } from '../src/fmuBuilds.mjs';
import { installFmuArchive, uninstallFmu } from '../src/fmuPackage.mjs';
import { platformTuple } from '../src/fmiBinary.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pidSourcesOnly = async () => Buffer.from(zipSync(Object.fromEntries(Object.entries(unzipSync(new Uint8Array(await readFile(join(import.meta.dirname, '..', 'examples', 'pidController', 'PidController.fmu'))))).filter(([name]) => !name.startsWith('binaries/')))));

test('a failed build says the compiler\'s first error', () => {
    assert.equal(firstError('Compiling model.c failed:\n/tmp/b/sources/model.c:3:1: error: expected \';\'\n  3 | }\n1 error generated.'), '/tmp/b/sources/model.c:3:1: error: expected \';\'');
    assert.equal(firstError('Linking Model.dylib failed:\nld: library not found for -lsundials'), 'ld: library not found for -lsundials');
    assert.equal(firstError(''), 'The compiler stopped without saying why.');
});

test('the key is the same for the same build in another folder, and changes with anything that changes the library', () => {
    const steps = (folder, headers) => [{ what: 'Compiling model.c', compiler: '/usr/bin/clang', arguments: ['-c', `-I${headers}/fmi3`, `-I${folder}/sources`, `${folder}/sources/model.c`, '-o', `${folder}/objects/0_model.o`] }];
    const one = portableSteps(steps('/tmp/building-a', '/app/engine/include/fmiStandard'), { buildFolder: '/tmp/building-a', headersDirectory: '/app/engine/include/fmiStandard' });
    const two = portableSteps(steps('/tmp/building-b', '/other/engine/include/fmiStandard'), { buildFolder: '/tmp/building-b', headersDirectory: '/other/engine/include/fmiStandard' });
    assert.deepEqual(one, two);
    assert.deepEqual(one[0].arguments, ['-c', '-I<headers>/fmi3', '-I<build>/sources', '<build>/sources/model.c', '-o', '<build>/objects/0_model.o']);
    const base = { archiveSha256: 'a'.repeat(64), compiler: '/usr/bin/clang', banner: 'clang 18', tuple: 'x86_64-linux', steps: one, recipe: null, headers: 'h' };
    const key = buildKey(base);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(buildKey({ ...base }), key);
    for (const change of [{ archiveSha256: 'b'.repeat(64) }, { banner: 'clang 19' }, { tuple: 'aarch64-linux' }, { steps: [{ ...one[0], arguments: [...one[0].arguments, '-O2'] }] }, { recipe: { name: 'OpenModelica', version: 1 } }, { headers: 'other' }]) {
        assert.notEqual(buildKey({ ...base, ...change }), key, JSON.stringify(change));
    }
});

test('a kept build is run only when its library is the one recorded, for this computer, and goes with its FMU', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateFmuBuilds-'));
    try {
        const installed = await installFmuArchive(await pidSourcesOnly(), { directory });
        const archiveSha256 = JSON.parse(await readFile(join(installed.installPath, 'fmuMeta.json'), 'utf8')).archiveSha256;
        const builds = buildsDirectoryOf(directory);
        const key = 'c'.repeat(64);
        const library = Buffer.from('a library');
        await mkdir(join(builds, key), { recursive: true });
        await writeFile(join(builds, key, 'PidController.dylib'), library);
        await writeFile(join(builds, key, 'build.json'), JSON.stringify({ key, archiveSha256, tuple: platformTuple(), library: 'PidController.dylib', librarySha256: sha256(library), banner: 'clang' }));
        await mkdir(join(builds, 'byArchive'), { recursive: true });
        await writeFile(join(builds, 'byArchive', `${archiveSha256}.json`), JSON.stringify({ key }));
        assert.equal((await currentBuildFor(directory, archiveSha256)).libraryPath, join(builds, key, 'PidController.dylib'));
        assert.equal(await currentBuildFor(directory, archiveSha256, 'some-other-platform'), null, 'Not for another platform.');
        await writeFile(join(builds, key, 'PidController.dylib'), 'changed');
        assert.equal(await cachedBuild(builds, key), null, 'A library that is not the one recorded is not run.');
        await writeFile(join(builds, 'byArchive', `${archiveSha256}.json`), JSON.stringify({ key: '../../etc' }));
        assert.equal(await currentBuildFor(directory, archiveSha256), null, 'A pointer that is not a key is not followed.');
        await uninstallFmu({ directory, guid: installed.guid, version: installed.version });
        assert.equal(await readFile(join(builds, key, 'build.json')).catch(() => null), null, 'Its builds go when the FMU is uninstalled.');
        await removeBuilds(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('what cannot be built is refused before anything runs: no build information, a problem, no compiler', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateFmuBuilds-'));
    try {
        const installed = await installFmuArchive(await pidSourcesOnly(), { directory });
        const never = async () => { throw new Error('nothing may run'); };
        const outcome = await buildInstalledFmu({ fmuDirectory: directory, guid: installed.guid, version: installed.version, engine: '/no/engine', sdkPath: '/no/sdk', compiler: { message: 'Building this FMU needs a C compiler.' }, confirm: never });
        assert.deepEqual(outcome, { status: 'refused', name: 'PidController', message: 'Building this FMU needs a C compiler.' });
        const library = Buffer.from(zipSync({ ...unzipSync(new Uint8Array(await pidSourcesOnly())), 'sources/buildDescription.xml': new TextEncoder().encode('<fmiBuildDescription fmiVersion="3.0"><BuildConfiguration modelIdentifier="PidController"><SourceFileSet><SourceFile name="PidController.c"/></SourceFileSet><Library name="sundials"/></BuildConfiguration></fmiBuildDescription>') }));
        const withLibrary = await installFmuArchive(library, { directory, version: '2.0.0' });
        const refused = await buildInstalledFmu({ fmuDirectory: directory, guid: withLibrary.guid, version: withLibrary.version, engine: '/no/engine', sdkPath: '/no/sdk', compiler: { compiler: 'cc', flavor: 'gcc', banner: 'cc' }, confirm: never });
        assert.equal(refused.status, 'refused');
        assert.match(refused.message, /^Konjugate cannot build PidController: it needs the library sundials/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

// The one fmuSourceImport failure (FMI review group 2): two builds at once, one rewriting confirmed.json while the other read it, read it
// empty. Whatever is read while files are being written is a whole file.
test('the archives confirmed, read while another build writes them, are always a whole list', async () => {
    const builds = await mkdtemp(join(tmpdir(), 'konjugateFmuBuildsRace-'));
    try {
        // A long list, as a computer that has built many FMUs keeps: the longer the file, the longer a write that is not whole takes.
        await writeFile(join(builds, 'confirmed.json'), JSON.stringify(Array.from({ length: 20000 }, (_, index) => `f${index.toString(16).padStart(63, '0')}`)));
        await rememberConfirmedArchive(builds, 'a'.repeat(64));
        // Writers one after another, as builds that confirm in turn; readers reading the whole time, as a build starting meanwhile.
        let writing = true;
        const writers = (async () => {
            try {
                for (let index = 0; index < 30; index += 1) await rememberConfirmedArchive(builds, index.toString(16).padStart(64, '0'));
            } finally {
                writing = false;
            }
        })();
        const readers = Array.from({ length: 2 }, async () => {
            try {
                while (writing) await confirmedArchives(builds);
            } catch (error) {
                writing = false;
                throw error;
            }
        });
        await Promise.all([writers, ...readers]);
        assert.ok((await confirmedArchives(builds)).has('a'.repeat(64)));
    } finally {
        await rm(builds, { recursive: true, force: true });
    }
});
