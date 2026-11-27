/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Building an FMU from its sources, the plan and the compiler (docs/proposals/sourceFmuImport.md, stage 2). From what the FMU says
// (fmuBuildInformation, src/fmuBuildInformation.mjs) this makes the plan the engine's buildFmuSources command reads: each source file
// set with its language, standard and definitions, the FMI standard's own headers searched first, and the override-prefix macro, so
// the library exports the unprefixed names Konjugate's glue loads (FMI 2.0.4 §2.1.1, FMI 3.0.2 §2.2.2). It also finds the C compiler:
// the C driver beside the C++ compiler programs already use (or the one set in Settings › Provider toolchains), else the platform's
// own, and says per platform what to install when there is none. Only the compiler runs, never a shell, and nothing here opens a
// network connection.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recipeCompiles } from './fmuRecipes.mjs';

// A path's last part, whichever separator it uses (a Windows path read on any computer, as Settings may hold one).
const fileName = (path) => String(path).split(/[\\/]/).pop();

// ---- Languages and compiler options ------------------------------------------------------------------------------------------

// A source file set's language (FMI 3.0.2 §2.4.10.3) as the engine takes it: `{ language: "c" | "c++", standard }`, the standard
// as gcc and clang name it ("" for the compiler's default).
export function languageOf(name) {
    const text = String(name ?? 'C').trim();
    const cxx = /^C\+\+(\d\d)?$/.exec(text);
    if (cxx) return { language: 'c++', standard: cxx[1] ? `c++${cxx[1]}` : '' };
    const c = /^C(\d\d)?$/.exec(text);
    if (!c) return null;
    const standard = { 89: 'c89', 90: 'c90', 99: 'c99', 11: 'c11', 17: 'c17', 18: 'c17', 23: 'c2x' }[c[1]] ?? '';
    return { language: 'c', standard };
}

// The flags a build description's compilerOptions may pass (decision 5): optimisation, language standard, warnings and code
// generation choices that read and write nothing. Anything else (a linker or preprocessor pass-through, a plugin, a response file,
// an output, a path) refuses the build, naming the flag.
const allowedFlags = [
    /^-O[0-3sgz]?$/, /^-std=(c|gnu|c\+\+|gnu\+\+)\w+$/, /^-W(?![lap],)[A-Za-z0-9=+-]+$/, /^-w$/, /^-pedantic(-errors)?$/, /^-ansi$/,
    /^-f(no-)?(rtti|exceptions|strict-aliasing|common|signed-char|unsigned-char|wrapv|PIC|pic|math-errno|inline|builtin)$/, /^-ffp-contract=(off|on)$/,
    /^-g[0-3]?$/, /^-m(sse\d?(\.\d)?|avx2?|fma|arch=native)$/,
    /^\/O[12dxits]$/, /^\/W[0-4]$/, /^\/w$/, /^\/std:[a-z0-9+]+$/, /^\/EH[a-z]+$/, /^\/GR-?$/, /^\/fp:(precise|strict)$/, /^\/Z[i7]$/
];
export function compilerOptionsOf(text) {
    const flags = String(text ?? '').trim().split(/\s+/).filter(Boolean);
    const refused = flags.find((flag) => !allowedFlags.some((pattern) => pattern.test(flag)));
    return refused ? { refused } : { flags };
}

// ---- The plan ----------------------------------------------------------------------------------------------------------------

