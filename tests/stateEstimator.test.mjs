/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The estimator's mathematics (src/stateEstimator.mjs) against the exact answer: for a linear model with Gaussian noise the Kalman
// filter is exact, so an ensemble filter of a two-state model (a level and its unmeasured inflow) must agree with the closed-form
// filter, mean and spread, within what the ensemble's size allows; and it must be repeatable to the bit.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, ensembleStatistics, initialEnsemble, perturb, quantile, readingNoise, seededNormal } from '../src/stateEstimator.mjs';

// level' = inflow - k level, inflow' = 0, stepped exactly over Δ (the transition matrix of the linear system).
const k = 0.002;
const delta = 600;
const decay = Math.exp(-k * delta);
const F = [[decay, (1 - decay) / k], [0, 1]];
const apply = (matrix, vector) => matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
const multiply = (a, b) => a.map((row) => b[0].map((_, j) => row.reduce((sum, value, k2) => sum + value * b[k2][j], 0)));
const transpose = (matrix) => matrix[0].map((_, j) => matrix.map((row) => row[j]));

test('an ensemble filter agrees with the exact Kalman filter on a linear model', () => {
    const processSigmas = [0.05, 0.0004];
    const readingSigma = 0.2;
    const truthNormal = seededNormal(99);
    const truth = [[10, 0.03]];
    for (let move = 1; move <= 10; move += 1) truth.push(apply(F, truth.at(-1)).map((value, index) => value + processSigmas[index] * truthNormal()));
    const readings = truth.map((state) => state[0] + readingSigma * truthNormal());

    // The exact filter, from a mean that is wrong about the inflow.
    let mean = [readings[0], 0.02];
    let covariance = [[readingSigma ** 2, 0], [0, 0.01 ** 2]];
    // The ensemble filter, from the same mean and spread.
    const count = 20000;
    const normal = seededNormal(7);
    let members = initialEnsemble(mean, [readingSigma, 0.01], count, normal);
    for (let move = 1; move <= 10; move += 1) {
        mean = apply(F, mean);
        covariance = multiply(multiply(F, covariance), transpose(F)).map((row, i) => row.map((value, j) => value + (i === j ? processSigmas[i] ** 2 : 0)));
        const innovationVariance = covariance[0][0] + readingSigma ** 2;
        const gain = [covariance[0][0] / innovationVariance, covariance[1][0] / innovationVariance];
        const innovation = readings[move] - mean[0];
        mean = mean.map((value, index) => value + gain[index] * innovation);
        covariance = covariance.map((row, i) => row.map((value, j) => value - gain[i] * covariance[0][j]));

        members = perturb(members.map((member) => apply(F, member)), processSigmas, normal);
        members = analyse(members, [{ index: 0, value: readings[move], noise: readingSigma }], normal).members;
    }
    const { mean: ensembleMean, spread } = ensembleStatistics(members);
    for (const index of [0, 1]) {
        const exactSpread = Math.sqrt(covariance[index][index]);
        // The ensemble's mean is within a few of its own standard errors of the exact one, and its spread within a few percent.
        assert.ok(Math.abs(ensembleMean[index] - mean[index]) < 5 * exactSpread / Math.sqrt(count) + 1e-12, `state ${index}: mean ${ensembleMean[index]} against ${mean[index]}`);
        assert.ok(Math.abs(spread[index] / exactSpread - 1) < 0.04, `state ${index}: spread ${spread[index]} against ${exactSpread}`);
    }
    // The inflow, never measured, was learnt from the level: its spread shrank from 0.01 and its mean moved toward the truth.
    assert.ok(spread[1] < 0.01 / 2);
    assert.ok(Math.abs(ensembleMean[1] - truth.at(-1)[1]) < Math.abs(0.02 - truth.at(-1)[1]));
});

test('repeatable to the bit, kept within bounds, and a state that is only read is never set', () => {
    const run = () => {
        const normal = seededNormal(3);
        const members = initialEnsemble([1, 5, 2], [0.5, 1, 0.1], 40, normal);
        return analyse(members, [{ index: 0, value: 1.4, noise: 0.1 }], normal, { updatable: [true, true, false], bounds: [null, { minimum: 4.8, maximum: 5.2 }, null] }).members;
    };
    const first = run();
    assert.deepEqual(run(), first);
    assert.ok(first.every((member) => member[1] >= 4.8 && member[1] <= 5.2));
    const normal = seededNormal(3);
    const before = initialEnsemble([1, 5, 2], [0.5, 1, 0.1], 40, normal);
    assert.deepEqual(first.map((member) => member[2]), before.map((member) => member[2]), 'The read-only state is as it was.');
    assert.throws(() => analyse(initialEnsemble([1], [0], 5, seededNormal(1)), [{ index: 0, value: 1, noise: 0 }], seededNormal(1)), /no information/);
});

test('an observation given as each member\'s prediction is the same analysis as one pointing at a state', () => {
    const members = initialEnsemble([300, 20], [0.5, 2], 50, seededNormal(5));
    const byIndex = analyse(members, [{ index: 0, value: 300.4, noise: 0.15 }], seededNormal(9)).members;
    const byPrediction = analyse(members, [{ predictions: members.map((member) => member[0]), value: 300.4, noise: 0.15 }], seededNormal(9)).members;
    assert.deepEqual(byPrediction, byIndex);
});

test('a sensor\'s noise is read from its readings, whatever smooth course they follow', () => {
    const normal = seededNormal(11);
    const values = Array.from({ length: 400 }, (_, index) => 300 + 40 * (1 - Math.exp(-index / 80)) + 0.25 * normal());
    assert.ok(Math.abs(readingNoise(values) / 0.25 - 1) < 0.1, `noise ${readingNoise(values)}`);
    assert.equal(readingNoise([1, 2, 3]), null);
    assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(quantile([0, 10], 0.1), 1);
});
