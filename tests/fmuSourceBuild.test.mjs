/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The plan and the compiler for building an FMU from its sources (docs/proposals/sourceFmuImport.md, stage 2). The engine's own build
// of the Reference FMUs is tests/engine/fmuSourceBuild.mjs.

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fmuBuildInformation } from '../src/fmuBuildInformation.mjs';
import { parseModelDescription } from '../src/fmiModelDescription.mjs';
import { cDriverFor, compilerOptionsOf, findCCompiler, fmuSourceBuildPlan, languageOf, missingCompilerMessage, missingFlavorMessage, runProgram } from '../src/fmuSourceBuild.mjs';

const here = join(import.meta.dirname, 'fixtures', 'fmuSources', 'referenceFmus');
const referenceBuild = async (version, buildDescriptionXml = null) => fmuBuildInformation({
    description: parseModelDescription(await readFile(join(here, version, 'modelDescription.xml'), 'utf8')),
    names: (await readFile(join(here, version, 'entries.txt'), 'utf8')).trim().split('\n'),
    buildDescriptionXml: buildDescriptionXml ?? (version === '3.0' ? await readFile(join(here, version, 'buildDescription.xml'), 'utf8') : null)
});
const where = { sourceRoot: '/build/sources', headersDirectory: '/engine/include/fmiStandard', objectDirectory: '/build/objects', output: '/build/BouncingBall.dylib' };

test('a source file set\'s language is the engine\'s language and standard', () => {
    assert.deepEqual(languageOf('C99'), { language: 'c', standard: 'gnu99' }, 'C99 as its GNU dialect: strict c99 hides strdup in glibc.');
    assert.deepEqual(languageOf('C'), { language: 'c', standard: '' });
    assert.deepEqual(languageOf(undefined), { language: 'c', standard: '' });
    assert.deepEqual(languageOf('C18'), { language: 'c', standard: 'gnu17' });
    assert.deepEqual(languageOf('C++17'), { language: 'c++', standard: 'c++17' });
    assert.deepEqual(languageOf('C++'), { language: 'c++', standard: '' });
    assert.equal(languageOf('Fortran'), null);
});

test('compilerOptions pass only from an allow-list, and the first other flag is named', () => {
    assert.deepEqual(compilerOptionsOf('-O2 -std=c11 -Wall -Wno-unused -fno-strict-aliasing'), { flags: ['-O2', '-std=c11', '-Wall', '-Wno-unused', '-fno-strict-aliasing'] });
    assert.deepEqual(compilerOptionsOf('/O2 /W3 /std:c11'), { flags: ['/O2', '/W3', '/std:c11'] });
    for (const flag of ['-B/tmp', '-fplugin=x.so', '@args.txt', '-o', '/FIevil.h', '-Wl,-rpath,/x', '-Wp,-include,/etc/passwd', '-include', '-I/etc', '-L/usr/lib', '-DX=1', '"-O2"']) {
        assert.deepEqual(compilerOptionsOf(`-O2 ${flag}`), { refused: flag }, flag);
    }
});

test('the C driver is the one beside the C++ compiler', () => {
    assert.equal(cDriverFor('/Library/Developer/CommandLineTools/usr/bin/clang++'), '/Library/Developer/CommandLineTools/usr/bin/clang');
    assert.equal(cDriverFor('/usr/bin/g++'), '/usr/bin/gcc');
    assert.equal(cDriverFor('x86_64-linux-gnu-g++-12'), 'x86_64-linux-gnu-gcc-12');
    assert.equal(cDriverFor('clang++-17'), 'clang-17');
    assert.equal(cDriverFor('c++'), 'cc');
    assert.equal(cDriverFor('C:\\VS\\bin\\Hostx64\\x64\\cl.exe'), 'C:\\VS\\bin\\Hostx64\\x64\\cl.exe');
    assert.equal(cDriverFor('/opt/icx'), null);
});

test('the plan compiles each set with its standard and definitions against the FMI standard\'s headers, exporting unprefixed names', async () => {
    const three = fmuSourceBuildPlan(await referenceBuild('3.0'), { fmiVersion: '3.0', ...where });
    assert.deepEqual(three.problems, []);
    assert.deepEqual(three.plan, {
        sourceRoot: '/build/sources', objectDirectory: '/build/objects', output: '/build/BouncingBall.dylib', timeoutSeconds: 300,
        includeFirst: ['/engine/include/fmiStandard/fmi3'],
        sets: [{
            language: 'c', standard: 'gnu99', files: ['fmi3Functions.c', 'model.c', 'common.c', 'cosimulation.c'],
            definitions: ['FMI3_OVERRIDE_FUNCTION_PREFIX', 'FMI_VERSION=3'], includeDirectories: []
        }],
        libraries: ['m'], threads: false
    });
    const two = fmuSourceBuildPlan(await referenceBuild('2.0'), { fmiVersion: '2.0', ...where });
    assert.deepEqual(two.plan.sets, [{ language: 'c', standard: '', files: ['all.c'], definitions: ['FMI2_OVERRIDE_FUNCTION_PREFIX'], includeDirectories: [] }]);
    assert.deepEqual(two.plan.includeFirst, ['/engine/include/fmiStandard/fmi2']);
    // A recipe (stage 4) adds definitions, libraries and threads.
    const recipe = fmuSourceBuildPlan(await referenceBuild('2.0'), { fmiVersion: '2.0', ...where, recipe: { definitions: ['OMC_FMI_RUNTIME=1'], libraries: ['pthread'], threads: true } });
    assert.deepEqual([recipe.plan.sets[0].definitions, recipe.plan.libraries, recipe.plan.threads], [['FMI2_OVERRIDE_FUNCTION_PREFIX', 'OMC_FMI_RUNTIME=1'], ['m', 'pthread'], true]);
});

