/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Exporter recipes (docs/proposals/sourceFmuImport.md, stage 4): what an exporter's sources need beyond what the FMI standard says, kept
// by Konjugate as data (definitions, include folders, libraries, threads, and the files its own build leaves out), never a script. The
// FMU's own CMakeLists.txt is read as text for the one fact it records (whether it integrates with SUNDIALS' CVODE), never run.
//
// OpenModelica 1.2x, from its CMakeLists.txt template (the PID controller example, examples/pidController): it compiles every C file of
// its runtime folders and the model's own files except <Model>_info.c (an #include-only fragment) and, without CVODE, cvode_solver.c and
// sundials_error.c, with OMC_MINIMAL_RUNTIME=1, OMC_FMI_RUNTIME=1 and CMINPACK_NO_DLL defined, OM_HAVE_PTHREADS and pthreads where the
// platform has them, sources/ and sources/sundials as include folders, and libm. Its <SourceFiles> also lists ModelicaExternalC's
// files, which that build does not compile.
//
// Its generated C is written for GCC-style compilers, as OpenModelica's own toolchains are (GCC or clang; MinGW-w64's GCC on
// Windows): a model with no equations of a kind gets an empty initializer for an array of unknown size (`const size_t eqMap[] = {};`
// in <Model>_12jac.c, a GNU C extension), which MSVC refuses (C7757). So the recipe asks for GCC or clang, also on Windows.

export const openModelicaRecipeVersion = 1;

// The files OpenModelica's own build compiles, as its CMakeLists globs them, relative to sources/.
const openModelicaCompiles = [
    /^(external_solvers|fmi-export|gc|meta|simulation|util)\/.+\.c$/,
    /^math-support\/pivot\.c$/,
    /^[^/]+\.c$/
];
const openModelicaLeavesOut = [/^[^/]+_info\.c$/, /^simulation\/solver\/(sundials_error|cvode_solver)\.c$/];

// The recipe for an FMU, from its build information's `exporter` (fmuBuildInformation) and its CMakeLists.txt as text: `{ recipe }`,
// `{ problem }` (a phrase following "Konjugate cannot build it: "), or null when Konjugate keeps no recipe for its exporter.
export function exporterRecipe(exporter, { cmakeListsText = null, platform = process.platform } = {}) {
    if (exporter?.id !== 'openModelica') return null;
    const [major, minor] = String(exporter.version).split('.').map(Number);
    if (major !== 1 || !(minor >= 20)) {
        return { problem: `it was exported by OpenModelica ${exporter.version}, and Konjugate keeps a recipe for OpenModelica 1.20 and later only` };
    }
    // `set(NEED_CVODE ON CACHE BOOL …)`: the FMU integrates with CVODE, which needs the SUNDIALS library.
    if (/set\s*\(\s*NEED_CVODE\s+ON\b/i.test(cmakeListsText ?? '')) {
        return { problem: 'it was exported by OpenModelica to integrate with CVODE, which needs the SUNDIALS library, and Konjugate does not build that yet. Export it with a fixed-step solver (OpenModelica\'s --fmiFlags=s:euler) to build it here' };
    }
    const threads = platform !== 'win32';
    return {
        recipe: {
            name: 'OpenModelica', version: openModelicaRecipeVersion,
            definitions: ['OMC_MINIMAL_RUNTIME=1', 'OMC_FMI_RUNTIME=1', 'CMINPACK_NO_DLL', ...(threads ? ['OM_HAVE_PTHREADS'] : [])],
            includeDirectories: ['sundials'],
            libraries: threads ? ['pthread'] : [],
            threads,
            // Regular expressions (as text, so the recipe is plain data) over paths relative to sources/: a file is compiled when it
            // matches one of `compiles` and none of `leavesOut`.
            compiles: openModelicaCompiles.map((pattern) => pattern.source),
            // The compilers its sources compile with, in the order Konjugate looks for one, and why another will not do.
            compilerFlavors: ['gcc', 'clang'],
            compilerReason: 'OpenModelica\'s generated C uses GNU C extensions (an empty initializer for an array of unknown size) that MSVC does not compile',
            leavesOut: openModelicaLeavesOut.map((pattern) => pattern.source)
        }
    };
}

// Whether a recipe compiles `file` (relative to sources/): every file when it says nothing.
export function recipeCompiles(recipe, file) {
    if (!recipe?.compiles) return true;
    return recipe.compiles.some((source) => new RegExp(source).test(file)) && !(recipe.leavesOut ?? []).some((source) => new RegExp(source).test(file));
}
