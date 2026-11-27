/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Synthetic datasets with known causal structure, for measuring how well Konjugate's causal inference (docs/causalInference.md, engine
// `infer`) recovers it. Every dataset is generated from a seed by this file, written to data/<id>.csv (the CSV `infer` reads: a time
// column, then one column per observed variable) and data/<id>.truth.json (the graph and equations it came from). Both are committed; the
// benchmark regenerates each dataset in memory and refuses to run if the committed CSV differs, so data and truth cannot drift apart.
//
//   node benchmarks/causal/reconstruction/datasets.mjs        writes every dataset
//
// Two kinds of generator:
//
//   discrete   a structural model stepped once per row (Δt = 1):
//                  x_i(t) = a_i x_i(t-1) + Σ_edges [ b x_j(t-L) + q x_j(t-L)² + c x_j(t-1) x_i(t-1) ] + Σ_instant d x_j(t) + σ_i ε_i(t)
//              with ε standard normal. This is the model class `infer` fits (lag 1; a self-lag; additive powers of a source; a
//              source-target product), except where a dataset deliberately steps outside it (a lag of 2, an effect within the same row, a
//              variable left out of the CSV). In the engine's units every coefficient is a rate per Δt: an edge's b, q and c are its
//              terms, and a variable's own term is a_i - 1.
//
//   ode        a continuous-time linear system dx/dt = A x + σ dW, integrated by Euler–Maruyama on a fine step and sampled every Δt. The
//              true rates are A's entries. `infer` converts a fitted one-row transition Φ to rates as (Φ - I)/Δt, while the sampled
//              data follow Φ = exp(A Δt); the two agree only when A Δt is small, so these datasets measure how the recovered equations
//              degrade as the sampling coarsens (docs/causalInference.md, "From a candidate to a real equation").
//
// Values are written to five significant figures, which keeps the files small; the rounding (about 1e-5 of a value) is far below every
// dataset's noise.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gaussian, mulberry32, uniform } from '../../lib/random.mjs';

export const dataDirectory = join(import.meta.dirname, 'data');
const burnIn = 200;

// A random directed acyclic graph over n variables in a fixed order: each pair (j < i) joined with probability p, each edge's rate
// uniform in ±[0.4, 0.9], each variable's own coefficient a uniform in [0.2, 0.6], every noise σ = 1.
function randomDag(n, p, seed) {
    const random = mulberry32(seed);
    const variables = Array.from({ length: n }, (_unused, index) => ({ name: `x${index + 1}`, self: Number(uniform(random, 0.2, 0.6).toFixed(3)), noise: 1 }));
    const edges = [];
    for (let target = 1; target < n; ++target) {
        for (let source = 0; source < target; ++source) {
            if (random() < p) {
                const magnitude = uniform(random, 0.4, 0.9);
                edges.push({ source: `x${source + 1}`, target: `x${target + 1}`, linear: Number(((random() < 0.5 ? -1 : 1) * magnitude).toFixed(3)) });
            }
        }
    }
    return { variables, edges };
}

const v = (name, self, noise = 1) => ({ name, self, noise });