// What the engine's buildFmuSources reads, for the build information `build` of an FMU of FMI version `fmiVersion` whose sources are at
// `sourceRoot`: `{ plan, notes, problems }`. `headersDirectory` is engine/include/fmiStandard (the folder holding fmi2/ and fmi3/),
// `objectDirectory` and `output` where the objects and the library go. `recipe` (stage 4) adds definitions, libraries and threads.
// Problems refuse the build (each a phrase following "Konjugate cannot build it: "); notes are said and lose nothing.
export function fmuSourceBuildPlan(build, { fmiVersion, sourceRoot, headersDirectory, objectDirectory, output, compilerFamily = null, recipe: givenRecipe = null, timeoutSeconds = 300 }) {
    // The exporter's recipe (src/fmuRecipes.mjs), chosen when the build information was read, unless one is given.
    const recipe = givenRecipe ?? build?.recipe ?? null;
    const problems = [...(build?.problems ?? [])];
    const notes = [];
    if (!build?.configuration) return { plan: null, notes, problems: problems.length ? problems : ['it says nothing about building it'] };
    const major = String(fmiVersion).startsWith('3.') ? 3 : 2;
    const sets = [];
    for (const set of build.configuration.sourceFileSets) {
        const language = languageOf(set.language);
        if (!language) continue; // said by fmuBuildInformation
        const options = set.compilerOptions ? compilerOptionsOf(set.compilerOptions) : { flags: [] };
        if (options.refused) problems.push(`its build description asks the compiler for ${options.refused}, which Konjugate does not pass on`);
        if (set.compiler && compilerFamily && !sameFamily(set.compiler, compilerFamily)) {
            notes.push(`Its build description asks for ${set.compiler}; Konjugate builds it with ${compilerFamily}.`);
        }
        sets.push({
            ...language,
            files: set.sourceFiles.filter((file) => recipeCompiles(recipe, file)),
            definitions: [
                `FMI${major}_OVERRIDE_FUNCTION_PREFIX`,
                ...set.definitions.map((definition) => (definition.value === null ? definition.name : `${definition.name}=${definition.value}`)),
                ...(recipe?.definitions ?? [])
            ],
            includeDirectories: [...set.includeDirectories, ...(recipe?.includeDirectories ?? [])],
            ...(options.flags?.length ? { compilerOptions: options.flags } : {})
        });
    }
    const plan = {
        sourceRoot, objectDirectory, output, timeoutSeconds,
        includeFirst: [join(headersDirectory, `fmi${major}`)],
        sets,
        libraries: [...new Set(['m', ...(recipe?.libraries ?? [])])],
        threads: Boolean(recipe?.threads)
    };
    return { plan, notes, problems: [...new Set(problems)] };
}

const family = (name) => {
    const text = fileName(String(name)).toLowerCase();
    if (/^cl(\.exe)?$/.test(text) || /msvc|microsoft/.test(text)) return 'msvc';
    if (/clang/.test(text)) return 'clang';
    if (/gcc|g\+\+|^cc$/.test(text)) return 'gcc';
    return text;
};
const sameFamily = (asked, used) => family(asked) === family(used);

// ---- Finding a compiler ------------------------------------------------------------------------------------------------------

// The C driver beside a C++ compiler: clang beside clang++, gcc beside g++, cc beside c++, keeping its folder, target prefix and
// version suffix (x86_64-linux-gnu-g++-12 gives x86_64-linux-gnu-gcc-12); MSVC's cl.exe compiles C itself (/TC). Null when it is not
// a compiler this knows the C driver of.
export function cDriverFor(cxxCompiler) {
    if (!cxxCompiler) return null;
    const name = fileName(cxxCompiler);
    const folder = cxxCompiler.slice(0, cxxCompiler.length - name.length);
    if (/^cl(\.exe)?$/i.test(name)) return cxxCompiler;
    const mapped = name.replace(/clang\+\+/, 'clang').replace(/g\+\+/, 'gcc').replace(/^c\+\+/, 'cc').replace(/-c\+\+/, '-cc');
    return mapped === name ? null : `${folder}${mapped}`;
}

// What the build says when there is no C compiler on this computer, per platform (the proposal's table).
export function missingCompilerMessage(platform = process.platform) {
    if (platform === 'darwin') return 'Building this FMU needs Apple\'s command line tools. Open Terminal, run xcode-select --install, then add the FMU again.';
    if (platform === 'win32') return 'Building this FMU needs a C compiler. Install Visual Studio Build Tools with \'Desktop development with C++\', or set a compiler in Settings › Provider toolchains.';
    return 'Building this FMU needs a C compiler. Install your distribution\'s build tools (for example sudo apt install build-essential), or set one in Settings › Provider toolchains.';
}

