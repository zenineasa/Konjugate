/* Copyright © 2026 Zenin Easa Panthakkalakath */

// npm run benchmark:setup: everything the performance benchmarks need, in one step, with nothing installed by hand and no administrator
// rights (benchmarks/README.md, Reproduce these results). Into KONJUGATE_BENCHMARK_TOOLS (default ~/.konjugate-benchmarks), at the versions
// pinned in comparisons/tools.mjs, comparisons/requirements.lock and comparisons/julia/Manifest.toml:
//
//   1. the engine the app ships, the development preset's RelWithDebInfo build (-O2) in out/engine, as npm run build:engine builds it, with
//      a bounded number of compilers at once (needs npm run setup's development dependencies);
//   2. uv, downloaded and checked against its SHA-256, which downloads the pinned standalone Python into the tool home and makes a virtual
//      environment with exactly the packages of requirements.lock, every one checked against its hash;
//   3. Julia, the official build, downloaded and checked against its SHA-256, with julia/Manifest.toml's packages instantiated and
//      precompiled in the tool home's own depot;
//   4. optionally, OpenModelica's Docker image, pinned by digest, when Docker is running (skipped, and said, when it is not).
//
// Run again, it checks each and repairs what is missing or not as pinned. --check only reports what is installed and its versions.
// Other options: --skip-engine, --skip-openmodelica. macOS (arm64, x64) and Linux (x64, arm64); Windows is not supported.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import {
    downloads, juliaEnvironment, juliaExecutable, juliaProject, juliaVersion, openModelicaImage, pythonExecutable, pythonVersion, requirementsLock, toolHome, uvEnvironment,
    uvExecutable, uvVersion
} from './comparisons/tools.mjs';
import { engineDirectory, engineExecutable, repositoryRoot, shippedBuildType } from './lib/shippedEngine.mjs';
import { describeEngineBuild, engineBuild } from './lib/machine.mjs';

const checkOnly = process.argv.includes('--check');
const skip = (name) => process.argv.includes(`--skip-${name}`);
const juliaPackages = 'OrdinaryDiffEqCore, OrdinaryDiffEqTsit5, OrdinaryDiffEqLowOrderRK, OrdinaryDiffEqRosenbrock, OrdinaryDiffEqBDF, SciMLBase, SparseArrays, LinearAlgebra, JSON';