// Every dataset. `group` orders the report; `expect` says, before running, whether the method should recover the structure ("recover")
// or is being shown at a known limit ("limit"), with the reason.
export const datasets = [
    // Topologies, linear, low noise.
    { id: 'chain', group: 'topology', title: 'Chain x1 → x2 → x3', kind: 'discrete', seed: 101, rows: 1500, expect: 'recover',
        variables: [v('x1', 0.5), v('x2', 0.3, 0.5), v('x3', 0.3, 0.5)],
        edges: [{ source: 'x1', target: 'x2', linear: 0.8 }, { source: 'x2', target: 'x3', linear: 0.7 }] },
    { id: 'fork', group: 'topology', title: 'Fork (common cause) x1 → x2, x1 → x3', kind: 'discrete', seed: 102, rows: 1500, expect: 'recover',
        variables: [v('x1', 0.5), v('x2', 0.3, 0.5), v('x3', 0.3, 0.5)],
        edges: [{ source: 'x1', target: 'x2', linear: 0.8 }, { source: 'x1', target: 'x3', linear: -0.6 }] },
    { id: 'collider', group: 'topology', title: 'Collider x1 → x3 ← x2', kind: 'discrete', seed: 103, rows: 1500, expect: 'recover',
        variables: [v('x1', 0.5), v('x2', 0.4), v('x3', 0.3, 0.5)],
        edges: [{ source: 'x1', target: 'x3', linear: 0.7 }, { source: 'x2', target: 'x3', linear: 0.6 }] },
    { id: 'diamond', group: 'topology', title: 'Diamond x1 → x2, x3 → x4', kind: 'discrete', seed: 104, rows: 1500, expect: 'recover',
        variables: [v('x1', 0.5), v('x2', 0.3, 0.5), v('x3', 0.3, 0.5), v('x4', 0.2, 0.5)],
        edges: [{ source: 'x1', target: 'x2', linear: 0.8 }, { source: 'x1', target: 'x3', linear: 0.6 }, { source: 'x2', target: 'x4', linear: 0.5 }, { source: 'x3', target: 'x4', linear: -0.7 }] },
    { id: 'feedback', group: 'topology', title: 'Feedback loop x1 → x2 → x3 → x1', kind: 'discrete', seed: 105, rows: 1500, expect: 'recover',
        variables: [v('x1', 0.3), v('x2', 0.3), v('x3', 0.3)],
        edges: [{ source: 'x1', target: 'x2', linear: 0.6 }, { source: 'x2', target: 'x3', linear: 0.6 }, { source: 'x3', target: 'x1', linear: -0.5 }] },
    { id: 'randomDag10', group: 'topology', title: 'Random sparse graph, 10 variables', kind: 'discrete', seed: 106, rows: 1500, expect: 'recover', ...randomDag(10, 0.25, 106) },
    { id: 'randomDag20', group: 'topology', title: 'Random sparse graph, 20 variables', kind: 'discrete', seed: 107, rows: 1000, expect: 'recover', ...randomDag(20, 0.12, 107) },

    // Noise: the diamond's downstream noise raised from 0.5 to 2, 8 and 32 (the root's stays 1).
    ...[2, 8, 32].map((noise, index) => ({
        id: `diamondNoise${noise}`, group: 'noise', title: `Diamond, downstream noise σ = ${noise}`, kind: 'discrete', seed: 110 + index, rows: 1500, expect: noise >= 8 ? 'limit' : 'recover',
        limit: noise >= 8 ? (noise === 8 ? 'The root x1 explains little of x2 and x3 against their own noise. Here the skeleton keeps every pair (its bar for four columns and 1,500 rows is 0.074) and all four edges are found, but not reliably: over 20 other seeds about one edge in seven is missed.' : 'The root x1 explains too little of x2 and x3 against their own noise for the skeleton to keep the pairs; the edges into x4, whose causes now vary widely, are still found.') : undefined,
        variables: [v('x1', 0.5), v('x2', 0.3, noise), v('x3', 0.3, noise), v('x4', 0.2, noise)],
        edges: [{ source: 'x1', target: 'x2', linear: 0.8 }, { source: 'x1', target: 'x3', linear: 0.6 }, { source: 'x2', target: 'x4', linear: 0.5 }, { source: 'x3', target: 'x4', linear: -0.7 }]
    })),

    // Nonlinear terms.
    { id: 'quadratic', group: 'nonlinear', title: 'Quadratic term x2 = 0.6 x1 + 0.4 x1² + …', kind: 'discrete', seed: 120, rows: 1500, expect: 'recover', inference: { degrees: [1, 2] },
        variables: [v('x1', 0.5), v('x2', 0.3, 0.3), v('x3', 0.3, 0.3)],
        edges: [{ source: 'x1', target: 'x2', linear: 0.6, quadratic: 0.4 }, { source: 'x2', target: 'x3', linear: 0.7 }] },
    { id: 'pureQuadratic', group: 'nonlinear', title: 'Purely quadratic term x2 = 0.8 x1² + …', kind: 'discrete', seed: 121, rows: 1500, expect: 'limit', inference: { degrees: [1, 2] },
        limit: 'x1 is symmetric about zero, so x1² has no linear correlation with x1 in expectation, and the skeleton (stage 1) is linear. It keeps the pair only when the sample\'s chance linear correlation clears its bar, as in this sample, and the power is then fitted exactly; over 20 other seeds that happens in one in five.',
        variables: [v('x1', 0.0), v('x2', 0.3, 0.3)],
        edges: [{ source: 'x1', target: 'x2', quadratic: 0.8 }] },
    { id: 'bilinear', group: 'nonlinear', title: 'Source-target product x2 += 0.3 x1 x2 (with a linear path)', kind: 'discrete', seed: 122, rows: 1500, expect: 'recover', inference: { interaction: true },
        variables: [v('x1', 0.5), v('x2', 0.4, 0.5)],
        edges: [{ source: 'x1', target: 'x2', linear: 0.6, interaction: 0.3 }] },

    // Outside the model class.
    { id: 'lag2', group: 'model class', title: 'Delay of two rows x1(t-2) → x2(t)', kind: 'discrete', seed: 130, rows: 1500, expect: 'limit',
        limit: 'infer fits lag 1 only (a lag of 2 has no single-Euler-step equation); x1\'s own persistence lets x1(t-1) stand in for x1(t-2), so the edge is found but its rate is wrong.',
        variables: [v('x1', 0.5), v('x2', 0.3, 0.5)],
        edges: [{ source: 'x1', target: 'x2', linear: 0.8, lag: 2 }] },
    { id: 'instantaneous', group: 'model class', title: 'Effect within one row x2(t) = 0.8 x1(t) + …', kind: 'discrete', seed: 131, rows: 1500, expect: 'limit',
        limit: 'The effect is faster than the sampling, so there is no lagged evidence of its direction; at best the pair is found as correlation without a direction.',
        variables: [v('x1', 0.5), v('x2', 0.3, 0.5)],
        edges: [{ source: 'x1', target: 'x2', linear: 0.8, lag: 0 }] },
    { id: 'hiddenConfounder', group: 'model class', title: 'Hidden common cause z → x1, z → x2 (z not in the CSV)', kind: 'discrete', seed: 132, rows: 1500, expect: 'limit', hidden: ['z'],
        limit: 'Nothing can tell a hidden common cause from a direct link using the observed columns alone; x1 and x2 truly share no edge, so any edge found between them is false.',
        variables: [v('z', 0.8), v('x1', 0.3, 0.5), v('x2', 0.3, 0.5)],
        edges: [{ source: 'z', target: 'x1', linear: 0.8 }, { source: 'z', target: 'x2', linear: 0.8 }] },
    { id: 'nearDeterministic', group: 'model class', title: 'Near-noiseless copy x1 → x2, x3(t) = x2(t) + 0.01 ε', kind: 'discrete', seed: 133, rows: 1500, expect: 'limit',
        limit: 'The skeleton conditions on every other current and lagged column at once; x3 is an almost exact copy of x2 in the same row, so conditioned on it x2 has nothing left to correlate with x1 (the collider-bias limitation docs/causalInference.md describes). The copy itself, within one row, is outside the lag-1 model.',
        variables: [v('x1', 0.5), v('x2', 0.3, 0.5), v('x3', 0.0, 0.01)],
        edges: [{ source: 'x1', target: 'x2', linear: 0.8 }, { source: 'x2', target: 'x3', linear: 1.0, lag: 0 }] },

    // Continuous time, sampled from finely to coarsely.
    ...[0.1, 0.5, 1, 2].map((sampleInterval, index) => ({
        id: `odeChainDt${String(sampleInterval).replace('.', 'p')}`, group: 'continuous time', title: `Linear ODE chain x1 → x2 → x3 → x4, sampled every ${sampleInterval} s`, kind: 'ode',
        seed: 140 + index, rows: 1500, sampleInterval, fineStep: 0.001, expect: sampleInterval === 0.5 || sampleInterval === 1 ? 'recover' : 'limit',
        limit: {
            0.1: 'Sampled finely, each variable changes little in one row; conditioned on the source\'s current value, its previous one adds only about Δt/2 of the coupling, below the skeleton\'s fixed threshold of 0.1 in partial correlation. More rows do not help (6,000 rows give the same), since the threshold is on the size of the correlation, not its significance.',
            2: 'Sampled coarsely, Φ = exp(A Δt) is far from I + A Δt, and (Φ - I)/Δt, the rate infer reports, is far from A: the structure is still found, but every rate is badly biased towards zero.'
        }[sampleInterval],
        variables: [v('x1', -1), v('x2', -1), v('x3', -1), v('x4', -1)],
        edges: [{ source: 'x1', target: 'x2', linear: 1.0 }, { source: 'x2', target: 'x3', linear: 0.8 }, { source: 'x3', target: 'x4', linear: -0.8 }]
    }))
];

