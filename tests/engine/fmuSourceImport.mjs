/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Building an FMU from its sources on import (docs/proposals/sourceFmuImport.md, stage 3), with the FMI Reference FMUs:
//   1. Every Co-Simulation case of FMI 2.0 and 3.0, its FMU with binaries/ removed, installed, built here and run: every output at
//      every communication point equals the same case on the FMU's shipped binary, bit for bit (decision 8: the shipped macOS arm64
//      binaries are clang's, as this build is; elsewhere a difference is reported with its size).
//   2. The cache: a second build builds nothing and asks nothing; another compiler builds again without asking; a corrupted library
//      is built again; two builds of one FMU at once build once.
//   3. Declining builds nothing, and the run says the FMU needs building; the refusals say why (no compiler, a compile error, a flag
//      outside the allow-list, a library, a path leaving sources/, the time limit); an FMU with neither binaries nor build information,
//      or Model Exchange only, is refused at inspection.
//   4. The installed FMU and a project keeping it are the same bytes before and after a build.
//   5. Stage 5: an FMU with a binary of its own built on request runs the build in its place, and its own binary again after Use its own
//      binary; Save FMU with this computer's binary gives an FMU that installs and runs here with no build, as the shipped one does; Clear
//      FMU builds leaves none.
//
//   node tests/engine/fmuSourceImport.mjs [path/to/konjugateEngine]
// The engine given builds (its buildFmuSources); runs use the development engine, as the app does.

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { runWithEngine } from '../../src/engineAdapter.mjs';
import { buildInstalledFmu, buildsKept, currentBuildFor, fmuWithThisComputersBinary, removeBuilds, setBuildPreferred } from '../../src/fmuBuilds.mjs';
import { inspectFmuArchive, installedFmuArchive, installFmuArchive, uninstallFmu } from '../../src/fmuPackage.mjs';
import { describeInstalledFmuPorts } from '../../src/fmiResolver.mjs';
import { findCCompiler } from '../../src/fmuSourceBuild.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { referenceCases, referenceFmuArchive, referenceHostDocument } from './fixtures/referenceFmuFidelity.mjs';