test('a disallowed flag refuses the build, and a compiler of another family is said, not obeyed', async () => {
    const xml = (attributes) => `<fmiBuildDescription fmiVersion="3.0"><BuildConfiguration modelIdentifier="BouncingBall"><SourceFileSet language="C99" ${attributes}><SourceFile name="model.c"/></SourceFileSet></BuildConfiguration></fmiBuildDescription>`;
    const refused = fmuSourceBuildPlan(await referenceBuild('3.0', xml('compilerOptions="-O2 -fplugin=/tmp/x.so"')), { fmiVersion: '3.0', ...where });
    assert.deepEqual(refused.problems, ['its build description asks the compiler for -fplugin=/tmp/x.so, which Konjugate does not pass on']);
    const passed = fmuSourceBuildPlan(await referenceBuild('3.0', xml('compilerOptions="-O2 -Wall" compiler="gcc"')), { fmiVersion: '3.0', ...where, compilerFamily: 'clang' });
    assert.deepEqual(passed.problems, []);
    assert.deepEqual(passed.plan.sets[0].compilerOptions, ['-O2', '-Wall']);
    assert.deepEqual(passed.notes, ['Its build description asks for gcc; Konjugate builds it with clang.']);
    assert.deepEqual(fmuSourceBuildPlan(null, { fmiVersion: '3.0', ...where }).problems, ['it says nothing about building it']);
});

// A computer as findCCompiler sees it: the programs that run (by command), the files that exist.
const computer = ({ programs = {}, files = {} }) => ({
    run: async (command, args) => {
        const program = programs[command];
        if (!program) return { code: null, stdout: '', stderr: '' };
        return typeof program === 'function' ? program(args) : program;
    },
    exists: (path) => path in files,
    readText: (path) => files[path] ?? null
});