// The dataset's truth in the engine's units: each edge's terms as rates, and each variable's own rate.
export function truthOf(dataset) {
    const timeStep = dataset.kind === 'ode' ? dataset.sampleInterval : 1;
    const hidden = new Set(dataset.hidden ?? []);
    const edges = dataset.edges.filter((edge) => !hidden.has(edge.source) && !hidden.has(edge.target)).map((edge) => ({
        source: edge.source, target: edge.target, lag: edge.lag ?? 1,
        terms: [...(edge.linear ? [{ degree: 1, rate: edge.linear }] : []), ...(edge.quadratic ? [{ degree: 2, rate: edge.quadratic }] : [])],
        ...(edge.interaction ? { interaction: edge.interaction } : {})
    }));
    const selfRates = Object.fromEntries(dataset.variables.filter((variable) => !hidden.has(variable.name)).map((variable) => [variable.name, dataset.kind === 'ode' ? variable.self : variable.self - 1]));
    return { timeStep, observed: dataset.variables.map((variable) => variable.name).filter((name) => !hidden.has(name)), hidden: [...hidden], edges, selfRates };
}

function simulateDiscrete(dataset) {
    const random = mulberry32(dataset.seed);
    const names = dataset.variables.map((variable) => variable.name);
    const index = Object.fromEntries(names.map((name, position) => [name, position]));
    const incoming = names.map(() => []);
    for (const edge of dataset.edges) incoming[index[edge.target]].push({ ...edge, from: index[edge.source], lag: edge.lag ?? 1 });
    const total = burnIn + dataset.rows;
    const series = Array.from({ length: total }, () => new Array(names.length).fill(0));
    for (let t = 2; t < total; ++t) {
        dataset.variables.forEach((variable, target) => {
            let value = variable.self * series[t - 1][target] + variable.noise * gaussian(random);
            for (const edge of incoming[target]) {
                const past = series[t - edge.lag][edge.from];
                value += (edge.linear ?? 0) * past + (edge.quadratic ?? 0) * past * past;
                if (edge.interaction) value += edge.interaction * series[t - 1][edge.from] * series[t - 1][target];
            }
            series[t][target] = value;
        });
        if (!series[t].every(Number.isFinite) || series[t].some((value) => Math.abs(value) > 1e6)) throw new Error(`${dataset.id} diverged at row ${t}.`);
    }
    return { times: Array.from({ length: dataset.rows }, (_unused, row) => row), values: series.slice(burnIn) };
}

