/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Graph scalability: the same thermal physics generated at any number of nodes (graphs.mjs states the three families' equations and
// their references), run on each execution backend (docs/parallelExecution.md) under each method.
//
// What is checked, in every mode and at the sizes in benchmark.json's `sizes` (small, so the accuracy run stays fast):
//   - the serial, thread-pool and partitioned backends give the same numbers, bit for bit, and report the same work;
//   - the work is what the model implies: N node substeps per global step, and every contribution evaluated once per substep under Euler
//     and once per stage (four a step) under Runge–Kutta 4;
//   - the backend that ran is the one requested, with the workers and partitions asked for;
//   - Konjugate's numbers are the method's exact steps to rounding (the chain and grid in closed form, the random network stepped here);
//   - the error against the exact solution of the equations (chain and grid at every size, the random network by the matrix exponential
//     where it is small), a regression guard on each method's accuracy;
//   - the random network's total heat Σ C_i T_i, conserved to rounding.
//
// What is measured under --full only (measure(), below): the same families up to 100,000 nodes, each run timed several times: the wall
// time of the engine process, split into compiling and planning (the engine's planningNanoseconds), solving (its synchronization compute
// time) and the rest (starting, reading and validating the project, and writing the result); throughput in node steps per second of
// solving; peak resident memory; and each parallel backend's speed-up over serial and its efficiency (speed-up per worker), plus a sweep
// of the worker count on one graph. The correctness checks above are repeated at every size measured and reported as rows.
//
// A method is an entry in benchmark.json's `methods`: the run's variant, the method whose exact steps the numbers are compared with (or
// null for a method that has none, such as an adaptive one, which is then judged against the exact solution only) and its evaluations per
// step. Dormand–Prince and Rodas4 (docs/proposals/integrators.md) will be added there.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { affineSolution } from '../../lib/linearAlgebra.mjs';
import { errorMetrics, timingStatistics } from '../../lib/metrics.mjs';
import { trajectory } from '../../lib/engine.mjs';
import { createChecks, engineRun, linePlot, methodName, resultRow, series } from '../../lib/study.mjs';
import { contributionCount, denseMatrix, generateGraph, stepIndependently, writeGraphModel } from './graphs.mjs';

export const directory = import.meta.dirname;
export const models = {};

const familyNames = { chain: 'chain', grid: 'grid', random: 'random network' };

// The number of global steps to each sample time.
const stepsTo = (time, step) => Math.round(time / step);

// The largest difference between Konjugate's samples and a reference's, relative to the largest starting temperature.
function largestDifference(numeric, reference, scale) {
    let largest = 0;
    numeric.forEach((sample, row) => sample.forEach((value, column) => { largest = Math.max(largest, Math.abs(value - reference[row][column])); }));
    return largest / scale;
}

// Runs one graph under one method on every backend, and judges it. Returns what the checks, rows and plots need.
async function studyGraph({ engine, graph, path, stateIds, method, backends, run, matrixExponentialMaxNodes, measure = false, repeats = 1, warmup = 0 }) {
    const runs = [];
    for (const backend of backends) {
        for (let index = 0; index < warmup; ++index) await engine.run(path, method.variant, run, { execution: backend.execution, modelAsIs: true });
        const measured = [];
        for (let index = 0; index < repeats; ++index) measured.push(await engine.run(path, method.variant, run, { execution: backend.execution, modelAsIs: true, measure }));
        runs.push({ backend, result: measured[0], measured });
    }
    const [serial] = runs;
    const numeric = trajectory(serial.result, stateIds);
    const scale = Math.max(...graph.initial.map(Math.abs));
    let bitDifferences = 0;
    let workDifferences = 0;
    let notAsRequested = 0;
    for (const { backend, result } of runs) {
        const values = trajectory(result, stateIds);
        values.forEach((sample, row) => sample.forEach((value, column) => { if (!Object.is(value, numeric[row][column])) bitDifferences += 1; }));
        if (JSON.stringify(result.work) !== JSON.stringify(serial.result.work)) workDifferences += 1;
        const requested = backend.execution;
        if (result.execution.backend !== requested.backend || (requested.workerThreads && result.execution.workerThreads !== Math.min(requested.workerThreads, graph.nodeCount))) notAsRequested += 1;
    }
    const steps = stepsTo(run.targetTime, run.globalTimeStep);
    const expectedWork = { globalSteps: steps, substeps: graph.nodeCount * steps, evaluations: contributionCount(graph) * steps * method.evaluationsPerStep };
    const workCountDifferences = Object.keys(expectedWork).filter((key) => serial.result.work[key] !== expectedWork[key]).length;

    const times = serial.result.times;
    let exactSteps = null;
    if (method.exactSteps) {
        const reference = graph.discrete
            ? times.map((time) => Array.from(graph.discrete(method.exactSteps, run.globalTimeStep, stepsTo(time, run.globalTimeStep))))
            : times.map((time) => Array.from(stepIndependently(graph, method.exactSteps, run.globalTimeStep, stepsTo(time, run.globalTimeStep))));
        exactSteps = largestDifference(numeric, reference, scale);
    }
    let exact = null;
    if (graph.exact) exact = times.map((time) => Array.from(graph.exact(time)));
    else if (graph.nodeCount <= matrixExponentialMaxNodes) exact = affineSolution(denseMatrix(graph), new Array(graph.nodeCount).fill(0), Array.from(graph.initial), times);
    const errors = exact ? errorMetrics(numeric, exact) : null;
    let conservation = null;
    if (graph.capacities) {
        const heat = (sample) => sample.reduce((total, value, index) => total + graph.capacities[index] * value, 0);
        const magnitude = graph.capacities.reduce((total, capacity, index) => total + capacity * Math.abs(graph.initial[index]), 0);
        conservation = Math.max(...numeric.map((sample) => Math.abs(heat(sample) - heat(numeric[0])))) / magnitude;
    }
    return { runs, bitDifferences, workDifferences, notAsRequested, workCountDifferences, exactSteps, errors, conservation, work: serial.result.work, steps };
}

function graphNote(graph, study) {
    const partitioned = study.runs.find(({ backend }) => backend.execution.backend === 'partitioned');
    return [
        `${graph.system.offsets[graph.nodeCount]} relationships`,
        study.bitDifferences === 0 ? `${study.runs.map(({ backend }) => backend.label).join(', ').replace(/, ([^,]*)$/, ' and $1')}: identical bit for bit` : `${study.bitDifferences} values differ between backends`,
        partitioned ? `partition cut ${(100 * partitioned.result.execution.communicationCutFraction).toFixed(2)} % of communication` : null,
        study.exactSteps === null ? null : `against the method's exact steps ${study.exactSteps.toExponential(1)}`,
        study.errors ? null : 'no exact solution at this size'
    ].filter(Boolean).join('; ');
}

async function buildGraph(workDirectory, family, size, config, run) {
    const graph = generateGraph(family, size, { seed: config.seed });
    const path = join(workDirectory, `${family}${graph.nodeCount}.kjt`);
    const stateIds = await writeGraphModel(graph, path, run);
    return { graph, path, stateIds };
}

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const run = engineRun(config.run);
    const workDirectory = await mkdtemp(join(tmpdir(), 'konjugateScaling-'));
    const totals = { bitDifferences: 0, workDifferences: 0, workCountDifferences: 0, notAsRequested: 0, conservation: 0 };
    const exactSteps = Object.fromEntries(config.methods.map((method) => [method.key, 0]));
    const exactError = Object.fromEntries(config.methods.map((method) => [method.key, 0]));
    const errorBySize = {};
    try {
        for (const [family, sizes] of Object.entries(config.sizes)) {
            for (const size of sizes) {
                const { graph, path, stateIds } = await buildGraph(workDirectory, family, size, config, run);
                for (const method of config.methods) {
                    const study = await studyGraph({ engine, graph, path, stateIds, method, backends: config.backends, run, matrixExponentialMaxNodes: config.matrixExponentialMaxNodes });
                    for (const key of ['bitDifferences', 'workDifferences', 'workCountDifferences', 'notAsRequested']) totals[key] += study[key];
                    if (study.conservation !== null) totals.conservation = Math.max(totals.conservation, study.conservation);
                    if (study.exactSteps !== null) exactSteps[method.key] = Math.max(exactSteps[method.key], study.exactSteps);
                    if (study.errors) {
                        exactError[method.key] = Math.max(exactError[method.key], study.errors.maxAbsError);
                        (errorBySize[`${family}:${method.key}`] ??= []).push([graph.nodeCount, study.errors.maxAbsError]);
                    }
                    rows.push(resultRow({
                        caseName: `${familyNames[family]}, ${graph.nodeCount} nodes`, model: family, variant: method.variant, run, errors: study.errors ?? {},
                        conservationError: study.conservation, work: study.work, unit: 'K', note: graphNote(graph, study)
                    }));
                }
            }
        }
    } finally {
        await rm(workDirectory, { recursive: true, force: true });
    }
    add('backendBitDifferences', totals.bitDifferences, 'Sampled values that differ, bit for bit, between the serial backend and the thread-pool or partitioned backend, over every graph, size and method');
    add('backendWorkDifferences', totals.workDifferences, 'Runs whose reported work (global steps, node substeps, contributions evaluated) differs from the serial run of the same graph and method');
    add('workCountDifferences', totals.workCountDifferences, 'Work counts that differ from what the model implies: N substeps a global step; each contribution once a substep under Euler, once a stage under Runge–Kutta 4');
    add('backendNotAsRequested', totals.notAsRequested, 'Runs whose effective backend or worker count is not the one requested (so a parallel backend really ran in parallel)');
    for (const method of config.methods) {
        const name = method.key === 'explicitEuler' ? 'euler' : method.key;
        if (method.exactSteps) add(`${name}ExactStepsDifference`, exactSteps[method.key], `${methodName(method.variant)}: largest difference from the method's exact steps (closed form for the chain and grid, stepped independently for the random network), relative to the largest starting temperature`);
        add(`${name}ExactSolutionError`, exactError[method.key], `${methodName(method.variant)}: largest error against the exact solution, K (chain and grid at every size, the random network by the matrix exponential at ${config.matrixExponentialMaxNodes} nodes), h = ${run.globalTimeStep} s to t = ${run.targetTime} s`);
    }
    add('randomHeatConservation', totals.conservation, 'Random network: largest drift of the total heat Σ C_i T_i from Konjugate\'s own states, relative to Σ C_i |T_i(0)|, over every size and method');

    const plots = [linePlot({
        id: 'scalingExactError', title: 'Error against the exact solution, by graph size', subtitle: `Largest error over every node and sample, h = ${run.globalTimeStep} s; identical on every backend`,
        xLabel: 'Nodes', yLabel: 'Max abs error (K)', logX: true, logY: true, xTicks: [...new Set(Object.values(errorBySize).flatMap((points) => points.map(([x]) => x)))].toSorted((a, b) => a - b),
        series: Object.entries(errorBySize).map(([key, points], index) => {
            const [family, methodKey] = key.split(':');
            return series(`${familyNames[family]}, ${methodName(config.methods.find((method) => method.key === methodKey).variant)}`, `slot${(index % 4) + 1}`, points.map(([x]) => x), points.map(([, y]) => y));
        })
    })];
    return {
        rows, checks, plots,
        notes: [
            'Every backend gives the same bits because every backend reads the same snapshot (Euler) or the same immutable stage vector (Runge–Kutta 4) and commits its results in a fixed order (docs/parallelExecution.md). The accuracy run uses small graphs; --full measures the same families up to 100,000 nodes, with the time it takes.',
            ...config.full.infeasible.map(({ nodes, reason }) => `Not measured at ${nodes.toLocaleString('en-US')} nodes: ${reason}`)
        ]
    };
}

