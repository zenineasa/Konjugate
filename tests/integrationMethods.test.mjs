/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultTolerance, integrationMethod, integrationMethodProblem, integrationMethods, methodOf, nameList, stageParticipation, stepsPerGlobalStepOf, toleranceOf, withIntegrationMethod, withStateAbsoluteTolerance } from '../src/integrationMethods.mjs';
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
    assert.equal(integrationMethod('dormandPrince54').name, 'Adaptive');
    assert.equal(integrationMethod('rodas4').name, 'Stiff');
    assert.equal(integrationMethod('bdf15'), null);
});

test('an unknown method and steps out of range are refused by name', () => {
    assert.match(integrationMethodProblem('bdf15', 1), /“bdf15” is not one this version of Konjugate knows/);
    assert.match(integrationMethodProblem('rungeKutta4', 0), /whole number from 1 through 10,000/);
    assert.match(integrationMethodProblem('rungeKutta4', 2.5), /whole number/);
    assert.equal(integrationMethodProblem('rungeKutta4', 10000), null);
    const execution = { workerThreads: 1, partitionCount: 1, partitionCommunicationBias: 4, automaticParallelThreshold: 128, automaticMaximumPartitionCutFraction: 0.25 };
    const values = { globalTimeStep: 0.01, outputInterval: 0.1, execution };
    assert.equal(validateRunConfigurationValues(values), null);
    assert.equal(validateRunConfigurationValues({ ...values, method: 'nodeByNode', stepsPerGlobalStep: 0 }), null, 'Euler ignores the hidden field.');
    assert.match(validateRunConfigurationValues({ ...values, method: 'rungeKutta4', stepsPerGlobalStep: 0 }), /Steps per global step/);
});

test('Adaptive writes its tolerance only where it is not the default, each number on its own, and has no steps per global step', () => {
    assert.deepEqual(withIntegrationMethod(configuration, 'dormandPrince54', 1, defaultTolerance), { ...configuration, method: 'dormandPrince54' });
    assert.deepEqual(withIntegrationMethod(configuration, 'dormandPrince54', 5, { relative: 1e-8, absolute: 1e-9 }),
        { ...configuration, method: 'dormandPrince54', tolerance: { relative: 1e-8 } });
    assert.deepEqual(withIntegrationMethod(configuration, 'dormandPrince54', 1, { relative: 1e-6, absolute: 1e-12 }),
        { ...configuration, method: 'dormandPrince54', tolerance: { absolute: 1e-12 } });
    // Another method has no tolerance to write, and going back takes it away.
    assert.deepEqual(withIntegrationMethod({ ...configuration, method: 'dormandPrince54', tolerance: { relative: 1e-3 } }, 'rungeKutta4', 1, { relative: 1e-3 }),
        { ...configuration, method: 'rungeKutta4' });
    assert.deepEqual(toleranceOf(configuration), { relative: 1e-6, absolute: 1e-9 });
    assert.deepEqual(toleranceOf({ tolerance: { absolute: 2 } }), { relative: 1e-6, absolute: 2 });
    assert.match(integrationMethodProblem('dormandPrince54', 1, { relative: 1 }), /relative tolerance must be a number greater than 0 and less than 1/);
    assert.match(integrationMethodProblem('dormandPrince54', 1, { absolute: 0 }), /absolute tolerance must be a number greater than 0/);
    assert.equal(integrationMethodProblem('dormandPrince54', 1, { relative: 1e-3, absolute: 10 }), null);
    const execution = { workerThreads: 1, partitionCount: 1, partitionCommunicationBias: 4, automaticParallelThreshold: 128, automaticMaximumPartitionCutFraction: 0.25 };
    assert.match(validateRunConfigurationValues({ globalTimeStep: 0.01, outputInterval: 0.1, execution, method: 'dormandPrince54', stepsPerGlobalStep: 1, tolerance: { relative: -1 } }), /relative tolerance/);
    // Samples stay on global steps under Adaptive too.
    assert.match(validateRunConfigurationValues({ globalTimeStep: 1, outputInterval: 0.25, execution, method: 'dormandPrince54', stepsPerGlobalStep: 1 }), /integer multiple of the global timestep/);
});

