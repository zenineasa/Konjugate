/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The engine's buildFmuSources (docs/proposals/sourceFmuImport.md, stage 2): every Co-Simulation FMU of the FMI Reference FMUs (FMI 2.0
// and 3.0, the release the import fidelity checks use) is built from its own sources with this computer's C compiler, as the plan of
// src/fmuSourceBuild.mjs says, into a library for this computer's processor; --print-steps gives the argument lists; a compile error
// names the file; a compiler that hangs is stopped at the time limit; and an argument is never read by a shell.
//
//   node tests/engine/fmuSourceBuild.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runEngine } from '../../src/engineAdapter.mjs';
import { binaryArchitectures, fmiArchitecture } from '../../src/fmiBinary.mjs';
import { inspectFmuArchive } from '../../src/fmuPackage.mjs';
import { findCCompiler, fmiStandardHeadersDirectory, fmuSourceBuildPlan, runProgram } from '../../src/fmuSourceBuild.mjs';
import { referenceCases, referenceFmuArchive } from './fixtures/referenceFmuFidelity.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const extension = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
const headersDirectory = fmiStandardHeadersDirectory(join(root, 'engine'));

const compiler = await findCCompiler();
if (compiler.message) {
    console.log(`  (skipping the source build check: no C compiler here -- ${compiler.message})`);
    process.exit(0);
}

// The FMU's sources/ written to a folder of its own, as the build copies them, and the plan for them.
async function prepared(archive, folder) {
    const { description, files, build } = inspectFmuArchive(archive);
    for (const [name, bytes] of Object.entries(files)) {
        if (!name.startsWith('sources/')) continue;
        await mkdir(dirname(join(folder, name)), { recursive: true });
        await writeFile(join(folder, name), bytes);
    }
    const { plan, problems } = fmuSourceBuildPlan(build, {
        fmiVersion: description.fmiVersion, sourceRoot: join(folder, 'sources'), headersDirectory,
        objectDirectory: join(folder, 'objects'), output: join(folder, `${description.modelIdentifier}${extension}`), compilerFamily: compiler.flavor
    });
    return { description, plan, problems };
}

async function build(plan, folder, extra = []) {
    await writeFile(join(folder, 'plan.json'), JSON.stringify(plan));
    return runEngine(executable, ['buildFmuSources', join(folder, 'plan.json'), '--compiler', compiler.compiler, ...extra]);
}

const folder = await mkdtemp(join(tmpdir(), 'konjugateFmuSourceBuild-'));
const lines = [];
try {
    // 1. Every Reference FMU case, both FMI versions, built for this computer.
    for (const fmiVersion of ['2.0', '3.0']) {
        for (const testCase of referenceCases.cases) {
            const what = `FMI ${fmiVersion} ${testCase.name}`;
            const caseFolder = join(folder, `${fmiVersion}-${testCase.name}`);
            const { plan, problems } = await prepared(await referenceFmuArchive(fmiVersion, testCase.name), caseFolder);
            assert.deepEqual(problems, [], `${what}: its sources can be built.`);
            const outcome = await build(plan, caseFolder);
            assert.equal(outcome.code, 0, `${what} did not build:\n${outcome.diagnostics}`);
            const architectures = binaryArchitectures(await readFile(plan.output));
            assert.ok(!architectures || architectures.includes(fmiArchitecture()), `${what}: built for ${architectures}, not this computer.`);
            await rm(join(caseFolder, 'objects'), { recursive: true, force: true });
        }
    }
    lines.push(`${referenceCases.cases.length * 2} Reference FMUs built from their sources with ${compiler.banner}`);

    // 2. The argument lists, as a build's cache key is made from them: one step per file, then the link.
    const stepsFolder = join(folder, 'steps');
    const { plan } = await prepared(await referenceFmuArchive('3.0', 'BouncingBall'), stepsFolder);
    await writeFile(join(stepsFolder, 'plan.json'), JSON.stringify(plan));
    const printed = await runProgram(executable, ['buildFmuSources', join(stepsFolder, 'plan.json'), '--compiler', compiler.compiler, '--print-steps']);
    assert.equal(printed.code, 0, printed.stderr);
    const steps = JSON.parse(printed.stdout);
    assert.deepEqual(steps.map((step) => step.what), ['Compiling fmi3Functions.c', 'Compiling model.c', 'Compiling common.c', 'Compiling cosimulation.c', `Linking BouncingBall${extension}`]);
    const first = steps[0].arguments;
    if (compiler.flavor !== 'msvc') {
        assert.ok(first.includes('-DFMI3_OVERRIDE_FUNCTION_PREFIX') && first.includes('-DFMI_VERSION=3') && first.includes('-std=gnu99') && first.includes('-O3'), first.join(' '));
        assert.ok(first.indexOf(`-I${join(headersDirectory, 'fmi3')}`) < first.indexOf(`-I${join(stepsFolder, 'sources')}`), 'The FMI standard\'s headers come before the FMU\'s own.');
    }
    await assert.rejects(stat(plan.output), 'Printing the steps builds nothing.');

    // 3. A compile error names the file and gives the compiler's words.
    const broken = join(folder, 'broken');
    await mkdir(join(broken, 'sources'), { recursive: true });
    await writeFile(join(broken, 'sources', 'model.c'), 'int broken( { return 0; }\n');
    const brokenPlan = { sourceRoot: join(broken, 'sources'), objectDirectory: join(broken, 'objects'), output: join(broken, `broken${extension}`), includeFirst: [], sets: [{ language: 'c', standard: 'gnu99', files: ['model.c'], definitions: [], includeDirectories: [] }], libraries: [], timeoutSeconds: 120 };
    const failed = await build(brokenPlan, broken);
    assert.notEqual(failed.code, 0);
    assert.match(failed.diagnostics, /Compiling model\.c failed:[\s\S]*model\.c/);
    lines.push('a compile error names its file');

    // 4. A compiler that hangs is stopped at the time limit; 5. an argument reaches the compiler as it is, never through a shell.
    if (process.platform !== 'win32') {
        const fakes = join(folder, 'fakes');
        await mkdir(fakes, { recursive: true });
        const hanging = join(fakes, 'hangingCompiler');
        await writeFile(hanging, '#!/bin/sh\nsleep 60\n');
        await chmod(hanging, 0o755);
        await writeFile(join(broken, 'plan.json'), JSON.stringify({ ...brokenPlan, timeoutSeconds: 1 }));
        const started = Date.now();
        const stopped = await runEngine(executable, ['buildFmuSources', join(broken, 'plan.json'), '--compiler', hanging]);
        assert.notEqual(stopped.code, 0);
        assert.match(stopped.diagnostics, /Compiling model\.c was stopped: the build took longer than 1 s/);
        assert.ok(Date.now() - started < 15000, `The hung compiler was stopped after ${Date.now() - started} ms.`);

        const marker = join(folder, 'aShellRanThis');
        await writeFile(join(broken, 'sources', 'model.c'), 'int fine(void) { return 0; }\n');
        const quoted = { ...brokenPlan, sets: [{ ...brokenPlan.sets[0], definitions: [`NOT_A_COMMAND="$(touch ${marker})"`, `ALSO=x;touch ${marker}`] }] };
        const harmless = await build(quoted, broken);
        assert.equal(harmless.code, 0, harmless.diagnostics);
        await assert.rejects(stat(marker), 'No shell ran an argument.');
        lines.push('a hung compiler is stopped at the time limit, and no argument is run by a shell');
    }
    console.log(`✓ buildFmuSources: ${lines.join('; ')}.`);
} finally {
    await rm(folder, { recursive: true, force: true });
}