// --full only: times every family at every size on every backend under every method, then sweeps the worker count on one graph. Returns
// timing entries for the report's timing table, and rows, plots and notes for this problem's own section.
export async function measure({ engine, config, repeats: maximumRepeats, warmupRuns, log = console.log }) {
    const { full } = config;
    const workDirectory = await mkdtemp(join(tmpdir(), 'konjugateScaling-'));
    const timings = [];
    const rows = [];
    const cases = [];
    const sweep = [];
    try {
        for (const [family, sizes] of Object.entries(full.sizes)) {
            for (const size of sizes) {
                const nodes = family === 'grid' ? Math.round(Math.sqrt(size)) ** 2 : size;
                const steps = Math.max(1, Math.min(full.maximumSteps, Math.round(full.nodeStepsPerCase / nodes)));
                const run = { globalTimeStep: config.run.globalTimeStep, targetTime: steps * config.run.globalTimeStep, outputInterval: steps * config.run.globalTimeStep };
                const large = nodes > full.repeatsAbove.nodes;
                const repeats = Math.min(maximumRepeats, large ? full.repeatsAbove.repeats : full.repeats);
                const warmup = large ? full.repeatsAbove.warmup : warmupRuns;
                const builtAt = performance.now();
                const { graph, path, stateIds } = await buildGraph(workDirectory, family, size, config, run);
                const generationMilliseconds = performance.now() - builtAt;
                const sweepHere = full.workerSweep.family === family && full.workerSweep.size === size;
                for (const method of config.methods) {
                    const study = await studyGraph({ engine, graph, path, stateIds, method, backends: config.backends, run, matrixExponentialMaxNodes: config.matrixExponentialMaxNodes, measure: true, repeats, warmup });
                    rows.push(resultRow({ caseName: `${familyNames[family]}, ${graph.nodeCount} nodes`, model: family, variant: method.variant, run, errors: study.errors ?? {}, conservationError: study.conservation, work: study.work, unit: 'K', note: graphNote(graph, study) }));
                    const serialSolve = timingStatistics(study.runs[0].measured.map((entry) => entry.timing.engineComputeMilliseconds)).minimum;
                    for (const { backend, measured } of study.runs) {
                        const entry = timingEntry({ family, graph, method, backend, measured, run, generationMilliseconds });
                        entry.speedUp = serialSolve / entry.solve.minimum;
                        entry.efficiency = entry.speedUp / measured[0].execution.workerThreads;
                        timings.push(entry);
                        cases.push(entry);
                        log(`  timed graphScalability: ${entry.label}: minimum wall ${entry.wall.minimum.toFixed(0)} ms, solve ${entry.solve.minimum.toFixed(0)} ms (medians ${entry.wall.median.toFixed(0)}, ${entry.solve.median.toFixed(0)}) over ${measured.length} runs`);
                    }
                    if (sweepHere && method.key === full.workerSweep.method) {
                        for (const workers of full.workerSweep.workers) {
                            for (const backend of ['threadPool', 'partitioned']) {
                                const execution = { backend, workerThreads: workers, ...(backend === 'partitioned' ? { partitionCount: workers } : {}) };
                                for (let index = 0; index < warmup; ++index) await engine.run(path, method.variant, run, { execution, modelAsIs: true });
                                const measured = [];
                                for (let index = 0; index < repeats; ++index) measured.push(await engine.run(path, method.variant, run, { execution, modelAsIs: true, measure: true }));
                                const solve = timingStatistics(measured.map((entry) => entry.timing.engineComputeMilliseconds)).minimum;
                                sweep.push({ backend, workers, effectiveWorkers: measured[0].execution.workerThreads, solve, speedUp: serialSolve / solve });
                            }
                        }
                    }
                }
            }
        }
    } finally {
        await rm(workDirectory, { recursive: true, force: true });
    }
    return { timings, rows, plots: timingPlots(cases, sweep, config), notes: timingNotes(cases, sweep, config) };
}

