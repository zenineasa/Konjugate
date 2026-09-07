/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Structural unit tests for src/fmiResolver.mjs, mirroring tests/fmiCodeGen.test.mjs's style and
// scope: a real installed FMU only needs a well-formed modelDescription.xml here (its "binary" is
// never actually loaded by these tests -- only hashed and path-embedded), so these run fast and
// without a C++ compiler. Full end-to-end fidelity against a REAL compiled FMU is covered by
// tests/engine/fmiImportFidelity.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { installFmuArchive } from '../src/fmuPackage.mjs';
import { resolveFmiSource, resolveInstalledFmus, FmiResolutionError } from '../src/fmiResolver.mjs';
import { packageKey } from '../src/packageArchive.mjs';

function fakeFmuBytes({ guid = 'guid-1', variables = '' } = {}) {
    const xml = `<?xml version="1.0"?>
<fmiModelDescription fmiVersion="2.0" modelName="Decay" guid="${guid}" generationTool="Test">
    <CoSimulation modelIdentifier="decayModel" canGetAndSetFMUstate="false"/>
    <ModelVariables>${variables}</ModelVariables>
</fmiModelDescription>`;
    return zipSync({
        'modelDescription.xml': new TextEncoder().encode(xml),
        [`binaries/${process.platform === 'win32' ? 'win64' : process.platform === 'darwin' ? 'darwin64' : 'linux64'}/decayModel${process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so'}`]:
            new TextEncoder().encode('fake-binary-bytes')
    }, { level: 0 });
}

const decayVariables = `
    <ScalarVariable name="Decay.Level" valueReference="0" causality="output" variability="continuous"><Real start="10"/></ScalarVariable>
    <ScalarVariable name="k" valueReference="1" causality="input" variability="continuous"><Real start="0.3"/></ScalarVariable>
`;