const root = join(import.meta.dirname, '..', '..');
const builder = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const sdkPath = join(root, 'engine');
const compiler = await findCCompiler();
if (compiler.message) {
    console.log(`  (skipping building FMUs from their sources on import: no C compiler here -- ${compiler.message})`);
    process.exit(0);
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// An FMU archive changed by `change(files)`, which edits the map of entries (binaries/ taken out by default).
const edited = (archive, change = () => {}) => {
    const files = Object.fromEntries(Object.entries(unzipSync(new Uint8Array(archive))).filter(([name]) => !name.startsWith('binaries/')));
    change(files);
    return Buffer.from(zipSync(files));
};

const packages = await mkdtemp(join(tmpdir(), 'konjugateFmuSourceImport-'));
const options = { applicationPath: root, resourcesPath: '', packaged: false, fmuDirectory: packages, disabledFmuKeys: [] };
const lines = [];
let version = 0;
const install = async (archive) => installFmuArchive(archive, { directory: packages, version: `1.0.${version++}` });
const build = (installed, extra = {}) => buildInstalledFmu({ fmuDirectory: packages, guid: installed.guid, version: installed.version, engine: builder, sdkPath, compiler, ...extra });

async function runCase(installed, testCase) {
    const ports = await describeInstalledFmuPorts(packages, installed.guid, installed.version);
    const document = referenceHostDocument({ guid: installed.guid, version: installed.version, ports, values: testCase.values, stepSize: testCase.stepSize });
    const outcome = await runWithEngine(JSON.stringify(document),
        { targetTime: testCase.stopTime, globalTimeStep: testCase.stepSize, outputInterval: testCase.stepSize, pacing: { mode: 'fastest' } }, options);
    if (!outcome.result) throw new Error(`${ports.name}: ${outcome.error ?? outcome.diagnostics}`);
    return outcome.result.samples;
}

try {
    // 1. Built on import, bit for bit against the shipped binary.
    let compared = 0;
    const differences = [];
    for (const fmiVersion of ['2.0', '3.0']) {
        for (const testCase of referenceCases.cases) {
            const what = `FMI ${fmiVersion} ${testCase.name}`;
            const archive = await referenceFmuArchive(fmiVersion, testCase.name);
            const shipped = await install(archive);
            const sourcesOnly = await install(edited(archive));
            const asked = [];
            const outcome = await build(sourcesOnly, { confirm: async (summary) => { asked.push(summary); return true; } });
            assert.equal(outcome.status, 'built', `${what}: ${outcome.message ?? outcome.status}\n${outcome.log ?? ''}`);
            assert.equal(asked.length, 1, `${what}: asked once before building.`);
            assert.equal(asked[0].banner, compiler.banner);
            const expected = await runCase(shipped, testCase);
            const actual = await runCase(sourcesOnly, testCase);
            assert.equal(actual.length, expected.length);
            expected.forEach((sample, index) => sample.states.forEach((state, at) => {
                const value = actual[index].states[at].value;
                compared += 1;
                if (!Object.is(value, state.value)) differences.push({ what, time: sample.time, gap: Math.abs(value - state.value) });
            }));
        }
    }
    if (process.platform === 'darwin' && process.arch === 'arm64') {
        assert.deepEqual(differences, [], 'Built here with clang, every case equals the shipped clang binary bit for bit.');
        lines.push(`${referenceCases.cases.length * 2} Reference FMUs built on import ran bit for bit as their shipped binaries (${compared} values)`);
    } else {
        const largest = differences.reduce((most, item) => Math.max(most, item.gap), 0);
        lines.push(`${referenceCases.cases.length * 2} Reference FMUs built on import: ${differences.length} of ${compared} values differ from the shipped binaries, largest ${largest}`);
    }

    // 2. The cache.
    const dahlquist = await referenceFmuArchive('3.0', 'Dahlquist');
    const cached = await install(edited(dahlquist));
    const first = await build(cached);
    assert.equal(first.status, 'built');
    const askedAgain = [];
    const second = await build(cached, { confirm: async () => { askedAgain.push(true); return true; } });
    assert.deepEqual([second.status, second.record.key, askedAgain.length], ['cached', first.record.key, 0], 'A second build builds nothing and asks nothing.');
    const changed = await build(cached, { compiler: { ...compiler, banner: `${compiler.banner} (updated)` }, confirm: async () => { askedAgain.push(true); return true; } });
    assert.equal(changed.status, 'built', 'Another compiler builds again.');
    assert.notEqual(changed.record.key, first.record.key);
    assert.equal(askedAgain.length, 0, 'An archive once confirmed is built again without asking.');
    await writeFile(changed.libraryPath, 'not a library');
    assert.equal(await currentBuildFor(packages, changed.record.archiveSha256), null, 'A corrupted library is not run.');
    assert.equal((await build(cached, { compiler: { ...compiler, banner: `${compiler.banner} (updated)` } })).status, 'built', 'A corrupted library is built again.');
    await removeBuilds(packages, first.record.archiveSha256);
    const together = await Promise.all([build(cached), build(cached)]);
    assert.deepEqual(together.map((outcome) => outcome.status).sort(), ['built', 'cached'], 'Two builds of one FMU at once build once.');
    lines.push('a kept build is used, a new compiler or a corrupted library builds again, and two builds at once build once');

    // 3. Declined, and refused.
    const feedthrough = await install(edited(await referenceFmuArchive('3.0', 'Feedthrough')));
    assert.equal((await build(feedthrough, { confirm: async () => false })).status, 'declined');
    await assert.rejects(runCase(feedthrough, referenceCases.cases.find((item) => item.name === 'Feedthrough')), /needs to be built from its sources on this computer/);
    assert.match((await build(feedthrough, { compiler: { message: 'Building this FMU needs a C compiler.' } })).message, /needs a C compiler/);
    const brokenSource = await install(edited(dahlquist, (files) => { files['sources/model.c'] = strToU8('this is not C;\n'); }));
    const broken = await build(brokenSource);
    assert.equal(broken.status, 'failed');
    assert.match(broken.message, /error/i);
    assert.match(broken.log, /Compiling model\.c failed/);
    const describe = (attributes, inside = '') => (files) => {
        files['sources/buildDescription.xml'] = strToU8(`<fmiBuildDescription fmiVersion="3.0"><BuildConfiguration modelIdentifier="Dahlquist"><SourceFileSet language="C99" ${attributes}><SourceFile name="model.c"/>${inside}</SourceFileSet></BuildConfiguration></fmiBuildDescription>`);
    };
    const refusal = async (change) => (await build(await install(edited(dahlquist, change)))).message;
    assert.match(await refusal(describe('compilerOptions="-O2 -fplugin=/tmp/x.so"')), /asks the compiler for -fplugin=\/tmp\/x\.so/);
    assert.match(await refusal((files) => { describe('')(files); files['sources/buildDescription.xml'] = strToU8(strFromU8(files['sources/buildDescription.xml']).replace('</BuildConfiguration>', '<Library name="sundials" external="true"/></BuildConfiguration>')); }), /needs the library sundials/);
    assert.match(await refusal(describe('', '<SourceFile name="../../escape.c"/>')), /not a path inside its sources/);
    if (process.platform !== 'win32') {
        const hanging = join(packages, 'hangingCompiler');
        await writeFile(hanging, '#!/bin/sh\nsleep 60\n');
        await chmod(hanging, 0o755);
        const slow = await build(await install(edited(dahlquist, (files) => { files['sources/note.txt'] = strToU8('another archive'); })), { compiler: { compiler: hanging, flavor: 'clang', banner: 'a compiler that hangs' }, timeoutSeconds: 1 });
        assert.equal(slow.status, 'failed');
        assert.match(slow.message, /took longer than 1 s/);
    }
    assert.throws(() => inspectFmuArchive(edited(dahlquist, (files) => { delete files['sources/buildDescription.xml']; for (const name of Object.keys(files)) if (name.startsWith('sources/')) delete files[name]; })), /there is nothing to load/);
    assert.throws(() => inspectFmuArchive(edited(dahlquist, (files) => { files['modelDescription.xml'] = strToU8(strFromU8(files['modelDescription.xml']).replace(/<CoSimulation[\s\S]*?\/>/, '')); })), /Model Exchange|Co-Simulation/);
    lines.push('declining builds nothing and the run says it needs building; no compiler, a compile error, a disallowed flag, a library, a path out of sources/ and the time limit are refused in words');

    // 4. Nothing the project keeps changes.
    const kept = await install(edited(await referenceFmuArchive('2.0', 'VanDerPol')));
    const folderHash = async () => {
        const folder = join(packages, 'fmus', kept.guid, kept.version);
        const entries = (await readdir(folder, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath ?? entry.path, entry.name)).sort();
        const hash = createHash('sha256');
        for (const path of entries) hash.update(relative(folder, path)).update(await readFile(path));
        return hash.digest('hex');
    };
    const project = async () => {
        const archive = await installedFmuArchive(packages, kept.guid, kept.version);
        return sha256(await encodeProjectFile(JSON.stringify({ format: 'konjugate', version: 1, nodes: [], edges: [] }), { attachments: [{ kind: 'fmu', name: archive.sha256, buffer: archive.buffer }] }));
    };
    const before = [await folderHash(), await project()];
    assert.equal((await build(kept)).status, 'built');
    assert.deepEqual([await folderHash(), await project()], before, 'The installed FMU and the project are the same bytes after a build.');
    await uninstallFmu({ directory: packages, guid: kept.guid, version: kept.version });
    lines.push('the installed FMU and a project keeping it are byte-identical before and after a build');

    // 5. On request, in place of its own binary; saved with this computer's binary; cleared.
    const vanDerPol = referenceCases.cases.find((item) => item.name === 'VanDerPol');
    const ownArchive = await referenceFmuArchive('3.0', 'VanDerPol');
    const own = await install(ownArchive);
    const shippedRun = await runCase(own, vanDerPol);
    const same = (one, two) => one.length === two.length && one.every((sample, index) => sample.states.every((state, at) => Object.is(state.value, two[index].states[at].value)));
    const requested = await build(own, { prefer: true, confirm: async (summary) => { assert.equal(summary.hasOwnBinary, true); return true; } });
    assert.equal(requested.status, 'built');
    const preferredPorts = await describeInstalledFmuPorts(packages, own.guid, own.version);
    assert.match(preferredPorts.binary, /Runs the build of its sources made on this computer .*, in place of its own binary\./);
    assert.deepEqual([preferredPorts.about.hasOwnBinary, Boolean(preferredPorts.about.built), preferredPorts.about.buildKept], [true, true, true]);
    const builtRun = await runCase(own, vanDerPol);
    if (process.platform === 'darwin' && process.arch === 'arm64') assert.ok(same(builtRun, shippedRun), 'Its build runs as its own binary, bit for bit.');
    await setBuildPreferred(packages, requested.record.archiveSha256, false);
    const ownAgain = await describeInstalledFmuPorts(packages, own.guid, own.version);
    assert.deepEqual([Boolean(ownAgain.about.built), ownAgain.about.buildKept], [false, true], 'Use its own binary keeps the build.');
    assert.doesNotMatch(ownAgain.binary, /build of its sources/);
    assert.ok(same(await runCase(own, vanDerPol), shippedRun));

    const sourcesFirst = await install(edited(ownArchive));
    assert.equal(await fmuWithThisComputersBinary(packages, sourcesFirst.guid, sourcesFirst.version), null, 'Nothing to save before it is built.');
    assert.equal((await build(sourcesFirst)).status, 'built');
    const saved = await fmuWithThisComputersBinary(packages, sourcesFirst.guid, sourcesFirst.version);
    const savedEntries = Object.keys(unzipSync(new Uint8Array(saved.buffer)));
    assert.ok(savedEntries.some((name) => name.startsWith(`binaries/${saved.directory}/`)), 'The saved FMU carries this computer\'s binary.');
    assert.ok(savedEntries.includes('sources/buildDescription.xml'), 'and its sources, as it came.');
    await removeBuilds(packages);
    assert.deepEqual(await buildsKept(packages), { count: 0, bytes: 0 }, 'Clear FMU builds leaves none.');
    const savedInstalled = await install(saved.buffer);
    const savedPorts = await describeInstalledFmuPorts(packages, savedInstalled.guid, savedInstalled.version);
    assert.deepEqual([savedPorts.about.runsHere, savedPorts.about.hasOwnBinary, Boolean(savedPorts.about.built)], [true, true, false], 'The saved FMU runs here on its own binary.');
    const savedRun = await runCase(savedInstalled, vanDerPol);
    if (process.platform === 'darwin' && process.arch === 'arm64') assert.ok(same(savedRun, shippedRun), 'The saved FMU runs as the shipped one, bit for bit.');
    lines.push('built on request it runs in place of its own binary until Use its own binary; saved with this computer\'s binary it runs with no build; Clear FMU builds leaves none');

    console.log(`✓ Source FMU import: ${lines.join('; ')}.`);
} finally {
    await rm(packages, { recursive: true, force: true });
}