function timingEntry({ family, graph, method, backend, measured, run, generationMilliseconds }) {
    const wall = timingStatistics(measured.map((entry) => entry.timing.wallMilliseconds));
    const solve = timingStatistics(measured.map((entry) => entry.timing.engineComputeMilliseconds));
    const compile = timingStatistics(measured.map((entry) => entry.timing.planningMilliseconds));
    const memory = measured.map((entry) => entry.timing.peakResidentBytes).filter((value) => value !== null);
    const nodeSteps = graph.nodeCount * measured[0].work.globalSteps;
    return {
        problem: 'scaling/graphScalability', label: `${familyNames[family]}, ${graph.nodeCount} nodes, ${methodName(method.variant)}, ${backend.label}`, model: `generated ${family}`,
        family, nodes: graph.nodeCount, method: method.key, backend: backend.execution.backend, workers: measured[0].execution.workerThreads,
        variant: method.variant, run, work: measured[0].work, wall, engineCompute: solve, solve, compile,
        otherMilliseconds: wall.minimum - solve.minimum - compile.minimum, generationMilliseconds,
        substepsPerSecond: measured[0].work.substeps / (solve.minimum / 1000), nodeStepsPerSecond: nodeSteps / (solve.minimum / 1000),
        peakResidentBytes: memory.length ? Math.max(...memory) : null
    };
}

