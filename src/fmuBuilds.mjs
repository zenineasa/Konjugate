/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Building an installed FMU from its sources on this computer, and the builds kept (docs/proposals/sourceFmuImport.md, stage 3).
// A build lives in `fmuBuilds/<key>/` beside the installed FMUs (`<packages>/fmuBuilds`, next to `<packages>/fmus`): the library,
// `build.json` (what was built, with which compiler and arguments, when, and the library's SHA-256) and `build.log`. The key is a SHA-256
// over the FMU archive's SHA-256, the compiler and its version banner, the platform tuple, the full argument lists, the recipe and the
// FMI headers' own SHA-256, so any change builds again. `byArchive/<archive SHA-256>.json` points at an archive's latest build, which
// the resolver runs (src/fmiResolver.mjs) when the FMU has no binary for this computer; it is checked against its SHA-256 first. The
// project keeps the FMU as it came: nothing here writes into the installed FMU or the project. Konjugate asks before the first build of
// an archive on this computer (decision 3); `confirmed.json` keeps the archives it may build.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parseModelDescription } from './fmiModelDescription.mjs';
import { binaryDirectoryCandidates, platformTuple } from './fmiBinary.mjs';
import { unzipSync, zipSync } from 'fflate';
import { fmuBuildInformation } from './fmuBuildInformation.mjs';
import { findCCompiler, fmiStandardHeadersDirectory, fmuSourceBuildPlan, runProgram } from './fmuSourceBuild.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const libraryExtension = (platform = process.platform) => (platform === 'win32' ? '.dll' : platform === 'darwin' ? '.dylib' : '.so');
const staleLockMs = 10 * 60 * 1000;

// A small file the cache rewrites (the archives confirmed, an archive's pointer) written whole: to a file of its own, then renamed over
// the old one, so a build reading it meanwhile (another window, or two builds at once) reads the old file or the new one, never a
// half-written one. writeFile alone truncates first, which once failed a build with an empty confirmed.json.
async function writeJsonWhole(path, value) {
    const partial = `${path}.${process.pid}.${randomUUID()}.partial`;
    try {
        await writeFile(partial, JSON.stringify(value));
        await renameRetrying(partial, path);
    } catch (error) {
        await rm(partial, { force: true });
        throw error;
    }
}

// rename(), tried again while Windows refuses it for a moment: it answers EPERM, EACCES or EBUSY while another handle has the file
// open (a reader, an antivirus scan, another rename onto it), as two builds at once met in 2.1.3's release checks. Ten tries, the
// waits doubling from `delayMs` to about a second in all; any other failure, or one that lasts, is thrown. `rename` is a test's seam.
const transientRenameCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
export async function renameRetrying(from, to, { rename: renameFile = rename, attempts = 10, delayMs = 2 } = {}) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await renameFile(from, to);
        } catch (error) {
            if (!transientRenameCodes.has(error.code) || attempt >= attempts) throw error;
            await new Promise((done) => setTimeout(done, delayMs * 2 ** (attempt - 1)));
        }
    }
}

// Each cache file's read-modify-write in turn, within this process (every window's builds run in the one main process): two builds
// at once each reading confirmed.json, adding their archive and writing it back, lost one of the two. `task` runs once the tasks
// before it on `path` have finished, whether they succeeded or not.
const fileTasks = new Map();
function inTurn(path, task) {
    const previous = fileTasks.get(path) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(task);
    const settled = result.catch(() => {});
    fileTasks.set(path, settled);
    settled.then(() => { if (fileTasks.get(path) === settled) fileTasks.delete(path); });
    return result;
}

export function buildsDirectoryOf(fmuDirectory) {
    return resolve(fmuDirectory, 'fmuBuilds');
}

// What an installed FMU (`fmuRoot`) says about building it: fmuBuildInformation over its folder's sources.
export async function installedBuildInformation(fmuRoot, description) {
    const sources = resolve(fmuRoot, 'sources');
    const entries = await readdir(sources, { recursive: true, withFileTypes: true }).catch(() => []);
    const names = entries.filter((entry) => entry.isFile())
        .map((entry) => `sources/${relative(sources, resolve(entry.parentPath ?? entry.path, entry.name)).split(sep).join('/')}`);
    const buildDescriptionXml = await readFile(resolve(sources, 'buildDescription.xml'), 'utf8').catch(() => null);
    const cmakeListsText = await readFile(resolve(sources, 'CMakeLists.txt'), 'utf8').catch(() => null);
    return fmuBuildInformation({ description, names, buildDescriptionXml, cmakeListsText });
}