test('the compiler is found per platform, and a computer without one is told what to install', async () => {
    const appleClang = { code: 0, stdout: 'Apple clang version 21.0.0 (clang-2100.3.34.2)\nTarget: arm64-apple-darwin25.6.0\n', stderr: '' };
    const mac = computer({ programs: { xcrun: { code: 0, stdout: '/Library/Developer/CommandLineTools/usr/bin/clang\n', stderr: '' }, '/Library/Developer/CommandLineTools/usr/bin/clang': appleClang } });
    assert.deepEqual(await findCCompiler({ platform: 'darwin', ...mac }), { compiler: '/Library/Developer/CommandLineTools/usr/bin/clang', flavor: 'clang', banner: 'Apple clang version 21.0.0 (clang-2100.3.34.2)' });
    assert.deepEqual(await findCCompiler({ platform: 'darwin', ...computer({}) }), { message: missingCompilerMessage('darwin') });
    assert.match(missingCompilerMessage('darwin'), /xcode-select --install/);

    // Windows: MSVC found by vswhere, at its default tools version, else clang or gcc on PATH.
    const vs = 'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools';
    const cl = `${vs}\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\cl.exe`;
    const windows = computer({
        programs: {
            'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe': { code: 0, stdout: `${vs}\r\n`, stderr: '' },
            [cl]: { code: 0, stdout: '', stderr: 'Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35207 for x64\r\nusage: cl [ option... ] filename...' }
        },
        files: { 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe': '', [`${vs}\\VC\\Auxiliary\\Build\\Microsoft.VCToolsVersion.default.txt`]: '14.44.35207\r\n', [cl]: '' }
    });
    assert.deepEqual(await findCCompiler({ platform: 'win32', arch: 'x64', environment: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, ...windows }),
        { compiler: cl, flavor: 'msvc', banner: 'Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35207 for x64' });
    const gccOnly = computer({ programs: { gcc: { code: 0, stdout: 'gcc.exe (Rev2, Built by MSYS2 project) 14.2.0\n', stderr: '' } } });
    assert.equal((await findCCompiler({ platform: 'win32', environment: {}, ...gccOnly })).compiler, 'gcc');
    assert.deepEqual(await findCCompiler({ platform: 'win32', environment: {}, ...computer({}) }), { message: missingCompilerMessage('win32') });
    // An exporter's recipe asking for GCC or clang (OpenModelica's): MSVC is not looked for, GCC before clang, and none says what to install.
    const allThree = computer({
        programs: { gcc: { code: 0, stdout: 'gcc.exe (Rev2, Built by MSYS2 project) 14.2.0\n', stderr: '' },
            'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe': { code: 0, stdout: `${vs}\r\n`, stderr: '' },
            [cl]: { code: 0, stdout: '', stderr: 'Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35207 for x64' },
            clang: { code: 0, stdout: 'clang version 20.1.8\nTarget: x86_64-pc-windows-msvc\n', stderr: '' } },
        files: { 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe': '', [`${vs}\\VC\\Auxiliary\\Build\\Microsoft.VCToolsVersion.default.txt`]: '14.44.35207\r\n', [cl]: '' }
    });
    const environment = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
    assert.equal((await findCCompiler({ platform: 'win32', arch: 'x64', environment, ...allThree })).flavor, 'msvc', 'With no recipe, MSVC first.');
    assert.deepEqual(await findCCompiler({ platform: 'win32', arch: 'x64', environment, flavors: ['gcc', 'clang'], ...allThree }),
        { compiler: 'gcc', flavor: 'gcc', banner: 'gcc.exe (Rev2, Built by MSYS2 project) 14.2.0' });
    assert.deepEqual(await findCCompiler({ platform: 'win32', arch: 'x64', environment, flavors: ['clang', 'gcc'], ...allThree }),
        { compiler: 'clang', flavor: 'clang', banner: 'clang version 20.1.8' });
    assert.deepEqual(await findCCompiler({ platform: 'win32', arch: 'x64', environment, flavors: ['gcc', 'clang'], ...windows }), { message: missingFlavorMessage('win32', ['gcc', 'clang']) });
    assert.match(missingFlavorMessage('win32', ['gcc', 'clang']), /^Building this FMU needs GCC or clang, which this computer does not have: install MinGW-w64's GCC/);
    assert.deepEqual(await findCCompiler({ platform: 'linux', flavors: ['gcc', 'clang'], ...computer({ programs: { cc: { code: 0, stdout: 'cc (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0\n', stderr: '' } } }) }),
        { compiler: 'cc', flavor: 'gcc', banner: 'cc (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0' }, 'Elsewhere cc, gcc, clang as before, of the flavors asked.');
    assert.match(missingCompilerMessage('win32'), /Visual Studio Build Tools with 'Desktop development with C\+\+'/);

    // Linux: cc, gcc, clang in turn.
    const linux = computer({ programs: { cc: { code: 1, stdout: '', stderr: 'broken' }, clang: { code: 0, stdout: 'Ubuntu clang version 18.1.3\n', stderr: '' } } });
    assert.deepEqual(await findCCompiler({ platform: 'linux', ...linux }), { compiler: 'clang', flavor: 'clang', banner: 'Ubuntu clang version 18.1.3' });
    assert.deepEqual(await findCCompiler({ platform: 'linux', ...computer({}) }), { message: missingCompilerMessage('linux') });
    assert.match(missingCompilerMessage('linux'), /sudo apt install build-essential/);
});

test('the compiler set in Settings gives the C driver beside it, or says why it cannot', async () => {
    const gcc = computer({ programs: { '/opt/gcc/bin/gcc': { code: 0, stdout: 'gcc (GCC) 13.2.0\n', stderr: '' } } });
    assert.deepEqual(await findCCompiler({ platform: 'linux', cxxOverride: '/opt/gcc/bin/g++', ...gcc }), { compiler: '/opt/gcc/bin/gcc', flavor: 'gcc', banner: 'gcc (GCC) 13.2.0' });
    assert.match((await findCCompiler({ platform: 'linux', cxxOverride: '/opt/gcc/bin/g++', ...computer({}) })).message,
        /^The C compiler beside the one set in Settings › Provider toolchains \(\/opt\/gcc\/bin\/gcc\) does not run\. Building this FMU needs a C compiler/);
    assert.match((await findCCompiler({ platform: 'linux', cxxOverride: '/opt/icx', ...computer({}) })).message, /has no C compiler Konjugate knows beside it/);
});

test('fake compilers on PATH: the first that runs is used, and none that runs gives the platform\'s message', { skip: process.platform === 'win32' && 'shell-script fake compilers' }, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'konjugateFakeCompilers-'));
    try {
        const fake = async (name, script) => {
            await writeFile(join(folder, name), `#!/bin/sh\n${script}\n`);
            await chmod(join(folder, name), 0o755);
        };
        await fake('cc', 'exit 3');
        await fake('gcc', 'echo "gcc (Fake) 1.2.3"');
        const environment = { PATH: folder };
        const run = (command, args) => runProgram(command, args, { env: environment });
        assert.deepEqual(await findCCompiler({ platform: 'linux', run, environment }), { compiler: 'gcc', flavor: 'gcc', banner: 'gcc (Fake) 1.2.3' });
        await fake('gcc', 'exit 1');
        assert.deepEqual(await findCCompiler({ platform: 'linux', run, environment }), { message: missingCompilerMessage('linux') });
        assert.equal((await runProgram('no-such-compiler-here', [], { env: environment })).code, null, 'A program that is not there does not run.');
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
});
