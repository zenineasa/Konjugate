/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The generated benchmarks' own machinery (benchmarks/README.md: graph scalability and causal reconstruction), checked without the engine:
// the graphs' exact references against their equations and against the methods stepped independently, the models the graphs become, and
// the causal datasets against their generator and the scoring against hand-counted cases.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { contributionCount, denseMatrix, generateGraph, graphDocument, stepIndependently } from '../benchmarks/scaling/graphScalability/graphs.mjs';
import { dataDirectory, datasetCsv, datasets, truthDocument, truthOf } from '../benchmarks/causal/reconstruction/datasets.mjs';
import { score } from '../benchmarks/causal/reconstruction/problem.mjs';
import { mulberry32 } from '../benchmarks/lib/random.mjs';

const largest = (left, right) => Math.max(...left.map((value, index) => Math.abs(value - right[index])));

test('a lattice\'s exact solution satisfies its equations, and its closed-form steps are the methods stepped', () => {
    for (const [family, size] of [['chain', 37], ['grid', 49]]) {
        const graph = generateGraph(family, size);
        const matrix = denseMatrix(graph);
        // dT/dt = A T, by a central difference of the exact solution.
        const time = 0.7;
        const h = 1e-5;
        const before = graph.exact(time - h);
        const after = graph.exact(time + h);
        const now = Array.from(graph.exact(time));
        const derivative = now.map((_unused, index) => (after[index] - before[index]) / (2 * h));
        const rate = matrix.map((row) => row.reduce((total, value, column) => total + value * now[column], 0));
        assert.ok(largest(derivative, rate) < 1e-8, `${family}: the exact solution satisfies dT/dt = A T`);
        assert.ok(largest(Array.from(graph.exact(0)), Array.from(graph.initial)) < 1e-15);
        for (const method of ['explicitEuler', 'rungeKutta4']) {
            assert.ok(largest(Array.from(graph.discrete(method, 0.05, 40)), Array.from(stepIndependently(graph, method, 0.05, 40))) < 1e-13, `${family}, ${method}`);
        }
    }
});

test('the random network is the same for the same seed, connected through its ring, and conserves its heat', () => {
    const graph = generateGraph('random', 60, { seed: 7 });
    assert.deepEqual(Array.from(generateGraph('random', 60, { seed: 7 }).initial), Array.from(graph.initial));
    assert.notDeepEqual(Array.from(generateGraph('random', 60, { seed: 8 }).initial), Array.from(graph.initial));
    assert.equal(graph.pathCount, 120);
    const heat = (values) => values.reduce((total, value, index) => total + graph.capacities[index] * value, 0);
    for (const method of ['explicitEuler', 'rungeKutta4']) assert.ok(Math.abs(heat(stepIndependently(graph, method, 0.02, 100)) - heat(graph.initial)) < 1e-13);
    // The conductances are symmetric: C_i a_ij = C_j a_ji.
    const matrix = denseMatrix(graph);
    for (let i = 0; i < 60; ++i) for (let j = 0; j < 60; ++j) assert.ok(Math.abs(graph.capacities[i] * matrix[i][j] - graph.capacities[j] * matrix[j][i]) < 1e-14);
});

test('a generated graph becomes a project with a node per mass and a relationship per direction of each path', () => {
    const graph = generateGraph('grid', 16);
    const { document, stateIds } = graphDocument(graph, { globalTimeStep: 0.02, outputInterval: 0.5 });
    assert.equal(document.nodes.length, 16);
    assert.equal(document.edges.length, 48);
    assert.equal(stateIds.length, 16);
    // Corners lose two neighbours to the ambient, edge masses one, the four inner masses none.
    assert.equal(document.nodes.filter((node) => node.sourceTerms.length === 1).length, 12);
    assert.equal(contributionCount(graph), 48 + 12);
    assert.deepEqual(document.nodes[0].sourceTerms[0].expressionModel.mathJson, ['Negate', ['Multiply', 2, 'temperature']]);
});

