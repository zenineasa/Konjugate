/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { installFmuArchive, listInstalledFmus, uninstallFmu, inspectFmuArchive, FmuPackageError } from '../src/fmuPackage.mjs';

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
