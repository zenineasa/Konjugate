// Copyright © 2026 Zenin Easa Panthakkalakath

// The checks every release runs (.github/workflows/release.yml) and a developer can run with `npm run test:release`: that code export
// (C++ in each of its parallel modes, and Python), FMU export (FMI 2.0 and FMI 3.0) and the FMU round trip give the engine's own numbers, and that the
// accuracy benchmarks still meet their thresholds. Each check runs in turn against one engine build; the summary at the end says what
// passed, what failed, what was skipped and why, and how long each took. Exits with status 1 if any check failed.
//
//   node scripts/runReleaseChecks.mjs [--engine <path>] [--require mpi,fmpy]
//
//   --engine <path>   the konjugateEngine executable (default: out/engine/konjugateEngine)
//   --require <list>  tools whose absence fails the run instead of skipping what needs them: mpi (mpic++, mpirun and mpi4py, for the
//                     C++ and Python MPI modes), fmpy (the independent FMI simulator the FMU export fidelity check drives). A release
//                     runner that installs a tool requires it, so a broken install cannot pass as a skip.
//
// Without a tool, what needs it is skipped and said so, here and in the summary, never silently. The C++ checks need a C++ compiler
// with GCC/Clang-style flags (CXX, default c++), and OpenMP (on macOS, Homebrew's libomp); Python ones need python3 (PYTHON).

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { rootDirectory } from './developmentEnvironment.mjs';

const { values: options } = parseArgs({
    options: {
        engine: { type: 'string' },
        require: { type: 'string', default: '' }
    }
});
const engine = options.engine ?? join(rootDirectory, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const required = new Set(options.require.split(',').map((tool) => tool.trim()).filter(Boolean));
for (const tool of required) {
    if (!['mpi', 'fmpy'].includes(tool)) {
        console.error(`Unknown tool to require: ${tool}. Known: mpi, fmpy.`);
        process.exit(2);
    }
}
const inActions = process.env.GITHUB_ACTIONS === 'true';
const python = process.env.PYTHON || 'python3';
// Long enough for the slowest runner to finish any one of them several times over; a check that hangs (an MPI launch that never
// returns, say) fails with a message instead of holding the release until the job's own limit.
const checkTimeoutMilliseconds = 30 * 60 * 1000;

function execute(executable, args, { stream = false, timeout = 0 } = {}) {
    return new Promise((resolve) => {
        let output = '';
        let timedOut = false;
        let child;
        try {
            // KONJUGATE_ENGINE_PATH: FMU export finds the engine it compiles with there first (resolveEnginePath), so every check uses
            // the one engine named here.
            child = spawn(executable, args, { cwd: rootDirectory, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KONJUGATE_ENGINE_PATH: engine } });
        } catch (error) {
            resolve({ code: null, output: String(error.message), timedOut });
            return;
        }
        const take = (chunk, target) => { output += chunk; if (stream) target.write(chunk); };
        child.stdout.on('data', (chunk) => take(chunk, process.stdout));
        child.stderr.on('data', (chunk) => take(chunk, process.stderr));
        const timer = timeout ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout) : null;
        child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, output: output + String(error.message), timedOut }); });
        child.once('close', (code) => { clearTimeout(timer); resolve({ code, output, timedOut }); });
    });
}

const found = async (executable) => (await execute(process.platform === 'win32' ? 'where' : 'which', [executable])).code === 0;
const pythonImports = async (module) => (await execute(python, ['-c', `import ${module}`])).code === 0;

// ---- what this machine has ----------------------------------------------------------------------------------------------------
const tools = {
    engine: existsSync(engine),
    cxx: await found(process.env.CXX || 'c++'),
    python: await found(python),
    mpicxx: await found(process.env.MPICXX || 'mpic++'),
    mpirun: await found(process.env.MPIRUN || 'mpirun')
};
tools.mpi4py = tools.python && await pythonImports('mpi4py');
tools.fmpy = tools.python && await pythonImports('fmpy');
if (process.platform === 'darwin') {
    const prefix = (await execute('brew', ['--prefix', 'libomp'])).output.trim();
    tools.libomp = Boolean(prefix) && existsSync(join(prefix, 'include', 'omp.h'));
} else {
    tools.libomp = true;
}

const problems = [];
const notes = [];
if (!tools.engine) problems.push(`No engine at ${engine}: build it with npm run build:engine, or name one with --engine.`);
if (!tools.cxx) problems.push(`No C++ compiler (${process.env.CXX || 'c++'}): the C++ export and FMU checks need one. Set CXX to name it.`);
if (!tools.python) problems.push(`No Python (${python}): the Python export check needs it. Set PYTHON to name it.`);
if (!tools.libomp) problems.push('No OpenMP for the C++ openmp mode: on macOS, brew install libomp.');
const cppMpi = tools.mpicxx && tools.mpirun;
const pythonMpi = tools.mpirun && tools.mpi4py;
const missingMpi = [!tools.mpicxx && 'mpic++', !tools.mpirun && 'mpirun', !tools.mpi4py && 'mpi4py'].filter(Boolean);
if (missingMpi.length) {
    const message = `MPI: ${missingMpi.join(', ')} not found, so ${[!cppMpi && 'the C++ mpi mode', !pythonMpi && 'the Python mpi mode'].filter(Boolean).join(' and ')} ${!cppMpi && !pythonMpi ? 'are' : 'is'} not checked.`;
    if (required.has('mpi')) problems.push(`${message} This run requires MPI.`);
    else notes.push(`${message} Install Open MPI (and pip install mpi4py) to check ${!cppMpi && !pythonMpi ? 'them' : 'it'}.`);
}
if (!tools.fmpy) {
    const message = 'FMPy is not importable, so the FMU export fidelity checks (an independent FMI simulator driving the exported FMI 2.0 and FMI 3.0 FMUs) do not run.';
    if (required.has('fmpy')) problems.push(`${message} This run requires FMPy (pip install fmpy).`);
    else notes.push(`${message} pip install fmpy to run it; the FMU round trip below still checks the FMU without it.`);
}

