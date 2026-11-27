/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Reading an FMU's build information (docs/proposals/sourceFmuImport.md, stage 1). tests/fixtures/fmuSources/referenceFmus holds the
// descriptions of the FMI Reference FMUs v0.0.42 BouncingBall (FMI 2.0 and 3.0, BSD 2-Clause, its LICENSE.txt beside them) and each
// FMU's list of archive entries, so this runs without the release zip; OpenModelica's PID controller is the one in examples/.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { chooseBuildConfiguration, fmuBuildInformation, parseBuildDescription, recogniseExporter } from '../src/fmuBuildInformation.mjs';
import { parseModelDescription } from '../src/fmiModelDescription.mjs';
import { platformTuple } from '../src/fmiBinary.mjs';
import { inspectFmuArchive, installFmuArchive } from '../src/fmuPackage.mjs';
import { describeInstalledFmuPorts } from '../src/fmiResolver.mjs';
import { buildInformationLine, fmuAboutLines } from '../src/nodeProgram.mjs';

const here = join(import.meta.dirname, 'fixtures', 'fmuSources', 'referenceFmus');
const reference = async (version) => ({
    description: parseModelDescription(await readFile(join(here, version, 'modelDescription.xml'), 'utf8')),
    names: (await readFile(join(here, version, 'entries.txt'), 'utf8')).trim().split('\n'),
    buildDescriptionXml: version === '3.0' ? await readFile(join(here, version, 'buildDescription.xml'), 'utf8') : null
});
const pidArchive = () => readFile(join(import.meta.dirname, '..', 'examples', 'pidController', 'PidController.fmu'));
// The archive without the entries `drop` says: an FMU as it would be with its binaries (or more) taken out.
const without = (archive, drop) => Buffer.from(zipSync(Object.fromEntries(Object.entries(unzipSync(new Uint8Array(archive))).filter(([name]) => !drop(name)))));
const buildDescription = (configurations) => `<?xml version="1.0" encoding="UTF-8"?>
<fmiBuildDescription fmiVersion="3.0">${configurations}</fmiBuildDescription>`;

test('FMI 3.0\'s buildDescription.xml is read: its configuration, source files, language and definitions', async () => {
    const parsed = parseBuildDescription((await reference('3.0')).buildDescriptionXml);
    assert.equal(parsed.fmiVersion, '3.0');
    assert.deepEqual(parsed.configurations, [{
        modelIdentifier: 'BouncingBall', platform: null, description: null,
        sourceFileSets: [{
            name: null, language: 'C99', compiler: null, compilerOptions: null,
            sourceFiles: ['fmi3Functions.c', 'model.c', 'common.c', 'cosimulation.c'],
            definitions: [{ name: 'FMI_VERSION', value: '3', optionValues: [] }], includeDirectories: []
        }],
        libraries: []
    }]);
    const build = fmuBuildInformation({ ...(await reference('3.0')), tuple: 'x86_64-darwin' });
    assert.equal(build.from, 'buildDescription');
    assert.equal(build.sourceFileCount, 4);
    assert.equal(build.language, 'C');
    assert.deepEqual(build.problems, []);
    assert.equal(build.exporter, null);
    assert.equal(buildInformationLine(build, { runsHere: false }), 'Sources only: Konjugate can build it, 4 C files from its buildDescription.xml');
    assert.equal(buildInformationLine(build, { runsHere: true }), 'It also carries its sources: 4 C files, from its buildDescription.xml');
});

test('FMI 2.0\'s <SourceFiles> is read when there is no buildDescription.xml', async () => {
    const { description, names } = await reference('2.0');
    assert.deepEqual(description.sourceFiles, ['all.c']);
    const build = fmuBuildInformation({ description, names });
    assert.equal(build.from, 'sourceFiles');
    assert.deepEqual(build.configuration.sourceFileSets.map((set) => [set.language, set.sourceFiles]), [['C', ['all.c']]]);
    assert.deepEqual(build.problems, []);
    // Nothing to build from: neither a buildDescription.xml nor <SourceFiles>.
    assert.equal(fmuBuildInformation({ description: { ...description, sourceFiles: undefined }, names }), null);
});