function simulateOde(dataset) {
    const random = mulberry32(dataset.seed);
    const names = dataset.variables.map((variable) => variable.name);
    const index = Object.fromEntries(names.map((name, position) => [name, position]));
    const n = names.length;
    const rates = Array.from({ length: n }, (_unused, row) => dataset.variables[row].self);
    const couplings = dataset.edges.map((edge) => ({ from: index[edge.source], to: index[edge.target], rate: edge.linear }));
    const perSample = Math.round(dataset.sampleInterval / dataset.fineStep);
    const diffusion = Math.sqrt(dataset.fineStep);
    let state = new Array(n).fill(0);
    const values = [];
    for (let sample = 0; sample < burnIn + dataset.rows; ++sample) {
        if (sample >= burnIn) values.push(state.slice());
        for (let step = 0; step < perSample; ++step) {
            const next = state.map((value, row) => value + dataset.fineStep * rates[row] * value + dataset.variables[row].noise * diffusion * gaussian(random));
            for (const { from, to, rate } of couplings) next[to] += dataset.fineStep * rate * state[from];
            state = next;
        }
    }
    return { times: values.map((_unused, row) => Number((row * dataset.sampleInterval).toFixed(6))), values };
}

const figures = (value) => String(Number(value.toPrecision(5)));

// The dataset's CSV text, exactly as committed.
export function datasetCsv(dataset) {
    const { times, values } = dataset.kind === 'ode' ? simulateOde(dataset) : simulateDiscrete(dataset);
    const hidden = new Set(dataset.hidden ?? []);
    const columns = dataset.variables.map((variable, position) => [variable.name, position]).filter(([name]) => !hidden.has(name));
    const lines = [['time', ...columns.map(([name]) => name)].join(',')];
    values.forEach((row, sample) => lines.push([times[sample], ...columns.map(([, position]) => figures(row[position]))].join(',')));
    return `${lines.join('\n')}\n`;
}

export function truthDocument(dataset) {
    const { edges, variables, ...rest } = dataset;
    return { ...rest, generator: { variables, edges }, truth: truthOf(dataset) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await mkdir(dataDirectory, { recursive: true });
    for (const dataset of datasets) {
        await writeFile(join(dataDirectory, `${dataset.id}.csv`), datasetCsv(dataset));
        await writeFile(join(dataDirectory, `${dataset.id}.truth.json`), `${JSON.stringify(truthDocument(dataset), null, 4)}\n`);
        console.log(`Wrote benchmarks/causal/reconstruction/data/${dataset.id}.csv and .truth.json.`);
    }
}