function run(command, args, options = {}) {
    console.log(`    $ ${[command, ...args].join(' ')}`);
    const result = spawnSync(command, args, { stdio: 'inherit', ...options });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status}).`);
}

function capture(command, args, options = {}) {
    if (!existsSync(command) && command.includes('/')) return null;
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });
    return result.status === 0 ? result.stdout.trim() : null;
}

// Downloads a file, checks it against its SHA-256 and unpacks it into a new directory, replacing any earlier one only once it is complete.
async function fetchAndUnpack({ url, sha256 }, destination) {
    // Three tries, each given half an hour: a slow mirror is waited for, a dropped connection tried again.
    let bytes = null;
    for (let attempt = 1; !bytes; ++attempt) {
        console.log(`    downloading ${url}${attempt > 1 ? ` (try ${attempt} of 3)` : ''}`);
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            bytes = Buffer.from(await response.arrayBuffer());
        } catch (error) {
            if (attempt === 3) throw new Error(`${url} could not be downloaded: ${error.message}`);
        }
    }
    console.log(`    downloaded ${(bytes.length / 2 ** 20).toFixed(1)} MiB`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== sha256) throw new Error(`${url} has SHA-256 ${digest}, not the pinned ${sha256}: not installed.`);
    const staging = `${destination}.partial`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const archive = join(staging, 'download.tar.gz');
    writeFileSync(archive, bytes);
    run('tar', ['-xzf', archive, '-C', staging]);
    rmSync(archive);
    rmSync(destination, { recursive: true, force: true });
    renameSync(staging, destination);
    console.log(`    checked (SHA-256 ${sha256.slice(0, 12)}…) and unpacked into ${destination}`);
}

// How many compilers a build runs at once: CMAKE_BUILD_PARALLEL_LEVEL when it is set, else one per processor but no more than one per
// 2 GiB of memory, since an unbounded make -j started some 200 compilers on an 8 GB computer and stalled it in swap.
function buildJobs() {
    const set = Number.parseInt(process.env.CMAKE_BUILD_PARALLEL_LEVEL ?? '', 10);
    if (Number.isInteger(set) && set > 0) return set;
    return Math.max(1, Math.min(os.availableParallelism(), Math.floor(os.totalmem() / 2 ** 30 / 2)));
}

// The engine the app ships: the development preset's RelWithDebInfo build in out/engine, the one npm run build:engine builds and the
// accuracy checks use, so accuracy, timing and the app run one engine. Only konjugateEngine is built, not the engine's tests.
function engine() {
    const cache = join(engineDirectory, 'CMakeCache.txt');
    const buildType = existsSync(cache) ? /^CMAKE_BUILD_TYPE:STRING=(.*)$/m.exec(readFileSync(cache, 'utf8'))?.[1] ?? null : null;
    const shipped = buildType === shippedBuildType;
    if (checkOnly) {
        if (!existsSync(engineExecutable)) return `not built (${engineExecutable}; npm run benchmark:setup or npm run build:engine builds it)`;
        if (!shipped) return `NOT the shipped build: ${buildType ?? 'no CMake cache'}, not ${shippedBuildType} (${engineExecutable})`;
        return `${describeEngineBuild(engineBuild(engineExecutable))} (${engineExecutable})`;
    }
    if (!existsSync(join(repositoryRoot, '.tools', 'vcpkg', 'scripts', 'buildsystems', 'vcpkg.cmake'))) {
        throw new Error('The engine\'s development dependencies are not set up: run npm run setup first (once), then this again.');
    }
    const jobs = buildJobs();
    console.log(`    at most ${jobs} compilers at once${process.env.CMAKE_BUILD_PARALLEL_LEVEL ? ' (CMAKE_BUILD_PARALLEL_LEVEL)' : ''}`);
    // The development preset sets CMAKE_BUILD_TYPE itself, so configuring again puts a directory configured otherwise back to the shipped
    // build; vcpkg, building the engine's dependencies the first time, is held to the same number of jobs.
    const env = { VCPKG_MAX_CONCURRENCY: String(jobs), ...process.env };
    if (!shipped) run('cmake', ['--preset', 'development'], { cwd: join(repositoryRoot, 'engine'), env });
    // Incremental: nothing is compiled when the build is current.
    run('cmake', ['--build', engineDirectory, '--config', shippedBuildType, '--target', 'konjugateEngine', '--parallel', String(jobs)], { cwd: join(repositoryRoot, 'engine'), env });
    run(process.execPath, [join(repositoryRoot, 'scripts', 'generateReportProtocol.mjs')]);
    return `${describeEngineBuild(engineBuild(engineExecutable))} (${engineExecutable})`;
}

function lockedVersions() {
    return Object.fromEntries([...readFileSync(requirementsLock, 'utf8').matchAll(/^([A-Za-z0-9_.-]+)==(\S+)/gm)].map(([, name, version]) => [name.toLowerCase(), version]));
}

function pythonState() {
    const text = capture(pythonExecutable, ['-I', '-c', 'import json, platform, numpy, scipy; print(json.dumps({"python": platform.python_version(), "numpy": numpy.__version__, "scipy": scipy.__version__}))']);
    return text ? JSON.parse(text) : null;
}

async function python() {
    const wanted = { python: pythonVersion, ...lockedVersions() };
    const asPinned = (state) => state && Object.entries(wanted).every(([name, version]) => state[name] === version);
    let state = pythonState();
    if (checkOnly) return state ? `${Object.entries(state).map(([name, version]) => `${name} ${version}`).join(', ')}${asPinned(state) ? ', as pinned' : ', NOT as pinned'}` : 'not installed';
    if (asPinned(state)) return `${Object.entries(state).map(([name, version]) => `${name} ${version}`).join(', ')}, as pinned`;
    if (capture(uvExecutable, ['--version']) !== `uv ${uvVersion}`) {
        const { uv } = downloads();
        const directory = join(toolHome, 'uv-download');
        await fetchAndUnpack(uv, directory);
        rmSync(join(toolHome, 'uv'), { recursive: true, force: true });
        renameSync(join(directory, uv.directory), join(toolHome, 'uv'));
        rmSync(directory, { recursive: true, force: true });
    }
    const env = uvEnvironment();
    run(uvExecutable, ['python', 'install', pythonVersion], { env });
    if (state?.python !== pythonVersion) rmSync(join(toolHome, 'python'), { recursive: true, force: true });
    if (!existsSync(pythonExecutable)) run(uvExecutable, ['venv', '-q', '--python', pythonVersion, join(toolHome, 'python')], { env });
    run(uvExecutable, ['pip', 'sync', '-q', '--require-hashes', '--python', pythonExecutable, requirementsLock], { env });
    state = pythonState();
    if (!asPinned(state)) throw new Error(`Python is not as pinned after installing: ${JSON.stringify(state)}, wanted ${JSON.stringify(wanted)}.`);
    return `${Object.entries(state).map(([name, version]) => `${name} ${version}`).join(', ')}, as pinned`;
}

function juliaReady() {
    const result = spawnSync(juliaExecutable, [`--project=${juliaProject}`, '--startup-file=no', '-e', `using ${juliaPackages}; print(VERSION)`], { encoding: 'utf8', env: juliaEnvironment() });
    return result.status === 0 && result.stdout.trim() === juliaVersion;
}

async function julia() {
    const version = capture(juliaExecutable, ['--version']);
    if (checkOnly) return version ? `${version}; packages ${juliaReady() ? 'instantiated and precompiled, as pinned' : 'NOT ready'}` : 'not installed';
    if (version !== `julia version ${juliaVersion}`) await fetchAndUnpack(downloads().julia, join(toolHome, `julia-${juliaVersion}-download`)).then(() => {
        rmSync(join(toolHome, `julia-${juliaVersion}`), { recursive: true, force: true });
        renameSync(join(toolHome, `julia-${juliaVersion}-download`, `julia-${juliaVersion}`), join(toolHome, `julia-${juliaVersion}`));
        rmSync(join(toolHome, `julia-${juliaVersion}-download`), { recursive: true, force: true });
    });
    if (juliaReady()) return `julia ${juliaVersion}; packages instantiated and precompiled, as pinned`;
    // Instantiating installs exactly julia/Manifest.toml's packages and changes nothing in the repository; precompiling takes several minutes.
    run(juliaExecutable, [`--project=${juliaProject}`, '--startup-file=no', '-e', 'using Pkg; Pkg.instantiate(); Pkg.precompile()'], { env: juliaEnvironment() });
    if (!juliaReady()) throw new Error('Julia\'s packages did not load after instantiating them.');
    return `julia ${juliaVersion}; packages instantiated and precompiled, as pinned`;
}

function openModelica() {
    if (!capture('/usr/bin/env', ['which', 'docker'])) return 'skipped: Docker is not installed (OpenModelica is optional)';
    if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) return 'skipped: Docker is not running (OpenModelica is optional; npm run benchmark:openmodelica pulls the image when it runs)';
    const present = spawnSync('docker', ['image', 'inspect', openModelicaImage], { stdio: 'ignore' }).status === 0;
    if (checkOnly) return present ? `image present (${openModelicaImage})` : 'image not pulled';
    if (!present) run('docker', ['pull', '--platform', process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64', openModelicaImage]);
    return `image present (${openModelicaImage})`;
}

async function main() {
    downloads();
    if (!checkOnly) mkdirSync(toolHome, { recursive: true });
    console.log(`Konjugate performance benchmarks: ${checkOnly ? 'checking' : 'setting up'} the tools in ${toolHome}${process.env.KONJUGATE_BENCHMARK_TOOLS ? ' (KONJUGATE_BENCHMARK_TOOLS)' : ''}`);
    const steps = [
        [`Engine (${shippedBuildType}, the shipped build)`, skip('engine') ? null : engine],
        [`Python ${pythonVersion} with SciPy`, python],
        [`Julia ${juliaVersion} with DifferentialEquations.jl`, julia],
        ['OpenModelica (optional, Docker)', skip('openmodelica') ? null : openModelica]
    ];
    let failed = false;
    for (const [title, step] of steps) {
        if (!step) continue;
        console.log(`  ${title}`);
        try {
            const outcome = await step();
            console.log(`    ${outcome}`);
            if (checkOnly && /not installed|NOT|not built|not pulled/.test(outcome) && !title.startsWith('OpenModelica')) failed = true;
        } catch (error) {
            failed = true;
            console.error(`    ✕ ${error.message}`);
            if (!checkOnly) break;
        }
    }
    if (failed) {
        if (checkOnly) console.log('Not ready: run npm run benchmark:setup.');
        return 1;
    }
    console.log(checkOnly ? 'Checked.' : 'Ready. Next: npm run benchmark:performance (benchmarks/README.md, Reproduce these results).');
    return 0;
}

try {
    process.exitCode = await main();
} catch (error) {
    console.error(`\nSetup stopped: ${error.message}`);
    process.exitCode = 1;
}
