/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { targetTimeIsReachable, validateRunConfigurationValues } from '../src/renderer/runConfigurationValidation.mjs';

const execution = {
    backend: 'automatic', partitionAlgorithm: 'automatic', workerThreads: 4, partitionCount: 2,
    partitionCommunicationBias: 4, automaticParallelThreshold: 64, automaticMaximumPartitionCutFraction: 0.5
};

test('a timestep with an output interval that is a whole multiple of it is accepted', () => {
    assert.equal(validateRunConfigurationValues({ globalTimeStep: 0.01, outputInterval: 0.1, execution }), null);
    assert.equal(validateRunConfigurationValues({ globalTimeStep: 0.05, outputInterval: 0.05, execution }), null);
});

test('the timestep and output interval must be positive, finite, and in whole multiples', () => {
    const message = /output interval must be an integer multiple/;
    assert.match(validateRunConfigurationValues({ globalTimeStep: 0, outputInterval: 0.1, execution }), message);
    assert.match(validateRunConfigurationValues({ globalTimeStep: Number.NaN, outputInterval: 0.1, execution }), message);
    assert.match(validateRunConfigurationValues({ globalTimeStep: 0.01, outputInterval: 0.005, execution }), message);
    assert.match(validateRunConfigurationValues({ globalTimeStep: 0.03, outputInterval: 0.1, execution }), message);
    assert.match(validateRunConfigurationValues({ globalTimeStep: 0.01, outputInterval: Infinity, execution }), message);
});

test('execution values outside their bounds are rejected first, with their own message', () => {
    const bad = (change) => validateRunConfigurationValues({ globalTimeStep: 0.01, outputInterval: 0.1, execution: { ...execution, ...change } });
    for (const change of [{ workerThreads: 0 }, { workerThreads: 257 }, { workerThreads: 1.5 }, { partitionCount: 0 },
        { partitionCommunicationBias: -1 }, { automaticParallelThreshold: 0 }, { automaticMaximumPartitionCutFraction: 1.1 }]) {
        assert.match(bad(change), /Execution values must be within/, JSON.stringify(change));
    }
    assert.match(validateRunConfigurationValues({ globalTimeStep: 0, outputInterval: 0, execution: { ...execution, workerThreads: 0 } }), /Execution values/);
});

test('a run must reach at least one timestep past where it starts, allowing for rounding', () => {
    assert.equal(targetTimeIsReachable(1, 0, 0.01), true);
    assert.equal(targetTimeIsReachable(0.5, 0.5, 0.01), false);
    assert.equal(targetTimeIsReachable(0.505, 0.5, 0.01), false);
    // 0.4 - (0.1 + 0.2) is a hair under 0.1 in floating point, but is one timestep.
    assert.equal(0.4 - (0.1 + 0.2) < 0.1, true);
    assert.equal(targetTimeIsReachable(0.4, 0.1 + 0.2, 0.1), true);
    assert.equal(targetTimeIsReachable(0.37 + 0.001, 0.37, 0.001), true);
    assert.equal(targetTimeIsReachable(2, 1, 0.5), true);
});
