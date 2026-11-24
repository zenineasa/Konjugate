/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Konjugate evaluated against established tools, reproducibly (benchmarks/README.md, Comparisons with established tools): the problems of
// problems.mjs under Konjugate's engine, its exported C++ (code export, its compiled path), SciPy's solve_ivp, Julia's
// DifferentialEquations.jl and OpenModelica, at relative tolerances from 1e-3 to 1e-10, each with the same equations, absolute tolerances
// and output samples. For every method and tolerance: the error against the problem's reference and the time to solve, kept apart from
// starting the process, loading or compiling (Konjugate's planning, the C++ compiler, Julia's packages and its first, compiling solve,
// OpenModelica's translation and C compilation).
//
//   node benchmarks/comparisons/compare.mjs [--only <problem id text>] [--tools konjugate,export,scipy,julia] [--rounds 5]
//        [--output <dir>] [--wait-for-quiet] [--python <venv python>] [--julia <julia>]
//   node benchmarks/comparisons/compare.mjs --tools openmodelica ...      phase 2, with Docker running (and quit for phase 1)
//
// The tools are interleaved so that drift (heat, background work) falls on all of them alike: for each problem, after an untimed setup,
// each round runs every tool in turn, Konjugate, its C++ export, SciPy, Julia, and each tool runs every one of its
// configurations once untimed (warm-up) and once timed; the rounds repeat. SciPy and Julia stay running between rounds (each serves
// commands on its standard input), so Julia compiles each method once. A configuration whose timed run took longer than 20 s is timed in
// three rounds only, one longer than 120 s in the first only, and tighter tolerances of its method are not run. With --wait-for-quiet every
// timed run is preceded by the quiet check of lib/quiet.mjs, and each problem by its full gate. OpenModelica runs only in a Linux container
// under Docker here, whose virtual machine would disturb the native tools: it is a second phase of its own (--tools openmodelica), its
// errors comparable with the rest and its times not, as the report says. The computer's state (load, power, thermal
// state) is recorded at the start and the end. Timing is local: run it on a quiet computer on mains power (the README's Timing).

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { generateStandaloneProgram } from '../../src/codeExport.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { createEngine, repositoryRoot, resolveEngineExecutable, trajectory } from '../lib/engine.mjs';
import { conditions, engineBuild, machineDetails } from '../lib/machine.mjs';
import { resultsDirectory, sourceIdentity } from '../lib/results.mjs';
import { errorMetrics, spread } from '../lib/metrics.mjs';
import { createQuietGate } from '../lib/quiet.mjs';
import { createOpenModelica, solvers as openModelicaSolvers } from './openmodelica/openmodelica.mjs';
import { comparisonProblems, families, tolerances, toolSpecification } from './problems.mjs';
import { startServer } from './runnerServer.mjs';
import { juliaArguments, juliaEnvironment, juliaLauncher, pythonExecutable } from './tools.mjs';

const { values: options } = parseArgs({
    options: {
        only: { type: 'string' },
        tools: { type: 'string', default: 'konjugate,export,scipy,julia' },
        rounds: { type: 'string', default: '5' },
        output: { type: 'string' },
        engine: { type: 'string' },
        python: { type: 'string', default: pythonExecutable },
        julia: { type: 'string', default: juliaLauncher() },
        cxx: { type: 'string', default: 'c++' },
        'wait-for-quiet': { type: 'boolean', default: false }
    }
});
const rounds = Number(options.rounds);
const tools = new Set(options.tools.split(','));
const here = import.meta.dirname;
const quietCommand = options['wait-for-quiet'] ? `${process.execPath} ${join(repositoryRoot, 'benchmarks', 'lib', 'quiet.mjs')} --wait` : '';
const quiet = options['wait-for-quiet'] ? createQuietGate() : null;
// Phase 1 times the native tools together; OpenModelica, in a Linux container under Docker, runs as phase 2, apart (README, Comparisons).
const phase = tools.size === 1 && tools.has('openmodelica') ? 'openmodelicaInDocker' : 'native';
if (phase === 'native' && tools.has('openmodelica')) console.warn('OpenModelica runs in Docker, whose virtual machine disturbs the native tools: run it on its own, --tools openmodelica, with Docker quit for the rest.');
// As the exported file's own header tells its user to compile it, the optimisation the shipped engine is built with too.
const compileFlags = ['-std=c++20', '-O2', '-DNDEBUG'];
const longRun = 20;
const budget = 120;
const oneThread = { ...juliaEnvironment(), OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1', MKL_NUM_THREADS: '1' };

function execute(command, args, { env = process.env } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
        let output = '';
        let diagnostics = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, output, diagnostics }));
    });
}

