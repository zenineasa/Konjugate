/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs the Konjugate benchmark suite headless with the native engine and writes its results (benchmarks/README.md).
//
//   node benchmarks/run.mjs --accuracy        deterministic accuracy checks only, no timing; exits 1 if any check fails
//   node benchmarks/run.mjs --full            the accuracy checks, then timing and memory on this machine
//
// Options:
//   --engine <path>      the konjugateEngine executable (default: $KONJUGATE_ENGINE, else out/engine/konjugateEngine)
//   --output <dir>       where to write results (default: out/benchmarks/accuracy for --accuracy,
//                        benchmarks/results/<machine>/ for --full)
//   --only <text>        run only the problems whose ID contains the text
//   --repeats <n>        timed runs per timing case in --full (default 7)
//   --warmup <n>         untimed runs before them (default 1)
//   --no-caffeinate      do not run --full under caffeinate on macOS
//   --no-scaling         under --full, time every problem's own timing cases but not graph scalability's (npm run benchmark:performance's parts)
//   --scaling-up-to <n>  under --full, time the generated graphs up to n nodes only (a quick check of the harness, not for publishing)
//   --wait-for-quiet     before timing, wait for a quiet computer, and check again before every timed run (lib/quiet.mjs)

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { createEngine, loadModel, repositoryRoot, resolveEngineExecutable } from './lib/engine.mjs';
import { busyProcesses, conditions, engineBuild, machineDetails } from './lib/machine.mjs';
import { resultsDirectory, sourceIdentity } from './lib/results.mjs';
import { createQuietGate } from './lib/quiet.mjs';
import { timingStatistics } from './lib/metrics.mjs';
import { formatNumber, plotCsv, renderSvg } from './lib/plots.mjs';
import { renderReport } from './lib/report.mjs';
import { referenceData } from './lib/study.mjs';
import { modelDocuments } from './generateModels.mjs';
import { problems } from './problems.mjs';

const { values: options } = parseArgs({
    options: {
        accuracy: { type: 'boolean', default: false },
        full: { type: 'boolean', default: false },
        engine: { type: 'string' },
        output: { type: 'string' },
        only: { type: 'string' },
        repeats: { type: 'string', default: '7' },
        warmup: { type: 'string', default: '1' },
        'no-caffeinate': { type: 'boolean', default: false },
        'wait-for-quiet': { type: 'boolean', default: false },
        'scaling-up-to': { type: 'string' },
        'no-scaling': { type: 'boolean', default: false }
    }
});
if (options.accuracy && options.full) throw new Error('Choose --accuracy or --full, not both.');
const mode = options.full ? 'full' : 'accuracy';
const repeats = Number(options.repeats);
const warmupRuns = Number(options.warmup);
if (!Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(warmupRuns) || warmupRuns < 0) throw new Error('--repeats must be at least 1 and --warmup at least 0.');

// A timing run keeps the computer awake and off idle throttling: on macOS the runner restarts itself under caffeinate.
if (mode === 'full' && process.platform === 'darwin' && !options['no-caffeinate'] && !process.env.KONJUGATE_BENCHMARK_CAFFEINATED && existsSync('/usr/bin/caffeinate')) {
    const child = spawn('/usr/bin/caffeinate', ['-ims', process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, KONJUGATE_BENCHMARK_CAFFEINATED: '1' } });
    child.once('exit', (code) => process.exit(code ?? 1));
} else {
    process.exitCode = await main();
}

