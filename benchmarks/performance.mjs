/* Copyright © 2026 Zenin Easa Panthakkalakath */

// npm run benchmark:performance: a timing session, for a quiet computer with everything else closed (benchmarks/README.md, Reproduce these
// results). It has three parts, run in this order, or only those --only names:
//
//   problems      every problem's timing cases (node benchmarks/run.mjs --full --no-scaling), after the accuracy checks
//   scaling       graph scalability (node benchmarks/run.mjs --full --only scaling/graphScalability)
//   comparisons   Konjugate, its exported C++, SciPy and Julia, interleaved (node benchmarks/comparisons/compare.mjs)
//
// First the engine the app ships (out/engine, RelWithDebInfo, -O2) and the tools are brought up to date (benchmarks/setup.mjs), before
// anything is timed. Then, before each part: a preflight that refuses to go on, saying why, unless the computer is on mains power, Docker
// is quit and no compiler, build tool, Electron application (Agent Orchestrator, an editor), Konjugate app or test is running; and the
// idle computer measured for three minutes,
// every timed run of the part then waiting until the one-minute load average and the processor time of other processes are below that
// baseline plus 1 (lib/quiet.mjs), and logging its time, load and Docker state. Everything runs under caffeinate, printing progress and the
// time left.
//
// Each session writes to its own folder, benchmarks/results/<machine>/sessions/<date and time>/<part>/, and then the sessions so far that
// timed the newest source are combined (benchmarks/combine.mjs) into benchmarks/results/<machine>/report.html: so a long run may be split into
// sessions on different days, and repeated sessions show how much the computer's own variation moves the numbers.
//
// Options:
//   --only <parts>     problems, scaling, comparisons, separated by commas (default all three)
//   --dry-run          a quick, untimed check that everything works: one repetition, graphs up to 1,000 nodes, one round of the comparisons
//                      without the largest grid; the preflight is reported but does not stop it, and there is no baseline and no waiting for
//                      quiet; into out/benchmarks/performance-dry-run/
//   --baseline <s>     seconds of idle baseline before each part (default 180)
//
// OpenModelica, which runs here only in Docker, is a separate command afterwards: npm run benchmark:openmodelica.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { combineSessions } from './combine.mjs';
import { writeComparisonReport } from './comparisons/report.mjs';
import { comparisonProblems } from './comparisons/problems.mjs';
import { repositoryRoot } from './lib/engine.mjs';
import { conditions } from './lib/machine.mjs';
import { resultsDirectory } from './lib/results.mjs';
import { engineExecutable } from './lib/shippedEngine.mjs';
import { preflight } from './lib/quiet.mjs';
import { problems } from './problems.mjs';

const { values: options } = parseArgs({
    options: { 'dry-run': { type: 'boolean', default: false }, only: { type: 'string', default: 'problems,scaling,comparisons' }, baseline: { type: 'string' } }
});
const dryRun = options['dry-run'];
const parts = options.only.split(',').map((part) => part.trim()).filter(Boolean);
for (const part of parts) if (!['problems', 'scaling', 'comparisons'].includes(part)) throw new Error(`--only takes problems, scaling and comparisons, not ${part}.`);
const rounds = dryRun ? 1 : 5;
const scalingUpTo = dryRun ? 1000 : null;
const baselineSeconds = dryRun ? 0 : Number(options.baseline ?? 180);
const dryRunProblems = ['robertson', 'vanDerPol', 'lorenz', 'rcNetwork', 'stiffGrid256', 'buck'];
// The engine the app ships (lib/shippedEngine.mjs): the one timed is the one the accuracy checks run and the app runs.
const engine = engineExecutable;
// About how long each part takes on an Apple M1 (8 GB), without waiting for quiet; a slower or busier computer takes longer.
const expectedMinutes = dryRun ? { problems: 6, scaling: 4, comparisons: 25 } : { problems: 20, scaling: 110, comparisons: 150 };

