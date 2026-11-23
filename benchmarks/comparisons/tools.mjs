/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The comparison tools, pinned, and where they live: outside the repository, kept between runs, installed by npm run benchmark:setup
// (benchmarks/setup.mjs) with nothing installed by hand and no administrator rights. KONJUGATE_BENCHMARK_TOOLS chooses the place, by
// default ~/.konjugate-benchmarks:
//
//   uv/            uv, the Python installer, downloaded at the version below and checked against its SHA-256
//   pythons/       the Python below, a standalone build uv downloads
//   python/        a virtual environment with exactly the packages of requirements.lock, each checked against its hash
//   julia-<v>/     Julia, the official build at the version below, checked against its SHA-256
//   julia-depot/   Julia's packages, exactly as julia/Manifest.toml pins them, precompiled
//
// OpenModelica is the Docker image below, pinned by digest and kept by Docker itself; it is optional.
// Supported: macOS (arm64, x64) and Linux (x64, arm64). Windows is not supported by these scripts.

import { homedir } from 'node:os';
import { join } from 'node:path';

export const toolHome = process.env.KONJUGATE_BENCHMARK_TOOLS ?? join(homedir(), '.konjugate-benchmarks');

export const uvVersion = '0.13.1';
export const pythonVersion = '3.12.15';
export const juliaVersion = '1.13.4';
export const openModelicaImage = 'openmodelica/openmodelica:v1.27.1-minimal@sha256:ac9a0223e69b8055d444b42f58ccb9680342b56848c68b81385bf83d7c0ba824';

const platforms = {
    'darwin-arm64': { uv: ['aarch64-apple-darwin', 'cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2'], julia: ['mac/aarch64', 'macaarch64', '8e58a1993ecbadb9a762a987eefa4e484b364a8560349609cc05e93287b9a8fe'] },
    'darwin-x64': { uv: ['x86_64-apple-darwin', 'bb7b805bdcf3d0bc8c74ceb94569e6b3e8aa35bd492acdbb9d46bf46d9d4ff6b'], julia: ['mac/x64', 'mac64', 'c84de0fcb4268841f296fd56c47c27383d81358033428389b0d1882b110b9bcd'] },
    'linux-x64': { uv: ['x86_64-unknown-linux-gnu', 'eadd9d27c134ab5ac1ffd4473b97a741407f3ea238288f03121fc4deddf90220'], julia: ['linux/x64', 'linux-x86_64', 'cf1658f13b91facccd57d41464d7125a0e48a1d24f49062d71532d04d4ec4130'] },
    'linux-arm64': { uv: ['aarch64-unknown-linux-gnu', '9041c73c99fdc5892cf128140beb354eca9231d502068cc36e6cb53a8e59ad14'], julia: ['linux/aarch64', 'linux-aarch64', 'd1814cb51e49a1ecd0c95ff0e4ac267ec5ddaba051f5eed2d866d55e40274de5'] }
};

// The downloads for this computer, or why there are none.
export function downloads() {
    const key = `${process.platform}-${process.arch}`;
    const platform = platforms[key];
    if (!platform) {
        throw new Error(process.platform === 'win32'
            ? 'The performance benchmarks\' scripts do not support Windows; run them on macOS or Linux (the engine\'s accuracy benchmarks, npm run benchmark:accuracy, do run on Windows).'
            : `The performance benchmarks support macOS and Linux on arm64 and x64, not ${key}.`);
    }
    const [triple, uvSha256] = platform.uv;
    const [juliaPath, juliaName, juliaSha256] = platform.julia;
    const minor = juliaVersion.split('.').slice(0, 2).join('.');
    return {
        uv: { url: `https://github.com/astral-sh/uv/releases/download/${uvVersion}/uv-${triple}.tar.gz`, sha256: uvSha256, directory: `uv-${triple}` },
        julia: { url: `https://julialang-s3.julialang.org/bin/${juliaPath}/${minor}/julia-${juliaVersion}-${juliaName}.tar.gz`, sha256: juliaSha256 }
    };
}

export const uvExecutable = join(toolHome, 'uv', 'uv');
export const pythonExecutable = join(toolHome, 'python', 'bin', 'python');
export const juliaExecutable = join(toolHome, `julia-${juliaVersion}`, 'bin', 'julia');
export const juliaProject = join(import.meta.dirname, 'julia');
export const requirementsLock = join(import.meta.dirname, 'requirements.lock');

// uv keeps its Pythons, their command links and its cache in the tool home (nothing in ~/.local/bin, no change to the shell's PATH), and
// uses only the Python it downloaded, never the computer's own.
export function uvEnvironment(base = process.env) {
    return {
        ...base, UV_PYTHON_INSTALL_DIR: join(toolHome, 'pythons'), UV_PYTHON_BIN_DIR: join(toolHome, 'pythons', 'bin'), UV_CACHE_DIR: join(toolHome, 'uv-cache'),
        UV_PYTHON_PREFERENCE: 'only-managed', UV_NO_CONFIG: '1', UV_NO_MODIFY_PATH: '1'
    };
}

// Julia's packages in the tool home, not the user's own ~/.julia.
export function juliaEnvironment(base = process.env) {
    return { ...base, JULIA_DEPOT_PATH: join(toolHome, 'julia-depot') };
}

// The Julia command and its first arguments.
export const juliaLauncher = () => juliaExecutable;
export const juliaArguments = (...rest) => rest;