async function installedFmu(fmuDirectory, guid, version) {
    const fmusRoot = resolve(fmuDirectory, 'fmus');
    const fmuRoot = resolve(fmusRoot, guid, version);
    if (!fmuRoot.startsWith(`${fmusRoot}${sep}`)) throw new Error('The FMU reference path is unsafe.');
    const description = parseModelDescription(await readFile(resolve(fmuRoot, 'modelDescription.xml'), 'utf8'));
    const meta = JSON.parse(await readFile(resolve(fmuRoot, 'fmuMeta.json'), 'utf8').catch(() => '{}'));
    const archiveSha256 = meta.archiveSha256 ?? sha256(await readFile(resolve(fmuRoot, 'archive.fmu')));
    return { fmuRoot, description, meta, archiveSha256, build: await installedBuildInformation(fmuRoot, description) };
}

// The SHA-256 of the FMI headers a build compiles against: a change to them builds again.
export async function headersSha256(headersDirectory) {
    const entries = (await readdir(headersDirectory, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())
        .map((entry) => resolve(entry.parentPath ?? entry.path, entry.name)).sort();
    const hash = createHash('sha256');
    for (const path of entries) hash.update(relative(headersDirectory, path).split(sep).join('/')).update('\0').update(await readFile(path)).update('\0');
    return hash.digest('hex');
}

// The argument lists with the build's own folders named alike, so the same FMU built in two temporary folders has one key.
export function portableSteps(steps, { buildFolder, headersDirectory }) {
    const text = JSON.stringify(steps).split(JSON.stringify(buildFolder).slice(1, -1)).join('<build>').split(JSON.stringify(headersDirectory).slice(1, -1)).join('<headers>');
    return JSON.parse(text);
}

export function buildKey({ archiveSha256, compiler, banner, tuple, steps, recipe = null, headers }) {
    return sha256(JSON.stringify({ archiveSha256, compiler, banner, tuple, steps, recipe: recipe ? { name: recipe.name, version: recipe.version } : null, headers }));
}

// The first line of a failed build's log a person needs: the compiler's first error, else its first words.
export function firstError(log) {
    const lines = String(log ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => /\b(fatal )?error\b/i.test(line) && !/^Compiling .* failed:$/.test(line))
        ?? lines.find((line) => !/ failed:$/.test(line)) ?? 'The compiler stopped without saying why.';
}

// A cached build, when its record and library are there and the library is the one recorded; null otherwise (a corrupted or partial
// build is not used, and is built again).
export async function cachedBuild(buildsDirectory, key) {
    const folder = resolve(buildsDirectory, key);
    const record = JSON.parse(await readFile(resolve(folder, 'build.json'), 'utf8').catch(() => 'null'));
    if (!record?.library) return null;
    const library = await readFile(resolve(folder, record.library)).catch(() => null);
    if (!library || sha256(library) !== record.librarySha256) return null;
    return { record, libraryPath: resolve(folder, record.library), library };
}

// The build the resolver runs for an archive on this computer: the latest one built, checked, for this platform.
// `preferredOnly` (an FMU that has a binary of its own for this computer): only a build the person chose to run in its place (stage 5,
// Build from its sources on request), until Use its own binary.
export async function currentBuildFor(fmuDirectory, archiveSha256, tuple = platformTuple(), { preferredOnly = false } = {}) {
    const builds = buildsDirectoryOf(fmuDirectory);
    const pointer = await readPointer(builds, archiveSha256);
    if (!pointer || (preferredOnly && !pointer.preferred)) return null;
    const cached = await cachedBuild(builds, pointer.key);
    return cached && cached.record.tuple === tuple && cached.record.archiveSha256 === archiveSha256 ? { ...cached, preferred: Boolean(pointer.preferred) } : null;
}

async function readPointer(builds, archiveSha256) {
    if (!/^[0-9a-f]{64}$/.test(String(archiveSha256))) return null;
    const pointer = JSON.parse(await readFile(resolve(builds, 'byArchive', `${archiveSha256}.json`), 'utf8').catch(() => 'null'));
    return pointer?.key && /^[0-9a-f]{64}$/.test(pointer.key) ? pointer : null;
}

// Whether an FMU's kept build runs in place of its own binary (Build from its sources) or not (Use its own binary).
export async function setBuildPreferred(fmuDirectory, archiveSha256, preferred) {
    const builds = buildsDirectoryOf(fmuDirectory);
    const path = resolve(builds, 'byArchive', `${archiveSha256}.json`);
    return inTurn(path, async () => {
        const pointer = await readPointer(builds, archiveSha256);
        if (!pointer) return false;
        await writeJsonWhole(path, { key: pointer.key, ...(preferred ? { preferred: true } : {}) });
        return true;
    });
}

// The installed FMU as a new .fmu with this computer's build of it among its binaries (Save FMU with this computer's binary…): the
// archive it was installed from, unchanged but for the library added under this computer's binaries/ folder (the FMU's own standard's
// name), replacing one there. `{ buffer, fileName, directory }`, or null when it has no build here.
export async function fmuWithThisComputersBinary(fmuDirectory, guid, version) {
    const fmu = await installedFmu(fmuDirectory, guid, version);
    const built = await currentBuildFor(fmuDirectory, fmu.archiveSha256);
    if (!built) return null;
    const files = unzipSync(new Uint8Array(await readFile(resolve(fmu.fmuRoot, 'archive.fmu'))));
    const directory = binaryDirectoryCandidates(fmu.description.fmiVersion)[0];
    files[`binaries/${directory}/${built.record.library}`] = new Uint8Array(built.library);
    return { buffer: Buffer.from(zipSync(files, { level: 6 })), fileName: `${fmu.description.modelName}.fmu`, directory };
}

// What the builds kept on this computer take: `{ count, bytes }`, for Settings.
export async function buildsKept(fmuDirectory) {
    const builds = buildsDirectoryOf(fmuDirectory);
    let count = 0;
    let bytes = 0;
    for (const entry of await readdir(builds, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
        count += 1;
        for (const file of await readdir(resolve(builds, entry.name), { withFileTypes: true }).catch(() => [])) {
            if (file.isFile()) bytes += (await stat(resolve(builds, entry.name, file.name))).size;
        }
    }
    return { count, bytes };
}

export async function confirmedArchives(builds) {
    return new Set(JSON.parse(await readFile(resolve(builds, 'confirmed.json'), 'utf8').catch(() => '[]')));
}

// The archives this computer may build without asking, with `archiveSha256` added.
export async function rememberConfirmedArchive(builds, archiveSha256) {
    const path = resolve(builds, 'confirmed.json');
    await inTurn(path, async () => {
        const confirmed = await confirmedArchives(builds);
        confirmed.add(archiveSha256);
        await writeJsonWhole(path, [...confirmed]);
    });
}

// Takes the lock for `key`, or waits for the build that holds it (another window building the same FMU) and returns false then.
async function takeLock(builds, key, signal) {
    const path = resolve(builds, `${key}.lock`);
    for (;;) {
        try {
            const handle = await open(path, 'wx');
            await handle.writeFile(String(process.pid));
            await handle.close();
            return { path, waited: false };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
        const held = await stat(path).catch(() => null);
        if (held && Date.now() - held.mtimeMs > staleLockMs) {
            await rm(path, { force: true });
            continue;
        }
        if (signal?.aborted) return null;
        await new Promise((done) => setTimeout(done, 200));
        if (!await stat(path).catch(() => null)) return { path: null, waited: true };
    }
}

function runBuild(engine, args, { onProgress, signal }) {
    return new Promise((done) => {
        const child = spawn(engine, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        let cancelled = false;
        const abort = () => { cancelled = true; child.kill('SIGKILL'); };
        signal?.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            let newline;
            while ((newline = stdout.indexOf('\n')) >= 0) {
                const line = stdout.slice(0, newline);
                stdout = stdout.slice(newline + 1);
                const step = /^step (\d+) of (\d+): (.*)$/.exec(line.trim());
                if (step) onProgress?.({ step: Number(step[1]), count: Number(step[2]), what: step[3] });
            }
        });
        child.stderr.on('data', (chunk) => { if (stderr.length < 1024 * 1024) stderr += chunk; });
        child.on('error', (error) => done({ code: null, stderr: error.message, cancelled }));
        child.on('close', (code) => {
            signal?.removeEventListener('abort', abort);
            done({ code, stderr: stderr.replace(/^ENGINE_FAILURE: /m, ''), cancelled });
        });
    });
}

// Builds the installed FMU `guid`/`version` from its sources, or finds its build. `engine` is the engine executable, `sdkPath` the
// engine's SDK folder (its include/fmiStandard holds the FMI headers), `compiler` findCCompiler's answer. `confirm(summary)` is asked
// before the first build of an archive (it resolves true to build); `onProgress({ step, count, what })` follows the build; `signal`
// cancels it (the file being compiled finishes first). `force` builds again even when a build is kept (Rebuild).
// Returns `{ status, ... }`: "cached" or "built" with `record` and `libraryPath`; "declined"; "cancelled"; "refused" with `message`
// (why it cannot be built); "failed" with `message` (the compiler's first error) and `log`.
export async function buildInstalledFmu({
    fmuDirectory, guid, version, engine, sdkPath, compiler, recipe = null, force = false, confirm = async () => true,
    onProgress = null, signal = null, timeoutSeconds = 300, tuple = platformTuple(), prefer = false, findCompiler = findCCompiler
}) {
    const fmu = await installedFmu(fmuDirectory, guid, version);
    const name = fmu.description.modelName;
    if (!fmu.build) return { status: 'refused', name, message: `${name} carries no build information (no buildDescription.xml and no <SourceFiles>).` };
    if (fmu.build.problems.length) return { status: 'refused', name, message: `Konjugate cannot build ${name}: ${fmu.build.problems[0]}.` };
    if (!compiler || compiler.message) return { status: 'refused', name, message: compiler?.message ?? 'No C compiler was found.' };
    // The exporter's recipe, when Konjugate keeps one for it (stage 4), unless the caller gives its own.
    recipe = recipe ?? fmu.build.recipe ?? null;
    // An exporter whose sources compile with some compilers only (OpenModelica's: GCC or clang) is built with one of them, found on
    // this computer when the compiler given is another (MSVC, on Windows), or refused saying why and what to install.
    if (recipe?.compilerFlavors && !recipe.compilerFlavors.includes(compiler.flavor)) {
        const fitting = await findCompiler({ flavors: recipe.compilerFlavors });
        if (fitting.message) return { status: 'refused', name, message: `Konjugate cannot build ${name} with ${compiler.banner}: ${recipe.compilerReason}. ${fitting.message}` };
        compiler = fitting;
    }
    const builds = buildsDirectoryOf(fmuDirectory);
    await mkdir(builds, { recursive: true });
    const folder = await mkdtemp(join(builds, 'building-'));
    let lock = null;
    try {
        await cp(resolve(fmu.fmuRoot, 'sources'), join(folder, 'sources'), { recursive: true });
        const headersDirectory = fmiStandardHeadersDirectory(sdkPath);
        const libraryName = `${fmu.description.modelIdentifier}${libraryExtension()}`;
        const { plan, problems, notes } = fmuSourceBuildPlan(fmu.build, {
            fmiVersion: fmu.description.fmiVersion, sourceRoot: join(folder, 'sources'), headersDirectory, objectDirectory: join(folder, 'objects'),
            output: join(folder, libraryName), compilerFamily: compiler.flavor, recipe, timeoutSeconds
        });
        if (problems.length) return { status: 'refused', name, message: `Konjugate cannot build ${name}: ${problems[0]}.` };
        await writeFile(join(folder, 'plan.json'), JSON.stringify(plan));
        const printed = await runProgram(engine, ['buildFmuSources', join(folder, 'plan.json'), '--compiler', compiler.compiler, '--print-steps']);
        if (printed.code !== 0) return { status: 'failed', name, message: firstError(printed.stderr), log: printed.stderr };
        const steps = portableSteps(JSON.parse(printed.stdout), { buildFolder: folder, headersDirectory });
        const key = buildKey({ archiveSha256: fmu.archiveSha256, compiler: compiler.compiler, banner: compiler.banner, tuple, steps, recipe, headers: await headersSha256(headersDirectory) });
        // The archive's latest build; run in place of a binary of its own when the person asked for it (`prefer`), or asked before.
        const pointTo = async () => {
            const path = resolve(builds, 'byArchive', `${fmu.archiveSha256}.json`);
            await inTurn(path, async () => {
                const preferred = prefer || Boolean((await readPointer(builds, fmu.archiveSha256))?.preferred);
                await mkdir(resolve(builds, 'byArchive'), { recursive: true });
                await writeJsonWhole(path, { key, ...(preferred ? { preferred: true } : {}) });
            });
        };
        if (!force) {
            const kept = await cachedBuild(builds, key);
            if (kept) {
                await pointTo();
                return { status: 'cached', name, record: kept.record, libraryPath: kept.libraryPath, notes };
            }
        }
        const confirmed = await confirmedArchives(builds);
        if (!confirmed.has(fmu.archiveSha256)) {
            const summary = {
                name, modelIdentifier: fmu.description.modelIdentifier, fmiVersion: fmu.description.fmiVersion, tuple,
                sourceFileCount: fmu.build.sourceFileCount, language: fmu.build.language, from: fmu.build.from, exporter: fmu.build.exporter,
                compiler: compiler.compiler, banner: compiler.banner, notes,
                files: plan.sets.flatMap((set) => set.files), definitions: [...new Set(plan.sets.flatMap((set) => set.definitions))], recipe: recipe?.name ?? null,
                hasOwnBinary: prefer
            };
            if (!await confirm(summary)) return { status: 'declined', name };
            await rememberConfirmedArchive(builds, fmu.archiveSha256);
        }
        lock = await takeLock(builds, key, signal);
        if (!lock) return { status: 'cancelled', name };
        if (lock.waited) {
            // Another window built it while this one waited.
            lock = null;
            const kept = await cachedBuild(builds, key);
            if (kept) {
                await pointTo();
                return { status: 'cached', name, record: kept.record, libraryPath: kept.libraryPath, notes };
            }
            return buildInstalledFmu({ fmuDirectory, guid, version, engine, sdkPath, compiler, recipe, force, confirm, onProgress, signal, timeoutSeconds, tuple, prefer, findCompiler });
        }
        const outcome = await runBuild(engine, ['buildFmuSources', join(folder, 'plan.json'), '--compiler', compiler.compiler, '--progress'], { onProgress: onProgress && ((progress) => onProgress({ ...progress, name })), signal });
        if (outcome.cancelled) return { status: 'cancelled', name };
        if (outcome.code !== 0) return { status: 'failed', name, message: firstError(outcome.stderr), log: outcome.stderr.trim() };
        const library = await readFile(join(folder, libraryName));
        const record = {
            key, archiveSha256: fmu.archiveSha256, name, modelIdentifier: fmu.description.modelIdentifier, fmiVersion: fmu.description.fmiVersion,
            tuple, compiler: compiler.compiler, banner: compiler.banner, recipe: recipe ? { name: recipe.name, version: recipe.version } : null,
            from: fmu.build.from, sourceFileCount: fmu.build.sourceFileCount, steps, library: libraryName, librarySha256: sha256(library),
            builtAt: new Date().toISOString()
        };
        const partial = resolve(builds, `${key}.partial`);
        await rm(partial, { recursive: true, force: true });
        await mkdir(partial, { recursive: true });
        await writeFile(resolve(partial, libraryName), library);
        await writeFile(resolve(partial, 'build.log'), `${steps.map((step) => `${step.what}\n  ${[step.compiler, ...step.arguments].join(' ')}`).join('\n')}\n${outcome.stderr}`);
        await writeFile(resolve(partial, 'build.json'), JSON.stringify(record, null, 2));
        await rm(resolve(builds, key), { recursive: true, force: true });
        await rename(partial, resolve(builds, key));
        await pointTo();
        return { status: 'built', name, record, libraryPath: resolve(builds, key, libraryName), notes };
    } finally {
        if (lock?.path) await rm(lock.path, { force: true });
        await rm(folder, { recursive: true, force: true });
    }
}

// A build's log, for Show build log.
export async function buildLog(fmuDirectory, archiveSha256) {
    const builds = buildsDirectoryOf(fmuDirectory);
    const pointer = await readPointer(builds, archiveSha256);
    return pointer ? readFile(resolve(builds, pointer.key, 'build.log'), 'utf8').catch(() => null) : null;
}

// Removes the builds of an archive (an FMU uninstalled), or every build (Settings' Clear FMU builds, with `archiveSha256` null).
export async function removeBuilds(fmuDirectory, archiveSha256 = null) {
    const builds = buildsDirectoryOf(fmuDirectory);
    if (archiveSha256 === null) {
        await rm(builds, { recursive: true, force: true });
        return;
    }
    for (const entry of await readdir(builds, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
        const record = JSON.parse(await readFile(resolve(builds, entry.name, 'build.json'), 'utf8').catch(() => 'null'));
        if (record?.archiveSha256 === archiveSha256) await rm(resolve(builds, entry.name), { recursive: true, force: true });
    }
    await rm(resolve(builds, 'byArchive', `${archiveSha256}.json`), { force: true });
    await inTurn(resolve(builds, 'confirmed.json'), async () => {
        const confirmed = await confirmedArchives(builds);
        if (confirmed.delete(archiveSha256)) await writeJsonWhole(resolve(builds, 'confirmed.json'), [...confirmed]);
    });
}
