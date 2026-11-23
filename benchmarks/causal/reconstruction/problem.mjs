/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Causal reconstruction: datasets generated from known graphs and equations (datasets.mjs states every generator), the graph hidden, and
// Konjugate's causal inference (`konjugateEngine infer`, docs/causalInference.md) asked to find it again from the CSV alone.
//
// Measured for every dataset, against its truth:
//   directed edges   a proposed edge is one `infer` reports with provenance "continuousLagged" (a lagged fit with a direction):
//                    precision = right / proposed, recall = right / true, F1 their harmonic mean
//   skeleton         the same for unordered pairs, counting also the "correlationOnly" pairs (related, direction unclear)
//   direction        of the true edges whose pair is found at all, the share reported in exactly the true direction (not reversed, not
//                    both ways, not correlation only)
//   equations        each proposed or true edge's terms as rates (degree 1, degree 2, the source-target product) against the true rates,
//                    a missing edge counting as zero: ‖estimated - true‖ / ‖true‖ over every edge ("equation error"), and over the true
//                    edges that were found ("on found edges"); and the own rate of every variable with a true cause (`infer` gives one
//                    only to a variable it finds a cause for), the same way ("own-rate error")
//
// Every check is judged against benchmark.json. For a dataset expected to be recovered, F1 has a floor a little below its observed value.
// For a dataset showing a known limit, the measure that shows the limit has a band on both sides of its observed value, so a change to the
// inference that alters it either way is noticed and the benchmark updated knowingly.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeInferenceReport } from '../../../src/reportProtocol.mjs';
import { createChecks, linePlot, series } from '../../lib/study.mjs';
import { dataDirectory, datasetCsv, datasets, truthOf } from './datasets.mjs';

export const directory = import.meta.dirname;
export const models = {};

function execute(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, diagnostics }));
    });
}

export const inferenceArguments = ({ degrees = [1], interaction = false } = {}) => [
    ...(degrees.length !== 1 || degrees[0] !== 1 ? ['--degrees', degrees.join(',')] : []),
    ...(interaction ? ['--include-interaction-terms', 'true'] : [])
];

async function infer(executable, csvPath, reportPath, inference) {
    const { code, diagnostics } = await execute(executable, ['infer', csvPath, '--report', reportPath, ...inferenceArguments(inference)]);
    if (code !== 0) throw new Error(`infer failed on ${csvPath} (exit ${code}). ${diagnostics.trim()}`);
    return decodeInferenceReport(await readFile(reportPath));
}

const ratio = (numerator, denominator) => (denominator ? numerator / denominator : null);
const harmonic = (precision, recall) => (precision === null || recall === null ? null : precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0);
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Scores one inference report against a dataset's truth.
export function score(report, truth) {
    const trueEdges = new Map(truth.edges.map((edge) => [`${edge.source}→${edge.target}`, edge]));
    const lagged = new Map(report.edges.filter((edge) => edge.provenance === 'continuousLagged').map((edge) => [`${edge.sourceColumn}→${edge.targetColumn}`, edge]));
    const correlationPairs = new Set(report.edges.filter((edge) => edge.provenance === 'correlationOnly').map((edge) => pairKey(edge.sourceColumn, edge.targetColumn)));
    const right = [...lagged.keys()].filter((key) => trueEdges.has(key)).length;
    const precision = ratio(right, lagged.size);
    const recall = ratio(right, trueEdges.size);

    const truePairs = new Set(truth.edges.map((edge) => pairKey(edge.source, edge.target)));
    const foundPairs = new Set([...[...lagged.values()].map((edge) => pairKey(edge.sourceColumn, edge.targetColumn)), ...correlationPairs]);
    const rightPairs = [...foundPairs].filter((pair) => truePairs.has(pair)).length;
    const skeletonPrecision = ratio(rightPairs, foundPairs.size);
    const skeletonRecall = ratio(rightPairs, truePairs.size);

    let directed = 0;
    let directable = 0;
    for (const edge of truth.edges) {
        if (!foundPairs.has(pairKey(edge.source, edge.target))) continue;
        directable += 1;
        if (lagged.has(`${edge.source}→${edge.target}`) && !lagged.has(`${edge.target}→${edge.source}`)) directed += 1;
    }

    // Each edge's terms as [degree 1, degree 2, product] rates.
    const trueTerms = (edge) => [1, 2].map((degree) => edge?.terms.find((term) => term.degree === degree)?.rate ?? 0).concat([edge?.interaction ?? 0]);
    const estimatedTerms = (edge) => [1, 2].map((degree) => edge?.terms.find((term) => term.degree === degree)?.coefficient ?? 0).concat([edge?.interaction?.coefficient ?? 0]);
    const accumulate = (keys) => {
        let difference = 0;
        let magnitude = 0;
        for (const key of keys) {
            const exact = trueTerms(trueEdges.get(key));
            const estimate = estimatedTerms(lagged.get(key));
            exact.forEach((value, index) => { difference += (estimate[index] - value) ** 2; magnitude += value ** 2; });
        }
        return magnitude > 0 ? Math.sqrt(difference / magnitude) : null;
    };
    const equationError = accumulate(new Set([...trueEdges.keys(), ...lagged.keys()]));
    const foundEquationError = accumulate([...trueEdges.keys()].filter((key) => lagged.has(key)));
    const caused = [...new Set(truth.edges.map((edge) => edge.target))];
    const ownRates = new Map(report.selfTerms.map((term) => [term.targetColumn, term.rate]));
    let ownDifference = 0;
    let ownMagnitude = 0;
    for (const target of caused) {
        ownDifference += ((ownRates.get(target) ?? 0) - truth.selfRates[target]) ** 2;
        ownMagnitude += truth.selfRates[target] ** 2;
    }
    return {
        trueEdges: trueEdges.size, proposed: lagged.size, right, falseEdges: lagged.size - right, correlationOnlyPairs: correlationPairs.size,
        precision, recall, f1: harmonic(precision, recall),
        skeletonPrecision, skeletonRecall, skeletonF1: harmonic(skeletonPrecision, skeletonRecall),
        directionAccuracy: ratio(directed, directable), equationError, foundEquationError,
        ownRateError: ownMagnitude > 0 ? Math.sqrt(ownDifference / ownMagnitude) : null,
        largestFalseRate: Math.max(0, ...[...lagged.entries()].filter(([key]) => !trueEdges.has(key)).map(([, edge]) => Math.abs(edge.terms.find((term) => term.degree === 1)?.coefficient ?? 0))),
        smallestTrueRate: Math.min(...truth.edges.map((edge) => Math.abs(edge.terms[0]?.rate ?? edge.interaction ?? 0))),
        proposedEdges: [...lagged.values()].map((edge) => ({ edge: `${edge.sourceColumn}→${edge.targetColumn}`, terms: edge.terms.map((term) => [term.degree, term.coefficient]), interaction: edge.interaction?.coefficient ?? null, score: edge.score }))
    };
}

