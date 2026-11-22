/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { integrationMethod, integrationMethodProblem, methodOf, nameList, stageParticipation, stepsPerGlobalStepOf, withIntegrationMethod } from '../src/integrationMethods.mjs';
import { validateRunConfigurationValues } from '../src/renderer/runConfigurationValidation.mjs';

const configuration = { id: 3, name: 'Default', globalTimeStep: 0.01, outputInterval: 0.1, execution: { backend: 'automatic' } };

test('a run configuration says its method only when it is not Euler node by node, and its steps only when not 1', () => {
    assert.deepEqual(withIntegrationMethod(configuration, 'nodeByNode', 1), configuration);
    assert.equal(JSON.stringify(withIntegrationMethod(configuration, 'nodeByNode', 7)), JSON.stringify(configuration), 'Euler has no steps per global step to write.');
    assert.deepEqual(withIntegrationMethod(configuration, 'rungeKutta4', 1), { ...configuration, method: 'rungeKutta4' });
    assert.deepEqual(withIntegrationMethod(configuration, 'rungeKutta4', 4), { ...configuration, method: 'rungeKutta4', stepsPerGlobalStep: 4 });
    // Back to the default takes both away again, so the file is the one it was.
    assert.deepEqual(withIntegrationMethod({ ...configuration, method: 'rungeKutta4', stepsPerGlobalStep: 4 }, 'nodeByNode', 4), configuration);
});

test('a configuration that names no method is Euler node by node, one step per global step', () => {
    assert.equal(methodOf(configuration), 'nodeByNode');
    assert.equal(stepsPerGlobalStepOf(configuration), 1);
    assert.equal(stepsPerGlobalStepOf({ ...configuration, method: 'rungeKutta4', stepsPerGlobalStep: 3 }), 3);
    assert.equal(integrationMethod('rungeKutta4').name, 'Runge–Kutta 4');
    assert.equal(integrationMethod('nodeByNode').name, 'Euler, node by node');
    assert.equal(integrationMethod('dormandPrince54'), null);
});

test('an unknown method and steps out of range are refused by name', () => {
    assert.match(integrationMethodProblem('dormandPrince54', 1), /“dormandPrince54” is not one this version of Konjugate knows/);
    assert.match(integrationMethodProblem('rungeKutta4', 0), /whole number from 1 through 10,000/);
    assert.match(integrationMethodProblem('rungeKutta4', 2.5), /whole number/);
    assert.equal(integrationMethodProblem('rungeKutta4', 10000), null);
    const execution = { workerThreads: 1, partitionCount: 1, partitionCommunicationBias: 4, automaticParallelThreshold: 128, automaticMaximumPartitionCutFraction: 0.25 };
    const values = { globalTimeStep: 0.01, outputInterval: 0.1, execution };
    assert.equal(validateRunConfigurationValues(values), null);
    assert.equal(validateRunConfigurationValues({ ...values, method: 'nodeByNode', stepsPerGlobalStep: 0 }), null, 'Euler ignores the hidden field.');
    assert.match(validateRunConfigurationValues({ ...values, method: 'rungeKutta4', stepsPerGlobalStep: 0 }), /Steps per global step/);
});

test('what cannot take stages is named before the run: a node that is a program is stepped, a term written as a program held', () => {
    const document = {
        nodes: [
            { id: 1, name: 'Pump', implementation: { kind: 'fmi', outputs: [] }, sourceTerms: [] },
            { id: 2, name: 'Controller', implementation: { kind: 'python', outputs: [{ key: 'rate', stateId: 21 }] }, sourceTerms: [] },
            { id: 3, name: 'Tank', sourceTerms: [{ id: 31, state: 'level', implementation: { kind: 'cpp' } }, { id: 32, state: 'level', expressionModel: {} }] },
            { id: 4, name: 'Off', enabled: false, implementation: { kind: 'fmi' }, sourceTerms: [] }
        ],
        edges: [
            { id: 41, name: 'Valve', source: { nodeId: 1 }, target: { nodeId: 3 }, implementation: { kind: 'python' } },
            { id: 42, name: 'Pipe', source: { nodeId: 1 }, target: { nodeId: 3 }, equationModel: {} },
            { id: 43, name: 'To nothing', source: { nodeId: 4 }, target: { nodeId: 3 }, implementation: { kind: 'python' } }
        ]
    };
    assert.deepEqual(stageParticipation(document), { stepped: ['Pump', 'Controller'], programs: ["Tank's level", 'Valve'] });
    assert.equal(nameList(['a', 'b', 'c']), 'a, b and c');
    assert.equal(nameList(['a', 'b', 'c', 'd', 'e', 'f'], 4), 'a, b, c, d and 2 more');
});
