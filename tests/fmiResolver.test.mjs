/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Structural unit tests for src/fmiResolver.mjs, mirroring tests/fmiCodeGen.test.mjs's style and
// scope: a real installed FMU only needs a well-formed modelDescription.xml here (its "binary" is
// never actually loaded by these tests -- only hashed and path-embedded), so these run fast and
// without a C++ compiler. Full end-to-end fidelity against a REAL compiled FMU is covered by
// tests/engine/fmiImportFidelity.mjs.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';
import { installFmuArchive } from '../src/fmuPackage.mjs';
import { describeInstalledFmuPorts, resolveFmiSource, resolveInstalledFmus, FmiResolutionError } from '../src/fmiResolver.mjs';
import { fmiArchitecture } from '../src/fmiBinary.mjs';
import { packageKey } from '../src/packageArchive.mjs';

// FMI review #5: a switched-off FMU node does not stop the model, whether its FMU is installed or not, nor count as a second instance.
test('a switched-off FMU node is not resolved: an FMU missing from the library, or one that runs once at a time, does not stop the model', async () => {
    const node = (id, name, implementation, extra = {}) => ({ id, name, states: [{ id: id * 10, symbol: 'level' }], implementation: { ...implementation, outputs: [{ key: 'decayLevel', stateId: id * 10 }] }, ...extra });
    await withInstalledFmu(async (directory, installed) => {
        const reference = { kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [] };
        const missing = { kind: 'fmi', fmuId: 'not-in-this-library', fmuVersion: '1.0.0', bindings: [] };
        const document = { format: 'konjugate', version: 1, edges: [], nodes: [node(1, 'Tank A', reference), node(2, 'Tank B', reference, { enabled: false }), node(3, 'Elsewhere', missing, { enabled: false })] };
        const resolved = JSON.parse(await resolveInstalledFmus(document, { fmuDirectory: directory }));
        assert.equal(resolved.nodes[0].implementation.kind, 'cpp');
        assert.deepEqual(resolved.nodes.slice(1).map((entry) => [entry.enabled, entry.implementation?.kind ?? null]), [[false, null], [false, null]], 'Switched off, it reaches the engine without its FMU.');
        // Switched on, the missing FMU is said as before.
        await assert.rejects(resolveInstalledFmus({ ...document, nodes: [node(3, 'Elsewhere', missing)] }, { fmuDirectory: directory }), /is not installed/);
    }, { coSimulation: ' canBeInstantiatedOnlyOncePerProcess="true"' });
});

const thisPlatformBinary = `binaries/${process.platform === 'win32' ? 'win64' : process.platform === 'darwin' ? 'darwin64' : 'linux64'}/decayModel${process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so'}`;