const started = Date.now();
const clock = (milliseconds) => {
    const minutes = Math.max(0, Math.round(milliseconds / 60000));
    return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`;
};
const say = (text) => console.log(`\n=== ${text}`);

// The whole session stays awake: the command starts itself again under caffeinate.
if (process.platform === 'darwin' && !process.env.KONJUGATE_PERFORMANCE_CAFFEINATED && existsSync('/usr/bin/caffeinate')) {
    const child = spawn('/usr/bin/caffeinate', ['-dims', process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, KONJUGATE_PERFORMANCE_CAFFEINATED: '1' } });
    child.once('exit', (code) => process.exit(code ?? 1));
} else {
    try {
        process.exitCode = await main();
    } catch (error) {
        console.error(`\nStopped: ${error.message}`);
        process.exitCode = 1;
    }
}

// How many timed cases the suite times in a part, for the progress line.
function expectedCases(part) {
    let count = 0;
    for (const { id, directory } of problems) {
        const config = JSON.parse(readFileSync(join(directory, 'benchmark.json'), 'utf8'));
        if (part === 'problems') count += (config.timing ?? []).length;
        if (part === 'scaling' && id === 'scaling/graphScalability') {
            const sizes = Object.values(config.full.sizes).flat().filter((size) => !scalingUpTo || size <= scalingUpTo).length;
            count += sizes * config.methods.length * config.backends.length;
        }
    }
    return count;
}

// Runs a step, passing its output through, with a progress line against `total` units counted by `unit` (a pattern of its lines).
function step({ title, args, env, unit, total, estimateMinutes, acceptExit = [0] }) {
    return new Promise((resolve, reject) => {
        const stepStarted = Date.now();
        let done = 0;
        let lastReport = 0;
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: repositoryRoot });
        const forward = (stream, sink) => createInterface({ input: stream }).on('line', (line) => {
            sink.write(`${line}\n`);
            if (!unit?.test(line)) return;
            done += 1;
            if (Date.now() - lastReport < 30000 && done !== total) return;
            lastReport = Date.now();
            const elapsed = Date.now() - stepStarted;
            const left = done > 0 ? (elapsed / done) * Math.max(total - done, 0) : estimateMinutes * 60000;
            console.log(`[progress] ${title}: ${done} of ${total} · ${clock(elapsed)} so far · about ${clock(left)} left in this part · ${clock(Date.now() - started)} since the start`);
        });
        forward(child.stdout, process.stdout);
        forward(child.stderr, process.stderr);
        child.once('error', reject);
        child.once('exit', (code) => (acceptExit.includes(code) ? resolve(code) : reject(new Error(`${title} failed (exit ${code}).`))));
    });
}

function preflightOrRefuse(part) {
    const reasons = preflight();
    if (!reasons.length) {
        console.log('On mains power; Docker, compilers, Electron applications and tests are not running.');
        return true;
    }
    const list = reasons.map((reason) => `  ✕ ${reason}`).join('\n');
    if (dryRun) {
        console.log(`(dry run: going on regardless of)\n${list}`);
        return true;
    }
    console.error(`Not starting ${part}: the timings would not be worth publishing while\n${list}\nPut these right (plug in the power, quit Docker Desktop and every other application, wait for builds and tests to finish), then run this again${parts.length > 1 ? ` (--only ${parts.slice(parts.indexOf(part)).join(',')} to go on from here)` : ''}.`);
    return false;
}

function baseline() {
    const result = spawnSync(process.execPath, [join(repositoryRoot, 'benchmarks', 'lib', 'quiet.mjs'), '--baseline', String(baselineSeconds)], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`The baseline could not be measured: ${result.stderr}`);
    const measured = JSON.parse(result.stdout.trim());
    const limits = { load: (measured.loadMedian + 1).toFixed(2), cores: (measured.otherCoresMedian + 1).toFixed(2) };
    console.log(`Idle: one-minute load ${measured.loadMedian} (largest ${measured.loadMaximum}), other processes ${measured.otherCoresMedian} cores. Every timed run waits for load below ${limits.load} and other processes below ${limits.cores} cores.`);
    return {
        ...process.env, KONJUGATE_BENCHMARK_CAFFEINATED: '1', KONJUGATE_QUIET_STRICT: '1', KONJUGATE_QUIET_BASELINE: JSON.stringify(measured),
        KONJUGATE_QUIET_LOAD_LIMIT: limits.load, KONJUGATE_QUIET_CORE_LIMIT: limits.cores
    };
}

async function main() {
    say(`Konjugate performance benchmarks${dryRun ? ': DRY RUN, untimed, a check that everything works' : ''}`);
    const total = parts.reduce((sum, part) => sum + expectedMinutes[part] + baselineSeconds / 60, 0);
    console.log(`Parts: ${parts.map((part) => `${part} (about ${clock(expectedMinutes[part] * 60000)})`).join(', ')}; about ${clock(total * 60000)} in all, longer when it waits for a quiet computer.`);
    if (!dryRun) console.log('Leave the computer alone, on mains power, with every other application closed, until it says Done.');

    say('Bringing the shipped engine (out/engine, RelWithDebInfo) and the tools up to date (benchmarks/setup.mjs)');
    const setup = spawnSync(process.execPath, [join(repositoryRoot, 'benchmarks', 'setup.mjs'), '--skip-openmodelica'], { stdio: 'inherit' });
    if (setup.status !== 0) throw new Error('Setup did not complete; see above.');

    const machineDirectory = dryRun ? join(repositoryRoot, 'out', 'benchmarks', 'performance-dry-run') : resultsDirectory();
    if (dryRun) rmSync(machineDirectory, { recursive: true, force: true });
    const session = new Date().toISOString().replace(/\.\d+Z$/, '').replaceAll(':', '-');
    const sessionDirectory = join(machineDirectory, 'sessions', session);
    mkdirSync(sessionDirectory, { recursive: true });
    console.log(`Session ${session}: ${sessionDirectory}`);
    const quiet = dryRun ? [] : ['--wait-for-quiet'];

    for (const [index, part] of parts.entries()) {
        say(`Part ${index + 1} of ${parts.length}: ${part} (about ${clock(expectedMinutes[part] * 60000)})`);
        if (!preflightOrRefuse(part)) return 2;
        // A dry run's numbers are discarded, so it neither measures a baseline nor waits for quiet.
        let env = { ...process.env, KONJUGATE_BENCHMARK_CAFFEINATED: '1' };
        if (!dryRun) {
            console.log(`Measuring the idle computer for ${baselineSeconds} s; do not touch it.`);
            env = baseline();
        }
        const output = join(sessionDirectory, part);
        console.log(`Conditions at the start of ${part}: ${JSON.stringify(conditions())}`);
        if (part === 'problems' || part === 'scaling') {
            await step({
                title: part, env, unit: /^ {2}timed /, total: expectedCases(part), estimateMinutes: expectedMinutes[part], acceptExit: [0, 1],
                args: [join(repositoryRoot, 'benchmarks', 'run.mjs'), '--full', '--engine', engine, '--no-caffeinate', '--output', output, ...quiet,
                    ...(part === 'problems' ? ['--no-scaling'] : ['--only', 'scaling/graphScalability']),
                    ...(dryRun ? ['--repeats', '1', '--warmup', '0', ...(part === 'scaling' ? ['--scaling-up-to', String(scalingUpTo)] : [])] : ['--repeats', '7', '--warmup', '1'])]
            });
        } else {
            const compared = comparisonProblems().filter(({ id }) => !dryRun || dryRunProblems.includes(id));
            await step({
                title: part, env, unit: /: round \d+ of \d+$/, total: compared.length * rounds, estimateMinutes: expectedMinutes[part],
                args: [join(repositoryRoot, 'benchmarks', 'comparisons', 'compare.mjs'), '--engine', engine, '--tools', 'konjugate,export,scipy,julia', '--rounds', String(rounds),
                    '--output', output, ...quiet, ...(dryRun ? ['--only', dryRunProblems.join(',')] : [])]
            });
            await writeComparisonReport(output);
        }
        console.log(`Conditions at the end of ${part}: ${JSON.stringify(conditions())}`);
    }

    say('Combining the sessions (benchmarks/combine.mjs)');
    const report = await combineSessions(machineDirectory);
    say(`Done in ${clock(Date.now() - started)}. Report: ${report}`);
    if (!dryRun) console.log('Optionally, afterwards: OpenModelica in Docker, not timing-comparable: start Docker Desktop, run npm run benchmark:openmodelica, then quit Docker Desktop.');
    return 0;
}