test('a state says its own absolute tolerance only when it has one', () => {
    const state = { id: 11, name: 'Level', symbol: 'level', initialValue: 1 };
    assert.deepEqual(withStateAbsoluteTolerance(state, 1e-3), { ...state, numerics: { absoluteTolerance: 1e-3 } });
    assert.deepEqual(withStateAbsoluteTolerance({ ...state, numerics: { absoluteTolerance: 1e-3 } }, undefined), state);
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
    const participation = stageParticipation(document);
    assert.deepEqual(participation.stepped, ['Pump', 'Controller']);
    assert.deepEqual(participation.programs, ["Tank's level", 'Valve']);
    assert.deepEqual(participation.older.map((program) => program.target), [
        { type: 'node', nodeId: 2 }, { type: 'sourceTerm', nodeId: 3, termId: 31 }, { type: 'edge', edgeId: 41 }
    ], 'Every program in the older format is listed, with where it is, for its "Convert to version 2 ›".');
    // A program in the current format takes every stage: neither stepped nor held.
    const newer = structuredClone(document);
    newer.nodes[1].implementation.source = 'from konjugate.v2 import Input, Node, Output\n';
    newer.edges[0].implementation.source = '#include <konjugate/sdk/v2/program.hpp>\n';
    newer.edges[0].implementation.kind = 'cpp';
    const current = stageParticipation(newer);
    assert.deepEqual(current.stepped, ['Pump']);
    assert.deepEqual(current.programs, ["Tank's level"]);
    assert.equal(nameList(['a', 'b', 'c']), 'a, b and c');
    assert.equal(nameList(['a', 'b', 'c', 'd', 'e', 'f'], 4), 'a, b, c, d and 2 more');
});

test('Stiff\'s solvers: Rosenbrock by default, its fifth-order form and BDF chosen by hand, each shown in the dialog as Stiff and never suggested', async () => {
    const integrationModule = await import('../src/integrationMethods.mjs');
    const { dialogMethodOf, stiffIntegrationMethod, stiffSolvers } = integrationModule;
    assert.deepEqual(stiffSolvers.map((solver) => solver.id), ['rodas4', 'rodas5p', 'bdf']);
    assert.equal(integrationMethods.filter((method) => method.offered !== false).some((method) => method.id === 'bdf'), false, 'BDF is not a Method of its own.');
    assert.equal(integrationMethods.filter((method) => method.offered !== false).some((method) => method.id === 'rodas5p'), false, 'Rodas5P is not a Method of its own.');
    assert.equal(dialogMethodOf('bdf'), 'rodas4');
    assert.equal(dialogMethodOf('rodas5p'), 'rodas4');
    assert.equal(withIntegrationMethod({ id: 1 }, 'rodas5p', 1, defaultTolerance, 'check').jacobian, 'check', 'Rodas5P works out a Jacobian as Stiff does.');
    assert.equal(dialogMethodOf('dormandPrince54'), 'dormandPrince54');
    assert.equal(withIntegrationMethod({ id: 1 }, 'bdf').method, 'bdf');
    // A stiffness finding's "Use Stiff" chooses Rosenbrock at every size (the user's decision): there is no rule that picks BDF.
    assert.equal(stiffIntegrationMethod, 'rodas4');
    assert.equal(integrationModule.bdfSuits, undefined);
    assert.equal(integrationModule.bdfStateThreshold, undefined);
});

test('Adaptive\'s solvers: Tsit5 by default, Dormand–Prince kept where a file names it, each shown in the dialog as Adaptive', async () => {
    const { adaptiveIntegrationMethod, adaptiveSolvers, defaultAdaptiveSolver, dialogMethodOf } = await import('../src/integrationMethods.mjs');
    assert.deepEqual(adaptiveSolvers.map((solver) => solver.id), ['tsit5', 'dormandPrince54']);
    assert.equal(defaultAdaptiveSolver, 'tsit5');
    assert.equal(adaptiveIntegrationMethod, 'dormandPrince54', 'The Method list\'s Adaptive keeps the id saved files use.');
    assert.equal(dialogMethodOf('tsit5'), 'dormandPrince54');
    assert.equal(dialogMethodOf('dormandPrince54'), 'dormandPrince54');
    assert.equal(integrationMethods.filter((method) => method.offered !== false).some((method) => method.id === 'tsit5'), false, 'Tsit5 is not a Method of its own.');
});