const formatShare = (value) => (value === null ? '–' : value.toFixed(2));
const formatError = (value) => (value === null ? '–' : value.toPrecision(2));

function row(dataset, result, note = '') {
    return {
        case: dataset.title, model: dataset.id, method: `infer${inferenceArguments(dataset.inference).length ? ` ${inferenceArguments(dataset.inference).join(' ')}` : ''}`,
        globalTimeStep: null, substeps: null, targetTime: null, maxAbsError: null, rmse: null, relativeError: result.equationError,
        conservationError: null, steadyStateError: null, observedOrder: null, globalSteps: null, substepsExecuted: null, evaluations: null, unit: 'rates',
        note: [
            `${dataset.rows} rows; edges true ${result.trueEdges}, proposed ${result.proposed}, right ${result.right}`,
            `precision ${formatShare(result.precision)}, recall ${formatShare(result.recall)}, F1 ${formatShare(result.f1)}`,
            `skeleton F1 ${formatShare(result.skeletonF1)}${result.correlationOnlyPairs ? ` (${result.correlationOnlyPairs} pair${result.correlationOnlyPairs === 1 ? '' : 's'} correlation only)` : ''}`,
            `direction ${formatShare(result.directionAccuracy)}`,
            result.falseEdges ? `largest false edge's rate ${result.largestFalseRate.toPrecision(2)} (smallest true rate ${result.smallestTrueRate.toPrecision(2)})` : null,
            `equation error ${formatError(result.equationError)} (on found edges ${formatError(result.foundEquationError)}), own-rate error ${formatError(result.ownRateError)}`,
            dataset.expect === 'limit' ? `known limit: ${dataset.limit}` : null,
            note
        ].filter(Boolean).join('; ')
    };
}

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const workDirectory = await mkdtemp(join(tmpdir(), 'konjugateCausal-'));
    const results = {};
    const rows = [];
    const sweep = config.sampleSize;
    const source = datasets.find((dataset) => dataset.id === sweep.dataset);
    try {
        for (const dataset of datasets) {
            const csvPath = join(dataDirectory, `${dataset.id}.csv`);
            // The committed data must be exactly what its generator writes, or its truth could describe different data.
            if (readFileSync(csvPath, 'utf8') !== datasetCsv(dataset)) throw new Error(`benchmarks/causal/reconstruction/data/${dataset.id}.csv differs from what datasets.mjs generates. Run node benchmarks/causal/reconstruction/datasets.mjs.`);
            const truth = truthOf(dataset);
            const report = await infer(engine.executable, csvPath, join(workDirectory, `${dataset.id}.bin`), dataset.inference);
            results[dataset.id] = score(report, truth);
            rows.push(row(dataset, results[dataset.id]));
        }
        // Sample size: the first n rows of one dataset.
        const lines = readFileSync(join(dataDirectory, `${source.id}.csv`), 'utf8').trimEnd().split('\n');
        results.sampleSize = [];
        for (const rowsUsed of sweep.rows) {
            const csvPath = join(workDirectory, `${source.id}-${rowsUsed}.csv`);
            await writeFile(csvPath, `${lines.slice(0, rowsUsed + 1).join('\n')}\n`);
            const result = score(await infer(engine.executable, csvPath, join(workDirectory, `${source.id}-${rowsUsed}.bin`), source.inference), truthOf(source));
            results.sampleSize.push({ rows: rowsUsed, ...result });
            rows.push(row({ ...source, rows: rowsUsed, title: `${source.title}, first ${rowsUsed} rows` }, result));
        }
    } finally {
        await rm(workDirectory, { recursive: true, force: true });
    }

    for (const name of Object.keys(config.thresholds)) {
        const [id, measure] = name.split('.');
        if (id === 'pooled' || id === 'sampleSize') continue;
        const dataset = datasets.find((candidate) => candidate.id === id);
        add(name, results[id][measure] ?? NaN, `${dataset.title}: ${config.measures[measure]}${dataset.expect === 'limit' ? ` (known limit: ${dataset.limit})` : ''}`);
    }
    const recovered = datasets.filter((dataset) => dataset.expect === 'recover');
    const pooledDirection = recovered.reduce((total, dataset) => total + (results[dataset.id].directionAccuracy ?? 0) * results[dataset.id].trueEdges, 0) / recovered.reduce((total, dataset) => total + results[dataset.id].trueEdges, 0);
    add('pooled.directionAccuracy', pooledDirection, `Every dataset expected to be recovered: ${config.measures.directionAccuracy}, weighted by true edges`);
    add('pooled.foundEquationError', Math.max(...recovered.filter((dataset) => dataset.kind === 'discrete').map((dataset) => results[dataset.id].foundEquationError ?? Infinity)),
        `Every discrete-time dataset expected to be recovered (the model class infer fits): largest ${config.measures.foundEquationError}`);
    const [fewest] = results.sampleSize;
    const most = results.sampleSize.at(-1);
    add('sampleSize.f1Gain', most.f1 - fewest.f1, `${source.title}: F1 with all ${most.rows} rows less F1 with the first ${fewest.rows}`);

    const noise = [0.5, 2, 8, 32];
    const noiseResults = ['diamond', 'diamondNoise2', 'diamondNoise8', 'diamondNoise32'].map((id) => results[id]);
    const ode = datasets.filter((dataset) => dataset.kind === 'ode');
    const plots = [
        linePlot({
            id: 'causalNoise', title: 'Recovery against noise', subtitle: 'Diamond x1 → x2, x3 → x4, 1,500 rows; noise σ on the three downstream variables', xLabel: 'Downstream noise σ', yLabel: 'Share', logX: true, xTicks: noise,
            series: [
                series('precision', 'slot1', noise, noiseResults.map((result) => result.precision ?? 0)),
                series('recall', 'slot2', noise, noiseResults.map((result) => result.recall ?? 0)),
                series('F1', 'slot3', noise, noiseResults.map((result) => result.f1 ?? 0)),
                series('direction', 'slot4', noise, noiseResults.map((result) => result.directionAccuracy ?? 0))
            ]
        }),
        linePlot({
            id: 'causalSampleSize', title: 'Recovery against the number of rows', subtitle: `${source.title}, the first n rows`, xLabel: 'Rows', yLabel: 'Share', logX: true, xTicks: sweep.rows,
            series: [
                series('precision', 'slot1', sweep.rows, results.sampleSize.map((result) => result.precision ?? 0)),
                series('recall', 'slot2', sweep.rows, results.sampleSize.map((result) => result.recall ?? 0)),
                series('F1', 'slot3', sweep.rows, results.sampleSize.map((result) => result.f1 ?? 0)),
                series('direction', 'slot4', sweep.rows, results.sampleSize.map((result) => result.directionAccuracy ?? 0))
            ]
        }),
        linePlot({
            id: 'causalSampling', title: 'Continuous time: equations against the sampling interval', subtitle: 'Linear ODE chain x1 → x2 → x3 → x4, rates -1, 1, 0.8, -0.8 s⁻¹', xLabel: 'Sampling interval Δt (s)', yLabel: 'Relative error', logX: true, logY: true, xTicks: ode.map((dataset) => dataset.sampleInterval),
            series: [
                series('equation error, every edge', 'slot1', ode.map((dataset) => dataset.sampleInterval), ode.map((dataset) => results[dataset.id].equationError)),
                series('equation error, found edges', 'slot2', ode.map((dataset) => dataset.sampleInterval), ode.map((dataset) => results[dataset.id].foundEquationError)),
                series('own-rate error', 'slot3', ode.map((dataset) => dataset.sampleInterval), ode.map((dataset) => results[dataset.id].ownRateError))
            ]
        })
    ];
    return { rows, checks, plots, notes: config.notes };
}