test('in an FMI 2.0.4 FMU a buildDescription.xml takes precedence over <SourceFiles>', async () => {
    const { description, names } = await reference('2.0');
    const xml = buildDescription(`<BuildConfiguration modelIdentifier="BouncingBall"><SourceFileSet language="C99"><SourceFile name="model.c"/><SourceFile name="fmi2Functions.c"/><PreprocessorDefinition name="FMI_VERSION" value="2"/></SourceFileSet></BuildConfiguration>`);
    const build = fmuBuildInformation({ description, names, buildDescriptionXml: xml });
    assert.equal(build.from, 'buildDescription');
    assert.deepEqual(build.configuration.sourceFileSets[0].sourceFiles, ['model.c', 'fmi2Functions.c']);
});

test('the configuration for this platform is chosen, else the one without a platform, else none, said why', () => {
    const configurations = parseBuildDescription(buildDescription(`
        <BuildConfiguration modelIdentifier="M" platform="x86_64-windows"><SourceFileSet><SourceFile name="windows.c"/></SourceFileSet></BuildConfiguration>
        <BuildConfiguration modelIdentifier="M"><SourceFileSet><SourceFile name="any.c"/></SourceFileSet></BuildConfiguration>
        <BuildConfiguration modelIdentifier="Other" platform="aarch64-darwin"><SourceFileSet><SourceFile name="other.c"/></SourceFileSet></BuildConfiguration>`)).configurations;
    assert.equal(chooseBuildConfiguration(configurations, 'M', 'x86_64-windows').configuration.sourceFileSets[0].sourceFiles[0], 'windows.c');
    assert.equal(chooseBuildConfiguration(configurations, 'M', 'aarch64-darwin').configuration.sourceFileSets[0].sourceFiles[0], 'any.c', 'Another model identifier\'s configuration is never taken.');
    assert.equal(chooseBuildConfiguration(configurations.filter((item) => item.platform), 'M', 'aarch64-darwin').problem,
        'its buildDescription.xml builds M for x86_64-windows only, not for this computer (aarch64-darwin)');
    assert.equal(chooseBuildConfiguration(configurations, 'Missing', 'aarch64-darwin').problem, 'its buildDescription.xml has no build configuration for Missing (only for M, Other)');
    assert.match(chooseBuildConfiguration([...configurations, configurations[1]], 'M', 'aarch64-darwin').problem, /has 2 build configurations for M without a platform/);
    assert.match(platformTuple({ platform: 'darwin', arch: 'arm64' }), /^aarch64-darwin$/);
    assert.equal(platformTuple({ platform: 'win32', arch: 'x64' }), 'x86_64-windows');
    assert.equal(platformTuple({ platform: 'linux', arch: 'x64' }), 'x86_64-linux');
});

test('what would stop a build is said by name: a library, a path out of sources/, a missing file, another language', async () => {
    const { description, names } = await reference('3.0');
    const problems = (sets, libraries = '') => fmuBuildInformation({ description, names, buildDescriptionXml: buildDescription(`<BuildConfiguration modelIdentifier="BouncingBall">${sets}${libraries}</BuildConfiguration>`) }).problems;
    assert.deepEqual(problems('<SourceFileSet><SourceFile name="model.c"/></SourceFileSet>', '<Library name="sundials" external="true"/>'),
        ['it needs the library sundials from this computer, and Konjugate does not build FMUs with libraries yet']);
    assert.deepEqual(problems('<SourceFileSet><SourceFile name="../../etc/passwd.c"/><SourceFile name="/tmp/x.c"/><SourceFile name="nowhere.c"/><IncludeDirectory name="../include"/></SourceFileSet>'), [
        'it lists ../../etc/passwd.c, which is not a path inside its sources',
        'it lists /tmp/x.c, which is not a path inside its sources',
        'it lists nowhere.c, which is not in its sources',
        'it asks to include ../include, which is not a folder inside its sources'
    ]);
    assert.deepEqual(problems('<SourceFileSet language="Fortran"><SourceFile name="model.c"/></SourceFileSet>'), ['its sources are in Fortran, and Konjugate builds C and C++ only']);
    assert.deepEqual(problems('<SourceFileSet language="C++17"><SourceFile name="model.c"/></SourceFileSet>'), []);
    assert.deepEqual(problems(''), ['it lists no source file to compile']);
    assert.match(fmuBuildInformation({ description, names, buildDescriptionXml: '<not closed' }).problems[0], /^its buildDescription.xml cannot be read: it is not valid XML/);
    const refused = fmuBuildInformation({ description, names, buildDescriptionXml: buildDescription('<BuildConfiguration modelIdentifier="BouncingBall"><SourceFileSet><SourceFile name="nowhere.c"/></SourceFileSet></BuildConfiguration>') });
    assert.equal(buildInformationLine(refused, { runsHere: false }), 'Sources only, and Konjugate cannot build it: it lists nowhere.c, which is not in its sources');
});