test('Stiff chooses Rodas5P for a relative tolerance tighter than 1e-6 and Rodas4 otherwise, the default tolerance among them', async () => {
    const { defaultStiffSolver } = await import('../src/integrationMethods.mjs');
    assert.equal(defaultStiffSolver(undefined), 'rodas4');
    assert.equal(defaultStiffSolver(defaultTolerance), 'rodas4');
    assert.equal(defaultStiffSolver({ relative: 1e-3, absolute: 1e-6 }), 'rodas4');
    assert.equal(defaultStiffSolver({ relative: 1e-6, absolute: 1e-12 }), 'rodas4');
    assert.equal(defaultStiffSolver({ relative: 9.9e-7, absolute: 1e-9 }), 'rodas5p');
    assert.equal(defaultStiffSolver({ relative: 1e-10, absolute: 1e-13 }), 'rodas5p');
});

test('Stiff\'s Jacobian is written only when it is not the default, and only for Stiff', () => {
    const configuration = { id: 1, name: 'Run', globalTimeStep: 0.1, outputInterval: 0.1 };
    assert.deepEqual(withIntegrationMethod(configuration, 'rodas4', 1, defaultTolerance, 'analytic'), { ...configuration, method: 'rodas4' });
    assert.deepEqual(withIntegrationMethod(configuration, 'bdf', 1, defaultTolerance, 'finiteDifference'), { ...configuration, method: 'bdf', jacobian: 'finiteDifference' });
    assert.deepEqual(withIntegrationMethod(configuration, 'rodas4', 1, defaultTolerance, 'check'), { ...configuration, method: 'rodas4', jacobian: 'check' });
    // Leaving Stiff drops it; the configuration's own is kept when none is given.
    assert.deepEqual(withIntegrationMethod({ ...configuration, method: 'rodas4', jacobian: 'finiteDifference' }, 'rungeKutta4', 1), { ...configuration, method: 'rungeKutta4' });
    assert.deepEqual(withIntegrationMethod({ ...configuration, jacobian: 'finiteDifference' }, 'rodas4', 1), { ...configuration, method: 'rodas4', jacobian: 'finiteDifference' });
});

test('the method guide is one source: docs/choosingAMethod.md is written from it, and each sign cites a benchmark that exists', async () => {
    const { readFile, access } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { methodGuide, methodGuideMarkdown, benchmarkEvidenceUrl } = await import('../src/integrationMethods.mjs');
    const root = join(import.meta.dirname, '..');
    assert.equal(await readFile(join(root, 'docs', 'choosingAMethod.md'), 'utf8'), methodGuideMarkdown(), 'Run node scripts/writeMethodGuide.mjs to bring docs/choosingAMethod.md up to date.');
    for (const item of methodGuide.signs) {
        assert.ok(item.evidence.length > 0, `"${item.sign}" cites its evidence.`);
        assert.ok([undefined, 'stiff', 'integration'].includes(item.topic));
        for (const benchmark of item.evidence) {
            await access(join(root, 'benchmarks', benchmark.path, 'problem.mjs'));
            assert.ok(benchmarkEvidenceUrl(benchmark.path).startsWith('https://github.com/zenineasa/Konjugate/tree/'));
        }
    }
    // The guide covers every method the Run dialog offers, and both of Stiff's solvers.
    const named = methodGuide.methods.map((item) => item.name).join(' ');
    for (const name of ['Euler, node by node', 'Semi-implicit', 'Verlet', 'Runge–Kutta 4', 'Adaptive', 'Rosenbrock', 'BDF']) assert.ok(named.includes(name), `The guide names ${name}.`);
});