function csv(rows, columns) {
    const quote = (value) => {
        if (value === null || value === undefined) return '';
        const text = String(value);
        return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    return `${[columns.join(','), ...rows.map((row) => columns.map((column) => quote(row[column])).join(','))].join('\n')}\n`;
}

async function main() {
    const startedAt = new Date();
    const source = sourceIdentity();
    const packageVersion = source.konjugateVersion;
    const executable = resolveEngineExecutable(options.engine);
    const workDirectory = await mkdtemp(join(tmpdir(), 'konjugateBenchmarks-'));
    const quiet = options['wait-for-quiet'] ? createQuietGate() : null;
    const baseEngine = createEngine(executable, workDirectory, { beforeTimedRun: quiet?.beforeTimedRun ?? null });
    const totals = { engineRuns: 0, substeps: 0, evaluations: 0 };
    let engineVersion = '';
    const engine = {
        ...baseEngine,
        async run(...args) {
            const result = await baseEngine.run(...args);
            totals.engineRuns += 1;
            totals.substeps += result.work.substeps;
            totals.evaluations += result.work.evaluations;
            engineVersion = result.engineVersion;
            return result;
        }
    };
    const selected = problems.filter(({ id }) => !options.only || id.includes(options.only));
    console.log(`Konjugate ${packageVersion} benchmarks, --${mode}, ${selected.length} problem${selected.length === 1 ? '' : 's'}, engine ${relative(repositoryRoot, executable) || executable}.`);

    try {
        // The committed models must be exactly what their problem.mjs builds, or a reference could describe a different model.
        for (const { path, document } of modelDocuments()) {
            if (!existsSync(path)) throw new Error(`${relative(repositoryRoot, path)} is missing. Run node benchmarks/generateModels.mjs.`);
            if (!isDeepStrictEqual(await loadModel(path), JSON.parse(JSON.stringify(document)))) {
                throw new Error(`${relative(repositoryRoot, path)} differs from what its problem.mjs builds. Run node benchmarks/generateModels.mjs.`);
            }
            await baseEngine.validate(path);
        }

        const results = [];
        for (const { id, directory, models, evaluate } of selected) {
            const config = JSON.parse(readFileSync(join(directory, 'benchmark.json'), 'utf8'));
            const startedProblem = Date.now();
            const entry = { id, title: config.title, summary: config.summary, models: Object.keys(models).map((name) => `${name}.kjt`), rows: [], checks: [], plots: [], notes: [], referenceProvenance: referenceData(directory)?.provenance ?? null };
            try {
                const outcome = await evaluate({ engine, config });
                Object.assign(entry, { rows: outcome.rows.map((row) => ({ problem: id, ...row })), checks: outcome.checks, plots: outcome.plots, notes: outcome.notes ?? [] });
            } catch (error) {
                entry.error = error.message;
                entry.checks.push({ name: 'evaluation', description: 'The problem ran to completion', value: NaN, limit: { max: 0 }, pass: false });
            }
            results.push(entry);
            const failing = entry.checks.filter((check) => !check.pass);
            console.log(`${failing.length ? '✕' : '✓'} ${id}: ${entry.checks.length - failing.length}/${entry.checks.length} checks${mode === 'accuracy' ? '' : ` (${((Date.now() - startedProblem) / 1000).toFixed(1)} s)`}`);
            for (const check of failing) console.log(`    ✕ ${check.name} = ${formatNumber(check.value)} (threshold ${JSON.stringify(check.limit)})${entry.error ? `: ${entry.error}` : ''}`);
        }

        let timings = null;
        let machine = null;
        let timingSummary = null;
        if (mode === 'full') {
            if (quiet) await quiet.full('timing');
            machine = { ...machineDetails(), engineBuild: engineBuild(executable) };
            const startConditions = conditions();
            console.log(`Timing starts: load ${startConditions.loadAverage.join(' ')}; ${startConditions.power}; ${startConditions.thermal}`);
            const busy = busyProcesses();
            if (busy.length) {
                console.warn('\n⚠ Other heavy processes are running; timings may be disturbed. Stop them and run again for numbers worth recording:');
                for (const entry of busy) console.warn(`    ${entry.kind}: pid ${entry.pid} ${entry.command}`);
            }
            if (machine.power?.source === 'Battery Power') console.warn('⚠ Running on battery power; macOS may throttle the processor.');
            if (machine.power?.lowPowerMode) console.warn('⚠ Low Power Mode is on.');
            timings = [];
            for (const { id, directory, measure } of selected) {
                const config = JSON.parse(readFileSync(join(directory, 'benchmark.json'), 'utf8'));
                for (const timing of config.timing ?? []) {
                    const modelPath = join(directory, `${timing.model}.kjt`);
                    for (let index = 0; index < warmupRuns; ++index) await baseEngine.run(modelPath, timing.variant, timing.run);
                    const measured = [];
                    for (let index = 0; index < repeats; ++index) measured.push(await baseEngine.run(modelPath, timing.variant, timing.run, { measure: true }));
                    const engineCompute = timingStatistics(measured.map((run) => run.timing.engineComputeMilliseconds));
                    const memory = measured.map((run) => run.timing.peakResidentBytes).filter((value) => value !== null);
                    timings.push({
                        problem: id, label: timing.label, model: `${timing.model}.kjt`, variant: timing.variant ?? {}, run: timing.run, work: measured[0].work,
                        wall: timingStatistics(measured.map((run) => run.timing.wallMilliseconds)), engineCompute,
                        substepsPerSecond: measured[0].work.substeps / (engineCompute.minimum / 1000),
                        peakResidentBytes: memory.length ? Math.max(...memory) : null
                    });
                    console.log(`  timed ${id}: ${timing.label}: minimum ${timings.at(-1).wall.minimum.toFixed(1)} ms, median ${timings.at(-1).wall.median.toFixed(1)} ms over ${repeats} runs`);
                }
                // A problem that times its own cases (generated models, several backends) exports measure(); its rows, plots and notes join
                // its own section of the report.
                if (measure && !options['no-scaling']) {
                    if (options['scaling-up-to'] && config.full?.sizes) {
                        for (const family of Object.keys(config.full.sizes)) config.full.sizes[family] = config.full.sizes[family].filter((size) => size <= Number(options['scaling-up-to']));
                    }
                    const measured = await measure({ engine: baseEngine, config, repeats, warmupRuns });
                    timings.push(...measured.timings);
                    const entry = results.find((candidate) => candidate.id === id);
                    entry.rows.push(...measured.rows.map((row) => ({ problem: id, ...row })));
                    entry.plots.push(...measured.plots);
                    entry.notes.push(...measured.notes);
                }
            }
            const endConditions = conditions();
            console.log(`Timing ends: load ${endConditions.loadAverage.join(' ')}; ${endConditions.power}; ${endConditions.thermal}`);
            timingSummary = { conditions: { start: startConditions, end: endConditions }, repeats, warmupRuns, caffeinated: Boolean(process.env.KONJUGATE_BENCHMARK_CAFFEINATED), busyProcesses: [...new Set(busy.map((entry) => entry.kind))], ...(quiet ? { quietGate: quiet.summary() } : {}) };
        }

        const outputDirectory = options.output
            ?? (mode === 'full' ? resultsDirectory(machine) : join(repositoryRoot, 'out', 'benchmarks', 'accuracy'));
        await rm(join(outputDirectory, 'plots'), { recursive: true, force: true });
        await mkdir(join(outputDirectory, 'plots'), { recursive: true });
        const allChecks = results.flatMap((entry) => entry.checks.map((check) => ({ problem: entry.id, ...check })));
        const summary = {
            run: {
                mode, startedAt: startedAt.toISOString(), konjugateVersion: packageVersion, engineVersion, engine: basename(executable),
                gitCommit: source.gitCommit, workingTreeChanges: source.workingTreeChanges
            },
            totals: { ...totals, checks: allChecks.length, passed: allChecks.filter((check) => check.pass).length },
            problems: results.map(({ plots, ...entry }) => ({ ...entry, plots: plots.map((plot) => `plots/${plot.id}.svg`) })),
            ...(mode === 'full' ? { machine, timing: timingSummary, timings } : {})
        };
        const resultColumns = ['problem', 'case', 'model', 'method', 'globalTimeStep', 'substeps', 'targetTime', 'maxAbsError', 'rmse', 'relativeError', 'conservationError', 'steadyStateError', 'observedOrder', 'globalSteps', 'substepsExecuted', 'evaluations', 'unit', 'note'];
        await writeFile(join(outputDirectory, 'results.csv'), csv(results.flatMap((entry) => entry.rows), resultColumns));
        await writeFile(join(outputDirectory, 'checks.csv'), csv(allChecks.map((check) => ({ ...check, min: check.limit.min, max: check.limit.max })), ['problem', 'name', 'value', 'min', 'max', 'pass', 'description']));
        if (timings) {
            await writeFile(join(outputDirectory, 'timing.csv'), csv(timings.map((timing) => ({
                problem: timing.problem, label: timing.label, model: timing.model, globalSteps: timing.work.globalSteps, substeps: timing.work.substeps, runs: timing.wall.count,
                wallMinMs: timing.wall.minimum, wallMedianMs: timing.wall.median, wallMaxMs: timing.wall.maximum, wallMadMs: timing.wall.medianAbsoluteDeviation,
                wallIqrMs: timing.wall.interquartileRange ?? null, wallMinOverMedian: timing.wall.minimumOverMedian ?? null,
                engineComputeMinMs: timing.engineCompute.minimum, engineComputeMedianMs: timing.engineCompute.median, engineComputeIqrMs: timing.engineCompute.interquartileRange ?? null,
                substepsPerSecond: timing.substepsPerSecond, peakResidentBytes: timing.peakResidentBytes
            })), ['problem', 'label', 'model', 'globalSteps', 'substeps', 'runs', 'wallMinMs', 'wallMedianMs', 'wallMaxMs', 'wallMadMs', 'wallIqrMs', 'wallMinOverMedian', 'engineComputeMinMs', 'engineComputeMedianMs', 'engineComputeIqrMs', 'substepsPerSecond', 'peakResidentBytes']));
        }
        if (quiet && mode === 'full') await writeFile(join(outputDirectory, 'timing-conditions.csv'), quiet.csv());
        await writeFile(join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? String(value) : value), 2)}\n`);
        for (const plot of results.flatMap((entry) => entry.plots)) {
            await writeFile(join(outputDirectory, 'plots', `${plot.id}.svg`), renderSvg(plot, { standalone: true }));
            await writeFile(join(outputDirectory, 'plots', `${plot.id}.csv`), plotCsv(plot));
        }
        await writeFile(join(outputDirectory, 'report.html'), renderReport({ summary, problems: results, timings }));

        const failing = allChecks.filter((check) => !check.pass);
        console.log(`\n${failing.length ? '✕' : '✓'} ${allChecks.length - failing.length}/${allChecks.length} checks within their thresholds, ${totals.engineRuns} engine runs.`);
        console.log(`Results: ${relative(process.cwd(), outputDirectory) || '.'}/report.html`);
        return failing.length ? 1 : 0;
    } finally {
        await rm(workDirectory, { recursive: true, force: true });
    }
}