test('the committed causal datasets are what their generator writes', () => {
    for (const dataset of datasets) {
        assert.equal(readFileSync(join(dataDirectory, `${dataset.id}.csv`), 'utf8'), datasetCsv(dataset), dataset.id);
        assert.deepEqual(JSON.parse(readFileSync(join(dataDirectory, `${dataset.id}.truth.json`), 'utf8')), JSON.parse(JSON.stringify(truthDocument(dataset))), dataset.id);
    }
});

test('the causal truth is in the engine\'s units: edge rates as given, a variable\'s own rate its coefficient less one', () => {
    const chain = truthOf(datasets.find((dataset) => dataset.id === 'chain'));
    assert.deepEqual(chain.edges[0], { source: 'x1', target: 'x2', lag: 1, terms: [{ degree: 1, rate: 0.8 }] });
    assert.ok(Math.abs(chain.selfRates.x2 - (0.3 - 1)) < 1e-15);
    const hidden = truthOf(datasets.find((dataset) => dataset.id === 'hiddenConfounder'));
    assert.deepEqual(hidden.observed, ['x1', 'x2']);
    assert.deepEqual(hidden.edges, []);
    const ode = truthOf(datasets.find((dataset) => dataset.id === 'odeChainDt0p5'));
    assert.equal(ode.timeStep, 0.5);
    assert.equal(ode.selfRates.x1, -1);
});

test('the reconstruction scores count edges, directions and equation error as defined', () => {
    const truth = { edges: [
        { source: 'a', target: 'b', lag: 1, terms: [{ degree: 1, rate: 1 }] },
        { source: 'b', target: 'c', lag: 1, terms: [{ degree: 1, rate: 1 }] },
        { source: 'a', target: 'c', lag: 1, terms: [{ degree: 1, rate: 1 }] }
    ], selfRates: { a: -0.5, b: -0.5, c: -0.5 } };
    const lagged = (source, target, coefficient) => ({ sourceColumn: source, targetColumn: target, provenance: 'continuousLagged', terms: [{ degree: 1, coefficient }], score: 0.9 });
    const report = {
        edges: [lagged('a', 'b', 1.1), lagged('b', 'a', 0.1), lagged('b', 'c', 0.9), { sourceColumn: 'a', targetColumn: 'c', provenance: 'correlationOnly', terms: [{ degree: 1, coefficient: 3 }] }],
        selfTerms: [{ targetColumn: 'b', rate: -0.5 }, { targetColumn: 'c', rate: -0.5 }]
    };
    const result = score(report, truth);
    assert.equal(result.proposed, 3);
    assert.equal(result.right, 2);
    assert.equal(result.precision, 2 / 3);
    assert.equal(result.recall, 2 / 3);
    assert.equal(result.skeletonPrecision, 1);
    assert.equal(result.skeletonRecall, 1);
    // a–b is reported both ways, a–c only as correlation: of three found pairs, one has exactly the true direction.
    assert.equal(result.directionAccuracy, 1 / 3);
    // Differences 0.1 (a→b), 0.1 (b→a, false), 0.1 (b→c), 1 (a→c, missed), against true magnitude √3.
    assert.ok(Math.abs(result.equationError - Math.sqrt((0.01 + 0.01 + 0.01 + 1) / 3)) < 1e-12);
    assert.ok(Math.abs(result.foundEquationError - Math.sqrt(0.02 / 2)) < 1e-12);
    assert.ok(Math.abs(result.largestFalseRate - 0.1) < 1e-15);
    assert.equal(result.ownRateError, 0);
});

test('the seeded generator gives the same numbers every time', () => {
    const first = mulberry32(42);
    const second = mulberry32(42);
    for (let index = 0; index < 100; ++index) assert.equal(first(), second());
    const values = Array.from({ length: 1000 }, mulberry32(1));
    assert.ok(values.every((value) => value >= 0 && value < 1));
});