// Runs a program with arguments, no shell, a time limit; `{ code, stdout, stderr }`, code null when it could not be started.
export function runProgram(command, args, { env = process.env, timeoutMs = 15000 } = {}) {
    return new Promise((resolve) => {
        execFile(command, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
            const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
            resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
    });
}

// A compiler's identity as it says it (its --version banner's first line; MSVC's banner, which cl.exe prints with no arguments),
// or null when it does not run.
async function compilerBanner(compiler, run) {
    const msvc = /(^|[\\/])cl(\.exe)?$/i.test(compiler);
    const result = await run(compiler, msvc ? [] : ['--version']);
    const text = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (msvc) return /Microsoft/.test(text.join(' ')) ? (text.find((line) => /Microsoft/.test(line)) ?? null) : null;
    return result.code === 0 && text.length ? text[0] : null;
}

// MSVC's cl.exe as vswhere finds it (the Visual Studio Installer's own locator, rather than fixed paths): the latest installation with
// the x64 build tools, its default tools version, the host and target of this computer's architecture.
async function msvcByVswhere({ run, exists, readText, environment, arch }) {
    const programFiles = environment['ProgramFiles(x86)'] ?? environment.ProgramFiles ?? 'C:\\Program Files (x86)';
    const vswhere = `${programFiles}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
    if (!exists(vswhere)) return null;
    const found = await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']);
    const installation = found.code === 0 ? found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : null;
    if (!installation) return null;
    const version = readText(`${installation}\\VC\\Auxiliary\\Build\\Microsoft.VCToolsVersion.default.txt`)?.trim();
    if (!version) return null;
    const host = arch === 'arm64' ? 'arm64' : 'x64';
    const compiler = `${installation}\\VC\\Tools\\MSVC\\${version}\\bin\\Host${host}\\${host}\\cl.exe`;
    return exists(compiler) ? compiler : null;
}

// The C compiler a build uses: `{ compiler, flavor, banner }`, or `{ message }` saying what to install (or that the compiler set in
// Settings does not run, or has no C driver beside it). `cxxOverride` is the C++ compiler set in Settings › Provider toolchains (the C
// driver is derived from it, decision 4). `run`, `exists`, `readText`, `environment`, `platform` and `arch` are the computer's; tests
// give their own.
export async function findCCompiler({
    cxxOverride = null, platform = process.platform, arch = process.arch, run = runProgram, environment = process.env,
    exists = existsSync, readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } }
} = {}) {
    const tryCompiler = async (compiler) => {
        const banner = await compilerBanner(compiler, run);
        return banner ? { compiler, flavor: /(^|[\\/])cl(\.exe)?$/i.test(compiler) ? 'msvc' : /clang/i.test(`${compiler} ${banner}`) ? 'clang' : 'gcc', banner } : null;
    };
    if (cxxOverride) {
        const driver = cDriverFor(cxxOverride);
        if (!driver) return { message: `The compiler set in Settings › Provider toolchains (${cxxOverride}) has no C compiler Konjugate knows beside it. Set a clang++, g++ or cl.exe there.` };
        return (await tryCompiler(driver)) ?? { message: `The C compiler beside the one set in Settings › Provider toolchains (${driver}) does not run. ${missingCompilerMessage(platform)}` };
    }
    const candidates = [];
    if (platform === 'darwin') {
        const found = await run('xcrun', ['-find', 'clang']);
        const path = found.code === 0 ? found.stdout.trim() : '';
        if (path) candidates.push(path);
    } else if (platform === 'win32') {
        const msvc = await msvcByVswhere({ run, exists, readText, environment, arch });
        if (msvc) candidates.push(msvc);
        candidates.push('clang', 'gcc');
    } else {
        candidates.push('cc', 'gcc', 'clang');
    }
    for (const candidate of candidates) {
        const found = await tryCompiler(candidate);
        if (found) return found;
    }
    return { message: missingCompilerMessage(platform) };
}

// The engine's headers folder for the FMI standard's own headers, from its SDK path (engine/ in development, the packaged engine's
// resources otherwise; cppProviderSdkPath, src/engineAdapter.mjs).
export function fmiStandardHeadersDirectory(sdkPath) {
    return join(sdkPath, 'include', 'fmiStandard');
}