test('OpenModelica\'s PID controller is recognised by its tool and the runtime it carries, and only then', async () => {
    const { description, files, build } = inspectFmuArchive(await pidArchive());
    assert.equal(build.from, 'sourceFiles');
    assert.equal(build.sourceFileCount, 113);
    assert.deepEqual(build.problems, []);
    assert.deepEqual(build.exporter, { id: 'openModelica', name: 'OpenModelica', version: '1.27.1' });
    assert.equal(recogniseExporter(description, ['sources/model.c']), null, 'Naming OpenModelica is not enough without its runtime.');
    assert.equal(recogniseExporter({ generationTool: 'Reference FMUs (v0.0.42)' }, Object.keys(files)), null);
});

test('an FMU with sources and no binaries is accepted, installed, and About says Konjugate can build it; one with neither is refused as before', async () => {
    const archive = await pidArchive();
    const sourcesOnly = without(archive, (name) => name.startsWith('binaries/'));
    const inspected = inspectFmuArchive(sourcesOnly);
    assert.deepEqual(inspected.platforms, []);
    assert.equal(inspected.build.sourceFileCount, 113);
    const bare = without(archive, (name) => name.startsWith('binaries/') || name.startsWith('sources/'));
    // With no <SourceFiles> either: its description's list taken out too.
    const text = Buffer.from(unzipSync(new Uint8Array(bare))['modelDescription.xml']).toString('utf8').replace(/<SourceFiles>[\s\S]*<\/SourceFiles>/, '');
    const neither = Buffer.from(zipSync({ ...unzipSync(new Uint8Array(bare)), 'modelDescription.xml': new TextEncoder().encode(text) }));
    assert.throws(() => inspectFmuArchive(neither), { message: 'The FMU has no binaries/<platform>/ directory -- there is nothing to load.' });

    const directory = await mkdtemp(join(tmpdir(), 'konjugateFmuSources-'));
    try {
        const installed = await installFmuArchive(sourcesOnly, { directory });
        const ports = await describeInstalledFmuPorts(directory, installed.guid, installed.version);
        assert.equal(ports.about.runsHere, false);
        const { recipe, ...summary } = ports.about.build;
        assert.deepEqual(summary, { from: 'sourceFiles', modelIdentifier: 'PidController', platform: platformTuple(), sourceFileCount: 113, language: 'C', exporter: { id: 'openModelica', name: 'OpenModelica', version: '1.27.1' }, problems: [] });
        assert.equal(recipe.name, 'OpenModelica', 'Built with OpenModelica\'s recipe (stage 4).');
        assert.ok(fmuAboutLines(ports.about).includes('Sources only: Konjugate can build it, 113 C files from its <SourceFiles> (exported by OpenModelica 1.27.1)'));
        // The same FMU with its binaries says it carries its sources as well.
        const both = await installFmuArchive(archive, { directory, version: '2.0.0' });
        const withBinaries = await describeInstalledFmuPorts(directory, both.guid, both.version);
        if (withBinaries.about.runsHere) assert.ok(fmuAboutLines(withBinaries.about).includes('It also carries its sources: 113 C files, from its <SourceFiles>'));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