function command(file, args) {
    try { return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

const applicable = (problem, family) => !(family === 'explicit' && problem.skipped.explicit);
const comparedIds = (problem) => problem.compared.map((index) => problem.stateIds[index]);
const keyOf = (record) => [record.problem, record.tool, record.method, record.switching ?? '', record.tolerance].join('|');
const seriesOf = (record) => [record.problem, record.tool, record.method, record.switching ?? ''].join('|');

function familyOf(tool, method) {
    if (tool === 'OpenModelica') return 'multistep';
    const property = { Konjugate: 'konjugate', 'Konjugate C++ export': 'konjugate', SciPy: 'scipy', Julia: 'julia' }[tool];
    return Object.entries(families).find(([, family]) => family[property].includes(method))?.[0] ?? null;
}

// The model with each state's absolute tolerance the relative tolerance times its scale (constant inputs: the relative tolerance), and its
// run configuration set to the method, so the engine and code export read the same settings.
function documentFor(problem, method, relative) {
    const document = structuredClone(problem.document);
    const scales = new Map(problem.stateIds.map((id, index) => [id, problem.absoluteScale[index]]));
    for (const node of document.nodes) {
        for (const state of node.states) state.numerics = { ...(state.numerics ?? {}), absoluteTolerance: relative * (scales.get(state.id) ?? 1) };
    }
    document.runConfigurations = [{
        id: 9000, name: 'Comparison', globalTimeStep: problem.run.outputInterval, targetTime: problem.run.targetTime, outputInterval: problem.run.outputInterval,
        method, tolerance: { relative, absolute: relative }
    }];
    document.activeRunConfigurationId = 9000;
    return document;
}

function parseCsv(text) {
    const [header, ...lines] = text.trim().split('\n');
    const split = (line) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).slice(0, -1).map((field) => field.replace(/,$/, '').replace(/^"|"$/g, '').replaceAll('""', '"'));
    return { columns: split(header), rows: lines.map((line) => line.split(',').map(Number)) };
}

function exportedColumns(document, ids, columns) {
    return ids.map((id) => {
        const node = document.nodes.find((candidate) => candidate.states.some((state) => state.id === id));
        const state = node.states.find((candidate) => candidate.id === id);
        const heading = `${node.name} — ${state.name}${state.unit ? ` (${state.unit})` : ''}`;
        const index = columns.indexOf(heading);
        if (index < 0) throw new Error(`The exported program's CSV has no column ${heading}.`);
        return index;
    });
}

async function prepareReference(problem, work) {
    let reference = problem.reference;
    if (reference.computed) {
        const specPath = join(work, `${problem.id}-reference-spec.json`);
        await writeFile(specPath, JSON.stringify(toolSpecification(problem, reference)));
        const output = join(work, `${problem.id}-reference.json`);
        const { code, diagnostics } = await execute(options.python, ['-I', join(here, 'scipyRunner.py'), '--spec', specPath, '--reference', '--output', output]);
        if (code !== 0) throw new Error(`The reference for ${problem.id} could not be computed: ${diagnostics.slice(-300)}`);
        reference = JSON.parse(await readFile(output, 'utf8'));
    }
    // A reference carries either the compared states only or every state of the tools' vector.
    const samples = reference.samples[0].length === problem.compared.length ? reference.samples : reference.samples.map((sample) => problem.compared.map((index) => sample[index]));
    return { samples, description: { source: reference.source, ...(reference.radauBdfAgreement !== undefined ? {
        radauBdfAgreement: reference.radauBdfAgreement, largestRelativeDifferenceFromCommittedCheckpoints: reference.largestRelativeDifferenceFromCommittedCheckpoints, checkpointsCompared: reference.checkpointsCompared
    } : {}) } };
}

async function main() {
    const executable = resolveEngineExecutable(options.engine);
    const work = await mkdtemp(join('/tmp', 'konjugateComparisons-'));
    const engine = createEngine(executable, work, { beforeTimedRun: quiet?.beforeTimedRun ?? null });
    // The runners' own timed runs are logged here by the quiet check they call (lib/quiet.mjs), beside this process's.
    const quietLog = join(work, 'quiet.jsonl');
    oneThread.KONJUGATE_QUIET_LOG = quietLog;
    const source = sourceIdentity();
    const machine = { ...machineDetails(), engineBuild: engineBuild(executable) };
    const outputDirectory = options.output ?? join(resultsDirectory(machine), 'comparisons');
    await mkdir(outputDirectory, { recursive: true });
    const summaryPath = join(outputDirectory, 'comparisons.json');
    const previous = existsSync(summaryPath) ? JSON.parse(await readFile(summaryPath, 'utf8')) : null;
    const versions = { ...(previous?.versions ?? {}) };
    const references = { ...(previous?.references ?? {}) };
    const openModelicaTranslation = { ...(previous?.openModelicaTranslation ?? {}) };
    const merged = new Map();
    const problems = comparisonProblems().filter(({ id }) => !options.only || options.only.split(',').some((text) => id.includes(text)));

    // Every timed run lands here; the first carries the error and work, the rest add their times.
    const add = (record) => {
        const key = keyOf(record);
        const existing = merged.get(key);
        if (!existing) { merged.set(key, { ...record, family: familyOf(record.tool, record.method) }); return; }
        if (!record.ok) return;
        for (const field of ['solveSeconds', 'wallSeconds', 'planningSeconds']) if (record[field]) existing[field] = [...(existing[field] ?? []), ...record[field]];
        if (record.peakResidentBytes) existing.peakResidentBytes = Math.max(existing.peakResidentBytes ?? 0, record.peakResidentBytes);
    };

    if (quiet) await quiet.full('comparisons');
    const startConditions = conditions();
    console.log(`Start: load ${startConditions.loadAverage.join(' ')}; ${startConditions.power}; ${startConditions.thermal}`);
    const python = tools.has('scipy') ? await startServer(options.python, ['-I', join(here, 'scipyRunner.py'), '--serve', '--quiet-command', quietCommand], { env: oneThread }) : null;
    const julia = tools.has('julia') ? await startServer(options.julia, juliaArguments(`--project=${join(here, 'julia')}`, '--startup-file=no', join(here, 'julia', 'juliaRunner.jl'), '--quiet-command', quietCommand), { env: oneThread }) : null;
    if (python) versions.scipy = python.hello.versions;
    if (julia) versions.julia = julia.hello.versions;
    const openModelica = tools.has('openmodelica') ? createOpenModelica(work) : null;
    if (openModelica) { await openModelica.start(); versions.openmodelica = openModelica.version; }
    try {
        for (const problem of problems) {
            console.log(`${problem.title}: setting up`);
            const reference = await prepareReference(problem, work);
            references[problem.id] = reference.description;
            const specPath = join(work, `${problem.id}-spec.json`);
            await writeFile(specPath, JSON.stringify(toolSpecification(problem, { samples: reference.samples })));
            const familiesHere = Object.entries(families).filter(([key]) => applicable(problem, key)).map(([, family]) => family);
            const konjugateMethods = familiesHere.flatMap((family) => family.konjugate);
            const switchings = problem.switchingInstants ? ['written', 'given'] : ['written'];
            const run = { globalTimeStep: problem.run.outputInterval, targetTime: problem.run.targetTime, outputInterval: problem.run.outputInterval };
            // Untimed setup: Konjugate's models, the exported programs compiled, OpenModelica's model translated and compiled. Each method's
            // first program is compiled alone, and its compile time is the one reported; the other tolerances' programs, the same source
            // but for the tolerance, are compiled up to four at a time, untimed.
            const models = new Map();
            const programs = new Map();
            const builds = [];
            for (const method of konjugateMethods) {
                for (const relative of tolerances) {
                    const document = documentFor(problem, method, relative);
                    const path = join(work, `${problem.id}-${method}-${relative}.kjt`);
                    await writeFile(path, await encodeProjectFile(JSON.stringify(document)));
                    models.set(`${method}|${relative}`, path);
                    if (!tools.has('export')) continue;
                    const source = join(work, `${problem.id}-${method}-${relative}.cpp`);
                    const binary = join(work, `${problem.id}-${method}-${relative}`);
                    try {
                        await writeFile(source, generateStandaloneProgram(document, 'cpp'));
                        builds.push({ method, relative, document, source, binary });
                    } catch (error) {
                        add({ problem: problem.id, tool: 'Konjugate C++ export', method, tolerance: relative, ok: false, error: error.message.slice(0, 300) });
                    }
                }
            }
            const compile = async (build) => {
                const compileStarted = performance.now();
                const compiled = await execute(options.cxx, [...compileFlags, build.source, '-o', build.binary]);
                if (compiled.code !== 0) {
                    add({ problem: problem.id, tool: 'Konjugate C++ export', method: build.method, tolerance: build.relative, ok: false, error: `did not compile: ${compiled.diagnostics.slice(0, 200)}` });
                    return null;
                }
                return (performance.now() - compileStarted) / 1000;
            };
            const soloSeconds = new Map();
            for (const method of konjugateMethods) {
                const first = builds.find((build) => build.method === method);
                if (!first) continue;
                const seconds = await compile(first);
                if (seconds !== null) { soloSeconds.set(method, seconds); programs.set(`${method}|${first.relative}`, { binary: first.binary, document: first.document, compileSeconds: seconds }); }
            }
            const rest = builds.filter((build) => !programs.has(`${build.method}|${build.relative}`) && soloSeconds.has(build.method));
            for (let index = 0; index < rest.length; index += 4) {
                const batch = rest.slice(index, index + 4);
                const outcomes = await Promise.all(batch.map(compile));
                batch.forEach((build, position) => {
                    if (outcomes[position] !== null) programs.set(`${build.method}|${build.relative}`, { binary: build.binary, document: build.document, compileSeconds: soloSeconds.get(build.method) });
                });
            }
            if (builds.length) console.log(`  C++ export: ${programs.size} programs compiled; alone, ${[...soloSeconds].map(([method, seconds]) => `${method} ${seconds.toFixed(1)} s`).join(', ')}`);
            if (openModelica) {
                try {
                    openModelicaTranslation[problem.id] = await openModelica.build(problem);
                    console.log(`  OpenModelica: translated in ${openModelicaTranslation[problem.id].translation.toFixed(2)} s, C compiled in ${openModelicaTranslation[problem.id].compile.toFixed(2)} s`);
                } catch (error) {
                    add({ problem: problem.id, tool: 'OpenModelica', method: 'dassl', tolerance: null, ok: false, error: error.message.slice(0, 300) });
                }
            }
            // Which rounds each configuration is timed in, decided from its first: all, three, or the first only; and the tolerances not
            // run at all because a looser one of the same method took longer than the budget.
            const roundsOf = new Map();
            const stopped = new Set();
            const allowed = (series, relative, round) => !(stopped.has(series) && relative < stopped.get(series)) && round <= (roundsOf.get(`${series}|${relative}`) ?? rounds);
            const settle = (record) => {
                if (!record.ok || !record.solveSeconds) return;
                const series = seriesOf(record);
                const timed = record.solveSeconds[0];
                if (!roundsOf.has(`${series}|${record.tolerance}`)) roundsOf.set(`${series}|${record.tolerance}`, timed > budget ? 1 : timed > longRun ? 3 : rounds);
                if (timed > budget && !(stopped.get(series) <= record.tolerance)) stopped.set(series, record.tolerance);
            };
            const skipList = (series, round) => tolerances.filter((relative) => !allowed(series, relative, round));
            if (quiet) await quiet.full(problem.id);
            for (let round = 1; round <= rounds; ++round) {
                console.log(`${problem.title}: round ${round} of ${rounds}`);
                if (tools.has('konjugate')) {
                    for (const method of konjugateMethods) {
                        const series = [problem.id, 'Konjugate', method, ''].join('|');
                        for (const relative of tolerances) {
                            if (!allowed(series, relative, round)) continue;
                            const record = { problem: problem.id, tool: 'Konjugate', method, tolerance: relative };
                            try {
                                const variant = { method, tolerance: { relative, absolute: relative } };
                                const warm = await engine.run(models.get(`${method}|${relative}`), variant, run, { modelAsIs: true });
                                const timed = await engine.run(models.get(`${method}|${relative}`), variant, run, { modelAsIs: true, measure: true });
                                const entry = {
                                    ...record, ok: true, solveSeconds: [timed.timing.engineComputeMilliseconds / 1000], wallSeconds: [timed.timing.wallMilliseconds / 1000],
                                    planningSeconds: [timed.timing.planningMilliseconds / 1000], peakResidentBytes: timed.timing.peakResidentBytes
                                };
                                if (round === 1) {
                                    entry.relativeError = errorMetrics(trajectory(warm, comparedIds(problem)), reference.samples).relativeError;
                                    entry.work = { nfev: warm.work.modelEvaluations ?? null, njev: warm.work.jacobians ?? null, nlu: warm.work.factorisations ?? null, steps: warm.work.methodSteps ?? null, rejected: warm.work.rejectedSteps ?? null };
                                }
                                add(entry);
                                settle({ ...entry, solveSeconds: entry.wallSeconds });
                            } catch (error) {
                                add({ ...record, ok: false, error: error.message.slice(0, 300) });
                            }
                        }
                    }
                }
                if (tools.has('export')) {
                    for (const method of konjugateMethods) {
                        const series = [problem.id, 'Konjugate C++ export', method, ''].join('|');
                        for (const relative of tolerances) {
                            const program = programs.get(`${method}|${relative}`);
                            if (!program || !allowed(series, relative, round)) continue;
                            const record = { problem: problem.id, tool: 'Konjugate C++ export', method, tolerance: relative };
                            try {
                                const csvPath = `${program.binary}.csv`;
                                const args = ['--target-time', String(problem.run.targetTime), '--output', csvPath];
                                const warm = await execute(program.binary, args);
                                if (warm.code !== 0) throw new Error(`exited ${warm.code}: ${warm.diagnostics.slice(0, 200)}`);
                                const entry = { ...record, ok: true, compileSeconds: program.compileSeconds, compileFlags: compileFlags.join(' ') };
                                if (round === 1) {
                                    const { columns, rows } = parseCsv(await readFile(csvPath, 'utf8'));
                                    const indexes = exportedColumns(program.document, comparedIds(problem), columns);
                                    entry.relativeError = errorMetrics(rows.map((row) => indexes.map((index) => row[index])), reference.samples).relativeError;
                                }
                                if (quiet) await quiet.beforeTimedRun(`${problem.id} export`);
                                const started = performance.now();
                                const timed = await execute(program.binary, args);
                                const seconds = (performance.now() - started) / 1000;
                                if (timed.code !== 0) throw new Error(`exited ${timed.code}`);
                                add({ ...entry, solveSeconds: [seconds], wallSeconds: [seconds] });
                                settle({ ...entry, solveSeconds: [seconds] });
                            } catch (error) {
                                add({ ...record, ok: false, error: error.message.slice(0, 300) });
                            }
                        }
                    }
                }
                for (const [server, tool, methods] of [[python, 'SciPy', familiesHere.flatMap((family) => family.scipy)], [julia, 'Julia', familiesHere.flatMap((family) => family.julia)]]) {
                    if (!server) continue;
                    for (const method of methods) {
                        for (const switching of switchings) {
                            const series = [problem.id, tool, method, switching].join('|');
                            const skip = skipList(series, round);
                            if (skip.length === tolerances.length) continue;
                            const reply = await server.ask({ spec: specPath, method, switching, skip });
                            for (const record of reply.records) {
                                const entry = { problem: problem.id, ...record };
                                if (round > 1) { delete entry.relativeError; delete entry.work; }
                                add(entry);
                                settle(entry);
                            }
                        }
                    }
                }
                if (openModelica && openModelicaTranslation[problem.id]) {
                    for (const solver of openModelicaSolvers) {
                        const series = [problem.id, 'OpenModelica', solver, ''].join('|');
                        for (const relative of tolerances) {
                            if (!allowed(series, relative, round)) continue;
                            const record = { problem: problem.id, tool: 'OpenModelica', method: solver, tolerance: relative };
                            try {
                                const warm = await openModelica.run(problem, solver, relative, round === 1 ? reference.samples : null);
                                if (quiet) await quiet.beforeTimedRun(`OpenModelica ${solver} ${problem.id}`);
                                const timed = await openModelica.run(problem, solver, relative);
                                const entry = { ...record, ok: true, solveSeconds: [timed.seconds], wallSeconds: [timed.wallSeconds], ...(round === 1 ? { relativeError: warm.relativeError, work: warm.work } : {}) };
                                add(entry);
                                settle(entry);
                            } catch (error) {
                                add({ ...record, ok: false, error: error.message.slice(0, 300) });
                            }
                        }
                    }
                }
            }
            // The tolerances a looser one's budget kept from running, named.
            for (const [series, from] of stopped) {
                const [problemId, tool, method, switching] = series.split('|');
                for (const relative of tolerances.filter((value) => value < from)) {
                    if (!merged.has(keyOf({ problem: problemId, tool, method, switching, tolerance: relative }))) {
                        add({ problem: problemId, tool, method, ...(switching ? { switching } : {}), tolerance: relative, ok: false, error: `not run: a looser tolerance took longer than ${budget} s` });
                    }
                }
            }
            for (const record of merged.values()) {
                if (record.problem !== problem.id || !record.ok) continue;
                console.log(`  ${record.tool} ${record.method}${record.switching === 'given' ? ' (given)' : ''} rtol ${record.tolerance}: median ${(spread(record.solveSeconds).median * 1000).toFixed(2)} ms over ${record.solveSeconds.length}, error ${Number(record.relativeError).toExponential(2)}`);
            }
        }
    } finally {
        python?.stop();
        julia?.stop();
        await openModelica?.stop();
    }
    const endConditions = conditions();
    console.log(`End: load ${endConditions.loadAverage.join(' ')}; ${endConditions.power}; ${endConditions.thermal}`);
    // Starting each tool apart from any solve, measured after the rounds: Python with its imports, Julia bare and with its packages.
    const startup = { ...(previous?.startup ?? {}) };
    const timedStart = async (file, args) => {
        await execute(file, args, { env: oneThread });
        const times = [];
        for (let index = 0; index < rounds; ++index) {
            if (quiet) await quiet.beforeTimedRun('startup');
            const started = performance.now();
            if ((await execute(file, args, { env: oneThread })).code !== 0) return null;
            times.push((performance.now() - started) / 1000);
        }
        return spread(times);
    };
    if (python) startup.scipy = { interpreterAndImport: await timedStart(options.python, ['-I', '-c', 'import numpy, scipy.integrate']) };
    if (julia) {
        startup.julia = {
            bareStart: await timedStart(options.julia, juliaArguments('--startup-file=no', '-e', '0')),
            startAndLoad: await timedStart(options.julia, juliaArguments(`--project=${join(here, 'julia')}`, '--startup-file=no', '-e', 'using OrdinaryDiffEqCore, OrdinaryDiffEqTsit5, OrdinaryDiffEqLowOrderRK, OrdinaryDiffEqRosenbrock, OrdinaryDiffEqBDF, SciMLBase, SparseArrays, LinearAlgebra, JSON')),
            loadInRunner: julia.hello.loadSeconds
        };
    }
    const translations = Object.values(openModelicaTranslation);
    if (translations.length) {
        startup.openmodelica = {
            'Translating a model: frontend, backend and code generation (median over problems)': spread(translations.map((entry) => entry.translation)).median,
            'Compiling the generated C (median over problems)': spread(translations.map((entry) => entry.compile)).median
        };
    }
    versions.konjugate = { version: source.konjugateVersion, commit: source.gitCommit, workingTreeChanges: source.workingTreeChanges, uncommittedSources: source.uncommittedSources, engineBuild: machine.engineBuild, exportCompiler: `${command(options.cxx, ['--version']).split('\n')[0]} ${compileFlags.join(' ')}` };
    // Records of problems and tools run now replace those of an earlier run; the rest are kept, so the comparisons can be run in parts.
    const records = [...merged.values()];
    const ran = new Set(records.map((record) => `${record.problem}|${record.tool}`));
    const kept = (previous?.records ?? []).filter((record) => !ran.has(`${record.problem}|${record.tool}`));
    const summary = {
        description: 'Konjugate evaluated against established tools, reproducibly: benchmarks/comparisons/ (README, Comparisons with established tools)',
        updatedAt: new Date().toISOString(), machine, conditions: { ...(previous?.conditions ?? {}), [phase]: { start: startConditions, end: endConditions } }, rounds, versions, startup, references, openModelicaTranslation, tolerances, families,
        problems: comparisonProblems().map(({ id, title, kind, stiff, run, compared, skipped, initial }) => ({ id, title, kind, stiff, run, states: initial.length, compared: compared.length, skipped })),
        quietGate: { ...(previous?.quietGate ?? {}), [phase]: quiet?.summary() ?? null },
        records: [...kept, ...records]
    };
    await writeFile(summaryPath, `${JSON.stringify(summary, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? String(value) : value), 1)}\n`);
    if (quiet) {
        const runners = existsSync(quietLog) ? (await readFile(quietLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
        await writeFile(join(outputDirectory, `timing-conditions-${phase}.csv`), quiet.csv(runners));
        summary.quietGate[phase] = { ...summary.quietGate[phase], runnerTimedRuns: runners.length, runnerTimedRunsWithDockerUp: runners.filter((entry) => entry.docker).length };
        await writeFile(summaryPath, `${JSON.stringify(summary, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? String(value) : value), 1)}\n`);
    }
    await rm(work, { recursive: true, force: true });
    console.log(`Wrote ${summaryPath}`);
}

await main();