async function withInstalledFmu(callback, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateFmiResolverTest-'));
    try {
        const installed = await installFmuArchive(fakeFmuBytes({ variables: decayVariables, ...options }), { directory, version: '1.0.0' });
        await callback(directory, installed);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('resolves a valid fmi implementation into a cpp node-provider implementation', async () => {
    await withInstalledFmu(async (directory, installed) => {
        const resolved = await resolveFmiSource({
            kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version,
            bindings: [{ key: 'k', kind: 'state', stateId: 11 }],
            outputs: [{ key: 'decayLevel', stateId: 12 }]
        }, directory);
        assert.equal(resolved.kind, 'cpp');
        assert.equal(resolved.providerApiVersion, 1);
        assert.ok(resolved.source.includes('createNodeProvider'));
        assert.ok(resolved.source.includes(installed.guid));
        // No synthetic feedback binding: bindings pass through unchanged, and every output is
        // marked setsValue instead (see src/fmiResolver.mjs's file header comment).
        assert.equal(resolved.bindings.length, 1);
        assert.equal(resolved.bindings[0].key, 'k');
        assert.equal(resolved.outputs.length, 1);
        assert.equal(resolved.outputs[0].key, 'decayLevel');
        assert.equal(resolved.outputs[0].setsValue, true);
        assert.ok(resolved.source.includes('outputs.addGradient("decayLevel", static_cast<double>(outputValues[0]));'));
    });
});

test('sanitizes a dotted FMU variable name into a valid lower-camel-case key', async () => {
    await withInstalledFmu(async (directory, installed) => {
        const resolved = await resolveFmiSource({
            kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version,
            bindings: [{ key: 'k', kind: 'state', stateId: 11 }],
            outputs: [{ key: 'decayLevel', stateId: 12 }]
        }, directory);
        assert.ok(resolved.source.includes('"decayLevel"'));
    });
});

test('rejects a missing binding for a real FMU input', async () => {
    await withInstalledFmu(async (directory, installed) => {
        await assert.rejects(
            resolveFmiSource({ kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [], outputs: [{ key: 'decayLevel', stateId: 12 }] }, directory),
            (error) => error instanceof FmiResolutionError && error.code === 'FMU_BINDING_MISSING'
        );
    });
});

test('rejects a binding key that does not name a real FMU input', async () => {
    await withInstalledFmu(async (directory, installed) => {
        await assert.rejects(
            resolveFmiSource({
                kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version,
                bindings: [{ key: 'k', kind: 'state', stateId: 11 }, { key: 'bogus', kind: 'state', stateId: 11 }],
                outputs: [{ key: 'decayLevel', stateId: 12 }]
            }, directory),
            (error) => error instanceof FmiResolutionError && error.code === 'FMU_BINDING_UNKNOWN'
        );
    });
});

test('rejects a missing outputs entry for a real FMU output', async () => {
    await withInstalledFmu(async (directory, installed) => {
        await assert.rejects(
            resolveFmiSource({ kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [{ key: 'k', kind: 'state', stateId: 11 }], outputs: [] }, directory),
            (error) => error instanceof FmiResolutionError && error.code === 'FMU_OUTPUT_MISSING'
        );
    });
});

test('rejects an outputs entry that does not name a real FMU output', async () => {
    await withInstalledFmu(async (directory, installed) => {
        await assert.rejects(
            resolveFmiSource({
                kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version,
                bindings: [{ key: 'k', kind: 'state', stateId: 11 }],
                outputs: [{ key: 'decayLevel', stateId: 12 }, { key: 'bogus', stateId: 99 }]
            }, directory),
            (error) => error instanceof FmiResolutionError && error.code === 'FMU_OUTPUT_UNKNOWN'
        );
    });
});

test('rejects a reference to an FMU that is not installed', async () => {
    await withInstalledFmu(async (directory) => {
        await assert.rejects(
            resolveFmiSource({ kind: 'fmi', fmuId: 'never-installed', fmuVersion: '1.0.0', bindings: [], outputs: [] }, directory),
            (error) => error instanceof FmiResolutionError && error.code === 'FMU_NOT_INSTALLED'
        );
    });
});

test('rejects a disabled FMU', async () => {
    await withInstalledFmu(async (directory, installed) => {
        await assert.rejects(
            resolveFmiSource(
                { kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [{ key: 'k', kind: 'state', stateId: 11 }], outputs: [{ key: 'decayLevel', stateId: 12 }] },
                directory,
                [packageKey('fmu', installed.guid, installed.version)]
            ),
            (error) => error instanceof FmiResolutionError && error.code === 'FMU_DISABLED'
        );
    });
});

test('rejects a malformed fmuId/fmuVersion reference', async () => {
    await withInstalledFmu(async (directory) => {
        await assert.rejects(
            resolveFmiSource({ kind: 'fmi', fmuId: '', fmuVersion: '1.0.0', bindings: [], outputs: [] }, directory),
            (error) => error instanceof FmiResolutionError && error.code === 'FMU_REFERENCE_INVALID'
        );
    });
});

test('two FMU variables that sanitize to the same key are rejected, not silently aliased', async () => {
    await withInstalledFmu(async (directory, installed) => {
        await assert.rejects(
            resolveFmiSource({
                kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version,
                bindings: [{ key: 'k', kind: 'state', stateId: 11 }],
                outputs: [{ key: 'decayLevel', stateId: 12 }]
            }, directory),
            () => true
        );
    }, { variables: `
        <ScalarVariable name="Decay.Level" valueReference="0" causality="output"><Real start="10"/></ScalarVariable>
        <ScalarVariable name="decayLevel" valueReference="2" causality="output"><Real start="0"/></ScalarVariable>
        <ScalarVariable name="k" valueReference="1" causality="input"><Real start="0.3"/></ScalarVariable>
    ` });
});

test('resolveInstalledFmus walks node implementations and leaves non-fmi kinds untouched', async () => {
    await withInstalledFmu(async (directory, installed) => {
        const document = {
            format: 'konjugate', version: 1,
            nodes: [
                { id: 1, name: 'Imported', states: [{ id: 11, name: 'K', symbol: 'k' }, { id: 12, name: 'Level', symbol: 'level' }], sourceTerms: [], implementation: {
                    kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version,
                    bindings: [{ key: 'k', kind: 'state', stateId: 11 }], outputs: [{ key: 'decayLevel', stateId: 12 }]
                } },
                { id: 2, name: 'Plain', states: [], sourceTerms: [] }
            ],
            edges: []
        };
        const resolved = JSON.parse(await resolveInstalledFmus(document, { fmuDirectory: directory }));
        assert.equal(resolved.nodes[0].implementation.kind, 'cpp');
        assert.equal(resolved.nodes[1].implementation, undefined);
    });
});
