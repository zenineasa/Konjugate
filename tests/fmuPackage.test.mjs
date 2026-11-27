/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { installFmuArchive, installedFmuArchive, installProjectAttachments, listInstalledFmus, sha256Hex, uninstallFmu, inspectFmuArchive, FmuPackageError } from '../src/fmuPackage.mjs';
import { readFile as readBytes, unlink, writeFile as writeBytes } from 'node:fs/promises';

function fmuBytes({ guid = 'guid-1', modelName = 'TestModel' } = {}) {
    const xml = `<?xml version="1.0"?>
<fmiModelDescription fmiVersion="2.0" modelName="${modelName}" guid="${guid}" generationTool="Test">
    <CoSimulation modelIdentifier="testModel" canGetAndSetFMUstate="true"/>
    <ModelVariables>
        <ScalarVariable name="x" valueReference="0" causality="output"><Real start="0"/></ScalarVariable>
    </ModelVariables>
</fmiModelDescription>`;
    return zipSync({
        'modelDescription.xml': new TextEncoder().encode(xml),
        'binaries/darwin64/testModel.dylib': new TextEncoder().encode('fake-binary')
    }, { level: 0 });
}

async function withScratchDirectory(callback) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateFmuPackageTest-'));
    try {
        await callback(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('inspectFmuArchive rejects a non-FMU zip', () => {
    const notAnFmu = zipSync({ 'readme.txt': new TextEncoder().encode('hi') }, { level: 0 });
    assert.throws(() => inspectFmuArchive(notAnFmu), /doesn't look like an FMU/);
});

test('install, list, and uninstall an FMU round-trips correctly', async () => {
    await withScratchDirectory(async (directory) => {
        const installed = await installFmuArchive(fmuBytes(), { directory, displayName: 'My Model', version: '2.0.0' });
        assert.equal(installed.guid, 'guid-1');
        assert.equal(installed.version, '2.0.0');
        assert.deepEqual(installed.platforms, ['darwin64']);

        const listed = await listInstalledFmus(directory);
        assert.equal(listed.length, 1);
        assert.equal(listed[0].packageId, 'guid-1');
        assert.equal(listed[0].name, 'My Model');
        assert.equal(listed[0].version, '2.0.0');
        assert.equal(listed[0].packageType, 'fmu');

        await uninstallFmu({ directory, guid: 'guid-1', version: '2.0.0' });
        assert.equal((await listInstalledFmus(directory)).length, 0);
    });
});

test('installing the same guid/version twice without overwrite is rejected', async () => {
    await withScratchDirectory(async (directory) => {
        await installFmuArchive(fmuBytes(), { directory, version: '1.0.0' });
        await assert.rejects(
            installFmuArchive(fmuBytes(), { directory, version: '1.0.0' }),
            (error) => error instanceof FmuPackageError && error.code === 'ALREADY_INSTALLED'
        );
    });
});

test('installing without a version defaults to 1.0.0', async () => {
    await withScratchDirectory(async (directory) => {
        const installed = await installFmuArchive(fmuBytes(), { directory });
        assert.equal(installed.version, '1.0.0');
    });
});

test('two different guids install side by side independently', async () => {
    await withScratchDirectory(async (directory) => {
        await installFmuArchive(fmuBytes({ guid: 'guid-a' }), { directory, version: '1.0.0' });
        await installFmuArchive(fmuBytes({ guid: 'guid-b' }), { directory, version: '1.0.0' });
        const listed = await listInstalledFmus(directory);
        assert.equal(listed.length, 2);
        assert.deepEqual(listed.map((entry) => entry.packageId).sort(), ['guid-a', 'guid-b']);
    });
});

test('uninstalling a never-installed FMU is rejected clearly', async () => {
    await withScratchDirectory(async (directory) => {
        await assert.rejects(
            uninstallFmu({ directory, guid: 'nope', version: '1.0.0' }),
            (error) => error instanceof FmuPackageError && error.code === 'NOT_INSTALLED'
        );
    });
});

test('an FMU with no binaries directory is rejected', () => {
    const xml = `<?xml version="1.0"?>
<fmiModelDescription fmiVersion="2.0" modelName="M" guid="g" generationTool="Test">
    <CoSimulation modelIdentifier="m"/>
    <ModelVariables></ModelVariables>
</fmiModelDescription>`;
    const archive = zipSync({ 'modelDescription.xml': new TextEncoder().encode(xml) }, { level: 0 });
    assert.throws(() => inspectFmuArchive(archive), /no binaries/);
});

// What a project keeps of an FMU (docs/proposals/fmuImportWorkflow.md, stage 8).
test('an installed FMU keeps the archive it came from, and its SHA-256, for a project to keep', async () => {
    await withScratchDirectory(async (directory) => {
        const archive = fmuBytes();
        const installed = await installFmuArchive(archive, { directory });
        const kept = await installedFmuArchive(directory, installed.guid, installed.version);
        assert.deepEqual(new Uint8Array(kept.buffer), archive);
        assert.equal(kept.sha256, sha256Hex(archive));
        assert.equal(kept.name, 'TestModel.fmu');
        assert.equal((await listInstalledFmus(directory))[0].manifest.archiveSha256, sha256Hex(archive));
        assert.equal(await installedFmuArchive(directory, 'nope', '1.0.0'), null);
    });
});

test('an FMU installed before archives were kept gives the same zipped archive every time', async () => {
    await withScratchDirectory(async (directory) => {
        const installed = await installFmuArchive(fmuBytes(), { directory });
        const root = join(directory, 'fmus', installed.guid, installed.version);
        // As an install from before: no archive, no SHA-256.
        await unlink(join(root, 'archive.fmu'));
        const meta = JSON.parse(await readBytes(join(root, 'fmuMeta.json'), 'utf8'));
        delete meta.archiveSha256;
        await writeBytes(join(root, 'fmuMeta.json'), JSON.stringify(meta));
        const first = await installedFmuArchive(directory, installed.guid, installed.version);
        await unlink(join(root, 'archive.fmu'));
        const second = await installedFmuArchive(directory, installed.guid, installed.version);
        assert.equal(first.sha256, second.sha256, 'The same files zip to the same bytes.');
        assert.ok(inspectFmuArchive(first.buffer).description.guid === 'guid-1', 'It is an FMU.');
    });
});

test('opening a project installs the FMUs it keeps that this computer lacks, and uses the ones it has', async () => {
    await withScratchDirectory(async (directory) => {
        const archive = fmuBytes();
        const sha256 = sha256Hex(archive);
        const project = JSON.stringify({ nodes: [{ id: 1, name: 'Tank', implementation: { kind: 'fmi', fmuId: 'guid-1', fmuVersion: '1.0.0', fmuSha256: sha256 } }] });
        const attachments = [{ kind: 'fmu', name: 'TestModel.fmu', sha256, buffer: Buffer.from(archive) }];
        const first = await installProjectAttachments(directory, project, attachments);
        assert.deepEqual(first, { content: project, installed: ['TestModel'] });
        assert.equal((await listInstalledFmus(directory)).length, 1);
        // Opened again: nothing to install.
        assert.deepEqual(await installProjectAttachments(directory, project, attachments), { content: project, installed: [] });
        // Another FMU with the same id and version installed here: the project's goes beside it, and its nodes refer to it.
        const other = fmuBytes({ modelName: 'Changed' });
        const otherSha = sha256Hex(other);
        const otherProject = JSON.stringify({ nodes: [{ id: 2, name: 'Tank', implementation: { kind: 'fmi', fmuId: 'guid-1', fmuVersion: '1.0.0', fmuSha256: otherSha } }] });
        const placed = await installProjectAttachments(directory, otherProject, [{ kind: 'fmu', name: 'Changed.fmu', sha256: otherSha, buffer: Buffer.from(other) }]);
        assert.equal(JSON.parse(placed.content).nodes[0].implementation.fmuVersion, `1.0.0+${otherSha.slice(0, 8)}`);
        assert.deepEqual((await listInstalledFmus(directory)).map((entry) => entry.version).sort(), ['1.0.0', `1.0.0+${otherSha.slice(0, 8)}`]);
        // An attachment no node refers to is left alone.
        assert.deepEqual(await installProjectAttachments(directory, JSON.stringify({ nodes: [] }), attachments), { content: JSON.stringify({ nodes: [] }), installed: [] });
    });
});

// FMI review M3: the limit on an FMU's total unpacked size held only once every file was unpacked, so an archive of a few hundred
// kilobytes could make Konjugate inflate hundreds of megabytes before refusing it. Each entry says its unpacked size before it is
// unpacked; the total is checked as the entries come, and the archive refused at the first one over the limit, unpacked or not. Here
// four 60 MB files (240 MB) and a fifth whose data is damaged: refused for its size, it is never inflated, so its damage never shows.
test('an FMU whose files add up to more than the unpacked limit is refused before they are unpacked', () => {
    const sixtyMegabytes = new Uint8Array(60 * 1024 * 1024);
    const archive = zipSync({
        'modelDescription.xml': new TextEncoder().encode('<?xml version="1.0"?><fmiModelDescription fmiVersion="2.0" modelName="Big" guid="big"><CoSimulation modelIdentifier="big"/></fmiModelDescription>'),
        ...Object.fromEntries([1, 2, 3, 4, 5].map((index) => [`resources/part${index}.bin`, sixtyMegabytes]))
    });
    // Damage the fifth file's compressed data, past its local header (30 bytes and its name).
    const name = new TextEncoder().encode('resources/part5.bin');
    const header = Buffer.from(archive).indexOf(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04])]), Buffer.from(archive).indexOf(Buffer.from(name)) - 30);
    archive.fill(0xff, header + 30 + name.length, header + 30 + name.length + 64);
    assert.ok(archive.length < 2 * 1024 * 1024, 'The archive itself is small.');
    assert.throws(() => inspectFmuArchive(archive), (error) => error instanceof FmuPackageError && error.code === 'ARCHIVE_LIMIT' && /expanded FMU size/.test(error.message));
});