// ---- the checks ---------------------------------------------------------------------------------------------------------------
const checks = [
    { name: 'Code export fidelity (C++ serial, openmp, stdThread, mpi; Python)', script: 'tests/engine/codeExportFidelity.mjs', args: [engine] },
    { name: 'FMU export fidelity (FMPy)', script: 'tests/engine/fmiExportFidelity.mjs', args: [engine] },
    { name: 'FMI 3.0 FMU export fidelity (FMPy)', script: 'tests/engine/fmi3ExportFidelity.mjs', args: [engine] },
    { name: 'FMU round trip', script: 'tests/engine/fmiRoundTrip.mjs', args: [engine] },
    { name: 'FMI example FMUs (examples/fmi)', script: 'tests/engine/fmiExamples.mjs', args: [engine] },
    { name: 'FMU export with declared ports (FMPy)', script: 'tests/engine/fmiPortsExportFidelity.mjs', args: [engine] },
    { name: 'Test signals for in ports', script: 'tests/engine/rootPortSignals.mjs', args: [engine] },
    { name: 'Controller example from OpenModelica (examples/pidController)', script: 'tests/engine/pidControllerExample.mjs', args: [engine] },
    { name: 'Accuracy benchmarks', script: 'benchmarks/run.mjs', args: ['--accuracy', '--engine', engine] }
];

const results = [];
const started = Date.now();
if (problems.length) {
    for (const problem of problems) console.error(inActions ? `::error title=Release checks::${problem}` : `✖ ${problem}`);
} else {
    for (const note of notes) console.log(inActions ? `::warning title=Release checks::${note}` : `! ${note}`);
    for (const check of checks) {
        console.log(inActions ? `::group::${check.name}` : `\n=== ${check.name} ===`);
        const begun = Date.now();
        const run = await execute(process.execPath, [join(rootDirectory, check.script), ...check.args], { stream: true, timeout: checkTimeoutMilliseconds });
        const seconds = (Date.now() - begun) / 1000;
        if (inActions) console.log('::endgroup::');
        const skipped = [...run.output.matchAll(/\(skipping ([^)]*)\)/g)].map((match) => match[1]);
        // A check that skipped everything it does (FMPy missing, say) did not pass: it did not run.
        const ranNothing = run.code === 0 && skipped.length > 0 && !/✓/.test(run.output);
        const outcome = run.timedOut ? 'failed' : run.code !== 0 ? 'failed' : ranNothing ? 'skipped' : 'passed';
        const failure = run.timedOut
            ? `did not finish within ${checkTimeoutMilliseconds / 60000} minutes`
            : (run.output.match(/^\s*(AssertionError[^\n]*|Error[^\n]*|[^\n]*(?:diverges|must|did not)[^\n]*)$/m)?.[1]?.trim() ?? `exited with status ${run.code}`);
        results.push({ ...check, outcome, seconds, skipped, failure: outcome === 'failed' ? failure : null, tail: outcome === 'failed' ? run.output.trim().split('\n').slice(-25).join('\n') : '' });
        if (outcome === 'failed' && inActions) console.log(`::error title=${check.name} failed::${failure}`);
    }
}

// ---- the summary --------------------------------------------------------------------------------------------------------------
const symbol = { passed: '✓', failed: '✖', skipped: '–' };
const totalSeconds = (Date.now() - started) / 1000;
const failed = problems.length > 0 || results.some((result) => result.outcome === 'failed');
const lines = ['', `Release checks on ${process.platform} ${process.arch}: ${failed ? 'FAILED' : 'passed'} in ${totalSeconds.toFixed(0)} s`];
for (const problem of problems) lines.push(`  ✖ ${problem}`);
for (const result of results) {
    lines.push(`  ${symbol[result.outcome]} ${result.name}: ${result.outcome} (${result.seconds.toFixed(1)} s)`);
    for (const skip of result.skipped) lines.push(`      skipped: ${skip}`);
    if (result.failure) lines.push(`      ${result.failure}`);
}
for (const note of notes) lines.push(`  ! ${note}`);
console.log(lines.join('\n'));
for (const result of results.filter((candidate) => candidate.outcome === 'failed')) {
    console.log(`\n--- The end of "${result.name}"'s output ---\n${result.tail}`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
    const markdown = [
        `### Release checks (${process.platform} ${process.arch}): ${failed ? 'failed' : 'passed'}`, '',
        ...problems.map((problem) => `- ✖ ${problem}`),
        ...(results.length ? ['| Check | Result | Time | Notes |', '| --- | --- | --- | --- |'] : []),
        ...results.map((result) => `| ${result.name} | ${symbol[result.outcome]} ${result.outcome} | ${result.seconds.toFixed(1)} s | ${[...result.skipped.map((skip) => `skipped: ${skip}`), result.failure].filter(Boolean).join('; ').replaceAll('|', '\\|')} |`),
        '', ...notes.map((note) => `- ${note}`),
        ...results.filter((result) => result.outcome === 'failed').flatMap((result) => ['', `<details><summary>${result.name}: the end of its output</summary>`, '', '```', result.tail, '```', '', '</details>']),
        ''
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown.join('\n')}\n`);
}
process.exitCode = failed ? 1 : 0;