function fakeFmuBytes({ guid = 'guid-1', variables = '', binaryPath = thisPlatformBinary, coSimulation = '' } = {}) {
    const xml = `<?xml version="1.0"?>
<fmiModelDescription fmiVersion="2.0" modelName="Decay" guid="${guid}" generationTool="Test">
    <CoSimulation modelIdentifier="decayModel" canGetAndSetFMUstate="false"${coSimulation}/>
    <ModelVariables>${variables}</ModelVariables>
</fmiModelDescription>`;
    return zipSync({
        'modelDescription.xml': new TextEncoder().encode(xml),
        [binaryPath]: new TextEncoder().encode('fake-binary-bytes')
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
        // The generated source is the FMU's variable table for the shared driver (konjugate/fmiImportedNode.hpp).
        assert.ok(resolved.source.includes('konjugate::fmi::makeImportedFmu2({'));
        assert.ok(resolved.source.includes('{"k", "k", 1u, ValueType::float64, Role::input}'));
        assert.ok(resolved.source.includes('{"decayLevel", "Decay.Level", 0u, ValueType::float64, Role::output}'));
        // FMI 2.0 gives an FMU its resources directory as a file: URI.
        assert.ok(resolved.source.includes(`"${pathToFileURL(join(directory, 'fmus', installed.guid, installed.version, 'resources')).href}"`));
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

test('an input or parameter with no binding keeps the FMU\'s start value: it is left out of the table the driver sets', async () => {
    await withInstalledFmu(async (directory, installed) => {
        const resolved = await resolveFmiSource({ kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [], outputs: [{ key: 'decayLevel', stateId: 12 }] }, directory);
        assert.deepEqual(resolved.bindings, []);
        assert.equal(resolved.source.includes('Role::input'), false, 'k is not set by the driver at all.');
        assert.ok(resolved.source.includes('{"decayLevel", "Decay.Level", 0u, ValueType::float64, Role::output}'));
        assert.ok(resolved.source.endsWith('Role::output}\n        }\n    });\n}\n'), 'No given values follow the table.');
    });
});

test('a variable with no start value of its own must be bound or given a value', async () => {
    const variables = `${decayVariables}
    <ScalarVariable name="gain" valueReference="2" causality="parameter" variability="tunable" initial="exact"><Real/></ScalarVariable>`;
    await withInstalledFmu(async (directory, installed) => {
        const reference = { kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, outputs: [{ key: 'decayLevel', stateId: 12 }] };
        await assert.rejects(resolveFmiSource({ ...reference, bindings: [] }, directory),
            (error) => error instanceof FmiResolutionError && error.code === 'FMU_BINDING_MISSING' && /'gain' has no start value of its own/.test(error.message));
        const resolved = await resolveFmiSource({ ...reference, bindings: [{ key: 'gain', kind: 'value', value: 2 }] }, directory);
        assert.ok(resolved.source.includes('{{"gain", "gain", 2u, ValueType::float64, Role::tunableParameter}, 2.0}'));
    }, { variables });
});

test('a value given in the file is set once when the run starts, and is not one of the node\'s inputs', async () => {
    await withInstalledFmu(async (directory, installed) => {
        const resolved = await resolveFmiSource({
            kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version,
            bindings: [{ key: 'k', kind: 'value', value: 0.125 }], outputs: [{ key: 'decayLevel', stateId: 12 }]
        }, directory);
        assert.deepEqual(resolved.bindings, [], 'The engine sees no binding for it.');
        assert.ok(resolved.source.endsWith(`        {
        {"decayLevel", "Decay.Level", 0u, ValueType::float64, Role::output}
        },
        {
        {{"k", "k", 1u, ValueType::float64, Role::input}, 0.125}
        }
    });
}
`), 'The given value follows the variable table.');
        for (const [value, literal] of [[3, '3.0'], [-2.5, '-2.5'], [1e21, '1e+21'], [1e-7, '1e-7']]) {
            const given = await resolveFmiSource({ kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [{ key: 'k', kind: 'value', value }], outputs: [{ key: 'decayLevel', stateId: 12 }] }, directory);
            assert.ok(given.source.includes(`Role::input}, ${literal}}`), `${value} is written as ${literal}.`);
        }
        for (const value of [Number.NaN, '1', null]) {
            await assert.rejects(resolveFmiSource({ kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [{ key: 'k', kind: 'value', value }], outputs: [{ key: 'decayLevel', stateId: 12 }] }, directory),
                (error) => error.code === 'FMU_VALUE_INVALID');
        }
        await assert.rejects(resolveFmiSource({ kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [{ key: 'k', kind: 'value', value: 1 }, { key: 'k', kind: 'state', stateId: 3 }], outputs: [{ key: 'decayLevel', stateId: 12 }] }, directory),
            (error) => error.code === 'FMU_BINDING_DUPLICATE');
    });
});

test('a node that binds every input writes the same source as before start values, with no given values', async () => {
    await withInstalledFmu(async (directory, installed) => {
        const resolved = await resolveFmiSource({
            kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version,
            bindings: [{ key: 'k', kind: 'state', stateId: 11 }], outputs: [{ key: 'decayLevel', stateId: 12 }]
        }, directory);
        assert.ok(resolved.source.endsWith(`        {
        {"k", "k", 1u, ValueType::float64, Role::input},
        {"decayLevel", "Decay.Level", 0u, ValueType::float64, Role::output}
        }
    });
}
`));
    });
});

test('the host takes the fmuStartValues requirement off the document before the engine sees it, and keeps the others', async () => {
    await withInstalledFmu(async (directory, installed) => {
        const node = { id: 1, name: 'Decay', states: [], implementation: { kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [], outputs: [{ key: 'decayLevel', stateId: 12 }] } };
        const alone = JSON.parse(await resolveInstalledFmus({ format: 'konjugate', version: 1, requires: ['fmuStartValues'], nodes: [node], edges: [] }, { fmuDirectory: directory }));
        assert.equal('requires' in alone, false);
        const others = JSON.parse(await resolveInstalledFmus({ format: 'konjugate', version: 1, requires: ['somethingNewer', 'fmuStartValues'], nodes: [node], edges: [] }, { fmuDirectory: directory }));
        assert.deepEqual(others.requires, ['somethingNewer'], 'An entry this host does not apply still reaches the engine, which refuses it by name.');
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

test('an FMU with no binary for this computer installs, and running it is refused naming this computer', async () => {
    // Only a binary for a computer Konjugate never runs on: no binaries/ directory for this one, under either standard's name.
    await withInstalledFmu(async (directory, installed) => {
        const machine = `${fmiArchitecture()}-${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'}`;
        await assert.rejects(
            resolveFmiSource({
                kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version,
                bindings: [{ key: 'k', kind: 'state', stateId: 11 }], outputs: [{ key: 'decayLevel', stateId: 12 }]
            }, directory),
            (error) => error instanceof FmiResolutionError && error.code === 'FMU_PLATFORM_MISSING'
                && error.message.startsWith(`FMU Decay (${installed.guid}) cannot run here: it has no binary this computer (${machine}) can run. `)
        );
    }, { binaryPath: 'binaries/riscv64-linux/decayModel.so' });
});

// An FMU is no longer switched off in Extensions (switching its node off does that), so a settings file from an older Konjugate that
// lists one as disabled changes nothing: the model runs.
test('an FMU an older Konjugate listed as disabled still resolves', async () => {
    await withInstalledFmu(async (directory, installed) => {
        const implementation = { kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [{ key: 'k', kind: 'state', stateId: 11 }], outputs: [{ key: 'decayLevel', stateId: 12 }] };
        const olderList = [packageKey('fmu', installed.guid, installed.version)];
        const resolved = await resolveFmiSource(implementation, directory, olderList);
        assert.equal(resolved.kind, 'cpp', 'The FMU runs as a node program.');
        const content = JSON.stringify({ format: 'konjugate', version: 1, nodes: [{ id: 1, name: 'Decay', states: [{ id: 11, symbol: 'k' }, { id: 12, symbol: 'level' }], sourceTerms: [], implementation }], edges: [] });
        const document = JSON.parse(await resolveInstalledFmus(content, { fmuDirectory: directory, disabledFmuKeys: olderList }));
        assert.equal(document.nodes[0].implementation.kind, 'cpp', 'resolveInstalledFmus runs it too, whatever disabledFmuKeys an older caller passes.');
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

test('an installed FMU\'s ports are described under the keys a node\'s implementation uses, for the node editor to wire', async () => {
    await withInstalledFmu(async (directory, installed) => {
        const { about: { archiveSha256, archiveBytes, ...about }, ...ports } = await describeInstalledFmuPorts(directory, installed.guid, installed.version);
        // The archive a project keeps of it (stage 8): the one it was installed from, by its SHA-256.
        const archive = await readFile(join(directory, 'fmus', installed.guid, installed.version, 'archive.fmu'));
        assert.equal(archiveBytes, archive.length);
        assert.equal(archiveSha256, createHash('sha256').update(archive).digest('hex'));
        const binaryDirectory = process.platform === 'win32' ? 'win64' : process.platform === 'darwin' ? 'darwin64' : 'linux64';
        // What the node's card shows of the FMU (docs/proposals/fmuImportWorkflow.md, stage 3).
        assert.deepEqual(about, {
            modelName: 'Decay', fmiVersion: '2.0', generationTool: 'Test',
            coSimulation: { canHandleVariableCommunicationStepSize: false, canSerializeFMUState: false, canBeInstantiatedOnlyOncePerProcess: false, needsExecutionTool: false },
            canGetAndSetFMUState: false, platforms: [binaryDirectory], runsHere: true, hasOwnBinary: true
        });
        assert.deepEqual(ports, {
            name: 'Decay', fmiVersion: '2.0',
            inputs: [{ key: 'k', name: 'k', causality: 'input', type: 'Real', variability: 'continuous', start: 0.3 }],
            outputs: [{ key: 'decayLevel', name: 'Decay.Level', type: 'Real', start: 10 }],
            notExposed: [],
            binary: `Runs binaries/${binaryDirectory}/decayModel${process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so'}.`
        });
        await assert.rejects(describeInstalledFmuPorts(directory, installed.guid, '9.9.9'), /is not installed/);
        await assert.rejects(describeInstalledFmuPorts(directory, '../escape', '1.0.0'), /unsafe/);
    });
});

// Refusals a connection of FMUs meets (docs/proposals/fmuImportWorkflow.md, stage 5).
test('an FMU that needs its exporting tool running beside it is refused by name', async () => {
    await withInstalledFmu(async (directory, installed) => {
        await assert.rejects(resolveFmiSource({ kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [], outputs: [{ key: 'decayLevel', stateId: 12 }] }, directory),
            (error) => error.code === 'FMU_NEEDS_TOOL' && /needs the tool it was exported from/.test(error.message));
    }, { coSimulation: ' needsExecutionTool="true"' });
});

test('an FMU that can run only once at a time is refused as a second node, naming both; once is fine', async () => {
    const node = (id, name, implementation) => ({ id, name, states: [{ id: id * 10, symbol: 'level' }], implementation: { ...implementation, outputs: [{ key: 'decayLevel', stateId: id * 10 }] } });
    await withInstalledFmu(async (directory, installed) => {
        const reference = { kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [] };
        const one = { format: 'konjugate', version: 1, nodes: [node(1, 'Tank A', reference)], edges: [] };
        assert.equal(JSON.parse(await resolveInstalledFmus(one, { fmuDirectory: directory })).nodes[0].implementation.kind, 'cpp');
        const two = { ...one, nodes: [...one.nodes, node(2, 'Tank B', reference)] };
        await assert.rejects(resolveInstalledFmus(two, { fmuDirectory: directory }),
            (error) => error.code === 'FMU_ONCE_PER_PROCESS' && /2 nodes use it: 'Tank A', 'Tank B'/.test(error.message));
    }, { coSimulation: ' canBeInstantiatedOnlyOncePerProcess="true"' });
    // Without the flag, two nodes are two instances.
    await withInstalledFmu(async (directory, installed) => {
        const reference = { kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, bindings: [] };
        const two = { format: 'konjugate', version: 1, nodes: [node(1, 'Tank A', reference), node(2, 'Tank B', reference)], edges: [] };
        assert.deepEqual(JSON.parse(await resolveInstalledFmus(two, { fmuDirectory: directory })).nodes.map((entry) => entry.implementation.kind), ['cpp', 'cpp']);
    });
});