const backendRoles = { serial: 'slot1', threadPool: 'slot2', partitioned: 'slot3' };
const backendNames = { serial: 'serial', threadPool: 'thread pool', partitioned: 'partitioned' };

function timingPlots(cases, sweep, config) {
    const plots = [];
    for (const method of config.methods) {
        const name = methodName(method.variant);
        const byBackend = (family, metric) => Object.keys(backendRoles).map((backend) => {
            const points = cases.filter((entry) => entry.family === family && entry.method === method.key && entry.backend === backend);
            return series(`${backendNames[backend]}`, backendRoles[backend], points.map((entry) => entry.nodes), points.map(metric));
        });
        for (const family of Object.keys(config.full.sizes)) {
            plots.push(linePlot({
                id: `scalingThroughput-${family}-${method.key}`, title: `Throughput, ${familyNames[family]}, ${name}`, subtitle: 'Node steps per second of solving (minimum), on this machine',
                xLabel: 'Nodes', yLabel: 'Node steps per second', logX: true, logY: true, series: byBackend(family, (entry) => entry.nodeStepsPerSecond)
            }));
        }
        const serial = cases.filter((entry) => entry.method === method.key && entry.backend === 'serial' && entry.family === 'grid');
        plots.push(linePlot({
            id: `scalingTimeSplit-${method.key}`, title: `Where the time goes, grid, ${name}, serial`, subtitle: 'Median wall time of the engine process, split into its parts',
            xLabel: 'Nodes', yLabel: 'Milliseconds', logX: true, logY: true,
            series: [
                series('wall time', 'reference', serial.map((entry) => entry.nodes), serial.map((entry) => entry.wall.minimum)),
                series('solving', 'slot2', serial.map((entry) => entry.nodes), serial.map((entry) => entry.solve.minimum)),
                series('compiling and planning', 'slot3', serial.map((entry) => entry.nodes), serial.map((entry) => entry.compile.minimum)),
                series('starting, reading, validating, writing', 'slot4', serial.map((entry) => entry.nodes), serial.map((entry) => entry.otherMilliseconds))
            ]
        }));
    }
    const euler = config.methods[0];
    plots.push(linePlot({
        id: 'scalingSpeedUp', title: `Parallel speed-up over serial, ${methodName(euler.variant)}`, subtitle: `Solving time, serial over parallel, ${config.backends[1].execution.workerThreads} workers; 1 is no gain`,
        xLabel: 'Nodes', yLabel: 'Speed-up', logX: true,
        series: Object.keys(config.full.sizes).flatMap((family, familyIndex) => ['threadPool', 'partitioned'].map((backend, index) => {
            const points = cases.filter((entry) => entry.family === family && entry.method === euler.key && entry.backend === backend);
            return series(`${familyNames[family]}, ${backendNames[backend]}`, `slot${((familyIndex * 2 + index) % 4) + 1}`, points.map((entry) => entry.nodes), points.map((entry) => entry.speedUp));
        }))
    }));
    if (sweep.length) {
        const { family, size } = config.full.workerSweep;
        plots.push(linePlot({
            id: 'scalingWorkerSweep', title: `Speed-up against workers, ${familyNames[family]} of ${size} nodes`, subtitle: 'Solving time, serial over parallel; the ideal is the number of workers',
            xLabel: 'Workers', yLabel: 'Speed-up', logX: true, logY: true, xTicks: config.full.workerSweep.workers,
            series: [
                ...['threadPool', 'partitioned'].map((backend) => {
                    const points = sweep.filter((entry) => entry.backend === backend);
                    return series(backendNames[backend], backendRoles[backend], points.map((entry) => entry.workers), points.map((entry) => entry.speedUp));
                }),
                series('ideal', 'guide', config.full.workerSweep.workers, config.full.workerSweep.workers)
            ]
        }));
    }
    return plots;
}

