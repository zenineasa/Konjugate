/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Exporter recipes (docs/proposals/sourceFmuImport.md, stage 4): OpenModelica's, from the PID controller example. Building it and
// running it against FMPy is tests/engine/pidControllerExample.mjs.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { exporterRecipe, recipeCompiles } from '../src/fmuRecipes.mjs';
import { fmuSourceBuildPlan } from '../src/fmuSourceBuild.mjs';
import { inspectFmuArchive } from '../src/fmuPackage.mjs';

const openModelica = { id: 'openModelica', name: 'OpenModelica', version: '1.27.1' };
const pidFiles = async () => unzipSync(new Uint8Array(await readFile(join(import.meta.dirname, '..', 'examples', 'pidController', 'PidController.fmu'))));

test('OpenModelica 1.2x has a recipe: its definitions, include folder, pthreads and libm where the platform has them, and GCC or clang', () => {
    const { recipe } = exporterRecipe(openModelica, { cmakeListsText: 'set(NEED_CVODE\n    OFF\n    CACHE BOOL "…")', platform: 'darwin' });
    assert.deepEqual([recipe.name, recipe.version, recipe.definitions, recipe.includeDirectories, recipe.libraries, recipe.threads],
        ['OpenModelica', 1, ['OMC_MINIMAL_RUNTIME=1', 'OMC_FMI_RUNTIME=1', 'CMINPACK_NO_DLL', 'OM_HAVE_PTHREADS'], ['sundials'], ['pthread'], true]);
    const windows = exporterRecipe(openModelica, { platform: 'win32' }).recipe;
    assert.deepEqual([windows.definitions, windows.libraries, windows.threads], [['OMC_MINIMAL_RUNTIME=1', 'OMC_FMI_RUNTIME=1', 'CMINPACK_NO_DLL'], [], false]);
    assert.deepEqual([recipe.compilerFlavors, windows.compilerFlavors], [['gcc', 'clang'], ['gcc', 'clang']], 'GCC or clang, as OpenModelica\'s own toolchains, MSVC refusing its generated C.');
    assert.match(recipe.compilerReason, /MSVC does not compile/);
    assert.equal(exporterRecipe({ id: 'other', name: 'Dymola', version: '2025x' }), null, 'Another exporter has no recipe.');
    assert.equal(exporterRecipe(null), null);
});

test('a CVODE FMU and an OpenModelica older than 1.20 are refused by name', () => {
    assert.match(exporterRecipe(openModelica, { cmakeListsText: 'set(NEED_CVODE\n    ON\n    CACHE BOOL "…")' }).problem,
        /^it was exported by OpenModelica to integrate with CVODE, which needs the SUNDIALS library, and Konjugate does not build that yet/);
    assert.equal(exporterRecipe({ ...openModelica, version: '1.19.2' }).problem, 'it was exported by OpenModelica 1.19.2, and Konjugate keeps a recipe for OpenModelica 1.20 and later only');
});

test('the recipe compiles what OpenModelica\'s own build compiles', () => {
    const { recipe } = exporterRecipe(openModelica);
    for (const file of ['PidController.c', 'PidController_FMU.c', 'simulation/solver/model_help.c', 'util/omc_mmap.c', 'external_solvers/dlaswp.c', 'math-support/pivot.c', 'gc/memory_pool.c']) {
        assert.equal(recipeCompiles(recipe, file), true, file);
    }
    for (const file of ['PidController_info.c', 'simulation/solver/cvode_solver.c', 'simulation/solver/sundials_error.c', 'ModelicaExternalC/ModelicaIO.c', 'math-support/other.c', 'simulation/solver/perform_simulation.c.inc']) {
        assert.equal(recipeCompiles(recipe, file), false, file);
    }
    assert.equal(recipeCompiles(null, 'anything.c'), true, 'No recipe compiles every listed file.');
});

test('the PID controller is read with its recipe, planned as OpenModelica builds it, and refused when it needs CVODE', async () => {
    const files = await pidFiles();
    const { build } = inspectFmuArchive(Buffer.from(zipSync(files)));
    assert.equal(build.recipe.name, 'OpenModelica');
    const { plan, problems } = fmuSourceBuildPlan(build, { fmiVersion: '2.0', sourceRoot: '/b/sources', headersDirectory: '/h', objectDirectory: '/b/o', output: '/b/PidController.dylib' });
    assert.deepEqual(problems, []);
    assert.equal(plan.sets[0].files.length, 108, 'Its 113 listed files less the five ModelicaExternalC files its own build leaves out.');
    assert.deepEqual(plan.sets[0].includeDirectories, ['sundials']);
    assert.deepEqual([plan.libraries, plan.threads], [process.platform === 'win32' ? ['m'] : ['m', 'pthread'], process.platform !== 'win32']);
    const cvode = { ...files, 'sources/CMakeLists.txt': strToU8(strFromU8(files['sources/CMakeLists.txt']).replace(/set\(NEED_CVODE\s+OFF/, 'set(NEED_CVODE\n    ON')) };
    assert.match(inspectFmuArchive(Buffer.from(zipSync(cvode))).build.problems[0], /integrate with CVODE/);
});