function timingNotes(cases, sweep, config) {
    const format = (value) => (value >= 1e6 ? `${(value / 1e6).toFixed(2)} M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)} k` : value.toFixed(value < 10 ? 1 : 0));
    const notes = [];
    for (const entry of cases.filter((candidate) => candidate.backend === 'serial')) {
        const best = cases.filter((candidate) => candidate.family === entry.family && candidate.nodes === entry.nodes && candidate.method === entry.method).toSorted((a, b) => a.solve.minimum - b.solve.minimum)[0];
        notes.push(`${entry.label.replace(', serial', '')}: wall ${format(entry.wall.minimum)} ms (compiling ${format(entry.compile.minimum)} ms, solving ${format(entry.solve.minimum)} ms, the rest ${format(entry.otherMilliseconds)} ms), ${format(entry.nodeStepsPerSecond)} node steps/s serial, peak memory ${entry.peakResidentBytes === null ? 'not measured' : `${(entry.peakResidentBytes / 2 ** 20).toFixed(0)} MiB`}; fastest solve ${backendNames[best.backend]} (speed-up ${best.speedUp.toFixed(2)}, efficiency ${best.efficiency.toFixed(2)}).`);
    }
    for (const entry of sweep) notes.push(`Worker sweep: ${backendNames[entry.backend]}, ${entry.workers} workers requested (${entry.effectiveWorkers} used): speed-up ${entry.speedUp.toFixed(2)}, efficiency ${(entry.speedUp / entry.effectiveWorkers).toFixed(2)}.`);
    return notes;
}
